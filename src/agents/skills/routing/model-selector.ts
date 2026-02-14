/**
 * Model Selector for Skills
 *
 * Selects the most appropriate model for executing a skill based on:
 * - Skill capability requirements
 * - Preferred model declarations
 * - Available models in the config
 * - Current model capabilities
 *
 * Used by sessions_spawn and sub-agent creation to auto-select models
 * that satisfy skill requirements.
 *
 * @module agents/skills/routing/model-selector
 */

import type { OpenClawConfig } from "../../../config/config.js";
import type { SkillEntry } from "../types.js";
import type { ModelCapability, ModelsCapabilityConfig, ThinkingLevel } from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  getModelCapabilities,
  modelHasCapabilities,
  findModelsWithCapabilities,
} from "./model-capabilities.js";

const modelSelectorLogger = createSubsystemLogger("skills-model-selector");

/**
 * Result of model selection for a skill.
 */
export interface ModelSelection {
  /** The selected model identifier (provider/model format) */
  model: string;
  /** Recommended thinking level based on skill requirements */
  thinking?: ThinkingLevel;
  /** Human-readable reason for the selection */
  reason: string;
  /** Whether the selection is optimal (model satisfies all requirements) */
  optimal: boolean;
  /** Missing capabilities if any */
  missingCapabilities?: ModelCapability[];
}

/**
 * Extract capability requirements from a skill entry.
 */
function extractSkillCapabilities(skill: SkillEntry): ModelCapability[] {
  const metadata = skill.metadata as Record<string, unknown> | undefined;
  if (!metadata) return [];

  const capabilities = metadata.capabilities;
  if (!Array.isArray(capabilities)) return [];

  return capabilities.filter((cap): cap is ModelCapability => typeof cap === "string");
}

/**
 * Extract preferred model from a skill entry.
 */
function extractPreferredModel(skill: SkillEntry): string | undefined {
  const metadata = skill.metadata as Record<string, unknown> | undefined;
  if (!metadata) return undefined;

  const preferredModel = metadata.preferredModel;
  return typeof preferredModel === "string" && preferredModel.trim()
    ? preferredModel.trim()
    : undefined;
}

/**
 * Extract minimum thinking budget from a skill entry.
 */
function extractMinThinkingBudget(skill: SkillEntry): ThinkingLevel | undefined {
  const metadata = skill.metadata as Record<string, unknown> | undefined;
  if (!metadata) return undefined;

  const minThinking = metadata.minThinkingBudget;
  if (typeof minThinking !== "string") return undefined;

  const validLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  return validLevels.includes(minThinking as ThinkingLevel)
    ? (minThinking as ThinkingLevel)
    : undefined;
}

/**
 * Get available models from config.
 *
 * Models are extracted from:
 * 1. Model capabilities config (explicit declarations)
 * 2. Auth profiles (configured providers)
 * 3. Known built-in models
 */
export function getAvailableModels(config?: OpenClawConfig): string[] {
  const models = new Set<string>();

  // Add models from capabilities config
  if (config?.models?.capabilities) {
    for (const modelId of Object.keys(config.models.capabilities)) {
      models.add(modelId);
    }
  }

  // Auth profiles are keyed by provider ID and don't contain model references
  // Models come from the model capabilities config and built-in defaults

  // Add common built-in models
  const builtInModels = [
    "anthropic/claude-opus-4",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-haiku",
    "openai/gpt-4o",
    "openai/o1",
    "openai/o3",
    "google/gemini-2.0-flash",
  ];
  for (const model of builtInModels) {
    models.add(model);
  }

  return Array.from(models);
}

