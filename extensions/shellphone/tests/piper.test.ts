/**
 * Piper TTS Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiperTtsProvider, createPiperProvider } from "../src/tts/piper.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn((event, cb) => {
      if (event === "close") {
        setTimeout(() => cb(0), 10);
      }
    }),
  })),
}));

// Mock fs
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
  existsSync: vi.fn(() => true),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    mkdtemp: vi.fn(() => Promise.resolve("/tmp/piper-test")),
    readFile: vi.fn(() => {
      // Return a valid WAV header + some PCM data
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + 100, 4);
      header.write("WAVE", 8);
      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(22050, 24);
      header.writeUInt32LE(44100, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(100, 40);
      return Promise.resolve(Buffer.concat([header, Buffer.alloc(100)]));
    }),
    unlink: vi.fn(() => Promise.resolve()),
    rmdir: vi.fn(() => Promise.resolve()),
  },
}));

describe("PiperTtsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create provider with config", () => {
    const provider = createPiperProvider({
      model: "en_US-amy-medium",
      dataDir: "~/.openclaw/piper",
    });

    expect(provider.name).toBe("piper");
  });

  it("should use default config values", () => {
    const provider = createPiperProvider();
    expect(provider.name).toBe("piper");
  });

  it("should have correct interface", () => {
    const provider = new PiperTtsProvider({
      model: "en_US-amy-medium",
      dataDir: "~/.openclaw/piper",
      lengthScale: 1.0,
    });

    expect(typeof provider.initialize).toBe("function");
    expect(typeof provider.isReady).toBe("function");
    expect(typeof provider.synthesize).toBe("function");
    expect(typeof provider.synthesizeForTelephony).toBe("function");
  });
});

describe("Piper configuration", () => {
  it("should accept various voice models", () => {
    const voices = ["en_US-amy-medium", "en_US-lessac-medium", "en_GB-alan-medium"];

    for (const model of voices) {
      const provider = createPiperProvider({ model });
      expect(provider.name).toBe("piper");
    }
  });

  it("should accept length scale for speech rate", () => {
    const slowProvider = createPiperProvider({ lengthScale: 1.5 });
    const fastProvider = createPiperProvider({ lengthScale: 0.8 });

    expect(slowProvider.name).toBe("piper");
    expect(fastProvider.name).toBe("piper");
  });

  it("should accept speaker ID for multi-speaker models", () => {
    const provider = createPiperProvider({ speakerId: 0 });
    expect(provider.name).toBe("piper");
  });
});
