/**
 * Log Monitor Agent Dispatch
 *
 * Dispatches healing sub-agents for issues that cannot be auto-resolved
 * by built-in handlers. Implements rate limiting, cooldown, and circuit
 * breaker patterns to prevent runaway agent spawning.
 */

import crypto from "node:crypto";
import type { AgentDispatchConfig, HealingApprovalGate } from "../config/types.log-monitor.js";
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
/** Cached registry reference, set on first dispatch call. */
let registryRef: IssueRegistry | null = null;

// ============================================================================
// Pending Approval Requests
// ============================================================================

export interface PendingApproval {
  id: string;
  issueSignature: string;
  issueMessage: string;
  severity: "low" | "medium" | "high";
  task: string;
  createdAt: number;
  expiresAt: number;
  opts: AgentDispatchOptions;
}

const pendingApprovals = new Map<string, PendingApproval>();
const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
// Approval Gate
// ============================================================================

type Severity = "low" | "medium" | "high";

export function requiresApproval(
  severity: Severity,
  gate: HealingApprovalGate | undefined,
): boolean {
  const mode = gate?.mode ?? "always";
  switch (mode) {
    case "off":
      return false;
    case "high-only":
      return severity === "high";
    case "medium-and-above":
      return severity === "medium" || severity === "high";
    case "always":
    default:
      return true;
  }
}

function requestApproval(opts: AgentDispatchOptions, severity: Severity): AgentDispatchResult {
  const id = crypto.randomUUID();
  const timeoutSeconds = opts.config.approvalGate?.timeoutSeconds ?? 300;
  const task = opts.agentContext?.task ?? `Heal: ${opts.issue.message}`;

  const pending: PendingApproval = {
    id,
    issueSignature: opts.issue.signature,
    issueMessage: opts.issue.message,
    severity,
    task,
    createdAt: Date.now(),
    expiresAt: Date.now() + timeoutSeconds * 1000,
    opts,
  };
  pendingApprovals.set(id, pending);

  // Set expiry timer
  const timer = setTimeout(() => {
    const expired = pendingApprovals.get(id);
    if (expired) {
      pendingApprovals.delete(id);
      approvalTimers.delete(id);
      opts.deps.logger?.info?.(
        `log-monitor: approval request ${id} expired for ${opts.issue.signature}`,
      );
    }
  }, timeoutSeconds * 1000);
  timer.unref();
  approvalTimers.set(id, timer);

  // Surface to user via system event with inline approve/reject buttons
  surfaceApprovalRequest(pending, opts.deps);

  opts.deps.logger?.info?.(
    `log-monitor: approval requested (${id}) for healing agent dispatch — severity=${severity}, issue=${opts.issue.signature}`,
  );

  return { dispatched: false, reason: `approval-pending:${id}` };
}

function surfaceApprovalRequest(pending: PendingApproval, deps: LogMonitorDeps): void {
  if (!deps.sessionKey) {
    return;
  }
  const severityEmoji =
    pending.severity === "high" ? "🔴" : pending.severity === "medium" ? "🟡" : "🟢";
  const text = [
    `${severityEmoji} **Healing Agent Approval Required**`,
    "",
    `**Issue:** ${pending.issueMessage}`,
    `**Severity:** ${pending.severity}`,
    `**Proposed action:** ${pending.task}`,
    "",
    `Approve: \`/heal approve ${pending.id}\``,
    `Reject: \`/heal reject ${pending.id}\``,
    "",
    `_Expires in ${Math.round((pending.expiresAt - pending.createdAt) / 1000)}s_`,
  ].join("\n");

  import("./system-events.js")
    .then(({ enqueueSystemEvent }) => {
      enqueueSystemEvent(text, { sessionKey: deps.sessionKey! });
    })
    .catch(() => {
      // Ignore import failure
    });
}

/**
 * Approve a pending healing agent dispatch.
 * Returns true if the approval was found and the agent was dispatched.
 */
export async function approveHealingDispatch(approvalId: string): Promise<{
  approved: boolean;
  dispatched: boolean;
  reason?: string;
}> {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return { approved: false, dispatched: false, reason: "approval-not-found-or-expired" };
  }

  // Clear pending state
  pendingApprovals.delete(approvalId);
  const timer = approvalTimers.get(approvalId);
  if (timer) {
    clearTimeout(timer);
    approvalTimers.delete(approvalId);
  }

  // Dispatch with gate bypassed
  const result = await dispatchHealingAgentInternal(pending.opts);
  return { approved: true, dispatched: result.dispatched, reason: result.reason };
}

/**
 * Reject a pending healing agent dispatch.
 */
