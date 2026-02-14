/**
 * Model Capability Registry
 *
 * Maintains a registry of known model capabilities for skill filtering.
 * Allows capability-based skill exclusion when the current model lacks
 * required features (e.g., vision, thinking, code-execution).
 *
 * @module agents/skills/routing/model-capabilities
 */

import type { ModelCapability, ModelCapabilityOverride, ModelsCapabilityConfig } from "./types.js";

/**
 * Known model capabilities.
 *
 * This registry covers commonly used models. Users can extend or override
 * via config.models.capabilities.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability[]> = {
  // Anthropic models
  "anthropic/claude-opus-4": [
    "vision",
    "thinking",
    "long-context",
    "tool-use",
    "streaming",
    "json-mode",
  ],
  "anthropic/claude-sonnet-4": [
    "vision",
    "thinking",
    "long-context",
    "tool-use",
    "streaming",
    "json-mode",
  ],
  "anthropic/claude-3.5-sonnet": ["vision", "long-context", "tool-use", "streaming", "json-mode"],
  "anthropic/claude-3-opus": ["vision", "long-context", "tool-use", "streaming", "json-mode"],
  "anthropic/claude-haiku": ["vision", "tool-use", "streaming", "json-mode"],
  "anthropic/claude-3-haiku": ["vision", "tool-use", "streaming", "json-mode"],

  // OpenAI models
  "openai/gpt-4o": ["vision", "tool-use", "streaming", "json-mode", "multimodal-output"],
  "openai/gpt-4o-mini": ["vision", "tool-use", "streaming", "json-mode"],
  "openai/gpt-4-turbo": ["vision", "long-context", "tool-use", "streaming", "json-mode"],
  "openai/gpt-4": ["tool-use", "streaming", "json-mode"],
  "openai/o1": ["thinking", "long-context"],
  "openai/o1-mini": ["thinking"],
  "openai/o1-preview": ["thinking", "long-context"],
  "openai/o3": ["thinking", "long-context", "tool-use"],
  "openai/o3-mini": ["thinking", "tool-use"],

  // Google models
  "google/gemini-2.0-flash": [
    "vision",
    "long-context",
    "tool-use",
    "streaming",
    "code-execution",
    "web-search",
  ],
  "google/gemini-2.0-pro": [
    "vision",
    "thinking",
    "long-context",
    "tool-use",
    "streaming",
    "code-execution",
  ],
  "google/gemini-1.5-pro": ["vision", "long-context", "tool-use", "streaming", "code-execution"],
  "google/gemini-1.5-flash": ["vision", "long-context", "tool-use", "streaming"],

  // DeepSeek models
  "deepseek/deepseek-r1": ["thinking", "moe", "long-context"],
  "deepseek/deepseek-v3": ["moe", "long-context", "tool-use"],
  "deepseek/deepseek-coder": ["long-context", "tool-use"],

  // Mistral models
  "mistral/mixtral-8x22b": ["moe", "tool-use", "streaming"],
  "mistral/mixtral-8x7b": ["moe", "streaming"],
  "mistral/mistral-large": ["tool-use", "streaming", "json-mode"],
  "mistral/mistral-medium": ["streaming"],

  // Meta models
  "meta/llama-3.1-405b": ["long-context", "tool-use", "streaming"],
  "meta/llama-3.1-70b": ["long-context", "tool-use", "streaming"],
  "meta/llama-3-70b": ["tool-use", "streaming"],

  // xAI models
  "xai/grok-2": ["vision", "tool-use", "streaming"],
  "xai/grok-beta": ["streaming"],
};

/**
 * Cache for resolved model capabilities (after applying config overrides).
 */
const resolvedCapabilitiesCache = new Map<string, ModelCapability[]>();

/**
 * Clear the resolved capabilities cache.
 * Call this if config changes at runtime.
 */
export function clearCapabilitiesCache(): void {
  resolvedCapabilitiesCache.clear();
}

/**
 * Get capabilities for a model, applying any config overrides.
 *
 * @param modelId - The model identifier (e.g., "anthropic/claude-opus-4")
 * @param config - Optional models capability config for overrides
 * @returns Array of capabilities the model supports
 */
export function getModelCapabilities(
  modelId: string,
  config?: ModelsCapabilityConfig,
): ModelCapability[] {
  // Check cache first (without config, use base registry)
  if (!config?.capabilities) {
    return MODEL_CAPABILITIES[modelId] ?? [];
  }

  const cacheKey = `${modelId}:${JSON.stringify(config.capabilities[modelId] ?? "default")}`;
  const cached = resolvedCapabilitiesCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Start with base capabilities
  let capabilities = [...(MODEL_CAPABILITIES[modelId] ?? [])];

  // Apply config overrides
  const override = config.capabilities[modelId];
  if (override) {
    if (Array.isArray(override)) {
      // Direct capability list replacement (cast string[] to ModelCapability[])
      capabilities = [...override] as ModelCapability[];
    } else {
      // Incremental override
      const overrideObj = override as ModelCapabilityOverride;
      if (overrideObj.add) {
        for (const cap of overrideObj.add) {
          // Cast to ModelCapability for type compatibility (runtime strings)
          const capAsModelCapability = cap as ModelCapability;
          if (!capabilities.includes(capAsModelCapability)) {
            capabilities.push(capAsModelCapability);
          }
        }
      }
      if (overrideObj.remove) {
        const removeSet = new Set(overrideObj.remove);
        capabilities = capabilities.filter((cap) => !removeSet.has(cap));
      }
    }
  }

  resolvedCapabilitiesCache.set(cacheKey, capabilities);
  return capabilities;
}

/**
 * Check if a model has a specific capability.
 *
 * @param modelId - The model identifier
 * @param capability - The capability to check
 * @param config - Optional models capability config for overrides
 * @returns true if the model has the capability
 */
export function modelHasCapability(
  modelId: string,
  capability: ModelCapability,
  config?: ModelsCapabilityConfig,
): boolean {
  const caps = getModelCapabilities(modelId, config);
  return caps.includes(capability);
}

/**
 * Check if a model has all required capabilities.
 *
 * @param modelId - The model identifier
 * @param required - Array of required capabilities
 * @param config - Optional models capability config for overrides
 * @returns true if the model has all required capabilities
 */
export function modelHasCapabilities(
  modelId: string,
  required: ModelCapability[],
  config?: ModelsCapabilityConfig,
): boolean {
  if (required.length === 0) {
    return true;
  }
  const caps = getModelCapabilities(modelId, config);
  return required.every((req) => caps.includes(req));
}

/**
 * Get all known model IDs from the registry.
 *
 * @returns Array of model identifiers
 */
export function getKnownModels(): string[] {
  return Object.keys(MODEL_CAPABILITIES);
}

/**
 * Find models that have all specified capabilities.
 *
 * @param required - Array of required capabilities
 * @param config - Optional models capability config for overrides
 * @returns Array of model IDs that satisfy the requirements
 */
export function findModelsWithCapabilities(
  required: ModelCapability[],
  config?: ModelsCapabilityConfig,
): string[] {
  const models = getKnownModels();
  return models.filter((modelId) => modelHasCapabilities(modelId, required, config));
}
