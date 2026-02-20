/**
 * Log Monitor Auto-Resolution Handlers
 *
 * Each handler declares which issue patterns it can resolve and provides
 * a resolution function. Handlers are tried in order; first match wins.
 */

import type { IssueCategory } from "./log-monitor-registry.js";
import { runCrashRecoveryCheck } from "./crash-recovery.js";

// ============================================================================
// Types
// ============================================================================

export type HandlerResult = "fixed" | "failed" | "needs-human" | "needs-agent";

export interface AgentContext {
  task: string;
  tools?: string[];
  severity?: "low" | "medium" | "high";
  timeoutSeconds?: number;
}

export interface HandlerResolution {
  result: HandlerResult;
  /** When result === "needs-agent", optional context for the agent */
  agentContext?: AgentContext;
}

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
  resolve(issue: LogMonitorIssue, ctx: HandlerContext): Promise<HandlerResult | HandlerResolution>;
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize a handler return value to a HandlerResolution object.
 * Supports both plain string results and full resolution objects.
 */
export function normalizeResolution(result: HandlerResult | HandlerResolution): HandlerResolution {
  if (typeof result === "string") {
    return { result };
  }
  return result;
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
 * Handles OAuth/token refresh failures by dispatching a healing agent.
 */
const OAuthTokenHandler: LogMonitorHandler = {
  name: "OAuthToken",

  matches(issue) {
    return (
      issue.message.includes("token") &&
      (issue.message.includes("expired") ||
        issue.message.includes("refresh") ||
        issue.message.includes("401") ||
        issue.message.includes("unauthorized"))
    );
  },

  async resolve(issue, _ctx): Promise<HandlerResolution> {
    return {
      result: "needs-agent",
      agentContext: {
        task: `OAuth/token error detected: ${issue.message}. Check token files, attempt refresh, verify credentials config.`,
        tools: ["check_config", "clear_token_cache", "inspect_logs"],
        severity: "medium",
        timeoutSeconds: 120,
      },
    };
  },
};

/**
 * Delegates to the existing crash recovery module for crash-pattern issues.
 * Returns "needs-agent" to let the dispatch system manage the agent lifecycle.
 */
const CrashRecoveryHandler: LogMonitorHandler = {
  name: "CrashRecovery",

  matches(issue) {
    return issue.category === "crash";
  },

  async resolve(issue, ctx): Promise<HandlerResolution> {
    // Try the quick crash recovery check first
    try {
      const result = await runCrashRecoveryCheck({}, { logger: ctx.logger });
      if (result.diagnosisSpawned) {
        ctx.logger?.info?.("log-monitor: crash recovery spawned diagnosis agent");
        return { result: "fixed" };
      }
      if (result.clusters > 0) {
        // Clusters detected — dispatch a healing agent for deeper diagnosis
        return {
          result: "needs-agent",
          agentContext: {
            task: `OpenCore crash detected: ${issue.message}. Diagnose root cause, find relevant source files, and implement a fix.`,
            tools: ["read_source", "exec_build", "inspect_logs", "restart_service"],
            severity: "high",
            timeoutSeconds: 900,
          },
        };
      }
      return { result: "fixed" };
    } catch (err) {
      ctx.logger?.warn?.(`log-monitor: crash recovery failed: ${String(err)}`);
      return {
        result: "needs-agent",
        agentContext: {
          task: `OpenCore crash detected and crash recovery module failed: ${issue.message}. Diagnose and fix.`,
          tools: ["read_source", "exec_build", "inspect_logs", "restart_service"],
          severity: "high",
          timeoutSeconds: 900,
        },
      };
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

/**
 * Catch-all handler for unhandled errors. Dispatches a healing agent
 * when occurrences are high enough to warrant investigation.
 * Must be last in the handler list.
 */
const GenericErrorHandler: LogMonitorHandler = {
  name: "GenericError",

  matches(issue) {
    return issue.category === "error" || issue.category === "unknown";
  },

  async resolve(issue, _ctx): Promise<HandlerResolution> {
    if (issue.occurrences >= 2) {
      return {
        result: "needs-agent",
        agentContext: {
          task: `Diagnose and fix recurring error: ${issue.message}`,
          severity: issue.occurrences >= 5 ? "high" : "medium",
        },
      };
    }
    // Single occurrence — suppress
    return { result: "fixed" };
  },
};

// ============================================================================
// Exports
// ============================================================================

/** Default set of built-in handlers, tried in order. */
export const BUILTIN_HANDLERS: LogMonitorHandler[] = [
  TransientNetworkHandler,
  OAuthTokenHandler,
  CrashRecoveryHandler,
  StuckSessionHandler,
  GenericErrorHandler,
];

/**
 * Run the first matching handler for an issue.
 * @returns The handler result (normalized to HandlerResolution), or null if no handler matched.
 */
export async function runHandlers(
  issue: LogMonitorIssue,
  ctx: HandlerContext,
  handlers: LogMonitorHandler[] = BUILTIN_HANDLERS,
): Promise<{ handler: string; result: HandlerResult; resolution: HandlerResolution } | null> {
  for (const handler of handlers) {
    if (handler.matches(issue)) {
      try {
        const raw = await handler.resolve(issue, ctx);
        const resolution = normalizeResolution(raw);
        return { handler: handler.name, result: resolution.result, resolution };
      } catch {
        return { handler: handler.name, result: "failed", resolution: { result: "failed" } };
      }
    }
  }
  return null;
}
