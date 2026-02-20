/**
 * Workflow Intercept — routes plugin commands through the workflow engine
 * when a matching workflow definition exists.
 *
 * Rules:
 * 1. Only intercepts when the command has NO args (interactive mode)
 * 2. If args are provided, falls through to the direct handler (CLI-style)
 * 3. Workflows must be registered with id matching `{plugin}-{subcommand}`
 *    or the exact command name
 * 4. Only intercepts on surfaces with inlineButtons capability
 */

import { getWorkflowEngine } from "../abstraction/bootstrap.js";
import type { SurfaceTarget } from "../abstraction/adapter.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";

/** Map of command names (or plugin-subcommand combos) to workflow IDs. */
const COMMAND_WORKFLOW_MAP: Record<string, string> = {
  // wallet subcommands
  "wallet:send": "wallet-send",
  "wallet:balance": "wallet-balance",
  "wallet:history": "wallet-history",
  "wallet:invoice": "wallet-invoice",
  // brain subcommands
  "brain:drop": "brain-drop",
  "brain:search": "brain-search",
  // heal subcommands
  "heal:run": "heal-run",
  // ark subcommands
  "ark:backup": "ark-backup",
  "ark:restore": "ark-restore",
  "ark:status": "ark-status",
};

/**
 * Attempt to intercept a plugin command and route through the workflow engine.
 *
 * Returns a result if the workflow was started, or null to fall through
 * to the regular command handler.
 */
export function tryWorkflowIntercept(params: {
  commandName: string;
  subCommand?: string;
  args?: string;
  ctx: PluginCommandContext;
}): Promise<PluginCommandResult | null> {
  const { commandName, subCommand, args, ctx } = params;

  // Only intercept arg-less commands (interactive mode)
  if (args && args.trim()) {
    return Promise.resolve(null);
  }

  const engine = getWorkflowEngine();
  if (!engine) {
    return Promise.resolve(null);
  }

  // Build lookup keys
  const keys: string[] = [];
  if (subCommand) {
    keys.push(`${commandName}:${subCommand}`);
  }
  keys.push(commandName);

  const workflowId = keys.map((k) => COMMAND_WORKFLOW_MAP[k]).find(Boolean);
  if (!workflowId) {
    return Promise.resolve(null);
  }

  // Check if the workflow is registered in the engine
  if (!engine.hasWorkflow(workflowId)) {
    return Promise.resolve(null);
  }

  const chatId = ctx.chatId ?? ctx.senderId ?? "unknown";

  const surface: SurfaceTarget = {
    surfaceId: "telegram",
    surfaceUserId: chatId,
    channelId: chatId,
  };

  return engine
    .startWorkflow(workflowId, chatId, surface)
    .then(() => {
      // Workflow started — engine renders the first step via adapter.
      // Return empty text to signal "handled".
      return { text: "" } as PluginCommandResult;
    })
    .catch((err) => {
      console.error(`[workflow-intercept] Failed to start workflow ${workflowId}:`, err);
      // Fall through to regular handler
      return null;
    });
}
