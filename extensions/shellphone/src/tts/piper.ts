/**
 * Piper TTS Provider
 *
 * Integrates with Piper TTS for fast, natural text-to-speech.
 * https://github.com/rhasspy/piper
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiperConfig, TtsProvider, TtsResult } from "../types.js";
import { wavToPcm, pcmToMulaw8k } from "../audio-utils.js";

const PIPER_SAMPLE_RATE = 22050;

/**
 * Resolve ~ to home directory.
 */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Piper TTS Provider.
 */
export class PiperTtsProvider implements TtsProvider {
  readonly name = "piper";
  private config: PiperConfig;
  private modelPath: string | null = null;
  private configPath: string | null = null;
  private ready = false;

  constructor(config: PiperConfig) {
    this.config = config;
  }

  /**
   * Initialize the Piper provider.
   * Locates model files and verifies Piper is installed.
   */
  async initialize(): Promise<void> {
    const dataDir = expandPath(this.config.dataDir);

    // Check if Piper is installed
    try {
      await this.runPiper(["--help"]);
    } catch (err) {
      throw new Error("Piper not found. Install with: ./scripts/install-piper.sh");
    }

    // Find model files
    const modelName = this.config.model;
    const possiblePaths = [
      path.join(dataDir, modelName, `${modelName}.onnx`),
      path.join(dataDir, `${modelName}.onnx`),
      path.join(dataDir, modelName, "model.onnx"),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.modelPath = p;
        // Look for config json
        const configPath = p.replace(".onnx", ".onnx.json");
        if (fs.existsSync(configPath)) {
          this.configPath = configPath;
        }
        break;
      }
    }

    if (!this.modelPath) {
      throw new Error(
        `Piper model not found: ${modelName}. Download with: ./scripts/install-piper.sh ${modelName}`,
      );
    }

    this.ready = true;
    console.log(`[PiperTTS] initialized: model=${this.modelPath}`);
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
      throw new Error("Piper TTS not ready");
    }

    // Create temp file for output
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "piper-"));
    const outputPath = path.join(tempDir, "output.wav");

    try {
      // Build Piper command
      const args = ["--model", this.modelPath!, "--output_file", outputPath];

      if (this.configPath) {
        args.push("--config", this.configPath);
      }

      if (this.config.speakerId !== undefined) {
        args.push("--speaker", String(this.config.speakerId));
      }

      if (this.config.lengthScale !== 1.0) {
        args.push("--length_scale", String(this.config.lengthScale));
      }

      // Run Piper with text on stdin
      await this.runPiper(args, text);

      // Read output WAV
      const wav = await fsp.readFile(outputPath);
      const { pcm, sampleRate } = wavToPcm(wav);

      // Calculate duration
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
        await fsp.unlink(outputPath);
        await fsp.rmdir(tempDir);
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
   * Run Piper with given arguments.
   */
  private runPiper(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("piper", args, {
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
        reject(new Error(`Piper spawn error: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Piper exited with code ${code}: ${stderr}`));
        }
      });

      // Send text on stdin
      if (stdin !== undefined) {
        proc.stdin?.write(stdin);
        proc.stdin?.end();
      } else {
        proc.stdin?.end();
      }
    });
  }
}

/**
 * Create a Piper TTS provider with default configuration.
 */
export function createPiperProvider(config?: Partial<PiperConfig>): PiperTtsProvider {
  const fullConfig: PiperConfig = {
    model: config?.model ?? "en_US-amy-medium",
    dataDir: config?.dataDir ?? "~/.openclaw/piper",
    speakerId: config?.speakerId,
    lengthScale: config?.lengthScale ?? 1.0,
  };
  return new PiperTtsProvider(fullConfig);
}

/**
 * List available Piper voices in the data directory.
 */
export async function listPiperVoices(dataDir: string): Promise<string[]> {
  const expanded = expandPath(dataDir);

  if (!fs.existsSync(expanded)) {
    return [];
  }

  const entries = await fsp.readdir(expanded, { withFileTypes: true });
  const voices: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Check if directory contains a model
      const modelPath = path.join(expanded, entry.name, `${entry.name}.onnx`);
      if (fs.existsSync(modelPath)) {
        voices.push(entry.name);
      }
    } else if (entry.name.endsWith(".onnx")) {
      // Direct model file
      voices.push(entry.name.replace(".onnx", ""));
    }
  }

  return voices;
}

export default PiperTtsProvider;
