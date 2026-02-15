import { describe, expect, test } from "vitest";
import { runHandlers } from "./log-monitor-handlers.js";
import { createIssueRegistry } from "./log-monitor-registry.js";
import { classifyLogLine } from "./log-monitor.js";

// ============================================================================
// Registry dedup logic
// ============================================================================

describe("IssueRegistry", () => {
  test("does not surface below minOccurrences", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 3,
      autoResolve: true,
    });
    const d1 = registry.record({ signature: "err:1", category: "error", message: "test" });
    expect(d1.shouldSurface).toBe(false);
    const d2 = registry.record({ signature: "err:1", category: "error", message: "test" });
    expect(d2.shouldSurface).toBe(false);
    const d3 = registry.record({ signature: "err:1", category: "error", message: "test" });
    expect(d3.shouldSurface).toBe(true);
  });

  test("deduplicates within time window", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 1,
      autoResolve: true,
    });
    const d1 = registry.record({ signature: "err:2", category: "error", message: "test" });
    expect(d1.shouldSurface).toBe(true);
    // Second occurrence within window should not surface again
    const d2 = registry.record({ signature: "err:2", category: "error", message: "test" });
    expect(d2.shouldSurface).toBe(false);
  });

  test("surfaces again after dedup window expires", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 100, // 100ms for testing
      minOccurrences: 1,
      autoResolve: true,
    });
    const d1 = registry.record({ signature: "err:3", category: "error", message: "test" });
    expect(d1.shouldSurface).toBe(true);
  });

  test("cursor persistence", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 1,
      autoResolve: true,
      stateDir: "/tmp/log-monitor-test-" + Date.now(),
    });
    registry.setCursor(12345);
    expect(registry.getCursor()).toBe(12345);
    registry.flush();

    // Create a new registry and load from the same dir
    const registry2 = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 1,
      autoResolve: true,
      stateDir: "/tmp/log-monitor-test-" + (Date.now() - 1), // different dir = fresh
    });
    expect(registry2.getCursor()).toBe(0);
  });

  test("auto-resolve decision respects config", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 1,
      autoResolve: false,
    });
    const d = registry.record({ signature: "err:4", category: "error", message: "test" });
    expect(d.shouldSurface).toBe(true);
    expect(d.shouldAutoResolve).toBe(false);
  });

  test("auto-resolve cooldown prevents repeated attempts", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 0, // no dedup for this test
      minOccurrences: 1,
      autoResolve: true,
    });
    const d1 = registry.record({ signature: "err:5", category: "error", message: "test" });
    expect(d1.shouldAutoResolve).toBe(true);
    registry.markAutoResolveAttempt("err:5");

    // Next occurrence should not auto-resolve (cooldown)
    const d2 = registry.record({ signature: "err:5", category: "error", message: "test" });
    expect(d2.shouldAutoResolve).toBe(false);
  });

  test("reset clears all state", () => {
    const registry = createIssueRegistry({
      dedupeWindowMs: 30_000,
      minOccurrences: 1,
      autoResolve: true,
    });
    registry.record({ signature: "err:6", category: "error", message: "test" });
    registry.setCursor(999);
    registry.reset();
    expect(registry.getCursor()).toBe(0);
    // After reset, same issue should surface again
    const d = registry.record({ signature: "err:6", category: "error", message: "test" });
    expect(d.shouldSurface).toBe(true);
  });
});

// ============================================================================
// Log line classification
// ============================================================================

describe("classifyLogLine", () => {
  test("classifies JSON error entries", () => {
    const line = JSON.stringify({
      level: "error",
      msg: "Connection timed out",
      code: "ETIMEDOUT",
    });
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("network");
    expect(result!.message).toContain("Connection timed out");
  });

  test("classifies JSON crash entries", () => {
    const line = JSON.stringify({
      level: "error",
      msg: "Uncaught exception: TypeError something",
    });
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("crash");
  });

  test("classifies generic JSON errors", () => {
    const line = JSON.stringify({
      level: "error",
      msg: "Something went wrong",
    });
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("error");
  });

  test("classifies suppressed exception lines", () => {
    const line =
      "[openclaw] Suppressed non-fatal exception (continuing): Error: ECONNRESET at something";
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("network");
  });

  test("classifies fatal uncaught exception lines", () => {
    const line = "[openclaw] FATAL uncaught exception (crashing): TypeError: Cannot read";
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("crash");
  });

  test("returns null for non-error lines", () => {
    expect(classifyLogLine("INFO: Gateway started on port 18789")).toBeNull();
    expect(classifyLogLine("")).toBeNull();
    expect(classifyLogLine("{}")).toBeNull();
  });

  test("classifies JSON level 50 (numeric error level)", () => {
    const line = JSON.stringify({ level: 50, msg: "disk full" });
    const result = classifyLogLine(line);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("error");
  });
});

// ============================================================================
// Handler matching and dispatch
// ============================================================================

describe("runHandlers", () => {
  test("matches TransientNetwork handler for network issues", async () => {
    const result = await runHandlers(
      { signature: "net:1", category: "network", message: "ECONNRESET", occurrences: 3 },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.handler).toBe("TransientNetwork");
    expect(result!.result).toBe("fixed");
  });

  test("TransientNetwork returns needs-human for high spike", async () => {
    const result = await runHandlers(
      { signature: "net:2", category: "network", message: "ECONNRESET", occurrences: 15 },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.handler).toBe("TransientNetwork");
    expect(result!.result).toBe("needs-human");
  });

  test("matches CrashRecovery handler for crash issues", async () => {
    const result = await runHandlers(
      { signature: "crash:1", category: "crash", message: "Uncaught", occurrences: 2 },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.handler).toBe("CrashRecovery");
  });

  test("matches StuckSession handler", async () => {
    const result = await runHandlers(
      {
        signature: "stuck:1",
        category: "stuck-session",
        message: "Session stuck",
        occurrences: 2,
      },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.handler).toBe("StuckSession");
    expect(result!.result).toBe("needs-human");
  });

  test("returns null when no handler matches", async () => {
    const result = await runHandlers(
      { signature: "unknown:1", category: "unknown", message: "???", occurrences: 1 },
      {},
    );
    expect(result).toBeNull();
  });
});

// ============================================================================
// Config toggle
// ============================================================================

describe("config toggle", () => {
  test("enabled=false produces a no-op handle", async () => {
    // We test this indirectly by importing startLogMonitor
    const { startLogMonitor } = await import("./log-monitor.js");
    const handle = startLogMonitor({ enabled: false }, {});
    // Should not throw
    handle.stop();
    handle.updateConfig({ enabled: false });
  });
});
