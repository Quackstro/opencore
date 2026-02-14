/**
 * Skill Router
 *
 * Main entry point for dynamic skill routing. Routes skills based on
 * conversation context, applying capability filtering and classification.
 *
 * Supports three modes:
 * - static: All eligible skills included (default, backwards compatible)
 * - dynamic: Skills filtered by classifier (keywords, embeddings, llm)
 * - hybrid: Static below threshold, dynamic above
 *
 * @module agents/skills/routing/router
 */

import type { SkillEntry } from "../types.js";
import type {
  ModelsCapabilityConfig,
  RoutingContext,
  RoutingResult,
  RoutingSkillMetadata,
  SkillClassification,
  SkillRoutingConfig,
  ExtendedRoutingConfig,
  DEFAULT_ROUTING_CONFIG,
} from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { filterByCapabilities } from "./capability-filter.js";
import { getDomainTracker } from "./domain-tracker.js";
import { classifyWithEmbeddings, type EmbeddingProvider } from "./embeddings-classifier.js";
import { classifyWithKeywords, detectDomainsFromMessage } from "./keywords-classifier.js";
import { classifyWithLLM, type LlmClassifierProvider } from "./llm-classifier.js";
// Batch 2 imports
import {
  expandSkillGroups,
  detectGroupsFromDomains,
  type SkillGroupConfig,
} from "./skill-groups.js";
import { applyUserPreferences, type UserPreferencesStore } from "./user-preferences.js";

/**
 * External providers for classifiers.
 * Set these before using embeddings or LLM classifiers.
 */
export interface ClassifierProviders {
  embedding?: EmbeddingProvider;
  llm?: LlmClassifierProvider;
}

let classifierProviders: ClassifierProviders = {};

/**
 * Set the classifier providers for embeddings and LLM classifiers.
 */
export function setClassifierProviders(providers: ClassifierProviders): void {
  classifierProviders = providers;
}

/**
 * Get the current classifier providers.
 */
export function getClassifierProviders(): ClassifierProviders {
  return classifierProviders;
}

/**
 * Clear classifier providers. Useful for testing.
 */
export function clearClassifierProviders(): void {
  classifierProviders = {};
}

/**
 * Hook callback for skill:filter events.
 * Allows plugins to override routing decisions by modifying the selectedSkills array.
 */
export type SkillFilterHookCallback = (params: {
  eligibleSkills: SkillEntry[];
  routingContext: RoutingContext;
  routingResult: RoutingResult;
  selectedSkills: string[];
}) => Promise<string[]> | string[];

const routingLogger = createSubsystemLogger("skills-routing");

/**
 * Simple in-memory cache for routing results.
 * Keyed by session + message hash.
 */
const routingCache = new Map<string, RoutingResult>();
const CACHE_MAX_SIZE = 100;

/**
 * Clear the routing cache.
 */
export function clearRoutingCache(): void {
  routingCache.clear();
}

/**
 * Generate a cache key for a routing context.
 */
function getCacheKey(context: RoutingContext): string {
  const sessionPart = context.sessionKey ?? "global";
  // Simple hash of the message
  let hash = 0;
  for (let i = 0; i < context.message.length; i++) {
    const char = context.message.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `${sessionPart}:${hash}`;
}

/**
 * Extract routing metadata from a skill entry.
 */
function getRoutingMetadata(entry: SkillEntry): RoutingSkillMetadata {
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return {};
  }
  return {
    domains: Array.isArray(metadata.domains) ? (metadata.domains as string[]) : undefined,
    alwaysInclude: typeof metadata.alwaysInclude === "boolean" ? metadata.alwaysInclude : undefined,
  };
}

/**
 * Get default routing config values merged with provided config.
 */
function getEffectiveConfig(config?: SkillRoutingConfig): SkillRoutingConfig {
  const defaults: SkillRoutingConfig = {
    mode: "static",
    dynamic: {
      classifier: "keywords",
      maxSkills: 0,
      minConfidence: 0.3,
      respectAlwaysInclude: true,
      cachePerSession: true,
    },
    hybrid: {
      staticThreshold: 5,
      dynamicAboveThreshold: true,
    },
  };

  if (!config) {
    return defaults;
  }

  return {
    mode: config.mode ?? defaults.mode,
    dynamic: {
      ...defaults.dynamic,
      ...config.dynamic,
    },
    hybrid: {
      ...defaults.hybrid,
      ...config.hybrid,
    },
    domainAliases: config.domainAliases,
  };
}

