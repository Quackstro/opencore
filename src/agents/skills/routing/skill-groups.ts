/**
 * Skill Groups
 *
 * Allows defining bundles of skills that activate together.
 * When any skill in a group is selected, optionally include all group members.
 * Groups can also be triggered by domain detection.
 *
 * @module agents/skills/routing/skill-groups
 */

import { createSubsystemLogger } from "../../../logging/subsystem.js";

const groupLogger = createSubsystemLogger("skills-groups");

/**
 * A skill group definition.
 */
export interface SkillGroup {
  /** Unique identifier for the group */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Skill names in this group */
  skills: string[];
  /** Domains that trigger this group */
  domains?: string[];
  /** Minimum confidence to activate (default: 0.5) */
  activationThreshold?: number;
  /** Whether to expand all skills when one is selected (default: true) */
  expandOnSelect?: boolean;
}

/**
 * Configuration for skill groups.
 */
export interface SkillGroupConfig {
  /** Defined groups */
  groups: SkillGroup[];
  /** Whether skill groups feature is enabled */
  enabled: boolean;
  /** Whether to auto-expand groups when one member is selected */
  autoExpand?: boolean;
  /** Whether to activate groups based on detected domains */
  activateByDomain?: boolean;
}

/**
 * Result of group expansion.
 */
export interface GroupExpansionResult {
  /** Final list of skills after expansion */
  skills: string[];
  /** Groups that were expanded */
  expandedGroups: string[];
  /** Skills that were added by expansion */
  addedSkills: string[];
}

/**
 * Default skill group configuration.
 */
export const DEFAULT_SKILL_GROUP_CONFIG: SkillGroupConfig = {
  groups: [],
  enabled: false,
  autoExpand: true,
  activateByDomain: true,
};

/**
 * Common skill group presets that can be used as starting points.
 */
export const SKILL_GROUP_PRESETS: Record<string, SkillGroup> = {
  "full-stack": {
    id: "full-stack",
    name: "Full-Stack Development",
    description: "Complete web development skill set",
    skills: ["claude-code", "github", "docker"],
    domains: ["coding", "devops"],
    activationThreshold: 0.5,
  },
  "legal-suite": {
    id: "legal-suite",
    name: "Legal Suite",
    description: "Legal document and contract skills",
    skills: ["paralegal", "contract-review", "compliance"],
    domains: ["legal"],
    activationThreshold: 0.6,
  },
  "data-analysis": {
    id: "data-analysis",
    name: "Data Analysis",
    description: "Data processing and visualization",
    skills: ["pandas", "sql", "charts"],
    domains: ["data"],
    activationThreshold: 0.5,
  },
  "media-production": {
    id: "media-production",
    name: "Media Production",
    description: "Image, video, and audio skills",
    skills: ["dall-e", "midjourney", "tts"],
    domains: ["media"],
    activationThreshold: 0.5,
  },
};

/**
 * Find groups that contain a specific skill.
 *
 * @param skillName - Name of the skill to find groups for
 * @param groups - List of skill groups
 * @returns Groups containing the skill
 */
export function findGroupsContainingSkill(skillName: string, groups: SkillGroup[]): SkillGroup[] {
  return groups.filter((group) =>
    group.skills.some((s) => s.toLowerCase() === skillName.toLowerCase()),
  );
}

/**
 * Expand selected skills to include all members of their groups.
 *
 * When a skill is selected and belongs to a group, this function can
 * optionally include all other skills in that group.
 *
 * @param selectedSkills - Initially selected skill names
 * @param groups - Skill group definitions
 * @param config - Skill group configuration
 * @returns Expanded list of skills
 */
export function expandSkillGroups(
  selectedSkills: string[],
  groups: SkillGroup[],
  config: SkillGroupConfig,
): GroupExpansionResult {
  if (!config.enabled || !config.autoExpand || groups.length === 0) {
    return {
      skills: selectedSkills,
      expandedGroups: [],
      addedSkills: [],
    };
  }

  const selectedSet = new Set(selectedSkills.map((s) => s.toLowerCase()));
  const expandedGroups: string[] = [];
  const addedSkills: string[] = [];

  // Find groups where at least one member is selected
  for (const group of groups) {
    // Skip groups that don't expand on select
    if (group.expandOnSelect === false) {
      continue;
    }

    // Check if any skill in this group is selected
    const hasSelectedMember = group.skills.some((skill) => selectedSet.has(skill.toLowerCase()));

    if (hasSelectedMember) {
      // Add all group members
      for (const skill of group.skills) {
        if (!selectedSet.has(skill.toLowerCase())) {
          selectedSet.add(skill.toLowerCase());
          addedSkills.push(skill);
        }
      }
      expandedGroups.push(group.id);
    }
  }

  if (expandedGroups.length > 0) {
    groupLogger.debug("skill-groups-expanded", {
      expandedGroups,
      addedSkills,
      originalCount: selectedSkills.length,
      finalCount: selectedSet.size,
    });
  }

  // Return skills in original casing (use original if available, otherwise added)
  const finalSkills = [
    ...selectedSkills,
    ...addedSkills.filter(
      (s) => !selectedSkills.some((orig) => orig.toLowerCase() === s.toLowerCase()),
    ),
  ];

  return {
    skills: finalSkills,
    expandedGroups,
    addedSkills,
  };
}

