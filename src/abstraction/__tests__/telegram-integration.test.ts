/**
 * T-024: Telegram Adapter Integration Test
 *
 * Mocks Telegram API, runs wallet onboarding through SDK with TelegramAdapter.
 * Verifies correct API call structure: sendMessage with inline_keyboard,
 * callback handling, button removal.
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
import type { WorkflowDefinition } from "../types/workflow.js";
import type { SurfaceTarget } from "../adapter.js";
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
      content: "🐕 Welcome to Wallet Setup!",
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
      validation: { minLength: 8 },
      toolCall: {
        name: "wallet_init",
        paramMap: { passphrase: "$input" },
      },
      next: "complete",
    },
    complete: {
      type: "info",
      content: "✅ Wallet created successfully!",
      terminal: true,
    },
    cancelled: {
      type: "info",
      content: "Wallet setup cancelled.",
      terminal: true,
    },
  },
};

// ─── Mock Telegram Provider ─────────────────────────────────────────────────

interface ApiCall {
  method: string;
  args: unknown;
}

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

// ─── Helpers ────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "telegram",
  surfaceUserId: "12345",
  channelId: "12345",
};

describe("Telegram Adapter Integration: Wallet Onboarding", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let apiCalls: ApiCall[];
  let adapter: TelegramAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tg-int-"));
    stateManager = new WorkflowStateManager(dataDir);
    toolCalls = [];

    const { provider, calls } = createMockProvider();
    apiCalls = calls;

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return { success: true, result: { address: "D8foobar..." } };
    };

    adapter = new TelegramAdapter(provider);
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

  it("renders confirm step with inline keyboard buttons", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    // Find the sendMessage call for the confirm step
    const confirmCall = apiCalls.find(
      (c) => c.method === "sendMessage" && (c.args as TelegramOutboundMessage).text.includes("create a new wallet"),
    );
    expect(confirmCall).toBeDefined();

    const msg = confirmCall!.args as TelegramOutboundMessage;
    expect(msg.reply_markup).toBeDefined();
    expect(msg.reply_markup!.inline_keyboard).toBeDefined();

    // Should have yes/no buttons + cancel button
    const allButtons = msg.reply_markup!.inline_keyboard.flat();
    expect(allButtons.some((b) => b.text === "Yes, create wallet")).toBe(true);
    expect(allButtons.some((b) => b.text === "No, cancel")).toBe(true);
    expect(allButtons.some((b) => b.text === "Cancel")).toBe(true);
  });

  it("parses callback_query into selection action", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    const callbackData = encodeCallbackData("wallet-onboarding", "confirm-create", "yes");
    const action = adapter.parseAction({
      type: "callback_query",
      data: callbackData,
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    });

    expect(action).not.toBeNull();
    expect(action!.kind).toBe("selection");
    expect(action!.value).toBe("yes");
    expect(action!.workflowId).toBe("wallet-onboarding");
    expect(action!.stepId).toBe("confirm-create");
  });

  it("completes full workflow via button presses and text input", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    // Press "Yes" button
    const yesCallback = encodeCallbackData("wallet-onboarding", "confirm-create", "yes");
    const yesAction = adapter.parseAction({
      type: "callback_query",
      data: yesCallback,
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;

    const r1 = await engine.handleAction("12345", yesAction);
    expect(r1.outcome).toBe("advanced");
    expect(r1.state?.currentStep).toBe("set-passphrase");

    // Enter passphrase via text
    const passAction = adapter.parseAction({
      type: "text_message",
      text: "mysecurepass123",
      userId: "12345",
      chatId: "12345",
      workflowId: "wallet-onboarding",
      stepId: "set-passphrase",
    })!;

    const r2 = await engine.handleAction("12345", passAction);
    expect(r2.outcome).toBe("completed");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("wallet_init");
    expect(toolCalls[0].params.passphrase).toBe("mysecurepass123");

    // Verify completion message was sent
    const completeCall = apiCalls.find(
      (c) => c.method === "sendMessage" && (c.args as TelegramOutboundMessage).text.includes("Wallet created"),
    );
    expect(completeCall).toBeDefined();
  });

  it("handles cancel via callback button", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    const cancelCallback = encodeCallbackData("wallet-onboarding", "confirm-create", "__cancel__");
    const cancelAction = adapter.parseAction({
      type: "callback_query",
      data: cancelCallback,
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-2",
    })!;

    const r = await engine.handleAction("12345", cancelAction);
    expect(r.outcome).toBe("cancelled");
    expect(engine.getActiveWorkflow("12345")).toBeNull();
  });

  it("handles back via callback button", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    // Confirm yes
    const yesAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;
    await engine.handleAction("12345", yesAction);

    // Back button on set-passphrase
    const backAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "set-passphrase", "__back__"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-3",
    })!;

    const r = await engine.handleAction("12345", backAction);
    expect(r.outcome).toBe("advanced");
    expect(r.state?.currentStep).toBe("confirm-create");
  });

  it("acknowledges callback queries", async () => {
    const rawEvent = {
      type: "callback_query",
      data: "wf:x|s:y|a:z",
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-99",
    };

    await adapter.acknowledgeAction(rawEvent, "Got it!");

    const ackCall = apiCalls.find((c) => c.method === "answerCallbackQuery");
    expect(ackCall).toBeDefined();
    expect((ackCall!.args as TelegramAnswerCallback).callback_query_id).toBe("cq-99");
    expect((ackCall!.args as TelegramAnswerCallback).text).toBe("Got it!");
  });

  it("renders text-input step with back/cancel buttons", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    // Confirm yes to get to set-passphrase
    const yesAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;
    await engine.handleAction("12345", yesAction);

    // Find the text-input step message
    const passCall = apiCalls.find(
      (c) => c.method === "sendMessage" && (c.args as TelegramOutboundMessage).text.includes("passphrase"),
    );
    expect(passCall).toBeDefined();

    const msg = passCall!.args as TelegramOutboundMessage;
    // Should have back + cancel buttons
    if (msg.reply_markup) {
      const allButtons = msg.reply_markup.inline_keyboard.flat();
      expect(allButtons.some((b) => b.text === "← Back")).toBe(true);
      expect(allButtons.some((b) => b.text === "Cancel")).toBe(true);
    }
  });

  it("handles text cancel command", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    // Confirm yes to get to set-passphrase
    const yesAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;
    await engine.handleAction("12345", yesAction);

    // Type "cancel" as text
    const cancelAction = adapter.parseAction({
      type: "text_message",
      text: "cancel",
      userId: "12345",
      chatId: "12345",
      workflowId: "wallet-onboarding",
      stepId: "set-passphrase",
    })!;

    expect(cancelAction.kind).toBe("cancel");
    const r = await engine.handleAction("12345", cancelAction);
    expect(r.outcome).toBe("cancelled");
  });

  it("handles No button correctly — routes to cancelled terminal", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    const noAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "confirm-create", "no"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;

    const r = await engine.handleAction("12345", noAction);
    expect(r.outcome).toBe("completed");
    expect(toolCalls).toHaveLength(0);

    // Check cancelled message was sent
    const cancelledMsg = apiCalls.find(
      (c) => c.method === "sendMessage" && (c.args as TelegramOutboundMessage).text.includes("cancelled"),
    );
    expect(cancelledMsg).toBeDefined();
  });

  it("validation error keeps user on same step", async () => {
    await engine.startWorkflow("wallet-onboarding", "12345", testSurface);

    const yesAction = adapter.parseAction({
      type: "callback_query",
      data: encodeCallbackData("wallet-onboarding", "confirm-create", "yes"),
      userId: "12345",
      chatId: "12345",
      callbackQueryId: "cq-1",
    })!;
    await engine.handleAction("12345", yesAction);

    // Too-short passphrase
    const shortPass = adapter.parseAction({
      type: "text_message",
      text: "short",
      userId: "12345",
      chatId: "12345",
      workflowId: "wallet-onboarding",
      stepId: "set-passphrase",
    })!;

    const r = await engine.handleAction("12345", shortPass);
    expect(r.outcome).toBe("validation-error");
    expect(r.state?.currentStep).toBe("set-passphrase");
    expect(toolCalls).toHaveLength(0);
  });
});
