/**
 * Whisper STT Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WhisperSttProvider, createWhisperProvider } from "../src/stt/whisper.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn(),
      once: vi.fn((event, cb) => {
        if (event === "data") {
          setTimeout(() => cb(Buffer.from('{"status":"ready","model":"base","device":"cpu"}')), 10);
        }
      }),
    },
    stderr: { on: vi.fn() },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn((event, cb) => {
      // Don't call exit immediately
    }),
    kill: vi.fn(),
  })),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    mkdtemp: vi.fn(() => Promise.resolve("/tmp/whisper-test")),
    writeFile: vi.fn(() => Promise.resolve()),
    chmod: vi.fn(() => Promise.resolve()),
    readFile: vi.fn(() => Promise.resolve(Buffer.alloc(100))),
    unlink: vi.fn(() => Promise.resolve()),
    rmdir: vi.fn(() => Promise.resolve()),
  },
}));

describe("WhisperSttProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create provider with config", () => {
    const provider = createWhisperProvider({
      model: "small",
      device: "cuda",
    });

    expect(provider.name).toBe("whisper");
  });

  it("should use default config values", () => {
    const provider = createWhisperProvider();
    expect(provider.name).toBe("whisper");
  });

  it("should have correct interface", () => {
    const provider = new WhisperSttProvider({
      model: "base",
      device: "cpu",
      language: "en",
    });

    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.isReady).toBe("function");
    expect(typeof provider.transcribe).toBe("function");
  });
});

describe("Whisper configuration", () => {
  it("should accept all model sizes", () => {
    const models = ["tiny", "base", "small", "medium", "large"];

    for (const model of models) {
      const provider = createWhisperProvider({
        model: model as "tiny" | "base" | "small" | "medium" | "large",
      });
      expect(provider.name).toBe("whisper");
    }
  });

  it("should accept device options", () => {
    const cpuProvider = createWhisperProvider({ device: "cpu" });
    const cudaProvider = createWhisperProvider({ device: "cuda" });

    expect(cpuProvider.name).toBe("whisper");
    expect(cudaProvider.name).toBe("whisper");
  });
});
