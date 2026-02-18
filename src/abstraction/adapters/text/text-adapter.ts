/**
 * T-011: Text-Only Surface Adapter (Universal Baseline)
 *
 * Renders all primitives as plain text.
 * Every surface degrades to this as a fallback.
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
import type { InteractionPrimitive } from "../../primitives.js";

let msgCounter = 0;

/** Callback to actually deliver text. Injected by the host. */
export type TextSendFn = (
  target: SurfaceTarget,
  text: string,
) => Promise<{ messageId: string }>;

export class TextOnlyAdapter implements SurfaceAdapter {
  readonly surfaceId = "text";
  readonly version = "1.0.0";
  readonly capabilities: SurfaceCapabilities = {
    inlineButtons: false,
    multiSelectButtons: false,
    reactions: false,
    messageEffects: false,
    fileUpload: false,
    voiceMessages: false,
    threading: false,
    richText: false,
    modals: false,
    maxButtonsPerRow: 0,
    maxButtonRows: 0,
    maxMessageLength: Number.MAX_SAFE_INTEGER,
  };

  private sendFn: TextSendFn;

  constructor(sendFn: TextSendFn) {
    this.sendFn = sendFn;
  }

  async render(
    target: SurfaceTarget,
    primitive: InteractionPrimitive,
    context: RenderContext,
  ): Promise<RenderedMessage> {
    const text = this.renderPrimitiveToText(primitive);
    const result = await this.sendFn(target, text);
    return { messageId: result.messageId, usedFallback: false };
  }

  parseAction(rawEvent: unknown): ParsedUserAction | null {
    if (
      !rawEvent ||
      typeof rawEvent !== "object" ||
      !("text" in rawEvent) ||
      !("workflowId" in rawEvent) ||
      !("stepId" in rawEvent) ||
      !("surface" in rawEvent) ||
      !("stepType" in rawEvent)
    ) {
      return null;
    }

    const ev = rawEvent as {
      text: string;
      workflowId: string;
      stepId: string;
      surface: SurfaceTarget;
      stepType: string;
      options?: { id: string }[];
    };

    const input = ev.text.trim();
    const lower = input.toLowerCase();

    // Meta-actions
    if (lower === "cancel") {
      return {
        kind: "cancel",
        workflowId: ev.workflowId,
        stepId: ev.stepId,
        surface: ev.surface,
        rawEvent,
      };
    }
    if (lower === "back") {
      return {
        kind: "back",
        workflowId: ev.workflowId,
        stepId: ev.stepId,
        surface: ev.surface,
        rawEvent,
      };
    }

    // Confirm: yes/no
    if (ev.stepType === "confirm") {
      if (/^y(es)?$/i.test(lower)) {
        return {
          kind: "selection",
          value: "yes",
          workflowId: ev.workflowId,
          stepId: ev.stepId,
          surface: ev.surface,
          rawEvent,
        };
      }
      if (/^n(o)?$/i.test(lower)) {
        return {
          kind: "selection",
          value: "no",
          workflowId: ev.workflowId,
          stepId: ev.stepId,
          surface: ev.surface,
          rawEvent,
        };
      }
    }

    // Choice: numeric
    if (ev.stepType === "choice" && ev.options) {
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= ev.options.length) {
        return {
          kind: "selection",
          value: ev.options[num - 1].id,
          workflowId: ev.workflowId,
          stepId: ev.stepId,
          surface: ev.surface,
          rawEvent,
        };
      }
    }

    // Multi-choice: comma-separated numbers
    if (ev.stepType === "multi-choice" && ev.options) {
      const parts = input.split(",").map((s) => s.trim());
      const nums = parts.map((s) => parseInt(s, 10));
      if (nums.every((n) => !isNaN(n) && n >= 1 && n <= ev.options!.length)) {
        return {
          kind: "selection",
          value: nums.map((n) => ev.options![n - 1].id),
          workflowId: ev.workflowId,
          stepId: ev.stepId,
          surface: ev.surface,
          rawEvent,
        };
      }
    }