/**
 * Route skills based on context and configuration.
 *
 * This is the main entry point for dynamic skill routing. It:
 * 1. Applies capability filtering based on the current model
 * 2. Applies routing mode logic (static/dynamic/hybrid)
 * 3. Classifies skills and filters by confidence
 * 4. Caches results if enabled
 *
 * @param eligibleSkills - Skills that passed basic eligibility checks
 * @param context - Routing context (message, session, model)
 * @param config - Routing configuration
 * @param modelsConfig - Optional model capability config
 * @returns Routing result with selected skills and metadata
 */
export async function routeSkills(
  eligibleSkills: SkillEntry[],
  context: RoutingContext,
  config?: SkillRoutingConfig,
  modelsConfig?: ModelsCapabilityConfig,
): Promise<RoutingResult> {
  const startTime = Date.now();
  const effectiveConfig = getEffectiveConfig(config);
  const mode = effectiveConfig.mode;

  // Step 1: Capability filtering (if model is provided)
  let workingSkills = eligibleSkills;
  let capabilityExclusions: RoutingResult["capabilityExclusions"];

  if (context.currentModel) {
    const capResult = filterByCapabilities(workingSkills, context.currentModel, modelsConfig);
    workingSkills = capResult.eligible;
    if (capResult.excluded.length > 0) {
      capabilityExclusions = capResult.excluded;
      routingLogger.debug("capability-filter-applied", {
        excluded: capResult.excluded.length,
        remaining: workingSkills.length,
      });
    }
  }

  // Step 2: Check cache (if caching is enabled)
  if (effectiveConfig.dynamic?.cachePerSession && context.sessionKey) {
    const cacheKey = getCacheKey(context);
    const cached = routingCache.get(cacheKey);
    if (cached) {
      routingLogger.debug("routing-cache-hit", { cacheKey });
      return {
        ...cached,
        cached: true,
        capabilityExclusions,
      };
    }
  }

  // Step 3: Apply routing mode
  let result: RoutingResult;

  if (mode === "static") {
    // Static mode: return all eligible skills
    result = {
      selectedSkills: workingSkills.map((s) => s.skill.name),
      classifications: [],
      method: "static",
      cached: false,
      capabilityExclusions,
    };
  } else if (mode === "hybrid") {
    // Hybrid mode: check threshold
    const threshold = effectiveConfig.hybrid?.staticThreshold ?? 5;
    if (workingSkills.length <= threshold) {
      result = {
        selectedSkills: workingSkills.map((s) => s.skill.name),
        classifications: [],
        method: "hybrid",
        cached: false,
        capabilityExclusions,
      };
    } else {
      // Fall through to dynamic classification
      result = await classifyAndFilter(
        workingSkills,
        context,
        effectiveConfig,
        capabilityExclusions,
      );
      result.method = "hybrid";
    }
  } else {
    // Dynamic mode: full classification
    result = await classifyAndFilter(workingSkills, context, effectiveConfig, capabilityExclusions);
  }

  // Step 4: Cache result
  if (effectiveConfig.dynamic?.cachePerSession && context.sessionKey) {
    const cacheKey = getCacheKey(context);
    routingCache.set(cacheKey, result);
    // Evict old entries if cache is too large
    if (routingCache.size > CACHE_MAX_SIZE) {
      const firstKey = routingCache.keys().next().value;
      if (firstKey) {
        routingCache.delete(firstKey);
      }
    }
  }

  // Step 5: Log routing decision
  const latencyMs = Date.now() - startTime;
  routingLogger.info("skill-routing-complete", {
    mode: result.method,
    classifier: effectiveConfig.dynamic?.classifier,
    eligible: eligibleSkills.length,
    selected: result.selectedSkills.length,
    capabilityExcluded: capabilityExclusions?.length ?? 0,
    latencyMs,
  });

  return result;
}

/**
 * Build contextual message including conversation history.
 *
 * @param context - Routing context
 * @param historyDepth - How many history messages to include
 * @returns Message with context prepended
 */
