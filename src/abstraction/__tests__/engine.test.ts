/**
 * T-015: Workflow Engine Unit Tests
 *
 * Covers: TS-001 through TS-008 from the test plan.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowEngine, type ToolExecutor } from "../engine.js";
import { WorkflowStateManager } from "../state.js";
import { DefaultCapabilityNegotiator } from "../negotiator.js";
import { TextOnlyAdapter, type TextSendFn } from "../adapters/text/text-adapter.js";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { ParsedUserAction, SurfaceTarget } from "../adapter.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test fixtures ──────────────────────────────────────────────────────────

const linearWorkflow: WorkflowDefinition = {
  id: "test-linear",
  plugin: "test",
  version: "1.0.0",
  ttl: 60000,
  entryPoint: "step1",
  steps: {
    step1: {
      type: "info",
      content: "Welcome",
      next: "step2",
    },
    step2: {
      type: "text-input",
      content: "Enter your name:",
      validation: { minLength: 1, maxLength: 50 },
      next: "step3",
    },
    step3: {
      type: "confirm",
      content: "Is {{data.step2.input}} correct?",
      confirmLabel: "Yes",
      denyLabel: "No",
      transitions: { yes: "done", no: "step2" },
    },
    done: {
      type: "info",
      content: "Thanks, {{data.step2.input}}!",
      terminal: true,
    },
  },
};

const branchingWorkflow: WorkflowDefinition = {
  id: "test-branch",
  plugin: "test",
  version: "1.0.0",
  entryPoint: "welcome",
  steps: {
    welcome: {
      type: "info",
      content: "Welcome",
      next: "choose",
    },
    choose: {
      type: "choice",
      content: "Pick a path:",
      options: [
        { id: "a", label: "Path A" },
        { id: "b", label: "Path B" },
      ],
      transitions: { a: "path-a", b: "path-b" },
    },
    "path-a": {
      type: "info",
      content: "You chose Path A.",
      terminal: true,
    },
    "path-b": {
      type: "info",
      content: "You chose Path B.",
      terminal: true,
    },
  },
};

const walletWorkflow: WorkflowDefinition = {
  id: "wallet-onboarding",
  plugin: "wallet",
  version: "1.0.0",
  ttl: 3600000,
  entryPoint: "welcome",
  steps: {
    welcome: {
      type: "info",
      content: "Welcome to wallet setup.",
      next: "confirm-create",
    },
    "confirm-create": {
      type: "confirm",
      content: "Create a new wallet?",
      confirmLabel: "Yes",
      denyLabel: "No",
      transitions: { yes: "set-passphrase", no: "cancelled" },
    },
    "set-passphrase": {
      type: "text-input",
      content: "Enter passphrase (8+ chars):",
      validation: { minLength: 8 },
      toolCall: {
        name: "wallet_init",
        paramMap: { passphrase: "$input" },
      },
      next: "complete",
    },
    complete: {
      type: "info",
      content: "Wallet created!",
      terminal: true,
    },
    cancelled: {
      type: "info",
      content: "Wallet setup cancelled. No changes were made.",
      terminal: true,
    },
  },
};

// ─── Test helpers ───────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "text",
  surfaceUserId: "test-user",
};

function makeAction(
  kind: ParsedUserAction["kind"],
  workflowId: string,
  stepId: string,
  opts?: { value?: string | string[]; text?: string },
): ParsedUserAction {
  return {
    kind,
    value: opts?.value,
    text: opts?.text,
    workflowId,
    stepId,
    surface: testSurface,
    rawEvent: {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WorkflowEngine", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let sentMessages: string[];
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wf-test-"));
    stateManager = new WorkflowStateManager(dataDir);
    sentMessages = [];
    toolCalls = [];
    toolResult = { success: true, result: { ok: true } };

    const sendFn: TextSendFn = async (_target, text) => {
      sentMessages.push(text);
      return { messageId: `msg-${sentMessages.length}` };
    };

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return toolResult;
    };

    const textAdapter = new TextOnlyAdapter(sendFn);

    engine = new WorkflowEngine({
      stateManager,
      negotiator: new DefaultCapabilityNegotiator(),
      toolExecutor,
    });
    engine.registerAdapter(textAdapter);
  });

  afterEach(() => {
    stateManager.destroy();
    try {
      rmSync(dataDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  // TS-001: Linear workflow completes
  it("completes a linear workflow", async () => {
    engine.registerWorkflow(linearWorkflow);
    const state = await engine.startWorkflow(
      "test-linear",
      "user1",
      testSurface,
    );

    // Should auto-advance through info step to step2
    expect(state.currentStep).toBe("step2");
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);

    // Enter name
    const r1 = await engine.handleAction(
      "user1",
      makeAction("text", "test-linear", "step2", { text: "Dr. Castro" }),
    );
    expect(r1.outcome).toBe("advanced");

    // Confirm yes
    const r2 = await engine.handleAction(
      "user1",
      makeAction("selection", "test-linear", "step3", { value: "yes" }),
    );
    expect(r2.outcome).toBe("completed");
    expect(r2.state).toBeNull();

    // State should be cleaned up
    expect(engine.getActiveWorkflow("user1")).toBeNull();
  });

  // TS-002: Branching workflow
  it("follows correct branch", async () => {
    engine.registerWorkflow(branchingWorkflow);
    await engine.startWorkflow("test-branch", "user1", testSurface);

    const r = await engine.handleAction(
      "user1",
      makeAction("selection", "test-branch", "choose", { value: "a" }),
    );
    expect(r.outcome).toBe("completed");

    // Check that Path A was rendered
    const pathAMsg = sentMessages.find((m) => m.includes("Path A"));
    expect(pathAMsg).toBeDefined();
  });

  // TS-003: Cancel mid-workflow
  it("cancels mid-workflow", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    const r = await engine.handleAction(
      "user1",
      makeAction("cancel", "wallet-onboarding", "confirm-create"),
    );
    expect(r.outcome).toBe("cancelled");
    expect(r.state).toBeNull();

    const cancelMsg = sentMessages.find((m) =>
      m.includes("Cancelled. No changes were made."),
    );
    expect(cancelMsg).toBeDefined();
  });

  // TS-004: Back mid-workflow
  it("navigates back", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    // Select yes on confirm
    await engine.handleAction(
      "user1",
      makeAction("selection", "wallet-onboarding", "confirm-create", {
        value: "yes",
      }),
    );

    // Now on set-passphrase. Go back.
    const r = await engine.handleAction(
      "user1",
      makeAction("back", "wallet-onboarding", "set-passphrase"),
    );
    expect(r.outcome).toBe("advanced");
    expect(r.state?.currentStep).toBe("confirm-create");
  });

  // TS-005: TTL expiry
  it("enforces TTL", async () => {
    const shortTtl: WorkflowDefinition = {
      ...linearWorkflow,
      id: "test-short-ttl",
      ttl: 1, // 1ms TTL
    };
    engine.registerWorkflow(shortTtl);
    await engine.startWorkflow("test-short-ttl", "user1", testSurface);

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    expect(engine.getActiveWorkflow("user1")).toBeNull();
  });

  // TS-006: Tool call binding
  it("executes tool calls", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    // Confirm yes
    await engine.handleAction(
      "user1",
      makeAction("selection", "wallet-onboarding", "confirm-create", {
        value: "yes",
      }),
    );

    // Enter passphrase
    const r = await engine.handleAction(
      "user1",
      makeAction("text", "wallet-onboarding", "set-passphrase", {
        text: "mysecurepass123",
      }),
    );
    expect(r.outcome).toBe("completed");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("wallet_init");
    expect(toolCalls[0].params.passphrase).toBe("mysecurepass123");
  });

  // TS-007: Validation rejects bad input
  it("rejects invalid input", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    // Confirm yes
    await engine.handleAction(
      "user1",
      makeAction("selection", "wallet-onboarding", "confirm-create", {
        value: "yes",
      }),
    );

    // Enter short passphrase
    const r = await engine.handleAction(
      "user1",
      makeAction("text", "wallet-onboarding", "set-passphrase", {
        text: "short",
      }),
    );
    expect(r.outcome).toBe("validation-error");
    expect(r.state).not.toBeNull();
    expect(r.state?.currentStep).toBe("set-passphrase");
    expect(toolCalls).toHaveLength(0);
  });

  // TS-008: Restart survival
  it("survives restart", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    // Confirm yes
    await engine.handleAction(
      "user1",
      makeAction("selection", "wallet-onboarding", "confirm-create", {
        value: "yes",
      }),
    );

    // Simulate restart: destroy and recreate state manager
    stateManager.destroy();
    const stateManager2 = new WorkflowStateManager(dataDir);
    const engine2 = new WorkflowEngine({
      stateManager: stateManager2,
      negotiator: new DefaultCapabilityNegotiator(),
      toolExecutor: async () => ({ success: true }),
    });
    engine2.registerWorkflow(walletWorkflow);
    engine2.registerAdapter(
      new TextOnlyAdapter(async () => ({ messageId: "x" })),
    );

    const restored = engine2.getActiveWorkflow("user1");
    expect(restored).not.toBeNull();
    expect(restored!.currentStep).toBe("set-passphrase");
    expect(restored!.data["confirm-create"]?.selection).toBe("yes");

    stateManager2.destroy();
  });

  // Additional: tool call failure stays on step
  it("stays on step after tool failure", async () => {
    toolResult = { success: false, error: "API unavailable" };
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    await engine.handleAction(
      "user1",
      makeAction("selection", "wallet-onboarding", "confirm-create", {
        value: "yes",
      }),
    );

    const r = await engine.handleAction(
      "user1",
      makeAction("text", "wallet-onboarding", "set-passphrase", {
        text: "mysecurepass123",
      }),
    );
    expect(r.outcome).toBe("tool-error");
    // still on set-passphrase (no onError defined, so stays)
    const active = engine.getActiveWorkflow("user1");
    expect(active?.currentStep).toBe("set-passphrase");
  });

  // Back on first step = cancel
  it("back on first interactive step goes to info, then back again cancels", async () => {
    engine.registerWorkflow(walletWorkflow);
    await engine.startWorkflow("wallet-onboarding", "user1", testSurface);

    // confirm-create has stepHistory=["welcome"], so back goes to welcome
    const r1 = await engine.handleAction(
      "user1",
      makeAction("back", "wallet-onboarding", "confirm-create"),
    );
    expect(r1.outcome).toBe("advanced");
    expect(r1.state?.currentStep).toBe("welcome");

    // Now on welcome with empty stepHistory, back = cancel
    const r2 = await engine.handleAction(
      "user1",
      makeAction("back", "wallet-onboarding", "welcome"),
    );
    expect(r2.outcome).toBe("cancelled");
    expect(r2.state).toBeNull();
  });

  // Workflow definition validation
  it("rejects invalid workflow definitions", () => {
    const bad: WorkflowDefinition = {
      id: "bad",
      plugin: "test",
      version: "1.0.0",
      entryPoint: "nonexistent",
      steps: {
        step1: {
          type: "info",
          content: "Hello",
          // Missing: no next, no terminal, no transitions
        },
      },
    };
    const result = engine.registerWorkflow(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // Branch workflow path B
  it("follows branch B correctly", async () => {
    engine.registerWorkflow(branchingWorkflow);
    await engine.startWorkflow("test-branch", "user1", testSurface);

    const r = await engine.handleAction(
      "user1",
      makeAction("selection", "test-branch", "choose", { value: "b" }),
    );
    expect(r.outcome).toBe("completed");
    const pathBMsg = sentMessages.find((m) => m.includes("Path B"));
    expect(pathBMsg).toBeDefined();
  });
});
