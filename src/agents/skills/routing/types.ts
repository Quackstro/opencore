/**
 * Dynamic Skill Routing Types
 *
 * Core type definitions for the skill routing system. These types define
 * the configuration, context, classification results, and routing outcomes.
 *
 * @module agents/skills/routing/types
 */

/**
 * Classification method for determining which skills to activate.
 * - keywords: Fast, zero-latency keyword matching (Phase 1)
 * - embeddings: Vector similarity matching (Phase 4+)
 * - llm: LLM-based classification (Phase 4+)
 */
export type SkillClassifierType = "keywords" | "embeddings" | "llm";

/**
 * Routing mode determining how skills are selected.
 * - static: All eligible skills included (default, backwards compatible)
 * - dynamic: Skills filtered by classifier
 * - hybrid: Static below threshold, dynamic above
 */
export type SkillRoutingMode = "static" | "dynamic" | "hybrid";

/**
 * LLM classifier configuration.
 */
export interface LlmClassifierConfig {
  /** Model to use for classification (e.g., "anthropic/claude-haiku") */
  model?: string;
  /** Maximum tokens for classification response */
  maxTokens?: number;
}

/**
 * Embeddings classifier configuration.
 */
export interface EmbeddingsClassifierConfig {
  /** Embedding model to use (e.g., "text-embedding-3-small") */
  model?: string;
  /** Cache skill embeddings across calls (default: true) */
  cacheEmbeddings?: boolean;
}

/**
 * Domain tracking configuration for multi-turn context.
 */
export interface DomainTrackingConfig {
  /** Whether domain tracking is enabled (default: false) */
  enabled?: boolean;
  /** Number of turns until domain weight halves (default: 3) */
  decayTurns?: number;
  /** How much to boost matching domains (multiplier, default: 1.3) */
  boostFactor?: number;
}

/**
 * Dynamic routing mode settings.
 */
export interface DynamicRoutingConfig {
  /** Classification method to use (defaults to "keywords" if not specified) */
  classifier?: SkillClassifierType;
  /** Maximum skills to inject per turn (0 = unlimited) */
  maxSkills?: number;
  /** Minimum confidence score to include a skill (0.0-1.0) */
  minConfidence?: number;
  /** Include skills with alwaysInclude: true regardless of classification */
  respectAlwaysInclude?: boolean;
  /** Cache classification results per-session */
  cachePerSession?: boolean;
  /** LLM classifier settings (when classifier: "llm") */
  llm?: LlmClassifierConfig;
  /** Embeddings classifier settings (when classifier: "embeddings") */
  embeddings?: EmbeddingsClassifierConfig;
  /** Conversation history depth for context-aware routing (default: 5) */
  historyDepth?: number;
  /** Domain tracking configuration for multi-turn context */
  domainTracking?: DomainTrackingConfig;
}

/**
 * Hybrid routing mode settings.
 */
export interface HybridRoutingConfig {
  /** Use static routing when eligible skills <= threshold */
  staticThreshold?: number;
  /** Fall back to dynamic when above threshold */
  dynamicAboveThreshold?: boolean;
}

/**
 * Skill routing configuration.
 */
export interface SkillRoutingConfig {
  /** Routing mode: static (all eligible), dynamic (classified), hybrid (threshold) */
  mode: SkillRoutingMode;
  /** Dynamic mode settings */
  dynamic?: DynamicRoutingConfig;
  /** Hybrid mode settings */
  hybrid?: HybridRoutingConfig;
  /** Domain aliases (map custom terms to canonical domains) */
  domainAliases?: Record<string, string[]>;
}

/**
 * Classification result for a single skill.
 */
export interface SkillClassification {
  /** Name of the skill */
  skillName: string;
  /** Domains the skill belongs to */
  domains: string[];
  /** Confidence score (0.0-1.0) */
  confidence: number;
  /** Optional reason for the classification */
  reason?: string;
}

/**
 * Context for routing decisions.
 */
export interface RoutingContext {
  /** Current user message */
  message: string;
  /** Recent conversation history for context (optional) */
  conversationHistory?: string[];
  /** Session key for caching (optional) */
  sessionKey?: string;
  /** Pre-detected domains from external source (optional) */
  detectedDomains?: string[];
  /** Current model being used (for capability filtering) */
  currentModel?: string;
}

/**
 * Result of the skill routing process.
 */
export interface RoutingResult {
  /** Names of skills selected for this turn */
  selectedSkills: string[];
  /** Classification details for selected skills */
  classifications: SkillClassification[];
  /** Routing method that was used */
  method: SkillRoutingMode;
  /** Whether this result was retrieved from cache */
  cached: boolean;
  /** Skills excluded due to capability requirements (optional) */
  capabilityExclusions?: SkillExclusion[];
  /** Detected domains from the message (optional) */
  detectedDomains?: string[];
}

/**
 * Canonical capability tags for LLM models.
 */
export type ModelCapability =
  | "vision"
  | "thinking"
  | "moe"
  | "long-context"
  | "tool-use"
  | "streaming"
  | "json-mode"
  | "code-execution"
  | "web-search"
  | "multimodal-output";

