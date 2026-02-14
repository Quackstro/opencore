/**
 * Tests for cost-aware model selector.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  MODEL_COSTS,
  DEFAULT_COST_AWARE_CONFIG,
  getModelCost,
  estimateRequestCost,
  compareCosts,
  filterByTier,
  selectModelCostAware,
  createBudgetTracker,
  getModelsByTier,
  getCostSummary,
  type CostTier,
  type CostAwareConfig,
} from "./cost-aware-selector.js";

describe("cost-aware-selector", () => {
  describe("MODEL_COSTS", () => {
    it("has costs for major models", () => {
      expect(MODEL_COSTS["anthropic/claude-opus-4"]).toBeDefined();
      expect(MODEL_COSTS["anthropic/claude-sonnet-4"]).toBeDefined();
      expect(MODEL_COSTS["anthropic/claude-haiku"]).toBeDefined();
      expect(MODEL_COSTS["openai/gpt-4o"]).toBeDefined();
      expect(MODEL_COSTS["openai/o1"]).toBeDefined();
      expect(MODEL_COSTS["google/gemini-2.0-flash"]).toBeDefined();
    });

    it("has valid tier values", () => {
      const validTiers: CostTier[] = ["free", "cheap", "standard", "expensive"];
      for (const [model, cost] of Object.entries(MODEL_COSTS)) {
        expect(validTiers).toContain(cost.tier);
      }
    });

    it("has positive costs", () => {
      for (const [model, cost] of Object.entries(MODEL_COSTS)) {
        expect(cost.inputPer1kTokens).toBeGreaterThanOrEqual(0);
        expect(cost.outputPer1kTokens).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("getModelCost", () => {
    it("returns cost for known model", () => {
      const cost = getModelCost("anthropic/claude-haiku");
      expect(cost).toBeDefined();
      expect(cost!.tier).toBe("cheap");
    });

    it("returns undefined for unknown model", () => {
      const cost = getModelCost("unknown/model");
      expect(cost).toBeUndefined();
    });
  });

  describe("estimateRequestCost", () => {
    it("calculates cost correctly", () => {
      // Claude Haiku: $0.00025/1k input, $0.00125/1k output
      const cost = estimateRequestCost("anthropic/claude-haiku", 1000, 1000);

      // Expected: 0.00025 + 0.00125 = 0.0015
      expect(cost).toBeCloseTo(0.0015, 5);
    });

    it("handles large token counts", () => {
      const cost = estimateRequestCost("anthropic/claude-haiku", 10000, 5000);

      // Expected: (10 * 0.00025) + (5 * 0.00125) = 0.0025 + 0.00625 = 0.00875
      expect(cost).toBeCloseTo(0.00875, 5);
    });

    it("returns undefined for unknown model", () => {
      const cost = estimateRequestCost("unknown/model", 1000, 1000);
      expect(cost).toBeUndefined();
    });
  });

  describe("compareCosts", () => {
    it("ranks cheap models before expensive", () => {
      const result = compareCosts("anthropic/claude-haiku", "anthropic/claude-opus-4");
      expect(result).toBeLessThan(0);
    });

    it("ranks same tier by total cost", () => {
      // Both standard tier, but different costs
      const result = compareCosts("anthropic/claude-sonnet-4", "openai/gpt-4-turbo");
      // Sonnet is cheaper
      expect(result).toBeLessThan(0);
    });

    it("returns 0 for same model", () => {
      const result = compareCosts("anthropic/claude-haiku", "anthropic/claude-haiku");
      expect(result).toBe(0);
    });

    it("handles unknown models", () => {
      // Unknown models sort last
      const result = compareCosts("unknown/model", "anthropic/claude-haiku");
      expect(result).toBeGreaterThan(0);
    });
  });

  describe("filterByTier", () => {
    const models = [
      "anthropic/claude-haiku", // cheap
      "anthropic/claude-sonnet-4", // standard
      "anthropic/claude-opus-4", // expensive
    ];

    it("filters to cheap tier", () => {
      const result = filterByTier(models, "cheap");
      expect(result).toContain("anthropic/claude-haiku");
      expect(result).not.toContain("anthropic/claude-sonnet-4");
      expect(result).not.toContain("anthropic/claude-opus-4");
    });

    it("filters to standard tier (includes cheap)", () => {
      const result = filterByTier(models, "standard");
      expect(result).toContain("anthropic/claude-haiku");
      expect(result).toContain("anthropic/claude-sonnet-4");
      expect(result).not.toContain("anthropic/claude-opus-4");
    });

    it("expensive tier includes all", () => {
      const result = filterByTier(models, "expensive");
      expect(result).toHaveLength(3);
    });

    it("includes unknown models", () => {
      const result = filterByTier(["unknown/model"], "cheap");
      expect(result).toContain("unknown/model");
    });
  });

  describe("selectModelCostAware", () => {
    const availableModels = [
      "anthropic/claude-haiku",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4",
      "openai/gpt-4o-mini",
    ];

    it("selects cheapest capable model", () => {
      const config: CostAwareConfig = { preferCheaper: true };
      const result = selectModelCostAware(["tool-use"], availableModels, config);

      // Either Haiku or GPT-4o-mini are cheapest with tool-use
      expect(["anthropic/claude-haiku", "openai/gpt-4o-mini"]).toContain(result.model);
      expect(result.cost.tier).toBe("cheap");
    });

    it("respects maxTier", () => {
      const config: CostAwareConfig = { preferCheaper: true, maxTier: "standard" };
      const result = selectModelCostAware(["thinking"], availableModels, config);

      // Opus has thinking but is expensive; Sonnet has thinking and is standard
      expect(result.model).toBe("anthropic/claude-sonnet-4");
    });

    it("selects model with required capabilities", () => {
      const config: CostAwareConfig = { preferCheaper: true };
      const result = selectModelCostAware(["thinking", "vision"], availableModels, config);

      // Only Sonnet and Opus have both thinking and vision
      expect(["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"]).toContain(result.model);
    });

    it("returns warning for no capable model", () => {
      const config: CostAwareConfig = { preferCheaper: true };
      const result = selectModelCostAware(
        ["code-execution"], // No model has this
        ["anthropic/claude-haiku"],
        config,
      );

      expect(result.reason).toContain("WARNING");
    });

    it("provides alternatives", () => {
      const config: CostAwareConfig = { preferCheaper: true };
      const result = selectModelCostAware(["tool-use"], availableModels, config);

      expect(result.alternatives).toBeDefined();
      expect(result.alternatives!.length).toBeGreaterThan(0);
    });
  });

  describe("createBudgetTracker", () => {
    it("tracks usage", () => {
      const tracker = createBudgetTracker(1.0);

      tracker.recordUsage("anthropic/claude-haiku", 1000, 1000);
      const spend = tracker.getTodaySpend();

      expect(spend).toBeGreaterThan(0);
    });

    it("calculates remaining budget", () => {
      const tracker = createBudgetTracker(1.0);

      const before = tracker.getRemainingBudget();
      tracker.recordUsage("anthropic/claude-haiku", 1000, 1000);
      const after = tracker.getRemainingBudget();

      expect(after).toBeLessThan(before!);
    });

    it("returns undefined remaining for unlimited budget", () => {
      const tracker = createBudgetTracker();
      expect(tracker.getRemainingBudget()).toBeUndefined();
    });

    it("checks affordability", () => {
      const tracker = createBudgetTracker(0.001);

      // Should be able to afford one small request
      expect(tracker.canAfford("anthropic/claude-haiku", 100, 100)).toBe(true);

      // Use up most of budget
      tracker.recordUsage("anthropic/claude-haiku", 2000, 2000);

      // Should not be able to afford much more
      expect(tracker.canAfford("anthropic/claude-haiku", 10000, 10000)).toBe(false);
    });

    it("resets daily", () => {
      const tracker = createBudgetTracker(1.0);

      tracker.recordUsage("anthropic/claude-haiku", 1000, 1000);
      const spendBefore = tracker.getTodaySpend();
      expect(spendBefore).toBeGreaterThan(0);

      tracker.resetDaily();
      const spendAfter = tracker.getTodaySpend();
      expect(spendAfter).toBe(0);
    });

    it("always affords with unlimited budget", () => {
      const tracker = createBudgetTracker();

      expect(tracker.canAfford("anthropic/claude-opus-4", 1000000, 1000000)).toBe(true);
    });
  });

  describe("getModelsByTier", () => {
    it("returns models for each tier", () => {
      const cheap = getModelsByTier("cheap");
      const expensive = getModelsByTier("expensive");

      expect(cheap.length).toBeGreaterThan(0);
      expect(expensive.length).toBeGreaterThan(0);

      expect(cheap).toContain("anthropic/claude-haiku");
      expect(expensive).toContain("anthropic/claude-opus-4");
    });
  });

  describe("getCostSummary", () => {
    it("returns summary for all tiers", () => {
      const summary = getCostSummary();

      expect(summary.cheap).toBeDefined();
      expect(summary.standard).toBeDefined();
      expect(summary.expensive).toBeDefined();

      expect(summary.cheap.models.length).toBeGreaterThan(0);
      expect(summary.cheap.avgInputCost).toBeGreaterThanOrEqual(0);
    });
  });

  describe("DEFAULT_COST_AWARE_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_COST_AWARE_CONFIG.preferCheaper).toBe(true);
      expect(DEFAULT_COST_AWARE_CONFIG.maxTier).toBe("expensive");
      expect(DEFAULT_COST_AWARE_CONFIG.costWeight).toBe(0.5);
    });
  });
});
