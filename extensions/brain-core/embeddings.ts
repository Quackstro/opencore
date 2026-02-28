/**
 * Brain Core — Embedding Providers.
 *
 * Supports both Gemini and OpenAI (or OpenAI-compatible) embedding APIs.
 * Auto-detects provider based on API key prefix (AI... = Gemini).
 */

import type { EmbeddingProvider } from "./schemas.js";

// ============================================================================
// Gemini Embeddings
// ============================================================================

export class BrainGeminiEmbeddings implements EmbeddingProvider {
  readonly dim: number;
  readonly name: string;

  constructor(
    private apiKey: string,
    private model: string = "gemini-embedding-001",
  ) {
    // gemini-embedding-001 outputs 3072-dim vectors
    this.dim = 3072;
    this.name = `Brain Embeddings (${model})`;
  }

  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
      const requests = batch.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }));
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Batch embedding failed: ${res.status} ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as any;
      allEmbeddings.push(...data.embeddings.map((e: any) => e.values));
    }
    return allEmbeddings;
  }
}

// ============================================================================
// OpenAI Embeddings (also supports OpenAI-compatible APIs)
// ============================================================================

export class BrainOpenAIEmbeddings implements EmbeddingProvider {
  readonly dim: number;
  readonly name: string;
  private apiKey: string;
  private model: string;
  private embeddingsUrl: string;

  constructor(apiKey: string, model: string = "text-embedding-3-small", baseURL?: string) {
    this.apiKey = apiKey;
    this.model = model;
    const base = (baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.embeddingsUrl = `${base}/embeddings`;
    this.name = `Brain Embeddings (${model})`;
    // text-embedding-3-large = 3072, others = 1536
    this.dim = model === "text-embedding-3-large" ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(this.embeddingsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(this.embeddingsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Batch embedding failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return data.data.map((d: any) => d.embedding);
  }
}

// ============================================================================
// Factory function
// ============================================================================

export interface EmbeddingConfig {
  provider?: "gemini" | "openai" | "auto";
  apiKey: string;
  model?: string;
  baseURL?: string;
}

/**
 * Create an embedding provider from config.
 * Auto-detects provider: Gemini keys start with "AI", otherwise OpenAI-compatible.
 *
 * @param config - Embedding configuration
 * @returns EmbeddingProvider instance
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  const provider = config.provider ?? "auto";
  const model = config.model ?? "text-embedding-3-small";

  // Auto-detect: Gemini keys start with "AI"
  const isGemini = provider === "gemini" || (provider === "auto" && config.apiKey.startsWith("AI"));

  if (isGemini) {
    const geminiModel = model.startsWith("gemini-") ? model : "gemini-embedding-001";
    return new BrainGeminiEmbeddings(config.apiKey, geminiModel);
  }

  return new BrainOpenAIEmbeddings(config.apiKey, model, config.baseURL);
}

/**
 * Get the vector dimension for a given model.
 */
export function getVectorDimension(
  model: string,
  provider: "gemini" | "openai" | "auto" = "auto",
): number {
  // Gemini models
  if (model.startsWith("gemini-") || provider === "gemini") {
    return 3072;
  }
  // OpenAI models
  if (model === "text-embedding-3-large") {
    return 3072;
  }
  return 1536; // Default for text-embedding-3-small and others
}
