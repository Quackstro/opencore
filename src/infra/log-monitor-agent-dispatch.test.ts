import { afterEach, describe, expect, test } from "vitest";
import type { AgentDispatchConfig } from "../config/types.log-monitor.js";
import type { HealingApprovalGate } from "../config/types.log-monitor.js";
import {
  approveHealingDispatch,
  buildHealingAgentPrompt,
  canSpawnAgent,
  isHealingAgentSession,
  listPendingApprovals,
  rejectHealingDispatch,
  requiresApproval,
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

// ============================================================================
// Approval Gate
// ============================================================================

describe("requiresApproval", () => {
  test("defaults to always requiring approval (undefined gate)", () => {
    expect(requiresApproval("low", undefined)).toBe(true);
    expect(requiresApproval("medium", undefined)).toBe(true);
    expect(requiresApproval("high", undefined)).toBe(true);
  });

  test("mode=always requires approval for all severities", () => {
    const gate: HealingApprovalGate = { mode: "always" };
    expect(requiresApproval("low", gate)).toBe(true);
    expect(requiresApproval("medium", gate)).toBe(true);
    expect(requiresApproval("high", gate)).toBe(true);
  });

  test("mode=off never requires approval", () => {
    const gate: HealingApprovalGate = { mode: "off" };
    expect(requiresApproval("low", gate)).toBe(false);
    expect(requiresApproval("medium", gate)).toBe(false);
    expect(requiresApproval("high", gate)).toBe(false);
  });

  test("mode=high-only requires approval only for high", () => {
    const gate: HealingApprovalGate = { mode: "high-only" };
    expect(requiresApproval("low", gate)).toBe(false);
    expect(requiresApproval("medium", gate)).toBe(false);
    expect(requiresApproval("high", gate)).toBe(true);
  });

  test("mode=medium-and-above requires approval for medium and high", () => {
    const gate: HealingApprovalGate = { mode: "medium-and-above" };
    expect(requiresApproval("low", gate)).toBe(false);
    expect(requiresApproval("medium", gate)).toBe(true);
    expect(requiresApproval("high", gate)).toBe(true);
  });
});

describe("approval lifecycle", () => {
  test("listPendingApprovals returns empty initially", () => {
    expect(listPendingApprovals()).toHaveLength(0);
  });

  test("rejectHealingDispatch returns false for unknown id", () => {
    const result = rejectHealingDispatch("nonexistent-id");
    expect(result.rejected).toBe(false);
    expect(result.reason).toBe("approval-not-found-or-expired");
  });

  test("approveHealingDispatch returns false for unknown id", async () => {
    const result = await approveHealingDispatch("nonexistent-id");
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("approval-not-found-or-expired");
  });
});
