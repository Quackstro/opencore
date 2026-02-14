/**
 * TTS Module Entry Point
 */

export { PiperTtsProvider, createPiperProvider, listPiperVoices } from "./piper.js";
export { EdgeTtsProvider, createEdgeProvider, listEdgeVoices } from "./edge.js";

export type { TtsProvider, TtsResult } from "../types.js";

import type { TtsConfig, TtsProvider } from "../types.js";
import { EdgeTtsProvider } from "./edge.js";
import { PiperTtsProvider } from "./piper.js";

/**
 * Create a TTS provider based on configuration.
 * Returns Piper as primary with Edge as fallback.
 */
export function createTtsProvider(config: TtsConfig): TtsProvider {
  if (config.provider === "edge") {
    return new EdgeTtsProvider(config.edge);
  }
  return new PiperTtsProvider(config.piper);
}

/**
 * Create a TTS provider with fallback.
 * Tries primary first, falls back to secondary on failure.
 */
export class FallbackTtsProvider implements TtsProvider {
  readonly name = "fallback";
  private primary: TtsProvider;
  private fallback: TtsProvider;
  private useFallback = false;

  constructor(primary: TtsProvider, fallback: TtsProvider) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async isReady(): Promise<boolean> {
    const primaryReady = await this.primary.isReady();
    if (primaryReady) {
      this.useFallback = false;
      return true;
    }

    const fallbackReady = await this.fallback.isReady();
    if (fallbackReady) {
      this.useFallback = true;
      console.warn("[TTS] Using fallback provider");
      return true;
    }

    return false;
  }

  async synthesize(text: string) {
    if (!this.useFallback) {
      try {
        return await this.primary.synthesize(text);
      } catch (err) {
        console.warn("[TTS] Primary failed, trying fallback:", err);
        this.useFallback = true;
      }
    }
    return await this.fallback.synthesize(text);
  }

  async synthesizeForTelephony(text: string): Promise<Buffer> {
    if (!this.useFallback) {
      try {
        return await this.primary.synthesizeForTelephony(text);
      } catch (err) {
        console.warn("[TTS] Primary failed, trying fallback:", err);
        this.useFallback = true;
      }
    }
    return await this.fallback.synthesizeForTelephony(text);
  }
}

/**
 * Create TTS with automatic fallback from Piper to Edge.
 */
export function createTtsWithFallback(config: TtsConfig): TtsProvider {
  const piper = new PiperTtsProvider(config.piper);
  const edge = new EdgeTtsProvider(config.edge);
  return new FallbackTtsProvider(piper, edge);
}
