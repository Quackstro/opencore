/**
 * Tests for model capabilities registry.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  MODEL_CAPABILITIES,
  getModelCapabilities,
  modelHasCapability,
  modelHasCapabilities,
  getKnownModels,
  findModelsWithCapabilities,
  clearCapabilitiesCache,
} from "./model-capabilities.js";

describe("model-capabilities", () => {
  beforeEach(() => {
    clearCapabilitiesCache();
  });

  describe("MODEL_CAPABILITIES", () => {
    it("contains Anthropic models", () => {
      expect(MODEL_CAPABILITIES["anthropic/claude-opus-4"]).toBeDefined();
      expect(MODEL_CAPABILITIES["anthropic/claude-sonnet-4"]).toBeDefined();
      expect(MODEL_CAPABILITIES["anthropic/claude-haiku"]).toBeDefined();
    });

    it("contains OpenAI models", () => {
      expect(MODEL_CAPABILITIES["openai/gpt-4o"]).toBeDefined();
      expect(MODEL_CAPABILITIES["openai/o1"]).toBeDefined();
    });

    it("contains Google models", () => {
      expect(MODEL_CAPABILITIES["google/gemini-2.0-flash"]).toBeDefined();
    });

    it("claude-opus-4 has vision and thinking", () => {
      const caps = MODEL_CAPABILITIES["anthropic/claude-opus-4"];
      expect(caps).toContain("vision");
      expect(caps).toContain("thinking");
      expect(caps).toContain("long-context");
    });

    it("o1 has thinking but not vision", () => {
      const caps = MODEL_CAPABILITIES["openai/o1"];
      expect(caps).toContain("thinking");
      expect(caps).not.toContain("vision");
    });
  });

  describe("getModelCapabilities", () => {
    it("returns capabilities for known models", () => {
      const caps = getModelCapabilities("anthropic/claude-opus-4");
      expect(caps).toContain("vision");
      expect(caps.length).toBeGreaterThan(0);
    });

    it("returns empty array for unknown models", () => {
      const caps = getModelCapabilities("unknown/model");
      expect(caps).toEqual([]);
    });

    it("applies config overrides (full replacement)", () => {
      const config: Parameters<typeof getModelCapabilities>[1] = {
        capabilities: {
          "custom/model": ["vision", "tool-use"],
        },
      };
      const caps = getModelCapabilities("custom/model", config);
      expect(caps).toContain("vision");
      expect(caps).toContain("tool-use");
    });

    it("applies config overrides (add)", () => {
      const config: Parameters<typeof getModelCapabilities>[1] = {
        capabilities: {
          "anthropic/claude-haiku": {
            add: ["thinking"],
          },
        },
      };
      const caps = getModelCapabilities("anthropic/claude-haiku", config);
      expect(caps).toContain("thinking");
      expect(caps).toContain("vision"); // Original capability
    });

    it("applies config overrides (remove)", () => {
      const config: Parameters<typeof getModelCapabilities>[1] = {
        capabilities: {
          "anthropic/claude-opus-4": {
            remove: ["vision"],
          },
        },
      };
      const caps = getModelCapabilities("anthropic/claude-opus-4", config);
      expect(caps).not.toContain("vision");
      expect(caps).toContain("thinking"); // Not removed
    });
  });

  describe("modelHasCapability", () => {
    it("returns true for supported capabilities", () => {
      expect(modelHasCapability("anthropic/claude-opus-4", "vision")).toBe(true);
    });

    it("returns false for unsupported capabilities", () => {
      expect(modelHasCapability("openai/o1", "vision")).toBe(false);
    });

    it("returns false for unknown models", () => {
      expect(modelHasCapability("unknown/model", "vision")).toBe(false);
    });
  });

  describe("modelHasCapabilities", () => {
    it("returns true when all capabilities are present", () => {
      expect(modelHasCapabilities("anthropic/claude-opus-4", ["vision", "thinking"])).toBe(true);
    });

    it("returns false when any capability is missing", () => {
      expect(modelHasCapabilities("openai/o1", ["vision", "thinking"])).toBe(false);
    });

    it("returns true for empty requirements", () => {
      expect(modelHasCapabilities("unknown/model", [])).toBe(true);
    });
  });

  describe("getKnownModels", () => {
    it("returns array of model IDs", () => {
      const models = getKnownModels();
      expect(models).toContain("anthropic/claude-opus-4");
      expect(models).toContain("openai/gpt-4o");
      expect(models.length).toBeGreaterThan(10);
    });
  });

  describe("findModelsWithCapabilities", () => {
    it("finds models with vision", () => {
      const models = findModelsWithCapabilities(["vision"]);
      expect(models).toContain("anthropic/claude-opus-4");
      expect(models).toContain("openai/gpt-4o");
      expect(models).not.toContain("openai/o1");
    });

    it("finds models with thinking", () => {
      const models = findModelsWithCapabilities(["thinking"]);
      expect(models).toContain("anthropic/claude-opus-4");
      expect(models).toContain("openai/o1");
    });

    it("finds models with multiple capabilities", () => {
      const models = findModelsWithCapabilities(["vision", "thinking"]);
      expect(models).toContain("anthropic/claude-opus-4");
      expect(models).not.toContain("openai/o1"); // Missing vision
      expect(models).not.toContain("openai/gpt-4o"); // Missing thinking
    });

    it("returns all models for empty requirements", () => {
      const models = findModelsWithCapabilities([]);
      expect(models.length).toBe(getKnownModels().length);
    });
  });
});
