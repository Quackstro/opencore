/**
 * Pipeline Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SttProvider, TtsProvider, CallRecord, PipelineConfig } from "../src/types.js";
import { VoicePipeline, createVoicePipeline } from "../src/pipeline.js";

// Create mock STT provider
const createMockStt = (): SttProvider => ({
  name: "mock-stt",
  async transcribe(audio: Buffer) {
    return {
      text: "Hello, this is a test",
      confidence: 0.95,
      language: "en",
      durationMs: 1000,
    };
  },
  async isReady() {
    return true;
  },
});

// Create mock TTS provider
const createMockTts = (): TtsProvider => ({
  name: "mock-tts",
  async synthesize(text: string) {
    return {
      audio: Buffer.alloc(1600),
      sampleRate: 22050,
      format: "pcm16",
      durationMs: Math.floor(text.length * 50),
    };
  },
  async synthesizeForTelephony(text: string) {
    return Buffer.alloc(800);
  },
  async isReady() {
    return true;
  },
});

// Create mock LLM
const createMockLlm = () => ({
  async generateResponse(params: { messages: unknown[] }) {
    return {
      text: "I understand. How can I help you today?",
    };
  },
});

// Create mock call record
const createMockCallRecord = (): CallRecord => ({
  callId: "test-call-123",
  provider: "mock",
  direction: "outbound",
  state: "active",
  from: "+15550001234",
  to: "+15550005678",
  startedAt: Date.now(),
  transcript: [],
  processedEventIds: [],
});

const createTestConfig = (): PipelineConfig => ({
  stt: {
    provider: "whisper",
    whisper: {
      model: "base",
      device: "cpu",
      language: "en",
    },
  },
  tts: {
    provider: "piper",
    piper: {
      model: "en_US-amy-medium",
      dataDir: "~/.openclaw/piper",
      lengthScale: 1.0,
    },
    edge: {
      voice: "en-US-AriaNeural",
    },
  },
  vad: {
    silenceThresholdMs: 500,
    minSpeechMs: 100,
    energyThreshold: 0.01,
  },
  llm: {
    maxTokens: 150,
    temperature: 0.7,
  },
});

describe("VoicePipeline", () => {
  let pipeline: VoicePipeline;
  let stt: SttProvider;
  let tts: TtsProvider;
  let llm: ReturnType<typeof createMockLlm>;
  let callbacks: {
    onSpeechStart: ReturnType<typeof vi.fn>;
    onTranscript: ReturnType<typeof vi.fn>;
    onResponse: ReturnType<typeof vi.fn>;
    onAudio: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    stt = createMockStt();
    tts = createMockTts();
    llm = createMockLlm();
    callbacks = {
      onSpeechStart: vi.fn(),
      onTranscript: vi.fn(),
      onResponse: vi.fn(),
      onAudio: vi.fn(),
      onError: vi.fn(),
    };

    pipeline = createVoicePipeline({
      config: createTestConfig(),
      stt,
      tts,
      llm,
      callbacks,
    });
  });

  it("should initialize call context", () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord, "You are a helpful assistant.");

    const context = pipeline.getContext("test-123");
    expect(context).toBeDefined();
    expect(context?.callId).toBe("test-123");
    expect(context?.systemPrompt).toBe("You are a helpful assistant.");
    expect(context?.conversationHistory.length).toBe(1);
    expect(context?.conversationHistory[0].role).toBe("system");
  });

  it("should use default system prompt when not provided", () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    const context = pipeline.getContext("test-123");
    expect(context?.systemPrompt).toContain("helpful voice assistant");
  });

  it("should track processing state", () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    expect(pipeline.isProcessing("test-123")).toBe(false);
  });

  it("should speak directly without STT/LLM", async () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    await pipeline.speak("test-123", "Hello, this is a test message.");

    expect(callbacks.onAudio).toHaveBeenCalled();

    const context = pipeline.getContext("test-123");
    expect(context?.conversationHistory.length).toBe(2);
    expect(context?.conversationHistory[1].role).toBe("assistant");
    expect(context?.conversationHistory[1].content).toBe("Hello, this is a test message.");
  });

  it("should interrupt on speech start", () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    pipeline.interrupt("test-123");

    // Should not throw
    expect(true).toBe(true);
  });

  it("should clean up on end call", async () => {
    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    await pipeline.endCall("test-123");

    const context = pipeline.getContext("test-123");
    expect(context).toBeUndefined();
  });
});

describe("createVoicePipeline", () => {
  it("should create pipeline with all components", () => {
    const pipeline = createVoicePipeline({
      config: createTestConfig(),
      stt: createMockStt(),
      tts: createMockTts(),
      llm: createMockLlm(),
    });

    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it("should work without callbacks", () => {
    const pipeline = createVoicePipeline({
      config: createTestConfig(),
      stt: createMockStt(),
      tts: createMockTts(),
      llm: createMockLlm(),
    });

    const callRecord = createMockCallRecord();
    pipeline.initCall("test-123", callRecord);

    // Should not throw
    expect(true).toBe(true);
  });
});
