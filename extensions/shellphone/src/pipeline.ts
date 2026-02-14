/**
 * Voice Pipeline Orchestration
 *
 * Coordinates the flow: Audio → VAD → STT → LLM → TTS → Audio
 *
 * Architecture:
 * ```
 * Twilio Media Stream → Silence Detection → Whisper STT → OpenCore LLM → Piper TTS → Twilio Media Stream
 * ```
 */

import type {
  PipelineConfig,
  PipelineContext,
  CallRecord,
  ConversationMessage,
  SttProvider,
  TtsProvider,
  SpeechSegment,
} from "./types.js";
import { concatAudio, mulawToPcm, pcmToMulaw8k, chunkAudio } from "./audio-utils.js";
import { VoiceActivityDetector, type VadResult } from "./stt/vad.js";

/**
 * LLM interface expected from OpenCore runtime.
 */
export interface LlmRuntime {
  generateResponse(params: {
    messages: ConversationMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; error?: string }>;
}

/**
 * Callbacks for pipeline events.
 */
export interface PipelineCallbacks {
  /** Called when speech starts (for barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Called when speech ends with transcription */
  onTranscript?: (callId: string, text: string) => void;
  /** Called with partial transcripts */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Called when LLM response is ready */
  onResponse?: (callId: string, text: string) => void;
  /** Called when TTS audio is ready for streaming */
  onAudio?: (callId: string, audio: Buffer) => void;
  /** Called on errors */
  onError?: (callId: string, error: Error) => void;
}

/**
 * Voice Processing Pipeline
 *
 * Handles the complete flow from audio input to audio output.
 */
export class VoicePipeline {
  private config: PipelineConfig;
  private stt: SttProvider;
  private tts: TtsProvider;
  private llm: LlmRuntime;
  private vad: VoiceActivityDetector;
  private callbacks: PipelineCallbacks;
  private contexts = new Map<string, PipelineContext>();
  private audioBuffers = new Map<string, Buffer[]>();
  private processing = new Map<string, boolean>();

  constructor(params: {
    config: PipelineConfig;
    stt: SttProvider;
    tts: TtsProvider;
    llm: LlmRuntime;
    callbacks?: PipelineCallbacks;
  }) {
    this.config = params.config;
    this.stt = params.stt;
    this.tts = params.tts;
    this.llm = params.llm;
    this.callbacks = params.callbacks ?? {};
    this.vad = new VoiceActivityDetector(params.config.vad);
  }

  /**
   * Initialize pipeline for a new call.
   */
  initCall(callId: string, callRecord: CallRecord, systemPrompt?: string): void {
    const context: PipelineContext = {
      callId,
      callRecord,
      conversationHistory: [],
      systemPrompt: systemPrompt || this.config.llm.systemPrompt || this.getDefaultSystemPrompt(),
    };

    // Add system message to history
    context.conversationHistory.push({
      role: "system",
      content: context.systemPrompt,
    });

    this.contexts.set(callId, context);
    this.audioBuffers.set(callId, []);
    this.processing.set(callId, false);

    console.log(`[shellphone] 🐚 initialized call ${callId}`);
  }

  /**
   * Process incoming audio frame.
   *
   * @param callId - Call identifier
   * @param audio - mu-law audio buffer from Twilio
   */
  async processAudio(callId: string, audio: Buffer): Promise<void> {
    const context = this.contexts.get(callId);
    if (!context) {
      console.warn(`[shellphone] 🐚 no context for call ${callId}`);
      return;
    }

    // Run VAD
    const vadResult = this.vad.process(audio, true);

    // Handle speech start (for barge-in)
    if (vadResult.speechStarted) {
      this.callbacks.onSpeechStart?.(callId);
    }

    // Accumulate audio during speech
    if (this.vad.isSpeaking()) {
      const buffers = this.audioBuffers.get(callId) ?? [];
      buffers.push(audio);
      this.audioBuffers.set(callId, buffers);
    }

    // Handle speech end - process the complete utterance
    if (vadResult.segment) {
      await this.processUtterance(callId, vadResult.segment);
    }
  }

