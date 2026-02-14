/**
 * Edge TTS Provider (Fallback)
 *
 * Uses Microsoft Edge's online TTS service as a fallback.
 * This is a simplified wrapper that calls the edge-tts CLI.
 */

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EdgeConfig, TtsProvider, TtsResult } from "../types.js";
import { wavToPcm, pcmToMulaw8k } from "../audio-utils.js";

/**
 * Edge TTS Provider using the edge-tts Python package.
 */
export class EdgeTtsProvider implements TtsProvider {
  readonly name = "edge";
  private config: EdgeConfig;
  private ready = false;

  constructor(config: EdgeConfig) {
    this.config = config;
  }

  /**
   * Initialize the Edge TTS provider.
   * Verifies that edge-tts is installed.
   */
  async initialize(): Promise<void> {
    try {
      await this.runEdgeTts(["--list-voices"]);
      this.ready = true;
      console.log(`[EdgeTTS] initialized: voice=${this.config.voice}`);
    } catch (err) {
      throw new Error("edge-tts not found. Install with: pip install edge-tts");
    }
  }

  /**
   * Check if the provider is ready.
   */
  async isReady(): Promise<boolean> {
    if (!this.ready) {
      try {
        await this.initialize();
      } catch {
        return false;
      }
    }
    return this.ready;
  }

  /**
   * Synthesize speech from text.
   *
   * @param text - Text to synthesize
   * @returns TTS result with audio buffer
   */
  async synthesize(text: string): Promise<TtsResult> {
    if (!(await this.isReady())) {
      throw new Error("Edge TTS not ready");
    }

    // Create temp files
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "edge-tts-"));
    const outputPath = path.join(tempDir, "output.mp3");

    try {
      // Run edge-tts
      await this.runEdgeTts([
        "--voice",
        this.config.voice,
        "--text",
        text,
        "--write-media",
        outputPath,
      ]);

      // Read output and convert to PCM
      // Note: edge-tts outputs MP3, we need to convert
      // For simplicity, we'll use ffmpeg if available, otherwise throw
      const pcmPath = path.join(tempDir, "output.wav");
      await this.convertToWav(outputPath, pcmPath);

      const wav = await fsp.readFile(pcmPath);
      const { pcm, sampleRate } = wavToPcm(wav);

      const samples = Math.floor(pcm.length / 2);
      const durationMs = Math.floor((samples / sampleRate) * 1000);

      return {
        audio: pcm,
        sampleRate,
        format: "pcm16",
        durationMs,
      };
    } finally {
      // Cleanup
      try {
        await fsp.rm(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Synthesize speech for telephony (mu-law 8kHz).
   *
   * @param text - Text to synthesize
   * @returns mu-law encoded audio buffer
   */
  async synthesizeForTelephony(text: string): Promise<Buffer> {
    const result = await this.synthesize(text);
    return pcmToMulaw8k(result.audio, result.sampleRate);
  }

  /**
   * Run edge-tts CLI.
   */
  private runEdgeTts(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("edge-tts", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        reject(new Error(`edge-tts spawn error: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`edge-tts exited with code ${code}: ${stderr}`));
        }
      });

      proc.stdin?.end();
    });
  }

  /**
   * Convert audio file to WAV using ffmpeg.
   */
  private convertToWav(input: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        "ffmpeg",
        ["-y", "-i", input, "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1", output],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stderr = "";

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        reject(new Error(`ffmpeg not found: ${err.message}. Install with: apt install ffmpeg`));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });
  }
}

/**
 * Create an Edge TTS provider with default configuration.
 */
export function createEdgeProvider(config?: Partial<EdgeConfig>): EdgeTtsProvider {
  const fullConfig: EdgeConfig = {
    voice: config?.voice ?? "en-US-AriaNeural",
  };
  return new EdgeTtsProvider(fullConfig);
}

/**
 * List available Edge TTS voices.
 */
export async function listEdgeVoices(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("edge-tts", ["--list-voices"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("error", () => {
      resolve([]);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        // Parse voice names from output
        const voices = stdout
          .split("\n")
          .filter((line) => line.includes("Name:"))
          .map((line) => line.split("Name:")[1]?.trim())
          .filter(Boolean);
        resolve(voices);
      } else {
        resolve([]);
      }
    });
  });
}

export default EdgeTtsProvider;
