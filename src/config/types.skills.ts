export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

/**
 * LLM classifier configuration for dynamic routing.
 */
export type SkillRoutingLlmConfig = {
  /** Model to use for classification (e.g., "anthropic/claude-haiku") */
  model?: string;
  /** Maximum tokens for classification response */
  maxTokens?: number;
};

/**
 * Embeddings classifier configuration for dynamic routing.
 */
export type SkillRoutingEmbeddingsConfig = {
  /** Embedding model to use (e.g., "text-embedding-3-small") */
  model?: string;
  /** Cache skill embeddings across calls (default: true) */
  cacheEmbeddings?: boolean;
};

/**
 * Domain tracking configuration for multi-turn context awareness.
 */
export type SkillRoutingDomainTrackingConfig = {
  /** Whether domain tracking is enabled (default: false) */
  enabled?: boolean;
  /** Number of turns until domain weight halves (default: 3) */
  decayTurns?: number;
  /** How much to boost matching domains (multiplier, default: 1.3) */
  boostFactor?: number;
};

/**
 * Dynamic routing mode settings.
 */
export type SkillRoutingDynamicConfig = {
  /** Classification method: keywords, embeddings, or llm */
  classifier?: "keywords" | "embeddings" | "llm";
  /** Maximum skills to inject per turn (0 = unlimited) */
  maxSkills?: number;
  /** Minimum confidence score to include a skill (0.0-1.0) */
  minConfidence?: number;
  /** Include skills with alwaysInclude: true regardless of classification */
  respectAlwaysInclude?: boolean;
  /** Cache classification results per-session */
  cachePerSession?: boolean;
  /** LLM classifier settings */
  llm?: SkillRoutingLlmConfig;
  /** Embeddings classifier settings */
  embeddings?: SkillRoutingEmbeddingsConfig;
  /** Conversation history depth for context-aware routing (default: 5) */
  historyDepth?: number;
  /** Domain tracking configuration for multi-turn context */
  domainTracking?: SkillRoutingDomainTrackingConfig;
};

/**
 * Hybrid routing mode settings.
 */
export type SkillRoutingHybridConfig = {
  /** Use static routing when eligible skills <= threshold */
  staticThreshold?: number;
  /** Fall back to dynamic when above threshold */
  dynamicAboveThreshold?: boolean;
};

/**
 * Skill routing configuration for dynamic skill selection.
 */
export type SkillRoutingConfig = {
  /** Routing mode: static (all eligible), dynamic (classified), hybrid (threshold) */
  mode?: "static" | "dynamic" | "hybrid";
  /** Dynamic mode settings */
  dynamic?: SkillRoutingDynamicConfig;
  /** Hybrid mode settings */
  hybrid?: SkillRoutingHybridConfig;
  /** Domain aliases (map custom terms to canonical domains) */
  domainAliases?: Record<string, string[]>;
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  /** Dynamic skill routing configuration */
  routing?: SkillRoutingConfig;
  entries?: Record<string, SkillConfig>;
};
