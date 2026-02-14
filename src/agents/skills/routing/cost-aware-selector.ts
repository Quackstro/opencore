/**
 * Cost-Aware Model Selector
 *
 * Factors in model costs when selecting models for skill execution.
 * Prefers cheaper models when they satisfy capability requirements.
 *
 * Cost data sources:
 * - Anthropic: https://www.anthropic.com/pricing
 * - OpenAI: https://openai.com/pricing
 * - Google: https://ai.google.dev/pricing
 * - DeepSeek: https://platform.deepseek.com/api-docs/pricing
 *
 * @module agents/skills/routing/cost-aware-selector
 */

import type { ModelCapability, ModelsCapabilityConfig } from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getModelCapabilities, modelHasCapabilities } from "./model-capabilities.js";

const costLogger = createSubsystemLogger("skills-cost-selector");

/**
 * Cost tier from cheapest to most expensive.
 */
export type CostTier = "free" | "cheap" | "standard" | "expensive";

/**
 * Cost information for a model.
 */
export interface ModelCost {
  /** Input cost per 1K tokens in USD */
  inputPer1kTokens: number;
  /** Output cost per 1K tokens in USD */
  outputPer1kTokens: number;
  /** Cost tier classification */
  tier: CostTier;
  /** Optional: context window size */
  contextWindow?: number;
  /** Optional: notes about pricing */
  notes?: string;
}

/**
 * Cost registry for known models.
 *
 * Prices as of February 2026. May need periodic updates.
 * Sources:
 * - Anthropic: anthropic.com/pricing
 * - OpenAI: openai.com/pricing
 * - Google: ai.google.dev/pricing
 * - DeepSeek: platform.deepseek.com
 * - Mistral: mistral.ai/pricing
 */
export const MODEL_COSTS: Record<string, ModelCost> = {
  // Anthropic models (prices per 1K tokens)
  "anthropic/claude-opus-4": {
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    tier: "expensive",
    contextWindow: 200000,
    notes: "Most capable Anthropic model",
  },
  "anthropic/claude-sonnet-4": {
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    tier: "standard",
    contextWindow: 200000,
    notes: "Balanced performance and cost",
  },
  "anthropic/claude-3.5-sonnet": {
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    tier: "standard",
    contextWindow: 200000,
  },
  "anthropic/claude-haiku": {
    inputPer1kTokens: 0.00025,
    outputPer1kTokens: 0.00125,
    tier: "cheap",
    contextWindow: 200000,
    notes: "Fast and cost-effective",
  },
  "anthropic/claude-3-haiku": {
    inputPer1kTokens: 0.00025,
    outputPer1kTokens: 0.00125,
    tier: "cheap",
    contextWindow: 200000,
  },

  // OpenAI models
  "openai/gpt-4o": {
    inputPer1kTokens: 0.005,
    outputPer1kTokens: 0.015,
    tier: "standard",
    contextWindow: 128000,
  },
  "openai/gpt-4o-mini": {
    inputPer1kTokens: 0.00015,
    outputPer1kTokens: 0.0006,
    tier: "cheap",
    contextWindow: 128000,
    notes: "Very cost-effective for simple tasks",
  },
  "openai/gpt-4-turbo": {
    inputPer1kTokens: 0.01,
    outputPer1kTokens: 0.03,
    tier: "expensive",
    contextWindow: 128000,
  },
  "openai/o1": {
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.06,
    tier: "expensive",
    contextWindow: 200000,
    notes: "Reasoning model with extended thinking",
  },
  "openai/o1-mini": {
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.012,
    tier: "standard",
    contextWindow: 128000,
  },
  "openai/o3": {
    inputPer1kTokens: 0.02,
    outputPer1kTokens: 0.08,
    tier: "expensive",
    contextWindow: 200000,
    notes: "Advanced reasoning model",
  },
  "openai/o3-mini": {
    inputPer1kTokens: 0.004,
    outputPer1kTokens: 0.016,
    tier: "standard",
    contextWindow: 128000,
  },

  // Google models
  "google/gemini-2.0-flash": {
    inputPer1kTokens: 0.0001,
    outputPer1kTokens: 0.0004,
    tier: "cheap",
    contextWindow: 1000000,
    notes: "Very large context, low cost",
  },
  "google/gemini-2.0-pro": {
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.005,
    tier: "standard",
    contextWindow: 2000000,
  },
  "google/gemini-1.5-pro": {
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.005,
    tier: "standard",
    contextWindow: 2000000,
  },
  "google/gemini-1.5-flash": {
    inputPer1kTokens: 0.000075,
    outputPer1kTokens: 0.0003,
    tier: "cheap",
    contextWindow: 1000000,
    notes: "Extremely cost-effective",
  },

  // DeepSeek models
  "deepseek/deepseek-r1": {
    inputPer1kTokens: 0.00055,
    outputPer1kTokens: 0.0022,
    tier: "cheap",
    contextWindow: 64000,
    notes: "Reasoning model, very cost-effective",
  },
  "deepseek/deepseek-v3": {
    inputPer1kTokens: 0.00027,
    outputPer1kTokens: 0.0011,
    tier: "cheap",
    contextWindow: 64000,
  },
  "deepseek/deepseek-coder": {
    inputPer1kTokens: 0.00014,
    outputPer1kTokens: 0.00028,
    tier: "cheap",
    contextWindow: 16000,
  },

  // Mistral models
  "mistral/mixtral-8x22b": {
    inputPer1kTokens: 0.002,
    outputPer1kTokens: 0.006,
    tier: "standard",
    contextWindow: 65000,
  },
  "mistral/mistral-large": {
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.009,
    tier: "standard",
    contextWindow: 128000,
  },
  "mistral/mistral-medium": {
    inputPer1kTokens: 0.0027,
    outputPer1kTokens: 0.0081,
    tier: "standard",
    contextWindow: 32000,
  },

  // Meta/Llama models (via providers)
  "meta/llama-3.1-405b": {
    inputPer1kTokens: 0.005,
    outputPer1kTokens: 0.015,
    tier: "standard",
    contextWindow: 128000,
  },
  "meta/llama-3.1-70b": {
    inputPer1kTokens: 0.001,
    outputPer1kTokens: 0.003,
    tier: "cheap",
    contextWindow: 128000,
  },

  // xAI models
  "xai/grok-2": {
    inputPer1kTokens: 0.005,
    outputPer1kTokens: 0.015,
    tier: "standard",
    contextWindow: 131072,
  },
};

