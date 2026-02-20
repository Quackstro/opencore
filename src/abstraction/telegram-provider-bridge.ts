/**
 * Bridge from Grammy's Bot API to the abstraction layer's TelegramProvider.
 *
 * Wraps bot.api.* calls into the TelegramProvider interface expected by
 * TelegramAdapter. Created once after the Telegram bot is initialized.
 */

import type {
  TelegramProvider,
  TelegramOutboundMessage,
  TelegramOutboundMedia,
  TelegramEditText,
  TelegramEditMarkup,
  TelegramAnswerCallback,
} from "./adapters/telegram/telegram-adapter.js";

/**
 * Minimal Bot API surface we need. Avoids importing Grammy types directly.
 */
export interface BotApiLike {
  sendMessage(
    chatId: string | number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendPhoto(
    chatId: string | number,
    photo: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: string | number,
    document: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendVoice(
    chatId: string | number,
    voice: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  editMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, other?: Record<string, unknown>): Promise<unknown>;
}

export function createTelegramProviderBridge(api: BotApiLike): TelegramProvider {
  return {
    async sendMessage(msg: TelegramOutboundMessage) {
      const other: Record<string, unknown> = {};
      if (msg.parse_mode) {
        other.parse_mode = msg.parse_mode;
      }
      if (msg.reply_markup) {
        other.reply_markup = msg.reply_markup;
      }
      const result = await api.sendMessage(msg.chat_id, msg.text, other);
      return { message_id: String(result.message_id) };
    },

    async sendMedia(msg: TelegramOutboundMedia) {
      const other: Record<string, unknown> = {};
      if (msg.caption) {
        other.caption = msg.caption;
      }
      if (msg.parse_mode) {
        other.parse_mode = msg.parse_mode;
      }
      if (msg.reply_markup) {
        other.reply_markup = msg.reply_markup;
      }

      let result: { message_id: number };
      switch (msg.mediaType) {
        case "photo":
          result = await api.sendPhoto(msg.chat_id, msg.source, other);
          break;
        case "voice":
          result = await api.sendVoice(msg.chat_id, msg.source, other);
          break;
        case "document":
        default:
          result = await api.sendDocument(msg.chat_id, msg.source, other);
          break;
      }
      return { message_id: String(result.message_id) };
    },

    async editMessageText(msg: TelegramEditText) {
      const other: Record<string, unknown> = {};
      if (msg.parse_mode) {
        other.parse_mode = msg.parse_mode;
      }
      if (msg.reply_markup) {
        other.reply_markup = msg.reply_markup;
      }
      await api.editMessageText(msg.chat_id, Number(msg.message_id), msg.text, other);
    },

    async editMessageReplyMarkup(msg: TelegramEditMarkup) {
      const other: Record<string, unknown> = {};
      if (msg.reply_markup) {
        other.reply_markup = msg.reply_markup;
      }
      await api.editMessageReplyMarkup(msg.chat_id, Number(msg.message_id), other);
    },

    async deleteMessage(chatId: string, messageId: string) {
      await api.deleteMessage(chatId, Number(messageId));
    },

    async answerCallbackQuery(msg: TelegramAnswerCallback) {
      const other: Record<string, unknown> = {};
      if (msg.text) {
        other.text = msg.text;
      }
      await api.answerCallbackQuery(msg.callback_query_id, other);
    },
  };
}
