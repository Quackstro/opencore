/**
 * Log Monitor Issue Registry
 *
 * Tracks detected issues with time-windowed deduplication to prevent
 * notification spam. Persists state to disk so cursors survive restarts.
 * Uses the existing DedupeCache for in-memory TTL checks.
 */

import { homedir } from "node:os";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

// ============================================================================
// Types
// ============================================================================

export type IssueCategory = "network" | "crash" | "stuck-session" | "error" | "security" | "unknown";

export interface IssueRecord {
  signature: string;
  category: IssueCategory;
  message: string;
  occurrences: number;
  firstSeenMs: number;
  lastSeenMs: number;
  lastSurfacedMs: number;
  autoResolveAttempts: number;
  lastAutoResolveMs: number;
  /** Number of consecutive agent dispatch failures for circuit breaker. */
  agentFailures: number;
  /** Timestamp of the last agent failure. */
  lastAgentFailureMs: number;
  /** Timestamp of the last agent dispatch. */
  lastAgentDispatchMs: number;
}

export interface IssueDecision {
  shouldSurface: boolean;
  shouldAutoResolve: boolean;
}

interface RegistryState {
  cursor: number;
  issues: Record<string, IssueRecord>;
}

export interface IssueRegistryConfig {
  dedupeWindowMs: number;
  minOccurrences: number;
  autoResolve: boolean;
  stateDir?: string;
}

const DEFAULT_STATE_DIR = path.join(homedir(), ".openclaw", "log-monitor");
const AUTO_RESOLVE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ============================================================================
// Registry
// ============================================================================

export interface IssueRegistry {
  /** Record an issue and get back the dedup decision. */
  record(issue: { signature: string; category: IssueCategory; message: string }): IssueDecision;
  /** Get the current log cursor position (byte offset). */
  getCursor(): number;
  /** Set the log cursor position. */
  setCursor(cursor: number): void;
  /** Mark an issue as having had an auto-resolve attempt. */
  markAutoResolveAttempt(signature: string): void;
  /** Mark an agent dispatch for an issue. */
  markAgentDispatch(signature: string): void;
  /** Mark an agent failure for an issue (increments circuit breaker counter). */
  markAgentFailure(signature: string): void;
  /** Reset agent failure counter (on success). */
  resetAgentFailures(signature: string): void;
  /** Get the issue record for a signature. */
  getIssue(signature: string): IssueRecord | undefined;
  /** Persist state to disk. */
  flush(): void;
  /** Load state from disk. */
  load(): void;
  /** Reset all state (for testing). */
  reset(): void;
}

export function createIssueRegistry(config: IssueRegistryConfig): IssueRegistry {
  const stateDir = config.stateDir ?? DEFAULT_STATE_DIR;
  const statePath = path.join(stateDir, "registry.json");

  let cursor = 0;
  const issues = new Map<string, IssueRecord>();

  function record(issue: {
    signature: string;
    category: IssueCategory;
    message: string;
  }): IssueDecision {
    const now = Date.now();
    const existing = issues.get(issue.signature);

    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenMs = now;
      existing.message = issue.message;
    } else {
      issues.set(issue.signature, {
        signature: issue.signature,
        category: issue.category,
        message: issue.message,
        occurrences: 1,
        firstSeenMs: now,
        lastSeenMs: now,
        lastSurfacedMs: 0,
        autoResolveAttempts: 0,
        lastAutoResolveMs: 0,
        agentFailures: 0,
        lastAgentFailureMs: 0,
        lastAgentDispatchMs: 0,
      });
    }

    const record = issues.get(issue.signature)!;

    const meetsThreshold = record.occurrences >= config.minOccurrences;
    const outsideDedupeWindow =
      record.lastSurfacedMs === 0 || now - record.lastSurfacedMs > config.dedupeWindowMs;

    const shouldSurface = meetsThreshold && outsideDedupeWindow;

    // Auto-resolve: fire on surface, OR when occurrences cross escalation
    // thresholds (5, 10, ...) to allow re-evaluation (e.g. failed → needs-agent)
    const recentAutoResolve =
      record.lastAutoResolveMs > 0 && now - record.lastAutoResolveMs < AUTO_RESOLVE_COOLDOWN_MS;
    const escalationThresholds = [5, 10, 20, 50];
    const justCrossedThreshold = escalationThresholds.some(
      (t) => record.occurrences === t,
    );
    const shouldAutoResolve =
      config.autoResolve && !recentAutoResolve && (shouldSurface || justCrossedThreshold);

    if (shouldSurface) {
      record.lastSurfacedMs = now;
    }

    return { shouldSurface, shouldAutoResolve };
  }

  function markAutoResolveAttempt(signature: string): void {
    const issue = issues.get(signature);
    if (issue) {
      issue.autoResolveAttempts += 1;
      issue.lastAutoResolveMs = Date.now();
    }
  }

  function markAgentDispatch(signature: string): void {
    const issue = issues.get(signature);
    if (issue) {
      issue.lastAgentDispatchMs = Date.now();
    }
  }

  function markAgentFailure(signature: string): void {
    const issue = issues.get(signature);
    if (issue) {
      issue.agentFailures += 1;
      issue.lastAgentFailureMs = Date.now();
    }
  }

  function resetAgentFailures(signature: string): void {
    const issue = issues.get(signature);
    if (issue) {
      issue.agentFailures = 0;
      issue.lastAgentFailureMs = 0;
    }
  }

  function getIssue(signature: string): IssueRecord | undefined {
    return issues.get(signature);
  }

  function flush(): void {
    const state: RegistryState = {
      cursor,
      issues: Object.fromEntries(issues),
    };
    saveJsonFile(statePath, state);
  }

  function load(): void {
    const raw = loadJsonFile(statePath) as RegistryState | undefined;
    if (!raw) {
      return;
    }
    if (typeof raw.cursor === "number") {
      cursor = raw.cursor;
    }
    if (raw.issues && typeof raw.issues === "object") {
      for (const [sig, record] of Object.entries(raw.issues)) {
        if (record && typeof record === "object" && typeof record.signature === "string") {
          issues.set(sig, record);
        }
      }
    }
  }

  function reset(): void {
    cursor = 0;
    issues.clear();
  }

  return {
    record,
    getCursor: () => cursor,
    setCursor: (c: number) => {
      cursor = c;
    },
    markAutoResolveAttempt,
    markAgentDispatch,
    markAgentFailure,
    resetAgentFailures,
    getIssue,
    flush,
    load,
    reset,
  };
}
