/**
 * T-057: Integration test — all plugins on Text-Only
 *
 * Tests key workflows from all 6 plugins through the Text-Only adapter.
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
import { registerLedgerWorkflows, LEDGER_WORKFLOWS } from "../workflows/ledger/index.js";
import { registerHealWorkflows, HEAL_WORKFLOWS } from "../workflows/heal/index.js";
import { registerArkWorkflows, ARK_WORKFLOWS } from "../workflows/ark/index.js";
import { registerBrainWorkflows, BRAIN_WORKFLOWS } from "../workflows/brain/index.js";
import { registerOpencoreWorkflows, OPENCORE_WORKFLOWS } from "../workflows/opencore/index.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "text",
  surfaceUserId: "user-txt",
};

describe("All Plugins — Text-Only Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let sentMessages: string[];
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let adapter: TextOnlyAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "all-txt-"));
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

  // ─── Wallet ─────────────────────────────────────────────────────────

  describe("Wallet", () => {
    it("balance", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user-txt", testSurface);
      expect(toolCalls[0].name).toBe("wallet_balance");
    });

    it("history", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.HISTORY, "user-txt", testSurface);
      expect(toolCalls[0].name).toBe("wallet_history");
    });
  });

  // ─── Ledger ─────────────────────────────────────────────────────────

  describe("Ledger", () => {
    it("transaction search", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.TRANSACTION_SEARCH, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("Amazon", "ledger-transaction-search", "enter-query", "text-input"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_transactions");
    });

    it("report — net worth via numbered selection", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.REPORT, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("2", "ledger-report", "choose-report", "choice", [
          { id: "spending" }, { id: "net-worth" }, { id: "balances" }, { id: "ytd" },
        ]));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_report");
      expect(toolCalls[0].params.action).toBe("netWorth");
    });

    it("budget — set category via text", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.BUDGET_SETUP, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("1", "ledger-budget-setup", "choose-action", "choice", [
          { id: "set-category" }, { id: "set-monthly" }, { id: "view-status" },
        ]));
      await engine.handleAction("user-txt",
        textAction("dining", "ledger-budget-setup", "enter-category", "text-input"));
      await engine.handleAction("user-txt",
        textAction("300", "ledger-budget-setup", "enter-category-amount", "text-input"));

      const r = await engine.handleAction("user-txt",
        textAction("yes", "ledger-budget-setup", "confirm-category-budget", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_budget");
      expect(toolCalls[0].params.category).toBe("dining");
    });

    it("bill management — upcoming", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.BILL_MANAGEMENT, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("1", "ledger-bill-management", "choose-action", "choice", [
          { id: "upcoming" }, { id: "detect" }, { id: "add" },
        ]));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_bills");
    });
  });

  // ─── Heal ───────────────────────────────────────────────────────────

  describe("Heal", () => {
    it("health check — system", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.HEALTH_CHECK, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("1", "heal-health-check", "choose-check", "choice", [
          { id: "system" }, { id: "plugins" }, { id: "connectivity" },
        ]));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("heal_check");
    });

    it("repair — confirm yes", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.REPAIR, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("yes", "heal-repair", "confirm-repair", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("heal_repair");
    });

    it("repair — cancel", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.REPAIR, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("no", "heal-repair", "confirm-repair", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(0);
    });
  });

  // ─── Ark ────────────────────────────────────────────────────────────

  describe("Ark", () => {
    it("status", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.STATUS, "user-txt", testSurface);
      expect(toolCalls[0].name).toBe("backup_status");
    });

    it("backup with passphrase", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.BACKUP, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("yes", "ark-backup", "confirm-backup", "confirm"));

      const r = await engine.handleAction("user-txt",
        textAction("securepass123", "ark-backup", "enter-passphrase", "text-input"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("backup_create");
    });

    it("restore with confirmation", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.RESTORE, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("backup-2024.ark", "ark-restore", "enter-file", "text-input"));
      await engine.handleAction("user-txt",
        textAction("mypassphrase1", "ark-restore", "enter-passphrase", "text-input"));

      const r = await engine.handleAction("user-txt",
        textAction("yes", "ark-restore", "confirm-restore", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("backup_restore");
    });
  });

  // ─── Brain ──────────────────────────────────────────────────────────

  describe("Brain", () => {
    it("drop", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DROP, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("Remember meeting at 3pm", "brain-drop", "enter-thought", "text-input"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_drop");
    });

    it("search", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.SEARCH, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("meeting notes", "brain-search", "enter-query", "text-input"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_search");
    });

    it("DND — enable", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DND, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("1", "brain-dnd", "choose-action", "choice", [
          { id: "on" }, { id: "off" }, { id: "status" },
        ]));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_dnd");
      expect(toolCalls[0].params.action).toBe("on");
    });
  });

  // ─── OpenCore ───────────────────────────────────────────────────────

  describe("OpenCore", () => {
    it("status", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.STATUS, "user-txt", testSurface);
      expect(toolCalls[0].name).toBe("opencore_status");
    });

    it("update — confirm", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.UPDATE, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("yes", "opencore-update", "confirm-update", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_update");
    });

    it("update — cancel", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.UPDATE, "user-txt", testSurface);

      const r = await engine.handleAction("user-txt",
        textAction("no", "opencore-update", "confirm-update", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(0);
    });

    it("config — set value", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.CONFIG, "user-txt", testSurface);

      await engine.handleAction("user-txt",
        textAction("2", "opencore-config", "choose-action", "choice", [
          { id: "view" }, { id: "set" }, { id: "channel" },
        ]));
      await engine.handleAction("user-txt",
        textAction("model", "opencore-config", "enter-key", "text-input"));
      await engine.handleAction("user-txt",
        textAction("claude-3", "opencore-config", "enter-value", "text-input"));

      const r = await engine.handleAction("user-txt",
        textAction("yes", "opencore-config", "confirm-set", "confirm"));
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_config");
      expect(toolCalls[0].params.key).toBe("model");
    });
  });
});
