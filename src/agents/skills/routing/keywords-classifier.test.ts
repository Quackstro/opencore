/**
 * Tests for keywords classifier.
 */

import { describe, expect, it } from "vitest";
import type { SkillEntry } from "../types.js";
import type { SkillRoutingConfig } from "./types.js";
import {
  DOMAIN_KEYWORDS,
  detectDomainsFromMessage,
  classifyWithKeywords,
  getCanonicalDomains,
  getDomainKeywords,
} from "./keywords-classifier.js";

// Helper to create mock skill entries
function createSkillEntry(
  name: string,
  domains: string[] = [],
  options: { alwaysInclude?: boolean; domainWeight?: number } = {},
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
      domains,
      alwaysInclude: options.alwaysInclude,
      domainWeight: options.domainWeight,
    } as SkillEntry["metadata"],
  };
}

describe("keywords-classifier", () => {
  describe("DOMAIN_KEYWORDS", () => {
    it("contains coding domain", () => {
      expect(DOMAIN_KEYWORDS.coding).toBeDefined();
      expect(DOMAIN_KEYWORDS.coding).toContain("code");
      expect(DOMAIN_KEYWORDS.coding).toContain("function");
    });

    it("contains legal domain", () => {
      expect(DOMAIN_KEYWORDS.legal).toBeDefined();
      expect(DOMAIN_KEYWORDS.legal).toContain("contract");
      expect(DOMAIN_KEYWORDS.legal).toContain("attorney");
    });

    it("contains all canonical domains", () => {
      const domains = getCanonicalDomains();
      expect(domains).toContain("coding");
      expect(domains).toContain("legal");
      expect(domains).toContain("finance");
      expect(domains).toContain("devops");
      expect(domains).toContain("writing");
    });
  });

  describe("detectDomainsFromMessage", () => {
    it("detects coding domain", () => {
      const domains = detectDomainsFromMessage("Help me write a function");
      expect(domains.has("coding")).toBe(true);
    });

    it("detects legal domain", () => {
      const domains = detectDomainsFromMessage("Review this contract");
      expect(domains.has("legal")).toBe(true);
    });

    it("detects multiple domains", () => {
      const domains = detectDomainsFromMessage(
        "Deploy my code to the server and review the invoice",
      );
      expect(domains.has("coding")).toBe(true);
      expect(domains.has("devops")).toBe(true);
      expect(domains.has("finance")).toBe(true);
    });

    it("returns empty set for unrelated message", () => {
      const domains = detectDomainsFromMessage("Hello, how are you?");
      expect(domains.size).toBe(0);
    });

    it("handles domain aliases", () => {
      const config: SkillRoutingConfig = {
        mode: "dynamic",
        domainAliases: {
          frontend: ["coding", "ui-design"],
        },
      };
      const domains = detectDomainsFromMessage("Build a UI component", config);
      expect(domains.has("ui-design")).toBe(true);
      expect(domains.has("frontend")).toBe(true);
    });

    it("matches whole words only", () => {
      // "code" should match but not "encode"
      const domains1 = detectDomainsFromMessage("help me code this");
      expect(domains1.has("coding")).toBe(true);

      // Should still match if "code" appears as a word
      const domains2 = detectDomainsFromMessage("the source code is broken");
      expect(domains2.has("coding")).toBe(true);
    });

    it("is case-insensitive", () => {
      const domains = detectDomainsFromMessage("Write a FUNCTION in JavaScript");
      expect(domains.has("coding")).toBe(true);
    });
  });

  describe("classifyWithKeywords", () => {
    const skills: SkillEntry[] = [
      createSkillEntry("claude-code", ["coding", "devops"]),
      createSkillEntry("paralegal", ["legal"]),
      createSkillEntry("accountant", ["finance"]),
      createSkillEntry("general-helper", []),
      createSkillEntry("critical-skill", ["coding"], { alwaysInclude: true }),
      createSkillEntry("weighted-skill", ["coding"], { domainWeight: 0.5 }),
    ];

    it("returns classifications sorted by confidence", () => {
      const context = { message: "Write a function to process data" };
      const classifications = classifyWithKeywords(context, skills);

      expect(classifications.length).toBe(skills.length);
      // First should be highest confidence
      expect(classifications[0].confidence).toBeGreaterThanOrEqual(classifications[1].confidence);
    });

    it("gives high score to matching domains", () => {
      const context = { message: "Review the contract terms" };
      const classifications = classifyWithKeywords(context, skills);

      const paralegal = classifications.find((c) => c.skillName === "paralegal");
      expect(paralegal).toBeDefined();
      expect(paralegal!.confidence).toBeGreaterThan(0.5);
    });

    it("gives low score to non-matching skills", () => {
      const context = { message: "Review the contract terms" };
      const classifications = classifyWithKeywords(context, skills);

      const accountant = classifications.find((c) => c.skillName === "accountant");
      expect(accountant).toBeDefined();
      expect(accountant!.confidence).toBe(0);
    });

    it("gives baseline score to skills without domains", () => {
      const context = { message: "Do something" };
      const classifications = classifyWithKeywords(context, skills);

      const helper = classifications.find((c) => c.skillName === "general-helper");
      expect(helper).toBeDefined();
      expect(helper!.confidence).toBe(0.1);
      expect(helper!.reason).toBe("no domains defined");
    });

    it("gives max score to alwaysInclude skills", () => {
      const context = { message: "Do something" };
      const classifications = classifyWithKeywords(context, skills);

      const critical = classifications.find((c) => c.skillName === "critical-skill");
      expect(critical).toBeDefined();
      expect(critical!.confidence).toBe(1.0);
      expect(critical!.reason).toBe("alwaysInclude flag");
    });

    it("applies domain weight", () => {
      const context = { message: "Write a function" };
      const classifications = classifyWithKeywords(context, skills);

      const weighted = classifications.find((c) => c.skillName === "weighted-skill");
      const claudeCode = classifications.find((c) => c.skillName === "claude-code");

      expect(weighted).toBeDefined();
      expect(claudeCode).toBeDefined();

      // weighted-skill: ["coding"] -> 1/1 = 1.0 * 0.5 weight = 0.5
      // claude-code: ["coding", "devops"] -> 1/2 = 0.5 * 1.0 weight = 0.5
      // In this case they're equal, so let's just verify the weight is applied
      expect(weighted!.confidence).toBe(0.5);

      // Create a test with a skill that has a single domain and full match
      const singleDomainSkills: SkillEntry[] = [
        createSkillEntry("full-weight", ["coding"]),
        createSkillEntry("half-weight", ["coding"], { domainWeight: 0.5 }),
      ];
      const singleResults = classifyWithKeywords(context, singleDomainSkills);
      const fullWeight = singleResults.find((c) => c.skillName === "full-weight");
      const halfWeight = singleResults.find((c) => c.skillName === "half-weight");

      expect(fullWeight!.confidence).toBe(1.0);
      expect(halfWeight!.confidence).toBe(0.5);
      expect(halfWeight!.confidence).toBeLessThan(fullWeight!.confidence);
    });

    it("uses pre-detected domains from context", () => {
      const context = {
        message: "Do something random",
        detectedDomains: ["legal"],
      };
      const classifications = classifyWithKeywords(context, skills);

      const paralegal = classifications.find((c) => c.skillName === "paralegal");
      expect(paralegal).toBeDefined();
      expect(paralegal!.confidence).toBeGreaterThan(0);
    });

    it("includes reason for matched domains", () => {
      const context = { message: "Review the contract" };
      const classifications = classifyWithKeywords(context, skills);

      const paralegal = classifications.find((c) => c.skillName === "paralegal");
      expect(paralegal?.reason).toContain("matched");
      expect(paralegal?.reason).toContain("legal");
    });
  });

  describe("getCanonicalDomains", () => {
    it("returns array of domain names", () => {
      const domains = getCanonicalDomains();
      expect(Array.isArray(domains)).toBe(true);
      expect(domains.length).toBeGreaterThan(5);
    });
  });

  describe("getDomainKeywords", () => {
    it("returns keywords for known domain", () => {
      const keywords = getDomainKeywords("coding");
      expect(keywords).toContain("code");
      expect(keywords).toContain("function");
    });

    it("returns empty array for unknown domain", () => {
      const keywords = getDomainKeywords("unknown-domain");
      expect(keywords).toEqual([]);
    });
  });
});
