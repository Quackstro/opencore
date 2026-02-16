/**
 * Log Monitor Agent Dispatch
 *
 * Dispatches healing sub-agents for issues that cannot be auto-resolved
 * by built-in handlers. Implements rate limiting, cooldown, and circuit
 * breaker patterns to prevent runaway agent spawning.
 */

import crypto from "node:crypto";
import type { AgentDispatchConfig } from "../config/types.log-monitor.js";
import type { AgentContext, LogMonitorIssue } from "./log-monitor-handlers.js";
import type { IssueRegistry } from "./log-monitor-registry.js";
import type { LogMonitorDeps } from "./log-monitor.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentDispatchOptions {
  issue: LogMonitorIssue;
  recentLogLines: string[];
  agentContext?: AgentContext;
  config: AgentDispatchConfig;
  registry: IssueRegistry;
  deps: LogMonitorDeps;
}

export interface AgentDispatchResult {
  dispatched: boolean;
  runId?: string;
  childSessionKey?: string;
  reason?: string;
}

export interface ActiveAgent {
  issueSignature: string;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// State (module-scoped for singleton behavior)
// ============================================================================

const activeAgents = new Map<string, ActiveAgent>();
const spawnHistory: number[] = [];

/** Circuit breaker: max consecutive failures before permanent escalation. */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;
/** Circuit breaker window: 6 hours. */
const CIRCUIT_BREAKER_WINDOW_MS = 6 * 60 * 60 * 1000;

// ============================================================================
// Default remediation tools listed in the agent prompt
// ============================================================================

const DEFAULT_REMEDIATION_TOOLS = [
  "exec: run shell commands (tail logs, check services, restart processes)",
  "read: inspect config and source files",
  "web_search: look up error messages and solutions",
];

// ============================================================================
// Rate Limiting
// ============================================================================

export function canSpawnAgent(
  issueSignature: string,
  config: AgentDispatchConfig,
  registry: IssueRegistry,
): { allowed: boolean; reason?: string } {
  // 0. Check if enabled
  if (!config.enabled) {
    return { allowed: false, reason: "agent-dispatch-disabled" };
  }

  // 1. Check max concurrent
  if (activeAgents.size >= (config.maxConcurrent ?? 2)) {
    return { allowed: false, reason: "max-concurrent-reached" };
  }

  // 2. Check if agent already active for this issue
  for (const [, agent] of activeAgents) {
    if (agent.issueSignature === issueSignature) {
      return { allowed: false, reason: "agent-already-active-for-issue" };
    }
  }

  // 3. Check per-issue cooldown
  const issueRecord = registry.getIssue(issueSignature);
  if (issueRecord) {
    const cooldownMs = (config.cooldownSeconds ?? 3600) * 1000;
    if (
      issueRecord.lastAgentDispatchMs > 0 &&
      Date.now() - issueRecord.lastAgentDispatchMs < cooldownMs
    ) {
      return { allowed: false, reason: "cooldown-active" };
    }

    // 4. Circuit breaker
    if (
      issueRecord.agentFailures >= CIRCUIT_BREAKER_MAX_FAILURES &&
      issueRecord.lastAgentFailureMs > 0 &&
      Date.now() - issueRecord.lastAgentFailureMs < CIRCUIT_BREAKER_WINDOW_MS
    ) {
      return { allowed: false, reason: "circuit-breaker-open" };
    }
  }

  // 5. Check hourly rate limit
  const oneHourAgo = Date.now() - 3_600_000;
  const recentSpawns = spawnHistory.filter((ts) => ts > oneHourAgo).length;
  if (recentSpawns >= (config.maxSpawnsPerHour ?? 5)) {
    return { allowed: false, reason: "hourly-rate-limit" };
  }

  return { allowed: true };
}

// ============================================================================
// Prompt Builder
// ============================================================================

export function buildHealingAgentPrompt(
  issue: LogMonitorIssue,
  recentLines: string[],
  context?: AgentContext,
): string {
  return `# Self-Healing: ${issue.category} Issue

## Problem
${issue.message}

## Signature
${issue.signature}

## Occurrences
${issue.occurrences} times in current window

## Recent Log Context
\`\`\`
${recentLines.join("\n")}
\`\`\`

## Available Remediation Actions
${(context?.tools ?? DEFAULT_REMEDIATION_TOOLS.map((t) => t)).map((t) => `- ${t}`).join("\n")}

## Instructions
1. Diagnose the root cause from the logs and error context
2. Attempt remediation using available tools
3. Verify the fix by checking service health
4. Report what you did and whether it worked

## Safety
- Do NOT restart the gateway unless explicitly needed
- Do NOT modify config files without understanding the impact
- If unsure, report findings and escalate to user
`;
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Dispatch a healing agent for an unresolved issue.
 *
 * Uses callGateway to spawn a sub-agent session, similar to sessions-spawn-tool.
 * The agent runs in the background; escalation to user happens on timeout or failure.
 */
export async function dispatchHealingAgent(
  opts: AgentDispatchOptions,
): Promise<AgentDispatchResult> {
  const { issue, recentLogLines, agentContext, config, registry, deps } = opts;

  // Rate limit check
  const check = canSpawnAgent(issue.signature, config, registry);
  if (!check.allowed) {
    deps.logger?.info?.(
      `log-monitor: agent dispatch blocked for ${issue.signature}: ${check.reason}`,
    );
    // If blocked, fall back to user escalation for important reasons
    if (check.reason === "circuit-breaker-open") {
      surfaceIssueInternal(
        issue.signature,
        `${issue.message} (healing agent circuit breaker open — needs manual review)`,
        deps,
      );
    }
    return { dispatched: false, reason: check.reason };
  }

  const agentId = config.agentId ?? "system";
  const childSessionKey = `agent:${agentId}:healing:${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const timeoutSeconds = agentContext?.timeoutSeconds ?? config.timeoutSeconds ?? 300;

  const prompt = buildHealingAgentPrompt(issue, recentLogLines, agentContext);

  try {
    // Dynamically import callGateway to avoid circular dependency issues
    const { callGateway } = await import("../gateway/call.js");
    const { AGENT_LANE_HEALING } = await import("../agents/lanes.js");
    const { registerSubagentRun } = await import("../agents/subagent-registry.js");

    await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey: childSessionKey,
        idempotencyKey: runId,
        deliver: false,
        lane: AGENT_LANE_HEALING,
        extraSystemPrompt: buildHealingSystemPrompt(agentContext),
        thinking: config.thinking ?? "high",
        timeout: timeoutSeconds,
        label: `healing:${issue.signature.slice(0, 40)}`,
        spawnedBy: "system:log-monitor",
      },
      timeoutMs: 10_000,
    });

    // Register in subagent registry
    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: "system:log-monitor",
      requesterDisplayKey: "Log Monitor",
      task: agentContext?.task ?? `Heal: ${issue.message}`,
      cleanup: "delete",
      label: `healing:${issue.signature.slice(0, 40)}`,
      model: config.model,
      runTimeoutSeconds: timeoutSeconds,
    });

    // Track in active agents
    const timer = startEscalationTimer(runId, issue, timeoutSeconds * 1000, registry, deps);
    activeAgents.set(runId, {
      issueSignature: issue.signature,
      startedAt: Date.now(),
      timer,
    });

    // Update spawn tracking
    spawnHistory.push(Date.now());
    registry.markAgentDispatch(issue.signature);

    deps.logger?.info?.(`log-monitor: dispatched healing agent ${runId} for ${issue.signature}`);

    return { dispatched: true, runId, childSessionKey };
  } catch (err) {
    deps.logger?.warn?.(
      `log-monitor: failed to dispatch healing agent for ${issue.signature}: ${String(err)}`,
    );
    return { dispatched: false, reason: `dispatch-error: ${String(err)}` };
  }
}

// ============================================================================
// System Prompt for Healing Agent
// ============================================================================

function buildHealingSystemPrompt(context?: AgentContext): string {
  const severity = context?.severity ?? "medium";
  return `You are a self-healing agent spawned by the OpenClaw log monitor.
Your job is to diagnose and fix the detected issue.

Severity: ${severity}
${severity === "high" ? "You may restart services if necessary." : "Avoid restarting services unless absolutely required."}

Safety constraints:
- Do NOT send messages to users
- Do NOT modify wallet or brain data
- Do NOT install new packages
- Report your findings clearly in your final message
- If you cannot fix the issue, explain what you found and recommend next steps
`;
}

// ============================================================================
// Escalation Timer
// ============================================================================

function startEscalationTimer(
  runId: string,
  issue: LogMonitorIssue,
  timeoutMs: number,
  registry: IssueRegistry,
  deps: LogMonitorDeps,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const agent = activeAgents.get(runId);
    if (agent) {
      // Agent didn't complete in time → escalate
      surfaceIssueInternal(
        issue.signature,
        `${issue.message} (healing agent timed out after ${timeoutMs / 1000}s — needs manual review)`,
        deps,
      );
      registry.markAgentFailure(issue.signature);
      activeAgents.delete(runId);
    }
  }, timeoutMs);
  timer.unref();
  return timer;
}

// ============================================================================
// Agent Completion Handler
// ============================================================================

/**
 * Called when a healing agent completes (from subagent-announce flow).
 */
export function onHealingAgentComplete(
  runId: string,
  result: { success: boolean; summary: string },
  registry: IssueRegistry,
  deps: LogMonitorDeps,
): void {
  const agent = activeAgents.get(runId);
  if (!agent) {
    return;
  }

  // Clear escalation timer
  if (agent.timer) {
    clearTimeout(agent.timer);
  }
  activeAgents.delete(runId);

  if (result.success) {
    registry.resetAgentFailures(agent.issueSignature);
    deps.logger?.info?.(`log-monitor: healing agent ${runId} resolved issue: ${result.summary}`);
  } else {
    registry.markAgentFailure(agent.issueSignature);
    surfaceIssueInternal(
      `agent-failed:${runId}`,
      `Healing agent could not resolve: ${result.summary}`,
      deps,
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function surfaceIssueInternal(signature: string, message: string, deps: LogMonitorDeps): void {
  if (!deps.sessionKey) {
    return;
  }
  // Use dynamic import to avoid circular dependency
  import("./system-events.js")
    .then(({ enqueueSystemEvent }) => {
      const text = `[Log Monitor] ${message}`;
      enqueueSystemEvent(text, { sessionKey: deps.sessionKey! });
      deps.logger?.info?.(`log-monitor: surfaced issue ${signature}`);
    })
    .catch(() => {
      // Ignore import failure
    });
}

/**
 * Check if a session key belongs to a healing agent.
 */
export function isHealingAgentSession(sessionKey: string): boolean {
  return sessionKey.includes(":healing:");
}

/**
 * Get the active agent count (for testing/diagnostics).
 */
export function getActiveAgentCount(): number {
  return activeAgents.size;
}

/**
 * Reset module state (for testing).
 */
export function resetAgentDispatchState(): void {
  for (const [, agent] of activeAgents) {
    if (agent.timer) {
      clearTimeout(agent.timer);
    }
  }
  activeAgents.clear();
  spawnHistory.length = 0;
}
