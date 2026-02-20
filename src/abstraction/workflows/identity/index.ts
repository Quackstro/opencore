/**
 * T-044: Identity Linking Workflows
 *
 * Dogfooding the abstraction layer: the identity linking flow
 * itself is built as an abstracted workflow.
 *
 * Surface A: /link → generate code → display (terminal)
 * Surface B: /link <code> → enter code → confirm → tool call → complete
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

import generateDef from "./generate.json" with { type: "json" };
import linkDef from "./link.json" with { type: "json" };

export const IDENTITY_WORKFLOWS = {
  GENERATE: "identity-link-generate",
  CLAIM: "identity-link-claim",
} as const;

export type IdentityWorkflowId = (typeof IDENTITY_WORKFLOWS)[keyof typeof IDENTITY_WORKFLOWS];

export function loadIdentityWorkflows(): WorkflowDefinition[] {
  return [
    generateDef as unknown as WorkflowDefinition,
    linkDef as unknown as WorkflowDefinition,
  ];
}

export function registerIdentityWorkflows(engine: WorkflowEngine) {
  const workflows = loadIdentityWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));

  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Identity workflow registration failed: ${details}`);
  }

  return results;
}

export async function startIdentityWorkflow(
  engine: WorkflowEngine,
  workflowId: IdentityWorkflowId,
  userId: string,
  surface: SurfaceTarget,
) {
  return engine.startWorkflow(workflowId, userId, surface);
}