/**
 * Select the most appropriate model for executing a skill.
 *
 * Selection priority:
 * 1. Preferred model (if available and capable)
 * 2. Current model (if satisfies requirements)
 * 3. Best alternative from available models
 * 4. Fallback to current model with warning
 *
 * @param skill - The skill entry to select a model for
 * @param availableModels - List of available model identifiers
 * @param currentModel - The currently active model
 * @param config - OpenClaw configuration
 * @returns ModelSelection with the selected model and metadata
 *
 * @example
 * ```typescript
 * const selection = selectModelForSkill(
 *   imageAnalyzerSkill,
 *   getAvailableModels(config),
 *   "anthropic/claude-haiku",
 *   config
 * );
 * // { model: "anthropic/claude-sonnet-4", thinking: "medium", reason: "...", optimal: true }
 * ```
 */
export function selectModelForSkill(
  skill: SkillEntry,
  availableModels: string[],
  currentModel: string,
  config?: OpenClawConfig,
): ModelSelection {
  const requiredCapabilities = extractSkillCapabilities(skill);
  const preferredModel = extractPreferredModel(skill);
  const minThinking = extractMinThinkingBudget(skill);
  // Cast config types to routing types (structurally identical after alignment)
  const modelsConfig: ModelsCapabilityConfig | undefined = config?.models?.capabilities
    ? { capabilities: config.models.capabilities as ModelsCapabilityConfig["capabilities"] }
    : undefined;
  const skillName = skill.skill.name;

  // No capability requirements - use current model
  if (requiredCapabilities.length === 0) {
    modelSelectorLogger.debug("model-selection-no-requirements", {
      skill: skillName,
      model: currentModel,
    });
    return {
      model: currentModel,
      thinking: minThinking,
      reason: "Current model used (no capability requirements)",
      optimal: true,
    };
  }

  // Try preferred model first if available
  if (preferredModel && availableModels.includes(preferredModel)) {
    if (modelHasCapabilities(preferredModel, requiredCapabilities, modelsConfig)) {
      modelSelectorLogger.debug("model-selection-preferred", {
        skill: skillName,
        model: preferredModel,
        capabilities: requiredCapabilities,
      });
      return {
        model: preferredModel,
        thinking: minThinking,
        reason: `Skill preferred model: ${preferredModel}`,
        optimal: true,
      };
    }
    // Preferred model doesn't have capabilities - log but continue
    modelSelectorLogger.debug("model-selection-preferred-lacks-capabilities", {
      skill: skillName,
      preferredModel,
      requiredCapabilities,
    });
  }

  // Check if current model satisfies requirements
  if (modelHasCapabilities(currentModel, requiredCapabilities, modelsConfig)) {
    modelSelectorLogger.debug("model-selection-current-satisfies", {
      skill: skillName,
      model: currentModel,
      capabilities: requiredCapabilities,
    });
    return {
      model: currentModel,
      thinking: minThinking,
      reason: "Current model satisfies requirements",
      optimal: true,
    };
  }

  // Find best alternative from available models
  const capableModels = findModelsWithCapabilities(requiredCapabilities, modelsConfig);
  const availableCapable = capableModels.filter((m) => availableModels.includes(m));

  if (availableCapable.length > 0) {
    // Sort by number of capabilities (prefer more capable models)
    const sorted = availableCapable.sort((a, b) => {
      const aCaps = getModelCapabilities(a, modelsConfig)?.length ?? 0;
      const bCaps = getModelCapabilities(b, modelsConfig)?.length ?? 0;
      return bCaps - aCaps;
    });

    const selected = sorted[0];
    modelSelectorLogger.info("model-selection-auto", {
      skill: skillName,
      model: selected,
      capabilities: requiredCapabilities,
      candidates: sorted.length,
    });
    return {
      model: selected,
      thinking: minThinking,
      reason: `Auto-selected for capabilities: ${requiredCapabilities.join(", ")}`,
      optimal: true,
    };
  }

  // No capable model found - warn and use current model
  const currentCaps = getModelCapabilities(currentModel, modelsConfig) ?? [];
  const missingCaps = requiredCapabilities.filter(
    (cap) => !currentCaps.includes(cap),
  ) as ModelCapability[];

  modelSelectorLogger.warn("model-selection-no-capable-model", {
    skill: skillName,
    model: currentModel,
    requiredCapabilities,
    missingCapabilities: missingCaps,
    hint: preferredModel,
  });

  return {
    model: currentModel,
    thinking: minThinking,
    reason: `WARNING: No model found with capabilities: ${requiredCapabilities.join(", ")}`,
    optimal: false,
    missingCapabilities: missingCaps,
  };
}

