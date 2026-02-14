/**
 * Tests for LLM classifier.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SkillEntry } from "../types.js";
import type { SkillRoutingConfig } from "./types.js";
import {
  classifyWithLLM,
  parseLlmResponse,
  createLlmClassifierProvider,
  type LlmClassifierProvider,
} from "./llm-classifier.js";

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

// Create mock LLM provider
function createMockLlmProvider(response: string): LlmClassifierProvider {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

describe("llm-classifier", () => {
  describe("parseLlmResponse", () => {
    it("parses valid JSON array", () => {
      expect(parseLlmResponse('["coding", "devops"]')).toEqual(["coding", "devops"]);
    });

    it("parses JSON array with surrounding text", () => {
      expect(parseLlmResponse('Here are the domains: ["coding", "devops"]')).toEqual([
        "coding",
        "devops",
      ]);
    });

    it("parses JSON array with trailing text", () => {
      expect(parseLlmResponse('["coding", "devops"] These are relevant.')).toEqual([
        "coding",
        "devops",
      ]);
    });

    it("handles empty array", () => {
      expect(parseLlmResponse("[]")).toEqual([]);
    });

    it("normalizes domain names to lowercase", () => {
      expect(parseLlmResponse('["CODING", "DevOps"]')).toEqual(["coding", "devops"]);
    });

    it("filters out non-string elements", () => {
      expect(parseLlmResponse('["coding", 123, null, "devops"]')).toEqual(["coding", "devops"]);
    });

    it("filters out empty strings", () => {
      expect(parseLlmResponse('["coding", "", "devops"]')).toEqual(["coding", "devops"]);
    });

    it("returns empty array for invalid JSON", () => {
      expect(parseLlmResponse("not json")).toEqual([]);
    });

    it("returns empty array for no array found", () => {
      expect(parseLlmResponse('{"domain": "coding"}')).toEqual([]);
    });

    it("handles multiline JSON", () => {
      const response = `The relevant domains are:
["coding",
 "devops"]`;
      expect(parseLlmResponse(response)).toEqual(["coding", "devops"]);
    });

    it("trims whitespace from domains", () => {
      expect(parseLlmResponse('["  coding  ", " devops "]')).toEqual(["coding", "devops"]);
    });
  });

  describe("classifyWithLLM", () => {
    const skills: SkillEntry[] = [
      createSkillEntry("claude-code", { domains: ["coding", "devops"] }),
      createSkillEntry("paralegal", { domains: ["legal"] }),
      createSkillEntry("accountant", { domains: ["finance"] }),
      createSkillEntry("always-on", { domains: ["misc"], alwaysInclude: true }),
    ];

    const config: SkillRoutingConfig = {
      mode: "dynamic",
      dynamic: {
        classifier: "llm",
        minConfidence: 0.3,
        llm: {
          model: "anthropic/claude-haiku",
          maxTokens: 100,
        },
      },
    };

    it("classifies skills based on LLM response", async () => {
      const provider = createMockLlmProvider('["coding"]');
      const context = { message: "Help me write code" };

      const result = await classifyWithLLM(context, skills, config, provider);

      expect(result).toHaveLength(skills.length);
      const codingSkill = result.find((r) => r.skillName === "claude-code");
      expect(codingSkill?.confidence).toBeGreaterThan(0);
    });

    it("orders confidence by position in LLM response", async () => {
      const provider = createMockLlmProvider('["coding", "legal"]');
      const context = { message: "Help me with legal code" };

      const result = await classifyWithLLM(context, skills, config, provider);

      const codingSkill = result.find((r) => r.skillName === "claude-code");
      const legalSkill = result.find((r) => r.skillName === "paralegal");

      // Coding should have higher confidence (position 0 vs position 1)
      expect(codingSkill?.confidence).toBeGreaterThan(legalSkill?.confidence ?? 0);
    });

    it("always-include skills get confidence 1.0", async () => {
      const provider = createMockLlmProvider("[]");
      const context = { message: "Random message" };

      const result = await classifyWithLLM(context, skills, config, provider);

      const alwaysOn = result.find((r) => r.skillName === "always-on");
      expect(alwaysOn?.confidence).toBe(1.0);
      expect(alwaysOn?.reason).toBe("alwaysInclude flag");
    });

    it("skills without matching domains get 0 confidence", async () => {
      const provider = createMockLlmProvider('["coding"]');
      const context = { message: "Help me write code" };

      const result = await classifyWithLLM(context, skills, config, provider);

      const financeSkill = result.find((r) => r.skillName === "accountant");
      expect(financeSkill?.confidence).toBe(0);
    });

    it("skills without domains get low baseline confidence", async () => {
      const skillsWithNoDomains = [createSkillEntry("no-domains", {}), ...skills];
      const provider = createMockLlmProvider('["coding"]');
      const context = { message: "Help me" };

      const result = await classifyWithLLM(context, skillsWithNoDomains, config, provider);

      const noDomains = result.find((r) => r.skillName === "no-domains");
      expect(noDomains?.confidence).toBe(0.1);
      expect(noDomains?.reason).toBe("no domains defined");
    });

    it("includes conversation history in prompt", async () => {
      const provider = createMockLlmProvider('["coding"]');
      const context = {
        message: "continue with that",
        conversationHistory: ["Let's work on the code", "Sure, I can help"],
      };

      await classifyWithLLM(context, skills, config, provider);

      expect(provider.complete).toHaveBeenCalledTimes(1);
      const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(prompt).toContain("code");
      expect(prompt).toContain("continue with that");
    });

    it("respects domain weight", async () => {
      const weightedSkills = [
        createSkillEntry("high-weight", { domains: ["coding"], domainWeight: 1.0 }),
        createSkillEntry("low-weight", { domains: ["coding"], domainWeight: 0.5 }),
      ];
      const provider = createMockLlmProvider('["coding"]');
      const context = { message: "Write code" };

      const result = await classifyWithLLM(context, weightedSkills, config, provider);

      const high = result.find((r) => r.skillName === "high-weight");
      const low = result.find((r) => r.skillName === "low-weight");

      expect(high?.confidence).toBeGreaterThan(low?.confidence ?? 0);
    });

    it("passes correct options to LLM provider", async () => {
      const provider = createMockLlmProvider("[]");
      const context = { message: "Test" };

      await classifyWithLLM(context, skills, config, provider);

      expect(provider.complete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxTokens: 100,
          temperature: 0.0,
        }),
      );
    });

    it("returns sorted results by confidence", async () => {
      const provider = createMockLlmProvider('["legal", "coding"]');
      const context = { message: "Test" };

      const result = await classifyWithLLM(context, skills, config, provider);

      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence);
      }
    });

    it("handles skills with no domains in the system", async () => {
      const noDomainSkills = [createSkillEntry("skill-a", {}), createSkillEntry("skill-b", {})];
      const provider = createMockLlmProvider("[]");
      const context = { message: "Test" };

      const result = await classifyWithLLM(context, noDomainSkills, config, provider);

      // Should return all skills with baseline confidence
      expect(result).toHaveLength(2);
      result.forEach((r) => {
        expect(r.confidence).toBe(0.1);
      });
    });
  });

  describe("createLlmClassifierProvider", () => {
    it("creates a provider from a function", async () => {
      const completeFn = vi.fn().mockResolvedValue('["coding"]');
      const provider = createLlmClassifierProvider(completeFn);

      const result = await provider.complete("Test prompt", { maxTokens: 100 });

      expect(result).toBe('["coding"]');
      expect(completeFn).toHaveBeenCalledWith("Test prompt", { maxTokens: 100 });
    });
  });
});
