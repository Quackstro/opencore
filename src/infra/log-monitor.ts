/**
 * Log Monitor Service
 *
 * Background loop that periodically tails the gateway log file, detects
 * recurring issues via the issue registry, auto-resolves known patterns,
 * and surfaces actionable issues to the user via system events.
 *
 * Uses setInterval + .unref() so it doesn't keep the process alive.
 */

import fs from "node:fs";
import type { AgentDispatchConfig, LogMonitorConfig } from "../config/types.log-monitor.js";
import { runCrashRecoveryCheck } from "./crash-recovery.js";
import { emitDiagnosticEvent } from "./diagnostic-events.js";
import { dispatchHealingAgent } from "./log-monitor-agent-dispatch.js";
import { startDiagnosticCollector } from "./log-monitor-diagnostics.js";
import { normalizeResolution, runHandlers, type HandlerContext } from "./log-monitor-handlers.js";
import {
  createIssueRegistry,
  type IssueCategory,
  type IssueRegistry,
} from "./log-monitor-registry.js";
import { enqueueSystemEvent } from "./system-events.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_AGENT_DISPATCH: AgentDispatchConfig = {
  enabled: false,
  timeoutSeconds: 300,
  thinking: "high",
  maxConcurrent: 2,
  cooldownSeconds: 3600,
  maxSpawnsPerHour: 5,
  agentId: "system",
};

const DEFAULTS: Required<LogMonitorConfig> = {
  enabled: false,
  intervalMs: 60_000,
  maxLinesPerScan: 500,
  dedupeWindowMs: 1_800_000, // 30 min
  minOccurrences: 2,
  autoResolve: true,
  crashRecovery: true,
  agentDispatch: DEFAULT_AGENT_DISPATCH,
};

// ============================================================================
// Log line classification
// ============================================================================

interface ClassifiedIssue {
  signature: string;
  category: IssueCategory;
  message: string;
}

const TRANSIENT_NETWORK_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
];

/**
 * Try to classify a log line as a known issue.
 * Returns null if the line doesn't represent an actionable issue.
 */
export function classifyLogLine(line: string): ClassifiedIssue | null {
  // Try JSON-structured error entries first
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.level === "error" || parsed.level === 50) {
        const msg = String(parsed.msg ?? parsed.message ?? parsed.err ?? "unknown error");
        const errCode = String(parsed.code ?? parsed.errorCode ?? "");

        // Network errors
        if (TRANSIENT_NETWORK_CODES.some((c) => errCode.includes(c) || msg.includes(c))) {
          return {
            signature: `network:${errCode || msg.slice(0, 60)}`,
            category: "network",
            message: msg.slice(0, 200),
          };
        }

        // Crash/uncaught
        if (msg.includes("Uncaught exception") || msg.includes("unhandled rejection")) {
          return {
            signature: `crash:${msg.slice(0, 80)}`,
            category: "crash",
            message: msg.slice(0, 200),
          };
        }

        // Generic error
        return {
          signature: `error:${msg.slice(0, 80)}`,
          category: "error",
          message: msg.slice(0, 200),
        };
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  // Match "[openclaw] Suppressed non-fatal exception" pattern
  const suppressedMatch = line.match(
    /\[openclaw\] Suppressed non-fatal exception \(continuing\):\s*(.+)/,
  );
  if (suppressedMatch) {
    const msg = suppressedMatch[1].slice(0, 200);
    // Check if it's a network error
    if (TRANSIENT_NETWORK_CODES.some((c) => msg.includes(c))) {
      return {
        signature: `network:suppressed:${msg.slice(0, 60)}`,
        category: "network",
        message: msg,
      };
    }
    return {
      signature: `error:suppressed:${msg.slice(0, 60)}`,
      category: "error",
      message: msg,
    };
  }

  // Match lane task errors (command queue failures — rate limits, auth errors, etc.)
  const laneMatch = line.match(
    /\[diagnostic\] lane task error: lane=(\S+).*?error="(.+)"/,
  );
  if (laneMatch) {
    const lane = laneMatch[1];
    const errMsg = laneMatch[2].slice(0, 200);
    const isNetwork = errMsg.includes("rate limit") || errMsg.includes("ECONNRESET") ||
      errMsg.includes("ETIMEDOUT") || errMsg.includes("fetch failed");
    return {
      signature: `lane:${lane.split(":").slice(0, 2).join(":")}:${errMsg.slice(0, 50)}`,
      category: isNetwork ? "network" : "error",
      message: `Lane ${lane}: ${errMsg}`,
    };
  }

  // Match embedded agent failures (all models failed)
  const agentFailMatch = line.match(/Embedded agent failed.*?:\s*(.+)/);
  if (agentFailMatch) {
    const errMsg = agentFailMatch[1].slice(0, 200);
    return {
      signature: `agent:embedded-fail:${errMsg.slice(0, 50)}`,
      category: "error",
      message: errMsg,
    };
  }

  // Match uncaught exception logs
  if (line.includes("[openclaw] FATAL uncaught exception")) {
    const msg = line.replace(/.*\[openclaw\]\s*/, "").slice(0, 200);
    return {
      signature: `crash:fatal:${msg.slice(0, 60)}`,
      category: "crash",
      message: msg,
    };
  }

  return null;
}