export function rejectHealingDispatch(approvalId: string): { rejected: boolean; reason?: string } {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return { rejected: false, reason: "approval-not-found-or-expired" };
  }

  pendingApprovals.delete(approvalId);
  const timer = approvalTimers.get(approvalId);
  if (timer) {
    clearTimeout(timer);
    approvalTimers.delete(approvalId);
  }

  pending.opts.deps.logger?.info?.(
    `log-monitor: healing dispatch rejected by user for ${pending.issueSignature}`,
  );
  return { rejected: true };
}

/**
 * List all pending approval requests.
 */
export function listPendingApprovals(): PendingApproval[] {
  const now = Date.now();
  // Clean expired while listing
  for (const [id, pending] of pendingApprovals) {
    if (pending.expiresAt <= now) {
      pendingApprovals.delete(id);
      const timer = approvalTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        approvalTimers.delete(id);
      }
    }
  }
  return [...pendingApprovals.values()];
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Dispatch a healing agent for an unresolved issue.
 *
 * Uses callGateway to spawn a sub-agent session, similar to sessions-spawn-tool.
 * The agent runs in the background; escalation to user happens on timeout or failure.
 *
 * When an approval gate is configured (default: "always"), this will surface an
 * approval request to the user instead of dispatching immediately.
 */
export async function dispatchHealingAgent(
  opts: AgentDispatchOptions,
): Promise<AgentDispatchResult> {
  // Cache registry reference for use by completion callbacks
  registryRef = opts.registry;

  // Check approval gate
  const severity = opts.agentContext?.severity ?? "medium";
  if (requiresApproval(severity, opts.config.approvalGate)) {
    return requestApproval(opts, severity);
  }

  return dispatchHealingAgentInternal(opts);
}

/**
 * Internal dispatch — bypasses approval gate. Called directly after approval
 * or when gate mode is "off" / severity doesn't require approval.
 */
async function dispatchHealingAgentInternal(
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

  // Derive agentId from requester session key when available, so the child
  // session routes completion back correctly (e.g., agent:dev:healing:* → agent:dev:main)
  const requesterAgent = deps.sessionKey?.match(/^agent:([^:]+):/)?.[1];
  const agentId = requesterAgent ?? config.agentId ?? "system";
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
        spawnedBy: deps.sessionKey ?? "system:log-monitor",
      },
      timeoutMs: 10_000,
    });

    // Register in subagent registry — route completion back to whoever triggered
    const requesterSessionKey = deps.sessionKey ?? "system:log-monitor";
    registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterDisplayKey:
        requesterSessionKey === "system:log-monitor" ? "Log Monitor" : "Healing Gate",
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
 * If registry/deps are omitted, uses the cached references from the last dispatch.
 */
export function onHealingAgentComplete(
  runId: string,
  result: { success: boolean; summary: string },
  registry?: IssueRegistry | null,
  deps?: LogMonitorDeps | null,
): void {
  const agent = activeAgents.get(runId);
  if (!agent) {
    return;
  }

  const reg = registry ?? registryRef;

  // Clear escalation timer
  if (agent.timer) {
    clearTimeout(agent.timer);
  }
  activeAgents.delete(runId);

  if (result.success) {
    reg?.resetAgentFailures(agent.issueSignature);
    deps?.logger?.info?.(`log-monitor: healing agent ${runId} resolved issue: ${result.summary}`);
  } else {
    reg?.markAgentFailure(agent.issueSignature);
    surfaceIssueInternal(
      `agent-failed:${runId}`,
      `Healing agent could not resolve: ${result.summary}`,
      deps ?? { sessionKey: undefined, logger: undefined },
    );
  }
}

/**
 * Called from the subagent lifecycle when a healing session ends.
 * Reads the agent's final reply to determine success/failure.
 */
export async function handleHealingAgentLifecycleEnd(
  runId: string,
  childSessionKey: string,
  outcome: { status: string; error?: string },
): Promise<void> {
  const agent = activeAgents.get(runId);
  if (!agent) {
    return;
  }

  let summary = "";
  let success = outcome.status === "ok";

  try {
    const { readLatestAssistantReply } = await import("../agents/tools/agent-step.js");
    const reply = await readLatestAssistantReply({ sessionKey: childSessionKey });
    summary = reply?.trim() || "(no output)";

    // Heuristic: check if the agent reported failure
    if (success && summary) {
      const lower = summary.toLowerCase();
      const failureSignals = [
        "could not",
        "unable to",
        "failed to",
        "cannot fix",
        "escalat",
        "needs manual",
        "needs human",
      ];
      if (failureSignals.some((sig) => lower.includes(sig))) {
        success = false;
      }
    }
  } catch {
    summary = outcome.error ?? "unknown";
    success = false;
  }

  onHealingAgentComplete(runId, { success, summary });
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
  for (const [id] of approvalTimers) {
    const timer = approvalTimers.get(id);
    if (timer) {
      clearTimeout(timer);
    }
  }
  pendingApprovals.clear();
  approvalTimers.clear();
  registryRef = null;
}
