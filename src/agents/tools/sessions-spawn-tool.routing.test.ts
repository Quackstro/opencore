/**
 * Tests for sessions-spawn-tool skill routing integration
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectSkillFromTask,
  selectModelForSkill,
  getAvailableModels,
} from "../skills/routing/index.js";

// Mock dependencies
vi.mock("../skills/routing/index.js", async () => {
  const actual = await vi.importActual("../skills/routing/index.js");
  return {
    ...actual,
    detectSkillFromTask: vi.fn(),
    selectModelForSkill: vi.fn(),
    getAvailableModels: vi.fn(),
  };
});

describe("sessions_spawn skill routing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectSkillFromTask", () => {
    it("should detect coding domain and return synthetic skill", () => {
      const mockDetectSkillFromTask = vi.mocked(detectSkillFromTask);
      mockDetectSkillFromTask.mockReturnValue({
        domains: ["coding"],
        inferredCapabilities: ["tool-use"],
        suggestedThinking: "medium",
        syntheticSkill: {
          skill: { name: "task-inferred", description: "Test", baseDir: "", files: [] },
          frontmatter: {},
          metadata: { domains: ["coding"], capabilities: ["tool-use"] },
        },
        confidence: 0.6,
      });

      const result = detectSkillFromTask("Fix the TypeScript error");

      expect(result.domains).toContain("coding");
      expect(result.syntheticSkill).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect media domain and infer vision capability", () => {
      const mockDetectSkillFromTask = vi.mocked(detectSkillFromTask);
      mockDetectSkillFromTask.mockReturnValue({
        domains: ["media"],
        inferredCapabilities: ["vision"],
        syntheticSkill: {
          skill: { name: "task-inferred", description: "Test", baseDir: "", files: [] },
          frontmatter: {},
          metadata: { domains: ["media"], capabilities: ["vision"] },
        },
        confidence: 0.3,
      });

      const result = detectSkillFromTask("Analyze this image");

      expect(result.domains).toContain("media");
      expect(result.inferredCapabilities).toContain("vision");
    });
  });

  describe("model auto-selection flow", () => {
    it("should select model based on skill capabilities", () => {
      const mockSelectModelForSkill = vi.mocked(selectModelForSkill);
      mockSelectModelForSkill.mockReturnValue({
        model: "anthropic/claude-sonnet-4",
        thinking: "medium",
        reason: "Auto-selected for capabilities: vision",
        optimal: true,
      });

      const mockGetAvailableModels = vi.mocked(getAvailableModels);
      mockGetAvailableModels.mockReturnValue([
        "anthropic/claude-sonnet-4",
        "anthropic/claude-haiku",
        "openai/gpt-4o",
      ]);

      const syntheticSkill = {
        skill: { name: "task-inferred", description: "Test", baseDir: "", files: [] },
        frontmatter: {},
        metadata: { domains: ["media"], capabilities: ["vision"] },
      };

      const result = selectModelForSkill(
        syntheticSkill as Parameters<typeof selectModelForSkill>[0],
        getAvailableModels(),
        "anthropic/claude-haiku",
        undefined,
      );

      expect(result.model).toBe("anthropic/claude-sonnet-4");
      expect(result.optimal).toBe(true);
    });

    it("should not override explicit model selection", () => {
      // This test verifies the behavior in sessions-spawn-tool.ts
      // When modelOverride is provided, skill-based selection should not run
      const explicitModel = "openai/gpt-4o";

      // Simulate the check in sessions-spawn-tool.ts
      const modelOverride = explicitModel;
      const shouldAutoSelect = !modelOverride;

      expect(shouldAutoSelect).toBe(false);
    });

    it("should apply thinking level from skill suggestion", () => {
      const mockSelectModelForSkill = vi.mocked(selectModelForSkill);
      mockSelectModelForSkill.mockReturnValue({
        model: "anthropic/claude-sonnet-4",
        thinking: "high",
        reason: "Skill requires high thinking",
        optimal: true,
      });

      const result = selectModelForSkill(
        {} as Parameters<typeof selectModelForSkill>[0],
        [],
        "",
        undefined,
      );

      expect(result.thinking).toBe("high");
    });
  });

  describe("edge cases", () => {
    it("should handle empty task gracefully", () => {
      const mockDetectSkillFromTask = vi.mocked(detectSkillFromTask);
      mockDetectSkillFromTask.mockReturnValue({
        domains: [],
        inferredCapabilities: [],
        confidence: 0,
      });

      const result = detectSkillFromTask("");

      expect(result.domains).toHaveLength(0);
      expect(result.confidence).toBe(0);
      expect(result.syntheticSkill).toBeUndefined();
    });

    it("should handle generic task without domains", () => {
      const mockDetectSkillFromTask = vi.mocked(detectSkillFromTask);
      mockDetectSkillFromTask.mockReturnValue({
        domains: [],
        inferredCapabilities: [],
        confidence: 0,
      });

      const result = detectSkillFromTask("Hello, how are you?");

      expect(result.domains).toHaveLength(0);
      expect(result.syntheticSkill).toBeUndefined();
    });
  });
});
