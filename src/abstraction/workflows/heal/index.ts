/**
 * T-051: Heal Plugin — WorkflowSDK Integration
 *
 * Audit findings: The heal plugin is primarily tool-based with no existing
 * interactive UI. Workflows created add structured health check selection
 * and confirmation before repair operations.
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

export const HEAL_WORKFLOWS = {
  HEALTH_CHECK: "heal-health-check",
  REPAIR: "heal-repair",
} as const;

export type HealWorkflowId = (typeof HEAL_WORKFLOWS)[keyof typeof HEAL_WORKFLOWS];

import healthCheck from "./health-check.json" with { type: "json" };
import repair from "./repair.json" with { type: "json" };

export function loadHealWorkflows(): WorkflowDefinition[] {
  return [
    healthCheck as unknown as WorkflowDefinition,
    repair as unknown as WorkflowDefinition,
  ];
}

export function registerHealWorkflows(engine: WorkflowEngine) {
  const workflows = loadHealWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));
  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Heal workflow registration failed: ${details}`);
  }
  return results;
}

export async function startHealWorkflow(
  engine: WorkflowEngine,
  workflowId: HealWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