function buildContextualMessage(context: RoutingContext, historyDepth: number): string {
  const history = context.conversationHistory ?? [];
  const recent = history.slice(-historyDepth);

  if (recent.length === 0) {
    return context.message;
  }

  return [...recent, context.message].join("\n\n");
}

/**
 * Classify skills and filter by confidence.
 *
 * @param skills - Skills to classify
 * @param context - Routing context
 * @param config - Effective routing config
 * @param capabilityExclusions - Previously excluded skills
 * @returns Routing result
 */
async function classifyAndFilter(
  skills: SkillEntry[],
  context: RoutingContext,
  config: SkillRoutingConfig,
  capabilityExclusions?: RoutingResult["capabilityExclusions"],
): Promise<RoutingResult> {
  const classifier = config.dynamic?.classifier ?? "keywords";
  const historyDepth = config.dynamic?.historyDepth ?? 5;
  let classifications: SkillClassification[];

  // Detect domains first for context
  const detectedDomains = detectDomainsFromMessage(context.message, config);

  // Build context-aware message for classifiers that support it
  const contextualMessage = buildContextualMessage(context, historyDepth);
  const contextWithHistory: RoutingContext = {
    ...context,
    message: contextualMessage,
  };

  switch (classifier) {
    case "embeddings":
      if (classifierProviders.embedding) {
        try {
          classifications = await classifyWithEmbeddings(
            contextWithHistory,
            skills,
            config,
            classifierProviders.embedding,
          );
          routingLogger.debug("embeddings-classifier-used", {
            skillCount: skills.length,
          });
        } catch (err) {
          routingLogger.warn("embeddings-classifier-failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall back to keywords
          classifications = classifyWithKeywords(context, skills, config);
        }
      } else {
        routingLogger.debug("embeddings-provider-not-configured", {});
        classifications = classifyWithKeywords(context, skills, config);
      }
      break;
    case "llm":
      if (classifierProviders.llm) {
        try {
          classifications = await classifyWithLLM(
            contextWithHistory,
            skills,
            config,
            classifierProviders.llm,
          );
          routingLogger.debug("llm-classifier-used", {
            skillCount: skills.length,
          });
        } catch (err) {
          routingLogger.warn("llm-classifier-failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall back to keywords
          classifications = classifyWithKeywords(context, skills, config);
        }
      } else {
        routingLogger.debug("llm-provider-not-configured", {});
        classifications = classifyWithKeywords(context, skills, config);
      }
      break;
    case "keywords":
    default:
      classifications = classifyWithKeywords(context, skills, config);
  }

  // Apply domain tracking boost if enabled
  const domainTrackingConfig = config.dynamic?.domainTracking;
  if (domainTrackingConfig?.enabled && context.sessionKey) {
    const tracker = getDomainTracker();
    classifications = tracker.applyBoost(context.sessionKey, classifications, domainTrackingConfig);

    // Record domains from this turn for future boosts
    const selectedDomains = classifications
      .filter((c) => c.confidence >= (config.dynamic?.minConfidence ?? 0.3))
      .flatMap((c) => c.domains.map((d) => ({ domain: d, weight: c.confidence })));

    if (selectedDomains.length > 0) {
      tracker.recordDomains(context.sessionKey, selectedDomains);
    }
  }

  // Apply confidence filter
  const minConfidence = config.dynamic?.minConfidence ?? 0.3;
  let selected = classifications.filter((c) => c.confidence >= minConfidence);

  // Apply max skills limit
  const maxSkills = config.dynamic?.maxSkills ?? 0;
  if (maxSkills > 0 && selected.length > maxSkills) {
    selected = selected.slice(0, maxSkills);
  }

  // Add alwaysInclude skills that didn't make the cut
  if (config.dynamic?.respectAlwaysInclude !== false) {
    const selectedNames = new Set(selected.map((s) => s.skillName));
    for (const skill of skills) {
      const routing = getRoutingMetadata(skill);
      if (routing.alwaysInclude && !selectedNames.has(skill.skill.name)) {
        selected.push({
          skillName: skill.skill.name,
          domains: routing.domains ?? [],
          confidence: 1.0,
          reason: "alwaysInclude flag",
        });
      }
    }
  }

  return {
    selectedSkills: selected.map((s) => s.skillName),
    classifications: selected,
    method: "dynamic",
    cached: false,
    capabilityExclusions,
    detectedDomains: Array.from(detectedDomains),
  };
}

/**
 * Synchronous version of routeSkills for contexts where async is not available.
 * Only supports keywords classifier.
 *
 * @param eligibleSkills - Skills that passed basic eligibility checks
 * @param context - Routing context
 * @param config - Routing configuration
 * @param modelsConfig - Optional model capability config
 * @returns Routing result
 */
export function routeSkillsSync(
  eligibleSkills: SkillEntry[],
  context: RoutingContext,
  config?: SkillRoutingConfig,
  modelsConfig?: ModelsCapabilityConfig,
): RoutingResult {
  const effectiveConfig = getEffectiveConfig(config);

  // Capability filtering
  let workingSkills = eligibleSkills;
  let capabilityExclusions: RoutingResult["capabilityExclusions"];

  if (context.currentModel) {
    const capResult = filterByCapabilities(workingSkills, context.currentModel, modelsConfig);
    workingSkills = capResult.eligible;
    if (capResult.excluded.length > 0) {
      capabilityExclusions = capResult.excluded;
    }
  }

  // Static mode
  if (effectiveConfig.mode === "static") {
    return {
      selectedSkills: workingSkills.map((s) => s.skill.name),
      classifications: [],
      method: "static",
      cached: false,
      capabilityExclusions,
    };
  }

  // Hybrid threshold check
  if (effectiveConfig.mode === "hybrid") {
    const threshold = effectiveConfig.hybrid?.staticThreshold ?? 5;
    if (workingSkills.length <= threshold) {
      return {
        selectedSkills: workingSkills.map((s) => s.skill.name),
        classifications: [],
        method: "hybrid",
        cached: false,
        capabilityExclusions,
      };
    }
  }

  // Dynamic classification (keywords only in sync mode)
  const detectedDomains = detectDomainsFromMessage(context.message, effectiveConfig);
  const classifications = classifyWithKeywords(context, workingSkills, effectiveConfig);

  const minConfidence = effectiveConfig.dynamic?.minConfidence ?? 0.3;
  let selected = classifications.filter((c) => c.confidence >= minConfidence);

  const maxSkills = effectiveConfig.dynamic?.maxSkills ?? 0;
  if (maxSkills > 0 && selected.length > maxSkills) {
    selected = selected.slice(0, maxSkills);
  }

  // Add alwaysInclude skills
  if (effectiveConfig.dynamic?.respectAlwaysInclude !== false) {
    const selectedNames = new Set(selected.map((s) => s.skillName));
    for (const skill of workingSkills) {
      const routing = getRoutingMetadata(skill);
      if (routing.alwaysInclude && !selectedNames.has(skill.skill.name)) {
        selected.push({
          skillName: skill.skill.name,
          domains: routing.domains ?? [],
          confidence: 1.0,
          reason: "alwaysInclude flag",
        });
      }
    }
  }

  return {
    selectedSkills: selected.map((s) => s.skillName),
    classifications: selected,
    method: effectiveConfig.mode === "hybrid" ? "hybrid" : "dynamic",
    cached: false,
    capabilityExclusions,
    detectedDomains: Array.from(detectedDomains),
  };
}

// ============================================================================
// Batch 2: Enhanced Routing with Skill Groups and User Preferences
// ============================================================================

/**
 * Optional providers for enhanced routing features.
 */
export interface EnhancedRoutingProviders {
  /** User preferences store for personalized routing */
  userPreferences?: UserPreferencesStore;
}

let enhancedProviders: EnhancedRoutingProviders = {};

/**
 * Set enhanced routing providers.
 */
export function setEnhancedRoutingProviders(providers: EnhancedRoutingProviders): void {
  enhancedProviders = { ...enhancedProviders, ...providers };
}

/**
 * Get the current enhanced routing providers.
 */
export function getEnhancedRoutingProviders(): EnhancedRoutingProviders {
  return enhancedProviders;
}

/**
 * Clear enhanced routing providers. Useful for testing.
 */
export function clearEnhancedRoutingProviders(): void {
  enhancedProviders = {};
}

/**
 * Enhanced routing result with additional metadata.
 */
export interface EnhancedRoutingResult extends RoutingResult {
  /** Skills added by skill group expansion */
  groupExpandedSkills?: string[];
  /** Skill groups that were activated */
  activatedGroups?: string[];
  /** Whether user preferences were applied */
  userPreferencesApplied?: boolean;
}

/**
 * Route skills with enhanced Batch 2 features.
 *
 * Extends the base routing with:
 * - Skill group expansion
 * - User preference-based weight adjustments
 * - Domain-triggered group activation
 *
 * @param eligibleSkills - Skills that passed basic eligibility checks
 * @param context - Routing context with optional userId
 * @param config - Extended routing configuration
 * @param modelsConfig - Optional model capability config
 * @returns Enhanced routing result
 */
export async function routeSkillsEnhanced(
  eligibleSkills: SkillEntry[],
  context: RoutingContext & { userId?: string },
  config?: ExtendedRoutingConfig,
  modelsConfig?: ModelsCapabilityConfig,
): Promise<EnhancedRoutingResult> {
  // First, run base routing
  const baseResult = await routeSkills(eligibleSkills, context, config, modelsConfig);

  let enhancedResult: EnhancedRoutingResult = {
    ...baseResult,
  };

  // Apply skill group expansion if enabled
  if (config?.skillGroups?.enabled && config.skillGroups.groups) {
    const groupConfig: SkillGroupConfig = {
      enabled: true,
      groups: config.skillGroups.groups,
      autoExpand: config.skillGroups.autoExpand ?? true,
      activateByDomain: config.skillGroups.activateByDomain ?? true,
    };

    // Expand based on selected skills
    const expansion = expandSkillGroups(
      enhancedResult.selectedSkills,
      groupConfig.groups,
      groupConfig,
    );

    if (expansion.addedSkills.length > 0) {
      enhancedResult.selectedSkills = expansion.skills;
      enhancedResult.groupExpandedSkills = expansion.addedSkills;
      enhancedResult.activatedGroups = expansion.expandedGroups;

      routingLogger.debug("skill-groups-expanded", {
        added: expansion.addedSkills,
        groups: expansion.expandedGroups,
      });
    }

    // Also check for domain-triggered groups
    if (groupConfig.activateByDomain && enhancedResult.detectedDomains) {
      const domainGroups = detectGroupsFromDomains(
        enhancedResult.detectedDomains,
        groupConfig.groups,
      );

      for (const group of domainGroups) {
        for (const skill of group.skills) {
          if (!enhancedResult.selectedSkills.includes(skill)) {
            enhancedResult.selectedSkills.push(skill);
            enhancedResult.groupExpandedSkills = enhancedResult.groupExpandedSkills ?? [];
            enhancedResult.groupExpandedSkills.push(skill);
          }
        }
        if (!enhancedResult.activatedGroups?.includes(group.id)) {
          enhancedResult.activatedGroups = enhancedResult.activatedGroups ?? [];
          enhancedResult.activatedGroups.push(group.id);
        }
      }
    }
  }

  // Apply user preferences if enabled and userId is provided
  if (config?.userPreferences?.enabled && context.userId && enhancedProviders.userPreferences) {
    const adjustedClassifications = applyUserPreferences(
      enhancedResult.classifications,
      context.userId,
      enhancedProviders.userPreferences,
    );

    // Re-filter based on adjusted confidences
    const minConfidence = config.dynamic?.minConfidence ?? 0.3;
    const filtered = adjustedClassifications.filter((c) => c.confidence >= minConfidence);

    enhancedResult.classifications = filtered;
    enhancedResult.selectedSkills = filtered.map((c) => c.skillName);
    enhancedResult.userPreferencesApplied = true;

    routingLogger.debug("user-preferences-applied", {
      userId: context.userId,
      adjustedCount: filtered.length,
    });
  }

  return enhancedResult;
}

/**
 * Record skill usage for learning.
 *
 * Call this when skills are actually invoked to improve future routing.
 *
 * @param userId - User identifier
 * @param usedSkills - Skills that were used
 * @param domains - Domains associated with the usage
 */
export function recordSkillUsage(userId: string, usedSkills: string[], domains: string[]): void {
  if (enhancedProviders.userPreferences) {
    enhancedProviders.userPreferences.learnFromUsage(userId, usedSkills, domains);
  }
}
