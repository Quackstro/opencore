/**
 * T-040/T-041: Slack Surface Adapter
 *
 * Maps abstract interaction primitives to Slack Block Kit.
 * Handles: modals for text input, threaded replies, ephemeral messages,
 * Block Kit limits (50 blocks/msg, 10 elements/actions block), 3000 char limit.
 */

import type {
  MessagePayload,
  ParsedUserAction,
  RenderContext,
  RenderedMessage,
  SendResult,
  SurfaceAdapter,
  SurfaceCapabilities,
  SurfaceTarget,
} from "../../adapter.js";
import type {
  ChoicePrimitive,
  ConfirmPrimitive,
  InfoPrimitive,
  InteractionPrimitive,
  MediaPrimitive,
  MultiChoicePrimitive,
  TextInputPrimitive,
} from "../../primitives.js";

// ─── Slack Block Kit Types ──────────────────────────────────────────────────

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackTextObject;
  accessory?: unknown;
  elements?: unknown[];
  element?: unknown;
  label?: SlackTextObject;
  dispatch_action?: boolean;
  [key: string]: unknown;
}

export interface SlackTextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackButtonElement {
  type: "button";
  text: SlackTextObject;
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
}

export interface SlackCheckboxOption {
  text: SlackTextObject;
  value: string;
  description?: SlackTextObject;
}

export interface SlackCheckboxesElement {
  type: "checkboxes";
  action_id: string;
  options: SlackCheckboxOption[];
}

export interface SlackModalView {
  type: "modal";
  callback_id: string;
  title: SlackTextObject;
  submit?: SlackTextObject;
  close?: SlackTextObject;
  blocks: SlackBlock[];
  private_metadata?: string;
}

// ─── Slack API Provider (injected) ──────────────────────────────────────────

export interface SlackOutboundMessage {
  channel: string;
  blocks: SlackBlock[];
  text: string; // fallback text
  thread_ts?: string;
}

export interface SlackEphemeralMessage {
  channel: string;
  user: string;
  blocks?: SlackBlock[];
  text: string;
  thread_ts?: string;
}

export interface SlackUpdateMessage {
  channel: string;
  ts: string;
  blocks?: SlackBlock[];
  text: string;
}

export interface SlackFileUpload {
  channels: string;
  content?: string;
  filename?: string;
  filetype?: string;
  title?: string;
  initial_comment?: string;
  thread_ts?: string;
  /** URL or path for the file */
  source?: string;
}

export interface SlackModalOpen {
  trigger_id: string;
  view: SlackModalView;
}

export interface SlackProvider {
  postMessage(msg: SlackOutboundMessage): Promise<{ ts: string; channel: string }>;
  postEphemeral(msg: SlackEphemeralMessage): Promise<{ message_ts: string }>;
  chatUpdate(msg: SlackUpdateMessage): Promise<void>;
  chatDelete(channel: string, ts: string): Promise<void>;
  filesUpload(msg: SlackFileUpload): Promise<{ file: { id: string } }>;
  viewsOpen(msg: SlackModalOpen): Promise<{ view: { id: string } }>;
}

// ─── Callback data encoding ─────────────────────────────────────────────────

function encodeActionId(
  workflowId: string,
  stepId: string,
  actionId: string,
): string {
  // Slack action_id max 255 chars
  const data = `wf:${workflowId}|s:${stepId}|a:${actionId}`;
  return data.length <= 255 ? data : data.slice(0, 255);
}

