/**
 * Tests for capability detector.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { ModelCapability } from "./types.js";
import {
  CAPABILITY_PROBES,
  getProbeForCapability,
  createCapabilityCache,
  probeModelCapabilities,
  verifyCapability,
  createMockLlmProvider,
  getProbeableCapabilities,
  describeCapability,
  type CapabilityProbe,
  type CapabilityCache,
} from "./capability-detector.js";

describe("capability-detector", () => {
  describe("CAPABILITY_PROBES", () => {
    it("has probes for common capabilities", () => {
      const capabilities: ModelCapability[] = [
        "vision",
        "tool-use",
        "thinking",
        "json-mode",
        "streaming",
      ];

      for (const cap of capabilities) {
        const probe = CAPABILITY_PROBES.find((p) => p.capability === cap);
        expect(probe).toBeDefined();
        expect(probe!.testPrompt).toBeTruthy();
        expect(typeof probe!.validateResponse).toBe("function");
      }
    });

    it("has descriptions for all probes", () => {
      for (const probe of CAPABILITY_PROBES) {
        expect(probe.description).toBeTruthy();
      }
    });
  });

  describe("getProbeForCapability", () => {
    it("returns probe for known capability", () => {
      const probe = getProbeForCapability("vision");
      expect(probe).toBeDefined();
      expect(probe!.capability).toBe("vision");
    });

    it("returns undefined for unknown capability", () => {
      const probe = getProbeForCapability("unknown" as ModelCapability);
      expect(probe).toBeUndefined();
    });
  });

  describe("probe validation", () => {
    it("validates YES responses", () => {
      const probe = getProbeForCapability("vision")!;

      expect(probe.validateResponse("YES")).toBe(true);
      expect(probe.validateResponse("Yes")).toBe(true);
      expect(probe.validateResponse("yes")).toBe(true);
      expect(probe.validateResponse("Yes, I can.")).toBe(true);
      expect(probe.validateResponse("yes.")).toBe(true);
    });

    it("rejects NO responses", () => {
      const probe = getProbeForCapability("vision")!;

      expect(probe.validateResponse("NO")).toBe(false);
      expect(probe.validateResponse("No")).toBe(false);
      expect(probe.validateResponse("no")).toBe(false);
      expect(probe.validateResponse("I cannot")).toBe(false);
    });
  });

  describe("createCapabilityCache", () => {
    it("stores and retrieves capabilities", () => {
      const cache = createCapabilityCache();

      cache.set("test-model", ["vision", "tool-use"]);
      const result = cache.get("test-model");

      expect(result).toEqual(["vision", "tool-use"]);
    });

    it("returns undefined for unknown model", () => {
      const cache = createCapabilityCache();
      expect(cache.get("unknown")).toBeUndefined();
    });

    it("clears all entries", () => {
      const cache = createCapabilityCache();

      cache.set("model1", ["vision"]);
      cache.set("model2", ["tool-use"]);

      cache.clear();

      expect(cache.get("model1")).toBeUndefined();
      expect(cache.get("model2")).toBeUndefined();
    });

    it("lists all models", () => {
      const cache = createCapabilityCache();

      cache.set("model1", ["vision"]);
      cache.set("model2", ["tool-use"]);

      const models = cache.listModels();
      expect(models).toContain("model1");
      expect(models).toContain("model2");
    });
  });

  describe("createMockLlmProvider", () => {
    it("returns YES for specified capabilities", async () => {
      const provider = createMockLlmProvider({
        vision: true,
        "tool-use": true,
      });

      const visionProbe = getProbeForCapability("vision")!;
      const response = await provider.complete("test", visionProbe.testPrompt);

      expect(response).toBe("YES");
    });

    it("returns NO for unspecified capabilities", async () => {
      const provider = createMockLlmProvider({
        vision: true,
      });

      const thinkingProbe = getProbeForCapability("thinking")!;
      const response = await provider.complete("test", thinkingProbe.testPrompt);

      expect(response).toBe("NO");
    });
  });

  describe("probeModelCapabilities", () => {
    it("detects capabilities from mock provider", async () => {
      const provider = createMockLlmProvider({
        vision: true,
        "tool-use": true,
        streaming: true,
      });

      const capabilities = await probeModelCapabilities("test-model", provider);

      expect(capabilities).toContain("vision");
      expect(capabilities).toContain("tool-use");
      expect(capabilities).toContain("streaming");
      expect(capabilities).not.toContain("thinking");
    });

    it("uses cache when available", async () => {
      const provider = createMockLlmProvider({ vision: true });
      const cache = createCapabilityCache();

      // Pre-populate cache
      cache.set("cached-model", ["thinking", "moe"]);

      const capabilities = await probeModelCapabilities("cached-model", provider, cache);

      // Should return cached values, not probed values
      expect(capabilities).toContain("thinking");
      expect(capabilities).toContain("moe");
    });

    it("probes specific capabilities only", async () => {
      let probeCount = 0;
      const provider = {
        async complete(): Promise<string> {
          probeCount++;
          return "YES";
        },
      };

      await probeModelCapabilities("test", provider, undefined, {
        capabilitiesToProbe: ["vision", "tool-use"],
      });

      expect(probeCount).toBe(2);
    });

    it("runs probes in parallel when specified", async () => {
      const callTimes: number[] = [];
      const provider = {
        async complete(): Promise<string> {
          callTimes.push(Date.now());
          await new Promise((r) => setTimeout(r, 10));
          return "YES";
        },
      };

      await probeModelCapabilities("test", provider, undefined, {
        capabilitiesToProbe: ["vision", "tool-use", "thinking"],
        parallel: true,
      });

      // All calls should start at nearly the same time
      const spread = Math.max(...callTimes) - Math.min(...callTimes);
      expect(spread).toBeLessThan(50); // Should all start within 50ms
    });

    it("stores results in cache", async () => {
      const provider = createMockLlmProvider({ vision: true });
      const cache = createCapabilityCache();

      await probeModelCapabilities("new-model", provider, cache);

      expect(cache.get("new-model")).toBeDefined();
      expect(cache.get("new-model")).toContain("vision");
    });
  });

  describe("verifyCapability", () => {
    it("verifies a specific capability", async () => {
      const provider = createMockLlmProvider({ vision: true });

      const result = await verifyCapability("test", "vision", provider);
      expect(result).toBe(true);
    });

    it("returns false for missing capability", async () => {
      const provider = createMockLlmProvider({ vision: true });

      const result = await verifyCapability("test", "thinking", provider);
      expect(result).toBe(false);
    });

    it("returns false for unknown capability", async () => {
      const provider = createMockLlmProvider({});

      const result = await verifyCapability("test", "unknown" as ModelCapability, provider);
      expect(result).toBe(false);
    });

    it("handles provider errors gracefully", async () => {
      const provider = {
        async complete(): Promise<string> {
          throw new Error("Network error");
        },
      };

      const result = await verifyCapability("test", "vision", provider);
      expect(result).toBe(false);
    });
  });

  describe("getProbeableCapabilities", () => {
    it("returns all capabilities with probes", () => {
      const capabilities = getProbeableCapabilities();

      expect(capabilities.length).toBe(CAPABILITY_PROBES.length);
      expect(capabilities).toContain("vision");
      expect(capabilities).toContain("tool-use");
      expect(capabilities).toContain("thinking");
    });
  });

  describe("describeCapability", () => {
    it("describes known capabilities", () => {
      const description = describeCapability("vision");
      expect(description).toBeTruthy();
      expect(description.toLowerCase()).toContain("image");
    });

    it("provides fallback for unknown capabilities", () => {
      const description = describeCapability("unknown" as ModelCapability);
      expect(description).toBeTruthy();
      expect(description).toContain("unknown");
    });
  });
});
