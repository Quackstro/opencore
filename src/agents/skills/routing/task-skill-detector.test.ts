/**
 * Tests for task-skill-detector.ts
 */

import { describe, it, expect } from "vitest";
import type { SkillEntry } from "../types.js";
import { detectSkillFromTask, detectBestSkillForTask } from "./task-skill-detector.js";

describe("detectSkillFromTask", () => {
  it("should detect coding domains from task", () => {
    const result = detectSkillFromTask("Fix the TypeScript error in the API handler");

    expect(result.domains).toContain("coding");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.inferredCapabilities).toContain("tool-use");
  });

  it("should detect media domains and require vision capability", () => {
    const result = detectSkillFromTask("Analyze this screenshot and describe what you see");

    expect(result.domains).toContain("media");
    expect(result.inferredCapabilities).toContain("vision");
  });

  it("should detect multiple domains", () => {
    const result = detectSkillFromTask("Review this screenshot and debug the JavaScript code");

    expect(result.domains).toContain("media");
    expect(result.domains).toContain("coding");
    expect(result.inferredCapabilities).toContain("vision");
    expect(result.inferredCapabilities).toContain("tool-use");
  });

  it("should suggest thinking level for coding tasks", () => {
    const result = detectSkillFromTask("Implement a complex algorithm for sorting");

    expect(result.suggestedThinking).toBe("medium");
  });

  it("should suggest high thinking for legal/security tasks", () => {
    const legalResult = detectSkillFromTask("Review this contract for liability issues");
    expect(legalResult.suggestedThinking).toBe("high");

    const securityResult = detectSkillFromTask("Audit this code for security vulnerabilities");
    expect(securityResult.suggestedThinking).toBe("high");
  });

  it("should return empty result for generic tasks", () => {
    const result = detectSkillFromTask("Hello, how are you today?");

    expect(result.domains.length).toBe(0);
    expect(result.inferredCapabilities.length).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.syntheticSkill).toBeUndefined();
  });

  it("should create synthetic skill entry for detected domains", () => {
    const result = detectSkillFromTask("Deploy the Docker container to Kubernetes");

    expect(result.syntheticSkill).toBeDefined();
    expect(result.syntheticSkill?.skill.name).toBe("task-inferred");
    expect(result.syntheticSkill?.metadata?.domains).toContain("devops");
  });

  it("should detect research domains", () => {
    const result = detectSkillFromTask("Search for recent papers on machine learning");

    expect(result.domains).toContain("research");
    expect(result.inferredCapabilities).toContain("web-search");
  });
});

describe("detectBestSkillForTask", () => {
  const mockSkills: SkillEntry[] = [
    {
      skill: { name: "claude-code", description: "Coding assistant", baseDir: "", files: [] },
      frontmatter: {},
      metadata: { domains: ["coding", "programming"] } as unknown as SkillEntry["metadata"],
    },
    {
      skill: { name: "image-analyzer", description: "Image analysis", baseDir: "", files: [] },
      frontmatter: {},
      metadata: {
        domains: ["media"],
        capabilities: ["vision"],
      } as unknown as SkillEntry["metadata"],
    },
    {
      skill: { name: "legal-assistant", description: "Legal help", baseDir: "", files: [] },
      frontmatter: {},
      metadata: { domains: ["legal"] } as unknown as SkillEntry["metadata"],
    },
  ];

  it("should find best matching skill based on domains", () => {
    const result = detectBestSkillForTask("Fix this JavaScript bug", mockSkills);

    expect(result?.skill.name).toBe("claude-code");
  });

  it("should find image-analyzer for media tasks", () => {
    const result = detectBestSkillForTask("Analyze this screenshot", mockSkills);

    expect(result?.skill.name).toBe("image-analyzer");
  });

  it("should find legal-assistant for contract tasks", () => {
    const result = detectBestSkillForTask("Review this contract", mockSkills);

    expect(result?.skill.name).toBe("legal-assistant");
  });

  it("should return undefined when no match found", () => {
    const result = detectBestSkillForTask("Hello, how are you?", mockSkills);

    expect(result).toBeUndefined();
  });

  it("should return undefined for empty skill list", () => {
    const result = detectBestSkillForTask("Fix this code", []);

    expect(result).toBeUndefined();
  });

  it("should return undefined for skills without domains", () => {
    const skillsWithoutDomains: SkillEntry[] = [
      {
        skill: { name: "generic", description: "Generic skill", baseDir: "", files: [] },
        frontmatter: {},
        metadata: {},
      },
    ];

    const result = detectBestSkillForTask("Fix this code", skillsWithoutDomains);

    expect(result).toBeUndefined();
  });
});