  /**
   * Process a complete speech utterance.
   */
  private async processUtterance(callId: string, segment: SpeechSegment): Promise<void> {
    const context = this.contexts.get(callId);
    if (!context) return;

    // Prevent concurrent processing
    if (this.processing.get(callId)) {
      console.log(`[shellphone] 🐚 skipping utterance (already processing)`);
      return;
    }
    this.processing.set(callId, true);

    try {
      // Step 1: Speech to Text
      console.log(`[shellphone] 🐚 transcribing ${segment.audio.length} bytes`);
      const sttResult = await this.stt.transcribe(segment.audio, 8000);

      if (!sttResult.text || sttResult.text.trim().length === 0) {
        console.log(`[shellphone] 🐚 empty transcript, skipping`);
        return;
      }

      const transcript = sttResult.text.trim();
      console.log(`[shellphone] 🐚 transcript: "${transcript}"`);
      this.callbacks.onTranscript?.(callId, transcript);

      // Add to conversation history
      context.conversationHistory.push({
        role: "user",
        content: transcript,
      });

      // Update call record transcript
      context.callRecord.transcript.push({
        timestamp: Date.now(),
        speaker: "user",
        text: transcript,
        isFinal: true,
      });

      // Step 2: LLM Response
      console.log(`[shellphone] 🐚 generating LLM response`);
      const llmResult = await this.llm.generateResponse({
        messages: context.conversationHistory,
        maxTokens: this.config.llm.maxTokens,
        temperature: this.config.llm.temperature,
      });

      if (llmResult.error) {
        throw new Error(llmResult.error);
      }

      const response = llmResult.text.trim();
      console.log(`[shellphone] 🐚 response: "${response}"`);
      this.callbacks.onResponse?.(callId, response);

      // Add to conversation history
      context.conversationHistory.push({
        role: "assistant",
        content: response,
      });

      // Update call record transcript
      context.callRecord.transcript.push({
        timestamp: Date.now(),
        speaker: "bot",
        text: response,
        isFinal: true,
      });

      // Step 3: Text to Speech
      console.log(`[shellphone] 🐚 synthesizing TTS`);
      const mulaw = await this.tts.synthesizeForTelephony(response);
      console.log(`[shellphone] 🐚 TTS complete: ${mulaw.length} bytes`);

      // Stream audio in chunks
      for (const chunk of chunkAudio(mulaw, 160)) {
        this.callbacks.onAudio?.(callId, chunk);
      }
    } catch (err) {
      console.error(`[shellphone] 🐚 error:`, err);
      this.callbacks.onError?.(callId, err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Clear audio buffer and reset processing flag
      this.audioBuffers.set(callId, []);
      this.processing.set(callId, false);
    }
  }

  /**
   * Speak a message directly (bypassing STT/LLM).
   */
  async speak(callId: string, text: string): Promise<void> {
    const context = this.contexts.get(callId);
    if (!context) {
      throw new Error(`No context for call ${callId}`);
    }

    // Add to conversation history
    context.conversationHistory.push({
      role: "assistant",
      content: text,
    });

    // Update call record
    context.callRecord.transcript.push({
      timestamp: Date.now(),
      speaker: "bot",
      text,
      isFinal: true,
    });

    // Synthesize and stream
    const mulaw = await this.tts.synthesizeForTelephony(text);

    for (const chunk of chunkAudio(mulaw, 160)) {
      this.callbacks.onAudio?.(callId, chunk);
    }
  }

  /**
   * Handle end of call - flush any remaining audio.
   */
  async endCall(callId: string): Promise<void> {
    // Flush VAD
    const segment = this.vad.flush();
    if (segment) {
      await this.processUtterance(callId, segment);
    }

    // Cleanup
    this.contexts.delete(callId);
    this.audioBuffers.delete(callId);
    this.processing.delete(callId);

    console.log(`[shellphone] 🐚 ended call ${callId}`);
  }

  /**
   * Get current context for a call.
   */
  getContext(callId: string): PipelineContext | undefined {
    return this.contexts.get(callId);
  }

  /**
   * Check if pipeline is processing for a call.
   */
  isProcessing(callId: string): boolean {
    return this.processing.get(callId) ?? false;
  }

  /**
   * Interrupt current processing (for barge-in).
   */
  interrupt(callId: string): void {
    // Clear audio buffer
    this.audioBuffers.set(callId, []);
    this.vad.reset();
    console.log(`[shellphone] 🐚 interrupted call ${callId}`);
  }

  private getDefaultSystemPrompt(): string {
    return `You are a helpful voice assistant on a phone call. Keep your responses brief and conversational (1-2 sentences max). Be natural and friendly. Speak clearly and avoid technical jargon unless necessary.`;
  }
}

/**
 * Create a voice pipeline with the given providers.
 */
export function createVoicePipeline(params: {
  config: PipelineConfig;
  stt: SttProvider;
  tts: TtsProvider;
  llm: LlmRuntime;
  callbacks?: PipelineCallbacks;
}): VoicePipeline {
  return new VoicePipeline(params);
}

export default VoicePipeline;
