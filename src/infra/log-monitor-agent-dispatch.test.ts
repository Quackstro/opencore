import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentDispatchConfig } from "../config/types.log-monitor.js";
import {
  buildHealingAgentPrompt,
  canSpawnAgent,
  getActiveAgentCount,
  isHealingAgentSession,
  resetAgentDispatchState,
} from "./log-monitor-agent-dispatch.js";
import { createIssueRegistry, type IssueRegistry } from "./log-monitor-registry.js";

function makeRegistry(): IssueRegistry {
  return createIssueRegistry({
    dedupeWindowMs: 30_000,
    minOccurrences: 1,
    autoResolve: true,
    stateDir: `/tmp/log-monitor-dispatch-test-${Date.now()}-${Math.random()}`,
  });
}

const defaultConfig: AgentDispatchConfig = {
  enabled: true,
  timeoutSeconds: 300,
  maxConcurrent: 2,
  cooldownSeconds: 3600,
  maxSpawnsPerHour: 5,
  agentId: "system",
};

afterEach(() => {
  resetAgentDispatchState();
});

// ============================================================================
// canSpawnAgent
// ============================================================================

describe("canSpawnAgent", () => {
  test("allows spawn when no restrictions", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    const result = canSpawnAgent("err:1", defaultConfig, registry);
    expect(result.allowed).toBe(true);
  });

  test("blocks when disabled", () => {
    const registry = makeRegistry();
    const result = canSpawnAgent("err:1", { ...defaultConfig, enabled: false }, registry);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("agent-dispatch-disabled");
  });

  test("blocks when cooldown is active", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentDispatch("err:1");
    const result = canSpawnAgent("err:1", { ...defaultConfig, cooldownSeconds: 3600 }, registry);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("cooldown-active");
  });

  test("blocks when circuit breaker is open", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    const result = canSpawnAgent("err:1", defaultConfig, registry);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("circuit-breaker-open");
  });

  test("allows after circuit breaker reset", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    registry.resetAgentFailures("err:1");
    const result = canSpawnAgent("err:1", defaultConfig, registry);
    expect(result.allowed).toBe(true);
  });
});

// ============================================================================
// buildHealingAgentPrompt
// ============================================================================

describe("buildHealingAgentPrompt", () => {
  test("includes issue details", () => {
    const prompt = buildHealingAgentPrompt(
      { signature: "err:test", category: "error", message: "Something broke", occurrences: 5 },
      ["line1", "line2"],
    );
    expect(prompt).toContain("Something broke");
    expect(prompt).toContain("err:test");
    expect(prompt).toContain("5 times");
    expect(prompt).toContain("line1");
    expect(prompt).toContain("line2");
  });

  test("uses custom tools from agentContext", () => {
    const prompt = buildHealingAgentPrompt(
      { signature: "err:test", category: "error", message: "test", occurrences: 1 },
      [],
      { task: "fix it", tools: ["custom_tool_1", "custom_tool_2"] },
    );
    expect(prompt).toContain("custom_tool_1");
    expect(prompt).toContain("custom_tool_2");
  });

  test("uses default tools when none specified", () => {
    const prompt = buildHealingAgentPrompt(
      { signature: "err:test", category: "error", message: "test", occurrences: 1 },
      [],
    );
    expect(prompt).toContain("exec:");
    expect(prompt).toContain("read:");
  });
});

// ============================================================================
// isHealingAgentSession
// ============================================================================

describe("isHealingAgentSession", () => {
  test("identifies healing sessions", () => {
    expect(isHealingAgentSession("agent:system:healing:abc-123")).toBe(true);
  });

  test("rejects non-healing sessions", () => {
    expect(isHealingAgentSession("agent:system:subagent:abc-123")).toBe(false);
    expect(isHealingAgentSession("agent:dev:main")).toBe(false);
  });
});

// ============================================================================
// Registry agent tracking
// ============================================================================

describe("IssueRegistry agent tracking", () => {
  test("markAgentDispatch sets timestamp", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentDispatch("err:1");
    const issue = registry.getIssue("err:1");
    expect(issue).toBeDefined();
    expect(issue!.lastAgentDispatchMs).toBeGreaterThan(0);
  });

  test("markAgentFailure increments counter", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    const issue = registry.getIssue("err:1");
    expect(issue!.agentFailures).toBe(2);
    expect(issue!.lastAgentFailureMs).toBeGreaterThan(0);
  });

  test("resetAgentFailures clears counter", () => {
    const registry = makeRegistry();
    registry.record({ signature: "err:1", category: "error", message: "test" });
    registry.markAgentFailure("err:1");
    registry.markAgentFailure("err:1");
    registry.resetAgentFailures("err:1");
    const issue = registry.getIssue("err:1");
    expect(issue!.agentFailures).toBe(0);
  });
});
