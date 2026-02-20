/**
 * /workflow command — start, cancel, or list available workflows.
 *
 * Usage:
 *   /workflow <id>          — start a workflow by ID
 *   /workflow cancel        — cancel the active workflow
 *   /workflow list          — list available workflows
 *   /workflow               — show usage or active workflow status
 */

import type { SurfaceTarget } from "../../abstraction/adapter.js";
import type { CommandHandler } from "./commands-types.js";
import { getWorkflowEngine } from "../../abstraction/bootstrap.js";

const COMMAND = "/workflow";
const ALIASES = ["/wf"];

function matchesCommand(input: string): string | null {
  const lower = input.toLowerCase();
  for (const cmd of [COMMAND, ...ALIASES]) {
    if (lower === cmd || lower.startsWith(`${cmd} `)) {
      return input.slice(cmd.length).trim();
    }
  }
  return null;
}

export const handleWorkflowCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const rest = matchesCommand(params.command.commandBodyNormalized);
  if (rest === null) {
    return null;
  }

  const engine = getWorkflowEngine();
  if (!engine) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Workflow engine not initialized." },
    };
  }

  const userId = params.command.senderId ?? params.command.to ?? "unknown";
  const chatId = params.command.to ?? params.command.senderId ?? "unknown";

  const surface: SurfaceTarget = {
    surfaceId: "telegram",
    surfaceUserId: chatId,
    channelId: chatId,
  };

  // /workflow cancel
  if (rest === "cancel") {
    const active = engine.getActiveWorkflow(userId);
    if (!active) {
      return { shouldContinue: false, reply: { text: "No active workflow to cancel." } };
    }
    await engine.cancelWorkflow(userId, active.workflowId);
    return { shouldContinue: false, reply: { text: "✅ Workflow cancelled." } };
  }

  // /workflow list
  if (rest === "list" || rest === "ls") {
    const workflows = [
      "wallet-onboarding",
      "wallet-send",
      "wallet-balance",
      "wallet-history",
      "wallet-invoice",
      "wallet-verify-payment",
      "brain-drop",
      "brain-search",
      "brain-fix",
      "brain-dnd",
      "ledger-budget-setup",
      "ledger-transaction-search",
      "ledger-report",
      "ledger-statement-import",
      "ledger-bill-management",
      "ark-backup",
      "ark-restore",
      "ark-status",
      "heal-health-check",
      "heal-repair",
      "opencore-status",
      "opencore-update",
      "opencore-config",
      "identity-link-generate",
      "identity-link-claim",
    ];
    const active = engine.getActiveWorkflow(userId);
    const lines = ["**Available Workflows**", ""];
    lines.push(...workflows.map((id) => `• \`${id}\``));
    if (active) {
      lines.push("", `🔄 Active: \`${active.workflowId}\` (step: ${active.currentStep})`);
    }
    lines.push("", "Start one: `/workflow <id>`");
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  // /workflow (no args) — show active or usage
  if (!rest) {
    const active = engine.getActiveWorkflow(userId);
    if (active) {
      return {
        shouldContinue: false,
        reply: {
          text: `🔄 Active workflow: \`${active.workflowId}\` (step: ${active.currentStep})\n\nUse \`/workflow cancel\` to abort, or respond to continue.`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: "Usage: `/workflow <id>` — start a workflow\n`/workflow list` — see available workflows\n`/workflow cancel` — cancel active workflow",
      },
    };
  }

  // /workflow <id> — start a workflow
  const workflowId = rest;
  const def = engine.getWorkflowDefinition(workflowId);
  if (!def) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Unknown workflow: \`${workflowId}\`\n\nUse \`/workflow list\` to see available workflows.`,
      },
    };
  }

  try {
    await engine.startWorkflow(workflowId, userId, surface);
    // Engine renders the first step via the adapter — no extra reply needed.
    return { shouldContinue: false };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to start workflow: ${String(err)}` },
    };
  }
};
