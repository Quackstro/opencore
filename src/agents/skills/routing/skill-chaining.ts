/**
 * Skill Chaining
 *
 * Skills can declare dependencies that auto-spawn prerequisite skills.
 * Provides dependency resolution, circular dependency detection, and
 * execution ordering.
 *
 * @module agents/skills/routing/skill-chaining
 */

import type { SkillEntry } from "../types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const chainingLogger = createSubsystemLogger("skills-chaining");

/**
 * Execution sequence for dependencies.
 */
export type DependencySequence = "before" | "after" | "parallel";

/**
 * Skill dependency declaration.
 */
export interface SkillDependency {
  /** Name of the skill that has dependencies */
  skillName: string;
  /** Required prerequisite skill names */
  requires: string[];
  /** Optional nice-to-have skills */
  optional?: string[];
  /** Execution order relative to the main skill */
  sequence?: DependencySequence;
}

/**
 * Result of dependency chain resolution.
 */
export interface DependencyChain {
  /** Full chain of skills in execution order */
  chain: string[];
  /** Execution order for each skill (lower = earlier) */
  order: Map<string, number>;
  /** Skills that were marked as optional but not found */
  missingOptional: string[];
  /** Skills that were required but not found */
  missingRequired: string[];
}

/**
 * Result of circular dependency detection.
 */
export interface CircularDependencyResult {
  /** Whether circular dependencies were found */
  hasCircular: boolean;
  /** List of detected cycles (each cycle is a path of skill names) */
  cycles: string[][];
}

/**
 * Extract dependencies from a skill entry's metadata.
 *
 * @param skill - Skill entry to extract dependencies from
 * @returns Dependency declaration or null if none declared
 */
export function extractDependencies(skill: SkillEntry): SkillDependency | null {
  const metadata = skill.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return null;
  }

  // Check for dependencies in metadata.dependencies
  const deps = metadata.dependencies as Record<string, unknown> | undefined;
  if (!deps) {
    return null;
  }

  const requires = deps.requires;
  const optional = deps.optional;
  const sequence = deps.sequence;

  // Validate requires
  if (!Array.isArray(requires) || requires.length === 0) {
    return null;
  }

  // All elements must be strings
  const validRequires = requires.filter((r): r is string => typeof r === "string");
  if (validRequires.length === 0) {
    return null;
  }

  const result: SkillDependency = {
    skillName: skill.skill.name,
    requires: validRequires,
  };

  // Add optional if present
  if (Array.isArray(optional)) {
    result.optional = optional.filter((o): o is string => typeof o === "string");
  }

  // Add sequence if valid
  if (sequence === "before" || sequence === "after" || sequence === "parallel") {
    result.sequence = sequence;
  }

  return result;
}

/**
 * Build a dependency map from skill entries.
 *
 * @param skills - All available skill entries
 * @returns Map of skill name to dependencies
 */
export function buildDependencyMap(skills: SkillEntry[]): Map<string, SkillDependency> {
  const map = new Map<string, SkillDependency>();

  for (const skill of skills) {
    const deps = extractDependencies(skill);
    if (deps) {
      map.set(skill.skill.name.toLowerCase(), deps);
    }
  }

  return map;
}

/**
 * Resolve the full dependency chain for a target skill.
 *
 * Uses depth-first traversal to find all dependencies, respecting
 * the execution order (before/after/parallel).
 *
 * @param targetSkill - The skill to resolve dependencies for
 * @param allSkills - All available skill entries
 * @param maxDepth - Maximum depth to prevent infinite loops (default: 5)
 * @returns Dependency chain with execution order
 */
