/**
 * T-053: Brain Plugin — WorkflowSDK Integration
 *
 * Audit findings: Brain plugin is tool-based. Workflows add structured
 * interactions for drop (thought capture), search, fix (with confirmation
 * for trash), and DND toggle.
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

export const BRAIN_WORKFLOWS = {
  DROP: "brain-drop",
  SEARCH: "brain-search",
  FIX: "brain-fix",
  DND: "brain-dnd",
} as const;

export type BrainWorkflowId = (typeof BRAIN_WORKFLOWS)[keyof typeof BRAIN_WORKFLOWS];

import drop from "./drop.json" with { type: "json" };
import search from "./search.json" with { type: "json" };
import fix from "./fix.json" with { type: "json" };
import dnd from "./dnd.json" with { type: "json" };

export function loadBrainWorkflows(): WorkflowDefinition[] {
  return [
    drop as unknown as WorkflowDefinition,
    search as unknown as WorkflowDefinition,
    fix as unknown as WorkflowDefinition,
    dnd as unknown as WorkflowDefinition,
  ];
}

export function registerBrainWorkflows(engine: WorkflowEngine) {
  const workflows = loadBrainWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));
  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Brain workflow registration failed: ${details}`);
  }
  return results;
}

export async function startBrainWorkflow(
  engine: WorkflowEngine,
  workflowId: BrainWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
