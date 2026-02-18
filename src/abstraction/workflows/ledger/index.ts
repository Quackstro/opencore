/**
 * T-050: Ledger Plugin — WorkflowSDK Integration
 *
 * Registers all ledger workflows. Covers: budget setup, transaction search,
 * reports, statement import, and bill management.
 *
 * Audit findings: The ledger plugin is primarily tool-based (LLM calls tools
 * on behalf of user). No existing interactive UI flows with buttons were found.
 * Workflows created here add structured multi-step interactions with
 * confirmation steps before data-modifying operations.
 */

import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

export const LEDGER_WORKFLOWS = {
  BUDGET_SETUP: "ledger-budget-setup",
  TRANSACTION_SEARCH: "ledger-transaction-search",
  REPORT: "ledger-report",
  STATEMENT_IMPORT: "ledger-statement-import",
  BILL_MANAGEMENT: "ledger-bill-management",
} as const;

export type LedgerWorkflowId = (typeof LEDGER_WORKFLOWS)[keyof typeof LEDGER_WORKFLOWS];

import budgetSetup from "./budget-setup.json" with { type: "json" };
import transactionSearch from "./transaction-search.json" with { type: "json" };
import report from "./report.json" with { type: "json" };
import statementImport from "./statement-import.json" with { type: "json" };
import billManagement from "./bill-management.json" with { type: "json" };

export function loadLedgerWorkflows(): WorkflowDefinition[] {
  return [
    budgetSetup as unknown as WorkflowDefinition,
    transactionSearch as unknown as WorkflowDefinition,
    report as unknown as WorkflowDefinition,
    statementImport as unknown as WorkflowDefinition,
    billManagement as unknown as WorkflowDefinition,
  ];
}

export function registerLedgerWorkflows(engine: WorkflowEngine) {
  const workflows = loadLedgerWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));
  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Ledger workflow registration failed: ${details}`);
  }
  return results;
}

export async function startLedgerWorkflow(
  engine: WorkflowEngine,
  workflowId: LedgerWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
