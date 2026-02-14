/**
 * Domain Tracker
 *
 * Tracks domains across conversation turns with time-based decay.
 * Used to boost skills matching recently active domains, maintaining
 * context continuity in multi-turn conversations.
 *
 * @module agents/skills/routing/domain-tracker
 */

/**
 * Configuration for domain tracking.
 */
export interface DomainTrackingConfig {
  /** Whether domain tracking is enabled */
  enabled?: boolean;
  /** Number of turns until domain weight halves (decay half-life) */
  decayTurns?: number;
  /** How much to boost matching domains (multiplier, e.g., 1.5 = 50% boost) */
  boostFactor?: number;
  /** Maximum age in milliseconds before a domain is cleared */
  maxAgeMs?: number;
}

/**
 * Default domain tracking configuration.
 */
export const DEFAULT_DOMAIN_TRACKING_CONFIG: Required<DomainTrackingConfig> = {
  enabled: false,
  decayTurns: 3,
  boostFactor: 1.3,
  maxAgeMs: 30 * 60 * 1000, // 30 minutes
};

/**
 * A single domain entry in the history.
 */
interface DomainEntry {
  /** Domain name */
  domain: string;
  /** Timestamp when domain was last active */
  timestamp: number;
  /** Number of turns since this domain was recorded */
  turns: number;
  /** Initial weight (based on confidence when recorded) */
  initialWeight: number;
}

/**
 * Domain history for a session.
 */
interface DomainHistory {
  /** Map of domain name to entry */
  entries: Map<string, DomainEntry>;
  /** Total number of turns in this session */
  turnCount: number;
}

/**
 * Active domain with computed weight.
 */
export interface ActiveDomain {
  /** Domain name */
  domain: string;
  /** Decayed weight (0.0 - 1.0+, can exceed 1.0 with boosts) */
  weight: number;
  /** Number of turns since this domain was active */
  turnsSinceActive: number;
}

/**
 * Domain tracker interface.
 */
export interface DomainTracker {
  /**
   * Record domains from a routing result.
   * Call this after each successful routing decision.
   *
   * @param sessionKey - Session identifier
   * @param domains - Array of domain names with optional weights
   */
  recordDomains(sessionKey: string, domains: Array<{ domain: string; weight?: number }>): void;

  /**
   * Get active domains for a session with decay applied.
   *
   * @param sessionKey - Session identifier
   * @returns Array of active domains with weights
   */
  getActiveDomains(sessionKey: string): ActiveDomain[];

  /**
   * Clear tracking for a session.
   *
   * @param sessionKey - Session identifier
   */
  clearSession(sessionKey: string): void;

  /**
   * Advance the turn counter for a session.
   * Should be called at the start of each new turn.
   *
   * @param sessionKey - Session identifier
   */
  advanceTurn(sessionKey: string): void;

  /**
   * Apply domain boost to skill classifications.
   * Returns a new array with boosted confidences.
   *
   * @param sessionKey - Session identifier
   * @param classifications - Original classifications
   * @param config - Domain tracking configuration
   * @returns Boosted classifications
   */
  applyBoost<T extends { domains: string[]; confidence: number }>(
    sessionKey: string,
    classifications: T[],
    config?: DomainTrackingConfig,
  ): T[];
}

/**
 * In-memory domain history storage.
 */
const sessionHistories = new Map<string, DomainHistory>();

/**
 * Calculate decayed weight for a domain entry.
 *
 * Uses exponential decay: weight = initialWeight * 0.5^(turns / halfLife)
 *
 * @param entry - Domain entry
 * @param currentTurn - Current turn number
 * @param config - Tracking configuration
 * @returns Decayed weight
 */
function calculateDecayedWeight(
  entry: DomainEntry,
  currentTurn: number,
  config: Required<DomainTrackingConfig>,
): number {
  const turnsSince = currentTurn - entry.turns;
  if (turnsSince <= 0) {
    return entry.initialWeight;
  }

  // Exponential decay with configurable half-life
  const decayFactor = Math.pow(0.5, turnsSince / config.decayTurns);
  return entry.initialWeight * decayFactor;
}

/**
 * Check if a domain entry has expired.
 *
 * @param entry - Domain entry
 * @param config - Tracking configuration
 * @returns true if expired
 */
