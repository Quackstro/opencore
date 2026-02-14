/**
 * Tests for skill chaining functionality.
 */

import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../types.js";
import {
  extractDependencies,
  buildDependencyMap,
  resolveDependencyChain,
  detectCircularDependencies,
  getDependents,
  validateDependencies,
  getExecutionPlan,
  mergeDependencies,
  type SkillDependency,
} from "./skill-chaining.js";

// Helper to create mock skill entries
function createSkillEntry(
  name: string,
  dependencies?: {
    requires?: string[];
    optional?: string[];
    sequence?: "before" | "after" | "parallel";
  },
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
    metadata: dependencies ? { dependencies } : undefined,
  };
}

describe("skill-chaining", () => {
  describe("extractDependencies", () => {
    it("extracts dependencies from skill metadata", () => {
      const skill = createSkillEntry("my-skill", {
        requires: ["github", "docker"],
        optional: ["kubernetes"],
        sequence: "before",
      });

      const deps = extractDependencies(skill);

      expect(deps).not.toBeNull();
      expect(deps!.skillName).toBe("my-skill");
      expect(deps!.requires).toEqual(["github", "docker"]);
      expect(deps!.optional).toEqual(["kubernetes"]);
      expect(deps!.sequence).toBe("before");
    });

    it("returns null for skill without dependencies", () => {
      const skill = createSkillEntry("simple-skill");
      const deps = extractDependencies(skill);
      expect(deps).toBeNull();
    });

    it("returns null for empty requires array", () => {
      const skill = createSkillEntry("skill", { requires: [] });
      const deps = extractDependencies(skill);
      expect(deps).toBeNull();
    });

    it("filters non-string requires", () => {
      const skill = createSkillEntry("skill", { requires: ["placeholder"] });
      (skill.metadata as any).dependencies = {
        requires: ["valid", 123, null, "another-valid"],
      };

      const deps = extractDependencies(skill);
      expect(deps!.requires).toEqual(["valid", "another-valid"]);
    });
  });

  describe("buildDependencyMap", () => {
    it("builds map from skill entries", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c"),
      ];

      const map = buildDependencyMap(skills);

      expect(map.size).toBe(2);
      expect(map.get("a")?.requires).toEqual(["b"]);
      expect(map.get("b")?.requires).toEqual(["c"]);
    });
  });

  describe("resolveDependencyChain", () => {
    it("resolves simple linear chain", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c"),
      ];

      const result = resolveDependencyChain("a", skills);

      expect(result.chain).toEqual(["c", "b", "a"]);
      expect(result.missingRequired).toHaveLength(0);
    });

    it("handles diamond dependencies", () => {
      // a -> b, c
      // b -> d
      // c -> d
      const skills = [
        createSkillEntry("a", { requires: ["b", "c"] }),
        createSkillEntry("b", { requires: ["d"] }),
        createSkillEntry("c", { requires: ["d"] }),
        createSkillEntry("d"),
      ];

      const result = resolveDependencyChain("a", skills);

      // d should only appear once
      const dCount = result.chain.filter((s) => s === "d").length;
      expect(dCount).toBe(1);

      // d should come before b and c
      expect(result.chain.indexOf("d")).toBeLessThan(result.chain.indexOf("b"));
      expect(result.chain.indexOf("d")).toBeLessThan(result.chain.indexOf("c"));
    });

    it("reports missing required dependencies", () => {
      const skills = [createSkillEntry("a", { requires: ["missing"] })];

      const result = resolveDependencyChain("a", skills);

      expect(result.missingRequired).toContain("missing");
    });

    it("reports missing optional dependencies", () => {
      const skills = [
        createSkillEntry("a", {
          requires: [],
          optional: ["missing-optional"],
        }),
      ];

      // Need to add a valid requires for extractDependencies to work
      const skill = skills[0];
      (skill.metadata as any).dependencies.requires = ["dummy"];

      // Add dummy skill
      skills.push(createSkillEntry("dummy"));

      const result = resolveDependencyChain("a", skills);

      expect(result.missingOptional).toContain("missing-optional");
    });

    it("respects maxDepth", () => {
      // Create a long chain
      const skills = [];
      for (let i = 0; i < 10; i++) {
        skills.push(
          createSkillEntry(`skill-${i}`, {
            requires: i < 9 ? [`skill-${i + 1}`] : undefined,
          }),
        );
      }

      const result = resolveDependencyChain("skill-0", skills, 3);

      // Should stop at maxDepth
      expect(result.chain.length).toBeLessThanOrEqual(4);
    });

    it("handles after sequence", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"], sequence: "after" }),
        createSkillEntry("b"),
      ];

      const result = resolveDependencyChain("a", skills);

      // a should come before b when sequence is "after"
      expect(result.chain.indexOf("a")).toBeLessThan(result.chain.indexOf("b"));
    });
  });

  describe("detectCircularDependencies", () => {
    it("detects simple cycle", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["a"] }),
      ];

      const result = detectCircularDependencies(skills);

      expect(result.hasCircular).toBe(true);
      expect(result.cycles.length).toBeGreaterThan(0);
    });

    it("detects longer cycle", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c", { requires: ["a"] }),
      ];

      const result = detectCircularDependencies(skills);

      expect(result.hasCircular).toBe(true);
    });

    it("returns no cycles for acyclic graph", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c"),
      ];

      const result = detectCircularDependencies(skills);

      expect(result.hasCircular).toBe(false);
      expect(result.cycles).toHaveLength(0);
    });

    it("handles skills without dependencies", () => {
      const skills = [createSkillEntry("a"), createSkillEntry("b")];

      const result = detectCircularDependencies(skills);

      expect(result.hasCircular).toBe(false);
    });
  });

  describe("getDependents", () => {
    it("finds skills that depend on a skill", () => {
      const skills = [
        createSkillEntry("a", { requires: ["c"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c"),
      ];

      const dependents = getDependents("c", skills);

      expect(dependents).toContain("a");
      expect(dependents).toContain("b");
    });

    it("includes optional dependents", () => {
      const skills = [
        createSkillEntry("a", { requires: ["x"], optional: ["c"] }),
        createSkillEntry("x"),
        createSkillEntry("c"),
      ];

      const dependents = getDependents("c", skills);

      expect(dependents).toContain("a");
    });

    it("returns empty for skill with no dependents", () => {
      const skills = [createSkillEntry("a", { requires: ["b"] }), createSkillEntry("b")];

      const dependents = getDependents("a", skills);

      expect(dependents).toHaveLength(0);
    });
  });

  describe("validateDependencies", () => {
    it("returns no warnings for valid dependencies", () => {
      const skills = [createSkillEntry("a", { requires: ["b"] }), createSkillEntry("b")];

      const warnings = validateDependencies(skills);

      expect(warnings).toHaveLength(0);
    });

    it("warns about missing required dependencies", () => {
      const skills = [createSkillEntry("a", { requires: ["missing"] })];

      const warnings = validateDependencies(skills);

      expect(warnings.some((w) => w.includes("missing") && w.includes("not found"))).toBe(true);
    });

    it("warns about missing optional dependencies", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"], optional: ["missing"] }),
        createSkillEntry("b"),
      ];

      const warnings = validateDependencies(skills);

      expect(warnings.some((w) => w.includes("missing") && w.includes("optional"))).toBe(true);
    });

    it("warns about self-dependency", () => {
      const skills = [createSkillEntry("a", { requires: ["a"] })];

      const warnings = validateDependencies(skills);

      expect(warnings.some((w) => w.includes("itself"))).toBe(true);
    });

    it("warns about circular dependencies", () => {
      const skills = [
        createSkillEntry("a", { requires: ["b"] }),
        createSkillEntry("b", { requires: ["a"] }),
      ];

      const warnings = validateDependencies(skills);

      expect(warnings.some((w) => w.includes("Circular"))).toBe(true);
    });
  });

  describe("getExecutionPlan", () => {
    it("creates execution plan for multiple skills", () => {
      const skills = [
        createSkillEntry("a", { requires: ["c"] }),
        createSkillEntry("b", { requires: ["c"] }),
        createSkillEntry("c"),
      ];

      const plan = getExecutionPlan(["a", "b"], skills);

      // c should come first (common dependency)
      expect(plan[0]).toBe("c");
      expect(plan).toContain("a");
      expect(plan).toContain("b");
    });

    it("deduplicates shared dependencies", () => {
      const skills = [
        createSkillEntry("a", { requires: ["shared"] }),
        createSkillEntry("b", { requires: ["shared"] }),
        createSkillEntry("shared"),
      ];

      const plan = getExecutionPlan(["a", "b"], skills);

      const sharedCount = plan.filter((s) => s === "shared").length;
      expect(sharedCount).toBe(1);
    });

    it("handles skills without dependencies", () => {
      const skills = [createSkillEntry("a"), createSkillEntry("b")];

      const plan = getExecutionPlan(["a", "b"], skills);

      expect(plan).toContain("a");
      expect(plan).toContain("b");
    });
  });

  describe("mergeDependencies", () => {
    it("merges dependencies", () => {
      const base: SkillDependency = {
        skillName: "skill",
        requires: ["a", "b"],
        optional: ["x"],
        sequence: "before",
      };

      const override: Partial<SkillDependency> = {
        requires: ["c"],
        optional: ["y"],
        sequence: "after",
      };

      const result = mergeDependencies(base, override);

      expect(result.requires).toContain("a");
      expect(result.requires).toContain("b");
      expect(result.requires).toContain("c");
      expect(result.optional).toContain("x");
      expect(result.optional).toContain("y");
      expect(result.sequence).toBe("after");
    });

    it("deduplicates arrays", () => {
      const base: SkillDependency = {
        skillName: "skill",
        requires: ["a", "b"],
      };

      const override: Partial<SkillDependency> = {
        requires: ["b", "c"],
      };

      const result = mergeDependencies(base, override);

      const bCount = result.requires.filter((r) => r === "b").length;
      expect(bCount).toBe(1);
    });
  });
});