/**
 * Cost tier ordering for comparison.
 */
const TIER_ORDER: Record<CostTier, number> = {
  free: 0,
  cheap: 1,
  standard: 2,
  expensive: 3,
};

/**
 * Configuration for cost-aware selection.
 */
export interface CostAwareConfig {
  /** Prefer cheaper models when capabilities match (default: true) */
  preferCheaper?: boolean;
  /** Maximum tier to consider (default: "expensive") */
  maxTier?: CostTier;
  /** Optional daily budget in USD */
  budgetPer24h?: number;
  /** Weight factor for cost vs capability trade-off (0-1, default: 0.5) */
  costWeight?: number;
}

/**
 * Default cost-aware configuration.
 */
export const DEFAULT_COST_AWARE_CONFIG: Required<CostAwareConfig> = {
  preferCheaper: true,
  maxTier: "expensive",
  budgetPer24h: undefined as unknown as number,
  costWeight: 0.5,
};

/**
 * Result of cost-aware model selection.
 */
export interface CostAwareSelection {
  /** Selected model identifier */
  model: string;
  /** Cost information for the model */
  cost: ModelCost;
  /** Human-readable reason for selection */
  reason: string;
  /** Alternative models that were considered */
  alternatives?: Array<{ model: string; cost: ModelCost; reason: string }>;
}

/**
 * Get cost information for a model.
 *
 * @param modelId - Model identifier
 * @returns Cost information or undefined if unknown
 */
export function getModelCost(modelId: string): ModelCost | undefined {
  return MODEL_COSTS[modelId];
}

/**
 * Calculate estimated cost for a request.
 *
 * @param modelId - Model identifier
 * @param inputTokens - Estimated input tokens
 * @param outputTokens - Estimated output tokens
 * @returns Estimated cost in USD or undefined if model unknown
 */
