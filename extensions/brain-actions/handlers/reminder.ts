/**
 * Brain Actions — Reminder Handler.
 *
 * Creates persistent cron reminders. Notification delivery is delegated
 * to configurable hooks (not hardcoded Telegram).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logAudit } from "@openclaw/brain-core";
import { extractTime, localToUtcMs, isInPast, formatExtraction } from "../time-extractor.js";
import type {
  ActionResult,
  ActionContext,
  TimeExtraction,
  PersistentReminderResult,
  ActionRouterConfig,
} from "../types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Cron Job Helpers
// ============================================================================

async function cronAdd(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["cron", "add", ...args], {
      timeout: 15000,
    });

    // Extract JSON from stdout
    const lines = stdout.split("\n");
    let jsonStr = "";
    let inJson = false;
    let depth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inJson && trimmed.startsWith("{")) inJson = true;
      if (inJson) {
        jsonStr += line + "\n";
        for (const ch of trimmed) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        if (depth === 0) break;
      }
    }

    if (!jsonStr) return null;
    const result = JSON.parse(jsonStr.trim());
    return result?.id ?? result?.jobId ?? null;
  } catch (err) {
    console.error("[brain-actions] Failed to create cron job:", err);
    return null;
  }
}

async function cronEditMessage(jobId: string, message: string): Promise<boolean> {
  try {
    await execFileAsync("openclaw", ["cron", "edit", jobId, "--message", message], {
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

async function cronRemove(jobId: string): Promise<boolean> {
  try {
    await execFileAsync("openclaw", ["cron", "rm", jobId], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Reminder Message Builder
// ============================================================================

/**
 * Build agent message for reminder trigger.
 * The agent should call the onReminderDeliver hook.
 */
function buildAgentMessage(reminderText: string, nagJobId: string, enableNag: boolean): string {
  return [
    "BRAIN_REMINDER_TRIGGER",
    `text: ${reminderText}`,
    `nagJobId: ${nagJobId}`,
    `enableNag: ${enableNag}`,
    "",
    "Execute the onReminderDeliver hook and reply NO_REPLY.",
  ].join("\n");
}

// ============================================================================
// Persistent Reminder Creation
// ============================================================================

/**
 * Create a persistent reminder with cron jobs.
 *
 * For one-shot reminders:
 * 1. Nag job (recurring every N min, initially DISABLED)
 * 2. Trigger job (one-shot at target time, enables nag, auto-deletes)
 *
 * For recurring reminders:
 * - Single recurring cron job
 */
export async function createPersistentReminder(
  extraction: TimeExtraction,
  config: ActionRouterConfig,
): Promise<PersistentReminderResult | null> {
  const timezone = config.timezone ?? "America/New_York";
  const nagIntervalMin = config.reminder?.nagIntervalMinutes ?? 5;
  const reminderText = extraction.reminderText || "Brain reminder";
  const baseName = reminderText.slice(0, 50);

  // Step 1: Create NAG job (disabled)
  const nagMessage = buildAgentMessage(reminderText, "SELF", false);
  const nagJobId = await cronAdd([
    "--name",
    `Brain Nag: ${baseName}`,
    "--every",
    `${nagIntervalMin}m`,
    "--session",
    "isolated",
    "--message",
    nagMessage,
    "--disabled",
    "--json",
  ]);

  if (!nagJobId) {
    console.error("[brain-actions] Failed to create nag job");
    return null;
  }

  // Update nag message with real job ID
  const nagMessageReal = buildAgentMessage(reminderText, nagJobId, false);
  await cronEditMessage(nagJobId, nagMessageReal);

  // Step 2: Handle recurring vs one-shot
  if (extraction.recurring) {
    const recurringMessage = buildAgentMessage(reminderText, nagJobId, false);
    const recurringJobId = await cronAdd([
      "--name",
      `Brain Recurring: ${baseName}`,
      "--cron",
      extraction.recurring,
      "--tz",
      timezone,
      "--session",
      "isolated",
      "--message",
      recurringMessage,
      "--json",
    ]);

    if (recurringJobId) {
      await cronRemove(nagJobId); // Not needed for recurring
      const recurringMessageReal = buildAgentMessage(reminderText, recurringJobId, false);
      await cronEditMessage(recurringJobId, recurringMessageReal);

      return {
        triggerJobId: null,
        nagJobId: recurringJobId,
        name: `Brain Recurring: ${baseName}`,
      };
    }
    return null;
  }

  // Step 3: Create TRIGGER job (one-shot)
  const date = extraction.date!;
  const time = extraction.time ?? config.reminder?.defaultTime ?? "09:00";
  const utcMs = localToUtcMs(date, time, extraction.timezone || timezone);
  const utcIso = new Date(utcMs).toISOString();

  const triggerMessage = buildAgentMessage(reminderText, nagJobId, true);
  const triggerJobId = await cronAdd([
    "--name",
    `Brain Trigger: ${baseName}`,
    "--at",
    utcIso,
    "--session",
    "isolated",
    "--message",
    triggerMessage,
    "--delete-after-run",
    "--json",
  ]);

  if (!triggerJobId) {
    console.error("[brain-actions] Failed to create trigger job");
    await cronRemove(nagJobId);
    return null;
  }

  return {
    triggerJobId,
    nagJobId,
    name: `Brain Reminder: ${baseName}`,
  };
}

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle a reminder action.
 */
export async function handleReminderAction(ctx: ActionContext): Promise<ActionResult> {
  const { store, config, classification, rawText, inboxId } = ctx;
  const timezone = config.timezone ?? "America/New_York";

  // Extract time via LLM
  const extraction = await extractTime(rawText, classification, config);
  if (!extraction) {
    await logAudit(store, {
      action: "action-routed",
      inputId: inboxId,
      details: `Reminder intent but no actionable time: "${classification.title}"`,
    });
    return { action: "no-action", details: "No actionable time extracted" };
  }

  // Check if in past
  if (isInPast(extraction, timezone)) {
    return { action: "no-action", details: "Time is in the past" };
  }

  // Create persistent reminder
  const result = await createPersistentReminder(extraction, config);
  if (!result) {
    return { action: "no-action", details: "Failed to create cron jobs" };
  }

  const reminderAt = formatExtraction(extraction, timezone);
  const details = `Created "${result.name}" for ${reminderAt}`;

  await logAudit(store, {
    action: "action-routed",
    inputId: inboxId,
    details,
  });

  // Call hook if registered
  if (ctx.hooks.onActionRouted) {
    await ctx.hooks.onActionRouted(
      "reminder-created",
      {
        action: "reminder-created",
        triggerJobId: result.triggerJobId ?? undefined,
        nagJobId: result.nagJobId,
        name: result.name,
        reminderAt,
        details,
      },
      inboxId,
    );
  }

  return {
    action: "reminder-created",
    triggerJobId: result.triggerJobId ?? undefined,
    nagJobId: result.nagJobId,
    name: result.name,
    reminderAt,
    details,
  };
}

/**
 * Handle a booking action (same as reminder, different label).
 */
export async function handleBookingAction(ctx: ActionContext): Promise<ActionResult> {
  const result = await handleReminderAction(ctx);
  if (result.action === "reminder-created") {
    return { ...result, action: "booking-created" };
  }
  return result;
}
