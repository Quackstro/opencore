/**
 * Model Selector Tests
 *
 * @module agents/skills/routing/model-selector.test
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SkillEntry } from "../types.js";
import { selectModelForSkill, selectModelForSkills, getAvailableModels } from "./model-selector.js";

// Mock the logger
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockSkillEntry(name: string, metadata: Record<string, unknown> = {}): SkillEntry {
  return {
    skill: {
      name,
      description: `Test skill: ${name}`,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
    },
    frontmatter: {},
    metadata,
  };
}

describe("model-selector", () => {
  describe("selectModelForSkill", () => {
    it("returns current model when no capability requirements", () => {
      const skill = createMockSkillEntry("basic-skill");
      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-opus-4", "anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-haiku");
      expect(result.optimal).toBe(true);
      expect(result.reason).toContain("no capability requirements");
    });

    it("uses preferred model when available and capable", () => {
      const skill = createMockSkillEntry("vision-skill", {
        capabilities: ["vision"],
        preferredModel: "anthropic/claude-sonnet-4",
      });

      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-sonnet-4");
      expect(result.optimal).toBe(true);
      expect(result.reason).toContain("preferred model");
    });

    it("uses current model if it satisfies requirements", () => {
      const skill = createMockSkillEntry("vision-skill", {
        capabilities: ["vision", "tool-use"],
      });

      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-opus-4");
      expect(result.optimal).toBe(true);
      expect(result.reason).toContain("Current model satisfies");
    });

    it("auto-selects capable model when current lacks capabilities", () => {
      const skill = createMockSkillEntry("thinking-skill", {
        capabilities: ["thinking"],
      });

      // claude-haiku lacks thinking capability in our mock capabilities
      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-opus-4", "anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-opus-4");
      expect(result.optimal).toBe(true);
      expect(result.reason).toContain("Auto-selected");
    });

    it("falls back to current model with warning when no capable model exists", () => {
      const skill = createMockSkillEntry("exotic-skill", {
        capabilities: ["code-execution"],
      });

      // No models in our registry have code-execution
      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-haiku");
      expect(result.optimal).toBe(false);
      expect(result.reason).toContain("WARNING");
      expect(result.missingCapabilities).toContain("code-execution");
    });

    it("includes minThinkingBudget in result", () => {
      const skill = createMockSkillEntry("deep-analysis", {
        capabilities: ["thinking"],
        minThinkingBudget: "high",
      });

      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-opus-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.thinking).toBe("high");
    });

    it("handles empty metadata gracefully", () => {
      const skill = createMockSkillEntry("empty-metadata");
      skill.metadata = undefined;

      const result = selectModelForSkill(
        skill,
        ["anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-haiku");
      expect(result.optimal).toBe(true);
    });
  });

  describe("selectModelForSkills", () => {
    it("returns current model when no skills provided", () => {
      const result = selectModelForSkills(
        [],
        ["anthropic/claude-opus-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-opus-4");
      expect(result.reason).toContain("No skills provided");
    });

    it("delegates to single-skill selection for one skill", () => {
      const skill = createMockSkillEntry("single-skill", {
        capabilities: ["vision"],
      });

      const result = selectModelForSkills(
        [skill],
        ["anthropic/claude-opus-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-opus-4");
      expect(result.optimal).toBe(true);
    });

    it("combines capability requirements from multiple skills", () => {
      const visionSkill = createMockSkillEntry("vision-skill", {
        capabilities: ["vision"],
      });
      const thinkingSkill = createMockSkillEntry("thinking-skill", {
        capabilities: ["thinking"],
      });

      const result = selectModelForSkills(
        [visionSkill, thinkingSkill],
        ["anthropic/claude-opus-4", "anthropic/claude-haiku"],
        "anthropic/claude-haiku",
        undefined,
      );

      // claude-opus-4 has both vision and thinking
      expect(result.model).toBe("anthropic/claude-opus-4");
      expect(result.optimal).toBe(true);
    });

    it("takes maximum thinking level from multiple skills", () => {
      const lowThinking = createMockSkillEntry("low-skill", {
        minThinkingBudget: "low",
      });
      const highThinking = createMockSkillEntry("high-skill", {
        minThinkingBudget: "high",
      });
      const mediumThinking = createMockSkillEntry("medium-skill", {
        minThinkingBudget: "medium",
      });

      const result = selectModelForSkills(
        [lowThinking, highThinking, mediumThinking],
        ["anthropic/claude-opus-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.thinking).toBe("high");
    });

    it("warns when no model satisfies all requirements", () => {
      const visionSkill = createMockSkillEntry("vision-skill", {
        capabilities: ["vision"],
      });
      const executionSkill = createMockSkillEntry("execution-skill", {
        capabilities: ["code-execution"],
      });

      const result = selectModelForSkills(
        [visionSkill, executionSkill],
        ["anthropic/claude-opus-4"],
        "anthropic/claude-opus-4",
        undefined,
      );

      expect(result.optimal).toBe(false);
      expect(result.reason).toContain("WARNING");
    });
  });

  describe("getAvailableModels", () => {
    it("returns built-in models when no config", () => {
      const models = getAvailableModels(undefined);

      expect(models).toContain("anthropic/claude-opus-4");
      expect(models).toContain("anthropic/claude-sonnet-4");
      expect(models).toContain("openai/gpt-4o");
    });

    it("includes models from capabilities config", () => {
      const config = {
        models: {
          capabilities: {
            "custom/my-model": ["vision", "tool-use"],
          },
        },
      };

      const models = getAvailableModels(config as any);

      expect(models).toContain("custom/my-model");
      expect(models).toContain("anthropic/claude-opus-4");
    });

    it("includes models from auth profiles", () => {
      const config = {
        auth: {
          profiles: [
            { id: "profile1", model: "local/llama-3" },
            { id: "profile2", model: "together/mixtral" },
          ],
        },
      };

      const models = getAvailableModels(config as any);

      expect(models).toContain("local/llama-3");
      expect(models).toContain("together/mixtral");
    });

    it("deduplicates models from multiple sources", () => {
      const config = {
        models: {
          capabilities: {
            "anthropic/claude-opus-4": ["vision"],
          },
        },
        auth: {
          profiles: [{ id: "profile1", model: "anthropic/claude-opus-4" }],
        },
      };

      const models = getAvailableModels(config as any);
      const opusCount = models.filter((m) => m === "anthropic/claude-opus-4").length;

      expect(opusCount).toBe(1);
    });
  });
});
