/**
 * T-023: Text-Only Adapter Integration Test
 *
 * Runs wallet onboarding workflow end-to-end through the SDK with TextOnlyAdapter.
 * Verifies text output, numeric parsing, cancel/back, completion.
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

// ─── Wallet onboarding workflow ─────────────────────────────────────────────

const walletOnboarding: WorkflowDefinition = {
  id: "wallet-onboarding",
  plugin: "wallet",
  version: "1.0.0",
  ttl: 3600000,
  entryPoint: "welcome",
  steps: {
    welcome: {
      type: "info",
      content: "🐕 Welcome to Wallet Setup!\n\nI'll help you create a secure DOGE wallet.",
      next: "confirm-create",
    },
    "confirm-create": {
      type: "confirm",
      content: "Would you like to create a new wallet?",
      confirmLabel: "Yes, create wallet",
      denyLabel: "No, cancel",
      transitions: { yes: "set-passphrase", no: "cancelled" },
    },
    "set-passphrase": {
      type: "text-input",
      content: "Enter a passphrase to encrypt your wallet:",
      placeholder: "Minimum 8 characters",
      validation: { minLength: 8, maxLength: 128 },
      toolCall: {
        name: "wallet_init",
        paramMap: { passphrase: "$input" },
      },
      next: "complete",
    },
    complete: {
      type: "info",
      content: "✅ Wallet created successfully!\n\nYour mnemonic has been sent securely.",
      terminal: true,
    },
    cancelled: {
      type: "info",
      content: "Wallet setup cancelled. No changes were made.",
      terminal: true,
    },
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "text",
  surfaceUserId: "user-123",
};

describe("Text-Only Adapter Integration: Wallet Onboarding", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let sentMessages: string[];
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let adapter: TextOnlyAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "text-int-"));
    stateManager = new WorkflowStateManager(dataDir);
    sentMessages = [];
    toolCalls = [];

    const sendFn: TextSendFn = async (_target, text) => {
      sentMessages.push(text);
      return { messageId: `msg-${sentMessages.length}` };
    };

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return { success: true, result: { address: "D8foobar..." } };
    };

    adapter = new TextOnlyAdapter(sendFn);
    engine = new WorkflowEngine({
      stateManager,
      negotiator: new DefaultCapabilityNegotiator(),
      toolExecutor,
    });
    engine.registerAdapter(adapter);
    engine.registerWorkflow(walletOnboarding);
  });

  afterEach(() => {
    stateManager.destroy();
    try { rmSync(dataDir, { recursive: true }); } catch { /* */ }
  });

  function parseText(text: string, workflowId: string, stepId: string, stepType: string, options?: { id: string }[]): ParsedUserAction | null {
    return adapter.parseAction({
      text,
      workflowId,
      stepId,
      surface: testSurface,
      stepType,
      options,
    });
  }

  it("completes full wallet onboarding flow", async () => {
    const state = await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // Should have rendered welcome info and auto-advanced to confirm
    expect(state.currentStep).toBe("confirm-create");
    expect(sentMessages.some((m) => m.includes("Welcome to Wallet Setup"))).toBe(true);
    expect(sentMessages.some((m) => m.includes("create a new wallet"))).toBe(true);

    // Confirm: reply "yes" (text adapter parses yes/no for confirm steps)
    const confirmAction = parseText("yes", "wallet-onboarding", "confirm-create", "confirm");
    expect(confirmAction).not.toBeNull();
    expect(confirmAction!.kind).toBe("selection");
    expect(confirmAction!.value).toBe("yes");

    const r1 = await engine.handleAction("user-123", confirmAction!);
    expect(r1.outcome).toBe("advanced");
    expect(r1.state?.currentStep).toBe("set-passphrase");

    // Enter passphrase
    const passAction = parseText("mysecurepass123", "wallet-onboarding", "set-passphrase", "text-input");
    expect(passAction).not.toBeNull();
    expect(passAction!.kind).toBe("text");

    const r2 = await engine.handleAction("user-123", passAction!);
    expect(r2.outcome).toBe("completed");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("wallet_init");
    expect(toolCalls[0].params.passphrase).toBe("mysecurepass123");

    // Completion message rendered
    expect(sentMessages.some((m) => m.includes("Wallet created successfully"))).toBe(true);
  });

  it("handles 'no' on confirm — cancels gracefully", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // Reply "no"
    const action = parseText("no", "wallet-onboarding", "confirm-create", "confirm");
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("selection");
    expect(action!.value).toBe("no");

    const r = await engine.handleAction("user-123", action!);
    expect(r.outcome).toBe("completed");
    expect(sentMessages.some((m) => m.includes("cancelled"))).toBe(true);
    expect(toolCalls).toHaveLength(0);
  });

  it("handles cancel command mid-workflow", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    const action = parseText("cancel", "wallet-onboarding", "confirm-create", "confirm");
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("cancel");

    const r = await engine.handleAction("user-123", action!);
    expect(r.outcome).toBe("cancelled");
    expect(engine.getActiveWorkflow("user-123")).toBeNull();
  });

  it("handles back command", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // Confirm yes
    const yesAction = parseText("yes", "wallet-onboarding", "confirm-create", "confirm");
    await engine.handleAction("user-123", yesAction!);

    // Now on set-passphrase, go back
    const backAction = parseText("back", "wallet-onboarding", "set-passphrase", "text-input");
    expect(backAction!.kind).toBe("back");

    const r = await engine.handleAction("user-123", backAction!);
    expect(r.outcome).toBe("advanced");
    expect(r.state?.currentStep).toBe("confirm-create");
  });

  it("rejects too-short passphrase with validation error", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    const yesAction = parseText("yes", "wallet-onboarding", "confirm-create", "confirm");
    await engine.handleAction("user-123", yesAction!);

    const shortPass = parseText("short", "wallet-onboarding", "set-passphrase", "text-input");
    const r = await engine.handleAction("user-123", shortPass!);
    expect(r.outcome).toBe("validation-error");
    expect(r.state?.currentStep).toBe("set-passphrase");
    expect(toolCalls).toHaveLength(0);
  });

  it("handles case-insensitive input", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // "CANCEL" should work
    const action = parseText("CANCEL", "wallet-onboarding", "confirm-create", "confirm");
    expect(action!.kind).toBe("cancel");
  });

  it("handles input with extra whitespace", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    const yesAction = parseText("  1  ", "wallet-onboarding", "confirm-create", "confirm");
    // The text adapter trims, so numeric "1" is parsed from "  1  "
    // Actually the confirm step maps "1"→yes via numbered rendering
    // parseAction for confirm checks yes/no text, but the text adapter renders as numbered list
    // For the confirm step, "1" maps to yes (confirmLabel) in the adapter's parseAction
    expect(yesAction).not.toBeNull();
  });

  it("handles non-numeric input for confirm step", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // "yes" should work for confirm
    const action = parseText("yes", "wallet-onboarding", "confirm-create", "confirm");
    expect(action!.kind).toBe("selection");
    expect(action!.value).toBe("yes");
  });

  it("progress is shown in messages", async () => {
    await engine.startWorkflow("wallet-onboarding", "user-123", testSurface);

    // The confirm step should have a "Step X of Y" indicator
    const stepMsg = sentMessages.find((m) => m.includes("Step "));
    expect(stepMsg).toBeDefined();
  });
});
