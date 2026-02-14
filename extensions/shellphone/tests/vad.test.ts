/**
 * VAD Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  VoiceActivityDetector,
  createDefaultVadConfig,
  containsSpeech,
  calculateSpeechPercentage,
} from "../src/stt/vad.js";

describe("VoiceActivityDetector", () => {
  let vad: VoiceActivityDetector;

  beforeEach(() => {
    vad = new VoiceActivityDetector(createDefaultVadConfig());
  });

  it("should initialize with correct default state", () => {
    const state = vad.getState();
    expect(state.isSpeaking).toBe(false);
    expect(state.speechStartMs).toBeNull();
    expect(state.audioBuffer).toEqual([]);
  });

  it("should detect speech start on high energy frame", () => {
    // Create a high-energy mu-law frame (loud audio)
    const loudFrame = Buffer.alloc(160);
    for (let i = 0; i < 160; i++) {
      loudFrame[i] = 0x80; // High amplitude mu-law
    }

    const result = vad.process(loudFrame, true);
    expect(result.speechStarted).toBe(true);
    expect(vad.isSpeaking()).toBe(true);
  });

  it("should not detect speech on low energy frame", () => {
    // Create a low-energy mu-law frame (silence)
    const silentFrame = Buffer.alloc(160);
    for (let i = 0; i < 160; i++) {
      silentFrame[i] = 0xff; // Near-zero amplitude mu-law
    }

    const result = vad.process(silentFrame, true);
    expect(result.speechStarted).toBe(false);
    expect(vad.isSpeaking()).toBe(false);
  });

  it("should emit segment after silence threshold", async () => {
    const config = {
      silenceThresholdMs: 100,
      minSpeechMs: 50,
      energyThreshold: 0.01,
    };
    const testVad = new VoiceActivityDetector(config, 8000);

    // Create loud frame
    const loudFrame = Buffer.alloc(160);
    for (let i = 0; i < 160; i++) {
      loudFrame[i] = 0x80;
    }

    // Create silent frame
    const silentFrame = Buffer.alloc(160);
    silentFrame.fill(0xff);

    // Start speech
    testVad.process(loudFrame, true);
    expect(testVad.isSpeaking()).toBe(true);

    // Wait for silence threshold
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Process silent frame
    const result = testVad.process(silentFrame, true);

    expect(result.speechEnded).toBe(true);
    expect(result.segment).toBeDefined();
    expect(result.segment?.isFinal).toBe(true);
  });

  it("should reset state correctly", () => {
    // Create loud frame
    const loudFrame = Buffer.alloc(160);
    loudFrame.fill(0x80);

    vad.process(loudFrame, true);
    expect(vad.isSpeaking()).toBe(true);

    vad.reset();

    const state = vad.getState();
    expect(state.isSpeaking).toBe(false);
    expect(state.audioBuffer).toEqual([]);
  });

  it("should flush accumulated audio", async () => {
    // Create a VAD with short minSpeechMs to ensure we get a segment
    const config = {
      silenceThresholdMs: 500,
      minSpeechMs: 10, // Very short for testing
      energyThreshold: 0.01,
    };
    const testVad = new VoiceActivityDetector(config, 8000);

    // Create loud frame
    const loudFrame = Buffer.alloc(160);
    loudFrame.fill(0x80);

    // Process several frames to accumulate some speech
    testVad.process(loudFrame, true);
    testVad.process(loudFrame, true);
    testVad.process(loudFrame, true);

    // Wait a bit to ensure minSpeechMs threshold is met
    await new Promise((resolve) => setTimeout(resolve, 50));

    const segment = testVad.flush();
    expect(segment).not.toBeNull();
    expect(segment?.audio.length).toBeGreaterThan(0);
  });
});

describe("containsSpeech", () => {
  it("should return true for high energy audio", () => {
    const loudFrame = Buffer.alloc(160);
    loudFrame.fill(0x80);
    expect(containsSpeech(loudFrame, true, 0.01)).toBe(true);
  });

  it("should return false for low energy audio", () => {
    const silentFrame = Buffer.alloc(160);
    silentFrame.fill(0xff);
    expect(containsSpeech(silentFrame, true, 0.01)).toBe(false);
  });
});

describe("calculateSpeechPercentage", () => {
  it("should return 0 for silent audio", () => {
    const silentAudio = Buffer.alloc(1600);
    silentAudio.fill(0xff);
    const percentage = calculateSpeechPercentage(silentAudio, true);
    expect(percentage).toBe(0);
  });

  it("should return 1 for all speech audio", () => {
    const speechAudio = Buffer.alloc(1600);
    speechAudio.fill(0x80);
    const percentage = calculateSpeechPercentage(speechAudio, true);
    expect(percentage).toBeGreaterThan(0.8);
  });
});
