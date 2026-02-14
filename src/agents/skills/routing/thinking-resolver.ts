/**
 * Thinking Level Resolver
 *
 * Resolves thinking levels based on skill overrides. Skills can declare
 * a preferred thinking level that is automatically applied based on
 * the override mode.
 *
 * Override modes:
 * - minimum: Upgrade if current level is lower
 * - maximum: Cap if current level is higher
 * - exact: Always use skill's level
 * - suggest: Provide hint but don't change level (default)
 *
 * @module agents/skills/routing/thinking-resolver
 */

import type { SkillEntry } from "../types.js";

/**
 * Valid thinking levels in order from lowest to highest intensity.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Thinking override mode determining how the skill's level is applied.
 */
export type ThinkingOverrideMode = "minimum" | "maximum" | "exact" | "suggest";

/**
 * Ordered array of thinking levels for comparison.
 * Index represents intensity (0 = off, 5 = xhigh).
 */
export const THINKING_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Result of thinking level resolution.
 */
export interface ThinkingResolution {
  /** The resolved thinking level to use */
  level: ThinkingLevel;
  /** Human-readable reason for the resolution */
  reason: string;
  /** Optional hint when suggest mode is used */
  hint?: string;
  /** Whether the level was changed from the current */
  changed: boolean;
  /** The skill that triggered the change (if any) */
  skillName?: string;
}

/**
 * Check if a string is a valid thinking level.
 *
 * @param value - The value to check
 * @returns true if the value is a valid ThinkingLevel
 */
export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_ORDER.includes(value as ThinkingLevel);
}

/**
 * Check if a string is a valid thinking override mode.
 *
 * @param value - The value to check
 * @returns true if the value is a valid ThinkingOverrideMode
 */
export function isValidThinkingOverrideMode(value: unknown): value is ThinkingOverrideMode {
  return typeof value === "string" && ["minimum", "maximum", "exact", "suggest"].includes(value);
}

/**
 * Compare two thinking levels.
 *
 * @param a - First thinking level
 * @param b - Second thinking level
 * @returns Negative if a < b, positive if a > b, 0 if equal
 */
export function compareLevels(a: ThinkingLevel, b: ThinkingLevel): number {
  return THINKING_ORDER.indexOf(a) - THINKING_ORDER.indexOf(b);
}

/**
 * Get the higher of two thinking levels.
 *
 * @param a - First thinking level
 * @param b - Second thinking level
 * @returns The higher level
 */
export function maxLevel(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
  return compareLevels(a, b) >= 0 ? a : b;
}

/**
 * Get the lower of two thinking levels.
 *
 * @param a - First thinking level
 * @param b - Second thinking level
 * @returns The lower level
 */
export function minLevel(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
  return compareLevels(a, b) <= 0 ? a : b;
}

/**
 * Extract thinking override metadata from a skill entry.
 *
 * @param skill - The skill entry
 * @returns Object with thinkingOverride and thinkingOverrideMode, or undefined values
 */
function extractThinkingMetadata(skill: SkillEntry | undefined): {
  override?: ThinkingLevel;
  mode: ThinkingOverrideMode;
} {
  if (!skill?.metadata) {
    return { override: undefined, mode: "suggest" };
  }

  const metadata = skill.metadata as Record<string, unknown>;
  const override = isValidThinkingLevel(metadata.thinkingOverride)
    ? metadata.thinkingOverride
    : undefined;
  const mode = isValidThinkingOverrideMode(metadata.thinkingOverrideMode)
    ? metadata.thinkingOverrideMode
    : "suggest";

  return { override, mode };
}

/**
 * Resolve the thinking level based on current level and skill override.
 *
 * This function implements the thinking level resolution logic:
 * - minimum mode: Upgrades current level if skill's level is higher
 * - maximum mode: Caps current level if skill's level is lower
 * - exact mode: Always uses skill's level (highest priority)
 * - suggest mode: Returns current level with a hint (no change)
 *
 * @param currentLevel - The current thinking level
 * @param skill - The skill entry (may be undefined)
 * @returns ThinkingResolution with the resolved level and metadata
 *
 * @example
 * ```typescript
 * // Minimum mode - upgrades when needed
 * resolveThinkingWithSkill("low", archSkill);  // { level: "high", changed: true, ... }
 *
 * // Maximum mode - caps when needed
 * resolveThinkingWithSkill("high", quickSkill);  // { level: "low", changed: true, ... }
 *
 * // Suggest mode - hint only
 * resolveThinkingWithSkill("off", hintSkill);  // { level: "off", hint: "...", changed: false }
 * ```
 */