/**
 * Detect groups that should activate based on detected domains.
 *
 * @param domains - Detected domain names
 * @param groups - Skill group definitions
 * @param minConfidence - Minimum confidence threshold (optional, uses group's threshold)
 * @returns Groups that match the domains
 */
export function detectGroupsFromDomains(
  domains: string[],
  groups: SkillGroup[],
  minConfidence?: number,
): SkillGroup[] {
  if (domains.length === 0 || groups.length === 0) {
    return [];
  }

  const domainSet = new Set(domains.map((d) => d.toLowerCase()));
  const matchedGroups: SkillGroup[] = [];

  for (const group of groups) {
    if (!group.domains || group.domains.length === 0) {
      continue;
    }

    // Check if any group domain matches detected domains
    const matchingDomains = group.domains.filter((d) => domainSet.has(d.toLowerCase()));

    if (matchingDomains.length > 0) {
      // Calculate match confidence based on overlap
      const overlapRatio = matchingDomains.length / group.domains.length;
      const threshold = minConfidence ?? group.activationThreshold ?? 0.5;

      if (overlapRatio >= threshold) {
        matchedGroups.push(group);
      }
    }
  }

  if (matchedGroups.length > 0) {
    groupLogger.debug("skill-groups-detected-from-domains", {
      domains,
      matchedGroups: matchedGroups.map((g) => g.id),
    });
  }

  return matchedGroups;
}

/**
 * Get all skills that should be activated based on detected domains.
 *
 * This combines domain-based group detection with skill expansion.
 *
 * @param domains - Detected domain names
 * @param groups - Skill group definitions
 * @param config - Skill group configuration
 * @returns Skills to activate from domain-matched groups
 */
export function getSkillsFromDomains(
  domains: string[],
  groups: SkillGroup[],
  config: SkillGroupConfig,
): string[] {
  if (!config.enabled || !config.activateByDomain) {
    return [];
  }

  const matchedGroups = detectGroupsFromDomains(domains, groups);
  const skills = new Set<string>();

  for (const group of matchedGroups) {
    for (const skill of group.skills) {
      skills.add(skill);
    }
  }

  return Array.from(skills);
}

/**
 * Merge multiple group configurations.
 *
 * @param configs - Array of partial configurations to merge
 * @returns Merged configuration
 */
export function mergeGroupConfigs(...configs: Partial<SkillGroupConfig>[]): SkillGroupConfig {
  const result: SkillGroupConfig = { ...DEFAULT_SKILL_GROUP_CONFIG };
  const allGroups = new Map<string, SkillGroup>();

  for (const config of configs) {
    if (config.enabled !== undefined) {
      result.enabled = config.enabled;
    }
    if (config.autoExpand !== undefined) {
      result.autoExpand = config.autoExpand;
    }
    if (config.activateByDomain !== undefined) {
      result.activateByDomain = config.activateByDomain;
    }
    if (config.groups) {
      for (const group of config.groups) {
        allGroups.set(group.id, group);
      }
    }
  }

  result.groups = Array.from(allGroups.values());
  return result;
}

/**
 * Validate a skill group definition.
 *
 * @param group - Group to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateSkillGroup(group: SkillGroup): string[] {
  const errors: string[] = [];

  if (!group.id || typeof group.id !== "string" || group.id.trim() === "") {
    errors.push("Group must have a non-empty id");
  }

  if (!group.name || typeof group.name !== "string" || group.name.trim() === "") {
    errors.push("Group must have a non-empty name");
  }

  if (!Array.isArray(group.skills) || group.skills.length === 0) {
    errors.push("Group must have at least one skill");
  }

  if (
    group.activationThreshold !== undefined &&
    (typeof group.activationThreshold !== "number" ||
      group.activationThreshold < 0 ||
      group.activationThreshold > 1)
  ) {
    errors.push("activationThreshold must be a number between 0 and 1");
  }

  return errors;
}

/**
 * Validate a full skill group configuration.
 *
 * @param config - Configuration to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateSkillGroupConfig(config: SkillGroupConfig): string[] {
  const errors: string[] = [];

  if (typeof config.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }

  if (!Array.isArray(config.groups)) {
    errors.push("groups must be an array");
    return errors;
  }

  // Check for duplicate group IDs
  const ids = new Set<string>();
  for (const group of config.groups) {
    if (ids.has(group.id)) {
      errors.push(`Duplicate group id: ${group.id}`);
    }
    ids.add(group.id);

    const groupErrors = validateSkillGroup(group);
    errors.push(...groupErrors.map((e) => `Group "${group.id}": ${e}`));
  }

  return errors;
}
