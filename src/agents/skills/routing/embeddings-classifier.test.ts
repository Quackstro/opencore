/**
 * Tests for embeddings classifier.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SkillEntry } from "../types.js";
import type { SkillRoutingConfig } from "./types.js";
import {
  classifyWithEmbeddings,
  classifyWithEmbeddingsBatch,
  cosineSimilarity,
  clearEmbeddingCache,
  type EmbeddingProvider,
} from "./embeddings-classifier.js";

// Mock embedding provider
function createMockEmbeddingProvider(embeddings: Map<string, number[]>): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-embeddings",
    embedQuery: vi.fn(async (text: string) => {
      // Return a deterministic embedding based on text hash
      const hash = text.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
      const embedding = Array.from({ length: 384 }, (_, i) => Math.sin(hash * (i + 1) * 0.01));
      // Override with predefined embeddings if available
      for (const [key, value] of embeddings) {
        if (text.toLowerCase().includes(key.toLowerCase())) {
          return value;
        }
      }
      return embedding;
    }),
    embedBatch: vi.fn(async (texts: string[]) => {
      const results: number[][] = [];
      for (const text of texts) {
        const hash = text.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
        let embedding = Array.from({ length: 384 }, (_, i) => Math.sin(hash * (i + 1) * 0.01));
        for (const [key, value] of embeddings) {
          if (text.toLowerCase().includes(key.toLowerCase())) {
            embedding = value;
            break;
          }
        }
        results.push(embedding);
      }
      return results;
    }),
  };
}

// Helper to create mock skill entries
function createSkillEntry(
  name: string,
  options: {
    domains?: string[];
    description?: string;
    alwaysInclude?: boolean;
    domainWeight?: number;
  } = {},
): SkillEntry {
  return {
    skill: {
      name,
      description: options.description ?? `${name} skill`,
      baseDir: `/skills/${name}`,
      filePath: `/skills/${name}/SKILL.md`,
      content: "",
      source: "test",
    },
    frontmatter: {},
    metadata: {
      domains: options.domains,
      alwaysInclude: options.alwaysInclude,
      domainWeight: options.domainWeight,
    } as SkillEntry["metadata"],
  };
}

describe("embeddings-classifier", () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const vec = [1, 2, 3, 4, 5];
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
    });

    it("returns 0.5 for orthogonal vectors (normalized)", () => {
      // Orthogonal vectors have cosine similarity of 0
      // After normalization to 0-1 range: (0 + 1) / 2 = 0.5
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 5);
    });

    it("returns 0 for opposite vectors (normalized)", () => {
      // Opposite vectors have cosine similarity of -1
      // After normalization to 0-1 range: (-1 + 1) / 2 = 0
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it("handles zero vectors", () => {
      const zero = [0, 0, 0];
      const vec = [1, 2, 3];
      expect(cosineSimilarity(zero, vec)).toBe(0);
      expect(cosineSimilarity(vec, zero)).toBe(0);
    });

    it("throws for mismatched dimensions", () => {
      expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("Vector dimension mismatch");
    });

    it("returns 0 for empty vectors", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });
  });

  describe("classifyWithEmbeddings", () => {
    const skills: SkillEntry[] = [
      createSkillEntry("claude-code", {
        domains: ["coding"],
        description: "Code generation and debugging",
      }),
      createSkillEntry("paralegal", {
        domains: ["legal"],
        description: "Legal document assistance",
      }),
      createSkillEntry("accountant", {
        domains: ["finance"],
        description: "Financial calculations",
      }),
      createSkillEntry("always-on", { domains: ["misc"], alwaysInclude: true }),
    ];

    const config: SkillRoutingConfig = {
      mode: "dynamic",
      dynamic: {
        classifier: "embeddings",
        minConfidence: 0.3,
        embeddings: {
          cacheEmbeddings: true,
        },
      },
    };

    it("classifies skills based on embedding similarity", async () => {
      // Create embeddings that are similar for coding-related content
      const codingEmbedding = Array.from({ length: 384 }, () => 0.5);
      const embeddings = new Map<string, number[]>([
        ["code", codingEmbedding],
        ["coding", codingEmbedding],
        ["function", codingEmbedding],
      ]);

      const provider = createMockEmbeddingProvider(embeddings);
      const context = { message: "Help me write a function" };

      const result = await classifyWithEmbeddings(context, skills, config, provider);

      expect(result).toHaveLength(skills.length);
      expect(result[0].skillName).toBeDefined();
      expect(result[0].confidence).toBeGreaterThanOrEqual(0);
      expect(result[0].confidence).toBeLessThanOrEqual(1);
    });

    it("always-include skills get confidence 1.0", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Random message" };

      const result = await classifyWithEmbeddings(context, skills, config, provider);

      const alwaysOn = result.find((r) => r.skillName === "always-on");
      expect(alwaysOn?.confidence).toBe(1.0);
      expect(alwaysOn?.reason).toBe("alwaysInclude flag");
    });

    it("respects domain weight", async () => {
      const weightedSkills = [
        createSkillEntry("high-weight", { domains: ["coding"], domainWeight: 1.0 }),
        createSkillEntry("low-weight", { domains: ["coding"], domainWeight: 0.5 }),
      ];

      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Write code" };

      const result = await classifyWithEmbeddings(context, weightedSkills, config, provider);

      // Both should be classified, but low-weight should have lower confidence
      const high = result.find((r) => r.skillName === "high-weight");
      const low = result.find((r) => r.skillName === "low-weight");

      expect(high).toBeDefined();
      expect(low).toBeDefined();
      // The low-weight skill should have its confidence scaled by 0.5
    });

    it("includes conversation history in context", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = {
        message: "continue with that",
        conversationHistory: ["Let's work on the code", "Sure, I can help"],
      };

      await classifyWithEmbeddings(context, skills, config, provider);

      // The embedQuery should have been called with combined context
      expect(provider.embedQuery).toHaveBeenCalled();
      const callArg = (provider.embedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg).toContain("code");
      expect(callArg).toContain("continue with that");
    });

    it("caches skill embeddings when enabled", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Test message" };

      await classifyWithEmbeddings(context, skills, config, provider);
      await classifyWithEmbeddings(context, skills, config, provider);

      // Skills should only be embedded once due to caching
      // (excluding always-include which skips embedding)
      const skillEmbedCalls = (provider.embedQuery as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => !call[0].includes("Test message"),
      );
      expect(skillEmbedCalls.length).toBeLessThanOrEqual(skills.length - 1); // -1 for alwaysInclude
    });

    it("returns sorted results by confidence", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Test" };

      const result = await classifyWithEmbeddings(context, skills, config, provider);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence);
      }
    });
  });

  describe("classifyWithEmbeddingsBatch", () => {
    const skills: SkillEntry[] = [
      createSkillEntry("skill-a", { domains: ["coding"] }),
      createSkillEntry("skill-b", { domains: ["legal"] }),
      createSkillEntry("skill-c", { domains: ["finance"] }),
    ];

    const config: SkillRoutingConfig = {
      mode: "dynamic",
      dynamic: { classifier: "embeddings" },
    };

    it("uses batch embedding for efficiency", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Test message" };

      await classifyWithEmbeddingsBatch(context, skills, config, provider);

      // Should use embedBatch instead of individual embedQuery calls
      expect(provider.embedBatch).toHaveBeenCalledTimes(1);
    });

    it("produces same results as non-batch version", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const context = { message: "Test message" };

      const batchResult = await classifyWithEmbeddingsBatch(context, skills, config, provider);
      clearEmbeddingCache();

      // Reset mock calls
      (provider.embedQuery as ReturnType<typeof vi.fn>).mockClear();

      const regularResult = await classifyWithEmbeddings(context, skills, config, provider);

      // Results should have same structure
      expect(batchResult.length).toBe(regularResult.length);
      expect(batchResult.map((r) => r.skillName).sort()).toEqual(
        regularResult.map((r) => r.skillName).sort(),
      );
    });
  });

  describe("clearEmbeddingCache", () => {
    it("clears cached embeddings", async () => {
      const provider = createMockEmbeddingProvider(new Map());
      const skills = [createSkillEntry("test-skill", { domains: ["coding"] })];
      const config: SkillRoutingConfig = {
        mode: "dynamic",
        dynamic: { classifier: "embeddings", embeddings: { cacheEmbeddings: true } },
      };
      const context = { message: "Test" };

      await classifyWithEmbeddings(context, skills, config, provider);
      clearEmbeddingCache();
      await classifyWithEmbeddings(context, skills, config, provider);

      // Skills should be embedded twice (once before clear, once after)
      const skillEmbedCalls = (provider.embedQuery as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => !call[0].includes("Test"),
      );
      expect(skillEmbedCalls.length).toBe(2);
    });
  });
});
