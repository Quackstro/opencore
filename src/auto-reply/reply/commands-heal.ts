import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { logVerbose } from "../../globals.js";

const COMMAND = "/heal";

type ParsedHealCommand =
  | { ok: true; action: "approve"; id: string }
  | { ok: true; action: "reject"; id: string }
  | { ok: true; action: "list" }
  | { ok: true; action: "history"; offset: number }
  | { ok: true; action: "search"; query: string }
  | { ok: true; action: "extend"; id: string }
  | { ok: true; action: "rerequest"; id: string }
  | { ok: true; action: "test"; severity?: "low" | "medium" | "high" }
  | { ok: true; action: "report"; id: string }
  | { ok: true; action: "dismiss"; id: string }
  | { ok: true; action: "apply"; id: string }
  | { ok: false; error: string };

function parseHealCommand(raw: string): ParsedHealCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return {
      ok: false,
      error:
        "🩺 **Self-Healing Pipeline**\n" +
        "Monitors logs and diagnostic events for errors, auto-resolves known patterns, " +
        "and dispatches AI healing agents for unresolved issues.\n\n" +
        "**Commands:**\n" +
        "• `/heal list` — show pending approval requests\n" +
        "• `/heal history [offset]` — browse all healing reports\n" +
        "• `/heal search <query>` — search reports by keyword\n" +
        "• `/heal approve <id>` — approve a healing agent dispatch\n" +
        "• `/heal reject <id>` — reject a pending request\n" +
        "• `/heal extend <id>` — extend approval window by 30 minutes\n" +
        "• `/heal rerequest <id>` — re-request an expired approval\n" +
        "• `/heal test [low|medium|high]` — inject a simulated error for E2E testing\n" +
        "• `/heal report <id>` — view full healing report\n" +
        "• `/heal dismiss <id>` — acknowledge and close a report\n" +
        "• `/heal apply <id>` — apply a suggested fix (experimental)",
    };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0].toLowerCase();

  if (action === "list" || action === "ls" || action === "pending") {
    return { ok: true, action: "list" };
  }

  if (action === "history" || action === "hist") {
    const offset = tokens[1] ? parseInt(tokens[1], 10) : 0;
    return { ok: true, action: "history", offset: Number.isNaN(offset) ? 0 : offset };
  }

  if (action === "search" || action === "find" || action === "grep") {
    const query = tokens.slice(1).join(" ");
    if (!query) {
      return { ok: false, error: "Usage: /heal search <query>" };
    }
    return { ok: true, action: "search", query };
  }

  if (action === "extend") {
    if (!tokens[1]) {
      return { ok: true, action: "extend", id: "" };
    }
    return { ok: true, action: "extend", id: tokens[1] };
  }

  if (
    action === "rerequest" ||
    action === "re-request" ||
    action === "retry" ||
    action === "request"
  ) {
    if (!tokens[1]) {
      return { ok: true, action: "rerequest", id: "" };
    }
    return { ok: true, action: "rerequest", id: tokens[1] };
  }

  if (action === "test" || action === "simulate") {
    const severity = tokens[1]?.toLowerCase();
    if (severity === "low" || severity === "medium" || severity === "high") {
      return { ok: true, action: "test", severity };
    }
    return { ok: true, action: "test" };
  }

  if (action === "report" || action === "full" || action === "details") {
    if (!tokens[1]) {
      return { ok: false, error: "Usage: /heal report <id>" };
    }
    return { ok: true, action: "report", id: tokens[1] };
  }

  if (action === "dismiss" || action === "ack" || action === "close") {
    if (!tokens[1]) {
      return { ok: false, error: "Usage: /heal dismiss <id>" };
    }
    return { ok: true, action: "dismiss", id: tokens[1] };
  }

  if (action === "apply" || action === "fix") {
    if (!tokens[1]) {
      return { ok: false, error: "Usage: /heal apply <id>" };
    }
    return { ok: true, action: "apply", id: tokens[1] };
  }

  if (action === "approve" || action === "yes" || action === "ok") {
    if (!tokens[1]) {
      return { ok: false, error: "Usage: /heal approve <id>" };
    }
    return { ok: true, action: "approve", id: tokens[1] };
  }

  if (action === "reject" || action === "deny" || action === "no") {
    if (!tokens[1]) {
      return { ok: false, error: "Usage: /heal reject <id>" };
    }
    return { ok: true, action: "reject", id: tokens[1] };
  }

  // Try treating the first token as an ID with implicit approve
  // e.g., /heal <uuid> approve
  if (tokens[1]) {
    const secondAction = tokens[1].toLowerCase();
    if (secondAction === "approve" || secondAction === "yes" || secondAction === "ok") {
      return { ok: true, action: "approve", id: tokens[0] };
    }
    if (secondAction === "reject" || secondAction === "deny" || secondAction === "no") {
      return { ok: true, action: "reject", id: tokens[0] };
    }
  }

  return {
    ok: false,
    error:
      "Usage: /heal approve <id> | /heal reject <id> | /heal list | /heal test [low|medium|high]",
  };
}

