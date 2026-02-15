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

export type IssueCategory = "network" | "crash" | "stuck-session" | "error" | "unknown";

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
      });
    }

    const record = issues.get(issue.signature)!;

    const meetsThreshold = record.occurrences >= config.minOccurrences;
    const outsideDedupeWindow =
      record.lastSurfacedMs === 0 || now - record.lastSurfacedMs > config.dedupeWindowMs;

    const shouldSurface = meetsThreshold && outsideDedupeWindow;

    // Auto-resolve: only if surfacing AND no recent attempt
    const recentAutoResolve =
      record.lastAutoResolveMs > 0 && now - record.lastAutoResolveMs < AUTO_RESOLVE_COOLDOWN_MS;
    const shouldAutoResolve = shouldSurface && config.autoResolve && !recentAutoResolve;

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
          issues.set(sig, record as IssueRecord);
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
    flush,
    load,
    reset,
  };
}
