/**
 * T-020/T-021/T-022: Telegram Surface Adapter
 *
 * Maps abstract interaction primitives to Telegram inline keyboards/messages.
 * Handles edge cases: callback timeout, message age, button chunking, message splitting, rate limiting.
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

// ─── Telegram API abstraction ───────────────────────────────────────────────

/** Button in an inline keyboard row */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** Outbound message sent via the Telegram API */
export interface TelegramOutboundMessage {
  chat_id: string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

/** Outbound media message */
export interface TelegramOutboundMedia {
  chat_id: string;
  caption?: string;
  parse_mode?: "MarkdownV2" | "HTML";
  /** URL or file path */
  source: string;
  mediaType: "photo" | "document" | "voice";
  reply_markup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

/** Edit message markup request */
export interface TelegramEditMarkup {
  chat_id: string;
  message_id: string;
  reply_markup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

/** Edit message text request */
export interface TelegramEditText {
  chat_id: string;
  message_id: string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  reply_markup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

/** Answer callback query request */
export interface TelegramAnswerCallback {
  callback_query_id: string;
  text?: string;
}

/** Injected Telegram API provider */
export interface TelegramProvider {
  sendMessage(msg: TelegramOutboundMessage): Promise<{ message_id: string }>;
  sendMedia(msg: TelegramOutboundMedia): Promise<{ message_id: string }>;
  editMessageText(msg: TelegramEditText): Promise<void>;
  editMessageReplyMarkup(msg: TelegramEditMarkup): Promise<void>;
  deleteMessage(chat_id: string, message_id: string): Promise<void>;
  answerCallbackQuery(msg: TelegramAnswerCallback): Promise<void>;
}

// ─── Callback data encoding ─────────────────────────────────────────────────

/** Encode workflow action into callback_data (max 64 bytes for Telegram) */
function encodeCallbackData(
  workflowId: string,
  stepId: string,
  actionId: string,
): string {
  // Format: wf:<workflowId>|s:<stepId>|a:<actionId>
  // Truncate if needed to fit 64 bytes
  const data = `wf:${workflowId}|s:${stepId}|a:${actionId}`;
  return data.length <= 64 ? data : data.slice(0, 64);
}

/** Decode callback_data back into components */
function decodeCallbackData(
  data: string,
): { workflowId: string; stepId: string; actionId: string } | null {
  const wfMatch = data.match(/^wf:([^|]+)\|s:([^|]+)\|a:(.+)$/);
  if (!wfMatch) {return null;}
  return {
    workflowId: wfMatch[1],
    stepId: wfMatch[2],
    actionId: wfMatch[3],
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BUTTONS_PER_ROW = 8;
const MAX_BUTTON_ROWS = 10;
const MAX_MESSAGE_LENGTH = 4096;
const MESSAGE_EDIT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

// ─── Adapter ────────────────────────────────────────────────────────────────

export class TelegramAdapter implements SurfaceAdapter {
  readonly surfaceId: string;
  readonly version = "1.0.0";
  readonly capabilities: SurfaceCapabilities = {
    inlineButtons: true,
    multiSelectButtons: false, // simulated via toggle
    reactions: true,
    messageEffects: true,
    fileUpload: true,
    voiceMessages: true,
    threading: true,
    richText: true,
    modals: false,
    maxButtonsPerRow: MAX_BUTTONS_PER_ROW,
    maxButtonRows: MAX_BUTTON_ROWS,
    maxMessageLength: MAX_MESSAGE_LENGTH,
  };

  private provider: TelegramProvider;
  /** Track message timestamps for edit-age checks */
  private messageTimestamps: Map<string, number> = new Map();

  constructor(provider: TelegramProvider, surfaceId = "telegram") {
    this.provider = provider;
    this.surfaceId = surfaceId;
  }

  // ─── Render ─────────────────────────────────────────────────────────

  async render(
    target: SurfaceTarget,
    primitive: InteractionPrimitive,
    context: RenderContext,
  ): Promise<RenderedMessage> {
    const chatId = target.channelId ?? target.surfaceUserId;

    switch (primitive.type) {
      case "choice":
        return this.renderChoice(chatId, primitive, context);
      case "multi-choice":
        return this.renderMultiChoice(chatId, primitive, context);
      case "confirm":
        return this.renderConfirm(chatId, primitive, context);
      case "text-input":
        return this.renderTextInput(chatId, primitive, context);
      case "info":
        return this.renderInfo(chatId, primitive);
      case "media":
        return this.renderMedia(chatId, primitive, context);
    }
  }

  private async renderChoice(
    chatId: string,
    p: ChoicePrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const keyboard = this.buildOptionButtons(
      p.options.map((o) => ({ text: o.label, data: encodeCallbackData(ctx.workflowId, ctx.stepId, o.id) })),
      p.includeBack,
      p.includeCancel,
      ctx,
    );
    return this.sendWithKeyboard(chatId, text, keyboard);
  }

  private async renderMultiChoice(
    chatId: string,
    p: MultiChoicePrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(
      `${p.content}\n\n_Select options, then tap "${p.submitLabel ?? "Confirm"}"._`,
      p.progress,
    );
    const buttons: Array<{ text: string; data: string }> = p.options.map((o) => ({
      text: o.label,
      data: encodeCallbackData(ctx.workflowId, ctx.stepId, `toggle:${o.id}`),
    }));
    // Add submit button
    buttons.push({
      text: `✅ ${p.submitLabel ?? "Confirm"}`,
      data: encodeCallbackData(ctx.workflowId, ctx.stepId, "submit"),
    });
    const keyboard = this.buildOptionButtons(buttons, p.includeBack, p.includeCancel, ctx);
    return this.sendWithKeyboard(chatId, text, keyboard);
  }

  private async renderConfirm(
    chatId: string,
    p: ConfirmPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const buttons: Array<{ text: string; data: string }> = [
      { text: p.confirmLabel, data: encodeCallbackData(ctx.workflowId, ctx.stepId, "yes") },
      { text: p.denyLabel, data: encodeCallbackData(ctx.workflowId, ctx.stepId, "no") },
    ];
    const keyboard = this.buildOptionButtons(buttons, p.includeBack, p.includeCancel, ctx);
    return this.sendWithKeyboard(chatId, text, keyboard);
  }

  private async renderTextInput(
    chatId: string,
    p: TextInputPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    let text = this.formatText(p.content, p.progress);
    if (p.validation) {
      const hints: string[] = [];
      if (p.validation.minLength) {hints.push(`min ${p.validation.minLength} chars`);}
      if (p.validation.maxLength) {hints.push(`max ${p.validation.maxLength} chars`);}
      if (hints.length) {text += `\n_(${hints.join(", ")})_`;}
    }
    // Text input has only back/cancel buttons (user types a reply)
    const metaButtons: Array<{ text: string; data: string }> = [];
    const keyboard = this.buildOptionButtons(metaButtons, p.includeBack, p.includeCancel, ctx);
    if (keyboard.length > 0) {
      return this.sendWithKeyboard(chatId, text, keyboard);
    }
    const result = await this.provider.sendMessage({ chat_id: chatId, text });
    this.messageTimestamps.set(result.message_id, Date.now());
    return { messageId: result.message_id, usedFallback: false };
  }

  private async renderInfo(
    chatId: string,
    p: InfoPrimitive,
  ): Promise<RenderedMessage> {
    const text = this.formatText(p.content, p.progress);
    const chunks = this.splitMessage(text);
    let lastId = "";
    for (const chunk of chunks) {
      const result = await this.provider.sendMessage({ chat_id: chatId, text: chunk });
      lastId = result.message_id;
      this.messageTimestamps.set(lastId, Date.now());
    }
    return { messageId: lastId, usedFallback: false };
  }

  private async renderMedia(
    chatId: string,
    p: MediaPrimitive,
    ctx: RenderContext,
  ): Promise<RenderedMessage> {
    const source = p.mediaUrl ?? p.mediaPath ?? "";
    const mediaType = p.mediaType === "image" ? "photo" as const
      : p.mediaType === "voice" ? "voice" as const
      : "document" as const;

    const metaButtons: Array<{ text: string; data: string }> = [];
    const keyboard = this.buildOptionButtons(metaButtons, p.includeBack, p.includeCancel, ctx);

    const result = await this.provider.sendMedia({
      chat_id: chatId,
      caption: this.formatText(p.content, p.progress),
      source,
      mediaType,
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    });
    this.messageTimestamps.set(result.message_id, Date.now());
    return { messageId: result.message_id, usedFallback: false };
  }

  // ─── Parse Action ───────────────────────────────────────────────────

  parseAction(rawEvent: unknown): ParsedUserAction | null {
    if (!rawEvent || typeof rawEvent !== "object") {return null;}
    const ev = rawEvent as Record<string, unknown>;

    // Callback query (button press)
    if (ev.type === "callback_query" && typeof ev.data === "string") {
      const decoded = decodeCallbackData(ev.data);
      if (!decoded) {return null;}

      const surface: SurfaceTarget = {
        surfaceId: "telegram",
        surfaceUserId: String(ev.userId ?? ""),
        channelId: ev.chatId != null ? String(ev.chatId) : undefined,
      };

      // Meta-actions
      if (decoded.actionId === "__cancel__") {
        return { kind: "cancel", workflowId: decoded.workflowId, stepId: decoded.stepId, surface, rawEvent };
      }
      if (decoded.actionId === "__back__") {
        return { kind: "back", workflowId: decoded.workflowId, stepId: decoded.stepId, surface, rawEvent };
      }

      return {
        kind: "selection",
        value: decoded.actionId,
        workflowId: decoded.workflowId,
        stepId: decoded.stepId,
        surface,
        rawEvent,
      };
    }

    // Text reply (for text-input steps)
    if (ev.type === "text_message" && typeof ev.text === "string") {
      const surface: SurfaceTarget = {
        surfaceId: "telegram",
        surfaceUserId: String(ev.userId ?? ""),
        channelId: ev.chatId != null ? String(ev.chatId) : undefined,
      };

      const text = (ev.text).trim();
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
    const chatId = target.channelId ?? target.surfaceUserId;
    const text = message.richText ?? message.text ?? "";

    if (message.media) {
      const mediaType = message.media.type === "image" ? "photo" as const
        : message.media.type === "voice" ? "voice" as const
        : "document" as const;
      const result = await this.provider.sendMedia({
        chat_id: chatId,
        caption: text || message.media.caption,
        source: message.media.url ?? message.media.path ?? "",
        mediaType,
      });
      return { messageId: result.message_id };
    }

    // Build inline keyboard from buttons if provided
    let reply_markup: TelegramOutboundMessage["reply_markup"];
    if (message.buttons?.length) {
      reply_markup = {
        inline_keyboard: message.buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      };
    }

    const chunks = this.splitMessage(text);
    let lastId = "";
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const result = await this.provider.sendMessage({
        chat_id: chatId,
        text: chunks[i],
        reply_markup: isLast ? reply_markup : undefined,
      });
      lastId = result.message_id;
    }
    return { messageId: lastId };
  }

  async updateMessage(
    target: SurfaceTarget,
    messageId: string,
    updated: MessagePayload,
  ): Promise<void> {
    const chatId = target.channelId ?? target.surfaceUserId;

    // Check message age — can't edit messages older than 48h
    const ts = this.messageTimestamps.get(messageId);
    if (ts && Date.now() - ts > MESSAGE_EDIT_MAX_AGE_MS) {
      // Send a new message instead
      if (updated.text || updated.richText) {
        await this.provider.sendMessage({
          chat_id: chatId,
          text: updated.richText ?? updated.text ?? "",
        });
      }
      return;
    }

    const text = updated.richText ?? updated.text;
    let reply_markup: TelegramEditText["reply_markup"];
    if (updated.buttons?.length) {
      reply_markup = {
        inline_keyboard: updated.buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      };
    }

    if (text) {
      await this.provider.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup,
      });
    } else {
      // Just remove/update buttons
      await this.provider.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup,
      });
    }
  }

