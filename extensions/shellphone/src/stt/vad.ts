/**
 * Voice Activity Detection (VAD)
 *
 * Simple energy-based VAD for detecting speech in audio streams.
 * Uses RMS energy thresholding with configurable silence detection.
 */

import type { VadConfig, SpeechSegment } from "../types.js";
import { calculateMulawRms, mulawToPcm, calculateRms, concatAudio } from "../audio-utils.js";

export interface VadState {
  /** Whether speech is currently detected */
  isSpeaking: boolean;
  /** Timestamp when speech started (ms) */
  speechStartMs: number | null;
  /** Timestamp of last speech activity (ms) */
  lastSpeechMs: number;
  /** Accumulated audio during speech */
  audioBuffer: Buffer[];
  /** Total samples collected */
  totalSamples: number;
}

export interface VadResult {
  /** Current VAD state */
  state: VadState;
  /** Completed speech segment (if silence threshold exceeded) */
  segment?: SpeechSegment;
  /** Whether speech just started */
  speechStarted: boolean;
  /** Whether speech just ended */
  speechEnded: boolean;
}

/**
 * Voice Activity Detector with configurable parameters.
 */
export class VoiceActivityDetector {
  private config: VadConfig;
  private state: VadState;
  private sampleRate: number;

  constructor(config: VadConfig, sampleRate = 8000) {
    this.config = config;
    this.sampleRate = sampleRate;
    this.state = this.createInitialState();
  }

  private createInitialState(): VadState {
    return {
      isSpeaking: false,
      speechStartMs: null,
      lastSpeechMs: 0,
      audioBuffer: [],
      totalSamples: 0,
    };
  }

  /**
   * Reset VAD state.
   */
  reset(): void {
    this.state = this.createInitialState();
  }

  /**
   * Process an audio frame and detect speech.
   *
   * @param audio - Audio buffer (mu-law or PCM)
   * @param isMulaw - Whether the audio is mu-law encoded
   * @returns VAD result with state and any completed segments
   */
  process(audio: Buffer, isMulaw = true): VadResult {
    const now = Date.now();
    const rms = isMulaw ? calculateMulawRms(audio) : calculateRms(audio);
    const isSpeech = rms > this.config.energyThreshold;

    // Calculate audio duration in milliseconds
    const samples = isMulaw ? audio.length : Math.floor(audio.length / 2);
    const durationMs = (samples / this.sampleRate) * 1000;
    this.state.totalSamples += samples;

    let speechStarted = false;
    let speechEnded = false;
    let segment: SpeechSegment | undefined;

    if (isSpeech) {
      // Speech detected
      if (!this.state.isSpeaking) {
        // Speech just started
        this.state.isSpeaking = true;
        this.state.speechStartMs = now;
        this.state.audioBuffer = [];
        speechStarted = true;
      }
      this.state.lastSpeechMs = now;
      this.state.audioBuffer.push(audio);
    } else if (this.state.isSpeaking) {
      // Silence during speech - still accumulate
      this.state.audioBuffer.push(audio);

      // Check if silence threshold exceeded
      const silenceMs = now - this.state.lastSpeechMs;
      if (silenceMs >= this.config.silenceThresholdMs) {
        // Speech ended
        const speechDurationMs = now - (this.state.speechStartMs ?? now);

        // Only emit segment if speech was long enough
        if (speechDurationMs >= this.config.minSpeechMs) {
          segment = {
            audio: concatAudio(this.state.audioBuffer),
            startMs: this.state.speechStartMs ?? now,
            endMs: now,
            isFinal: true,
          };
        }

        // Reset state
        this.state.isSpeaking = false;
        this.state.speechStartMs = null;
        this.state.audioBuffer = [];
        speechEnded = true;
      }
    }

    return {
      state: { ...this.state },
      segment,
      speechStarted,
      speechEnded,
    };
  }

  /**
   * Force end of speech (e.g., on call hangup).
   * Returns any accumulated audio as a segment.
   */
  flush(): SpeechSegment | null {
    if (!this.state.isSpeaking || this.state.audioBuffer.length === 0) {
      this.reset();
      return null;
    }

    const now = Date.now();
    const speechDurationMs = now - (this.state.speechStartMs ?? now);

    // Only emit segment if speech was long enough
    if (speechDurationMs < this.config.minSpeechMs) {
      this.reset();
      return null;
    }

    const segment: SpeechSegment = {
      audio: concatAudio(this.state.audioBuffer),
      startMs: this.state.speechStartMs ?? now,
      endMs: now,
      isFinal: true,
    };

    this.reset();
    return segment;
  }

  /**
   * Get current state.
   */
  getState(): VadState {
    return { ...this.state };
  }

  /**
   * Check if currently in speech.
   */
  isSpeaking(): boolean {
    return this.state.isSpeaking;
  }

  /**
   * Get speech duration so far (if speaking).
   */
  getSpeechDurationMs(): number {
    if (!this.state.isSpeaking || !this.state.speechStartMs) {
      return 0;
    }
    return Date.now() - this.state.speechStartMs;
  }

  /**
   * Get silence duration (if not speaking).
   */
  getSilenceDurationMs(): number {
    if (this.state.isSpeaking) {
      return 0;
    }
    if (this.state.lastSpeechMs === 0) {
      return 0;
    }
    return Date.now() - this.state.lastSpeechMs;
  }
}

/**
 * Create a default VAD configuration.
 */
export function createDefaultVadConfig(): VadConfig {
  return {
    silenceThresholdMs: 500,
    minSpeechMs: 100,
    energyThreshold: 0.01,
  };
}

/**
 * Analyze audio buffer and estimate if it contains speech.
 * Useful for quick classification without full VAD.
 */
export function containsSpeech(audio: Buffer, isMulaw = true, threshold = 0.01): boolean {
  const rms = isMulaw ? calculateMulawRms(audio) : calculateRms(audio);
  return rms > threshold;
}

/**
 * Calculate speech percentage in an audio buffer.
 * Analyzes frame by frame and returns percentage of frames with speech.
 */
export function calculateSpeechPercentage(
  audio: Buffer,
  isMulaw = true,
  frameMs = 20,
  sampleRate = 8000,
  threshold = 0.01,
): number {
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000);
  const bytesPerFrame = isMulaw ? samplesPerFrame : samplesPerFrame * 2;

  let totalFrames = 0;
  let speechFrames = 0;

  for (let i = 0; i < audio.length; i += bytesPerFrame) {
    const frame = audio.subarray(i, Math.min(i + bytesPerFrame, audio.length));
    totalFrames++;

    if (containsSpeech(frame, isMulaw, threshold)) {
      speechFrames++;
    }
  }

  return totalFrames > 0 ? speechFrames / totalFrames : 0;
}

export default VoiceActivityDetector;
