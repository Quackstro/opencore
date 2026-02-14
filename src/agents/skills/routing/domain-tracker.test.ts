/**
 * Tests for domain tracker.
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createDomainTracker,
  getDomainTracker,
  clearAllDomainTracking,
  DEFAULT_DOMAIN_TRACKING_CONFIG,
  type DomainTracker,
} from "./domain-tracker.js";

describe("domain-tracker", () => {
  let tracker: DomainTracker;

  beforeEach(() => {
    clearAllDomainTracking();
    tracker = createDomainTracker();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recordDomains", () => {
    it("records domains for a session", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      const active = tracker.getActiveDomains("session-1");

      expect(active).toHaveLength(1);
      expect(active[0].domain).toBe("coding");
      expect(active[0].weight).toBeCloseTo(1.0, 5);
    });

    it("normalizes domain names to lowercase", () => {
      tracker.recordDomains("session-1", [{ domain: "CODING" }]);

      const active = tracker.getActiveDomains("session-1");

      expect(active[0].domain).toBe("coding");
    });

    it("records multiple domains", () => {
      tracker.recordDomains("session-1", [
        { domain: "coding" },
        { domain: "devops" },
        { domain: "legal" },
      ]);

      const active = tracker.getActiveDomains("session-1");

      expect(active).toHaveLength(3);
      expect(active.map((d) => d.domain).sort()).toEqual(["coding", "devops", "legal"]);
    });

    it("updates weight when domain is re-mentioned", () => {
      tracker.recordDomains("session-1", [{ domain: "coding", weight: 0.5 }]);
      tracker.advanceTurn("session-1");
      tracker.recordDomains("session-1", [{ domain: "coding", weight: 0.8 }]);

      const active = tracker.getActiveDomains("session-1");

      // Weight should be boosted
      expect(active[0].weight).toBeGreaterThan(0.5);
    });

    it("respects weight parameter", () => {
      tracker.recordDomains("session-1", [
        { domain: "high", weight: 0.9 },
        { domain: "low", weight: 0.3 },
      ]);

      const active = tracker.getActiveDomains("session-1");

      const high = active.find((d) => d.domain === "high");
      const low = active.find((d) => d.domain === "low");

      expect(high?.weight).toBeGreaterThan(low?.weight ?? 0);
    });
  });

  describe("getActiveDomains", () => {
    it("returns empty array for unknown session", () => {
      const active = tracker.getActiveDomains("unknown-session");

      expect(active).toEqual([]);
    });

    it("applies decay over turns", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      const initialWeight = tracker.getActiveDomains("session-1")[0].weight;

      // Advance several turns
      for (let i = 0; i < 3; i++) {
        tracker.advanceTurn("session-1");
      }

      const decayedWeight = tracker.getActiveDomains("session-1")[0].weight;

      // Weight should have decayed (default half-life is 3 turns)
      expect(decayedWeight).toBeLessThan(initialWeight);
      expect(decayedWeight).toBeCloseTo(initialWeight * 0.5, 1);
    });

    it("removes expired domains", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      // Advance time beyond max age (default 30 minutes)
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);

      const active = tracker.getActiveDomains("session-1");

      expect(active).toHaveLength(0);
    });

    it("filters out domains with very low weight", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      // Advance many turns to decay weight below threshold
      for (let i = 0; i < 20; i++) {
        tracker.advanceTurn("session-1");
      }

      const active = tracker.getActiveDomains("session-1");

      // Should filter out domains with weight < 0.05
      expect(active).toHaveLength(0);
    });

    it("sorts by weight descending", () => {
      tracker.recordDomains("session-1", [
        { domain: "low", weight: 0.3 },
        { domain: "high", weight: 0.9 },
        { domain: "mid", weight: 0.6 },
      ]);

      const active = tracker.getActiveDomains("session-1");

      expect(active[0].domain).toBe("high");
      expect(active[1].domain).toBe("mid");
      expect(active[2].domain).toBe("low");
    });

    it("includes turnsSinceActive", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      tracker.advanceTurn("session-1");
      tracker.advanceTurn("session-1");

      const active = tracker.getActiveDomains("session-1");

      expect(active[0].turnsSinceActive).toBe(2);
    });
  });

  describe("clearSession", () => {
    it("clears tracking for a session", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      tracker.clearSession("session-1");

      const active = tracker.getActiveDomains("session-1");

      expect(active).toEqual([]);
    });

    it("does not affect other sessions", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      tracker.recordDomains("session-2", [{ domain: "legal" }]);

      tracker.clearSession("session-1");

      expect(tracker.getActiveDomains("session-1")).toEqual([]);
      expect(tracker.getActiveDomains("session-2")).toHaveLength(1);
    });
  });

  describe("advanceTurn", () => {
    it("increments turn counter", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      expect(tracker.getActiveDomains("session-1")[0].turnsSinceActive).toBe(0);

      tracker.advanceTurn("session-1");

      expect(tracker.getActiveDomains("session-1")[0].turnsSinceActive).toBe(1);
    });

    it("creates session if not exists", () => {
      tracker.advanceTurn("new-session");
      tracker.recordDomains("new-session", [{ domain: "coding" }]);

      // Turn counter should be 1, so domain was recorded at turn 1
      tracker.advanceTurn("new-session");

      expect(tracker.getActiveDomains("new-session")[0].turnsSinceActive).toBe(1);
    });
  });

  describe("applyBoost", () => {
    const classifications = [
      { skillName: "skill-a", domains: ["coding"], confidence: 0.5 },
      { skillName: "skill-b", domains: ["legal"], confidence: 0.5 },
      { skillName: "skill-c", domains: ["finance"], confidence: 0.5 },
    ];

    it("does not modify when disabled", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      const result = tracker.applyBoost("session-1", classifications, {
        enabled: false,
      });

      expect(result).toEqual(classifications);
    });

    it("boosts matching domains when enabled", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      const result = tracker.applyBoost("session-1", classifications, {
        enabled: true,
        boostFactor: 1.3,
      });

      const codingSkill = result.find((r) => r.skillName === "skill-a");
      const legalSkill = result.find((r) => r.skillName === "skill-b");

      expect(codingSkill?.confidence).toBeGreaterThan(0.5);
      expect(legalSkill?.confidence).toBe(0.5);
    });

    it("caps boosted confidence at 1.0", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      const highConfidence = [{ skillName: "skill-a", domains: ["coding"], confidence: 0.9 }];

      const result = tracker.applyBoost("session-1", highConfidence, {
        enabled: true,
        boostFactor: 2.0,
      });

      expect(result[0].confidence).toBe(1.0);
    });

    it("does not modify when no active domains", () => {
      const result = tracker.applyBoost("session-1", classifications, {
        enabled: true,
      });

      expect(result).toEqual(classifications);
    });

    it("uses best boost for skills with multiple domains", () => {
      tracker.recordDomains("session-1", [
        { domain: "coding", weight: 0.5 },
        { domain: "devops", weight: 0.8 },
      ]);

      const multiDomainSkill = [
        { skillName: "skill-a", domains: ["coding", "devops"], confidence: 0.5 },
      ];

      const result = tracker.applyBoost("session-1", multiDomainSkill, {
        enabled: true,
        boostFactor: 1.3,
      });

      // Should use the higher weight (devops at 0.8)
      expect(result[0].confidence).toBeGreaterThan(0.5);
    });

    it("respects decayed weights", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);

      // Get initial boost
      const result1 = tracker.applyBoost("session-1", classifications, {
        enabled: true,
        boostFactor: 1.3,
      });
      const initialBoost = result1.find((r) => r.skillName === "skill-a")?.confidence ?? 0;

      // Advance turns to decay
      for (let i = 0; i < 3; i++) {
        tracker.advanceTurn("session-1");
      }

      const result2 = tracker.applyBoost("session-1", classifications, {
        enabled: true,
        boostFactor: 1.3,
      });
      const decayedBoost = result2.find((r) => r.skillName === "skill-a")?.confidence ?? 0;

      expect(decayedBoost).toBeLessThan(initialBoost);
    });
  });

  describe("getDomainTracker", () => {
    it("returns singleton instance", () => {
      const tracker1 = getDomainTracker();
      const tracker2 = getDomainTracker();

      expect(tracker1).toBe(tracker2);
    });

    it("returns new instance after clearAllDomainTracking", () => {
      const tracker1 = getDomainTracker();
      clearAllDomainTracking();
      const tracker2 = getDomainTracker();

      expect(tracker1).not.toBe(tracker2);
    });
  });

  describe("clearAllDomainTracking", () => {
    it("clears all sessions", () => {
      const globalTracker = getDomainTracker();
      globalTracker.recordDomains("session-1", [{ domain: "coding" }]);
      globalTracker.recordDomains("session-2", [{ domain: "legal" }]);

      clearAllDomainTracking();
      const newTracker = getDomainTracker();

      expect(newTracker.getActiveDomains("session-1")).toEqual([]);
      expect(newTracker.getActiveDomains("session-2")).toEqual([]);
    });
  });

  describe("DEFAULT_DOMAIN_TRACKING_CONFIG", () => {
    it("has expected default values", () => {
      expect(DEFAULT_DOMAIN_TRACKING_CONFIG).toEqual({
        enabled: false,
        decayTurns: 3,
        boostFactor: 1.3,
        maxAgeMs: 30 * 60 * 1000,
      });
    });
  });

  describe("session isolation", () => {
    it("isolates domains between sessions", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      tracker.recordDomains("session-2", [{ domain: "legal" }]);

      const session1Domains = tracker.getActiveDomains("session-1");
      const session2Domains = tracker.getActiveDomains("session-2");

      expect(session1Domains).toHaveLength(1);
      expect(session1Domains[0].domain).toBe("coding");
      expect(session2Domains).toHaveLength(1);
      expect(session2Domains[0].domain).toBe("legal");
    });

    it("isolates turn counts between sessions", () => {
      tracker.recordDomains("session-1", [{ domain: "coding" }]);
      tracker.recordDomains("session-2", [{ domain: "coding" }]);

      for (let i = 0; i < 5; i++) {
        tracker.advanceTurn("session-1");
      }

      expect(tracker.getActiveDomains("session-1")[0].turnsSinceActive).toBe(5);
      expect(tracker.getActiveDomains("session-2")[0].turnsSinceActive).toBe(0);
    });
  });
});