export const handleHealCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseHealCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /heal from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  try {
    const {
      approveHealingDispatch,
      rejectHealingDispatch,
      listPendingApprovals,
      dispatchHealingAgent,
      extendApproval,
      rerequestApproval,
    } = await import("../../infra/log-monitor-agent-dispatch.js");

    if (parsed.action === "report") {
      return await handleHealReport(parsed.id);
    }

    if (parsed.action === "dismiss") {
      return await handleHealDismiss(parsed.id);
    }

    if (parsed.action === "apply") {
      return await handleHealApply(params, parsed.id);
    }

    if (parsed.action === "test") {
      return await handleHealTest(
        params,
        parsed.severity,
        dispatchHealingAgent,
        listPendingApprovals,
      );
    }

    if (parsed.action === "list") {
      const pending = listPendingApprovals();
      if (pending.length === 0) {
        return {
          shouldContinue: false,
          reply: { text: "No pending healing agent approvals." },
        };
      }
      const lines = pending.map((p) => {
        const severityEmoji = p.severity === "high" ? "🔴" : p.severity === "medium" ? "🟡" : "🟢";
        const expiresIn = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
        return `${severityEmoji} \`${p.id.slice(0, 8)}\` — ${p.issueMessage} (${p.severity}, expires in ${expiresIn}s)`;
      });
      // Build approve/reject buttons for each pending approval
      const buttons = pending.flatMap((p) => {
        const shortId = p.id.slice(0, 8);
        return [
          [
            { text: `✅ Approve ${shortId}`, callback_data: `/heal approve ${shortId}` },
            { text: `🚫 Reject ${shortId}`, callback_data: `/heal reject ${shortId}` },
          ],
        ];
      });
      return {
        shouldContinue: false,
        reply: {
          text: `**Pending Approvals (${pending.length}):**\n${lines.join("\n")}`,
          channelData: { telegram: { buttons } },
        },
      };
    }

    if (parsed.action === "history") {
      return await handleHealHistory(parsed.offset);
    }

    if (parsed.action === "search") {
      return await handleHealSearch(parsed.query);
    }

    if (parsed.action === "extend") {
      const pending = listPendingApprovals();
      if (!parsed.id) {
        if (pending.length === 0) {
          return { shouldContinue: false, reply: { text: "No pending approvals to extend." } };
        }
        const lines = pending.map((p) => {
          const expiresIn = Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000));
          return `• \`${p.id.slice(0, 8)}\` — ${p.issueMessage} (expires in ~${expiresIn}m)`;
        });
        const buttons = pending.map((p) => [
          {
            text: `🔄 Extend ${p.id.slice(0, 8)}`,
            callback_data: `/heal extend ${p.id.slice(0, 8)}`,
          },
        ]);
        return {
          shouldContinue: false,
          reply: {
            text: `**Pending approvals:**\n${lines.join("\n")}\n\nTap to extend:`,
            channelData: { telegram: { buttons } },
          },
        };
      }
      const match = resolveApprovalId(parsed.id, pending);
      if (!match) {
        return {
          shouldContinue: false,
          reply: { text: `❌ No pending approval matching \`${parsed.id}\`.` },
        };
      }
      const result = extendApproval(match.id);
      if (!result.extended) {
        return {
          shouldContinue: false,
          reply: { text: `❌ Extend failed: ${result.reason}` },
        };
      }
      const expiresIn = Math.round((result.newExpiresAt! - Date.now()) / 60000);
      return {
        shouldContinue: false,
        reply: {
          text: `🔄 Extended approval \`${match.id.slice(0, 8)}\` — expires in ~${expiresIn}m`,
        },
      };
    }

    if (parsed.action === "rerequest") {
      if (!parsed.id) {
        return {
          shouldContinue: false,
          reply: {
            text: "ℹ️ Re-request revives an expired approval.\n\nUsage: `/heal rerequest <id>`\n\nExpired approvals show a 🔄 Re-request button — tap it from the expired notification.",
          },
        };
      }
      const result = rerequestApproval(parsed.id);
      if (!result.rerequested) {
        return {
          shouldContinue: false,
          reply: {
            text: `❌ No expired approval matching \`${parsed.id}\`. Only expired approvals (within 2h grace window) can be re-requested.`,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: `🔄 Re-requested approval — new ID: \`${result.newId?.slice(0, 8)}\`. Check for the new approval message.`,
        },
      };
    }

    if (parsed.action === "approve") {
      // Support short ID prefix matching
      const pending = listPendingApprovals();
      const match = resolveApprovalId(parsed.id, pending);
      if (!match) {
        return {
          shouldContinue: false,
          reply: { text: `❌ No pending approval matching \`${parsed.id}\`.` },
        };
      }
      const result = await approveHealingDispatch(match.id);
      if (!result.approved) {
        return {
          shouldContinue: false,
          reply: { text: `❌ Approval failed: ${result.reason}` },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: result.dispatched
            ? `✅ Healing agent approved and dispatched for: ${match.issueMessage}\n\n📋 Report ID: \`${match.id.slice(0, 8)}\``
            : `⚠️ Approved but dispatch failed: ${result.reason}\n\nID: \`${match.id.slice(0, 8)}\``,
        },
      };
    }

    if (parsed.action === "reject") {
      const pending = listPendingApprovals();
      const match = resolveApprovalId(parsed.id, pending);
      if (!match) {
        return {
          shouldContinue: false,
          reply: { text: `❌ No pending approval matching \`${parsed.id}\`.` },
        };
      }
      const result = rejectHealingDispatch(match.id);
      if (!result.rejected) {
        return {
          shouldContinue: false,
          reply: { text: `❌ Rejection failed: ${result.reason}` },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `🚫 Healing agent rejected for: ${match.issueMessage}` },
      };
    }
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Error: ${String(err)}` },
    };
  }

  return null;
};

/**
 * Apply a fix from a healing report by spawning a sub-agent.
 */
async function handleHealApply(
  params: Parameters<CommandHandler>[0],
  id: string,
): Promise<CommandHandlerResult> {
  const { loadReport, getUnacknowledgedReports } = await import("../../infra/healing-reports.js");

  // Resolve report by exact or prefix match
  let report = loadReport(id);
  if (!report) {
    const unacked = getUnacknowledgedReports();
    const match = unacked.find((r) => r.id.startsWith(id));
    if (match) {
      report = match;
    }
  }
  if (!report) {
    return { shouldContinue: false, reply: { text: `❌ Report \`${id}\` not found.` } };
  }
  if (!report.hasFix) {
    return {
      shouldContinue: false,
      reply: {
        text:
          `❌ Report \`${report.id}\` has no fix to apply.\n\n` +
          `The healing agent diagnosed the issue but didn't propose a concrete fix. ` +
          `You can ask me to help fix it based on the report:\n\`/heal report ${report.id}\``,
      },
    };
  }

  // Dispatch a healing agent with the apply-fix task
  const task = [
    `Apply the following fix from healing report ${report.id}:`,
    "",
    `**Issue:** ${report.issueSignature}`,
    `**Fix:** ${report.fixDescription ?? "See full report below"}`,
    "",
    "--- Full Report ---",
    report.fullReport,
    "--- End Report ---",
    "",
    "Instructions:",
    "- Read the report and understand the proposed fix",
    "- Apply the fix (edit files, update config, etc.)",
    "- Verify the fix works (check logs, run tests if applicable)",
    "- If a restart is needed, say 'restart required' — do NOT restart services yourself",
    "- Report what you did and the result",
  ].join("\n");

  try {
    const { dispatchHealingAgent } = await import("../../infra/log-monitor-agent-dispatch.js");
    const result = await dispatchHealingAgent({
      issue: {
        signature: report.issueSignature,
        category: "error",
        occurrences: 0,
        message: `Apply fix: ${report.fixDescription ?? report.issueSignature}`,
      },
      recentLogLines: [],
      agentContext: {
        task,
        severity: report.severity,
      },
      config: {
        enabled: true,
        timeoutSeconds: 600,
        approvalGate: { mode: "off" }, // Already approved by clicking /heal apply
      },
      registry: null as never, // Not needed for direct dispatch
      deps: {
        sessionKey: params.sessionKey,
        deliveryChannel: "telegram",
        deliveryTo: params.command?.senderId,
        deliveryAccountId: params.ctx?.AccountId,
        logger: undefined,
      },
    });

    if (result.dispatched) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `🔧 **Applying fix** from report \`${report.id}\`\n\n` +
            `**Fix:** ${report.fixDescription ?? "Applying fix from report..."}\n\n` +
            `A healing agent has been dispatched. You'll be notified when it completes.`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to dispatch fix agent: ${result.reason ?? "unknown"}`,
      },
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to spawn fix agent: ${String(err)}`,
      },
    };
  }
}