export function resolveThinkingWithSkill(
  currentLevel: ThinkingLevel,
  skill: SkillEntry | undefined,
): ThinkingResolution {
  // No skill or no metadata - return current level unchanged
  if (!skill) {
    return {
      level: currentLevel,
      reason: "no skill provided",
      changed: false,
    };
  }

  const { override, mode } = extractThinkingMetadata(skill);
  const skillName = skill.skill.name;

  // No thinking override defined
  if (!override) {
    return {
      level: currentLevel,
      reason: "no skill override",
      changed: false,
    };
  }

  switch (mode) {
    case "exact":
      // Always use skill's level
      return {
        level: override,
        reason: `skill "${skillName}" requires ${override} thinking`,
        changed: override !== currentLevel,
        skillName,
      };

    case "minimum":
      // Upgrade if current is lower than override
      if (compareLevels(currentLevel, override) < 0) {
        return {
          level: override,
          reason: `upgraded to ${override} for skill "${skillName}"`,
          changed: true,
          skillName,
        };
      }
      return {
        level: currentLevel,
        reason: `current level ${currentLevel} meets minimum ${override}`,
        changed: false,
        skillName,
      };

    case "maximum":
      // Cap if current is higher than override
      if (compareLevels(currentLevel, override) > 0) {
        return {
          level: override,
          reason: `capped to ${override} for skill "${skillName}"`,
          changed: true,
          skillName,
        };
      }
      return {
        level: currentLevel,
        reason: `current level ${currentLevel} within maximum ${override}`,
        changed: false,
        skillName,
      };

    case "suggest":
    default:
      // Return current level with a hint
      return {
        level: currentLevel,
        reason: "skill suggests different level",
        hint: `Skill "${skillName}" suggests ${override} thinking for best results`,
        changed: false,
        skillName,
      };
  }
}

/**
 * Resolve thinking level across multiple skills.
 *
 * When multiple skills are involved (e.g., routing selected multiple skills),
 * this function combines their thinking requirements:
 * - exact mode has highest priority (first exact wins)
 * - minimum modes are combined (highest minimum wins)
 * - maximum modes are combined (lowest maximum wins)
 * - suggest modes are collected as hints
 *
 * @param currentLevel - The current thinking level
 * @param skills - Array of skill entries
 * @returns ThinkingResolution with combined resolution
 */
export function resolveThinkingWithSkills(
  currentLevel: ThinkingLevel,
  skills: SkillEntry[],
): ThinkingResolution {
  if (skills.length === 0) {
    return {
      level: currentLevel,
      reason: "no skills provided",
      changed: false,
    };
  }

  // Check for exact override first (highest priority)
  for (const skill of skills) {
    const { override, mode } = extractThinkingMetadata(skill);
    if (override && mode === "exact") {
      return {
        level: override,
        reason: `skill "${skill.skill.name}" requires ${override} thinking (exact)`,
        changed: override !== currentLevel,
        skillName: skill.skill.name,
      };
    }
  }

  // Collect all minimum and maximum constraints
  let effectiveMinimum: ThinkingLevel = "off";
  let effectiveMaximum: ThinkingLevel = "xhigh";
  const hints: string[] = [];
  const minimumSkills: string[] = [];
  const maximumSkills: string[] = [];

  for (const skill of skills) {
    const { override, mode } = extractThinkingMetadata(skill);
    if (!override) continue;

    switch (mode) {
      case "minimum":
        if (compareLevels(override, effectiveMinimum) > 0) {
          effectiveMinimum = override;
        }
        minimumSkills.push(skill.skill.name);
        break;
      case "maximum":
        if (compareLevels(override, effectiveMaximum) < 0) {
          effectiveMaximum = override;
        }
        maximumSkills.push(skill.skill.name);
        break;
      case "suggest":
        hints.push(`${skill.skill.name} suggests ${override}`);
        break;
    }
  }

  // Check for conflicting constraints
  if (compareLevels(effectiveMinimum, effectiveMaximum) > 0) {
    // Minimum > Maximum is a conflict; prioritize minimum (upgrade takes precedence)
    return {
      level: effectiveMinimum,
      reason: `conflicting constraints; using minimum ${effectiveMinimum} (from ${minimumSkills.join(", ")})`,
      hint: `Maximum ${effectiveMaximum} (from ${maximumSkills.join(", ")}) was lower than minimum`,
      changed: effectiveMinimum !== currentLevel,
      skillName: minimumSkills[0],
    };
  }

  // Apply constraints to current level
  let resolvedLevel = currentLevel;
  let reason = "no override applied";
  let changed = false;
  let skillName: string | undefined;

  // Apply minimum constraint (upgrade if needed)
  if (compareLevels(currentLevel, effectiveMinimum) < 0) {
    resolvedLevel = effectiveMinimum;
    reason = `upgraded to ${effectiveMinimum} (minimum from ${minimumSkills.join(", ")})`;
    changed = true;
    skillName = minimumSkills[0];
  }

  // Apply maximum constraint (cap if needed)
  if (compareLevels(resolvedLevel, effectiveMaximum) > 0) {
    resolvedLevel = effectiveMaximum;
    reason = `capped to ${effectiveMaximum} (maximum from ${maximumSkills.join(", ")})`;
    changed = true;
    skillName = maximumSkills[0];
  }

  // Combine hints if any
  const hint = hints.length > 0 ? hints.join("; ") : undefined;

  return {
    level: resolvedLevel,
    reason,
    hint,
    changed,
    skillName,
  };
}
