/**
 * T-007: Message Router
 *
 * - routeResponse: send to last-active surface (follow the user)
 * - routeProactive: send to default surface
 * - Queue on failure with exponential backoff
 * - Reroute if user interacts on different surface before delivery
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InteractionPrimitive } from "./primitives.js";
import type {
  MessagePayload,
  RenderContext,
  RenderedMessage,
  SendResult,
  SurfaceAdapter,
  SurfaceTarget,
} from "./adapter.js";
import type { IdentityService } from "./identity/identity-service.js";

// ─── Queue Types ────────────────────────────────────────────────────────────

interface QueueEntry {
  id: string;
  userId: string;
  targetSurface: string;
  message: MessagePayload;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  maxAttempts: number;
}

const BACKOFF_MS = [10_000, 30_000, 90_000, 270_000, 810_000];
const MAX_QUEUE_PER_USER = 100;
const QUEUE_PROCESS_INTERVAL_MS = 30_000;

export class MessageRouter {
  private adapters: Map<string, SurfaceAdapter> = new Map();
  private queue: QueueEntry[] = [];
  private readonly queuePath: string;
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private identityService: IdentityService;

  constructor(dataDir: string, identityService: IdentityService) {
    this.identityService = identityService;
    this.queuePath = join(dataDir, "workflows", "message-queue.json");
    this.loadQueue();
    this.processTimer = setInterval(
      () => this.processQueue(),
      QUEUE_PROCESS_INTERVAL_MS,
    );
    if (this.processTimer.unref) {this.processTimer.unref();}
  }

  destroy(): void {
    this.saveQueue();
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  registerAdapter(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.surfaceId, adapter);
  }

  getAdapter(surfaceId: string): SurfaceAdapter | undefined {
    return this.adapters.get(surfaceId);
  }

  // ─── Routing ──────────────────────────────────────────────────────────

  /**
   * Route response to the surface the user last interacted from.
   */
  async routeResponse(
    userId: string,
    lastSurface: SurfaceTarget,
    message: MessagePayload,
  ): Promise<SendResult> {
    const adapter = this.adapters.get(lastSurface.surfaceId);
    if (!adapter) {
      this.queueForRetry(userId, lastSurface.surfaceId, message);
      return { messageId: "" };
    }

    try {
      return await adapter.sendMessage(lastSurface, message);
    } catch {
      this.queueForRetry(userId, lastSurface.surfaceId, message);
      return { messageId: "" };
    }
  }

  /**
   * Route proactive message to user's default surface.
   */
  async routeProactive(
    userId: string,
    message: MessagePayload,
  ): Promise<SendResult> {
    const user = this.identityService.getUser(userId);
    if (!user) {return { messageId: "" };}

    const surfaceId = user.defaultSurface;
    const surfaceUserId = user.linkedSurfaces[surfaceId];
    if (!surfaceUserId) {return { messageId: "" };}

    const target: SurfaceTarget = { surfaceId, surfaceUserId };
    const adapter = this.adapters.get(surfaceId);
    if (!adapter) {
      this.queueForRetry(userId, surfaceId, message);
      return { messageId: "" };
    }

    try {
      return await adapter.sendMessage(target, message);
    } catch {
      this.queueForRetry(userId, surfaceId, message);
      return { messageId: "" };
    }
  }

  /**
   * Route a workflow primitive render.
   */
  async routeWorkflowRender(
    userId: string,
    surface: SurfaceTarget,
    primitive: InteractionPrimitive,
    context: RenderContext,
  ): Promise<RenderedMessage> {
    const adapter = this.adapters.get(surface.surfaceId);
    if (!adapter) {
      return {
        messageId: "",
        usedFallback: true,
        fallbackType: "notify-blocked",
      };
    }
    return adapter.render(surface, primitive, context);
  }

  // ─── Queue ────────────────────────────────────────────────────────────

  queueForRetry(
    userId: string,
    targetSurface: string,
    message: MessagePayload,
  ): void {
    // Enforce per-user limit
    const userEntries = this.queue.filter((e) => e.userId === userId);
    if (userEntries.length >= MAX_QUEUE_PER_USER) {
      // Remove oldest
      const oldest = userEntries.toSorted(
        (a, b) =>
          new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime(),
      )[0];
      this.queue = this.queue.filter((e) => e.id !== oldest.id);
    }

    this.queue.push({
      id: randomUUID(),
      userId,
      targetSurface,
      message,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      maxAttempts: 5,
    });
    this.saveQueue();
  }

  async processQueue(userId?: string): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const entry of this.queue) {
      if (userId && entry.userId !== userId) {continue;}

      // Check backoff
      if (entry.lastAttemptAt) {
        const backoff = BACKOFF_MS[Math.min(entry.attempts - 1, BACKOFF_MS.length - 1)];
        if (now - new Date(entry.lastAttemptAt).getTime() < backoff) {continue;}
      }

      if (entry.attempts >= entry.maxAttempts) {
        toRemove.push(entry.id);
        continue;
      }

      const adapter = this.adapters.get(entry.targetSurface);
      if (!adapter) {
        entry.attempts++;
        entry.lastAttemptAt = new Date().toISOString();
        continue;
      }

      // Resolve target
      const user = this.identityService.getUser(entry.userId);
      if (!user) {
        toRemove.push(entry.id);
        continue;
      }

      const surfaceUserId = user.linkedSurfaces[entry.targetSurface];
      if (!surfaceUserId) {
        toRemove.push(entry.id);
        continue;
      }

      try {
        await adapter.sendMessage(
          { surfaceId: entry.targetSurface, surfaceUserId },
          entry.message,
        );
        toRemove.push(entry.id);
      } catch {
        entry.attempts++;
        entry.lastAttemptAt = new Date().toISOString();
      }
    }

    if (toRemove.length > 0) {
      this.queue = this.queue.filter((e) => !toRemove.includes(e.id));
      this.saveQueue();
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private loadQueue(): void {
    if (!existsSync(this.queuePath)) {return;}
    try {
      const raw = readFileSync(this.queuePath, "utf-8");
      this.queue = JSON.parse(raw);
    } catch {
      this.queue = [];
    }
  }

  private saveQueue(): void {
    const dir = dirname(this.queuePath);
    if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}
    const tmp = `${this.queuePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.queue, null, 2), "utf-8");
    renameSync(tmp, this.queuePath);
  }
}