/**
 * Show the full report for a healing report ID.
 */
async function handleHealReport(id: string): Promise<CommandHandlerResult> {
  const { loadReport, getUnacknowledgedReports } = await import("../../infra/healing-reports.js");

  // Try exact match first, then prefix match against unacknowledged
  let report = loadReport(id);
  if (!report) {
    const unacked = getUnacknowledgedReports();
    const match = unacked.find((r) => r.id.startsWith(id));
    if (match) {
      report = match;
    }
  }
  if (!report) {
    return { shouldContinue: false, reply: { text: `❌ Report \`${id}\` not found.` } };
  }

  const statusEmoji = report.success ? "✅" : "❌";
  // Telegram has 4096 char limit — truncate if needed
  const maxLen = 3500;
  const body =
    report.fullReport.length > maxLen
      ? `${report.fullReport.slice(0, maxLen)}\n\n_(truncated — ${report.fullReport.length} chars total)_`
      : report.fullReport;

  return {
    shouldContinue: false,
    reply: {
      text: [
        `${statusEmoji} **Full Healing Report** — \`${report.id}\``,
        `**Issue:** \`${report.issueSignature}\``,
        `**Completed:** ${report.completedAt}`,
        "",
        body,
      ].join("\n"),
      channelData: {
        telegram: {
          buttons: [[{ text: "🗑 Dismiss", callback_data: `/heal dismiss ${report.id}` }]],
        },
      },
    },
  };
}

