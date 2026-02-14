/**
 * Whisper STT Provider
 *
 * Integrates with faster-whisper (Python) for speech-to-text transcription.
 * Uses a Python subprocess with JSON-RPC-like communication.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WhisperConfig, SttProvider, SttResult } from "../types.js";
import { pcmToWav, mulawToWhisperPcm, SAMPLE_RATES } from "../audio-utils.js";

// Python script for faster-whisper integration
const WHISPER_WORKER_SCRIPT = `
#!/usr/bin/env python3
"""
Whisper STT Worker
Reads WAV files from stdin commands and outputs JSON transcriptions.
"""
import sys
import json
import os
import tempfile
import traceback

def main():
    model_name = os.environ.get("WHISPER_MODEL", "base")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = "int8" if device == "cpu" else "float16"
    language = os.environ.get("WHISPER_LANGUAGE", "en")
    
    # Import faster-whisper
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper not installed. Run: pip install faster-whisper"}), flush=True)
        sys.exit(1)
    
    # Load model
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        print(json.dumps({"status": "ready", "model": model_name, "device": device}), flush=True)
    except Exception as e:
        print(json.dumps({"error": f"Failed to load model: {str(e)}"}), flush=True)
        sys.exit(1)
    
    # Process commands from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            cmd = json.loads(line)
            action = cmd.get("action")
            
            if action == "transcribe":
                wav_path = cmd.get("path")
                if not wav_path or not os.path.exists(wav_path):
                    print(json.dumps({"error": "File not found", "id": cmd.get("id")}), flush=True)
                    continue
                
                # Transcribe
                segments, info = model.transcribe(
                    wav_path,
                    language=language,
                    beam_size=5,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 300}
                )
                
                # Collect segments
                text_parts = []
                for segment in segments:
                    text_parts.append(segment.text.strip())
                
                text = " ".join(text_parts)
                
                result = {
                    "id": cmd.get("id"),
                    "text": text,
                    "language": info.language,
                    "duration_ms": int(info.duration * 1000),
                    "language_probability": info.language_probability
                }
                print(json.dumps(result), flush=True)
                
            elif action == "ping":
                print(json.dumps({"pong": True, "id": cmd.get("id")}), flush=True)
                
            elif action == "quit":
                break
                
        except json.JSONDecodeError:
            print(json.dumps({"error": "Invalid JSON"}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}), flush=True)

if __name__ == "__main__":
    main()
`;

interface PendingRequest {
  resolve: (result: SttResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Whisper STT Provider using faster-whisper Python library.
 */
export class WhisperSttProvider implements SttProvider {
  readonly name = "whisper";
  private config: WhisperConfig;
  private process: ChildProcess | null = null;
  private ready = false;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private outputBuffer = "";
  private scriptPath: string | null = null;

  constructor(config: WhisperConfig) {
    this.config = config;
  }

