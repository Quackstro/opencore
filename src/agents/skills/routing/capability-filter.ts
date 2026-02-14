/**
 * Capability Filter
 *
 * Filters skills based on the current model's capabilities.
 * Skills that require capabilities the model doesn't have are excluded
 * with detailed exclusion information for debugging.
 *
 * @module agents/skills/routing/capability-filter
 */

import type { SkillEntry } from "../types.js";
import type {
  ModelCapability,
  ModelsCapabilityConfig,
  RoutingSkillMetadata,
  SkillExclusion,
} from "./types.js";
import { getModelCapabilities, modelHasCapabilities } from "./model-capabilities.js";

/**
 * Result of capability filtering.
 */
export interface CapabilityFilterResult {
  /** Skills that passed capability requirements */
  eligible: SkillEntry[];
  /** Skills excluded due to missing capabilities */
  excluded: SkillExclusion[];
}

/**
 * Extract routing metadata from a skill entry.
 *
 * @param entry - The skill entry
 * @returns Routing metadata or empty object
 */
function getRoutingMetadata(entry: SkillEntry): RoutingSkillMetadata {
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return {};
  }

  return {
    capabilities: Array.isArray(metadata.capabilities)
      ? (metadata.capabilities as ModelCapability[])
      : undefined,
    preferredModel:
      typeof metadata.preferredModel === "string" ? metadata.preferredModel : undefined,
    fallbackCapabilities: Array.isArray(metadata.fallbackCapabilities)
      ? (metadata.fallbackCapabilities as ModelCapability[][])
      : undefined,
  };
}

/**
 * Check if a model satisfies capability requirements (with fallbacks).
 *
 * @param modelId - The current model ID
 * @param required - Primary required capabilities
 * @param fallbacks - Alternative capability sets (OR logic)
 * @param config - Optional capability config overrides
 * @returns true if the model satisfies requirements
 */
function satisfiesCapabilities(
  modelId: string,
  required: ModelCapability[],
  fallbacks: ModelCapability[][] | undefined,
  config?: ModelsCapabilityConfig,
): boolean {
  // Check primary requirements
  if (modelHasCapabilities(modelId, required, config)) {
    return true;
  }

  // Check fallback capability sets (OR logic)
  if (fallbacks && fallbacks.length > 0) {
    for (const fallbackSet of fallbacks) {
      if (modelHasCapabilities(modelId, fallbackSet, config)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Filter skills by the current model's capabilities.
 *
 * Skills with no capability requirements always pass.
 * Skills with requirements are checked against the model's capabilities.
 * Fallback capability sets are checked with OR logic.
 *
 * @param skills - Array of skill entries to filter
 * @param currentModel - The current model identifier
 * @param config - Optional models capability config for overrides
 * @returns Object with eligible skills and exclusion details
 */
export function filterByCapabilities(
  skills: SkillEntry[],
  currentModel: string,
  config?: ModelsCapabilityConfig,
): CapabilityFilterResult {
  const eligible: SkillEntry[] = [];
  const excluded: SkillExclusion[] = [];

  const modelCaps = getModelCapabilities(currentModel, config);

  for (const skill of skills) {
    const routing = getRoutingMetadata(skill);
    const required = routing.capabilities ?? [];

    // No requirements = always eligible
    if (required.length === 0) {
      eligible.push(skill);
      continue;
    }

    // Check capability satisfaction (with fallbacks)
    if (satisfiesCapabilities(currentModel, required, routing.fallbackCapabilities, config)) {
      eligible.push(skill);
    } else {
      // Calculate which capabilities are missing
      const missing = required.filter((cap) => !modelCaps.includes(cap));

      excluded.push({
        skill: skill.skill.name,
        reason: "missing-capabilities",
        missing,
        hint: routing.preferredModel,
      });
    }
  }

  return { eligible, excluded };
}

/**
 * Get capability exclusions without filtering.
 *
 * Useful for generating warnings without actually removing skills.
 *
 * @param skills - Array of skill entries to check
 * @param currentModel - The current model identifier
 * @param config - Optional models capability config for overrides
 * @returns Array of exclusion details for skills with missing capabilities
 */
export function getCapabilityExclusions(
  skills: SkillEntry[],
  currentModel: string,
  config?: ModelsCapabilityConfig,
): SkillExclusion[] {
  const { excluded } = filterByCapabilities(skills, currentModel, config);
  return excluded;
}

/**
 * Check if a specific skill has capability issues with the current model.
 *
 * @param skill - The skill entry to check
 * @param currentModel - The current model identifier
 * @param config - Optional models capability config for overrides
 * @returns Exclusion info if there are issues, undefined otherwise
 */
export function checkSkillCapabilities(
  skill: SkillEntry,
  currentModel: string,
  config?: ModelsCapabilityConfig,
): SkillExclusion | undefined {
  const { excluded } = filterByCapabilities([skill], currentModel, config);
  return excluded[0];
}