function decodeActionId(
  actionId: string,
): { workflowId: string; stepId: string; actionId: string } | null {
  const match = actionId.match(/^wf:([^|]+)\|s:([^|]+)\|a:(.+)$/);
  if (!match) return null;
  return { workflowId: match[1], stepId: match[2], actionId: match[3] };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTON_ROWS = 10;
const MAX_MESSAGE_LENGTH = 3000;
const MAX_BLOCKS_PER_MESSAGE = 50;
const MAX_ELEMENTS_PER_ACTION = 10;

// ─── Adapter ────────────────────────────────────────────────────────────────

export class SlackAdapter implements SurfaceAdapter {
  readonly surfaceId = "slack";
  readonly version = "1.0.0";
  readonly capabilities: SurfaceCapabilities = {
    inlineButtons: true,
    multiSelectButtons: true,
    reactions: true,
    messageEffects: false,
    fileUpload: true,
    voiceMessages: false,
    threading: true,
    richText: true,
    modals: true,
    maxButtonsPerRow: MAX_BUTTONS_PER_ROW,
    maxButtonRows: MAX_BUTTON_ROWS,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  };

  private provider: SlackProvider;

  constructor(provider: SlackProvider) {
    this.provider = provider;
  }

  // ─── Render ─────────────────────────────────────────────────────────

  async render(
    target: SurfaceTarget,
    primitive: InteractionPrimitive,
    context: RenderContext,
  ): Promise<RenderedMessage> {
    switch (primitive.type) {
      case "choice":
        return this.renderChoice(target, primitive, context);
      case "multi-choice":
        return this.renderMultiChoice(target, primitive, context);
      case "confirm":
        return this.renderConfirm(target, primitive, context);
      case "text-input":
        return this.renderTextInput(target, primitive, context);
      case "info":
        return this.renderInfo(target, primitive);
      case "media":
        return this.renderMedia(target, primitive, context);
    }
  }

  private async renderChoice(
    target: SurfaceTarget,
    p: ChoicePrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const blocks: SlackBlock[] = [
      this.sectionBlock(text),
    ];

    // Build button rows, respecting limits
    const buttons: SlackButtonElement[] = p.options.map((o) => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: o.label, emoji: true },
      action_id: encodeActionId(ctx.workflowId, ctx.stepId, o.id),
      value: o.id,
      style: o.style === "danger" ? "danger" : o.style === "success" || o.style === "primary" ? "primary" : undefined,
    }));

    // Add meta buttons
    if (p.includeBack) {
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "← Back", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__back__"),
        value: "__back__",
      });
    }
    if (p.includeCancel) {
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__cancel__"),
        value: "__cancel__",
      });
    }

    // Chunk buttons into actions blocks (max MAX_ELEMENTS_PER_ACTION per block)
    for (let i = 0; i < buttons.length; i += MAX_ELEMENTS_PER_ACTION) {
      const chunk = buttons.slice(i, i + MAX_ELEMENTS_PER_ACTION);
      blocks.push({
        type: "actions",
        block_id: `actions_${i}`,
        elements: chunk,
      });
      if (blocks.length >= MAX_BLOCKS_PER_MESSAGE) break;
    }

    return this.postBlocks(target, blocks, text);
  }

  private async renderMultiChoice(
    target: SurfaceTarget,
    p: MultiChoicePrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const blocks: SlackBlock[] = [
      this.sectionBlock(text),
    ];

    const checkboxOptions: SlackCheckboxOption[] = p.options.map((o) => ({
      text: { type: "plain_text" as const, text: o.label, emoji: true },
      value: o.id,
      description: o.description ? { type: "plain_text" as const, text: o.description, emoji: true } : undefined,
    }));

    blocks.push({
      type: "actions",
      block_id: "multi_select",
      elements: [
        {
          type: "checkboxes",
          action_id: encodeActionId(ctx.workflowId, ctx.stepId, "checkboxes"),
          options: checkboxOptions,
        } satisfies SlackCheckboxesElement,
      ],
    });

    // Submit + meta buttons
    const metaButtons: SlackButtonElement[] = [
      {
        type: "button",
        text: { type: "plain_text", text: `✅ ${p.submitLabel ?? "Confirm"}`, emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "submit"),
        value: "submit",
        style: "primary",
      },
    ];
    if (p.includeBack) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "← Back", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__back__"),
        value: "__back__",
      });
    }
    if (p.includeCancel) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__cancel__"),
        value: "__cancel__",
      });
    }

    blocks.push({
      type: "actions",
      block_id: "meta_actions",
      elements: metaButtons,
    });

    return this.postBlocks(target, blocks, text);
  }

  private async renderConfirm(
    target: SurfaceTarget,
    p: ConfirmPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const blocks: SlackBlock[] = [
      this.sectionBlock(text),
    ];

    const buttons: SlackButtonElement[] = [
      {
        type: "button",
        text: { type: "plain_text", text: p.confirmLabel, emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "yes"),
        value: "yes",
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: p.denyLabel, emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "no"),
        value: "no",
        style: "danger",
      },
    ];

    if (p.includeBack) {
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "← Back", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__back__"),
        value: "__back__",
      });
    }
    if (p.includeCancel) {
      buttons.push({
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__cancel__"),
        value: "__cancel__",
      });
    }

    blocks.push({
      type: "actions",
      block_id: "confirm_actions",
      elements: buttons,
    });

    return this.postBlocks(target, blocks, text);
  }

  private async renderTextInput(
    target: SurfaceTarget,
    p: TextInputPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);

    // If we have a trigger_id (from an interaction), open a modal
    const rawTarget = target as SurfaceTarget & { triggerId?: string };
    if (rawTarget.triggerId) {
      return this.openTextInputModal(target, p, ctx, rawTarget.triggerId);
    }

    // Fallback: post a message asking for threaded reply
    const blocks: SlackBlock[] = [
      this.sectionBlock(text),
    ];

    if (p.validation) {
      const hints: string[] = [];
      if (p.validation.minLength) hints.push(`min ${p.validation.minLength} chars`);
      if (p.validation.maxLength) hints.push(`max ${p.validation.maxLength} chars`);
      if (hints.length) {
        blocks.push(this.contextBlock(`_(${hints.join(", ")})_`));
      }
    }

    blocks.push(this.contextBlock("Reply in this thread with your answer."));

    // Add meta buttons
    const metaButtons: SlackButtonElement[] = [];
    if (p.includeBack) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "← Back", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__back__"),
        value: "__back__",
      });
    }
    if (p.includeCancel) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__cancel__"),
        value: "__cancel__",
      });
    }
    if (metaButtons.length > 0) {
      blocks.push({
        type: "actions",
        block_id: "meta_actions",
        elements: metaButtons,
      });
    }

    return this.postBlocks(target, blocks, text);
  }

  private async openTextInputModal(
    target: SurfaceTarget,
    p: TextInputPrimitive,
    ctx: RenderContext,
    triggerId: string,
  ): Promise<RenderedMessage> {
    const metadata = JSON.stringify({
      workflowId: ctx.workflowId,
      stepId: ctx.stepId,
      channelId: target.channelId ?? target.surfaceUserId,
      threadTs: target.threadId,
    });

    const view: SlackModalView = {
      type: "modal",
      callback_id: `wf_modal:${ctx.workflowId}:${ctx.stepId}`,
      title: { type: "plain_text", text: "Input Required", emoji: true },
      submit: { type: "plain_text", text: "Submit", emoji: true },
      close: { type: "plain_text", text: "Cancel", emoji: true },
      private_metadata: metadata,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: p.content },
        },
        {
          type: "input",
          block_id: "input_block",
          label: { type: "plain_text", text: "Your answer", emoji: true },
          element: {
            type: "plain_text_input",
            action_id: "text_input",
            placeholder: p.placeholder
              ? { type: "plain_text", text: p.placeholder, emoji: true }
              : undefined,
            min_length: p.validation?.minLength,
            max_length: p.validation?.maxLength,
          },
        },
      ],
    };

    const result = await this.provider.viewsOpen({ trigger_id: triggerId, view });
    return { messageId: `modal:${result.view.id}`, usedFallback: false };
  }

  private async renderInfo(
    target: SurfaceTarget,
    p: InfoPrimitive,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const chunks = this.splitText(text);
    let lastTs = "";

    for (const chunk of chunks) {
      const blocks: SlackBlock[] = [this.sectionBlock(chunk)];
      const result = await this.provider.postMessage({
        channel: target.channelId ?? target.surfaceUserId,
        blocks,
        text: chunk,
        thread_ts: target.threadId,
      });
      lastTs = result.ts;
    }

    return { messageId: lastTs, usedFallback: false };
  }

  private async renderMedia(
    target: SurfaceTarget,
    p: MediaPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const channel = target.channelId ?? target.surfaceUserId;
    const text = this.formatText(p.content, p.progress);
    const source = p.mediaUrl ?? p.mediaPath ?? "";

    const result = await this.provider.filesUpload({
      channels: channel,
      source,
      initial_comment: text,
      thread_ts: target.threadId,
    });

    // If we need meta buttons, post them as a follow-up
    const metaButtons: SlackButtonElement[] = [];
    if (p.includeBack) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "← Back", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__back__"),
        value: "__back__",
      });
    }
    if (p.includeCancel) {
      metaButtons.push({
        type: "button",
        text: { type: "plain_text", text: "Cancel", emoji: true },
        action_id: encodeActionId(ctx.workflowId, ctx.stepId, "__cancel__"),
        value: "__cancel__",
      });
    }

    if (metaButtons.length > 0) {
      const btnResult = await this.provider.postMessage({
        channel,
        blocks: [{ type: "actions", block_id: "meta_actions", elements: metaButtons }],
        text: "",
        thread_ts: target.threadId,
      });
      return { messageId: btnResult.ts, usedFallback: false };
    }

    return { messageId: `file:${result.file.id}`, usedFallback: false };
  }

  // ─── Parse Action ───────────────────────────────────────────────────

  parseAction(rawEvent: unknown): ParsedUserAction | null {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const ev = rawEvent as Record<string, unknown>;

    // block_actions payload (button click, checkbox change)
    if (ev.type === "block_actions") {
      const actions = ev.actions as Array<Record<string, unknown>> | undefined;
      if (!actions?.length) return null;

      const action = actions[0];
      const actionIdStr = String(action.action_id ?? "");
      const decoded = decodeActionId(actionIdStr);
      if (!decoded) return null;

      const surface: SurfaceTarget = {
        surfaceId: "slack",
        surfaceUserId: String(ev.userId ?? ""),
        channelId: ev.channelId != null ? String(ev.channelId) : undefined,
        threadId: ev.threadTs != null ? String(ev.threadTs) : undefined,
      };

      // Meta-actions
      if (decoded.actionId === "__cancel__") {
        return { kind: "cancel", workflowId: decoded.workflowId, stepId: decoded.stepId, surface, rawEvent };
      }
      if (decoded.actionId === "__back__") {
        return { kind: "back", workflowId: decoded.workflowId, stepId: decoded.stepId, surface, rawEvent };
      }

      // Checkboxes — multi-select
      if (action.type === "checkboxes") {
        const selectedOptions = action.selected_options as Array<{ value: string }> | undefined;
        const values = selectedOptions?.map((o) => o.value) ?? [];
        return {
          kind: "selection",
          value: values,
          workflowId: decoded.workflowId,
          stepId: decoded.stepId,
          surface,
          rawEvent,
        };
      }

      // Button press
      return {
        kind: "selection",
        value: decoded.actionId,
        workflowId: decoded.workflowId,
        stepId: decoded.stepId,
        surface,
        rawEvent,
      };
    }

    // view_submission payload (modal form)
    if (ev.type === "view_submission") {
      const view = ev.view as Record<string, unknown> | undefined;
      if (!view) return null;

      const callbackId = String(view.callback_id ?? "");
      const match = callbackId.match(/^wf_modal:([^:]+):(.+)$/);
      if (!match) return null;

      const workflowId = match[1];
      const stepId = match[2];

      // Extract text input value
      const stateValues = (view.state as Record<string, unknown>)?.values as Record<string, Record<string, Record<string, unknown>>> | undefined;
      const inputValue = stateValues?.input_block?.text_input?.value as string | undefined;

      // Parse metadata for surface info
      let channelId: string | undefined;
      let threadTs: string | undefined;
      try {
        const meta = JSON.parse(String(view.private_metadata ?? "{}"));
        channelId = meta.channelId;
        threadTs = meta.threadTs;
      } catch { /* ignore */ }

      const surface: SurfaceTarget = {
        surfaceId: "slack",
        surfaceUserId: String(ev.userId ?? ""),
        channelId,
        threadId: threadTs,
      };

      return {
        kind: "text",
        text: inputValue ?? "",
        workflowId,
        stepId,
        surface,
        rawEvent,
      };
    }

    // Text message (threaded reply for text-input)
    if (ev.type === "message" && typeof ev.text === "string") {
      const surface: SurfaceTarget = {
        surfaceId: "slack",
        surfaceUserId: String(ev.userId ?? ""),
        channelId: ev.channelId != null ? String(ev.channelId) : undefined,
        threadId: ev.threadTs != null ? String(ev.threadTs) : undefined,
      };

      const text = (ev.text as string).trim();
      const lower = text.toLowerCase();

      if (lower === "cancel" || lower === "/cancel") {
        return {
          kind: "cancel",
          workflowId: String(ev.workflowId ?? ""),
          stepId: String(ev.stepId ?? ""),
          surface,
          rawEvent,
        };
      }
      if (lower === "back" || lower === "/back") {
        return {
          kind: "back",
          workflowId: String(ev.workflowId ?? ""),
          stepId: String(ev.stepId ?? ""),
          surface,
          rawEvent,
        };
      }

      return {
        kind: "text",
        text,
        workflowId: String(ev.workflowId ?? ""),
        stepId: String(ev.stepId ?? ""),
        surface,
        rawEvent,
      };
    }

    return null;
  }

  // ─── Message Operations ─────────────────────────────────────────────

  async sendMessage(
    target: SurfaceTarget,
    message: MessagePayload,
  ): Promise<SendResult> {
    const channel = target.channelId ?? target.surfaceUserId;
    const text = message.richText ?? message.text ?? "";

    if (message.media) {
      const result = await this.provider.filesUpload({
        channels: channel,
        source: message.media.url ?? message.media.path ?? "",
        initial_comment: text || message.media.caption,
        thread_ts: target.threadId,
      });
      return { messageId: `file:${result.file.id}` };
    }

    const blocks: SlackBlock[] = [];
    if (text) {
      blocks.push(this.sectionBlock(text));
    }

    // Build actions from buttons
    if (message.buttons?.length) {
      const allButtons: SlackButtonElement[] = [];
      for (const row of message.buttons) {
        for (const btn of row) {
          allButtons.push({
            type: "button",
            text: { type: "plain_text", text: btn.text, emoji: true },
            action_id: btn.callbackData,
            value: btn.callbackData,
            style: btn.style === "danger" ? "danger" : btn.style === "primary" || btn.style === "success" ? "primary" : undefined,
          });
        }
      }
      for (let i = 0; i < allButtons.length; i += MAX_ELEMENTS_PER_ACTION) {
        blocks.push({
          type: "actions",
          elements: allButtons.slice(i, i + MAX_ELEMENTS_PER_ACTION),
        });
      }
    }

    const result = await this.provider.postMessage({
      channel,
      blocks: blocks.length > 0 ? blocks : [this.sectionBlock(text)],
      text,
      thread_ts: target.threadId,
    });
    return { messageId: result.ts };
  }

  async updateMessage(
    target: SurfaceTarget,
    messageId: string,
    updated: MessagePayload,
  ): Promise<void> {
    const channel = target.channelId ?? target.surfaceUserId;

    // Can't update modals or file messages via chat.update
    if (messageId.startsWith("modal:") || messageId.startsWith("file:")) return;

    const text = updated.richText ?? updated.text ?? "";
    const blocks: SlackBlock[] = [];

    if (text) {
      blocks.push(this.sectionBlock(text));
    }

    if (updated.buttons?.length) {
      const allButtons: SlackButtonElement[] = [];
      for (const row of updated.buttons) {
        for (const btn of row) {
          allButtons.push({
            type: "button",
            text: { type: "plain_text", text: btn.text, emoji: true },
            action_id: btn.callbackData,
            value: btn.callbackData,
          });
        }
      }
      for (let i = 0; i < allButtons.length; i += MAX_ELEMENTS_PER_ACTION) {
        blocks.push({
          type: "actions",
          elements: allButtons.slice(i, i + MAX_ELEMENTS_PER_ACTION),
        });
      }
    }

    await this.provider.chatUpdate({
      channel,
      ts: messageId,
      blocks: blocks.length > 0 ? blocks : undefined,
      text,
    });
  }

  async deleteMessage(
    target: SurfaceTarget,
    messageId: string,
  ): Promise<void> {
    if (messageId.startsWith("modal:") || messageId.startsWith("file:")) return;
    const channel = target.channelId ?? target.surfaceUserId;
    await this.provider.chatDelete(channel, messageId);
  }

  async acknowledgeAction(
    rawEvent: unknown,
    text?: string,
  ): Promise<void> {
    if (!rawEvent || typeof rawEvent !== "object") return;
    const ev = rawEvent as Record<string, unknown>;

    // For Slack block_actions, send an ephemeral ack if text is provided
    if ((ev.type === "block_actions" || ev.type === "view_submission") && text) {
      const channelId = ev.channelId as string | undefined;
      const userId = ev.userId as string | undefined;
      if (channelId && userId) {
        await this.provider.postEphemeral({
          channel: channelId,
          user: userId,
          text,
          thread_ts: ev.threadTs as string | undefined,
        });
      }
    }
    // Slack interactions are acknowledged via HTTP 200, which is handled at the HTTP layer.
    // This method handles the optional visible acknowledgment.
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private formatText(
    content: string,
    progress?: { current: number; total: number },
  ): string {
    const parts: string[] = [];
    if (progress) {
      parts.push(`*Step ${progress.current} of ${progress.total}*`);
      parts.push("");
    }
    parts.push(content);
    return parts.join("\n");
  }

  private sectionBlock(text: string): SlackBlock {
    // Enforce 3000 char limit per section; truncate if needed
    const truncated = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + "..."
      : text;
    return {
      type: "section",
      text: { type: "mrkdwn", text: truncated },
    };
  }

  private contextBlock(text: string): SlackBlock {
    return {
      type: "context",
      elements: [{ type: "mrkdwn", text }],
    };
  }

  private splitText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH / 2) splitAt = MAX_MESSAGE_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
  }

  private async postBlocks(
    target: SurfaceTarget,
    blocks: SlackBlock[],
    fallbackText: string,
  ): Promise<RenderedMessage> {
    const result = await this.provider.postMessage({
      channel: target.channelId ?? target.surfaceUserId,
      blocks: blocks.slice(0, MAX_BLOCKS_PER_MESSAGE),
      text: fallbackText,
      thread_ts: target.threadId,
    });
    return { messageId: result.ts, usedFallback: false };
  }
}

export { encodeActionId, decodeActionId };
