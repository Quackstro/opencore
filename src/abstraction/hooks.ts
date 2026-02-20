/**
 * Workflow Hooks — bridges the abstraction layer into the existing
 * plugin callback/message handler system.
 *
 * Two handlers:
 * 1. Callback handler: intercepts inline button presses with `wf:` prefix
 * 2. Message handler: intercepts text when user has an active workflow
 *
 * Both are registered via registerCallbackHandler/registerMessageHandler
 * from plugins/callback-message-handlers.ts, using the same pattern
 * that plugins use.
 */

import type {
  PluginCallbackHandlerContext,
  PluginCallbackHandlerResult,
  PluginMessageHandlerContext,
  PluginMessageHandlerResult,
} from "../plugins/types.js";
import type { ParsedUserAction, SurfaceTarget } from "./adapter.js";
import {
  registerCallbackHandler,
  registerMessageHandler,
} from "../plugins/callback-message-handlers.js";
import { getWorkflowEngine } from "./bootstrap.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const PLUGIN_ID = "workflow-engine";

/** Callback data prefix used by TelegramAdapter: wf:<workflowId>|s:<stepId>|a:<actionId> */
const WF_CALLBACK_PATTERN = /^wf:/;

/**
 * Message handler priority. Higher = checked first.
 * Wallet onboarding uses priority ~100; we use 200 to intercept first
 * when a workflow is active (but return null if no active workflow,
 * letting other handlers run).
 */
const WF_MESSAGE_PRIORITY = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSurface(chatId: string): SurfaceTarget {
  return {
    surfaceId: "telegram",
    surfaceUserId: chatId,
    channelId: chatId,
  };
}

function decodeCallbackData(data: string): {
  workflowId: string;
  stepId: string;
  actionId: string;
} | null {
  const m = data.match(/^wf:([^|]+)\|s:([^|]+)\|a:(.+)$/);
  if (!m) {
    return null;
  }
  return { workflowId: m[1], stepId: m[2], actionId: m[3] };
}

function actionResultToText(outcome: string, error?: string): string | null {
  switch (outcome) {
    case "advanced":
    case "completed":
      // Engine already rendered the step via adapter — no extra reply needed.
      // Return empty string to signal "handled, don't pass through".
      return null;
    case "validation-error":
      return error ?? "Invalid input. Please try again.";
    case "tool-error":
      return error ?? "Something went wrong. Please try again.";
    case "cancelled":
      return error ?? "Cancelled.";
    default:
      return null;
  }
}

// ─── Callback Handler ───────────────────────────────────────────────────────

async function handleWorkflowCallback(
  ctx: PluginCallbackHandlerContext,
): Promise<PluginCallbackHandlerResult> {
  const engine = getWorkflowEngine();
  if (!engine) {
    return null;
  }

  const data = ctx.callbackData ?? ctx.data ?? "";
  const decoded = decodeCallbackData(data);
  if (!decoded) {
    return null;
  }

  const surface = buildSurface(ctx.chatId);
  const userId = ctx.chatId; // For now, userId = chatId. IdentityService can resolve later.

  let action: ParsedUserAction;

  if (decoded.actionId === "__cancel__") {
    action = {
      kind: "cancel",
      workflowId: decoded.workflowId,
      stepId: decoded.stepId,
      surface,
      rawEvent: ctx,
    };
  } else if (decoded.actionId === "__back__") {
    action = {
      kind: "back",
      workflowId: decoded.workflowId,
      stepId: decoded.stepId,
      surface,
      rawEvent: ctx,
    };
  } else {
    action = {
      kind: "selection",
      value: decoded.actionId,
      workflowId: decoded.workflowId,
      stepId: decoded.stepId,
      surface,
      rawEvent: ctx,
    };
  }

  const result = await engine.handleAction(userId, action);

  // The engine renders steps via the adapter directly.
  // For "advanced"/"completed", the adapter already sent messages,
  // so we return a minimal result to prevent the plugin system from
  // also trying to edit the callback message.
  const errorText = actionResultToText(result.outcome, result.error);

  if (result.outcome === "advanced" || result.outcome === "completed") {
    // Return empty text to signal "handled, no reply needed".
    // bot-handlers.ts skips sendMessage/editMessageText when text is empty.
    return { text: "" };
  }

  if (errorText) {
    return { text: errorText };
  }

  return null;
}

// ─── Message Handler ────────────────────────────────────────────────────────

async function handleWorkflowMessage(
  ctx: PluginMessageHandlerContext,
): Promise<PluginMessageHandlerResult> {
  const engine = getWorkflowEngine();
  if (!engine) {
    return null;
  }

  const userId = ctx.chatId;

  // Only intercept if user has an active workflow
  const activeWorkflow = engine.getActiveWorkflow(userId);
  if (!activeWorkflow) {
    return null;
  }

  const surface = buildSurface(ctx.chatId);
  const text = ctx.text.trim();

  // Check for meta-actions typed as text
  const lower = text.toLowerCase();
  let action: ParsedUserAction;

  if (lower === "cancel" || lower === "/cancel") {
    action = {
      kind: "cancel",
      workflowId: activeWorkflow.workflowId,
      stepId: activeWorkflow.currentStep,
      surface,
      rawEvent: ctx,
    };
  } else if (lower === "back" || lower === "/back") {
    action = {
      kind: "back",
      workflowId: activeWorkflow.workflowId,
      stepId: activeWorkflow.currentStep,
      surface,
      rawEvent: ctx,
    };
  } else {
    action = {
      kind: "text",
      text,
      workflowId: activeWorkflow.workflowId,
      stepId: activeWorkflow.currentStep,
      surface,
      rawEvent: ctx,
    };
  }

  const result = await engine.handleAction(userId, action);

  if (result.outcome === "advanced" || result.outcome === "completed") {
    // Return empty text to signal "handled, no reply needed".
    // bot-handlers.ts skips sendMessage when text is empty.
    return { text: "" };
  }

  const errorText = actionResultToText(result.outcome, result.error);
  if (errorText) {
    return { text: errorText };
  }

  return null;
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register workflow handlers with the plugin handler system.
 * Call once after initWorkflowEngine().
 */
export function registerWorkflowHooks(): void {
  registerCallbackHandler(PLUGIN_ID, {
    pattern: WF_CALLBACK_PATTERN,
    handler: handleWorkflowCallback,
  });

  registerMessageHandler(PLUGIN_ID, {
    pattern: /.*/, // Match all text — we filter by active workflow inside
    priority: WF_MESSAGE_PRIORITY,
    handler: handleWorkflowMessage,
  });

  console.log("[workflow-hooks] Registered callback + message handlers");
}