  /**
   * Start the Whisper worker process.
   */
  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    // Write worker script to temp file
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "whisper-"));
    this.scriptPath = path.join(tempDir, "whisper_worker.py");
    await fsp.writeFile(this.scriptPath, WHISPER_WORKER_SCRIPT, "utf-8");
    await fsp.chmod(this.scriptPath, 0o755);

    // Spawn Python process
    this.process = spawn("python3", [this.scriptPath], {
      env: {
        ...process.env,
        WHISPER_MODEL: this.config.model,
        WHISPER_DEVICE: this.config.device,
        WHISPER_LANGUAGE: this.config.language,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data) => this.handleOutput(data.toString()));
    this.process.stderr?.on("data", (data) => {
      console.error("[WhisperSTT] stderr:", data.toString());
    });

    this.process.on("error", (err) => {
      console.error("[WhisperSTT] process error:", err);
      this.ready = false;
    });

    this.process.on("exit", (code) => {
      console.log(`[WhisperSTT] process exited with code ${code}`);
      this.ready = false;
      this.process = null;
    });

    // Wait for ready signal
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Whisper worker startup timeout"));
      }, 60000); // 60s for model loading

      const checkReady = (data: string) => {
        try {
          const msg = JSON.parse(data);
          if (msg.status === "ready") {
            clearTimeout(timeout);
            this.ready = true;
            console.log(`[WhisperSTT] ready: model=${msg.model}, device=${msg.device}`);
            resolve();
          } else if (msg.error) {
            clearTimeout(timeout);
            reject(new Error(msg.error));
          }
        } catch {
          // Not JSON, ignore
        }
      };

      // Temporarily attach listener for ready signal
      const handler = (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          checkReady(line);
        }
      };
      this.process!.stdout?.once("data", handler);
    });
  }

  /**
   * Stop the Whisper worker process.
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      this.sendCommand({ action: "quit" });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      this.process = null;
      this.ready = false;

      // Cleanup script
      if (this.scriptPath) {
        try {
          await fsp.unlink(this.scriptPath);
          await fsp.rmdir(path.dirname(this.scriptPath));
        } catch {
          // Ignore cleanup errors
        }
        this.scriptPath = null;
      }
    }
  }

  /**
   * Check if the provider is ready.
   */
  async isReady(): Promise<boolean> {
    if (!this.process || !this.ready) {
      try {
        await this.start();
      } catch {
        return false;
      }
    }
    return this.ready;
  }

  /**
   * Transcribe audio buffer.
   *
   * @param audio - Audio buffer (mu-law from Twilio or PCM)
   * @param sampleRate - Input sample rate (default 8000 for telephony)
   * @returns Transcription result
   */
  async transcribe(audio: Buffer, sampleRate = 8000): Promise<SttResult> {
    if (!(await this.isReady())) {
      throw new Error("Whisper STT not ready");
    }

    // Convert to 16kHz PCM WAV for Whisper
    let pcm: Buffer;
    if (sampleRate === 8000) {
      // Assume mu-law from Twilio
      pcm = mulawToWhisperPcm(audio);
    } else {
      // Already PCM, just need to resample
      const { resamplePcm } = await import("../audio-utils.js");
      pcm = resamplePcm(audio, sampleRate, SAMPLE_RATES.WHISPER);
    }

    // Write to temp file
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "whisper-audio-"));
    const wavPath = path.join(tempDir, "audio.wav");
    const wav = pcmToWav(pcm, SAMPLE_RATES.WHISPER);
    await fsp.writeFile(wavPath, wav);

    try {
      const id = ++this.requestId;
      const result = await this.sendRequest({
        action: "transcribe",
        path: wavPath,
        id,
      });

      return {
        text: result.text || "",
        confidence: result.language_probability,
        language: result.language,
        durationMs: result.duration_ms,
      };
    } finally {
      // Cleanup temp files
      try {
        await fsp.unlink(wavPath);
        await fsp.rmdir(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      throw new Error("Whisper process not running");
    }
    this.process.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private sendRequest(
    cmd: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = cmd.id as number;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Whisper transcription timeout"));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as unknown as Record<string, unknown>),
        reject,
        timeout,
      });

      this.sendCommand(cmd);
    });
  }

  private handleOutput(data: string): void {
    this.outputBuffer += data;
    const lines = this.outputBuffer.split("\n");

    // Keep incomplete line in buffer
    this.outputBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);

        if (msg.id !== undefined) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(msg.id);

            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg as SttResult);
            }
          }
        }
      } catch {
        console.warn("[WhisperSTT] unparseable output:", line);
      }
    }
  }
}

/**
 * Create a Whisper STT provider with default configuration.
 */
export function createWhisperProvider(config?: Partial<WhisperConfig>): WhisperSttProvider {
  const fullConfig: WhisperConfig = {
    model: config?.model ?? "base",
    device: config?.device ?? "cpu",
    language: config?.language ?? "en",
  };
  return new WhisperSttProvider(fullConfig);
}

export default WhisperSttProvider;