export function resolveDependencyChain(
  targetSkill: string,
  allSkills: SkillEntry[],
  maxDepth: number = 5,
): DependencyChain {
  const targetLower = targetSkill.toLowerCase();
  const skillMap = new Map<string, SkillEntry>();
  const depMap = buildDependencyMap(allSkills);

  // Build skill lookup map
  for (const skill of allSkills) {
    skillMap.set(skill.skill.name.toLowerCase(), skill);
  }

  const visited = new Set<string>();
  const chain: string[] = [];
  const order = new Map<string, number>();
  const missingOptional: string[] = [];
  const missingRequired: string[] = [];

  /**
   * Recursive dependency resolution with topological sorting.
   */
  function visit(skillName: string, depth: number, currentOrder: number): number {
    if (depth > maxDepth) {
      chainingLogger.warn("skill-dependency-max-depth", { skillName, maxDepth });
      return currentOrder;
    }

    const skillLower = skillName.toLowerCase();

    // Skip if already visited
    if (visited.has(skillLower)) {
      return currentOrder;
    }

    visited.add(skillLower);

    // Get dependencies for this skill
    const deps = depMap.get(skillLower);
    let orderCounter = currentOrder;

    if (deps) {
      const sequence = deps.sequence ?? "before";

      // Process required dependencies
      for (const req of deps.requires) {
        const reqLower = req.toLowerCase();
        if (!skillMap.has(reqLower)) {
          missingRequired.push(req);
          continue;
        }

        if (!visited.has(reqLower)) {
          if (sequence === "before") {
            // Dependencies run first, so visit them before adding to chain
            orderCounter = visit(req, depth + 1, orderCounter);
          }
        }
      }

      // Process optional dependencies
      for (const opt of deps.optional ?? []) {
        const optLower = opt.toLowerCase();
        if (!skillMap.has(optLower)) {
          missingOptional.push(opt);
          continue;
        }

        if (!visited.has(optLower)) {
          if (sequence === "before") {
            orderCounter = visit(opt, depth + 1, orderCounter);
          }
        }
      }
    }

    // Add this skill to the chain
    chain.push(skillName);
    order.set(skillLower, orderCounter);
    orderCounter++;

    // Process "after" dependencies
    if (deps && deps.sequence === "after") {
      for (const req of deps.requires) {
        if (!visited.has(req.toLowerCase()) && skillMap.has(req.toLowerCase())) {
          orderCounter = visit(req, depth + 1, orderCounter);
        }
      }
      for (const opt of deps.optional ?? []) {
        if (!visited.has(opt.toLowerCase()) && skillMap.has(opt.toLowerCase())) {
          orderCounter = visit(opt, depth + 1, orderCounter);
        }
      }
    }

    return orderCounter;
  }

  // Start resolution from target skill
  if (skillMap.has(targetLower)) {
    visit(targetSkill, 0, 0);
  } else {
    missingRequired.push(targetSkill);
  }

  chainingLogger.debug("skill-dependency-chain-resolved", {
    targetSkill,
    chain,
    missingRequired,
    missingOptional,
  });

  return {
    chain,
    order,
    missingOptional,
    missingRequired,
  };
}

/**
 * Detect circular dependencies in skill definitions.
 *
 * Uses DFS-based cycle detection to find all cycles.
 *
 * @param skills - All skill entries to check
 * @returns Detection result with list of cycles
 */
export function detectCircularDependencies(skills: SkillEntry[]): CircularDependencyResult {
  const depMap = buildDependencyMap(skills);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  /**
   * DFS cycle detection.
   */
  function dfs(skillName: string): void {
    const skillLower = skillName.toLowerCase();

    if (recursionStack.has(skillLower)) {
      // Found a cycle - extract the cycle path
      const cycleStart = path.indexOf(skillName);
      if (cycleStart !== -1) {
        const cycle = [...path.slice(cycleStart), skillName];
        cycles.push(cycle);
      }
      return;
    }

    if (visited.has(skillLower)) {
      return;
    }

    visited.add(skillLower);
    recursionStack.add(skillLower);
    path.push(skillName);

    const deps = depMap.get(skillLower);
    if (deps) {
      for (const req of deps.requires) {
        dfs(req);
      }
      for (const opt of deps.optional ?? []) {
        dfs(opt);
      }
    }

    path.pop();
    recursionStack.delete(skillLower);
  }

  // Check all skills
  for (const skill of skills) {
    if (!visited.has(skill.skill.name.toLowerCase())) {
      dfs(skill.skill.name);
    }
  }

  if (cycles.length > 0) {
    chainingLogger.warn("skill-circular-dependencies-detected", {
      cycleCount: cycles.length,
      cycles,
    });
  }

  return {
    hasCircular: cycles.length > 0,
    cycles,
  };
}

