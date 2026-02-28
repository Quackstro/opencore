/**
 * Brain Core — Audit trail logger.
 *
 * Every system action is logged to the audit_trail table.
 * Traceable, error-discoverable, trust-building.
 */

import type { BrainStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export type AuditAction =
  | "captured"
  | "classified"
  | "routed"
  | "needs-review"
  | "updated"
  | "nudged"
  | "reviewed"
  | "fixed"
  | "archived"
  | "action-routed"
  | "merged"
  | "action-proposed"
  | "action-resolved"
  | "action-policy-check"
  | "action-approved"
  | "action-executing"
  | "action-executed"
  | "action-failed"
  | "action-dismissed";

export interface LogAuditParams {
  action: AuditAction;
  inputId: string;
  outputId?: string;
  bucket?: string;
  confidence?: number;
  details: string;
  tokenCost?: number;
}

// ============================================================================
// Audit logger
// ============================================================================

/**
 * Log an action to the audit trail.
 *
 * @param store - BrainStore instance
 * @param params - Audit log parameters
 * @returns The created audit entry ID
 */
export async function logAudit(store: BrainStore, params: LogAuditParams): Promise<string> {
  const record = await store.create("audit_trail", {
    timestamp: new Date().toISOString(),
    action: params.action,
    inputId: params.inputId,
    outputId: params.outputId ?? "",
    bucket: params.bucket ?? "",
    confidence: params.confidence ?? 0,
    details: params.details,
    tokenCost: params.tokenCost ?? 0,
  });

  return record.id as string;
}

/**
 * Query audit entries for a given input ID.
 *
 * @param store - BrainStore instance
 * @param inputId - The input ID to query audit entries for
 * @returns Array of audit trail records
 */
export async function getAuditTrail(
  store: BrainStore,
  inputId: string,
): Promise<Record<string, unknown>[]> {
  const allAudits = await store.list("audit_trail");
  return allAudits.filter((a) => a.inputId === inputId);
}
