/**
 * Capability Detector
 *
 * Auto-detect model capabilities through probing.
 * Useful for unknown or local models where capabilities aren't registered.
 *
 * @module agents/skills/routing/capability-detector
 */

import type { ModelCapability } from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const detectorLogger = createSubsystemLogger("skills-capability-detector");

/**
 * A capability probe definition.
 */
export interface CapabilityProbe {
  /** The capability being tested */
  capability: ModelCapability;
  /** Test prompt to send to the model */
  testPrompt: string;
  /** Function to validate the response */
  validateResponse: (response: string) => boolean;
  /** Optional timeout for the probe (ms) */
  timeoutMs?: number;
  /** Whether this probe requires special handling */
  requiresSpecialHandling?: boolean;
  /** Description of what this probe tests */
  description?: string;
}

/**
 * Standard capability probes for common capabilities.
 *
 * These probes use simple yes/no questions that most models can answer.
 * The validation is intentionally lenient to handle various response formats.
 */
export const CAPABILITY_PROBES: CapabilityProbe[] = [
  {
    capability: "vision",
    testPrompt: "Can you analyze images if I provide them? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model can process image inputs",
  },
  {
    capability: "tool-use",
    testPrompt: "Do you support function calling or tool use? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model supports function/tool calling",
  },
  {
    capability: "thinking",
    testPrompt:
      "Do you have an extended thinking or chain-of-thought reasoning mode? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model has extended reasoning capabilities",
  },
  {
    capability: "json-mode",
    testPrompt:
      "Can you output responses in strict JSON format when requested? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model can produce structured JSON output",
  },
  {
    capability: "streaming",
    testPrompt: "Do you support streaming responses? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      // Most models support streaming, so we're lenient here
      return (
        lower.startsWith("yes") ||
        lower.includes("yes,") ||
        lower === "yes." ||
        !lower.includes("no")
      );
    },
    description: "Tests if model supports streaming output",
  },
  {
    capability: "long-context",
    testPrompt: "Is your context window larger than 100,000 tokens? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model has >100k token context",
  },
  {
    capability: "code-execution",
    testPrompt: "Can you execute code in a sandbox environment? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model can run code",
  },
  {
    capability: "web-search",
    testPrompt: "Do you have integrated web search capabilities? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model has web search integration",
  },
  {
    capability: "multimodal-output",
    testPrompt: "Can you generate images or other media as output? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model can produce non-text output",
  },
  {
    capability: "moe",
    testPrompt: "Are you a mixture-of-experts model? Reply with only YES or NO.",
    validateResponse: (r) => {
      const lower = r.toLowerCase().trim();
      return lower.startsWith("yes") || lower.includes("yes,") || lower === "yes.";
    },
    description: "Tests if model uses MoE architecture",
  },
];

/**
 * Get the probe for a specific capability.
 *
 * @param capability - The capability to get the probe for
 * @returns The probe or undefined if not found
 */
export function getProbeForCapability(capability: ModelCapability): CapabilityProbe | undefined {
  return CAPABILITY_PROBES.find((p) => p.capability === capability);
}

/**
 * Interface for LLM provider used by the detector.
 */
export interface LlmProvider {
  /**
   * Send a simple text prompt and get a response.
   * @param modelId - Model to use
   * @param prompt - Text prompt
   * @param options - Optional settings
   * @returns Response text
   */
  complete(
    modelId: string,
    prompt: string,
    options?: { maxTokens?: number; timeoutMs?: number },
  ): Promise<string>;
}

/**
 * Cache for detected capabilities.
 */
export interface CapabilityCache {
  /**
   * Get cached capabilities for a model.
   * @param modelId - Model identifier
   * @returns Cached capabilities or undefined
   */
  get(modelId: string): ModelCapability[] | undefined;

  /**
   * Set capabilities for a model.
   * @param modelId - Model identifier
   * @param capabilities - Detected capabilities
   */
  set(modelId: string, capabilities: ModelCapability[]): void;

  /**
   * Clear the cache.
   */
  clear(): void;

  /**
   * Get all cached models.
   */
  listModels(): string[];
}

/**
 * Create an in-memory capability cache.
 *
 * @returns CapabilityCache instance
 */
export function createCapabilityCache(): CapabilityCache {
  const cache = new Map<string, ModelCapability[]>();

  return {
    get(modelId: string): ModelCapability[] | undefined {
      return cache.get(modelId);
    },

    set(modelId: string, capabilities: ModelCapability[]): void {
      cache.set(modelId, capabilities);
    },

    clear(): void {
      cache.clear();
    },

    listModels(): string[] {
      return Array.from(cache.keys());
    },
  };
}

/**
 * Result of a capability probe.
 */
export interface ProbeResult {
  /** The capability tested */
  capability: ModelCapability;
  /** Whether the capability is detected */
  detected: boolean;
  /** Raw response from the model */
  rawResponse?: string;
  /** Error if probe failed */
  error?: string;
  /** Time taken in milliseconds */
  durationMs?: number;
}

