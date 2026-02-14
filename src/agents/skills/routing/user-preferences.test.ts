/**
 * Tests for user preferences functionality.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createUserPreferencesStore,
  applyUserPreferences,
  getUserDomainInsights,
  resetUserLearning,
  DEFAULT_LEARNING_CONFIG,
  type UserPreference,
  type SkillClassification,
} from "./user-preferences.js";

describe("user-preferences", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prefs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createUserPreferencesStore", () => {
    it("creates an in-memory store", () => {
      const store = createUserPreferencesStore();

      expect(store.get("user1")).toBeUndefined();
      expect(store.listUsers()).toHaveLength(0);
    });

    it("creates a persistent store", () => {
      const persistPath = path.join(tempDir, "prefs.json");
      const store = createUserPreferencesStore(persistPath);

      store.set("user1", { domainWeights: { coding: 1.5 } });

      // Verify file was created
      expect(fs.existsSync(persistPath)).toBe(true);

      // Create new store and verify data loads
      const store2 = createUserPreferencesStore(persistPath);
      const pref = store2.get("user1");
      expect(pref?.domainWeights.coding).toBe(1.5);
    });

    it("handles missing persist file gracefully", () => {
      const persistPath = path.join(tempDir, "nonexistent.json");
      const store = createUserPreferencesStore(persistPath);

      expect(store.listUsers()).toHaveLength(0);
    });
  });

  describe("store.get and store.set", () => {
    it("sets and gets preferences", () => {
      const store = createUserPreferencesStore();

      store.set("user1", {
        domainWeights: { coding: 1.5, legal: 0.8 },
        preferredSkills: ["claude-code"],
        excludedSkills: ["unwanted-skill"],
      });

      const pref = store.get("user1");
      expect(pref).toBeDefined();
      expect(pref!.domainWeights.coding).toBe(1.5);
      expect(pref!.preferredSkills).toContain("claude-code");
      expect(pref!.excludedSkills).toContain("unwanted-skill");
    });

    it("merges domain weights on update", () => {
      const store = createUserPreferencesStore();

      store.set("user1", { domainWeights: { coding: 1.5 } });
      store.set("user1", { domainWeights: { legal: 1.2 } });

      const pref = store.get("user1");
      expect(pref!.domainWeights.coding).toBe(1.5);
      expect(pref!.domainWeights.legal).toBe(1.2);
    });

    it("updates lastUpdated timestamp", () => {
      const store = createUserPreferencesStore();
      const before = Date.now();

      store.set("user1", { domainWeights: {} });

      const pref = store.get("user1");
      expect(pref!.lastUpdated).toBeGreaterThanOrEqual(before);
    });
  });

  describe("store.learnFromUsage", () => {
    it("increases domain weights with usage", () => {
      const store = createUserPreferencesStore();

      store.learnFromUsage("user1", ["claude-code"], ["coding"]);
      const pref1 = store.get("user1");
      const weight1 = pref1!.domainWeights.coding;

      store.learnFromUsage("user1", ["claude-code"], ["coding"]);
      const pref2 = store.get("user1");
      const weight2 = pref2!.domainWeights.coding;

      expect(weight2).toBeGreaterThan(weight1);
    });

    it("respects maxWeight", () => {
      const store = createUserPreferencesStore(undefined, {
        incrementPerUse: 0.5,
        maxWeight: 1.5,
      });

      // Multiple uses
      for (let i = 0; i < 10; i++) {
        store.learnFromUsage("user1", ["skill"], ["coding"]);
      }

      const pref = store.get("user1");
      expect(pref!.domainWeights.coding).toBeLessThanOrEqual(1.5);
    });

    it("tracks usage statistics", () => {
      const store = createUserPreferencesStore();

      store.learnFromUsage("user1", ["skill1", "skill2"], ["coding"]);

      const pref = store.get("user1");
      expect(pref!.usageStats).toBeDefined();
      expect(pref!.usageStats!.domains.coding).toBeDefined();
      expect(pref!.usageStats!.domains.coding.invocations).toBe(1);
      expect(pref!.usageStats!.domains.coding.usedSkills).toContain("skill1");
      expect(pref!.usageStats!.domains.coding.usedSkills).toContain("skill2");
    });

    it("does nothing when disabled", () => {
      const store = createUserPreferencesStore(undefined, { enabled: false });

      store.learnFromUsage("user1", ["skill"], ["coding"]);

      expect(store.get("user1")).toBeUndefined();
    });
  });

  describe("store.applyDecay", () => {
    it("decays weights for unused domains", () => {
      const store = createUserPreferencesStore(undefined, {
        decayPerDay: 0.1,
        decayGracePeriodDays: 0, // No grace period for testing
      });

      // Set up initial state with old timestamp
      const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
      store.set("user1", {
        domainWeights: { coding: 1.5 },
        lastUpdated: oldTime,
      });

      store.applyDecay();

      const pref = store.get("user1");
      // Weight should be reduced by ~0.2 (2 days * 0.1)
      expect(pref!.domainWeights.coding).toBeLessThan(1.5);
    });

    it("respects minWeight", () => {
      const store = createUserPreferencesStore(undefined, {
        decayPerDay: 1.0, // Very aggressive decay
        decayGracePeriodDays: 0,
        minWeight: 0.5,
      });

      const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      store.set("user1", {
        domainWeights: { coding: 1.5 },
        lastUpdated: oldTime,
      });

      store.applyDecay();

      const pref = store.get("user1");
      expect(pref!.domainWeights.coding).toBeGreaterThanOrEqual(0.5);
    });

    it("respects grace period", () => {
      const store = createUserPreferencesStore(undefined, {
        decayPerDay: 0.1,
        decayGracePeriodDays: 7,
      });

      // Set up state from 2 days ago (within grace period)
      const recentTime = Date.now() - 2 * 24 * 60 * 60 * 1000;
      store.set("user1", {
        domainWeights: { coding: 1.5 },
        lastUpdated: recentTime,
      });

      store.applyDecay();

      const pref = store.get("user1");
      // Weight should NOT be reduced (within grace period)
      expect(pref!.domainWeights.coding).toBe(1.5);
    });
  });

  describe("store.delete", () => {
    it("deletes user preferences", () => {
      const store = createUserPreferencesStore();

      store.set("user1", { domainWeights: { coding: 1.5 } });
      expect(store.get("user1")).toBeDefined();

      store.delete("user1");
      expect(store.get("user1")).toBeUndefined();
    });
  });

  describe("applyUserPreferences", () => {
    it("boosts skills based on domain weights", () => {
      const store = createUserPreferencesStore();
      store.set("user1", { domainWeights: { coding: 1.5 } });

      const classifications: SkillClassification[] = [
        { skillName: "claude-code", domains: ["coding"], confidence: 0.5 },
        { skillName: "paralegal", domains: ["legal"], confidence: 0.5 },
      ];

      const result = applyUserPreferences(classifications, "user1", store);

      const codingSkill = result.find((c) => c.skillName === "claude-code");
      const legalSkill = result.find((c) => c.skillName === "paralegal");

      expect(codingSkill!.confidence).toBeGreaterThan(0.5);
      expect(legalSkill!.confidence).toBe(0.5);
    });

    it("excludes skills in excludedSkills", () => {
      const store = createUserPreferencesStore();
      store.set("user1", { excludedSkills: ["unwanted"] });

      const classifications: SkillClassification[] = [
        { skillName: "wanted", domains: ["misc"], confidence: 0.5 },
        { skillName: "unwanted", domains: ["misc"], confidence: 0.5 },
      ];

      const result = applyUserPreferences(classifications, "user1", store);

      expect(result.map((c) => c.skillName)).toContain("wanted");
      expect(result.map((c) => c.skillName)).not.toContain("unwanted");
    });

    it("boosts preferred skills", () => {
      const store = createUserPreferencesStore();
      store.set("user1", { preferredSkills: ["favorite"] });

      const classifications: SkillClassification[] = [
        { skillName: "favorite", domains: ["misc"], confidence: 0.5 },
        { skillName: "other", domains: ["misc"], confidence: 0.5 },
      ];

      const result = applyUserPreferences(classifications, "user1", store);

      const favorite = result.find((c) => c.skillName === "favorite");
      const other = result.find((c) => c.skillName === "other");

      expect(favorite!.confidence).toBeGreaterThan(other!.confidence);
    });

    it("returns original classifications for unknown user", () => {
      const store = createUserPreferencesStore();

      const classifications: SkillClassification[] = [
        { skillName: "skill", domains: ["misc"], confidence: 0.5 },
      ];

      const result = applyUserPreferences(classifications, "unknown", store);
      expect(result).toEqual(classifications);
    });

    it("re-sorts by confidence after adjustments", () => {
      const store = createUserPreferencesStore();
      store.set("user1", { domainWeights: { coding: 2.0 } });

      const classifications: SkillClassification[] = [
        { skillName: "legal-skill", domains: ["legal"], confidence: 0.8 },
        { skillName: "coding-skill", domains: ["coding"], confidence: 0.5 },
      ];

      const result = applyUserPreferences(classifications, "user1", store);

      // Coding skill should now be first due to boost
      expect(result[0].skillName).toBe("coding-skill");
    });
  });

  describe("getUserDomainInsights", () => {
    it("returns insights for user", () => {
      const store = createUserPreferencesStore();
      store.set("user1", { domainWeights: { coding: 1.5, legal: 0.8 } });
      store.learnFromUsage("user1", ["skill"], ["coding"]);

      const insights = getUserDomainInsights("user1", store);

      expect(insights).not.toBeNull();
      expect(insights!.topDomains).toHaveLength(2);
      expect(insights!.topDomains[0].domain).toBe("coding");
      expect(insights!.totalInvocations).toBe(1);
    });

    it("returns null for unknown user", () => {
      const store = createUserPreferencesStore();
      const insights = getUserDomainInsights("unknown", store);
      expect(insights).toBeNull();
    });
  });

  describe("resetUserLearning", () => {
    it("clears learning data while keeping explicit preferences", () => {
      const store = createUserPreferencesStore();
      store.set("user1", {
        preferredSkills: ["favorite"],
        excludedSkills: ["unwanted"],
      });
      store.learnFromUsage("user1", ["skill"], ["coding"]);

      resetUserLearning("user1", store);

      const pref = store.get("user1");
      expect(pref!.domainWeights).toEqual({});
      expect(pref!.usageStats).toBeUndefined();
      expect(pref!.preferredSkills).toContain("favorite");
      expect(pref!.excludedSkills).toContain("unwanted");
    });

    it("does nothing for unknown user", () => {
      const store = createUserPreferencesStore();
      resetUserLearning("unknown", store); // Should not throw
    });
  });

  describe("DEFAULT_LEARNING_CONFIG", () => {
    it("has valid defaults", () => {
      expect(DEFAULT_LEARNING_CONFIG.enabled).toBe(true);
      expect(DEFAULT_LEARNING_CONFIG.incrementPerUse).toBeGreaterThan(0);
      expect(DEFAULT_LEARNING_CONFIG.maxWeight).toBeGreaterThan(1);
      expect(DEFAULT_LEARNING_CONFIG.minWeight).toBeLessThan(1);
      expect(DEFAULT_LEARNING_CONFIG.decayPerDay).toBeGreaterThan(0);
    });
  });
});