/**
 * Get all skills that depend on a given skill.
 *
 * Useful for understanding the impact of removing or modifying a skill.
 *
 * @param skillName - Skill to find dependents for
 * @param skills - All skill entries
 * @returns Array of skill names that depend on the given skill
 */
export function getDependents(skillName: string, skills: SkillEntry[]): string[] {
  const skillLower = skillName.toLowerCase();
  const dependents: string[] = [];

  for (const skill of skills) {
    const deps = extractDependencies(skill);
    if (!deps) continue;

    const allDeps = [...deps.requires, ...(deps.optional ?? [])];
    if (allDeps.some((d) => d.toLowerCase() === skillLower)) {
      dependents.push(skill.skill.name);
    }
  }

  return dependents;
}

/**
 * Validate dependency declarations for all skills.
 *
 * @param skills - All skill entries to validate
 * @returns Array of validation warnings
 */
export function validateDependencies(skills: SkillEntry[]): string[] {
  const warnings: string[] = [];
  const skillNames = new Set(skills.map((s) => s.skill.name.toLowerCase()));

  for (const skill of skills) {
    const deps = extractDependencies(skill);
    if (!deps) continue;

    // Check required dependencies exist
    for (const req of deps.requires) {
      if (!skillNames.has(req.toLowerCase())) {
        warnings.push(`Skill "${skill.skill.name}": required dependency "${req}" not found`);
      }
    }

    // Check optional dependencies exist (just warn)
    for (const opt of deps.optional ?? []) {
      if (!skillNames.has(opt.toLowerCase())) {
        warnings.push(`Skill "${skill.skill.name}": optional dependency "${opt}" not found`);
      }
    }

    // Check for self-dependency
    if (deps.requires.some((r) => r.toLowerCase() === skill.skill.name.toLowerCase())) {
      warnings.push(`Skill "${skill.skill.name}": depends on itself`);
    }
  }

  // Check for circular dependencies
  const circularResult = detectCircularDependencies(skills);
  if (circularResult.hasCircular) {
    for (const cycle of circularResult.cycles) {
      warnings.push(`Circular dependency detected: ${cycle.join(" → ")}`);
    }
  }

  return warnings;
}

/**
 * Get the execution plan for a set of skills.
 *
 * Resolves all dependencies and returns a flat list of skills
 * in execution order.
 *
 * @param targetSkills - Skills to execute
 * @param allSkills - All available skills
 * @returns Ordered list of skills to execute
 */
export function getExecutionPlan(targetSkills: string[], allSkills: SkillEntry[]): string[] {
  const allInPlan = new Set<string>();
  const orderMap = new Map<string, number>();

  for (const target of targetSkills) {
    const chain = resolveDependencyChain(target, allSkills);

    for (const skill of chain.chain) {
      const skillLower = skill.toLowerCase();
      allInPlan.add(skill);

      // Take the earliest order for each skill
      const existingOrder = orderMap.get(skillLower);
      const newOrder = chain.order.get(skillLower) ?? Number.MAX_SAFE_INTEGER;
      if (existingOrder === undefined || newOrder < existingOrder) {
        orderMap.set(skillLower, newOrder);
      }
    }
  }

  // Sort by order
  const plan = Array.from(allInPlan).sort((a, b) => {
    const orderA = orderMap.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const orderB = orderMap.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });

  chainingLogger.debug("skill-execution-plan", {
    targets: targetSkills,
    plan,
  });

  return plan;
}

/**
 * Merge dependency configurations.
 *
 * @param base - Base dependencies
 * @param override - Override dependencies
 * @returns Merged dependencies
 */
export function mergeDependencies(
  base: SkillDependency,
  override: Partial<SkillDependency>,
): SkillDependency {
  return {
    skillName: override.skillName ?? base.skillName,
    requires: [...new Set([...base.requires, ...(override.requires ?? [])])],
    optional: [...new Set([...(base.optional ?? []), ...(override.optional ?? [])])],
    sequence: override.sequence ?? base.sequence,
  };
}
