/**
 * T-006: Unified Identity Service
 *
 * - JSON file-based identity store with in-memory index
 * - Link code generation (6-char alphanumeric, 10-min TTL, in-memory only)
 * - Resolve: store → config → create new
 * - Atomic file writes
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LinkCode,
  LinkCodeExpiredError,
  LinkCodeNotFoundError,
  type UnifiedUser,
  SameSurfaceError,
  SurfaceNotLinkedError,
  LastSurfaceError,
  MaxCodesError,
} from "./types.js";

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CODES_PER_SURFACE = 3;
const GC_INTERVAL_MS = 60_000; // 1 minute

function generateCode(): string {
  // 6-char alphanumeric uppercase
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const bytes = randomBytes(6);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export class IdentityService {
  private users: Record<string, UnifiedUser> = {};
  /** surfaceKey ("surfaceId:surfaceUserId") → unified user ID */
  private surfaceLookup: Map<string, string> = new Map();
  /** Active link codes (in-memory only) */
  private linkCodes: Map<string, LinkCode> = new Map();

  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private readonly usersPath: string;
  private readonly manualLinksPath: string;

  constructor(dataDir: string) {
    this.usersPath = join(dataDir, "identity", "users.json");
    this.manualLinksPath = join(dataDir, "config", "manual-links.json");
    this.load();
    this.gcTimer = setInterval(() => this.gcLinkCodes(), GC_INTERVAL_MS);
    // Unref so it doesn't keep the process alive
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // ─── Link Codes ──────────────────────────────────────────────────────

  generateLinkCode(surfaceId: string, surfaceUserId: string): LinkCode {
    const issuedBy = `${surfaceId}:${surfaceUserId}`;

    // Enforce max active codes per surface identity
    let activeCount = 0;
    for (const lc of this.linkCodes.values()) {
      if (lc.issuedBy === issuedBy && !lc.claimed) activeCount++;
    }
    if (activeCount >= MAX_CODES_PER_SURFACE) throw new MaxCodesError();

    // Generate unique code
    let code: string;
    do {
      code = generateCode();
    } while (this.linkCodes.has(code));

    const now = new Date().toISOString();
    const linkCode: LinkCode = {
      code,
      issuedBy,
      issuedAt: now,
      expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(),
      claimed: false,
    };

    this.linkCodes.set(code, linkCode);
    return linkCode;
  }

  claimLinkCode(
    code: string,
    surfaceId: string,
    surfaceUserId: string,
  ): UnifiedUser {
    const lc = this.linkCodes.get(code);
    if (!lc) throw new LinkCodeNotFoundError();
    if (lc.claimed || new Date(lc.expiresAt) < new Date()) {
      this.linkCodes.delete(code);
      throw new LinkCodeExpiredError();
    }

    // Parse issuer
    const [issuerSurface, issuerUserId] = lc.issuedBy.split(":", 2);
    if (surfaceId === issuerSurface && surfaceUserId === issuerUserId) {
      throw new SameSurfaceError();
    }

    // Claim
    lc.claimed = true;
    this.linkCodes.delete(code);

    // Resolve or create user for issuer
    const issuerUser = this.resolveUser(issuerSurface, issuerUserId);

    // Check if claimer already has a user — merge if so
    const claimerKey = `${surfaceId}:${surfaceUserId}`;
    const existingClaimerId = this.surfaceLookup.get(claimerKey);

    if (existingClaimerId && existingClaimerId !== issuerUser.id) {
      // Merge claimer into issuer
      const claimerUser = this.users[existingClaimerId];
      if (claimerUser) {
        for (const [sId, sUserId] of Object.entries(
          claimerUser.linkedSurfaces,
        )) {
          issuerUser.linkedSurfaces[sId] = sUserId;
          issuerUser.linkedAt[sId] =
            claimerUser.linkedAt[sId] ?? new Date().toISOString();
          this.surfaceLookup.set(`${sId}:${sUserId}`, issuerUser.id);
        }
        delete this.users[existingClaimerId];
      }
    } else {
      // Just link the new surface
      const now = new Date().toISOString();
      issuerUser.linkedSurfaces[surfaceId] = surfaceUserId;
      issuerUser.linkedAt[surfaceId] = now;
      this.surfaceLookup.set(claimerKey, issuerUser.id);
    }

    this.save();
    return issuerUser;
  }

  // ─── User Resolution ──────────────────────────────────────────────────

  resolveUser(surfaceId: string, surfaceUserId: string): UnifiedUser {
    const key = `${surfaceId}:${surfaceUserId}`;

    // 1. Check store
    const existingId = this.surfaceLookup.get(key);
    if (existingId && this.users[existingId]) return this.users[existingId];

    // 2. Check manual links
    const manualId = this.findManualLink(surfaceId, surfaceUserId);
    if (manualId && this.users[manualId]) {
      // Index it
      this.surfaceLookup.set(key, manualId);
      this.users[manualId].linkedSurfaces[surfaceId] = surfaceUserId;
      this.users[manualId].linkedAt[surfaceId] = new Date().toISOString();
      this.save();
      return this.users[manualId];
    }

    // 3. Create new
    const now = new Date().toISOString();
    const user: UnifiedUser = {
      id: `user-${randomUUID().slice(0, 12)}`,
      linkedSurfaces: { [surfaceId]: surfaceUserId },
      defaultSurface: surfaceId,
      linkedAt: { [surfaceId]: now },
      createdAt: now,
    };

    this.users[user.id] = user;
    this.surfaceLookup.set(key, user.id);
    this.save();
    return user;
  }

  // ─── Manual Linking ────────────────────────────────────────────────────

  linkManual(
    unifiedUserId: string,
    surfaceId: string,
    surfaceUserId: string,
  ): void {
    const user = this.users[unifiedUserId];
    if (!user) throw new Error(`User "${unifiedUserId}" not found`);

    const now = new Date().toISOString();
    user.linkedSurfaces[surfaceId] = surfaceUserId;
    user.linkedAt[surfaceId] = now;
    this.surfaceLookup.set(`${surfaceId}:${surfaceUserId}`, unifiedUserId);
    this.save();
  }

  setDefaultSurface(unifiedUserId: string, surfaceId: string): void {
    const user = this.users[unifiedUserId];
    if (!user) throw new Error(`User "${unifiedUserId}" not found`);
    if (!user.linkedSurfaces[surfaceId]) {
      throw new SurfaceNotLinkedError(surfaceId);
    }
    user.defaultSurface = surfaceId;
    this.save();
  }

  unlinkSurface(unifiedUserId: string, surfaceId: string): void {
    const user = this.users[unifiedUserId];
    if (!user) throw new Error(`User "${unifiedUserId}" not found`);
    if (Object.keys(user.linkedSurfaces).length <= 1) {
      throw new LastSurfaceError();
    }
    const surfaceUserId = user.linkedSurfaces[surfaceId];
    if (!surfaceUserId) throw new SurfaceNotLinkedError(surfaceId);

    delete user.linkedSurfaces[surfaceId];
    delete user.linkedAt[surfaceId];
    this.surfaceLookup.delete(`${surfaceId}:${surfaceUserId}`);

    if (user.defaultSurface === surfaceId) {
      user.defaultSurface = Object.keys(user.linkedSurfaces)[0];
    }
    this.save();
  }

  getUser(unifiedUserId: string): UnifiedUser | null {
    return this.users[unifiedUserId] ?? null;
  }

  getUserBySurface(surfaceId: string, surfaceUserId: string): UnifiedUser | null {
    const id = this.surfaceLookup.get(`${surfaceId}:${surfaceUserId}`);
    return id ? (this.users[id] ?? null) : null;
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private load(): void {
    if (existsSync(this.usersPath)) {
      try {
        const raw = readFileSync(this.usersPath, "utf-8");
        this.users = JSON.parse(raw);
        this.rebuildIndex();
      } catch {
        this.users = {};
      }
    }
  }

  private rebuildIndex(): void {
    this.surfaceLookup.clear();
    for (const [userId, user] of Object.entries(this.users)) {
      for (const [surfaceId, surfaceUserId] of Object.entries(
        user.linkedSurfaces,
      )) {
        this.surfaceLookup.set(`${surfaceId}:${surfaceUserId}`, userId);
      }
    }
  }

  private save(): void {
    const dir = dirname(this.usersPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const tmp = `${this.usersPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.users, null, 2), "utf-8");
    renameSync(tmp, this.usersPath);
  }

  private findManualLink(
    surfaceId: string,
    surfaceUserId: string,
  ): string | null {
    if (!existsSync(this.manualLinksPath)) return null;
    try {
      const raw = readFileSync(this.manualLinksPath, "utf-8");
      const links: Record<string, Record<string, string>> = JSON.parse(raw);
      // links = { "user-id": { "telegram": "12345", "slack": "U04ABC" } }
      for (const [userId, surfaces] of Object.entries(links)) {
        if (surfaces[surfaceId] === surfaceUserId) return userId;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private gcLinkCodes(): void {
    const now = Date.now();
    for (const [code, lc] of this.linkCodes) {
      if (lc.claimed || new Date(lc.expiresAt).getTime() < now) {
        this.linkCodes.delete(code);
      }
    }
  }
}
