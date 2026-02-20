/**
 * T-054: OpenCore Plugin — WorkflowSDK Integration
 *
 * Audit findings: OpenCore management is tool-based. Workflows add structured
 * interactions for status check, update (with confirmation), and config
 * management (view/set with confirmation/channel setup).
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

export const OPENCORE_WORKFLOWS = {
  STATUS: "opencore-status",
  UPDATE: "opencore-update",
  CONFIG: "opencore-config",
} as const;

export type OpencoreWorkflowId = (typeof OPENCORE_WORKFLOWS)[keyof typeof OPENCORE_WORKFLOWS];

import status from "./status.json" with { type: "json" };
import update from "./update.json" with { type: "json" };
import config from "./config.json" with { type: "json" };

export function loadOpencoreWorkflows(): WorkflowDefinition[] {
  return [
    status as unknown as WorkflowDefinition,
    update as unknown as WorkflowDefinition,
    config as unknown as WorkflowDefinition,
  ];
}

export function registerOpencoreWorkflows(engine: WorkflowEngine) {
  const workflows = loadOpencoreWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));
  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`OpenCore workflow registration failed: ${details}`);
  }
  return results;
}

export async function startOpencoreWorkflow(
  engine: WorkflowEngine,
  workflowId: OpencoreWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
