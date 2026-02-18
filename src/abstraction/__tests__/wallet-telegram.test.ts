/**
 * T-034: Wallet Workflows on Telegram Adapter
 *
 * Tests all wallet workflows through the Telegram adapter (mocked).
 * Verifies button labels, flow order, tool calls, error messages.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowEngine, type ToolExecutor } from "../engine.js";
import { WorkflowStateManager } from "../state.js";
import { DefaultCapabilityNegotiator } from "../negotiator.js";
import {
  TelegramAdapter,
  type TelegramProvider,
  type TelegramOutboundMessage,
  type TelegramOutboundMedia,
  type TelegramEditMarkup,
  type TelegramEditText,
  type TelegramAnswerCallback,
  encodeCallbackData,
} from "../adapters/telegram/telegram-adapter.js";
import type { SurfaceTarget } from "../adapter.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWalletWorkflows, WALLET_WORKFLOWS } from "../workflows/wallet/index.js";

// ─── Mock Provider ──────────────────────────────────────────────────────────

interface ApiCall { method: string; args: unknown }

function createMockProvider() {
  let msgCounter = 0;
  const calls: ApiCall[] = [];
  const provider: TelegramProvider = {
    async sendMessage(msg: TelegramOutboundMessage) {
      msgCounter++;
      calls.push({ method: "sendMessage", args: msg });
      return { message_id: `tg-${msgCounter}` };
    },
    async sendMedia(msg: TelegramOutboundMedia) {
      msgCounter++;
      calls.push({ method: "sendMedia", args: msg });
      return { message_id: `tg-${msgCounter}` };
    },
    async editMessageText(msg: TelegramEditText) {
      calls.push({ method: "editMessageText", args: msg });
    },
    async editMessageReplyMarkup(msg: TelegramEditMarkup) {
      calls.push({ method: "editMessageReplyMarkup", args: msg });
    },
    async deleteMessage(chat_id: string, message_id: string) {
      calls.push({ method: "deleteMessage", args: { chat_id, message_id } });
    },
    async answerCallbackQuery(msg: TelegramAnswerCallback) {
      calls.push({ method: "answerCallbackQuery", args: msg });
    },
  };
  return { provider, calls };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "telegram",
  surfaceUserId: "user-tg",
  channelId: "user-tg",
};

describe("Wallet Workflows — Telegram Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let apiCalls: ApiCall[];
  let adapter: TelegramAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wallet-tg-"));
    stateManager = new WorkflowStateManager(dataDir);
    toolCalls = [];
    toolResult = { success: true, result: { ok: true } };

    const { provider, calls } = createMockProvider();
    apiCalls = calls;

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return toolResult;
    };

    adapter = new TelegramAdapter(provider);
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

  function findMsg(text: string) {
    return apiCalls.find(
      (c) => c.method === "sendMessage" && (c.args as TelegramOutboundMessage).text.includes(text),
    );
  }

  function getButtons(call: ApiCall) {
    const msg = call.args as TelegramOutboundMessage;
    return msg.reply_markup?.inline_keyboard?.flat() ?? [];
  }

  // ─── Onboarding ─────────────────────────────────────────────────────

  describe("Onboarding", () => {
    it("renders welcome and confirm with correct buttons", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      const welcomeMsg = findMsg("Welcome to DOGE Wallet");
      expect(welcomeMsg).toBeDefined();

      const confirmMsg = findMsg("Create a new wallet?");
      expect(confirmMsg).toBeDefined();
      const buttons = getButtons(confirmMsg!);
      expect(buttons.some((b) => b.text === "Create Wallet")).toBe(true);
      expect(buttons.some((b) => b.text === "Cancel")).toBe(true);
    });

    it("completes happy path with tool call", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      // Confirm yes
      const yesAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r1 = await engine.handleAction("user-tg", yesAction);
      expect(r1.outcome).toBe("advanced");
      expect(r1.state?.currentStep).toBe("set-passphrase");

      // Enter passphrase
      const passAction = adapter.parseAction({
        type: "text_message", text: "mysecurepass123",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-onboarding", stepId: "set-passphrase",
      })!;
      const r2 = await engine.handleAction("user-tg", passAction);
      expect(r2.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_init");
      expect(toolCalls[0].params.passphrase).toBe("mysecurepass123");

      expect(findMsg("Wallet is Ready")).toBeDefined();
    });

    it("handles No → cancelled terminal", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      const noAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "confirm-create", "no"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", noAction);
      expect(r.outcome).toBe("completed");
      expect(findMsg("cancelled")).toBeDefined();
      expect(toolCalls).toHaveLength(0);
    });

    it("validates passphrase length", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      const yesAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", yesAction);

      const shortPass = adapter.parseAction({
        type: "text_message", text: "short",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-onboarding", stepId: "set-passphrase",
      })!;
      const r = await engine.handleAction("user-tg", shortPass);
      expect(r.outcome).toBe("validation-error");
      expect(r.state?.currentStep).toBe("set-passphrase");
      expect(toolCalls).toHaveLength(0);
    });

    it("handles tool call failure", async () => {
      toolResult = { success: false, error: "Wallet already initialized" };
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      const yesAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", yesAction);

      const passAction = adapter.parseAction({
        type: "text_message", text: "mysecurepass123",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-onboarding", stepId: "set-passphrase",
      })!;
      const r = await engine.handleAction("user-tg", passAction);
      expect(r.outcome).toBe("tool-error");
    });

    it("supports back navigation", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user-tg", testSurface);

      const yesAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", yesAction);

      const backAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-onboarding", "set-passphrase", "__back__"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-2",
      })!;
      const r = await engine.handleAction("user-tg", backAction);
      expect(r.outcome).toBe("advanced");
      expect(r.state?.currentStep).toBe("confirm-create");
    });
  });

  // ─── Send DOGE ──────────────────────────────────────────────────────

  describe("Send DOGE", () => {
    it("completes full send flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-tg", testSurface);

      // Enter address
      const addrAction = adapter.parseAction({
        type: "text_message", text: "DKaHBkfEJKef6r3L1SmhQiVbd2JT3vsRCa",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-send", stepId: "enter-address",
      })!;
      const r1 = await engine.handleAction("user-tg", addrAction);
      expect(r1.outcome).toBe("advanced");

      // Enter amount
      const amtAction = adapter.parseAction({
        type: "text_message", text: "10.5",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-send", stepId: "enter-amount",
      })!;
      const r2 = await engine.handleAction("user-tg", amtAction);
      expect(r2.outcome).toBe("advanced");

      // Enter reason
      const reasonAction = adapter.parseAction({
        type: "text_message", text: "Test payment",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-send", stepId: "enter-reason",
      })!;
      const r3 = await engine.handleAction("user-tg", reasonAction);
      expect(r3.outcome).toBe("advanced");

      // Confirm
      const confirmAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-send", "confirm-send", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r4 = await engine.handleAction("user-tg", confirmAction);
      expect(r4.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_send");
      expect(toolCalls[0].params.to).toBe("DKaHBkfEJKef6r3L1SmhQiVbd2JT3vsRCa");
    });

    it("validates DOGE address format", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-tg", testSurface);

      const badAddr = adapter.parseAction({
        type: "text_message", text: "not-an-address",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-send", stepId: "enter-address",
      })!;
      const r = await engine.handleAction("user-tg", badAddr);
      expect(r.outcome).toBe("validation-error");
    });

    it("cancel at confirm step", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-tg", testSurface);

      // Fill in address, amount, reason
      for (const [text, step] of [
        ["DKaHBkfEJKef6r3L1SmhQiVbd2JT3vsRCa", "enter-address"],
        ["10", "enter-amount"],
        ["test", "enter-reason"],
      ] as const) {
        const action = adapter.parseAction({
          type: "text_message", text,
          userId: "user-tg", chatId: "user-tg",
          workflowId: "wallet-send", stepId: step,
        })!;
        await engine.handleAction("user-tg", action);
      }

      // Cancel at confirm
      const noAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-send", "confirm-send", "no"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", noAction);
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(0);
      expect(findMsg("cancelled")).toBeDefined();
    });
  });

  // ─── Balance ────────────────────────────────────────────────────────

  describe("Balance", () => {
    it("executes balance check", async () => {
      const state = await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user-tg", testSurface);
      // Balance workflow auto-advances through info steps
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_balance");
    });
  });

  // ─── History ────────────────────────────────────────────────────────

  describe("History", () => {
    it("executes history fetch", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.HISTORY, "user-tg", testSurface);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_history");
    });
  });

  // ─── Invoice ────────────────────────────────────────────────────────

  describe("Invoice", () => {
    it("completes invoice creation flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.INVOICE, "user-tg", testSurface);

      // Enter amount
      const amtAction = adapter.parseAction({
        type: "text_message", text: "50",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-invoice", stepId: "enter-amount",
      })!;
      await engine.handleAction("user-tg", amtAction);

      // Enter description
      const descAction = adapter.parseAction({
        type: "text_message", text: "Payment for services",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "wallet-invoice", stepId: "enter-description",
      })!;
      await engine.handleAction("user-tg", descAction);

      // Confirm
      const confirmAction = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-invoice", "confirm-invoice", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirmAction);
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_invoice");
    });
  });

  // ─── Verify Payment ────────────────────────────────────────────────

  describe("Verify Payment", () => {
    it("completes verify flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.VERIFY_PAYMENT, "user-tg", testSurface);

      const txid = "a".repeat(64);
      for (const [text, step] of [
        ["inv-123", "enter-invoice-id"],
        [txid, "enter-txid"],
        ["50", "enter-amount"],
      ] as const) {
        const action = adapter.parseAction({
          type: "text_message", text,
          userId: "user-tg", chatId: "user-tg",
          workflowId: "wallet-verify-payment", stepId: step,
        })!;
        await engine.handleAction("user-tg", action);
      }

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_verify_payment");
      expect(toolCalls[0].params.invoiceId).toBe("inv-123");
      expect(toolCalls[0].params.txid).toBe(txid);
    });
  });
});