/**
 * Dismiss/acknowledge a healing report.
 */
async function handleHealDismiss(id: string): Promise<CommandHandlerResult> {
  const { acknowledgeReport, getUnacknowledgedReports } =
    await import("../../infra/healing-reports.js");

  // Try prefix match
  const unacked = getUnacknowledgedReports();
  const match = unacked.find((r) => r.id === id || r.id.startsWith(id));
  const resolvedId = match?.id ?? id;

  const ok = acknowledgeReport(resolvedId);
  if (!ok) {
    return { shouldContinue: false, reply: { text: `❌ Report \`${id}\` not found.` } };
  }
  return { shouldContinue: false, reply: { text: `🗑 Report \`${resolvedId}\` dismissed.` } };
}

/**
 * Simulate the full healing pipeline: classify → handler → dispatch → approval gate.
 * This injects a synthetic error through the real dispatch path to validate end-to-end.
 */
async function handleHealTest(
  params: Parameters<CommandHandler>[0],
  severity: "low" | "medium" | "high" | undefined,
  dispatchHealingAgent: typeof import("../../infra/log-monitor-agent-dispatch.js").dispatchHealingAgent,
  listPendingApprovals: typeof import("../../infra/log-monitor-agent-dispatch.js").listPendingApprovals,
): Promise<CommandHandlerResult> {
  const testSeverity = severity ?? "medium";
  const testSignature = `test:heal-e2e:${Date.now()}`;
  const testMessage = `[HEAL TEST] Simulated ${testSeverity}-severity error for end-to-end validation`;

  // We need a registry for the dispatch — create a temporary one
  const { createIssueRegistry } = await import("../../infra/log-monitor-registry.js");
  const registry = createIssueRegistry({
    dedupeWindowMs: 30_000,
    minOccurrences: 1,
    autoResolve: true,
  });
  registry.record({ signature: testSignature, category: "error", message: testMessage });

  const result = await dispatchHealingAgent({
    issue: {
      signature: testSignature,
      category: "error",
      message: testMessage,
      occurrences: 1,
    },
    recentLogLines: [
      `[${new Date().toISOString()}] ERROR ${testMessage}`,
      "[heal-test] This is a simulated error for testing the self-healing pipeline.",
      "[heal-test] The healing agent should diagnose this as a test and report back.",
    ],
    agentContext: {
      task: `[TEST] Diagnose and report on simulated error: ${testMessage}. This is a test — confirm you received the task and report your findings.`,
      severity: testSeverity,
      tools: ["exec: run shell commands", "read: inspect files"],
      timeoutSeconds: 120,
    },
    config: {
      enabled: true,
      timeoutSeconds: 120,
      maxConcurrent: 2,
      maxSpawnsPerHour: 10,
      cooldownSeconds: 60,
      agentId: params.agentId ?? "dev",
      approvalGate: { mode: "always" },
    },
    registry,
    deps: {
      sessionKey: params.sessionKey,
      logFile: undefined,
      logger: {
        info: (msg: string) => logVerbose(msg),
        warn: (msg: string) => logVerbose(msg),
      },
    },
  });

  if (result.reason?.startsWith("approval-pending:")) {
    const pending = listPendingApprovals();
    const latest = pending.find((p) => p.issueSignature === testSignature);
    const shortId = latest?.id.slice(0, 8) ?? "unknown";
    return {
      shouldContinue: false,
      reply: {
        text: [
          `🧪 **Heal Test — Approval Gate Triggered**`,
          "",
          `Severity: **${testSeverity}**`,
          `Signature: \`${testSignature}\``,
          `Approval ID: \`${shortId}\``,
        ].join("\n"),
        channelData: {
          telegram: {
            buttons: [
              [
                { text: "✅ Approve", callback_data: `/heal approve ${shortId}` },
                { text: "🚫 Reject", callback_data: `/heal reject ${shortId}` },
              ],
            ],
          },
        },
      },
    };
  }

  if (result.dispatched) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          `🧪 **Heal Test — Agent Dispatched**`,
          "",
          `Severity: **${testSeverity}**`,
          `Run ID: \`${result.runId}\``,
          `Session: \`${result.childSessionKey}\``,
          "",
          `The healing agent is running. Watch for its completion announcement.`,
        ].join("\n"),
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `🧪 **Heal Test — Dispatch Blocked**\n\nReason: ${result.reason}\n\nThis may indicate rate limiting, circuit breaker, or config issues.`,
    },
  };
}

