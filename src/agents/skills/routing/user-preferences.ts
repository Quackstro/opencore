/**
 * User Preferences for Skill Routing
 *
 * Per-user domain preferences that bias skill routing decisions.
 * Includes learning from usage patterns to automatically adjust weights.
 *
 * @module agents/skills/routing/user-preferences
 */

import * as fs from "fs";
import * as path from "path";
import type { SkillClassification } from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const prefsLogger = createSubsystemLogger("skills-user-prefs");

/**
 * User preference data structure.
 */
export interface UserPreference {
  /** User identifier */
  userId: string;
  /** Domain weight multipliers (domain -> weight) */
  domainWeights: Record<string, number>;
  /** Skills that always get boosted */
  preferredSkills?: string[];
  /** Skills that are never included */
  excludedSkills?: string[];
  /** Last time preferences were updated (epoch ms) */
  lastUpdated: number;
  /** Usage statistics for learning */
  usageStats?: DomainUsageStats;
}

/**
 * Usage statistics for a domain.
 */
export interface DomainUsageStat {
  /** Domain name */
  domain: string;
  /** Number of times skills in this domain were invoked */
  invocations: number;
  /** Last time this domain was used (epoch ms) */
  lastUsed: number;
  /** Skills in this domain that were used */
  usedSkills: string[];
}

/**
 * Aggregated usage statistics.
 */
export interface DomainUsageStats {
  /** Per-domain statistics */
  domains: Record<string, DomainUsageStat>;
  /** Total invocations across all domains */
  totalInvocations: number;
  /** Last learning update timestamp */
  lastLearningUpdate: number;
}

/**
 * Learning algorithm configuration.
 */
export interface LearningConfig {
  /** Enable learning from usage (default: true) */
  enabled?: boolean;
  /** How much each invocation increases domain weight (default: 0.1) */
  incrementPerUse?: number;
  /** Maximum weight a domain can reach (default: 2.0) */
  maxWeight?: number;
  /** Minimum weight floor (default: 0.5) */
  minWeight?: number;
  /** Decay rate per day for unused domains (default: 0.05) */
  decayPerDay?: number;
  /** Days without use before decay starts (default: 7) */
  decayGracePeriodDays?: number;
}

/**
 * Default learning configuration.
 */
export const DEFAULT_LEARNING_CONFIG: Required<LearningConfig> = {
  enabled: true,
  incrementPerUse: 0.1,
  maxWeight: 2.0,
  minWeight: 0.5,
  decayPerDay: 0.05,
  decayGracePeriodDays: 7,
};

/**
 * Interface for user preferences storage.
 */
export interface UserPreferencesStore {
  /**
   * Get preferences for a user.
   * @param userId - User identifier
   * @returns User preferences or undefined if not set
   */
  get(userId: string): UserPreference | undefined;

  /**
   * Set preferences for a user.
   * @param userId - User identifier
   * @param prefs - Partial preferences to merge
   */
  set(userId: string, prefs: Partial<UserPreference>): void;

  /**
   * Learn from actual skill usage.
   * Called when skills are invoked to adjust weights.
   * @param userId - User identifier
   * @param usedSkills - Skills that were actually used
   * @param domains - Domains associated with the usage
   */
  learnFromUsage(userId: string, usedSkills: string[], domains: string[]): void;

  /**
   * Apply decay to all users based on time since last use.
   */
  applyDecay(): void;

  /**
   * List all user IDs with preferences.
   */
  listUsers(): string[];

  /**
   * Delete preferences for a user.
   */
  delete(userId: string): void;

  /**
   * Persist to disk (if configured).
   */
  save(): void;
}

/**
 * Create a user preferences store.
 *
 * @param persistPath - Optional file path for persistence
 * @param learningConfig - Learning algorithm configuration
 * @returns UserPreferencesStore instance
 */
