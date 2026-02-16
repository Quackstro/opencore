import { describe, expect, test } from "vitest";
import {
  BUILTIN_HANDLERS,
  normalizeResolution,
  runHandlers,
  type HandlerContext,
  type HandlerResolution,
  type LogMonitorHandler,
  type LogMonitorIssue,
} from "./log-monitor-handlers.js";

const ctx: HandlerContext = { logger: undefined };

// ============================================================================
// normalizeResolution
// ============================================================================

describe("normalizeResolution", () => {
  test("normalizes plain string to HandlerResolution", () => {
    expect(normalizeResolution("fixed")).toEqual({ result: "fixed" });
    expect(normalizeResolution("needs-agent")).toEqual({ result: "needs-agent" });
    expect(normalizeResolution("needs-human")).toEqual({ result: "needs-human" });
    expect(normalizeResolution("failed")).toEqual({ result: "failed" });
  });

  test("passes through HandlerResolution objects", () => {
    const res: HandlerResolution = {
      result: "needs-agent",
      agentContext: { task: "fix it", severity: "high" },
    };
    expect(normalizeResolution(res)).toBe(res);
  });
});

// ============================================================================
// Handler ordering
// ============================================================================

describe("BUILTIN_HANDLERS ordering", () => {
  test("has correct order", () => {
    const names = BUILTIN_HANDLERS.map((h) => h.name);
    expect(names).toEqual([
      "TransientNetwork",
      "OAuthToken",
      "CrashRecovery",
      "StuckSession",
      "GenericError",
    ]);
  });

  test("GenericError is last (catch-all)", () => {
    const last = BUILTIN_HANDLERS[BUILTIN_HANDLERS.length - 1];
    expect(last.name).toBe("GenericError");
  });
});

// ============================================================================
// TransientNetworkHandler
// ============================================================================

describe("TransientNetworkHandler", () => {
  test("matches network category", () => {
    const handler = BUILTIN_HANDLERS[0];
    expect(
      handler.matches({ signature: "x", category: "network", message: "test", occurrences: 1 }),
    ).toBe(true);
  });

  test("matches by ECONNRESET in message", () => {
    const handler = BUILTIN_HANDLERS[0];
    expect(
      handler.matches({
        signature: "x",
        category: "error",
        message: "ECONNRESET happened",
        occurrences: 1,
      }),
    ).toBe(true);
  });

  test("suppresses low-count network errors", async () => {
    const handler = BUILTIN_HANDLERS[0];
    const result = await handler.resolve(
      { signature: "x", category: "network", message: "ECONNRESET", occurrences: 3 },
      ctx,
    );
    expect(normalizeResolution(result).result).toBe("fixed");
  });

  test("escalates high-count network errors", async () => {
    const handler = BUILTIN_HANDLERS[0];
    const result = await handler.resolve(
      { signature: "x", category: "network", message: "ECONNRESET", occurrences: 15 },
      ctx,
    );
    expect(normalizeResolution(result).result).toBe("needs-human");
  });
});

// ============================================================================
// OAuthTokenHandler
// ============================================================================

describe("OAuthTokenHandler", () => {
  const handler = BUILTIN_HANDLERS[1];

  test("matches token expired messages", () => {
    expect(
      handler.matches({
        signature: "x",
        category: "error",
        message: "token expired",
        occurrences: 1,
      }),
    ).toBe(true);
  });

  test("matches 401 token messages", () => {
    expect(
      handler.matches({
        signature: "x",
        category: "error",
        message: "token 401 unauthorized",
        occurrences: 1,
      }),
    ).toBe(true);
  });

  test("does not match unrelated messages", () => {
    expect(
      handler.matches({
        signature: "x",
        category: "error",
        message: "something broke",
        occurrences: 1,
      }),
    ).toBe(false);
  });

  test("returns needs-agent with context", async () => {
    const result = await handler.resolve(
      { signature: "x", category: "error", message: "token expired", occurrences: 1 },
      ctx,
    );
    const res = normalizeResolution(result);
    expect(res.result).toBe("needs-agent");
    expect(res.agentContext).toBeDefined();
    expect(res.agentContext?.severity).toBe("medium");
    expect(res.agentContext?.timeoutSeconds).toBe(120);
  });
});

