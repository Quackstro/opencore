/**
 * T-035: Wallet Workflows on Text-Only Adapter
 *
 * Tests all wallet workflows through the Text-Only adapter.
 * Verifies all flows completable with text-based input.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowEngine, type ToolExecutor } from "../engine.js";
import { WorkflowStateManager } from "../state.js";
import { DefaultCapabilityNegotiator } from "../negotiator.js";
import { TextOnlyAdapter, type TextSendFn } from "../adapters/text/text-adapter.js";
import type { ParsedUserAction, SurfaceTarget } from "../adapter.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWalletWorkflows, WALLET_WORKFLOWS } from "../workflows/wallet/index.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "text",
  surfaceUserId: "user-txt",
};

describe("Wallet Workflows — Text-Only Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let sentMessages: string[];
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let adapter: TextOnlyAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wallet-txt-"));
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

    adapter = new TextOnlyAdapter(sendFn);
    engine = new WorkflowEngine({
      stateManager,
      negotiator: new DefaultCapabilityNegotiator(),
      toolExecutor,
    });
    engine.registerAdapter(adapter);
    registerWalletWorkflows(engine);
  });

  afterEach(() => {
    stateManager.destroy();
    try { rmSync(dataDir, { recursive: true }); } catch { /* */ }
  });

  function textAction(
    text: string,
    workflowId: string,
    stepId: string,
    stepType: string,
    options?: { id: string }[],
  ): ParsedUserAction {
    return adapter.parseAction({
      text, workflowId, stepId, surface: testSurface, stepType, options,
    })!;
  }

  // ─── Onboarding ─────────────────────────────────────────────────────

  describe("Onboarding", () => {
    it("completes happy path", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);

      expect(sentMessages.some((m) => m.includes("Welcome to DOGE Wallet"))).toBe(true);
      expect(sentMessages.some((m) => m.includes("Create a new wallet?"))).toBe(true);

      // Confirm yes
      const r1 = await engine.handleAction("user-txt",
        textAction("yes", "wallet-onboarding", "confirm-create", "confirm"));
      expect(r1.outcome).toBe("advanced");

      // Enter passphrase
      const r2 = await engine.handleAction("user-txt",
        textAction("mysecurepass123", "wallet-onboarding", "set-passphrase", "text-input"));
      expect(r2.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_init");
    });

    it("handles no → cancelled", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("no", "wallet-onboarding", "confirm-create", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(sentMessages.some((m) => m.includes("cancelled"))).toBe(true);
    });

    it("cancel command works", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("cancel", "wallet-onboarding", "confirm-create", "confirm"));
      expect(r.outcome).toBe("cancelled");
    });

    it("back command works", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("yes", "wallet-onboarding", "confirm-create", "confirm"));

      const r = await engine.handleAction("user-txt",
        textAction("back", "wallet-onboarding", "set-passphrase", "text-input"));
      expect(r.outcome).toBe("advanced");
      expect(r.state?.currentStep).toBe("confirm-create");
    });

    it("validates passphrase", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("yes", "wallet-onboarding", "confirm-create", "confirm"));

      const r = await engine.handleAction("user-txt",
        textAction("short", "wallet-onboarding", "set-passphrase", "text-input"));
      expect(r.outcome).toBe("validation-error");
      expect(toolCalls).toHaveLength(0);
    });

    it("shows progress indicators", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-txt", testSurface);
      expect(sentMessages.some((m) => m.includes("Step "))).toBe(true);
    });
  });

  // ─── Send DOGE ──────────────────────────────────────────────────────

  describe("Send DOGE", () => {
    it("completes full send flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-txt", testSurface);

      const steps: Array<[string, string, string]> = [
        ["DKaHBkfEJKef6r3L1SmhQiVbd2JT3vsRCa", "enter-address", "text-input"],
        ["10.5", "enter-amount", "text-input"],
        ["Test payment", "enter-reason", "text-input"],
      ];

      for (const [text, stepId, stepType] of steps) {
        await engine.handleAction("user-txt", textAction(text, "wallet-send", stepId, stepType));
      }

      // Confirm with yes
      const r = await engine.handleAction("user-txt",
        textAction("yes", "wallet-send", "confirm-send", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_send");
    });

    it("validates address", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("bad", "wallet-send", "enter-address", "text-input"));
      expect(r.outcome).toBe("validation-error");
    });

    it("cancel at any step", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("cancel", "wallet-send", "enter-address", "text-input"));
      expect(r.outcome).toBe("cancelled");
    });
  });

  // ─── Balance ────────────────────────────────────────────────────────

  describe("Balance", () => {
    it("executes balance check", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user-txt", testSurface);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_balance");
    });
  });

  // ─── History ────────────────────────────────────────────────────────

  describe("History", () => {
    it("executes history fetch", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.HISTORY, "user-txt", testSurface);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_history");
    });
  });

  // ─── Invoice ────────────────────────────────────────────────────────

  describe("Invoice", () => {
    it("completes invoice creation", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.INVOICE, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("50", "wallet-invoice", "enter-amount", "text-input"));
      await engine.handleAction("user-txt",
        textAction("Payment for services", "wallet-invoice", "enter-description", "text-input"));

      const r = await engine.handleAction("user-txt",
        textAction("yes", "wallet-invoice", "confirm-invoice", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_invoice");
    });

    it("cancel invoice", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.INVOICE, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("50", "wallet-invoice", "enter-amount", "text-input"));
      await engine.handleAction("user-txt",
        textAction("desc", "wallet-invoice", "enter-description", "text-input"));

      const r = await engine.handleAction("user-txt",
        textAction("no", "wallet-invoice", "confirm-invoice", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(0);
    });
  });

  // ─── Verify Payment ────────────────────────────────────────────────

  describe("Verify Payment", () => {
    it("completes verify flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.VERIFY_PAYMENT, "user-txt", testSurface);

      const txid = "a".repeat(64);
      await engine.handleAction("user-txt",
        textAction("inv-123", "wallet-verify-payment", "enter-invoice-id", "text-input"));
      await engine.handleAction("user-txt",
        textAction(txid, "wallet-verify-payment", "enter-txid", "text-input"));
      await engine.handleAction("user-txt",
        textAction("50", "wallet-verify-payment", "enter-amount", "text-input"));

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_verify_payment");
    });
  });
});
