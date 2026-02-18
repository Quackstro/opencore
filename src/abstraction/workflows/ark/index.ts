/**
 * T-052: Ark Plugin — WorkflowSDK Integration
 *
 * Audit findings: The ark (backup) plugin is tool-based. Backup/restore are
 * destructive operations, so workflows add confirmation steps and passphrase
 * collection. Status check is a simple info workflow.
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

export const ARK_WORKFLOWS = {
  BACKUP: "ark-backup",
  RESTORE: "ark-restore",
  STATUS: "ark-status",
} as const;

export type ArkWorkflowId = (typeof ARK_WORKFLOWS)[keyof typeof ARK_WORKFLOWS];

import backup from "./backup.json" with { type: "json" };
import restore from "./restore.json" with { type: "json" };
import status from "./status.json" with { type: "json" };

export function loadArkWorkflows(): WorkflowDefinition[] {
  return [
    backup as unknown as WorkflowDefinition,
    restore as unknown as WorkflowDefinition,
    status as unknown as WorkflowDefinition,
  ];
}

export function registerArkWorkflows(engine: WorkflowEngine) {
  const workflows = loadArkWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));
  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Ark workflow registration failed: ${details}`);
  }
  return results;
}

export async function startArkWorkflow(
  engine: WorkflowEngine,
  workflowId: ArkWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