/**
 * Model capability override configuration.
 * Uses string[] for compatibility with config files (JSON can't express the ModelCapability union).
 */
export interface ModelCapabilityOverride {
  /** Capabilities to add */
  add?: string[];
  /** Capabilities to remove */
  remove?: string[];
}

/**
 * Models configuration section for capability overrides.
 * Uses string[] for compatibility with config files (JSON can't express the ModelCapability union).
 */
export interface ModelsCapabilityConfig {
  /** Per-model capability definitions or overrides */
  capabilities?: Record<string, string[] | ModelCapabilityOverride>;
}

/**
 * Information about a skill excluded due to missing capabilities.
 */
export interface SkillExclusion {
  /** Name of the excluded skill */
  skill: string;
  /** Reason for exclusion */
  reason: "missing-capabilities" | "model-mismatch";
  /** List of missing capabilities */
  missing: string[];
  /** Hint: suggested model that has the capabilities */
  hint?: string;
}

/**
 * Valid thinking levels in order from lowest to highest intensity.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Thinking override mode determining how the skill's level is applied.
 * - minimum: Upgrade if current level is lower
 * - maximum: Cap if current level is higher
 * - exact: Always use skill's level (highest priority)
 * - suggest: Provide hint but don't change level (default)
 */
export type ThinkingOverrideMode = "minimum" | "maximum" | "exact" | "suggest";

/**
 * Extended OpenClaw skill metadata including routing fields.
 * This extends the base OpenClawSkillMetadata with routing-specific fields.
 */
export interface RoutingSkillMetadata {
  /** Domain tags this skill belongs to (e.g., ["coding", "devops"]) */
  domains?: string[];
  /** Weight for ranking within a domain (0.0-1.0, default: 1.0) */
  domainWeight?: number;
  /** If true, skill is always injected regardless of routing */
  alwaysInclude?: boolean;
  /** Required LLM capabilities for this skill */
  capabilities?: ModelCapability[];
  /** Suggested model for sub-agent execution */
  preferredModel?: string;
  /** Minimum thinking level for thinking-capable models (legacy field) */
  minThinkingBudget?: "low" | "medium" | "high";
  /** Alternative capability sets (OR logic) */
  fallbackCapabilities?: ModelCapability[][];
  /** Thinking level override for automatic adjustment */
  thinkingOverride?: ThinkingLevel;
  /** Mode for applying the thinking override (default: "suggest") */
  thinkingOverrideMode?: ThinkingOverrideMode;
}

/**
 * Default routing configuration values.
 */
export const DEFAULT_ROUTING_CONFIG: SkillRoutingConfig = {
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

// ============================================================================
// Batch 2: Enhanced Routing Features
// ============================================================================

/**
 * Skill group definition for bundling related skills.
 * Re-exported from skill-groups module for convenience.
 */
export type { SkillGroup, SkillGroupConfig, GroupExpansionResult } from "./skill-groups.js";

/**
 * User preference types for personalized routing.
 * Re-exported from user-preferences module for convenience.
 */
export type {
  UserPreference,
  UserPreferencesStore,
  LearningConfig,
  DomainUsageStats,
} from "./user-preferences.js";

/**
 * Cost-aware selection types.
 * Re-exported from cost-aware-selector module for convenience.
 */
export type {
  CostTier,
  ModelCost,
  CostAwareConfig,
  CostAwareSelection,
  BudgetTracker,
} from "./cost-aware-selector.js";

/**
 * Capability detection types.
 * Re-exported from capability-detector module for convenience.
 */
export type {
  CapabilityProbe,
  CapabilityCache,
  LlmProvider,
  ProbeResult,
} from "./capability-detector.js";

/**
 * Skill chaining types.
 * Re-exported from skill-chaining module for convenience.
 */
export type {
  SkillDependency,
  DependencySequence,
  DependencyChain,
  CircularDependencyResult,
} from "./skill-chaining.js";

/**
 * Extended routing configuration with Batch 2 features.
 */
export interface ExtendedRoutingConfig extends SkillRoutingConfig {
  /** Skill groups configuration */
  skillGroups?: {
    enabled?: boolean;
    groups?: Array<{
      id: string;
      name: string;
      description?: string;
      skills: string[];
      domains?: string[];
      activationThreshold?: number;
      expandOnSelect?: boolean;
    }>;
    autoExpand?: boolean;
    activateByDomain?: boolean;
  };
  /** User preferences configuration */
  userPreferences?: {
    enabled?: boolean;
    persistPath?: string;
    learning?: {
      enabled?: boolean;
      incrementPerUse?: number;
      maxWeight?: number;
      minWeight?: number;
      decayPerDay?: number;
      decayGracePeriodDays?: number;
    };
  };
  /** Cost-aware selection configuration */
  costAware?: {
    enabled?: boolean;
    preferCheaper?: boolean;
    maxTier?: "free" | "cheap" | "standard" | "expensive";
    budgetPer24h?: number;
    costWeight?: number;
  };
  /** Skill chaining configuration */
  chaining?: {
    enabled?: boolean;
    maxDepth?: number;
    resolveDependencies?: boolean;
  };
}
