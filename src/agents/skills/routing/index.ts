/**
 * Dynamic Skill Routing Module
 *
 * Context-aware skill selection for optimized prompts.
 * Analyzes conversation content and selectively activates relevant skills.
 *
 * @module agents/skills/routing
 */

// Core types
export type {
  SkillClassifierType,
  SkillRoutingMode,
  LlmClassifierConfig,
  EmbeddingsClassifierConfig,
  DomainTrackingConfig,
  DynamicRoutingConfig,
  HybridRoutingConfig,
  SkillRoutingConfig,
  SkillClassification,
  RoutingContext,
  RoutingResult,
  ModelCapability,
  ModelCapabilityOverride,
  ModelsCapabilityConfig,
  SkillExclusion,
  RoutingSkillMetadata,
  ThinkingLevel,
  ThinkingOverrideMode,
} from "./types.js";

export { DEFAULT_ROUTING_CONFIG } from "./types.js";

// Model capabilities
export {
  MODEL_CAPABILITIES,
  getModelCapabilities,
  modelHasCapability,
  modelHasCapabilities,
  getKnownModels,
  findModelsWithCapabilities,
  clearCapabilitiesCache,
} from "./model-capabilities.js";

// Keywords classifier
export {
  DOMAIN_KEYWORDS,
  detectDomainsFromMessage,
  classifyWithKeywords,
  getCanonicalDomains,
  getDomainKeywords,
} from "./keywords-classifier.js";

// Capability filter
export type { CapabilityFilterResult } from "./capability-filter.js";
export {
  filterByCapabilities,
  getCapabilityExclusions,
  checkSkillCapabilities,
} from "./capability-filter.js";

// Router
export type { ClassifierProviders } from "./router.js";
export {
  routeSkills,
  routeSkillsSync,
  clearRoutingCache,
  setClassifierProviders,
  getClassifierProviders,
  clearClassifierProviders,
} from "./router.js";

// Embeddings classifier
export type { EmbeddingProvider } from "./embeddings-classifier.js";
export {
  classifyWithEmbeddings,
  classifyWithEmbeddingsBatch,
  cosineSimilarity,
  clearEmbeddingCache,
} from "./embeddings-classifier.js";

// LLM classifier
export type { LlmClassifierProvider } from "./llm-classifier.js";
export {
  classifyWithLLM,
  parseLlmResponse,
  createLlmClassifierProvider,
  DEFAULT_CLASSIFIER_MODEL,
} from "./llm-classifier.js";

// Domain tracker
export type { DomainTracker, ActiveDomain } from "./domain-tracker.js";
export {
  createDomainTracker,
  getDomainTracker,
  clearAllDomainTracking,
  DEFAULT_DOMAIN_TRACKING_CONFIG,
} from "./domain-tracker.js";

// Thinking resolver
export type { ThinkingResolution } from "./thinking-resolver.js";
export {
  THINKING_ORDER,
  isValidThinkingLevel,
  isValidThinkingOverrideMode,
  compareLevels,
  maxLevel,
  minLevel,
  resolveThinkingWithSkill,
  resolveThinkingWithSkills,
} from "./thinking-resolver.js";

// Model selector
export type { ModelSelection } from "./model-selector.js";
export { getAvailableModels, selectModelForSkill, selectModelForSkills } from "./model-selector.js";

// Task skill detector
export type { TaskSkillDetection } from "./task-skill-detector.js";
export { detectSkillFromTask, detectBestSkillForTask } from "./task-skill-detector.js";

// ============================================================================
// Batch 2: Enhanced Routing Features
// ============================================================================

// Skill groups
export type { SkillGroup, SkillGroupConfig, GroupExpansionResult } from "./skill-groups.js";
export {
  DEFAULT_SKILL_GROUP_CONFIG,
  SKILL_GROUP_PRESETS,
  expandSkillGroups,
  detectGroupsFromDomains,
  getSkillsFromDomains,
  findGroupsContainingSkill,
  mergeGroupConfigs,
  validateSkillGroup,
  validateSkillGroupConfig,
} from "./skill-groups.js";

// User preferences
export type {
  UserPreference,
  DomainUsageStat,
  DomainUsageStats,
  LearningConfig,
  UserPreferencesStore,
} from "./user-preferences.js";
export {
  DEFAULT_LEARNING_CONFIG,
  createUserPreferencesStore,
  applyUserPreferences,
  getUserDomainInsights,
  resetUserLearning,
} from "./user-preferences.js";

// Cost-aware selector
export type {
  CostTier,
  ModelCost,
  CostAwareConfig,
  CostAwareSelection,
  BudgetTracker,
} from "./cost-aware-selector.js";
export {
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
} from "./cost-aware-selector.js";

// Capability detector
export type {
  CapabilityProbe,
  LlmProvider,
  CapabilityCache,
  ProbeResult,
} from "./capability-detector.js";
export {
  CAPABILITY_PROBES,
  getProbeForCapability,
  createCapabilityCache,
  probeModelCapabilities,
  verifyCapability,
  createMockLlmProvider,
  getProbeableCapabilities,
  describeCapability,
} from "./capability-detector.js";

// Skill chaining
export type {
  DependencySequence,
  SkillDependency,
  DependencyChain,
  CircularDependencyResult,
} from "./skill-chaining.js";
export {
  extractDependencies,
  buildDependencyMap,
  resolveDependencyChain,
  detectCircularDependencies,
  getDependents,
  validateDependencies,
  getExecutionPlan,
  mergeDependencies,
} from "./skill-chaining.js";

// Extended config type
export type { ExtendedRoutingConfig } from "./types.js";
