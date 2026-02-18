/**
 * T-003: Workflow Definition Validator
 *
 * Validates workflow JSON definitions against the schema + semantic rules:
 * - entryPoint must exist in steps
 * - All transition targets must exist in steps
 * - Each step must have exactly one of: transitions, next, or terminal:true
 * - At least one terminal step
 * - No unreachable steps
 * - Options required for choice/multi-choice
 * - Options max 7 (Miller's Law)
 */

import type { WorkflowDefinition, WorkflowStepDefinition } from "../types/workflow.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateWorkflowDefinition(
  def: WorkflowDefinition,
): ValidationResult {
  const errors: ValidationError[] = [];

  // Required fields
  if (!def.id) {errors.push({ path: "id", message: "id is required" });}
  if (!def.plugin)
    {errors.push({ path: "plugin", message: "plugin is required" });}
  if (!def.version)
    {errors.push({ path: "version", message: "version is required" });}
  if (!def.entryPoint)
    {errors.push({ path: "entryPoint", message: "entryPoint is required" });}
  if (!def.steps || Object.keys(def.steps).length === 0) {
    errors.push({ path: "steps", message: "at least one step is required" });
    return { valid: false, errors };
  }

  const stepIds = new Set(Object.keys(def.steps));

  // entryPoint must exist
  if (!stepIds.has(def.entryPoint)) {
    errors.push({
      path: "entryPoint",
      message: `entryPoint "${def.entryPoint}" does not exist in steps`,
    });
  }

  let hasTerminal = false;
  const allTransitionTargets = new Set<string>();

  for (const [stepId, step] of Object.entries(def.steps)) {
    const prefix = `steps.${stepId}`;

    // Exactly one of: transitions, next, terminal
    const hasTransitions =
      step.transitions && Object.keys(step.transitions).length > 0;
    const hasNext = !!step.next;
    const isTerminal = !!step.terminal;
    const exitCount =
      (hasTransitions ? 1 : 0) + (hasNext ? 1 : 0) + (isTerminal ? 1 : 0);

    if (exitCount === 0) {
      errors.push({
        path: prefix,
        message:
          "step must have one of: transitions, next, or terminal:true",
      });
    }
    if (exitCount > 1) {
      errors.push({
        path: prefix,
        message:
          "step must have exactly one of: transitions, next, or terminal:true",
      });
    }

    if (isTerminal) {hasTerminal = true;}

    // Validate transition targets exist
    if (step.transitions) {
      for (const [key, target] of Object.entries(step.transitions)) {
        allTransitionTargets.add(target);
        if (!stepIds.has(target)) {
          errors.push({
            path: `${prefix}.transitions.${key}`,
            message: `transition target "${target}" does not exist in steps`,
          });
        }
      }
    }

    if (step.next) {
      allTransitionTargets.add(step.next);
      if (!stepIds.has(step.next)) {
        errors.push({
          path: `${prefix}.next`,
          message: `next target "${step.next}" does not exist in steps`,
        });
      }
    }

    // Options required for choice/multi-choice
    if (step.type === "choice" || step.type === "multi-choice") {
      if (!step.options || step.options.length === 0) {
        errors.push({
          path: `${prefix}.options`,
          message: `options required for ${step.type} step`,
        });
      } else if (step.options.length > 7) {
        errors.push({
          path: `${prefix}.options`,
          message: `max 7 options per step (Miller's Law), got ${step.options.length}`,
        });
      }
    }

    // Choice/confirm must have transitions
    if (
      (step.type === "choice" || step.type === "confirm") &&
      !step.transitions &&
      !step.next &&
      !step.terminal
    ) {
      // Already caught above
    }

    // Validate content length
    if (step.content && step.content.length > 2000) {
      errors.push({
        path: `${prefix}.content`,
        message: "content must be ≤ 2000 characters",
      });
    }
  }

  // At least one terminal step
  if (!hasTerminal) {
    errors.push({
      path: "steps",
      message: "at least one step must be terminal",
    });
  }

  // Check for unreachable steps
  if (stepIds.has(def.entryPoint)) {
    const reachable = new Set<string>();
    const queue = [def.entryPoint];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (reachable.has(current)) {continue;}
      reachable.add(current);

      const step = def.steps[current];
      if (!step) {continue;}

      if (step.transitions) {
        for (const target of Object.values(step.transitions)) {
          if (!reachable.has(target)) {queue.push(target);}
        }
      }
      if (step.next && !reachable.has(step.next)) {
        queue.push(step.next);
      }
      if (step.toolCall?.onError && !reachable.has(step.toolCall.onError)) {
        queue.push(step.toolCall.onError);
      }
    }

    for (const stepId of stepIds) {
      if (!reachable.has(stepId)) {
        errors.push({
          path: `steps.${stepId}`,
          message: `step "${stepId}" is unreachable from entryPoint`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