export function estimateRequestCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const cost = MODEL_COSTS[modelId];
  if (!cost) {
    return undefined;
  }

  const inputCost = (inputTokens / 1000) * cost.inputPer1kTokens;
  const outputCost = (outputTokens / 1000) * cost.outputPer1kTokens;

  return inputCost + outputCost;
}

/**
 * Compare two models by cost.
 *
 * @param modelA - First model
 * @param modelB - Second model
 * @returns Negative if A is cheaper, positive if B is cheaper, 0 if equal
 */
export function compareCosts(modelA: string, modelB: string): number {
  const costA = MODEL_COSTS[modelA];
  const costB = MODEL_COSTS[modelB];

  if (!costA && !costB) return 0;
  if (!costA) return 1; // Unknown models sort last
  if (!costB) return -1;

  // Compare by tier first
  const tierDiff = TIER_ORDER[costA.tier] - TIER_ORDER[costB.tier];
  if (tierDiff !== 0) return tierDiff;

  // If same tier, compare by total cost (assuming 1:1 input:output ratio)
  const totalA = costA.inputPer1kTokens + costA.outputPer1kTokens;
  const totalB = costB.inputPer1kTokens + costB.outputPer1kTokens;

  return totalA - totalB;
}

/**
 * Filter models by cost tier.
 *
 * @param models - Model identifiers
 * @param maxTier - Maximum tier to include
 * @returns Filtered model list
 */
export function filterByTier(models: string[], maxTier: CostTier): string[] {
  const maxOrder = TIER_ORDER[maxTier];

  return models.filter((model) => {
    const cost = MODEL_COSTS[model];
    if (!cost) return true; // Include unknown models
    return TIER_ORDER[cost.tier] <= maxOrder;
  });
}

/**
 * Select a model considering cost and capabilities.
 *
 * Selection algorithm:
 * 1. Filter by required capabilities
 * 2. Filter by cost tier
 * 3. Sort by cost (cheapest first if preferCheaper)
 * 4. Return cheapest capable model
 *
 * @param requiredCapabilities - Required model capabilities
 * @param availableModels - List of available model identifiers
 * @param config - Cost-aware configuration
 * @param modelsConfig - Optional model capability overrides
 * @returns Selection result with model and cost
 */
export function selectModelCostAware(
  requiredCapabilities: ModelCapability[],
  availableModels: string[],
  config: CostAwareConfig,
  modelsConfig?: ModelsCapabilityConfig,
): CostAwareSelection {
  const effectiveConfig: Required<CostAwareConfig> = {
    ...DEFAULT_COST_AWARE_CONFIG,
    ...config,
  };

  // Step 1: Filter by capabilities
  let candidates = availableModels.filter((model) =>
    modelHasCapabilities(model, requiredCapabilities, modelsConfig),
  );

  if (candidates.length === 0) {
    // No capable models found - return first available with warning
    const fallback = availableModels[0];
    const fallbackCost = MODEL_COSTS[fallback] ?? {
      inputPer1kTokens: 0,
      outputPer1kTokens: 0,
      tier: "standard" as CostTier,
    };

    costLogger.warn("cost-aware-no-capable-model", {
      requiredCapabilities,
      availableModels,
    });

    return {
      model: fallback,
      cost: fallbackCost,
      reason: `WARNING: No model with capabilities: ${requiredCapabilities.join(", ")}`,
    };
  }

  // Step 2: Filter by cost tier
  if (effectiveConfig.maxTier) {
    const tierFiltered = filterByTier(candidates, effectiveConfig.maxTier);
    if (tierFiltered.length > 0) {
      candidates = tierFiltered;
    }
  }

  // Step 3: Sort by cost
  if (effectiveConfig.preferCheaper) {
    candidates.sort(compareCosts);
  }

  // Step 4: Select best candidate
  const selected = candidates[0];
  const selectedCost = MODEL_COSTS[selected] ?? {
    inputPer1kTokens: 0,
    outputPer1kTokens: 0,
    tier: "standard" as CostTier,
  };

  // Build alternatives list
  const alternatives = candidates.slice(1, 4).map((model) => ({
    model,
    cost: MODEL_COSTS[model] ?? {
      inputPer1kTokens: 0,
      outputPer1kTokens: 0,
      tier: "standard" as CostTier,
    },
    reason: "Alternative option",
  }));

  const reason =
    requiredCapabilities.length > 0
      ? `Cost-optimized for capabilities: ${requiredCapabilities.join(", ")}`
      : `Cost-optimized selection (tier: ${selectedCost.tier})`;

  costLogger.debug("cost-aware-selection", {
    selected,
    tier: selectedCost.tier,
    requiredCapabilities,
    candidateCount: candidates.length,
  });

  return {
    model: selected,
    cost: selectedCost,
    reason,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
  };
}