export function createUserPreferencesStore(
  persistPath?: string,
  learningConfig?: LearningConfig,
): UserPreferencesStore {
  const config: Required<LearningConfig> = {
    ...DEFAULT_LEARNING_CONFIG,
    ...learningConfig,
  };

  // In-memory storage
  const preferences = new Map<string, UserPreference>();

  // Load from disk if path provided
  if (persistPath) {
    try {
      if (fs.existsSync(persistPath)) {
        const data = fs.readFileSync(persistPath, "utf-8");
        const parsed = JSON.parse(data) as Record<string, UserPreference>;
        for (const [userId, pref] of Object.entries(parsed)) {
          preferences.set(userId, pref);
        }
        prefsLogger.debug("user-preferences-loaded", {
          path: persistPath,
          userCount: preferences.size,
        });
      }
    } catch (err) {
      prefsLogger.warn("user-preferences-load-failed", {
        path: persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const save = (): void => {
    if (!persistPath) return;

    try {
      const dir = path.dirname(persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, UserPreference> = {};
      for (const [userId, pref] of preferences) {
        data[userId] = pref;
      }
      fs.writeFileSync(persistPath, JSON.stringify(data, null, 2), "utf-8");

      prefsLogger.debug("user-preferences-saved", {
        path: persistPath,
        userCount: preferences.size,
      });
    } catch (err) {
      prefsLogger.warn("user-preferences-save-failed", {
        path: persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    get(userId: string): UserPreference | undefined {
      return preferences.get(userId);
    },

    set(userId: string, prefs: Partial<UserPreference>): void {
      const existing = preferences.get(userId);
      const updated: UserPreference = {
        userId,
        domainWeights: existing?.domainWeights ?? {},
        preferredSkills: existing?.preferredSkills,
        excludedSkills: existing?.excludedSkills,
        lastUpdated: Date.now(),
        usageStats: existing?.usageStats,
        ...prefs,
      };

      // Merge domain weights (unless explicitly reset to empty object)
      if (
        prefs.domainWeights &&
        existing?.domainWeights &&
        Object.keys(prefs.domainWeights).length > 0
      ) {
        updated.domainWeights = {
          ...existing.domainWeights,
          ...prefs.domainWeights,
        };
      }

      preferences.set(userId, updated);
      save();

      prefsLogger.debug("user-preferences-set", {
        userId,
        domains: Object.keys(updated.domainWeights).length,
        preferredSkills: updated.preferredSkills?.length ?? 0,
        excludedSkills: updated.excludedSkills?.length ?? 0,
      });
    },

    learnFromUsage(userId: string, usedSkills: string[], domains: string[]): void {
      if (!config.enabled || (usedSkills.length === 0 && domains.length === 0)) {
        return;
      }

      const existing = preferences.get(userId);
      const pref: UserPreference = existing ?? {
        userId,
        domainWeights: {},
        lastUpdated: Date.now(),
      };

      // Initialize usage stats if needed
      if (!pref.usageStats) {
        pref.usageStats = {
          domains: {},
          totalInvocations: 0,
          lastLearningUpdate: Date.now(),
        };
      }

      const now = Date.now();
      const stats = pref.usageStats;

      // Update domain statistics and weights
      for (const domain of domains) {
        const domainLower = domain.toLowerCase();

        // Update stats
        if (!stats.domains[domainLower]) {
          stats.domains[domainLower] = {
            domain: domainLower,
            invocations: 0,
            lastUsed: now,
            usedSkills: [],
          };
        }
        const domainStat = stats.domains[domainLower];
        domainStat.invocations++;
        domainStat.lastUsed = now;

        // Track which skills were used in this domain
        for (const skill of usedSkills) {
          if (!domainStat.usedSkills.includes(skill)) {
            domainStat.usedSkills.push(skill);
          }
        }

        // Increase domain weight
        const currentWeight = pref.domainWeights[domainLower] ?? 1.0;
        const newWeight = Math.min(config.maxWeight, currentWeight + config.incrementPerUse);
        pref.domainWeights[domainLower] = newWeight;
      }

      stats.totalInvocations++;
      stats.lastLearningUpdate = now;
      pref.lastUpdated = now;

      preferences.set(userId, pref);
      save();

      prefsLogger.debug("user-preferences-learned", {
        userId,
        domains,
        usedSkills,
        totalInvocations: stats.totalInvocations,
      });
    },

    applyDecay(): void {
      if (!config.enabled || config.decayPerDay <= 0) {
        return;
      }

      const now = Date.now();
      const msPerDay = 24 * 60 * 60 * 1000;
      const gracePeriodMs = config.decayGracePeriodDays * msPerDay;
      let decayedCount = 0;

      for (const [userId, pref] of preferences) {
        let modified = false;

        for (const [domain, weight] of Object.entries(pref.domainWeights)) {
          const stat = pref.usageStats?.domains[domain];
          const lastUsed = stat?.lastUsed ?? pref.lastUpdated;
          const timeSinceUse = now - lastUsed;

          // Only decay if past grace period
          if (timeSinceUse > gracePeriodMs) {
            const daysSinceUse = (timeSinceUse - gracePeriodMs) / msPerDay;
            const decayAmount = daysSinceUse * config.decayPerDay;
            const newWeight = Math.max(config.minWeight, weight - decayAmount);

            if (newWeight !== weight) {
              pref.domainWeights[domain] = newWeight;
              modified = true;
              decayedCount++;
            }
          }
        }

        if (modified) {
          pref.lastUpdated = now;
          preferences.set(userId, pref);
        }
      }

      if (decayedCount > 0) {
        save();
        prefsLogger.debug("user-preferences-decay-applied", {
          decayedDomains: decayedCount,
        });
      }
    },

    listUsers(): string[] {
      return Array.from(preferences.keys());
    },

    delete(userId: string): void {
      preferences.delete(userId);
      save();
    },

    save,
  };
}

/**
 * Apply user preferences to skill classifications.
 *
 * This modifies classification confidences based on:
 * - Domain weights: boost/reduce based on user's domain preferences
 * - Preferred skills: always boost these skills
 * - Excluded skills: filter these out entirely
 *
 * @param classifications - Original classification results
 * @param userId - User identifier
 * @param store - User preferences store
 * @returns Modified classifications
 */
export function applyUserPreferences(
  classifications: SkillClassification[],
  userId: string,
  store: UserPreferencesStore,
): SkillClassification[] {
  const prefs = store.get(userId);
  if (!prefs) {
    return classifications;
  }

  // Build excluded skill set
  const excludedSet = new Set((prefs.excludedSkills ?? []).map((s) => s.toLowerCase()));

  // Build preferred skill set
  const preferredSet = new Set((prefs.preferredSkills ?? []).map((s) => s.toLowerCase()));

  const result: SkillClassification[] = [];

  for (const classification of classifications) {
    // Filter out excluded skills
    if (excludedSet.has(classification.skillName.toLowerCase())) {
      continue;
    }

    let adjustedConfidence = classification.confidence;
    let reason = classification.reason;

    // Apply domain weight multipliers
    let maxDomainBoost = 1.0;
    for (const domain of classification.domains) {
      const weight = prefs.domainWeights[domain.toLowerCase()];
      if (weight !== undefined && weight > maxDomainBoost) {
        maxDomainBoost = weight;
      }
    }

    if (maxDomainBoost !== 1.0) {
      adjustedConfidence = Math.min(1.0, adjustedConfidence * maxDomainBoost);
      reason = reason
        ? `${reason}; domain weight boost: ${maxDomainBoost.toFixed(2)}`
        : `domain weight boost: ${maxDomainBoost.toFixed(2)}`;
    }

    // Apply preferred skill boost
    if (preferredSet.has(classification.skillName.toLowerCase())) {
      // Preferred skills get a fixed boost
      adjustedConfidence = Math.min(1.0, adjustedConfidence * 1.5);
      reason = reason ? `${reason}; preferred skill` : "preferred skill";
    }

    result.push({
      ...classification,
      confidence: adjustedConfidence,
      reason,
    });
  }

  // Re-sort by confidence
  result.sort((a, b) => b.confidence - a.confidence);

  prefsLogger.debug("user-preferences-applied", {
    userId,
    originalCount: classifications.length,
    resultCount: result.length,
    excludedCount: classifications.length - result.length,
  });

  return result;
}

/**
 * Get domain insights for a user.
 *
 * @param userId - User identifier
 * @param store - User preferences store
 * @returns Domain usage insights or null if no data
 */
export function getUserDomainInsights(
  userId: string,
  store: UserPreferencesStore,
): {
  topDomains: Array<{ domain: string; weight: number; invocations: number }>;
  totalInvocations: number;
  daysSinceActive: number;
} | null {
  const prefs = store.get(userId);
  if (!prefs) {
    return null;
  }

  const stats = prefs.usageStats;
  const now = Date.now();

  const domains = Object.entries(prefs.domainWeights)
    .map(([domain, weight]) => ({
      domain,
      weight,
      invocations: stats?.domains[domain]?.invocations ?? 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    topDomains: domains.slice(0, 10),
    totalInvocations: stats?.totalInvocations ?? 0,
    daysSinceActive: Math.floor((now - prefs.lastUpdated) / (24 * 60 * 60 * 1000)),
  };
}

/**
 * Reset learning data for a user while keeping explicit preferences.
 *
 * @param userId - User identifier
 * @param store - User preferences store
 */
export function resetUserLearning(userId: string, store: UserPreferencesStore): void {
  const prefs = store.get(userId);
  if (!prefs) {
    return;
  }

  store.set(userId, {
    ...prefs,
    domainWeights: {},
    usageStats: undefined,
    lastUpdated: Date.now(),
  });

  prefsLogger.info("user-learning-reset", { userId });
}
