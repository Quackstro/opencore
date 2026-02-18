/**
 * T-042: Wallet Workflows on Slack Adapter
 *
 * Tests all wallet workflows through the Slack adapter (mocked).
 * Verifies Block Kit structure, interaction payload handling, tool call execution.
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
  type SlackBlock,
  encodeActionId,
} from "../adapters/slack/slack-adapter.js";
import type { SurfaceTarget } from "../adapter.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWalletWorkflows, WALLET_WORKFLOWS } from "../workflows/wallet/index.js";

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

describe("Wallet Workflows — Slack Adapter", () => {
  let dataDir: string;
  let stateManager: WorkflowStateManager;
  let engine: WorkflowEngine;
  let toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  let toolResult: { success: boolean; result?: unknown; error?: string };
  let apiCalls: ApiCall[];
  let adapter: SlackAdapter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "wallet-slack-"));
    stateManager = new WorkflowStateManager(dataDir);
    toolCalls = [];
    toolResult = { success: true, result: { ok: true } };

    const toolExecutor: ToolExecutor = async (name, params) => {
      toolCalls.push({ name, params });
      return toolResult;
    };

    engine = new WorkflowEngine({
      stateManager,
      negotiator: new DefaultCapabilityNegotiator(),
      toolExecutor,
    });

    const { provider, calls } = createMockProvider();
    apiCalls = calls;
    adapter = new SlackAdapter(provider);
    engine.registerAdapter(adapter);
    registerWalletWorkflows(engine);
  });

  afterEach(() => {
    stateManager.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ─── Onboarding ─────────────────────────────────────────────────────

  describe("wallet-onboarding", () => {
    it("renders welcome info then confirm with Block Kit buttons", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user1", testSurface);

      // Should auto-advance through welcome info to confirm-create
      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      expect(postCalls.length).toBeGreaterThanOrEqual(2);

      // Last message should have confirm buttons
      const lastMsg = postCalls[postCalls.length - 1].args as SlackOutboundMessage;
      const actionsBlock = lastMsg.blocks.find((b: SlackBlock) => b.type === "actions");
      expect(actionsBlock).toBeDefined();

      const elements = actionsBlock!.elements as Array<{ text: { text: string }; action_id: string }>;
      const labels = elements.map((e) => e.text.text);
      expect(labels).toContain("Create Wallet");
      expect(labels).toContain("Cancel");
    });

    it("completes full flow: confirm → passphrase → done", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user1", testSurface);

      // Click "Create Wallet" (confirm yes)
      const yesAction = {
        type: "block_actions",
        userId: "U12345",
        channelId: "C12345",
        actions: [{
          action_id: encodeActionId("wallet-onboarding", "confirm-create", "yes"),
          type: "button",
        }],
      };
      const parsed = adapter.parseAction(yesAction);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("selection");
      expect(parsed!.value).toBe("yes");

      let result = await engine.handleAction("user1", parsed!);
      expect(result.outcome).toBe("advanced");

      // Enter passphrase via threaded message
      const textAction = {
        type: "message",
        userId: "U12345",
        channelId: "C12345",
        text: "MyStr0ngP@ss!",
        workflowId: "wallet-onboarding",
        stepId: "set-passphrase",
      };
      const textParsed = adapter.parseAction(textAction);
      expect(textParsed).not.toBeNull();
      expect(textParsed!.kind).toBe("text");

      result = await engine.handleAction("user1", textParsed!);
      expect(result.outcome).toBe("completed");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_init");
      expect(toolCalls[0].params.passphrase).toBe("MyStr0ngP@ss!");
    });

    it("cancels via deny button", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user1", testSurface);

      const noAction = {
        type: "block_actions",
        userId: "U12345",
        channelId: "C12345",
        actions: [{
          action_id: encodeActionId("wallet-onboarding", "confirm-create", "no"),
          type: "button",
        }],
      };
      const parsed = adapter.parseAction(noAction);
      const result = await engine.handleAction("user1", parsed!);
      expect(result.outcome).toBe("completed");
    });
  });

  // ─── Send ───────────────────────────────────────────────────────────

  describe("wallet-send", () => {
    it("completes full send flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user1", testSurface);

      // Enter address
      let textAction = {
        type: "message",
        userId: "U12345",
        channelId: "C12345",
        text: "D8vFz4GUQMJBC4GK9NpCQhJfXv1xGYZk3H",
        workflowId: "wallet-send",
        stepId: "enter-address",
      };
      let parsed = adapter.parseAction(textAction)!;
      let result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("advanced");

      // Enter amount
      textAction = {
        ...textAction,
        text: "100",
        stepId: "enter-amount",
      };
      parsed = adapter.parseAction(textAction)!;
      result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("advanced");

      // Enter reason
      textAction = {
        ...textAction,
        text: "Test payment",
        stepId: "enter-reason",
      };
      parsed = adapter.parseAction(textAction)!;
      result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("advanced");

      // Confirm
      const yesAction = {
        type: "block_actions",
        userId: "U12345",
        channelId: "C12345",
        actions: [{
          action_id: encodeActionId("wallet-send", "confirm-send", "yes"),
          type: "button",
        }],
      };
      parsed = adapter.parseAction(yesAction)!;
      result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("wallet_send");
      expect(toolCalls[0].params.to).toBe("D8vFz4GUQMJBC4GK9NpCQhJfXv1xGYZk3H");
    });
  });

  // ─── Balance ────────────────────────────────────────────────────────

  describe("wallet-balance", () => {
    it("executes balance check tool and completes", async () => {
      const state = await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user1", testSurface);
      // Auto-advances through info steps, calls tool
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_balance");

      // Verify Block Kit sections were posted
      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      const msg = postCalls[0].args as SlackOutboundMessage;
      expect(msg.blocks[0].type).toBe("section");
    });
  });

  // ─── History ────────────────────────────────────────────────────────

  describe("wallet-history", () => {
    it("executes history fetch tool and completes", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.HISTORY, "user1", testSurface);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe("wallet_history");
    });
  });

  // ─── Invoice ────────────────────────────────────────────────────────

  describe("wallet-invoice", () => {
    it("completes full invoice creation flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.INVOICE, "user1", testSurface);

      // Enter amount
      let parsed = adapter.parseAction({
        type: "message", userId: "U12345", channelId: "C12345",
        text: "50", workflowId: "wallet-invoice", stepId: "enter-amount",
      })!;
      let result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("advanced");

      // Enter description
      parsed = adapter.parseAction({
        type: "message", userId: "U12345", channelId: "C12345",
        text: "Website hosting", workflowId: "wallet-invoice", stepId: "enter-description",
      })!;
      result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("advanced");

      // Confirm
      parsed = adapter.parseAction({
        type: "block_actions", userId: "U12345", channelId: "C12345",
        actions: [{ action_id: encodeActionId("wallet-invoice", "confirm-invoice", "yes"), type: "button" }],
      })!;
      result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("wallet_invoice");
    });
  });

  // ─── Verify Payment ────────────────────────────────────────────────

  describe("wallet-verify-payment", () => {
    it("completes full verification flow", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.VERIFY_PAYMENT, "user1", testSurface);

      const txid = "a".repeat(64);

      // Enter invoice ID
      let parsed = adapter.parseAction({
        type: "message", userId: "U12345", channelId: "C12345",
        text: "inv-123", workflowId: "wallet-verify-payment", stepId: "enter-invoice-id",
      })!;
      await engine.handleAction("user1", parsed);

      // Enter txid
      parsed = adapter.parseAction({
        type: "message", userId: "U12345", channelId: "C12345",
        text: txid, workflowId: "wallet-verify-payment", stepId: "enter-txid",
      })!;
      await engine.handleAction("user1", parsed);

      // Enter amount
      parsed = adapter.parseAction({
        type: "message", userId: "U12345", channelId: "C12345",
        text: "50", workflowId: "wallet-verify-payment", stepId: "enter-amount",
      })!;
      const result = await engine.handleAction("user1", parsed);
      expect(result.outcome).toBe("completed");
      expect(toolCalls[0].name).toBe("wallet_verify_payment");
      expect(toolCalls[0].params.invoiceId).toBe("inv-123");
      expect(toolCalls[0].params.txid).toBe(txid);
    });
  });

  // ─── Block Kit Structure ──────────────────────────────────────────

  describe("Block Kit structure", () => {
    it("renders section blocks with mrkdwn text", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user1", testSurface);
      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      const firstMsg = postCalls[0].args as SlackOutboundMessage;
      expect(firstMsg.blocks[0].type).toBe("section");
      expect((firstMsg.blocks[0].text as { type: string }).type).toBe("mrkdwn");
    });

    it("renders actions block with button elements", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.ONBOARDING, "user1", testSurface);
      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      // Confirm step has actions
      const confirmMsg = postCalls[postCalls.length - 1].args as SlackOutboundMessage;
      const actionsBlock = confirmMsg.blocks.find((b: SlackBlock) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      const elements = actionsBlock!.elements as Array<{ type: string }>;
      expect(elements[0].type).toBe("button");
    });

    it("posts to correct channel", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.BALANCE, "user1", testSurface);
      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      for (const call of postCalls) {
        expect((call.args as SlackOutboundMessage).channel).toBe("C12345");
      }
    });
  });

  // ─── Interaction Payloads ─────────────────────────────────────────

  describe("interaction payload parsing", () => {
    it("parses block_actions button click", () => {
      const event = {
        type: "block_actions",
        userId: "U12345",
        channelId: "C12345",
        actions: [{
          action_id: encodeActionId("test-wf", "step1", "option-a"),
          type: "button",
        }],
      };
      const parsed = adapter.parseAction(event);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("selection");
      expect(parsed!.value).toBe("option-a");
      expect(parsed!.workflowId).toBe("test-wf");
      expect(parsed!.stepId).toBe("step1");
    });

    it("parses view_submission modal", () => {
      const event = {
        type: "view_submission",
        userId: "U12345",
        view: {
          callback_id: "wf_modal:test-wf:step1",
          private_metadata: JSON.stringify({ channelId: "C12345" }),
          state: {
            values: {
              input_block: {
                text_input: { value: "hello world" },
              },
            },
          },
        },
      };
      const parsed = adapter.parseAction(event);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("text");
      expect(parsed!.text).toBe("hello world");
      expect(parsed!.workflowId).toBe("test-wf");
    });

    it("parses cancel text message", () => {
      const event = {
        type: "message",
        userId: "U12345",
        channelId: "C12345",
        text: "cancel",
        workflowId: "test-wf",
        stepId: "step1",
      };
      const parsed = adapter.parseAction(event);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("cancel");
    });

    it("returns null for unknown event types", () => {
      expect(adapter.parseAction({ type: "unknown" })).toBeNull();
      expect(adapter.parseAction(null)).toBeNull();
      expect(adapter.parseAction(42)).toBeNull();
    });
  });

  // ─── Modal Text Input ─────────────────────────────────────────────

  describe("modal text input", () => {
    it("opens modal when triggerId is available", async () => {
      const surfaceWithTrigger: SurfaceTarget & { triggerId: string } = {
        ...testSurface,
        triggerId: "trigger-abc",
      };
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user1", surfaceWithTrigger);

      const modalCalls = apiCalls.filter((c) => c.method === "viewsOpen");
      expect(modalCalls.length).toBeGreaterThanOrEqual(1);

      const modalArg = modalCalls[0].args as { trigger_id: string; view: { type: string; blocks: SlackBlock[] } };
      expect(modalArg.trigger_id).toBe("trigger-abc");
      expect(modalArg.view.type).toBe("modal");
      // Should have input block
      const inputBlock = modalArg.view.blocks.find((b: SlackBlock) => b.type === "input");
      expect(inputBlock).toBeDefined();
    });

    it("falls back to threaded reply when no triggerId", async () => {
      await engine.startWorkflow(WALLET_WORKFLOWS.SEND, "user1", testSurface);

      const postCalls = apiCalls.filter((c) => c.method === "postMessage");
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
      // Should have context block mentioning "Reply in this thread"
      const lastMsg = postCalls[postCalls.length - 1].args as SlackOutboundMessage;
      const contextBlock = lastMsg.blocks.find((b: SlackBlock) => b.type === "context");
      expect(contextBlock).toBeDefined();
    });
  });
});
