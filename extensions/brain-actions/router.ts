/**
 * Brain Actions — Action Router.
 *
 * Routes detected intents to appropriate handlers.
 */

import { logAudit } from "@openclaw/brain-core";
import { detectIntent, isTimeSensitive, isPaymentIntent, isTagOnlyIntent } from "./detector.js";
import { handlePaymentAction } from "./handlers/payment.js";
import { handleReminderAction, handleBookingAction } from "./handlers/reminder.js";
import type { ActionResult, ActionContext, DetectedIntent } from "./types.js";

// ============================================================================
// Tag-Only Actions
// ============================================================================

/**
 * Handle tag-only actions (todo, purchase, call).
 * These just update the classification and don't create cron jobs.
 */
async function handleTagOnlyAction(
  ctx: ActionContext,
  intent: DetectedIntent,
): Promise<ActionResult> {
  const { store, inboxId, classification } = ctx;

  const actionMap: Record<string, ActionResult["action"]> = {
    todo: "todo-tagged",
    purchase: "purchase-tagged",
    call: "call-tagged",
  };

  const action = actionMap[intent] ?? "no-action";
  const details = `Tagged as ${intent}: "${classification.title}"`;

  await logAudit(store, {
    action: "action-routed",
    inputId: inboxId,
    details,
  });

  if (ctx.hooks.onActionRouted) {
    await ctx.hooks.onActionRouted(action, { action, details }, inboxId);
  }

  return { action, details };
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Route a classified thought to the appropriate action handler.
 *
 * @param ctx - Action context with store, config, classification, etc.
 * @returns Action result
 */
export async function routeAction(ctx: ActionContext): Promise<ActionResult> {
  const { config, classification, rawText, inputTag, inboxId, store } = ctx;

  // Check if actions are enabled
  if (config.enabled === false) {
    return { action: "no-action", details: "Actions disabled" };
  }

  // Detect intent
  const intent = detectIntent(classification, rawText, inputTag);

  if (intent === "none") {
    return { action: "no-action", details: "No actionable intent detected" };
  }

  console.log(`[brain-actions] Detected intent: ${intent} for "${classification.title}"`);

  // Route to appropriate handler
  try {
    if (isTimeSensitive(intent)) {
      if (!config.reminder?.enabled === false) {
        if (intent === "booking") {
          return await handleBookingAction(ctx);
        }
        return await handleReminderAction(ctx);
      }
      return { action: "no-action", details: "Reminders disabled" };
    }

    if (isPaymentIntent(intent)) {
      if (config.payment?.enabled !== false) {
        return await handlePaymentAction(ctx);
      }
      return { action: "no-action", details: "Payments disabled" };
    }

    if (isTagOnlyIntent(intent)) {
      return await handleTagOnlyAction(ctx, intent);
    }

    return { action: "no-action", details: `Unhandled intent: ${intent}` };
  } catch (err) {
    console.error(`[brain-actions] Handler error for ${intent}:`, err);

    await logAudit(store, {
      action: "action-routed",
      inputId: inboxId,
      details: `Action handler error: ${err}`,
    });

    return { action: "no-action", details: `Handler error: ${err}` };
  }
}

/**
 * Check if a thought should trigger action routing.
 * Used as a quick filter before full processing.
 */
export function shouldRouteAction(
  classification: any,
  rawText: string,
  inputTag?: string,
): boolean {
  const intent = detectIntent(classification, rawText, inputTag);
  return intent !== "none";
}

// ============================================================================
// Re-exports
// ============================================================================

export { detectIntent, isTimeSensitive, isPaymentIntent, isTagOnlyIntent } from "./detector.js";
export {
  handleReminderAction,
  handleBookingAction,
  createPersistentReminder,
} from "./handlers/reminder.js";
export { handlePaymentAction, extractPaymentParams } from "./handlers/payment.js";
