/**
 * Logging circuit breaker — prevents log writes from filling the disk.
 *
 * Provides two layers of protection:
 *  1. Per-file size cap with automatic rotation (truncate-and-rename)
 *  2. Global disk-space check that trips a breaker when free space is critically low
 *
 * All file-writing log paths should call `guardedAppend` / `guardedAppendSync`
 * instead of raw `fs.appendFile` / `fs.appendFileSync`.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default max bytes per individual log file (50 MB). */
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** When rotating, keep the tail of the file (last N bytes). Set to 0 to truncate entirely. */
const DEFAULT_KEEP_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB

/** Minimum free disk space before the global breaker trips (100 MB). */
const MIN_FREE_DISK_BYTES = 100 * 1024 * 1024;

/** How often (ms) we re-check disk space when the breaker is tripped. */
const DISK_CHECK_INTERVAL_MS = 30_000; // 30 s

/** How often (ms) we proactively check disk space when the breaker is healthy. */
const DISK_HEALTHY_CHECK_INTERVAL_MS = 60_000; // 60 s

/** How often (ms) we check a single file's size. */
const FILE_SIZE_CHECK_INTERVAL_MS = 10_000; // 10 s

// ---------------------------------------------------------------------------
// Global disk-space breaker
// ---------------------------------------------------------------------------

let breakerTripped = false;
let lastDiskCheckMs = 0;
let diskCheckPromise: Promise<void> | null = null;

async function checkDiskSpace(): Promise<boolean> {
  try {
    const stats = await fsPromises.statfs("/");
    const freeBytes = stats.bfree * stats.bsize;
    return freeBytes > MIN_FREE_DISK_BYTES;
  } catch {
    // If we can't check, assume OK to avoid silencing all logs on a stat error
    return true;
  }
}

async function refreshDiskBreaker(): Promise<void> {
  const ok = await checkDiskSpace();
  breakerTripped = !ok;
  lastDiskCheckMs = Date.now();
}

function maybeRefreshDiskBreaker(): void {
  const interval = breakerTripped ? DISK_CHECK_INTERVAL_MS : DISK_HEALTHY_CHECK_INTERVAL_MS;
  if (Date.now() - lastDiskCheckMs < interval) {
    return;
  }
  if (diskCheckPromise) {
    return; // already in-flight
  }
  diskCheckPromise = refreshDiskBreaker().finally(() => {
    diskCheckPromise = null;
  });
}

/**
 * Returns true when log writes should be suppressed (disk critically full).
 * Callers should check this before attempting any write.
 */
export function isBreakerTripped(): boolean {
  maybeRefreshDiskBreaker();
  return breakerTripped;
}

// ---------------------------------------------------------------------------
// Per-file size tracking & rotation
// ---------------------------------------------------------------------------

type FileSizeEntry = {
  sizeBytes: number;
  lastCheckMs: number;
  rotating: boolean;
};

const fileSizeCache = new Map<string, FileSizeEntry>();

function getCachedSize(filePath: string): number {
  const entry = fileSizeCache.get(filePath);
  if (entry && Date.now() - entry.lastCheckMs < FILE_SIZE_CHECK_INTERVAL_MS) {
    return entry.sizeBytes;
  }
  // Synchronous stat — cheap and avoids async complexity in the hot path.
  try {
    const stat = fs.statSync(filePath);
    const sizeBytes = stat.size;
    fileSizeCache.set(filePath, {
      sizeBytes,
      lastCheckMs: Date.now(),
      rotating: entry?.rotating ?? false,
    });
    return sizeBytes;
  } catch {
    return 0; // file doesn't exist yet
  }
}

function bumpCachedSize(filePath: string, addedBytes: number): void {
  const entry = fileSizeCache.get(filePath);
  if (entry) {
    entry.sizeBytes += addedBytes;
  }
}

/**
 * Rotates a log file by keeping only the last `keepTailBytes` of content.
 * If `keepTailBytes` is 0, the file is truncated to empty.
 * The old content is moved to `<file>.1` (single generation).
 */
