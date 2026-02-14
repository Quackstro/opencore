/**
 * Tests for routing types and default configuration.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_CONFIG,
  type SkillRoutingConfig,
  type RoutingContext,
  type RoutingResult,
  type SkillClassification,
} from "./types.js";

describe("routing types", () => {
  describe("DEFAULT_ROUTING_CONFIG", () => {
    it("defaults to static mode", () => {
      expect(DEFAULT_ROUTING_CONFIG.mode).toBe("static");
    });

    it("has keywords as default classifier", () => {
      expect(DEFAULT_ROUTING_CONFIG.dynamic?.classifier).toBe("keywords");
    });

    it("has sensible dynamic defaults", () => {
      expect(DEFAULT_ROUTING_CONFIG.dynamic?.maxSkills).toBe(0);
      expect(DEFAULT_ROUTING_CONFIG.dynamic?.minConfidence).toBe(0.3);
      expect(DEFAULT_ROUTING_CONFIG.dynamic?.respectAlwaysInclude).toBe(true);
      expect(DEFAULT_ROUTING_CONFIG.dynamic?.cachePerSession).toBe(true);
    });

    it("has sensible hybrid defaults", () => {
      expect(DEFAULT_ROUTING_CONFIG.hybrid?.staticThreshold).toBe(5);
      expect(DEFAULT_ROUTING_CONFIG.hybrid?.dynamicAboveThreshold).toBe(true);
    });
  });

  describe("type validation", () => {
    it("accepts valid SkillRoutingConfig", () => {
      const config: SkillRoutingConfig = {
        mode: "dynamic",
        dynamic: {
          classifier: "keywords",
          maxSkills: 10,
          minConfidence: 0.5,
        },
        domainAliases: {
          frontend: ["coding", "ui-design"],
        },
      };
      expect(config.mode).toBe("dynamic");
    });

    it("accepts valid RoutingContext", () => {
      const context: RoutingContext = {
        message: "Help me write a function",
        conversationHistory: ["previous message"],
        sessionKey: "session-123",
        currentModel: "anthropic/claude-opus-4",
      };
      expect(context.message).toBeDefined();
    });

    it("accepts valid RoutingResult", () => {
      const result: RoutingResult = {
        selectedSkills: ["claude-code", "github"],
        classifications: [
          {
            skillName: "claude-code",
            domains: ["coding"],
            confidence: 0.9,
            reason: "matched: coding",
          },
        ],
        method: "dynamic",
        cached: false,
      };
      expect(result.selectedSkills).toHaveLength(2);
    });

    it("accepts valid SkillClassification", () => {
      const classification: SkillClassification = {
        skillName: "paralegal",
        domains: ["legal"],
        confidence: 0.85,
        reason: "matched: legal",
      };
      expect(classification.confidence).toBeGreaterThan(0);
    });
  });
});