// ============================================================================
// GenericErrorHandler
// ============================================================================

describe("GenericErrorHandler", () => {
  const handler = BUILTIN_HANDLERS[4];

  test("matches error category", () => {
    expect(
      handler.matches({ signature: "x", category: "error", message: "test", occurrences: 1 }),
    ).toBe(true);
  });

  test("matches unknown category", () => {
    expect(
      handler.matches({ signature: "x", category: "unknown", message: "test", occurrences: 1 }),
    ).toBe(true);
  });

  test("does not match network category", () => {
    expect(
      handler.matches({ signature: "x", category: "network", message: "test", occurrences: 1 }),
    ).toBe(false);
  });

  test("suppresses low-occurrence errors", async () => {
    const result = await handler.resolve(
      { signature: "x", category: "error", message: "some error", occurrences: 2 },
      ctx,
    );
    expect(normalizeResolution(result).result).toBe("fixed");
  });

  test("dispatches agent for high-occurrence errors", async () => {
    const result = await handler.resolve(
      { signature: "x", category: "error", message: "recurring error", occurrences: 5 },
      ctx,
    );
    const res = normalizeResolution(result);
    expect(res.result).toBe("needs-agent");
    expect(res.agentContext?.severity).toBe("medium");
  });
});

// ============================================================================
// runHandlers
// ============================================================================

describe("runHandlers", () => {
  test("returns null when no handler matches", async () => {
    const issue: LogMonitorIssue = {
      signature: "x",
      category: "crash",
      message: "test",
      occurrences: 1,
    };
    const emptyHandlers: LogMonitorHandler[] = [];
    const result = await runHandlers(issue, ctx, emptyHandlers);
    expect(result).toBeNull();
  });

  test("returns resolution with handler name", async () => {
    const mockHandler: LogMonitorHandler = {
      name: "Mock",
      matches: () => true,
      resolve: async () => "fixed",
    };
    const result = await runHandlers(
      { signature: "x", category: "error", message: "test", occurrences: 1 },
      ctx,
      [mockHandler],
    );
    expect(result).not.toBeNull();
    expect(result!.handler).toBe("Mock");
    expect(result!.result).toBe("fixed");
    expect(result!.resolution).toEqual({ result: "fixed" });
  });

  test("normalizes HandlerResolution returns", async () => {
    const mockHandler: LogMonitorHandler = {
      name: "Mock",
      matches: () => true,
      resolve: async () => ({
        result: "needs-agent" as const,
        agentContext: { task: "do something" },
      }),
    };
    const result = await runHandlers(
      { signature: "x", category: "error", message: "test", occurrences: 1 },
      ctx,
      [mockHandler],
    );
    expect(result!.result).toBe("needs-agent");
    expect(result!.resolution.agentContext?.task).toBe("do something");
  });

  test("catches handler errors and returns failed", async () => {
    const mockHandler: LogMonitorHandler = {
      name: "Broken",
      matches: () => true,
      resolve: async () => {
        throw new Error("boom");
      },
    };
    const result = await runHandlers(
      { signature: "x", category: "error", message: "test", occurrences: 1 },
      ctx,
      [mockHandler],
    );
    expect(result!.result).toBe("failed");
  });

  test("first match wins", async () => {
    const h1: LogMonitorHandler = {
      name: "First",
      matches: () => true,
      resolve: async () => "fixed",
    };
    const h2: LogMonitorHandler = {
      name: "Second",
      matches: () => true,
      resolve: async () => "needs-human",
    };
    const result = await runHandlers(
      { signature: "x", category: "error", message: "test", occurrences: 1 },
      ctx,
      [h1, h2],
    );
    expect(result!.handler).toBe("First");
  });

  test("backward compat: plain string results still work", async () => {
    const mockHandler: LogMonitorHandler = {
      name: "Legacy",
      matches: () => true,
      resolve: async () => "needs-human",
    };
    const result = await runHandlers(
      { signature: "x", category: "error", message: "test", occurrences: 1 },
      ctx,
      [mockHandler],
    );
    expect(result!.result).toBe("needs-human");
    expect(result!.resolution).toEqual({ result: "needs-human" });
  });
});