const HISTORY_PAGE_SIZE = 5;

/**
 * Show paginated history of all healing reports.
 */
async function handleHealHistory(offset: number): Promise<CommandHandlerResult> {
  const { getAllReports } = await import("../../infra/healing-reports.js");
  const all = getAllReports();
  if (all.length === 0) {
    return { shouldContinue: false, reply: { text: "📜 No healing reports yet." } };
  }
  const page = all.slice(offset, offset + HISTORY_PAGE_SIZE);
  if (page.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: `📜 No more reports (total: ${all.length}).` },
    };
  }
  const lines = page.map((r) => {
    const emoji = r.success ? "✅" : "❌";
    const acked = r.acknowledged ? "📌" : "🆕";
    const date = new Date(r.completedAt).toISOString().slice(0, 16).replace("T", " ");
    return `${emoji}${acked} \`${r.id.slice(0, 8)}\` ${date} — ${r.issueSignature}`;
  });
  const header = `📜 **Healing History** (${offset + 1}–${offset + page.length} of ${all.length})`;
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (offset > 0) {
    navRow.push({
      text: "⬅️ Previous",
      callback_data: `/heal history ${Math.max(0, offset - HISTORY_PAGE_SIZE)}`,
    });
  }
  if (offset + HISTORY_PAGE_SIZE < all.length) {
    navRow.push({ text: "➡️ Next", callback_data: `/heal history ${offset + HISTORY_PAGE_SIZE}` });
  }
  if (navRow.length > 0) {
    buttons.push(navRow);
  }

  return {
    shouldContinue: false,
    reply: {
      text: `${header}\n\n${lines.join("\n")}`,
      channelData: buttons.length > 0 ? { telegram: { buttons } } : undefined,
    },
  };
}

