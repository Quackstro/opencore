/**
 * Brain Actions — Payment Handler.
 *
 * Generic payment action handling. Resolution and execution are delegated
 * to configurable hooks (personal implementation in clawd workspace).
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logAudit } from "@openclaw/brain-core";
import type {
  ActionResult,
  ActionContext,
  PaymentParams,
  PaymentResolution,
  PaymentActionResult,
} from "../types.js";

// ============================================================================
// Payment Parameter Extraction
// ============================================================================

/**
 * Extract payment parameters from classification result.
 */
export function extractPaymentParams(classification: any, rawText: string): PaymentParams | null {
  // Check proposedActions from classifier
  const proposedPayment = classification.proposedActions?.find((a: any) => a.type === "payment");

  if (proposedPayment) {
    return {
      recipient: proposedPayment.recipient || "",
      amount: parseFloat(proposedPayment.amount) || 0,
      currency: proposedPayment.currency || "DOGE",
      reason: proposedPayment.reason || classification.title || rawText.slice(0, 100),
    };
  }

  // Fallback: try to extract from raw text
  const amountMatch = rawText.match(/(\d+(?:\.\d+)?)\s*(?:doge|Ð|D)/i);
  const recipientMatch = rawText.match(/(?:to|for|@)\s+(\w+)/i);

  if (amountMatch) {
    return {
      recipient: recipientMatch?.[1] || "",
      amount: parseFloat(amountMatch[1]),
      currency: "DOGE",
      reason: classification.title || rawText.slice(0, 100),
    };
  }

  return null;
}

// ============================================================================
// Pending Action Storage
// ============================================================================

const PENDING_ACTIONS_DIR = join(homedir(), ".openclaw", "brain", "pending-actions");

interface PendingAction {
  id: string;
  type: "payment";
  status: "proposed" | "awaiting-approval" | "executing" | "complete" | "dismissed" | "failed";
  params: PaymentParams;
  resolution?: PaymentResolution;
  inboxId: string;
  createdAt: string;
  updatedAt: string;
  txid?: string;
  error?: string;
}

async function savePendingAction(action: PendingAction): Promise<void> {
  await mkdir(PENDING_ACTIONS_DIR, { recursive: true });
  const path = join(PENDING_ACTIONS_DIR, `${action.id}.json`);
  await writeFile(path, JSON.stringify(action, null, 2));
}

// ============================================================================
// Payment Handler
// ============================================================================

/**
 * Handle a payment action.
 *
 * Flow:
 * 1. Extract payment params from classification
 * 2. Call resolver hook to get recipient address
 * 3. Evaluate policy (auto-execute vs approval)
 * 4. Either execute immediately or request approval
 */
export async function handlePaymentAction(ctx: ActionContext): Promise<PaymentActionResult> {
  const { store, embedder, config, classification, rawText, inboxId, hooks } = ctx;

  // 1. Extract payment parameters
  const params = extractPaymentParams(classification, rawText);
  if (!params || !params.recipient || params.amount <= 0) {
    await logAudit(store, {
      action: "action-routed",
      inputId: inboxId,
      details: `Payment intent but invalid params: ${JSON.stringify(params)}`,
    });
    return { action: "no-action", details: "Invalid payment parameters" };
  }

  // 2. Resolve recipient to address
  let resolution: PaymentResolution = { resolved: false };

  if (hooks.onPaymentResolve) {
    try {
      resolution = await hooks.onPaymentResolve(params.recipient, embedder);
    } catch (err) {
      console.error("[brain-actions] Payment resolution error:", err);
      resolution = { resolved: false, error: String(err) };
    }
  } else {
    // No resolver hook — can't proceed
    await logAudit(store, {
      action: "action-routed",
      inputId: inboxId,
      details: `Payment to "${params.recipient}" but no resolver hook configured`,
    });
    return {
      action: "payment-failed",
      params,
      details: "No payment resolver configured",
    };
  }

  if (!resolution.resolved || !resolution.address) {
    await logAudit(store, {
      action: "action-routed",
      inputId: inboxId,
      details: `Could not resolve recipient "${params.recipient}": ${resolution.error || "not found"}`,
    });
    return {
      action: "payment-failed",
      params,
      resolution,
      details: `Could not resolve recipient: ${resolution.error || "not found"}`,
    };
  }

  // 3. Create pending action
  const actionId = randomUUID();
  const pendingAction: PendingAction = {
    id: actionId,
    type: "payment",
    status: "proposed",
    params,
    resolution,
    inboxId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 4. Evaluate auto-execute policy
  const autoThreshold = config.payment?.autoExecuteThreshold ?? 0.95;
  const maxAutoAmount = config.payment?.maxAutoExecuteAmount ?? 10;
  const confidence = resolution.confidence ?? 0;

  const shouldAutoExecute =
    confidence >= autoThreshold && params.amount <= maxAutoAmount && hooks.onPaymentExecute;

  if (shouldAutoExecute) {
    // Auto-execute
    pendingAction.status = "executing";
    await savePendingAction(pendingAction);

    try {
      const result = await hooks.onPaymentExecute!(params, resolution);

      if (result.success) {
        pendingAction.status = "complete";
        pendingAction.txid = result.txid;
        pendingAction.updatedAt = new Date().toISOString();
        await savePendingAction(pendingAction);

        const details = `Auto-executed ${params.amount} ${params.currency} to ${resolution.recipientName || params.recipient}`;
        await logAudit(store, {
          action: "action-routed",
          inputId: inboxId,
          details,
        });

        if (hooks.onActionRouted) {
          await hooks.onActionRouted(
            "payment-auto-executed",
            {
              action: "payment-auto-executed",
              paymentId: actionId,
              txid: result.txid,
              recipient: resolution.recipientName || params.recipient,
              amount: params.amount,
              currency: params.currency,
              details,
            },
            inboxId,
          );
        }

        return {
          action: "payment-auto-executed",
          paymentId: actionId,
          txid: result.txid,
          params,
          resolution,
          details,
        };
      } else {
        pendingAction.status = "failed";
        pendingAction.error = result.error;
        pendingAction.updatedAt = new Date().toISOString();
        await savePendingAction(pendingAction);

        return {
          action: "payment-failed",
          paymentId: actionId,
          params,
          resolution,
          details: result.error || "Execution failed",
        };
      }
    } catch (err) {
      pendingAction.status = "failed";
      pendingAction.error = String(err);
      pendingAction.updatedAt = new Date().toISOString();
      await savePendingAction(pendingAction);

      return {
        action: "payment-failed",
        paymentId: actionId,
        params,
        resolution,
        details: String(err),
      };
    }
  }

  // 5. Request approval
  pendingAction.status = "awaiting-approval";
  await savePendingAction(pendingAction);

  const details = `Proposed ${params.amount} ${params.currency} to ${resolution.recipientName || params.recipient} (awaiting approval)`;
  await logAudit(store, {
    action: "action-routed",
    inputId: inboxId,
    details,
  });

  // Call approval hook
  if (hooks.onPaymentApproval) {
    try {
      await hooks.onPaymentApproval(params, resolution, actionId);
    } catch (err) {
      console.error("[brain-actions] Payment approval hook error:", err);
    }
  }

  if (hooks.onActionRouted) {
    await hooks.onActionRouted(
      "payment-proposed",
      {
        action: "payment-proposed",
        paymentId: actionId,
        recipient: resolution.recipientName || params.recipient,
        amount: params.amount,
        currency: params.currency,
        details,
      },
      inboxId,
    );
  }

  return {
    action: "payment-proposed",
    paymentId: actionId,
    params,
    resolution,
    details,
  };
}
