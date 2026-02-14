/**
 * Tests for skill router.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { SkillEntry } from "../types.js";
import type { SkillRoutingConfig } from "./types.js";
import { clearCapabilitiesCache } from "./model-capabilities.js";
import { routeSkills, routeSkillsSync, clearRoutingCache } from "./router.js";

// Helper to create mock skill entries
function createSkillEntry(
  name: string,
  options: {
    domains?: string[];
    capabilities?: string[];
    alwaysInclude?: boolean;
    domainWeight?: number;
  } = {},
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
      domains: options.domains,
      capabilities: options.capabilities,
      alwaysInclude: options.alwaysInclude,
      domainWeight: options.domainWeight,
    } as SkillEntry["metadata"],
  };
}

describe("router", () => {
  beforeEach(() => {
    clearRoutingCache();
    clearCapabilitiesCache();
  });

  const codingSkills: SkillEntry[] = [
    createSkillEntry("claude-code", { domains: ["coding"] }),
    createSkillEntry("github", { domains: ["coding", "devops"] }),
    createSkillEntry("paralegal", { domains: ["legal"] }),
    createSkillEntry("accountant", { domains: ["finance"] }),
    createSkillEntry("general-helper", {}),
    createSkillEntry("always-on", { domains: ["misc"], alwaysInclude: true }),
  ];

  describe("routeSkills", () => {
    describe("static mode", () => {
      it("returns all eligible skills", async () => {
        const config: SkillRoutingConfig = { mode: "static" };
        const context = { message: "Help me write code" };

        const result = await routeSkills(codingSkills, context, config);

        expect(result.selectedSkills).toHaveLength(codingSkills.length);
        expect(result.method).toBe("static");
        expect(result.classifications).toHaveLength(0);
      });

      it("is the default mode", async () => {
        const context = { message: "Help me write code" };

        const result = await routeSkills(codingSkills, context);

        expect(result.method).toBe("static");
      });
    });

    describe("dynamic mode", () => {
      const dynamicConfig: SkillRoutingConfig = {
        mode: "dynamic",
        dynamic: {
          classifier: "keywords",
          minConfidence: 0.3,
          respectAlwaysInclude: true,
        },
      };

      it("classifies and filters skills", async () => {
        const context = { message: "Help me write a function" };

        const result = await routeSkills(codingSkills, context, dynamicConfig);

        expect(result.method).toBe("dynamic");
        expect(result.selectedSkills).toContain("claude-code");
        expect(result.selectedSkills).toContain("github");
        expect(result.selectedSkills).not.toContain("paralegal");
        expect(result.selectedSkills).not.toContain("accountant");
      });

      it("includes alwaysInclude skills", async () => {
        const context = { message: "Help me with random stuff" };

        const result = await routeSkills(codingSkills, context, dynamicConfig);

        expect(result.selectedSkills).toContain("always-on");
      });

      it("respects maxSkills limit", async () => {
        const config: SkillRoutingConfig = {
          mode: "dynamic",
          dynamic: {
            classifier: "keywords",
            minConfidence: 0.0,
            maxSkills: 2,
          },
        };
        const context = { message: "Help me with everything" };

        const result = await routeSkills(codingSkills, context, config);

        expect(result.selectedSkills.length).toBeLessThanOrEqual(2);
      });

      it("applies minConfidence filter", async () => {
        const strictConfig: SkillRoutingConfig = {
          mode: "dynamic",
          dynamic: {
            classifier: "keywords",
            minConfidence: 0.9,
            respectAlwaysInclude: false,
          },
        };
        const context = { message: "Write some code" };

        const result = await routeSkills(codingSkills, context, strictConfig);

        // Only high-confidence matches should pass
        expect(result.selectedSkills.length).toBeLessThan(codingSkills.length);
      });

      it("returns detected domains", async () => {
        const context = { message: "Review the contract" };

        const result = await routeSkills(codingSkills, context, dynamicConfig);

        expect(result.detectedDomains).toContain("legal");
      });
    });

    describe("hybrid mode", () => {
      it("uses static when skills <= threshold", async () => {
        const config: SkillRoutingConfig = {
          mode: "hybrid",
          hybrid: { staticThreshold: 10 },
        };
        const context = { message: "Help me" };

        const result = await routeSkills(codingSkills, context, config);

        expect(result.method).toBe("hybrid");
        expect(result.selectedSkills).toHaveLength(codingSkills.length);
      });

      it("uses dynamic when skills > threshold", async () => {
        const config: SkillRoutingConfig = {
          mode: "hybrid",
          hybrid: { staticThreshold: 2 },
          dynamic: { classifier: "keywords", minConfidence: 0.3 },
        };
        const context = { message: "Write some code" };

        const result = await routeSkills(codingSkills, context, config);

        expect(result.method).toBe("hybrid");
        expect(result.classifications.length).toBeGreaterThan(0);
      });
    });

    describe("capability filtering", () => {
      it("excludes skills based on model capabilities", async () => {
        const skills = [
          createSkillEntry("vision-skill", { capabilities: ["vision"] }),
          createSkillEntry("basic-skill", {}),
        ];
        const context = {
          message: "Do something",
          currentModel: "openai/o1", // No vision
        };

        const result = await routeSkills(skills, context, { mode: "static" });

        expect(result.selectedSkills).toContain("basic-skill");
        expect(result.selectedSkills).not.toContain("vision-skill");
        expect(result.capabilityExclusions).toHaveLength(1);
        expect(result.capabilityExclusions![0].skill).toBe("vision-skill");
      });

      it("applies capability config overrides", async () => {
        const skills = [createSkillEntry("thinking-skill", { capabilities: ["thinking"] })];
        const context = {
          message: "Do something",
          currentModel: "anthropic/claude-haiku",
        };
        const modelsConfig: Parameters<typeof routeSkills>[3] = {
          capabilities: {
            "anthropic/claude-haiku": { add: ["thinking"] },
          },
        };

        const result = await routeSkills(skills, context, { mode: "static" }, modelsConfig);

        expect(result.selectedSkills).toContain("thinking-skill");
      });
    });

    describe("caching", () => {
      it("caches results when enabled", async () => {
        const config: SkillRoutingConfig = {
          mode: "dynamic",
          dynamic: { cachePerSession: true },
        };
        const context = {
          message: "Write code",
          sessionKey: "test-session",
        };

        const result1 = await routeSkills(codingSkills, context, config);
        expect(result1.cached).toBe(false);

        const result2 = await routeSkills(codingSkills, context, config);
        expect(result2.cached).toBe(true);
      });

      it("does not cache without sessionKey", async () => {
        const config: SkillRoutingConfig = {
          mode: "dynamic",
          dynamic: { cachePerSession: true },
        };
        const context = { message: "Write code" };

        const result1 = await routeSkills(codingSkills, context, config);
        const result2 = await routeSkills(codingSkills, context, config);

        expect(result1.cached).toBe(false);
        expect(result2.cached).toBe(false);
      });
    });
  });

  describe("routeSkillsSync", () => {
    it("works the same as async version for keywords", () => {
      const config: SkillRoutingConfig = {
        mode: "dynamic",
        dynamic: { classifier: "keywords", minConfidence: 0.3 },
      };
      const context = { message: "Help me write a function" };

      const result = routeSkillsSync(codingSkills, context, config);

      expect(result.method).toBe("dynamic");
      expect(result.selectedSkills).toContain("claude-code");
    });

    it("handles static mode", () => {
      const config: SkillRoutingConfig = { mode: "static" };
      const context = { message: "Anything" };

      const result = routeSkillsSync(codingSkills, context, config);

      expect(result.selectedSkills).toHaveLength(codingSkills.length);
    });

    it("handles hybrid mode", () => {
      const config: SkillRoutingConfig = {
        mode: "hybrid",
        hybrid: { staticThreshold: 10 },
      };
      const context = { message: "Anything" };

      const result = routeSkillsSync(codingSkills, context, config);

      expect(result.method).toBe("hybrid");
    });
  });

  describe("clearRoutingCache", () => {
    it("clears the cache", async () => {
      const config: SkillRoutingConfig = {
        mode: "dynamic",
        dynamic: { cachePerSession: true },
      };
      const context = {
        message: "Write code",
        sessionKey: "test-session",
      };

      await routeSkills(codingSkills, context, config);
      clearRoutingCache();
      const result = await routeSkills(codingSkills, context, config);

      expect(result.cached).toBe(false);
    });
  });
});