async function rotateFile(filePath: string, keepTailBytes: number): Promise<void> {
  const entry = fileSizeCache.get(filePath);
  if (entry?.rotating) {
    return; // rotation already in progress
  }
  if (entry) {
    entry.rotating = true;
  }

  try {
    const rotatedPath = `${filePath}.1`;
    try {
      await fsPromises.rm(rotatedPath, { force: true });
    } catch {
      // ignore
    }

    if (keepTailBytes <= 0) {
      // Simple case: archive the whole file, start fresh
      try {
        await fsPromises.rename(filePath, rotatedPath);
      } catch {
        // If rename fails (e.g., file locked on Windows), truncate in-place
        await fsPromises.truncate(filePath, 0);
      }
    } else {
      // Keep the tail: read last N bytes, write to new file, swap
      const handle = await fsPromises.open(filePath, "r");
      try {
        const stat = await handle.stat();
        const start = Math.max(0, stat.size - keepTailBytes);
        const buf = Buffer.alloc(stat.size - start);
        await handle.read(buf, 0, buf.length, start);
        await handle.close();

        // Move old file to .1
        try {
          await fsPromises.rename(filePath, rotatedPath);
        } catch {
          // ignore
        }
        // Write tail to the original path
        await fsPromises.writeFile(filePath, buf);
      } catch {
        try {
          await handle.close();
        } catch {
          // ignore
        }
        // Fallback: just truncate
        try {
          await fsPromises.truncate(filePath, 0);
        } catch {
          // ignore
        }
      }
    }

    // Reset cached size
    fileSizeCache.set(filePath, {
      sizeBytes: keepTailBytes,
      lastCheckMs: Date.now(),
      rotating: false,
    });
  } catch {
    // Worst case: mark rotation done so we don't block forever
    if (entry) {
      entry.rotating = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: guarded append helpers
// ---------------------------------------------------------------------------

export type GuardedAppendOptions = {
  /** Max file size in bytes before rotation kicks in. Default: 50 MB. */
  maxFileBytes?: number;
  /** Bytes to keep from the tail after rotation. Default: 2 MB. 0 = truncate entirely. */
  keepTailBytes?: number;
};

/**
 * Synchronous guarded append. Drops the write if the circuit breaker is tripped
 * or the file exceeds its size limit (and triggers async rotation).
 *
 * Use this in the core logger transport where synchronous writes are required.
 */
export function guardedAppendSync(
  filePath: string,
  data: string,
  options?: GuardedAppendOptions,
): void {
  if (isBreakerTripped()) {
    return;
  }

  const maxBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const keepTail = options?.keepTailBytes ?? DEFAULT_KEEP_TAIL_BYTES;
  const currentSize = getCachedSize(filePath);

  if (currentSize > maxBytes) {
    // Trigger async rotation, skip this write
    void rotateFile(filePath, keepTail);
    return;
  }

  try {
    fs.appendFileSync(filePath, data, { encoding: "utf8" });
    bumpCachedSize(filePath, Buffer.byteLength(data, "utf8"));
  } catch {
    // never block on logging failures
  }
}

/** Set of directories we've already ensured exist. */
const ensuredDirs = new Set<string>();

/**
 * Async guarded append. Returns a promise that resolves when the write completes
 * (or is dropped). Performs rotation inline when the file exceeds its limit.
 * Automatically creates the parent directory on first write to a new path.
 */
export async function guardedAppend(
  filePath: string,
  data: string,
  options?: GuardedAppendOptions,
): Promise<void> {
  if (isBreakerTripped()) {
    return;
  }

  const maxBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const keepTail = options?.keepTailBytes ?? DEFAULT_KEEP_TAIL_BYTES;
  const currentSize = getCachedSize(filePath);

  if (currentSize > maxBytes) {
    await rotateFile(filePath, keepTail);
    // After rotation the file is small again; allow this write through
  }

  const dir = path.dirname(filePath);
  if (!ensuredDirs.has(dir)) {
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch {
      // ignore
    }
    ensuredDirs.add(dir);
  }

  try {
    await fsPromises.appendFile(filePath, data, "utf8");
    bumpCachedSize(filePath, Buffer.byteLength(data, "utf8"));
  } catch {
    // never block on logging failures
  }
}

// ---------------------------------------------------------------------------
// Periodic pruning — clean up old rolling log files
// ---------------------------------------------------------------------------

let pruneIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic prune of rolling log files in `dir`.
 * Safe to call multiple times — only one interval will be active.
 */
export function startPeriodicPrune(dir: string, maxAgeMs: number): void {
  if (pruneIntervalHandle) {
    return;
  }
  const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
  pruneIntervalHandle = setInterval(() => {
    pruneOldFiles(dir, maxAgeMs);
  }, PRUNE_INTERVAL_MS);
  // Don't keep the process alive just for pruning
  if (
    pruneIntervalHandle &&
    typeof pruneIntervalHandle === "object" &&
    "unref" in pruneIntervalHandle
  ) {
    pruneIntervalHandle.unref();
  }
}

function pruneOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore missing dir
  }
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  breakerTripped = false;
  lastDiskCheckMs = 0;
  diskCheckPromise = null;
  fileSizeCache.clear();
  if (pruneIntervalHandle) {
    clearInterval(pruneIntervalHandle);
    pruneIntervalHandle = null;
  }
}
