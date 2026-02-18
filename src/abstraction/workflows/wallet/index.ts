/**
 * T-033: Wallet Plugin — WorkflowSDK Integration
 *
 * Registers all wallet workflows and provides an entry point.
 * Imports ONLY from the abstraction layer — no surface-specific code.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition } from "../../types/workflow.js";
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

// ─── Workflow IDs ───────────────────────────────────────────────────────────

export const WALLET_WORKFLOWS = {
  ONBOARDING: "wallet-onboarding",
  SEND: "wallet-send",
  BALANCE: "wallet-balance",
  HISTORY: "wallet-history",
  INVOICE: "wallet-invoice",
  VERIFY_PAYMENT: "wallet-verify-payment",
} as const;

export type WalletWorkflowId = (typeof WALLET_WORKFLOWS)[keyof typeof WALLET_WORKFLOWS];

// ─── Inline workflow definitions ────────────────────────────────────────────
// Loaded at module evaluation time. In production these would be read from
// the JSON files. For compatibility with all runtimes (ESM, CJS, Vitest)
// we also export a loadWalletWorkflows() that takes an explicit directory.

import onboarding from "./onboarding.json" with { type: "json" };
import send from "./send.json" with { type: "json" };
import balance from "./balance.json" with { type: "json" };
import history from "./history.json" with { type: "json" };
import invoice from "./invoice.json" with { type: "json" };
import verifyPayment from "./verify-payment.json" with { type: "json" };

/** All wallet workflow definitions. */
export function loadWalletWorkflows(): WorkflowDefinition[] {
  return [
    onboarding as unknown as WorkflowDefinition,
    send as unknown as WorkflowDefinition,
    balance as unknown as WorkflowDefinition,
    history as unknown as WorkflowDefinition,
    invoice as unknown as WorkflowDefinition,
    verifyPayment as unknown as WorkflowDefinition,
  ];
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register all wallet workflows with the engine.
 * Call once during plugin initialization.
 */
export function registerWalletWorkflows(engine: WorkflowEngine) {
  const workflows = loadWalletWorkflows();
  const results = workflows.map((wf) => ({
    id: wf.id,
    result: engine.registerWorkflow(wf),
  }));

  const failures = results.filter((r) => !r.result.valid);
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.id}: ${f.result.errors.map((e) => e.message).join(", ")}`)
      .join("; ");
    throw new Error(`Wallet workflow registration failed: ${details}`);
  }

  return results;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Start a wallet workflow.
 *
 * @param engine - The workflow engine instance
 * @param workflowId - Which wallet workflow to start
 * @param userId - Unified user ID
 * @param surface - Target surface
 * @param initialData - Optional initial data to inject
 */
export async function startWalletWorkflow(
  engine: WorkflowEngine,
  workflowId: WalletWorkflowId,
  userId: string,
  surface: SurfaceTarget,
  initialData?: Record<string, unknown>,
) {
  return engine.startWorkflow(workflowId, userId, surface, initialData);
}
