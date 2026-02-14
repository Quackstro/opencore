/**
 * Task-based Skill Detection
 *
 * Lightweight detection of likely skills from a task description without
 * loading the full skill registry. Uses domain keyword matching to infer
 * which skill domains and capabilities the task might require.
 *
 * Used by sessions_spawn to auto-select models for sub-agents based on
 * task content when explicit model selection isn't provided.
 *
 * @module agents/skills/routing/task-skill-detector
 */

import type { OpenClawSkillMetadata, SkillEntry } from "../types.js";
import type { ModelCapability, ThinkingLevel } from "./types.js";
import { detectDomainsFromMessage, DOMAIN_KEYWORDS } from "./keywords-classifier.js";

/**
 * Domain to capability mapping for common patterns.
 *
 * When a domain is detected, these capabilities are likely required.
 */
const DOMAIN_CAPABILITIES: Record<string, ModelCapability[]> = {
  media: ["vision"],
  "ui-design": ["vision"],
  coding: ["tool-use"],
  devops: ["tool-use"],
  data: ["tool-use", "json-mode"],
  research: ["tool-use", "web-search"],
};

/**
 * Domain to preferred thinking level mapping.
 *
 * Some domains benefit from higher thinking levels.
 */
const DOMAIN_THINKING: Record<string, ThinkingLevel> = {
  coding: "medium",
  legal: "high",
  security: "high",
  data: "medium",
};

/**
 * Result of detecting skills from a task.
 */
export interface TaskSkillDetection {
  /** Detected domain names */
  domains: string[];
  /** Inferred capability requirements based on domains */
  inferredCapabilities: ModelCapability[];
  /** Suggested thinking level based on domains */
  suggestedThinking?: ThinkingLevel;
  /** Synthetic skill entry for model selection */
  syntheticSkill?: SkillEntry;
  /** Confidence score (0.0-1.0) */
  confidence: number;
}

/**
 * Extract routing metadata for task detection.
 * Returns metadata compatible with OpenClawSkillMetadata but containing
 * routing-specific fields that will be read via type casting.
 */
function buildSyntheticMetadata(
  domains: string[],
  capabilities: ModelCapability[],
  thinking?: ThinkingLevel,
): Record<string, unknown> {
  return {
    // Routing-specific fields (read via casting in model selector)
    domains,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    thinkingOverride: thinking,
    thinkingOverrideMode: thinking ? "minimum" : undefined,
  };
}

/**
 * Detect skills/capabilities from a task description.
 *
 * This is a lightweight heuristic for sessions_spawn that doesn't require
 * loading the full skill registry. It uses domain keywords to infer what
 * capabilities the task likely needs.
 *
 * @param task - The task description from sessions_spawn
 * @returns TaskSkillDetection with domains, capabilities, and synthetic skill
 *
 * @example
 * ```typescript
 * const detection = detectSkillFromTask("Analyze this screenshot and fix the CSS");
 * // {
 * //   domains: ["media", "ui-design", "coding"],
 * //   inferredCapabilities: ["vision", "tool-use"],
 * //   suggestedThinking: "medium",
 * //   confidence: 0.6
 * // }
 * ```
 */
export function detectSkillFromTask(task: string): TaskSkillDetection {
  const detectedDomains = detectDomainsFromMessage(task);
  const domains = Array.from(detectedDomains);

  if (domains.length === 0) {
    return {
      domains: [],
      inferredCapabilities: [],
      confidence: 0,
    };
  }

  // Collect capabilities from detected domains
  const capabilitySet = new Set<ModelCapability>();
  for (const domain of domains) {
    const caps = DOMAIN_CAPABILITIES[domain];
    if (caps) {
      caps.forEach((cap) => capabilitySet.add(cap));
    }
  }
  const inferredCapabilities = Array.from(capabilitySet);

  // Determine suggested thinking level (highest from all domains)
  let suggestedThinking: ThinkingLevel | undefined;
  const thinkingOrder: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  for (const domain of domains) {
    const thinking = DOMAIN_THINKING[domain];
    if (thinking) {
      if (
        !suggestedThinking ||
        thinkingOrder.indexOf(thinking) > thinkingOrder.indexOf(suggestedThinking)
      ) {
        suggestedThinking = thinking;
      }
    }
  }

  // Calculate confidence based on number of domains and keyword matches
  const confidence = Math.min(1.0, domains.length * 0.3);

  // Build synthetic skill entry for model selection
  const syntheticSkill: SkillEntry = {
    skill: {
      name: "task-inferred",
      description: `Inferred from task: ${task.slice(0, 100)}`,
      baseDir: "",
      filePath: "",
      source: "task-inferred",
      disableModelInvocation: true,
    },
    frontmatter: {},
    metadata: buildSyntheticMetadata(
      domains,
      inferredCapabilities,
      suggestedThinking,
    ) as OpenClawSkillMetadata,
  };

  return {
    domains,
    inferredCapabilities,
    suggestedThinking,
    syntheticSkill,
    confidence,
  };
}

/**
 * Detect the best matching skill from a list of skill entries based on task.
 *
 * When skills are available, this finds the best match rather than using
 * the synthetic skill approach.
 *
 * @param task - The task description
 * @param eligibleSkills - Available skill entries
 * @returns Best matching skill entry or undefined if no good match
 */
export function detectBestSkillForTask(
  task: string,
  eligibleSkills: SkillEntry[],
): SkillEntry | undefined {
  if (eligibleSkills.length === 0) {
    return undefined;
  }

  const detectedDomains = detectDomainsFromMessage(task);
  if (detectedDomains.size === 0) {
    return undefined;
  }

  // Score each skill by domain overlap
  let bestSkill: SkillEntry | undefined;
  let bestScore = 0;

  for (const skill of eligibleSkills) {
    const metadata = skill.metadata as Record<string, unknown> | undefined;
    const skillDomains: string[] = Array.isArray(metadata?.domains)
      ? (metadata.domains as string[])
      : [];

    if (skillDomains.length === 0) {
      continue;
    }

    // Count overlapping domains
    const overlap = skillDomains.filter((d) => detectedDomains.has(d)).length;
    const score = overlap / skillDomains.length;

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  // Only return if we have a decent match
  return bestScore >= 0.5 ? bestSkill : undefined;
}
