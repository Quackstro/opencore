import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { logVerbose } from "../../globals.js";

const COMMAND = "/heal";

type ParsedHealCommand =
  | { ok: true; action: "approve"; id: string }
  | { ok: true; action: "reject"; id: string }
  | { ok: true; action: "list" }
  | { ok: true; action: "test"; severity?: "low" | "medium" | "high" }
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
        "Usage: /heal approve <id> | /heal reject <id> | /heal list | /heal test [low|medium|high]",
    };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0].toLowerCase();

  if (action === "list" || action === "ls" || action === "pending") {
    return { ok: true, action: "list" };
  }

  if (action === "test" || action === "simulate") {
    const severity = tokens[1]?.toLowerCase();
    if (severity === "low" || severity === "medium" || severity === "high") {
      return { ok: true, action: "test", severity };
    }
    return { ok: true, action: "test" };
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
    } = await import("../../infra/log-monitor-agent-dispatch.js");

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
      return {
        shouldContinue: false,
        reply: { text: `**Pending Approvals (${pending.length}):**\n${lines.join("\n")}` },
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
          "",
          `The approval gate caught this. To continue the test:`,
          `• \`/heal approve ${shortId}\` — dispatch the healing agent`,
          `• \`/heal reject ${shortId}\` — cancel the test`,
        ].join("\n"),
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
