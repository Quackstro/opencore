/**
 * Tests for capability filter.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { SkillEntry } from "../types.js";
import {
  filterByCapabilities,
  getCapabilityExclusions,
  checkSkillCapabilities,
} from "./capability-filter.js";
import { clearCapabilitiesCache } from "./model-capabilities.js";

// Helper to create mock skill entries with capabilities
function createSkillEntry(
  name: string,
  capabilities: string[] = [],
  options: { preferredModel?: string; fallbackCapabilities?: string[][] } = {},
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
      capabilities,
      preferredModel: options.preferredModel,
      fallbackCapabilities: options.fallbackCapabilities,
    } as SkillEntry["metadata"],
  };
}

describe("capability-filter", () => {
  beforeEach(() => {
    clearCapabilitiesCache();
  });

  describe("filterByCapabilities", () => {
    it("passes skills with no capability requirements", () => {
      const skills = [createSkillEntry("basic-skill"), createSkillEntry("another-skill")];

      const result = filterByCapabilities(skills, "openai/gpt-4o");

      expect(result.eligible).toHaveLength(2);
      expect(result.excluded).toHaveLength(0);
    });

    it("passes skills when model has required capabilities", () => {
      const skills = [
        createSkillEntry("vision-skill", ["vision"]),
        createSkillEntry("tool-skill", ["tool-use"]),
      ];

      // gpt-4o has vision and tool-use
      const result = filterByCapabilities(skills, "openai/gpt-4o");

      expect(result.eligible).toHaveLength(2);
      expect(result.excluded).toHaveLength(0);
    });

    it("excludes skills when model lacks required capabilities", () => {
      const skills = [
        createSkillEntry("vision-skill", ["vision"]),
        createSkillEntry("thinking-skill", ["thinking"]),
      ];

      // o1 has thinking but not vision
      const result = filterByCapabilities(skills, "openai/o1");

      expect(result.eligible).toHaveLength(1);
      expect(result.eligible[0].skill.name).toBe("thinking-skill");
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].skill).toBe("vision-skill");
      expect(result.excluded[0].missing).toContain("vision");
    });

    it("excludes skills requiring multiple capabilities when any is missing", () => {
      const skills = [createSkillEntry("complex-skill", ["vision", "thinking"])];

      // o1 has thinking but not vision
      const result = filterByCapabilities(skills, "openai/o1");

      expect(result.eligible).toHaveLength(0);
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].missing).toContain("vision");
    });

    it("includes preferredModel hint in exclusion", () => {
      const skills = [
        createSkillEntry("vision-skill", ["vision"], {
          preferredModel: "anthropic/claude-opus-4",
        }),
      ];

      const result = filterByCapabilities(skills, "openai/o1");

      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].hint).toBe("anthropic/claude-opus-4");
    });

    it("handles fallback capabilities (OR logic)", () => {
      const skills = [
        createSkillEntry("flexible-skill", ["vision"], {
          fallbackCapabilities: [["thinking"]],
        }),
      ];

      // o1 lacks vision but has thinking (fallback)
      const result = filterByCapabilities(skills, "openai/o1");

      expect(result.eligible).toHaveLength(1);
      expect(result.excluded).toHaveLength(0);
    });

    it("applies config capability overrides", () => {
      const skills = [createSkillEntry("thinking-skill", ["thinking"])];

      // claude-haiku doesn't have thinking by default
      const result1 = filterByCapabilities(skills, "anthropic/claude-haiku");
      expect(result1.eligible).toHaveLength(0);

      // But we can add it via config
      const config: Parameters<typeof filterByCapabilities>[2] = {
        capabilities: {
          "anthropic/claude-haiku": { add: ["thinking"] },
        },
      };
      const result2 = filterByCapabilities(skills, "anthropic/claude-haiku", config);
      expect(result2.eligible).toHaveLength(1);
    });

    it("handles unknown models gracefully", () => {
      const skills = [
        createSkillEntry("basic-skill"),
        createSkillEntry("vision-skill", ["vision"]),
      ];

      const result = filterByCapabilities(skills, "unknown/model");

      // Basic skill passes (no requirements)
      // Vision skill excluded (unknown model has no capabilities)
      expect(result.eligible).toHaveLength(1);
      expect(result.excluded).toHaveLength(1);
    });
  });

  describe("getCapabilityExclusions", () => {
    it("returns only exclusion info", () => {
      const skills = [
        createSkillEntry("basic-skill"),
        createSkillEntry("vision-skill", ["vision"]),
      ];

      const exclusions = getCapabilityExclusions(skills, "openai/o1");

      expect(exclusions).toHaveLength(1);
      expect(exclusions[0].skill).toBe("vision-skill");
    });
  });

  describe("checkSkillCapabilities", () => {
    it("returns undefined for skills with no issues", () => {
      const skill = createSkillEntry("basic-skill");
      const result = checkSkillCapabilities(skill, "openai/gpt-4o");
      expect(result).toBeUndefined();
    });

    it("returns exclusion info for skills with issues", () => {
      const skill = createSkillEntry("vision-skill", ["vision"]);
      const result = checkSkillCapabilities(skill, "openai/o1");

      expect(result).toBeDefined();
      expect(result!.skill).toBe("vision-skill");
      expect(result!.missing).toContain("vision");
    });
  });
});