/**
 * Search healing reports by query string (matches issue signature or full report text).
 */
async function handleHealSearch(query: string): Promise<CommandHandlerResult> {
  const { getAllReports } = await import("../../infra/healing-reports.js");
  const all = getAllReports();
  const lower = query.toLowerCase();
  const matches = all.filter(
    (r) =>
      r.issueSignature.toLowerCase().includes(lower) ||
      r.fullReport.toLowerCase().includes(lower) ||
      r.id.startsWith(query),
  );
  if (matches.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: `🔍 No reports matching "${query}".` },
    };
  }
  const capped = matches.slice(0, 10);
  const lines = capped.map((r) => {
    const emoji = r.success ? "✅" : "❌";
    const date = new Date(r.completedAt).toISOString().slice(0, 16).replace("T", " ");
    return `${emoji} \`${r.id.slice(0, 8)}\` ${date} — ${r.issueSignature}`;
  });
  const header =
    matches.length > 10
      ? `🔍 **Search: "${query}"** (showing 10 of ${matches.length})`
      : `🔍 **Search: "${query}"** (${matches.length} result${matches.length === 1 ? "" : "s"})`;
  return {
    shouldContinue: false,
    reply: { text: `${header}\n\n${lines.join("\n")}` },
  };
}

/**
 * Resolve a full or prefix approval ID against the pending list.
 */
function resolveApprovalId(
  input: string,
  pending: Array<{ id: string; issueMessage: string }>,
): { id: string; issueMessage: string } | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // Exact match first
  const exact = pending.find((p) => p.id === normalized);
  if (exact) {
    return exact;
  }
  // Prefix match (allow short IDs like first 8 chars of UUID)
  const prefixMatches = pending.filter((p) => p.id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  return null;
}