  async deleteMessage(
    target: SurfaceTarget,
    messageId: string,
  ): Promise<void> {
    const chatId = target.channelId ?? target.surfaceUserId;
    await this.provider.deleteMessage(chatId, messageId);
    this.messageTimestamps.delete(messageId);
  }

  async acknowledgeAction(
    rawEvent: unknown,
    text?: string,
  ): Promise<void> {
    if (!rawEvent || typeof rawEvent !== "object") {return;}
    const ev = rawEvent as Record<string, unknown>;
    if (ev.type === "callback_query" && typeof ev.callbackQueryId === "string") {
      await this.provider.answerCallbackQuery({
        callback_query_id: ev.callbackQueryId,
        text,
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private formatText(
    content: string,
    progress?: { current: number; total: number },
  ): string {
    const parts: string[] = [];
    if (progress) {
      parts.push(`Step ${progress.current} of ${progress.total}`);
      parts.push("");
    }
    parts.push(content);
    return parts.join("\n");
  }

  /** Build inline keyboard with option buttons + meta-action row */
  private buildOptionButtons(
    options: Array<{ text: string; data: string }>,
    includeBack: boolean,
    includeCancel: boolean,
    ctx: RenderContext,
  ): TelegramInlineButton[][] {
    const rows: TelegramInlineButton[][] = [];

    // Chunk option buttons into rows respecting max per row
    for (let i = 0; i < options.length; i += MAX_BUTTONS_PER_ROW) {
      const chunk = options.slice(i, i + MAX_BUTTONS_PER_ROW);
      rows.push(chunk.map((o) => ({ text: o.text, callback_data: o.data })));
      if (rows.length >= MAX_BUTTON_ROWS - 1) {break;} // Reserve last row for meta
    }

    // Meta-action row
    const metaRow: TelegramInlineButton[] = [];
    if (includeBack) {
      metaRow.push({
        text: "← Back",
        callback_data: encodeCallbackData(ctx.workflowId, ctx.stepId, "__back__"),
      });
    }
    if (includeCancel) {
      metaRow.push({
        text: "Cancel",
        callback_data: encodeCallbackData(ctx.workflowId, ctx.stepId, "__cancel__"),
      });
    }
    if (metaRow.length > 0 && rows.length < MAX_BUTTON_ROWS) {
      rows.push(metaRow);
    }

    return rows;
  }

  /** Split message into chunks respecting max length */
  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) {return [text];}
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH / 2) {splitAt = MAX_MESSAGE_LENGTH;}
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    keyboard: TelegramInlineButton[][],
  ): Promise<RenderedMessage> {
    const result = await this.provider.sendMessage({
      chat_id: chatId,
      text,
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    });
    this.messageTimestamps.set(result.message_id, Date.now());
    return { messageId: result.message_id, usedFallback: false };
  }
}

// Re-export for convenience
export { encodeCallbackData, decodeCallbackData };