function isExpired(entry: DomainEntry, config: Required<DomainTrackingConfig>): boolean {
  const age = Date.now() - entry.timestamp;
  return age > config.maxAgeMs;
}

/**
 * Get or create domain history for a session.
 */
function getHistory(sessionKey: string): DomainHistory {
  let history = sessionHistories.get(sessionKey);
  if (!history) {
    history = {
      entries: new Map(),
      turnCount: 0,
    };
    sessionHistories.set(sessionKey, history);
  }
  return history;
}

/**
 * Create a domain tracker instance.
 *
 * @returns DomainTracker instance
 */
export function createDomainTracker(): DomainTracker {
  return {
    recordDomains(sessionKey: string, domains: Array<{ domain: string; weight?: number }>): void {
      const history = getHistory(sessionKey);
      const now = Date.now();

      for (const { domain, weight = 1.0 } of domains) {
        const normalizedDomain = domain.toLowerCase();
        const existing = history.entries.get(normalizedDomain);

        if (existing) {
          // Update existing entry - boost weight if re-mentioned
          existing.timestamp = now;
          existing.turns = history.turnCount;
          existing.initialWeight = Math.min(1.5, existing.initialWeight + weight * 0.2);
        } else {
          // Create new entry
          history.entries.set(normalizedDomain, {
            domain: normalizedDomain,
            timestamp: now,
            turns: history.turnCount,
            initialWeight: Math.min(1.0, weight),
          });
        }
      }
    },

    getActiveDomains(sessionKey: string): ActiveDomain[] {
      const history = sessionHistories.get(sessionKey);
      if (!history) {
        return [];
      }

      const config = DEFAULT_DOMAIN_TRACKING_CONFIG;
      const activeDomains: ActiveDomain[] = [];

      for (const [domain, entry] of history.entries) {
        // Skip expired entries
        if (isExpired(entry, config)) {
          history.entries.delete(domain);
          continue;
        }

        const weight = calculateDecayedWeight(entry, history.turnCount, config);

        // Only include domains with meaningful weight
        if (weight >= 0.05) {
          activeDomains.push({
            domain,
            weight,
            turnsSinceActive: history.turnCount - entry.turns,
          });
        }
      }

      // Sort by weight descending
      return activeDomains.sort((a, b) => b.weight - a.weight);
    },

    clearSession(sessionKey: string): void {
      sessionHistories.delete(sessionKey);
    },

    advanceTurn(sessionKey: string): void {
      const history = getHistory(sessionKey);
      history.turnCount++;
    },

    applyBoost<T extends { domains: string[]; confidence: number }>(
      sessionKey: string,
      classifications: T[],
      config?: DomainTrackingConfig,
    ): T[] {
      const effectiveConfig = {
        ...DEFAULT_DOMAIN_TRACKING_CONFIG,
        ...config,
      };

      if (!effectiveConfig.enabled) {
        return classifications;
      }

      const activeDomains = this.getActiveDomains(sessionKey);
      if (activeDomains.length === 0) {
        return classifications;
      }

      // Build domain weight map
      const domainWeights = new Map<string, number>();
      for (const { domain, weight } of activeDomains) {
        domainWeights.set(domain.toLowerCase(), weight);
      }

      // Apply boosts
      return classifications.map((classification) => {
        let bestBoost = 0;

        for (const domain of classification.domains) {
          const domainWeight = domainWeights.get(domain.toLowerCase());
          if (domainWeight !== undefined) {
            // Calculate boost: weight * boostFactor - 1 gives the additional boost
            const boost = domainWeight * (effectiveConfig.boostFactor - 1);
            bestBoost = Math.max(bestBoost, boost);
          }
        }

        if (bestBoost > 0) {
          return {
            ...classification,
            confidence: Math.min(1.0, classification.confidence * (1 + bestBoost)),
          };
        }

        return classification;
      });
    },
  };
}

/**
 * Singleton domain tracker instance.
 */
let globalDomainTracker: DomainTracker | null = null;

/**
 * Get the global domain tracker instance.
 *
 * @returns Global DomainTracker
 */
export function getDomainTracker(): DomainTracker {
  if (!globalDomainTracker) {
    globalDomainTracker = createDomainTracker();
  }
  return globalDomainTracker;
}

/**
 * Clear all domain tracking state.
 * Useful for testing.
 */
export function clearAllDomainTracking(): void {
  sessionHistories.clear();
  globalDomainTracker = null;
}
