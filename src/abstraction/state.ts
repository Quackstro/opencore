/**
 * T-004: Workflow State Manager
 *
 * CRUD for workflow states keyed by userId + workflowId.
 * - File-based persistence (atomic writes)
 * - TTL enforcement on read
 * - GC sweep every 5 minutes
 * - Survives agent restart (NFR-003)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowState } from "./types/workflow.js";

const GC_INTERVAL_MS = 5 * 60 * 1000;

function stateKey(userId: string, workflowId: string): string {
  return `${userId}::${workflowId}`;
}

export class WorkflowStateManager {
  private states: Record<string, WorkflowState> = {};
  private dirty = false;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly statesPath: string;

  constructor(dataDir: string) {
    this.statesPath = join(dataDir, "workflows", "states.json");
    this.load();
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  destroy(): void {
    if (this.dirty) this.save();
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  create(state: WorkflowState): void {
    const key = stateKey(state.userId, state.workflowId);
    // Cancel existing if any
    if (this.states[key]) {
      delete this.states[key];
    }
    this.states[key] = state;
    this.dirty = true;
    this.save();
  }

  get(userId: string, workflowId: string): WorkflowState | null {
    const key = stateKey(userId, workflowId);
    const state = this.states[key];
    if (!state) return null;

    // TTL check
    if (new Date(state.expiresAt).getTime() < Date.now()) {
      delete this.states[key];
      this.dirty = true;
      this.save();
      return null;
    }

    return state;
  }

  update(state: WorkflowState): void {
    const key = stateKey(state.userId, state.workflowId);
    this.states[key] = state;
    this.dirty = true;
    this.save();
  }

  delete(userId: string, workflowId: string): boolean {
    const key = stateKey(userId, workflowId);
    if (!this.states[key]) return false;
    delete this.states[key];
    this.dirty = true;
    this.save();
    return true;
  }

  /**
   * Get any active (non-expired) workflow for a user.
   * Returns the first one found (typically there's only one active per user).
   */
  getActiveForUser(userId: string): WorkflowState | null {
    const now = Date.now();
    for (const [key, state] of Object.entries(this.states)) {
      if (state.userId !== userId) continue;
      if (new Date(state.expiresAt).getTime() < now) {
        delete this.states[key];
        this.dirty = true;
        continue;
      }
      return state;
    }
    if (this.dirty) this.save();
    return null;
  }

  /**
   * Get all active workflows for a user (rare — usually 0 or 1).
   */
  getAllForUser(userId: string): WorkflowState[] {
    const now = Date.now();
    const result: WorkflowState[] = [];
    for (const [key, state] of Object.entries(this.states)) {
      if (state.userId !== userId) continue;
      if (new Date(state.expiresAt).getTime() < now) {
        delete this.states[key];
        this.dirty = true;
        continue;
      }
      result.push(state);
    }
    if (this.dirty) this.save();
    return result;
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.statesPath)) return;
    try {
      const raw = readFileSync(this.statesPath, "utf-8");
      this.states = JSON.parse(raw);
    } catch {
      this.states = {};
    }
  }

  private save(): void {
    const dir = dirname(this.statesPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmp = `${this.statesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.states, null, 2), "utf-8");
    renameSync(tmp, this.statesPath);
    this.dirty = false;
  }

  private gc(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, state] of Object.entries(this.states)) {
      if (new Date(state.expiresAt).getTime() < now) {
        delete this.states[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
