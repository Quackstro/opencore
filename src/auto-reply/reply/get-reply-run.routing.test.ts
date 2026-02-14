/**
 * Tests for get-reply-run thinking resolver integration
 */

import { describe, it, expect, vi } from "vitest";
import type { SkillEntry } from "../../agents/skills/types.js";
import { resolveThinkingWithSkills } from "../../agents/skills/routing/thinking-resolver.js";

describe("get-reply-run thinking resolver integration", () => {
  describe("resolveThinkingWithSkills", () => {
    it("should upgrade thinking level with minimum mode skill", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "deep-analyzer", description: "Deep analysis", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "high",
            thinkingOverrideMode: "minimum",
          },
        },
      ];

      const result = resolveThinkingWithSkills("low", skills);

      expect(result.level).toBe("high");
      expect(result.changed).toBe(true);
      expect(result.skillName).toBe("deep-analyzer");
    });

    it("should not downgrade with minimum mode when current is higher", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "quick-lookup", description: "Quick lookup", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "low",
            thinkingOverrideMode: "minimum",
          },
        },
      ];

      const result = resolveThinkingWithSkills("high", skills);

      expect(result.level).toBe("high");
      expect(result.changed).toBe(false);
    });

    it("should cap thinking level with maximum mode skill", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "fast-search", description: "Fast search", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "low",
            thinkingOverrideMode: "maximum",
          },
        },
      ];

      const result = resolveThinkingWithSkills("high", skills);

      expect(result.level).toBe("low");
      expect(result.changed).toBe(true);
      expect(result.skillName).toBe("fast-search");
    });

    it("should force level with exact mode skill", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "precision-task", description: "Precision", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "medium",
            thinkingOverrideMode: "exact",
          },
        },
      ];

      const result = resolveThinkingWithSkills("high", skills);

      expect(result.level).toBe("medium");
      expect(result.changed).toBe(true);
    });

    it("should generate hint with suggest mode (default)", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "suggested-skill", description: "Suggested", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "high",
            // No mode = suggest (default)
          },
        },
      ];

      const result = resolveThinkingWithSkills("low", skills);

      expect(result.level).toBe("low"); // Unchanged
      expect(result.changed).toBe(false);
      expect(result.hint).toContain("high");
    });

    it("should not change level when no skills have thinking override", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "basic-skill", description: "Basic", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {},
        },
      ];

      const result = resolveThinkingWithSkills("medium", skills);

      expect(result.level).toBe("medium");
      expect(result.changed).toBe(false);
    });

    it("should handle empty skill array", () => {
      const result = resolveThinkingWithSkills("low", []);

      expect(result.level).toBe("low");
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("no skills provided");
    });

    it("should prioritize exact mode over other modes", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "minimum-skill", description: "Min", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "high",
            thinkingOverrideMode: "minimum",
          },
        },
        {
          skill: { name: "exact-skill", description: "Exact", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "medium",
            thinkingOverrideMode: "exact",
          },
        },
      ];

      const result = resolveThinkingWithSkills("low", skills);

      // Exact mode should win
      expect(result.level).toBe("medium");
      expect(result.skillName).toBe("exact-skill");
    });

    it("should combine multiple minimum constraints", () => {
      const skills: SkillEntry[] = [
        {
          skill: { name: "skill-a", description: "A", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "low",
            thinkingOverrideMode: "minimum",
          },
        },
        {
          skill: { name: "skill-b", description: "B", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "high",
            thinkingOverrideMode: "minimum",
          },
        },
      ];

      const result = resolveThinkingWithSkills("off", skills);

      // Should use the highest minimum
      expect(result.level).toBe("high");
      expect(result.changed).toBe(true);
    });
  });

  describe("integration scenario", () => {
    it("should simulate real get-reply-run flow with skill entries", () => {
      // Simulate skillsSnapshot.entries being available
      const skillsSnapshot = {
        prompt: "Skills prompt...",
        skills: [{ name: "deep-code-review", primaryEnv: "GITHUB_TOKEN" }],
        entries: [
          {
            skill: {
              name: "deep-code-review",
              description: "Deep code review",
              baseDir: "",
              files: [],
            },
            frontmatter: {},
            metadata: {
              domains: ["coding"],
              thinkingOverride: "high",
              thinkingOverrideMode: "minimum",
            },
          },
        ] as SkillEntry[],
      };

      const currentThinkLevel = "low";
      const hasThinkDirective = false;

      // Simulate the check in get-reply-run.ts
      const skillEntries = skillsSnapshot.entries;
      if (
        currentThinkLevel &&
        Array.isArray(skillEntries) &&
        skillEntries.length > 0 &&
        !hasThinkDirective
      ) {
        const thinkingResolution = resolveThinkingWithSkills(
          currentThinkLevel as Parameters<typeof resolveThinkingWithSkills>[0],
          skillEntries,
        );

        expect(thinkingResolution.changed).toBe(true);
        expect(thinkingResolution.level).toBe("high");
        expect(thinkingResolution.skillName).toBe("deep-code-review");
      }
    });

    it("should not override when user has explicit think directive", () => {
      const skillEntries: SkillEntry[] = [
        {
          skill: { name: "skill", description: "Test", baseDir: "", files: [] },
          frontmatter: {},
          metadata: {
            thinkingOverride: "high",
            thinkingOverrideMode: "exact",
          },
        },
      ];

      const currentThinkLevel = "low";
      const hasThinkDirective = true; // User said /think:low

      // Simulate the check - should skip when directive is present
      const shouldApplySkillThinking = !hasThinkDirective;

      expect(shouldApplySkillThinking).toBe(false);
    });
  });
});