// ============================================================================
// Log file reading
// ============================================================================

/**
 * Read new lines from the log file since the given byte cursor.
 */
function readNewLogLines(
  filePath: string,
  cursor: number,
  maxLines: number,
): { lines: string[]; newCursor: number } {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;

    // File was truncated or rotated
    if (cursor > size) {
      return { lines: [], newCursor: size };
    }

    // No new data
    if (size <= cursor) {
      return { lines: [], newCursor: cursor };
    }

    const length = Math.min(size - cursor, maxLines * 1000); // rough estimate: 1000 bytes per line
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, cursor);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString("utf8");
    let lines = text.split("\n");

    // Drop incomplete first line if we're resuming mid-file
    if (cursor > 0 && lines.length > 0 && !text.startsWith("\n")) {
      lines = lines.slice(1);
    }

    // Drop empty trailing line
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }

    // Cap at maxLines
    if (lines.length > maxLines) {
      lines = lines.slice(lines.length - maxLines);
    }

    return { lines, newCursor: cursor + length };
  } catch {
    return { lines: [], newCursor: cursor };
  }
}

// ============================================================================
// Service
// ============================================================================

export interface LogMonitorDeps {
  /** Path to the log file. If not provided, uses getResolvedLoggerSettings. */
  logFile?: string;
  /** Session key for system events. If not provided, skips event delivery. */
  sessionKey?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface LogMonitorHandle {
  stop(): void;
  updateConfig(cfg: LogMonitorConfig): void;
}

/**
 * Start the log monitor background service.
 *
 * @param cfg - Log monitor configuration (merged with defaults).
 * @param deps - External dependencies (log file path, session key, logger).
 * @returns A handle with stop() and updateConfig() methods.
 */
export function startLogMonitor(cfg: LogMonitorConfig, deps: LogMonitorDeps): LogMonitorHandle {
  const merged = { ...DEFAULTS, ...cfg };

  if (!merged.enabled) {
    return { stop() {}, updateConfig() {} };
  }

  const registry: IssueRegistry = createIssueRegistry({
    dedupeWindowMs: merged.dedupeWindowMs,
    minOccurrences: merged.minOccurrences,
    autoResolve: merged.autoResolve,
  });

  // Restore persisted state
  registry.load();

  const handlerCtx: HandlerContext = { logger: deps.logger };

  // One-time: run crash recovery if enabled
  if (merged.crashRecovery) {
    void runCrashRecoveryCheck({}, { logger: deps.logger }).catch((err) => {
      deps.logger?.warn?.(`log-monitor: crash recovery check failed: ${String(err)}`);
    });
  }

  // Main config (mutable for updateConfig)
  let currentConfig = merged;

  // Start diagnostic event collector to capture real-time events
  const stopDiagnostics = startDiagnosticCollector((issue) => {
    const decision = registry.record(issue);
    if (decision.shouldSurface) {
      surfaceIssue(issue.signature, issue.message, deps);
    }
    if (decision.shouldAutoResolve) {
      void resolveIssue(issue, registry, handlerCtx, deps, currentConfig.agentDispatch);
    }
  });

  function tick() {
    if (!deps.logFile) {
      return;
    }

    const cursor = registry.getCursor();
    const { lines, newCursor } = readNewLogLines(
      deps.logFile,
      cursor,
      currentConfig.maxLinesPerScan,
    );

    for (const line of lines) {
      const issue = classifyLogLine(line);
      if (!issue) {
        continue;
      }

      const decision = registry.record(issue);

      emitDiagnosticEvent({
        type: "logMonitor.issue",
        signature: issue.signature,
        category: issue.category,
        message: issue.message,
        occurrences: 0,
        surfaced: decision.shouldSurface,
        autoResolved: decision.shouldAutoResolve,
      });

      if (decision.shouldSurface) {
        surfaceIssue(issue.signature, issue.message, deps);
      }
      if (decision.shouldAutoResolve) {
        void resolveIssue(issue, registry, handlerCtx, deps, currentConfig.agentDispatch);
      }
    }

    registry.setCursor(newCursor);
    // Periodic flush to persist state
    registry.flush();
  }

  const interval = setInterval(tick, currentConfig.intervalMs);
  interval.unref();

  deps.logger?.info?.("log-monitor: started");

  return {
    stop() {
      clearInterval(interval);
      stopDiagnostics();
      registry.flush();
      deps.logger?.info?.("log-monitor: stopped");
    },
    updateConfig(newCfg: LogMonitorConfig) {
      currentConfig = { ...DEFAULTS, ...newCfg };
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read recent log lines from the log file (for agent context).
 */
function getRecentLogLines(deps: LogMonitorDeps, count: number): string[] {
  if (!deps.logFile) {
    return [];
  }
  try {
    const stat = fs.statSync(deps.logFile);
    const estimatedBytes = count * 500;
    const start = Math.max(0, stat.size - estimatedBytes);
    const buffer = Buffer.alloc(Math.min(estimatedBytes, stat.size));
    const fd = fs.openSync(deps.logFile, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString("utf8").split("\n");
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function surfaceIssue(signature: string, message: string, deps: LogMonitorDeps): void {
  if (!deps.sessionKey) {
    return;
  }
  const text = `[Log Monitor] ${message}`;
  enqueueSystemEvent(text, { sessionKey: deps.sessionKey });
  deps.logger?.info?.(`log-monitor: surfaced issue ${signature}`);
}

async function resolveIssue(
  issue: { signature: string; category: IssueCategory; message: string },
  registry: IssueRegistry,
  ctx: HandlerContext,
  deps: LogMonitorDeps,
  agentDispatchConfig?: AgentDispatchConfig,
): Promise<void> {
  registry.markAutoResolveAttempt(issue.signature);

  const result = await runHandlers({ ...issue, occurrences: 0 }, ctx);

  if (result) {
    const resolution = normalizeResolution(result.resolution);
    deps.logger?.info?.(
      `log-monitor: handler ${result.handler} resolved ${issue.signature} → ${result.result}`,
    );

    if (resolution.result === "needs-agent") {
      const config = { ...DEFAULT_AGENT_DISPATCH, ...agentDispatchConfig };
      if (config.enabled) {
        const recentLines = getRecentLogLines(deps, 50);
        const dispatchResult = await dispatchHealingAgent({
          issue: { ...issue, occurrences: 0 },
          recentLogLines: recentLines,
          agentContext: resolution.agentContext,
          config,
          registry,
          deps,
        });
        if (dispatchResult.dispatched) {
          return;
        }
        // If dispatch was blocked, fall through to user escalation
        deps.logger?.info?.(
          `log-monitor: agent dispatch blocked (${dispatchResult.reason}), escalating to user`,
        );
      }
      // Agent dispatch disabled or blocked — escalate to user
      surfaceIssue(issue.signature, `${issue.message} (auto-resolve: needs manual review)`, deps);
      return;
    }

    if (result.result === "needs-human") {
      surfaceIssue(issue.signature, `${issue.message} (auto-resolve: needs manual review)`, deps);
    }
  }
}