/**
 * Select the best model for a set of skills.
 *
 * When multiple skills are involved, this finds a model that satisfies
 * the union of all capability requirements.
 *
 * @param skills - Array of skill entries
 * @param availableModels - List of available model identifiers
 * @param currentModel - The currently active model
 * @param config - OpenClaw configuration
 * @returns ModelSelection with the selected model
 */
export function selectModelForSkills(
  skills: SkillEntry[],
  availableModels: string[],
  currentModel: string,
  config?: OpenClawConfig,
): ModelSelection {
  if (skills.length === 0) {
    return {
      model: currentModel,
      reason: "No skills provided",
      optimal: true,
    };
  }

  if (skills.length === 1) {
    return selectModelForSkill(skills[0], availableModels, currentModel, config);
  }

  // Collect all capability requirements
  const allCapabilities = new Set<ModelCapability>();
  let maxThinking: ThinkingLevel | undefined;
  const thinkingOrder: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  for (const skill of skills) {
    const caps = extractSkillCapabilities(skill);
    caps.forEach((cap) => allCapabilities.add(cap));

    const thinking = extractMinThinkingBudget(skill);
    if (thinking) {
      if (!maxThinking || thinkingOrder.indexOf(thinking) > thinkingOrder.indexOf(maxThinking)) {
        maxThinking = thinking;
      }
    }
  }

  const requiredCapabilities = Array.from(allCapabilities);
  // Cast config types to routing types (structurally identical after alignment)
  const modelsConfig: ModelsCapabilityConfig | undefined = config?.models?.capabilities
    ? { capabilities: config.models.capabilities as ModelsCapabilityConfig["capabilities"] }
    : undefined;

  // No capability requirements - use current model
  if (requiredCapabilities.length === 0) {
    return {
      model: currentModel,
      thinking: maxThinking,
      reason: "Current model used (no capability requirements)",
      optimal: true,
    };
  }

  // Check if current model satisfies all requirements
  if (modelHasCapabilities(currentModel, requiredCapabilities, modelsConfig)) {
    return {
      model: currentModel,
      thinking: maxThinking,
      reason: `Current model satisfies combined requirements: ${requiredCapabilities.join(", ")}`,
      optimal: true,
    };
  }

  // Find model that satisfies all requirements
  const capableModels = findModelsWithCapabilities(requiredCapabilities, modelsConfig);
  const availableCapable = capableModels.filter((m) => availableModels.includes(m));

  if (availableCapable.length > 0) {
    const sorted = availableCapable.sort((a, b) => {
      const aCaps = getModelCapabilities(a, modelsConfig)?.length ?? 0;
      const bCaps = getModelCapabilities(b, modelsConfig)?.length ?? 0;
      return bCaps - aCaps;
    });

    const selected = sorted[0];
    return {
      model: selected,
      thinking: maxThinking,
      reason: `Auto-selected for combined capabilities: ${requiredCapabilities.join(", ")}`,
      optimal: true,
    };
  }

  // Fallback with warning
  const currentCaps = getModelCapabilities(currentModel, modelsConfig) ?? [];
  const missingCaps = requiredCapabilities.filter(
    (cap) => !currentCaps.includes(cap),
  ) as ModelCapability[];

  return {
    model: currentModel,
    thinking: maxThinking,
    reason: `WARNING: No model found with all capabilities: ${requiredCapabilities.join(", ")}`,
    optimal: false,
    missingCapabilities: missingCaps,
  };
}
