/**
 * Log Monitor Auto-Resolution Handlers
 *
 * Each handler declares which issue patterns it can resolve and provides
 * a resolution function. Handlers are tried in order; first match wins.
 */

import type { IssueCategory } from "./log-monitor-registry.js";
import { runCrashRecoveryCheck } from "./crash-recovery.js";
import { isTransientNetworkError } from "./unhandled-rejections.js";

// ============================================================================
// Types
// ============================================================================

export type HandlerResult = "fixed" | "failed" | "needs-human";

export interface LogMonitorIssue {
  signature: string;
  category: IssueCategory;
  message: string;
  occurrences: number;
}

export interface HandlerContext {
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface LogMonitorHandler {
  name: string;
  matches(issue: LogMonitorIssue): boolean;
  resolve(issue: LogMonitorIssue, ctx: HandlerContext): Promise<HandlerResult>;
}

// ============================================================================
// Transient Network Codes (mirrored from unhandled-rejections.ts)
// ============================================================================

const TRANSIENT_NETWORK_PATTERNS = [
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
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "fetch failed",
];

// ============================================================================
// Built-in Handlers
// ============================================================================

/**
 * Suppresses transient network errors (ECONNRESET, ETIMEDOUT, etc.)
 * unless they exceed a high-frequency threshold.
 */
const TransientNetworkHandler: LogMonitorHandler = {
  name: "TransientNetwork",

  matches(issue) {
    if (issue.category === "network") {
      return true;
    }
    return TRANSIENT_NETWORK_PATTERNS.some((code) => issue.message.includes(code));
  },

  async resolve(issue, ctx) {
    // Transient network errors are expected; suppress unless they spike.
    // A high spike (>10 in the observation window) suggests a real problem.
    if (issue.occurrences > 10) {
      ctx.logger?.warn?.(
        `log-monitor: transient network errors spiking (${issue.occurrences} occurrences) — needs human review`,
      );
      return "needs-human";
    }
    ctx.logger?.info?.(
      `log-monitor: suppressing transient network error (${issue.occurrences} occurrences)`,
    );
    return "fixed";
  },
};

/**
 * Delegates to the existing crash recovery module for crash-pattern issues.
 */
const CrashRecoveryHandler: LogMonitorHandler = {
  name: "CrashRecovery",

  matches(issue) {
    return issue.category === "crash";
  },

  async resolve(issue, ctx) {
    try {
      const result = await runCrashRecoveryCheck({}, { logger: ctx.logger });
      if (result.diagnosisSpawned) {
        ctx.logger?.info?.("log-monitor: crash recovery spawned diagnosis agent");
        return "fixed";
      }
      if (result.clusters > 0) {
        return "needs-human";
      }
      return "fixed";
    } catch (err) {
      ctx.logger?.warn?.(`log-monitor: crash recovery failed: ${String(err)}`);
      return "failed";
    }
  },
};

/**
 * Handles stuck session patterns by logging guidance.
 */
const StuckSessionHandler: LogMonitorHandler = {
  name: "StuckSession",

  matches(issue) {
    return issue.category === "stuck-session";
  },

  async resolve(issue, ctx) {
    ctx.logger?.info?.(
      `log-monitor: stuck session detected — will surface to user for manual review`,
    );
    return "needs-human";
  },
};

// ============================================================================
// Exports
// ============================================================================

/** Default set of built-in handlers, tried in order. */
export const BUILTIN_HANDLERS: LogMonitorHandler[] = [
  TransientNetworkHandler,
  CrashRecoveryHandler,
  StuckSessionHandler,
];

/**
 * Run the first matching handler for an issue.
 * @returns The handler result, or null if no handler matched.
 */
export async function runHandlers(
  issue: LogMonitorIssue,
  ctx: HandlerContext,
  handlers: LogMonitorHandler[] = BUILTIN_HANDLERS,
): Promise<{ handler: string; result: HandlerResult } | null> {
  for (const handler of handlers) {
    if (handler.matches(issue)) {
      try {
        const result = await handler.resolve(issue, ctx);
        return { handler: handler.name, result };
      } catch {
        return { handler: handler.name, result: "failed" };
      }
    }
  }
  return null;
}
