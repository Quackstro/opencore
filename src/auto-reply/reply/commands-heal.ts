import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { logVerbose } from "../../globals.js";

const COMMAND = "/heal";

type ParsedHealCommand =
  | { ok: true; action: "approve"; id: string }
  | { ok: true; action: "reject"; id: string }
  | { ok: true; action: "list" }
  | { ok: true; action: "history"; offset: number; search?: string }
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
      error: [
        "🩺 **Self-Healing Agent**",
        "",
        "Monitors logs for errors, spawns AI agents to diagnose and fix issues automatically. Issues go through an approval gate before agents are dispatched.",
        "",
        "**Commands:**",
        "• `/heal list` — pending approval requests",
        "• `/heal history` — past healing reports (paginated)",
        "• `/heal search <query>` — search reports by keyword",
        "• `/heal approve <id>` — approve a healing agent dispatch",
        "• `/heal reject <id>` — reject a pending dispatch",
        "• `/heal report <id>` — view full report details",
        "• `/heal dismiss <id>` — acknowledge/dismiss a report",
        "• `/heal test [low|medium|high]` — run E2E pipeline test",
      ].join("\n"),
    };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0].toLowerCase();

  if (action === "list" || action === "ls" || action === "pending") {
    return { ok: true, action: "list" };
  }

  if (action === "history" || action === "log" || action === "past") {
    const offset = tokens[1] ? parseInt(tokens[1], 10) : 0;
    return { ok: true, action: "history", offset: !isNaN(offset) ? Math.max(0, offset) : 0 };
  }

  if (action === "search" || action === "find" || action === "grep") {
    const query = tokens.slice(1).join(" ").trim();
    if (!query) {
      return { ok: false, error: "Usage: /heal search <query>" };
    }
    return { ok: true, action: "history", offset: 0, search: query };
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
      "Usage: /heal list | /heal history [offset] | /heal search <query> | /heal approve <id> | /heal reject <id> | /heal test [low|medium|high]",
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
    } = await import("../../infra/log-monitor-agent-dispatch.js");

    if (parsed.action === "report") {
      return await handleHealReport(parsed.id);
    }

    if (parsed.action === "dismiss") {
      return await handleHealDismiss(parsed.id);
    }

    if (parsed.action === "apply") {
      return {
        shouldContinue: false,
        reply: {
          text: "🔧 Apply fix is not yet implemented — review the full report and apply manually, or ask me to help.",
        },
      };
    }

    if (parsed.action === "history") {
      return await handleHealHistory(parsed.offset, parsed.search);
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
            ? `✅ Healing agent approved and dispatched for: ${match.issueMessage}`
            : `⚠️ Approved but dispatch failed: ${result.reason}`,
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
 * Show history of all healing reports with offset-based pagination and optional search.
 */
async function handleHealHistory(offset: number, search?: string): Promise<CommandHandlerResult> {
  const PAGE_SIZE = 5;
  const { getAllReports } = await import("../../infra/healing-reports.js");

  let allReports = getAllReports();

  // Apply search filter if provided
  if (search) {
    const q = search.toLowerCase();
    allReports = allReports.filter(
      (r) =>
        r.issueSignature.toLowerCase().includes(q) ||
        r.tldr.toLowerCase().includes(q) ||
        r.fullReport.toLowerCase().includes(q) ||
        r.id.toLowerCase().startsWith(q),
    );
  }

  if (allReports.length === 0) {
    const msg = search ? `No healing reports matching "${search}".` : "No healing reports found.";
    return { shouldContinue: false, reply: { text: msg } };
  }

  // Clamp offset
  if (offset >= allReports.length) {
    offset = Math.max(0, Math.floor((allReports.length - 1) / PAGE_SIZE) * PAGE_SIZE);
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(allReports.length / PAGE_SIZE);
  const pageReports = allReports.slice(offset, offset + PAGE_SIZE);
  const hasMore = allReports.length > offset + PAGE_SIZE;

  const lines = pageReports.map((r) => {
    const statusEmoji = r.success ? "✅" : "❌";
    const severityEmoji = r.severity === "high" ? "🔴" : r.severity === "medium" ? "🟡" : "🟢";
    const ackLabel = r.acknowledged ? "dismissed" : "active";
    const date = r.completedAt.slice(0, 10);
    const sigShort =
      r.issueSignature.length > 35 ? `${r.issueSignature.slice(0, 35)}…` : r.issueSignature;
    return `${statusEmoji}${severityEmoji} \`${r.id.slice(0, 8)}\` ${date} — ${sigShort} _(${ackLabel})_`;
  });

  const searchSuffix = search ? ` matching "${search}"` : "";
  const header = `**Healing History** (page ${page}/${totalPages}, ${allReports.length} items${searchSuffix})`;

  // Build navigation buttons
  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (hasMore) {
    const nextCmd = search
      ? `/heal search ${search}` // search doesn't paginate via offset yet — show all matches
      : `/heal history ${offset + PAGE_SIZE}`;
    navRow.push({ text: "📜 Show More", callback_data: nextCmd });
  }
  navRow.push({ text: "🔍 Search", callback_data: "/heal search" });

  // Report buttons for unacknowledged items on this page
  const reportRows = pageReports
    .filter((r) => !r.acknowledged)
    .map((r) => [{ text: `📋 ${r.id.slice(0, 8)}`, callback_data: `/heal report ${r.id}` }]);

  const buttons = [navRow, ...reportRows];

  return {
    shouldContinue: false,
    reply: {
      text: `${header}\n\n${lines.join("\n")}`,
      channelData: { telegram: { buttons } },
    },
  };
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