    // Text input: any text
    if (ev.stepType === "text-input") {
      return {
        kind: "text",
        text: input,
        workflowId: ev.workflowId,
        stepId: ev.stepId,
        surface: ev.surface,
        rawEvent,
      };
    }

    // Default: treat as text
    return {
      kind: "text",
      text: input,
      workflowId: ev.workflowId,
      stepId: ev.stepId,
      surface: ev.surface,
      rawEvent,
    };
  }

  async sendMessage(
    target: SurfaceTarget,
    message: MessagePayload,
  ): Promise<SendResult> {
    const text = message.richText ?? message.text ?? "";
    const result = await this.sendFn(target, text);
    return { messageId: result.messageId };
  }

  async updateMessage(
    _target: SurfaceTarget,
    _messageId: string,
    _updated: MessagePayload,
  ): Promise<void> {
    // No-op: text surfaces can't edit messages
  }

  async deleteMessage(
    _target: SurfaceTarget,
    _messageId: string,
  ): Promise<void> {
    // No-op
  }

  async acknowledgeAction(
    _rawEvent: unknown,
    _text?: string,
  ): Promise<void> {
    // No-op
  }

  // ─── Text Rendering ───────────────────────────────────────────────────

  private renderPrimitiveToText(p: InteractionPrimitive): string {
    const parts: string[] = [];

    // Progress
    if (p.progress) {
      parts.push(`Step ${p.progress.current} of ${p.progress.total}`);
    }

    switch (p.type) {
      case "choice": {
        parts.push(p.content);
        parts.push("");
        p.options.forEach((o, i) => parts.push(`${i + 1}. ${o.label}`));
        parts.push("");
        parts.push("Reply with a number.");
        parts.push(this.metaText(p.includeBack, p.includeCancel));
        break;
      }
      case "multi-choice": {
        parts.push(p.content);
        parts.push("");
        p.options.forEach((o, i) => parts.push(`${i + 1}. ${o.label}`));
        parts.push("");
        parts.push("Reply with numbers separated by commas.");
        parts.push(this.metaText(p.includeBack, p.includeCancel));
        break;
      }
      case "confirm": {
        parts.push(p.content);
        parts.push("");
        parts.push(`1. ${p.confirmLabel}`);
        parts.push(`2. ${p.denyLabel}`);
        parts.push("");
        parts.push("Reply with a number.");
        parts.push(this.metaText(p.includeBack, p.includeCancel));
        break;
      }
      case "text-input": {
        parts.push(p.content);
        if (p.validation) {
          const hints: string[] = [];
          if (p.validation.minLength)
            {hints.push(`min ${p.validation.minLength} chars`);}
          if (p.validation.maxLength)
            {hints.push(`max ${p.validation.maxLength} chars`);}
          if (hints.length) {parts.push(`(${hints.join(", ")})`);}
        }
        parts.push("");
        parts.push("Reply with your answer.");
        parts.push(this.metaText(p.includeBack, p.includeCancel));
        break;
      }
      case "info": {
        parts.push(p.content);
        break;
      }
      case "media": {
        parts.push(p.content);
        if (p.mediaUrl) {parts.push(`📎 ${p.mediaUrl}`);}
        else if (p.mediaPath) {parts.push(`📎 [file attached]`);}
        parts.push(this.metaText(p.includeBack, p.includeCancel));
        break;
      }
    }

    return parts.filter((l) => l !== undefined).join("\n");
  }

  private metaText(back: boolean, cancel: boolean): string {
    const parts: string[] = [];
    if (cancel) {parts.push("'cancel' to exit");}
    if (back) {parts.push("'back' for previous step");}
    return parts.length > 0 ? `Type ${parts.join(", ")}.` : "";
  }
}