/**
 * Probe a model for its capabilities.
 *
 * Runs all capability probes against the model and returns detected capabilities.
 * Results can be cached for future use.
 *
 * @param modelId - Model to probe
 * @param llmProvider - LLM provider for sending probes
 * @param cache - Optional cache to store/retrieve results
 * @param options - Probe options
 * @returns Array of detected capabilities
 */
export async function probeModelCapabilities(
  modelId: string,
  llmProvider: LlmProvider,
  cache?: CapabilityCache,
  options?: {
    /** Only probe specific capabilities */
    capabilitiesToProbe?: ModelCapability[];
    /** Skip capabilities that are already known */
    skipKnown?: boolean;
    /** Timeout per probe in ms */
    timeoutMs?: number;
    /** Run probes in parallel */
    parallel?: boolean;
  },
): Promise<ModelCapability[]> {
  // Check cache first
  if (cache && !options?.skipKnown) {
    const cached = cache.get(modelId);
    if (cached) {
      detectorLogger.debug("capability-probe-cache-hit", { modelId, cached });
      return cached;
    }
  }

  const probesToRun = options?.capabilitiesToProbe
    ? CAPABILITY_PROBES.filter((p) => options.capabilitiesToProbe!.includes(p.capability))
    : CAPABILITY_PROBES;

  const timeoutMs = options?.timeoutMs ?? 10000;
  const detectedCapabilities: ModelCapability[] = [];

  detectorLogger.info("capability-probe-starting", {
    modelId,
    probeCount: probesToRun.length,
  });

  const runProbe = async (probe: CapabilityProbe): Promise<ProbeResult> => {
    const startTime = Date.now();
    try {
      const response = await llmProvider.complete(modelId, probe.testPrompt, {
        maxTokens: 50,
        timeoutMs: probe.timeoutMs ?? timeoutMs,
      });

      const detected = probe.validateResponse(response);
      const durationMs = Date.now() - startTime;

      return {
        capability: probe.capability,
        detected,
        rawResponse: response,
        durationMs,
      };
    } catch (err) {
      return {
        capability: probe.capability,
        detected: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  };

  // Run probes
  let results: ProbeResult[];
  if (options?.parallel) {
    results = await Promise.all(probesToRun.map(runProbe));
  } else {
    results = [];
    for (const probe of probesToRun) {
      results.push(await runProbe(probe));
    }
  }

  // Collect detected capabilities
  for (const result of results) {
    if (result.detected) {
      detectedCapabilities.push(result.capability);
    }

    detectorLogger.debug("capability-probe-result", {
      modelId,
      capability: result.capability,
      detected: result.detected,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  // Cache the results
  if (cache) {
    cache.set(modelId, detectedCapabilities);
  }

  detectorLogger.info("capability-probe-complete", {
    modelId,
    detected: detectedCapabilities,
    probeCount: probesToRun.length,
    successCount: results.filter((r) => !r.error).length,
  });

  return detectedCapabilities;
}

/**
 * Verify a specific capability for a model.
 *
 * @param modelId - Model to test
 * @param capability - Capability to verify
 * @param llmProvider - LLM provider for sending probes
 * @returns true if capability is detected
 */
export async function verifyCapability(
  modelId: string,
  capability: ModelCapability,
  llmProvider: LlmProvider,
): Promise<boolean> {
  const probe = getProbeForCapability(capability);
  if (!probe) {
    detectorLogger.warn("capability-probe-not-found", { capability });
    return false;
  }

  try {
    const response = await llmProvider.complete(modelId, probe.testPrompt, {
      maxTokens: 50,
      timeoutMs: probe.timeoutMs ?? 10000,
    });

    const detected = probe.validateResponse(response);

    detectorLogger.debug("capability-verify-result", {
      modelId,
      capability,
      detected,
    });

    return detected;
  } catch (err) {
    detectorLogger.warn("capability-verify-failed", {
      modelId,
      capability,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Create a mock LLM provider for testing.
 *
 * @param responses - Map of capability to whether it should be detected
 * @returns Mock LlmProvider
 */
export function createMockLlmProvider(
  responses: Partial<Record<ModelCapability, boolean>>,
): LlmProvider {
  return {
    async complete(_modelId: string, prompt: string): Promise<string> {
      // Find which capability this prompt is testing
      for (const probe of CAPABILITY_PROBES) {
        if (prompt === probe.testPrompt) {
          const shouldDetect = responses[probe.capability] ?? false;
          return shouldDetect ? "YES" : "NO";
        }
      }
      return "NO";
    },
  };
}

/**
 * Get all capabilities that can be probed.
 *
 * @returns Array of probeable capabilities
 */
export function getProbeableCapabilities(): ModelCapability[] {
  return CAPABILITY_PROBES.map((p) => p.capability);
}

/**
 * Describe a capability in human-readable terms.
 *
 * @param capability - Capability to describe
 * @returns Description string
 */
export function describeCapability(capability: ModelCapability): string {
  const probe = getProbeForCapability(capability);
  return probe?.description ?? `${capability} capability`;
}
