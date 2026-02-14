/**
 * LLM Classifier
 *
 * Uses a fast language model to classify which skills/domains are relevant
 * to a user message. Provides the highest accuracy classification at the
 * cost of latency and API calls.
 *
 * @module agents/skills/routing/llm-classifier
 */

import type { SkillEntry } from "../types.js";
import type {
  RoutingContext,
  RoutingSkillMetadata,
  SkillClassification,
  SkillRoutingConfig,
} from "./types.js";

/**
 * Interface for LLM provider used in classification.
 */
export interface LlmClassifierProvider {
  /**
   * Complete a prompt and return the response text.
   *
   * @param prompt - The classification prompt
   * @param options - Optional parameters
   * @returns The model's response text
   */
  complete: (
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
}

/**
 * Default model for LLM classification.
 */
export const DEFAULT_CLASSIFIER_MODEL = "anthropic/claude-haiku";

/**
 * Classification prompt template.
 */
const CLASSIFICATION_PROMPT = `You are a skill router. Given a user message and available skill domains, determine which domains are relevant to the user's request.

Available domains:
{domains}

User message:
{message}

Instructions:
- Output ONLY a JSON array of relevant domain names, ordered by relevance (most relevant first)
- Only include domains that are clearly relevant to the user's message
- If no domains are clearly relevant, output an empty array: []
- Do not include explanations, just the JSON array

Relevant domains:`;

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
    domainWeight: typeof metadata.domainWeight === "number" ? metadata.domainWeight : undefined,
    alwaysInclude: typeof metadata.alwaysInclude === "boolean" ? metadata.alwaysInclude : undefined,
  };
}

/**
 * Parse the LLM response to extract domains.
 * Handles various response formats gracefully.
 *
 * @param response - Raw LLM response
 * @returns Array of domain names
 */
export function parseLlmResponse(response: string): string[] {
  const trimmed = response.trim();

  // Try to find a JSON array in the response
  const jsonMatch = trimmed.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Filter to only valid strings and normalize
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((domain) => domain.toLowerCase().trim())
      .filter((domain) => domain.length > 0);
  } catch {
    return [];
  }
}

/**
 * Build the contextual message for classification.
 *
 * @param context - Routing context
 * @param historyDepth - How many history messages to include
 * @returns Combined message with context
 */
function buildContextualMessage(context: RoutingContext, historyDepth: number): string {
  const history = context.conversationHistory ?? [];
  const recentHistory = history.slice(-historyDepth);

  if (recentHistory.length === 0) {
    return context.message;
  }

  // Format history as conversation context
  const historyText = recentHistory.map((msg, i) => `[${i + 1}] ${msg}`).join("\n");
  return `Recent conversation:\n${historyText}\n\nCurrent message:\n${context.message}`;
}

/**
 * Classify skills using an LLM.
 *
 * @param context - Routing context with user message
 * @param skills - Array of eligible skill entries
 * @param config - Routing configuration
 * @param llmProvider - Provider for LLM completion
 * @returns Array of skill classifications sorted by confidence (descending)
 */
export async function classifyWithLLM(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
  llmProvider: LlmClassifierProvider,
): Promise<SkillClassification[]> {
  // Collect all unique domains from skills
  const domainToSkills = new Map<string, SkillEntry[]>();
  const allDomains = new Set<string>();

  for (const skill of skills) {
    const routing = getRoutingMetadata(skill);
    const domains = routing.domains ?? [];

    for (const domain of domains) {
      allDomains.add(domain);
      const existing = domainToSkills.get(domain) ?? [];
      existing.push(skill);
      domainToSkills.set(domain, existing);
    }
  }

  // If no domains defined, fall back to basic classification
  if (allDomains.size === 0) {
    return skills.map((skill) => ({
      skillName: skill.skill.name,
      domains: [],
      confidence: 0.1,
      reason: "no domains defined",
    }));
  }

  // Build contextual message
  const historyDepth = config.dynamic?.historyDepth ?? 5;
  const contextualMessage = buildContextualMessage(context, historyDepth);

  // Build the classification prompt
  const domainList = Array.from(allDomains).sort().join(", ");
  const prompt = CLASSIFICATION_PROMPT.replace("{domains}", domainList).replace(
    "{message}",
    contextualMessage,
  );

  // Call the LLM
  const maxTokens = config.dynamic?.llm?.maxTokens ?? 150;
  const response = await llmProvider.complete(prompt, {
    maxTokens,
    temperature: 0.0, // Deterministic for classification
  });

  // Parse the response
  const detectedDomains = parseLlmResponse(response);

  // Build classifications
  const classifications: SkillClassification[] = [];

  for (const skill of skills) {
    const routing = getRoutingMetadata(skill);
    const skillDomains = routing.domains ?? [];

    let confidence: number;
    let reason: string | undefined;

    if (routing.alwaysInclude) {
      confidence = 1.0;
      reason = "alwaysInclude flag";
    } else if (skillDomains.length === 0) {
      // Skills without domains get low baseline
      confidence = 0.1;
      reason = "no domains defined";
    } else {
      // Find the best matching domain position
      let bestPosition = -1;
      let matchedDomain: string | undefined;

      for (const domain of skillDomains) {
        const position = detectedDomains.indexOf(domain.toLowerCase());
        if (position !== -1 && (bestPosition === -1 || position < bestPosition)) {
          bestPosition = position;
          matchedDomain = domain;
        }
      }

      if (bestPosition === -1) {
        // No match
        confidence = 0;
      } else {
        // Higher confidence for earlier positions in the relevance list
        // Position 0 = 1.0, Position 1 = 0.9, Position 2 = 0.8, etc.
        const positionScore = Math.max(0.1, 1.0 - bestPosition * 0.1);
        const domainWeight = routing.domainWeight ?? 1.0;
        confidence = positionScore * domainWeight;
        reason = `matched domain: ${matchedDomain} (position ${bestPosition + 1})`;
      }
    }

    classifications.push({
      skillName: skill.skill.name,
      domains: skillDomains,
      confidence,
      reason,
    });
  }

  return classifications.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Create an LLM classifier provider from a completion function.
 *
 * @param completeFn - Async function that completes a prompt
 * @returns LlmClassifierProvider instance
 */
export function createLlmClassifierProvider(
  completeFn: (
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ) => Promise<string>,
): LlmClassifierProvider {
  return {
    complete: completeFn,
  };
}