/**
 * Budget tracker for monitoring daily spend.
 */
export interface BudgetTracker {
  /** Record a model usage for budget tracking */
  recordUsage(modelId: string, inputTokens: number, outputTokens: number): void;
  /** Get remaining budget for today */
  getRemainingBudget(): number | undefined;
  /** Get total spend for today */
  getTodaySpend(): number;
  /** Check if budget allows a request */
  canAfford(modelId: string, estimatedInputTokens: number, estimatedOutputTokens: number): boolean;
  /** Reset daily tracking (called at midnight) */
  resetDaily(): void;
}

/**
 * Create a budget tracker for monitoring spend.
 *
 * @param dailyBudget - Daily budget in USD (undefined = unlimited)
 * @returns BudgetTracker instance
 */
export function createBudgetTracker(dailyBudget?: number): BudgetTracker {
  let todaySpend = 0;
  let lastResetDate = new Date().toDateString();

  const checkReset = (): void => {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
      todaySpend = 0;
      lastResetDate = today;
    }
  };

  return {
    recordUsage(modelId: string, inputTokens: number, outputTokens: number): void {
      checkReset();
      const cost = estimateRequestCost(modelId, inputTokens, outputTokens);
      if (cost !== undefined) {
        todaySpend += cost;
        costLogger.debug("budget-usage-recorded", {
          modelId,
          inputTokens,
          outputTokens,
          cost,
          todaySpend,
        });
      }
    },

    getRemainingBudget(): number | undefined {
      checkReset();
      if (dailyBudget === undefined) {
        return undefined;
      }
      return Math.max(0, dailyBudget - todaySpend);
    },

    getTodaySpend(): number {
      checkReset();
      return todaySpend;
    },

    canAfford(
      modelId: string,
      estimatedInputTokens: number,
      estimatedOutputTokens: number,
    ): boolean {
      checkReset();
      if (dailyBudget === undefined) {
        return true;
      }
      const estimatedCost = estimateRequestCost(
        modelId,
        estimatedInputTokens,
        estimatedOutputTokens,
      );
      if (estimatedCost === undefined) {
        return true; // Unknown model, allow
      }
      return todaySpend + estimatedCost <= dailyBudget;
    },

    resetDaily(): void {
      todaySpend = 0;
      lastResetDate = new Date().toDateString();
    },
  };
}

/**
 * Get all models in a specific cost tier.
 *
 * @param tier - Cost tier to filter by
 * @returns Model identifiers in the specified tier
 */
export function getModelsByTier(tier: CostTier): string[] {
  return Object.entries(MODEL_COSTS)
    .filter(([, cost]) => cost.tier === tier)
    .map(([model]) => model);
}

/**
 * Get a summary of model costs by tier.
 *
 * @returns Summary object with tier information
 */
export function getCostSummary(): Record<
  CostTier,
  { models: string[]; avgInputCost: number; avgOutputCost: number }
> {
  const tiers: CostTier[] = ["free", "cheap", "standard", "expensive"];
  const summary: Record<
    CostTier,
    { models: string[]; avgInputCost: number; avgOutputCost: number }
  > = {} as any;

  for (const tier of tiers) {
    const tierModels = getModelsByTier(tier);
    const costs = tierModels.map((m) => MODEL_COSTS[m]).filter(Boolean);

    summary[tier] = {
      models: tierModels,
      avgInputCost:
        costs.length > 0 ? costs.reduce((sum, c) => sum + c.inputPer1kTokens, 0) / costs.length : 0,
      avgOutputCost:
        costs.length > 0
          ? costs.reduce((sum, c) => sum + c.outputPer1kTokens, 0) / costs.length
          : 0,
    };
  }

  return summary;
}
