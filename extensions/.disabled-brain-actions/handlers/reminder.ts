/**
 * Brain Actions — Reminder Handler.
 *
 * Generic reminder creation using cron jobs.
 * Notification delivery is delegated to configurable hooks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logAudit, type BrainStore } from "@openclaw/brain-core";
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

/**
 * Run `openclaw cron add` and return the job ID.
 * Returns null on failure (non-fatal).
 */
async function cronAdd(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["cron", "add", ...args], {
      timeout: 15000,
    });

    // Extract the JSON object from stdout (skip banner lines)
    const lines = stdout.split("\n");
    let jsonStr = "";
    let inJson = false;
    let depth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inJson && trimmed.startsWith("{")) {
        inJson = true;
      }
      if (inJson) {
        jsonStr += line + "\n";
        for (const ch of trimmed) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        if (depth === 0) break;
      }
    }

    if (!jsonStr) {
      console.error("[brain-actions] No JSON in cron output:", stdout.slice(0, 300));
      return null;
    }

    const result = JSON.parse(jsonStr.trim());
    const jobId = result?.id ?? result?.jobId ?? null;
    if (!jobId) {
      console.error("[brain-actions] No job ID in parsed output:", jsonStr.slice(0, 200));
      return null;
    }

    return jobId;
  } catch (err) {
    console.error("[brain-actions] Failed to create cron job:", err);
    return null;
  }
}

/**
 * Edit a cron job's message.
 */
async function cronEditMessage(jobId: string, message: string): Promise<boolean> {
  try {
    await execFileAsync("openclaw", ["cron", "edit", jobId, "--message", message], {
      timeout: 15000,
    });
    return true;
  } catch (err) {
    console.error("[brain-actions] Failed to edit cron job:", err);
    return false;
  }
}

/**
 * Remove a cron job.
 */
async function cronRemove(jobId: string): Promise<boolean> {
  try {
    await execFileAsync("openclaw", ["cron", "rm", jobId], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Agent Message Builder
// ============================================================================

/**
 * Build the agent message for reminder delivery.
 * The agent will call the registered hook for actual delivery.
 *
 * Note: This is a generic message that tells the agent to trigger the
 * onReminderDeliver hook. The hook implementation handles the actual
 * notification delivery (Telegram, email, etc.).
 */
function buildAgentMessage(reminderText: string, nagJobId: string, enableNag: boolean): string {
  // The agent receives this message and should:
  // 1. Call the onReminderDeliver hook with the reminderText and nagJobId
  // 2. Optionally enable the nag job if this is the initial trigger

  let msg = `BRAIN_REMINDER_TRIGGER\n`;
  msg += `text: ${reminderText}\n`;
  msg += `nagJobId: ${nagJobId}\n`;
  msg += `enableNag: ${enableNag}\n`;
  msg += `\nExecute the onReminderDeliver hook and reply NO_REPLY.`;

  return msg;
}

// ============================================================================
// Persistent Reminder Creation
// ============================================================================

/**
 * Create a persistent reminder with two cron jobs:
 *
 * 1. **Nag job** (recurring every N min, initially DISABLED):
 *    Triggers reminder delivery hook.
 *    Enabled by the trigger job when the reminder time arrives.
 *
 * 2. **Trigger job** (one-shot at target time, auto-deletes):
 *    First delivery with hook AND enables the nag job.
 *
 * For recurring patterns, creates a single recurring cron job.
 *
 * @returns Object with triggerJobId and nagJobId, or null on failure
 */
export async function createPersistentReminder(
  extraction: TimeExtraction,
  config: ActionRouterConfig,
): Promise<PersistentReminderResult | null> {
  const timezone = config.timezone ?? "America/New_York";
  const nagIntervalMin = config.reminder?.nagIntervalMinutes ?? 5;
  const reminderText = extraction.reminderText || "Brain reminder";
  const baseName = reminderText.slice(0, 50);

  // Step 1: Create the NAG job (disabled, every N min)
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

  // Update the nag message with the real job ID
  const nagMessageReal = buildAgentMessage(reminderText, nagJobId, false);
  await cronEditMessage(nagJobId, nagMessageReal);

  // Step 2: Handle recurring vs one-shot
  if (extraction.recurring) {
    // For recurring patterns, create a single recurring job
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

    // Clean up the nag job (not needed for recurring)
    if (recurringJobId) {
      await cronRemove(nagJobId);

      // Update recurring job to use its own ID
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

  // Step 3: Create the TRIGGER job (one-shot at target time)
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
    // Trigger failed — clean up the nag job
    console.error("[brain-actions] Failed to create trigger job, cleaning up nag");
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
// Reminder Handler
// ============================================================================

/**
 * Handle a reminder action.
 * Extracts time via LLM and creates persistent cron reminders.
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
      details: `Reminder intent detected for "${classification.title}" but no actionable time could be extracted`,
    });
    return { action: "no-action", details: "No actionable time extracted" };
  }

  // Check if extracted time is in the past
  if (isInPast(extraction, timezone)) {
    console.log("[brain-actions] Extracted time is in the past, skipping reminder");
    return { action: "no-action", details: "Extracted time is in the past" };
  }

  // Create the persistent reminder
  const result = await createPersistentReminder(extraction, config);
  if (!result) {
    return { action: "no-action", details: "Failed to create cron jobs" };
  }

  // Build description for audit trail
  const reminderAt = formatExtraction(extraction, timezone);
  const details = `Created persistent reminder "${result.name}" (nag: ${result.nagJobId}, trigger: ${result.triggerJobId ?? "N/A"}) for ${reminderAt} — "${extraction.reminderText}"`;

  // Log to audit trail
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
 * Handle a booking action (appointment reminders).
 * Same as reminder but logged as "booking".
 */
export async function handleBookingAction(ctx: ActionContext): Promise<ActionResult> {
  const result = await handleReminderAction(ctx);

  if (result.action === "reminder-created") {
    return { ...result, action: "booking-created" };
  }

  return result;
}
