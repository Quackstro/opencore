/**
 * Tests for skill groups functionality.
 */

import { describe, expect, it } from "vitest";
import {
  expandSkillGroups,
  detectGroupsFromDomains,
  getSkillsFromDomains,
  findGroupsContainingSkill,
  mergeGroupConfigs,
  validateSkillGroup,
  validateSkillGroupConfig,
  SKILL_GROUP_PRESETS,
  type SkillGroup,
  type SkillGroupConfig,
} from "./skill-groups.js";

describe("skill-groups", () => {
  const testGroups: SkillGroup[] = [
    {
      id: "full-stack",
      name: "Full-Stack Development",
      skills: ["claude-code", "github", "docker"],
      domains: ["coding", "devops"],
      activationThreshold: 0.5,
    },
    {
      id: "legal-suite",
      name: "Legal Suite",
      skills: ["paralegal", "contract-review", "compliance"],
      domains: ["legal"],
      activationThreshold: 0.6,
    },
    {
      id: "no-expand",
      name: "No Auto Expand",
      skills: ["skill-a", "skill-b"],
      domains: ["misc"],
      expandOnSelect: false,
    },
  ];

  const enabledConfig: SkillGroupConfig = {
    groups: testGroups,
    enabled: true,
    autoExpand: true,
    activateByDomain: true,
  };

  const disabledConfig: SkillGroupConfig = {
    groups: testGroups,
    enabled: false,
  };

  describe("expandSkillGroups", () => {
    it("expands skills when group member is selected", () => {
      const result = expandSkillGroups(["claude-code"], testGroups, enabledConfig);

      expect(result.skills).toContain("claude-code");
      expect(result.skills).toContain("github");
      expect(result.skills).toContain("docker");
      expect(result.expandedGroups).toContain("full-stack");
      expect(result.addedSkills).toContain("github");
      expect(result.addedSkills).toContain("docker");
    });

    it("does not expand when config is disabled", () => {
      const result = expandSkillGroups(["claude-code"], testGroups, disabledConfig);

      expect(result.skills).toEqual(["claude-code"]);
      expect(result.expandedGroups).toHaveLength(0);
      expect(result.addedSkills).toHaveLength(0);
    });

    it("does not expand when autoExpand is false", () => {
      const config: SkillGroupConfig = { ...enabledConfig, autoExpand: false };
      const result = expandSkillGroups(["claude-code"], testGroups, config);

      expect(result.skills).toEqual(["claude-code"]);
    });

    it("respects expandOnSelect: false on individual groups", () => {
      const result = expandSkillGroups(["skill-a"], testGroups, enabledConfig);

      expect(result.skills).toEqual(["skill-a"]);
      expect(result.expandedGroups).not.toContain("no-expand");
    });

    it("handles multiple groups being triggered", () => {
      const result = expandSkillGroups(["claude-code", "paralegal"], testGroups, enabledConfig);

      expect(result.skills).toContain("claude-code");
      expect(result.skills).toContain("github");
      expect(result.skills).toContain("paralegal");
      expect(result.skills).toContain("contract-review");
      expect(result.expandedGroups).toContain("full-stack");
      expect(result.expandedGroups).toContain("legal-suite");
    });

    it("does not duplicate skills", () => {
      const result = expandSkillGroups(["claude-code", "github"], testGroups, enabledConfig);

      const githubCount = result.skills.filter((s) => s === "github").length;
      expect(githubCount).toBe(1);
    });

    it("handles empty groups array", () => {
      const config: SkillGroupConfig = { ...enabledConfig, groups: [] };
      const result = expandSkillGroups(["claude-code"], [], config);

      expect(result.skills).toEqual(["claude-code"]);
    });
  });

  describe("detectGroupsFromDomains", () => {
    it("detects groups matching domains", () => {
      const result = detectGroupsFromDomains(["coding"], testGroups);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("full-stack");
    });

    it("detects multiple groups", () => {
      const result = detectGroupsFromDomains(["coding", "legal"], testGroups);

      expect(result).toHaveLength(2);
      expect(result.map((g) => g.id)).toContain("full-stack");
      expect(result.map((g) => g.id)).toContain("legal-suite");
    });

    it("respects activation threshold", () => {
      // legal-suite requires 0.6 threshold - needs at least 1 of 1 domains
      const result = detectGroupsFromDomains(["legal"], testGroups);
      expect(result.map((g) => g.id)).toContain("legal-suite");
    });

    it("returns empty for non-matching domains", () => {
      const result = detectGroupsFromDomains(["unknown"], testGroups);
      expect(result).toHaveLength(0);
    });

    it("handles empty domains", () => {
      const result = detectGroupsFromDomains([], testGroups);
      expect(result).toHaveLength(0);
    });

    it("handles empty groups", () => {
      const result = detectGroupsFromDomains(["coding"], []);
      expect(result).toHaveLength(0);
    });
  });

  describe("getSkillsFromDomains", () => {
    it("returns skills from domain-matched groups", () => {
      const result = getSkillsFromDomains(["coding"], testGroups, enabledConfig);

      expect(result).toContain("claude-code");
      expect(result).toContain("github");
      expect(result).toContain("docker");
    });

    it("returns empty when disabled", () => {
      const result = getSkillsFromDomains(["coding"], testGroups, disabledConfig);
      expect(result).toHaveLength(0);
    });

    it("returns empty when activateByDomain is false", () => {
      const config: SkillGroupConfig = { ...enabledConfig, activateByDomain: false };
      const result = getSkillsFromDomains(["coding"], testGroups, config);
      expect(result).toHaveLength(0);
    });
  });

  describe("findGroupsContainingSkill", () => {
    it("finds groups containing a skill", () => {
      const result = findGroupsContainingSkill("github", testGroups);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("full-stack");
    });

    it("handles case-insensitive matching", () => {
      const result = findGroupsContainingSkill("GITHUB", testGroups);
      expect(result).toHaveLength(1);
    });

    it("returns empty for unknown skill", () => {
      const result = findGroupsContainingSkill("unknown-skill", testGroups);
      expect(result).toHaveLength(0);
    });
  });

  describe("mergeGroupConfigs", () => {
    it("merges multiple configs", () => {
      const config1: Partial<SkillGroupConfig> = {
        enabled: true,
        groups: [testGroups[0]],
      };
      const config2: Partial<SkillGroupConfig> = {
        autoExpand: false,
        groups: [testGroups[1]],
      };

      const result = mergeGroupConfigs(config1, config2);

      expect(result.enabled).toBe(true);
      expect(result.autoExpand).toBe(false);
      expect(result.groups).toHaveLength(2);
    });

    it("later configs override earlier ones", () => {
      const config1: Partial<SkillGroupConfig> = { enabled: true };
      const config2: Partial<SkillGroupConfig> = { enabled: false };

      const result = mergeGroupConfigs(config1, config2);
      expect(result.enabled).toBe(false);
    });
  });

  describe("validateSkillGroup", () => {
    it("validates valid group", () => {
      const errors = validateSkillGroup(testGroups[0]);
      expect(errors).toHaveLength(0);
    });

    it("detects missing id", () => {
      const errors = validateSkillGroup({ id: "", name: "Test", skills: ["a"] });
      expect(errors.some((e) => e.includes("id"))).toBe(true);
    });

    it("detects missing name", () => {
      const errors = validateSkillGroup({ id: "test", name: "", skills: ["a"] });
      expect(errors.some((e) => e.includes("name"))).toBe(true);
    });

    it("detects empty skills array", () => {
      const errors = validateSkillGroup({ id: "test", name: "Test", skills: [] });
      expect(errors.some((e) => e.includes("skill"))).toBe(true);
    });

    it("detects invalid activationThreshold", () => {
      const errors = validateSkillGroup({
        id: "test",
        name: "Test",
        skills: ["a"],
        activationThreshold: 1.5,
      });
      expect(errors.some((e) => e.includes("activationThreshold"))).toBe(true);
    });
  });

  describe("validateSkillGroupConfig", () => {
    it("validates valid config", () => {
      const errors = validateSkillGroupConfig(enabledConfig);
      expect(errors).toHaveLength(0);
    });

    it("detects duplicate group IDs", () => {
      const config: SkillGroupConfig = {
        enabled: true,
        groups: [
          { id: "same", name: "First", skills: ["a"] },
          { id: "same", name: "Second", skills: ["b"] },
        ],
      };
      const errors = validateSkillGroupConfig(config);
      expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
    });
  });

  describe("SKILL_GROUP_PRESETS", () => {
    it("has valid presets", () => {
      expect(SKILL_GROUP_PRESETS["full-stack"]).toBeDefined();
      expect(SKILL_GROUP_PRESETS["legal-suite"]).toBeDefined();

      for (const preset of Object.values(SKILL_GROUP_PRESETS)) {
        const errors = validateSkillGroup(preset);
        expect(errors).toHaveLength(0);
      }
    });
  });
});
