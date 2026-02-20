/**
 * T-056: Integration test — all plugins on Slack
 *
 * Tests key workflows from all 6 plugins through the Slack adapter.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowEngine, type ToolExecutor } from "../engine.js";
import { WorkflowStateManager } from "../state.js";
import { DefaultCapabilityNegotiator } from "../negotiator.js";
import {
  SlackAdapter,
  type SlackProvider,
  type SlackOutboundMessage,
  type SlackEphemeralMessage,
  type SlackUpdateMessage,
  type SlackFileUpload,
  type SlackModalOpen,
  encodeActionId,
} from "../adapters/slack/slack-adapter.js";
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
  let tsCounter = 0;
  const calls: ApiCall[] = [];
  const provider: SlackProvider = {
    async postMessage(msg: SlackOutboundMessage) {
      tsCounter++;
      calls.push({ method: "postMessage", args: msg });
      return { ts: `ts-${tsCounter}`, channel: msg.channel };
    },
    async postEphemeral(msg: SlackEphemeralMessage) {
      calls.push({ method: "postEphemeral", args: msg });
      return { message_ts: `eph-${++tsCounter}` };
    },
    async chatUpdate(msg: SlackUpdateMessage) {
      calls.push({ method: "chatUpdate", args: msg });
    },
    async chatDelete(channel: string, ts: string) {
      calls.push({ method: "chatDelete", args: { channel, ts } });
    },
    async filesUpload(msg: SlackFileUpload) {
      calls.push({ method: "filesUpload", args: msg });
      return { file: { id: `file-${++tsCounter}` } };
    },
    async viewsOpen(msg: SlackModalOpen) {
      calls.push({ method: "viewsOpen", args: msg });
      return { view: { id: `view-${++tsCounter}` } };
    },
  };
  return { provider, calls };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

const testSurface: SurfaceTarget = {
  surfaceId: "slack",
  surfaceUserId: "U12345",
  channelId: "C12345",
};

describe("All Plugins — Slack Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let apiCalls: ApiCall[];
  let adapter: SlackAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "all-slack-"));
    stateManager = new WorkflowStateManager(dataDir);
    toolCalls = [];
    toolResult = { success: true, result: { ok: true } };

    const { provider, calls } = createMockProvider();
    apiCalls = calls;

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return toolResult;
    };

    adapter = new SlackAdapter(provider);
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

  // ─── Wallet ─────────────────────────────────────────────────────────

  describe("Wallet", () => {
    it("balance check", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "U12345", testSurface);
      expect(toolCalls[0].name).toBe("wallet_balance");
    });
  });

  // ─── Ledger ─────────────────────────────────────────────────────────

  describe("Ledger", () => {
    it("report — net worth via button", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.REPORT, "U12345", testSurface);

      const action = adapter.parseAction({
        type: "block_actions",
        userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("ledger-report", "choose-report", "net-worth"), type: "button" }],
      })!;
      const r = await engine.handleAction("U12345", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_report");
    });

    it("transaction search", async () => {
      await engine.startWorkflow(LEDGER_WORKFLOWS.TRANSACTION_SEARCH, "U12345", testSurface);

      const action = adapter.parseAction({
        type: "message", text: "Starbucks",
        userId: "U12345", channelId: "C12345",
        workflowId: "ledger-transaction-search", stepId: "enter-query",
      })!;
      const r = await engine.handleAction("U12345", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("ledger_transactions");
    });
  });

  // ─── Heal ───────────────────────────────────────────────────────────

  describe("Heal", () => {
    it("repair with confirmation", async () => {
      await engine.startWorkflow(HEAL_WORKFLOWS.REPAIR, "U12345", testSurface);

      const confirm = adapter.parseAction({
        type: "block_actions",
        userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("heal-repair", "confirm-repair", "yes"), type: "button" }],
      })!;
      const r = await engine.handleAction("U12345", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("heal_repair");
    });
  });

  // ─── Ark ────────────────────────────────────────────────────────────

  describe("Ark", () => {
    it("status check", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.STATUS, "U12345", testSurface);
      expect(toolCalls[0].name).toBe("backup_status");
    });

    it("backup with passphrase", async () => {
      await engine.startWorkflow(ARK_WORKFLOWS.BACKUP, "U12345", testSurface);

      const confirm = adapter.parseAction({
        type: "block_actions",
        userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("ark-backup", "confirm-backup", "yes"), type: "button" }],
      })!;
      await engine.handleAction("U12345", confirm);

      const pass = adapter.parseAction({
        type: "message", text: "securepass123",
        userId: "U12345", channelId: "C12345",
        workflowId: "ark-backup", stepId: "enter-passphrase",
      })!;
      const r = await engine.handleAction("U12345", pass);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("backup_create");
    });
  });

  // ─── Brain ──────────────────────────────────────────────────────────

  describe("Brain", () => {
    it("drop a thought", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DROP, "U12345", testSurface);

      const thought = adapter.parseAction({
        type: "message", text: "Buy groceries tomorrow",
        userId: "U12345", channelId: "C12345",
        workflowId: "brain-drop", stepId: "enter-thought",
      })!;
      const r = await engine.handleAction("U12345", thought);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_drop");
    });

    it("DND toggle", async () => {
      await engine.startWorkflow(BRAIN_WORKFLOWS.DND, "U12345", testSurface);

      const action = adapter.parseAction({
        type: "block_actions",
        userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("brain-dnd", "choose-action", "off"), type: "button" }],
      })!;
      const r = await engine.handleAction("U12345", action);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("brain_dnd");
      expect(toolCalls[0].params.action).toBe("off");
    });
  });

  // ─── OpenCore ───────────────────────────────────────────────────────

  describe("OpenCore", () => {
    it("status", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.STATUS, "U12345", testSurface);
      expect(toolCalls[0].name).toBe("opencore_status");
    });

    it("update with confirmation", async () => {
      await engine.startWorkflow(OPENCORE_WORKFLOWS.UPDATE, "U12345", testSurface);

      const confirm = adapter.parseAction({
        type: "block_actions",
        userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("opencore-update", "confirm-update", "yes"), type: "button" }],
      })!;
      const r = await engine.handleAction("U12345", confirm);
      expect(r.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("opencore_update");
    });
  });
});
