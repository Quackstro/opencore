/**
 * T-055: Integration test — all plugins on Telegram
 *
 * Tests key workflows from all 6 plugins through the Telegram adapter.
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
import { registerLedgerWorkflows, LEDGER_WORKFLOWS } from "../workflows/ledger/index.js";
import { registerHealWorkflows, HEAL_WORKFLOWS } from "../workflows/heal/index.js";
import { registerArkWorkflows, ARK_WORKFLOWS } from "../workflows/ark/index.js";
import { registerBrainWorkflows, BRAIN_WORKFLOWS } from "../workflows/brain/index.js";
import { registerOpencoreWorkflows, OPENCORE_WORKFLOWS } from "../workflows/opencore/index.js";

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

describe("All Plugins — Telegram Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let apiCalls: ApiCall[];
  let adapter: TelegramAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "all-tg-"));
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
    registerLedgerWorkflows(engine);
    registerHealWorkflows(engine);
    registerArkWorkflows(engine);
    registerBrainWorkflows(engine);
    registerOpencoreWorkflows(engine);
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

  // ─── Wallet ─────────────────────────────────────────────────────────

  describe("Wallet", () => {
    it("balance check executes tool", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user-tg", testSurface);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_balance");
    });

    it("send flow with confirmation", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user-tg", testSurface);

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

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("wallet-send", "confirm-send", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("wallet_send");
    });
  });

  // ─── Ledger ─────────────────────────────────────────────────────────

  describe("Ledger", () => {
    it("transaction search", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.TRANSACTION_SEARCH, "user-tg", testSurface);
      expect(findMsg("Transaction Search")).toBeDefined();

      const action = adapter.parseAction({
        type: "text_message", text: "Amazon",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ledger-transaction-search", stepId: "enter-query",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_transactions");
      expect(toolCalls[0].params.description).toBe("Amazon");
    });

    it("report — net worth (no input needed)", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.REPORT, "user-tg", testSurface);

      const action = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ledger-report", "choose-report", "net-worth"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_report");
      expect(toolCalls[0].params.action).toBe("netWorth");
    });

    it("budget setup — set category", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.BUDGET_SETUP, "user-tg", testSurface);

      // Choose set-category
      const choose = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ledger-budget-setup", "choose-action", "set-category"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", choose);

      // Enter category
      const cat = adapter.parseAction({
        type: "text_message", text: "groceries",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ledger-budget-setup", stepId: "enter-category",
      })!;
      await engine.handleAction("user-tg", cat);

      // Enter amount
      const amt = adapter.parseAction({
        type: "text_message", text: "500",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ledger-budget-setup", stepId: "enter-category-amount",
      })!;
      await engine.handleAction("user-tg", amt);

      // Confirm
      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ledger-budget-setup", "confirm-category-budget", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-2",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_budget");
      expect(toolCalls[0].params.category).toBe("groceries");
    });

    it("bill management — view upcoming", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.BILL_MANAGEMENT, "user-tg", testSurface);

      const action = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ledger-bill-management", "choose-action", "upcoming"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_bills");
    });

    it("statement import with confirmation", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.STATEMENT_IMPORT, "user-tg", testSurface);

      for (const [text, step] of [
        ["chase-checking", "enter-account"],
        ["2024-01", "enter-period"],
        ["/data/stmt.json", "enter-file-path"],
      ] as const) {
        const action = adapter.parseAction({
          type: "text_message", text,
          userId: "user-tg", chatId: "user-tg",
          workflowId: "ledger-statement-import", stepId: step,
        })!;
        await engine.handleAction("user-tg", action);
      }

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ledger-statement-import", "confirm-import", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_import");
    });
  });

  // ─── Heal ───────────────────────────────────────────────────────────

  describe("Heal", () => {
    it("health check — system", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.HEALTH_CHECK, "user-tg", testSurface);

      const action = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("heal-health-check", "choose-check", "system"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("heal_check");
    });

    it("repair with confirmation", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.REPAIR, "user-tg", testSurface);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("heal-repair", "confirm-repair", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("heal_repair");
    });

    it("repair cancel", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.REPAIR, "user-tg", testSurface);

      const deny = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("heal-repair", "confirm-repair", "no"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", deny);
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(0);
    });
  });

  // ─── Ark ────────────────────────────────────────────────────────────

  describe("Ark", () => {
    it("backup status", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.STATUS, "user-tg", testSurface);
      expect(toolCalls[0].name).toBe("backup_status");
    });

    it("backup creation with passphrase", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.BACKUP, "user-tg", testSurface);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ark-backup", "confirm-backup", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", confirm);

      const pass = adapter.parseAction({
        type: "text_message", text: "mybackuppass123",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ark-backup", stepId: "enter-passphrase",
      })!;
      const r = await engine.handleAction("user-tg", pass);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("backup_create");
      expect(toolCalls[0].params.passphrase).toBe("mybackuppass123");
    });

    it("restore with confirmation", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.RESTORE, "user-tg", testSurface);

      const file = adapter.parseAction({
        type: "text_message", text: "backup-2024-01.ark",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ark-restore", stepId: "enter-file",
      })!;
      await engine.handleAction("user-tg", file);

      const pass = adapter.parseAction({
        type: "text_message", text: "mybackuppass123",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "ark-restore", stepId: "enter-passphrase",
      })!;
      await engine.handleAction("user-tg", pass);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("ark-restore", "confirm-restore", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("backup_restore");
    });
  });

  // ─── Brain ──────────────────────────────────────────────────────────

  describe("Brain", () => {
    it("drop a thought", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DROP, "user-tg", testSurface);

      const thought = adapter.parseAction({
        type: "text_message", text: "Remember to call dentist",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "brain-drop", stepId: "enter-thought",
      })!;
      const r = await engine.handleAction("user-tg", thought);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_drop");
      expect(toolCalls[0].params.text).toBe("Remember to call dentist");
    });

    it("search brain", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.SEARCH, "user-tg", testSurface);

      const query = adapter.parseAction({
        type: "text_message", text: "dentist",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "brain-search", stepId: "enter-query",
      })!;
      const r = await engine.handleAction("user-tg", query);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_search");
    });

    it("DND toggle — enable", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DND, "user-tg", testSurface);

      const action = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("brain-dnd", "choose-action", "on"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_dnd");
      expect(toolCalls[0].params.action).toBe("on");
    });

    it("fix — trash with confirmation", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.FIX, "user-tg", testSurface);

      const id = adapter.parseAction({
        type: "text_message", text: "abc123",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "brain-fix", stepId: "enter-id",
      })!;
      await engine.handleAction("user-tg", id);

      const choose = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("brain-fix", "choose-action", "trash"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", choose);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("brain-fix", "confirm-trash", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-2",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_fix");
    });
  });

  // ─── OpenCore ───────────────────────────────────────────────────────

  describe("OpenCore", () => {
    it("status check", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.STATUS, "user-tg", testSurface);
      expect(toolCalls[0].name).toBe("opencore_status");
    });

    it("update with confirmation", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.UPDATE, "user-tg", testSurface);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("opencore-update", "confirm-update", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_update");
    });

    it("config — view", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.CONFIG, "user-tg", testSurface);

      const action = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("opencore-config", "choose-action", "view"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      const r = await engine.handleAction("user-tg", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_config");
    });

    it("config — set with confirmation", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.CONFIG, "user-tg", testSurface);

      const choose = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("opencore-config", "choose-action", "set"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-1",
      })!;
      await engine.handleAction("user-tg", choose);

      const key = adapter.parseAction({
        type: "text_message", text: "defaultModel",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "opencore-config", stepId: "enter-key",
      })!;
      await engine.handleAction("user-tg", key);

      const val = adapter.parseAction({
        type: "text_message", text: "gpt-4",
        userId: "user-tg", chatId: "user-tg",
        workflowId: "opencore-config", stepId: "enter-value",
      })!;
      await engine.handleAction("user-tg", val);

      const confirm = adapter.parseAction({
        type: "callback_query",
        data: encodeCallbackData("opencore-config", "confirm-set", "yes"),
        userId: "user-tg", chatId: "user-tg", callbackQueryId: "cq-2",
      })!;
      const r = await engine.handleAction("user-tg", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_config");
      expect(toolCalls[0].params.key).toBe("defaultModel");
      expect(toolCalls[0].params.value).toBe("gpt-4");
    });
  });
});
