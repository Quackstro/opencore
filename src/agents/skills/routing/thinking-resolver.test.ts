/**
 * Tests for thinking level resolver.
 */

import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../types.js";
import type { ThinkingLevel, ThinkingOverrideMode } from "./types.js";
import {
  THINKING_ORDER,
  isValidThinkingLevel,
  isValidThinkingOverrideMode,
  compareLevels,
  maxLevel,
  minLevel,
  resolveThinkingWithSkill,
  resolveThinkingWithSkills,
} from "./thinking-resolver.js";

// Helper to create mock skill entries with thinking overrides
function createSkillEntry(
  name: string,
  thinkingOverride?: ThinkingLevel,
  thinkingOverrideMode?: ThinkingOverrideMode,
): SkillEntry {
  return {
    skill: {
      name,
      description: `${name} skill`,
      baseDir: `/skills/${name}`,
      filePath: `/skills/${name}/SKILL.md`,
      content: "",
      source: "test",
    },
    frontmatter: {},
    metadata: {
      thinkingOverride,
      thinkingOverrideMode,
    } as SkillEntry["metadata"],
  };
}

describe("thinking-resolver", () => {
  describe("THINKING_ORDER", () => {
    it("has levels in correct order", () => {
      expect(THINKING_ORDER).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    });
  });

  describe("isValidThinkingLevel", () => {
    it("returns true for valid levels", () => {
      expect(isValidThinkingLevel("off")).toBe(true);
      expect(isValidThinkingLevel("minimal")).toBe(true);
      expect(isValidThinkingLevel("low")).toBe(true);
      expect(isValidThinkingLevel("medium")).toBe(true);
      expect(isValidThinkingLevel("high")).toBe(true);
      expect(isValidThinkingLevel("xhigh")).toBe(true);
    });

    it("returns false for invalid levels", () => {
      expect(isValidThinkingLevel("invalid")).toBe(false);
      expect(isValidThinkingLevel("")).toBe(false);
      expect(isValidThinkingLevel(null)).toBe(false);
      expect(isValidThinkingLevel(undefined)).toBe(false);
      expect(isValidThinkingLevel(123)).toBe(false);
    });
  });

  describe("isValidThinkingOverrideMode", () => {
    it("returns true for valid modes", () => {
      expect(isValidThinkingOverrideMode("minimum")).toBe(true);
      expect(isValidThinkingOverrideMode("maximum")).toBe(true);
      expect(isValidThinkingOverrideMode("exact")).toBe(true);
      expect(isValidThinkingOverrideMode("suggest")).toBe(true);
    });

    it("returns false for invalid modes", () => {
      expect(isValidThinkingOverrideMode("invalid")).toBe(false);
      expect(isValidThinkingOverrideMode("")).toBe(false);
      expect(isValidThinkingOverrideMode(null)).toBe(false);
    });
  });

  describe("compareLevels", () => {
    it("returns negative when a < b", () => {
      expect(compareLevels("off", "high")).toBeLessThan(0);
      expect(compareLevels("low", "medium")).toBeLessThan(0);
    });

    it("returns positive when a > b", () => {
      expect(compareLevels("high", "off")).toBeGreaterThan(0);
      expect(compareLevels("medium", "low")).toBeGreaterThan(0);
    });

    it("returns zero when a === b", () => {
      expect(compareLevels("medium", "medium")).toBe(0);
      expect(compareLevels("off", "off")).toBe(0);
    });
  });

  describe("maxLevel", () => {
    it("returns the higher level", () => {
      expect(maxLevel("low", "high")).toBe("high");
      expect(maxLevel("high", "low")).toBe("high");
      expect(maxLevel("medium", "medium")).toBe("medium");
    });
  });

  describe("minLevel", () => {
    it("returns the lower level", () => {
      expect(minLevel("low", "high")).toBe("low");
      expect(minLevel("high", "low")).toBe("low");
      expect(minLevel("medium", "medium")).toBe("medium");
    });
  });

  describe("resolveThinkingWithSkill", () => {
    describe("no skill or no override", () => {
      it("returns current level when no skill provided", () => {
        const result = resolveThinkingWithSkill("medium", undefined);
        expect(result.level).toBe("medium");
        expect(result.changed).toBe(false);
        expect(result.reason).toBe("no skill provided");
      });

      it("returns current level when skill has no override", () => {
        const skill = createSkillEntry("basic-skill");
        const result = resolveThinkingWithSkill("medium", skill);
        expect(result.level).toBe("medium");
        expect(result.changed).toBe(false);
        expect(result.reason).toBe("no skill override");
      });
    });

    describe("minimum mode", () => {
      it("upgrades when current < override", () => {
        const skill = createSkillEntry("arch-skill", "high", "minimum");
        const result = resolveThinkingWithSkill("low", skill);

        expect(result.level).toBe("high");
        expect(result.changed).toBe(true);
        expect(result.reason).toContain("upgraded");
        expect(result.skillName).toBe("arch-skill");
      });

      it("keeps current when current >= override", () => {
        const skill = createSkillEntry("arch-skill", "medium", "minimum");
        const result = resolveThinkingWithSkill("high", skill);

        expect(result.level).toBe("high");
        expect(result.changed).toBe(false);
        expect(result.reason).toContain("meets minimum");
      });

      it("keeps current when current == override", () => {
        const skill = createSkillEntry("arch-skill", "medium", "minimum");
        const result = resolveThinkingWithSkill("medium", skill);

        expect(result.level).toBe("medium");
        expect(result.changed).toBe(false);
      });
    });

    describe("maximum mode", () => {
      it("caps when current > override", () => {
        const skill = createSkillEntry("quick-skill", "low", "maximum");
        const result = resolveThinkingWithSkill("high", skill);

        expect(result.level).toBe("low");
        expect(result.changed).toBe(true);
        expect(result.reason).toContain("capped");
        expect(result.skillName).toBe("quick-skill");
      });

      it("keeps current when current <= override", () => {
        const skill = createSkillEntry("quick-skill", "high", "maximum");
        const result = resolveThinkingWithSkill("medium", skill);

        expect(result.level).toBe("medium");
        expect(result.changed).toBe(false);
        expect(result.reason).toContain("within maximum");
      });

      it("keeps current when current == override", () => {
        const skill = createSkillEntry("quick-skill", "medium", "maximum");
        const result = resolveThinkingWithSkill("medium", skill);

        expect(result.level).toBe("medium");
        expect(result.changed).toBe(false);
      });
    });

    describe("exact mode", () => {
      it("always uses override level", () => {
        const skill = createSkillEntry("exact-skill", "high", "exact");

        // From lower
        const result1 = resolveThinkingWithSkill("low", skill);
        expect(result1.level).toBe("high");
        expect(result1.changed).toBe(true);
        expect(result1.reason).toContain("requires");

        // From higher
        const result2 = resolveThinkingWithSkill("xhigh", skill);
        expect(result2.level).toBe("high");
        expect(result2.changed).toBe(true);

        // From same
        const result3 = resolveThinkingWithSkill("high", skill);
        expect(result3.level).toBe("high");
        expect(result3.changed).toBe(false);
      });
    });

    describe("suggest mode (default)", () => {
      it("returns current level with hint", () => {
        const skill = createSkillEntry("suggest-skill", "medium", "suggest");
        const result = resolveThinkingWithSkill("off", skill);

        expect(result.level).toBe("off");
        expect(result.changed).toBe(false);
        expect(result.hint).toBeDefined();
        expect(result.hint).toContain("suggests");
        expect(result.hint).toContain("medium");
      });

      it("defaults to suggest when mode is undefined", () => {
        const skill = createSkillEntry("default-skill", "high", undefined);
        const result = resolveThinkingWithSkill("low", skill);

        expect(result.level).toBe("low");
        expect(result.changed).toBe(false);
        expect(result.hint).toBeDefined();
      });
    });

    describe("design doc example scenarios", () => {
      it("low -> high with minimum = high (upgraded)", () => {
        const skill = createSkillEntry("test", "high", "minimum");
        const result = resolveThinkingWithSkill("low", skill);
        expect(result.level).toBe("high");
        expect(result.changed).toBe(true);
      });

      it("high -> medium with minimum = high (kept higher)", () => {
        const skill = createSkillEntry("test", "medium", "minimum");
        const result = resolveThinkingWithSkill("high", skill);
        expect(result.level).toBe("high");
        expect(result.changed).toBe(false);
      });

      it("high -> low with maximum = low (capped)", () => {
        const skill = createSkillEntry("test", "low", "maximum");
        const result = resolveThinkingWithSkill("high", skill);
        expect(result.level).toBe("low");
        expect(result.changed).toBe(true);
      });

      it("medium -> high with exact = high (forced)", () => {
        const skill = createSkillEntry("test", "high", "exact");
        const result = resolveThinkingWithSkill("medium", skill);
        expect(result.level).toBe("high");
        expect(result.changed).toBe(true);
      });

      it("off -> medium with suggest = off (hint only)", () => {
        const skill = createSkillEntry("test", "medium", "suggest");
        const result = resolveThinkingWithSkill("off", skill);
        expect(result.level).toBe("off");
        expect(result.changed).toBe(false);
        expect(result.hint).toBeDefined();
      });
    });
  });

  describe("resolveThinkingWithSkills", () => {
    it("returns current level when no skills provided", () => {
      const result = resolveThinkingWithSkills("medium", []);
      expect(result.level).toBe("medium");
      expect(result.changed).toBe(false);
    });

    it("exact mode takes highest priority", () => {
      const skills = [
        createSkillEntry("min-skill", "high", "minimum"),
        createSkillEntry("exact-skill", "low", "exact"),
        createSkillEntry("max-skill", "medium", "maximum"),
      ];
      const result = resolveThinkingWithSkills("medium", skills);

      expect(result.level).toBe("low");
      expect(result.reason).toContain("exact");
      expect(result.skillName).toBe("exact-skill");
    });

    it("combines minimum constraints (highest wins)", () => {
      const skills = [
        createSkillEntry("min-low", "low", "minimum"),
        createSkillEntry("min-high", "high", "minimum"),
        createSkillEntry("min-medium", "medium", "minimum"),
      ];
      const result = resolveThinkingWithSkills("off", skills);

      expect(result.level).toBe("high");
      expect(result.changed).toBe(true);
    });

    it("combines maximum constraints (lowest wins)", () => {
      const skills = [
        createSkillEntry("max-high", "high", "maximum"),
        createSkillEntry("max-low", "low", "maximum"),
        createSkillEntry("max-medium", "medium", "maximum"),
      ];
      const result = resolveThinkingWithSkills("xhigh", skills);

      expect(result.level).toBe("low");
      expect(result.changed).toBe(true);
    });

    it("applies both minimum and maximum constraints", () => {
      const skills = [
        createSkillEntry("min-skill", "medium", "minimum"),
        createSkillEntry("max-skill", "high", "maximum"),
      ];

      // Current too low -> upgrade to minimum
      const result1 = resolveThinkingWithSkills("low", skills);
      expect(result1.level).toBe("medium");

      // Current too high -> cap to maximum
      const result2 = resolveThinkingWithSkills("xhigh", skills);
      expect(result2.level).toBe("high");

      // Current in range -> no change
      const result3 = resolveThinkingWithSkills("medium", skills);
      expect(result3.level).toBe("medium");
      expect(result3.changed).toBe(false);
    });

    it("handles conflicting constraints (minimum > maximum)", () => {
      const skills = [
        createSkillEntry("min-skill", "high", "minimum"),
        createSkillEntry("max-skill", "low", "maximum"),
      ];
      const result = resolveThinkingWithSkills("medium", skills);

      // Minimum takes precedence in conflicts
      expect(result.level).toBe("high");
      expect(result.hint).toContain("lower than minimum");
    });

    it("collects suggest hints", () => {
      const skills = [
        createSkillEntry("suggest1", "high", "suggest"),
        createSkillEntry("suggest2", "medium", "suggest"),
      ];
      const result = resolveThinkingWithSkills("low", skills);

      expect(result.level).toBe("low");
      expect(result.changed).toBe(false);
      expect(result.hint).toContain("suggest1");
      expect(result.hint).toContain("suggest2");
    });

    it("ignores skills without thinking overrides", () => {
      const skills = [
        createSkillEntry("no-override"),
        createSkillEntry("with-override", "high", "minimum"),
      ];
      const result = resolveThinkingWithSkills("low", skills);

      expect(result.level).toBe("high");
      expect(result.skillName).toBe("with-override");
    });
  });
});
