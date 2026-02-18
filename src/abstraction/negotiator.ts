/**
 * T-005: Capability Negotiator
 *
 * Resolves fallback hierarchy per primitive type:
 *   1. Native — surface supports the primitive natively
 *   2. Text fallback — numbered options, yes/no, etc.
 *   3. Silent omit — cosmetic only (reactions, effects)
 *   4. Notify blocked — workflow truly blocked
 */

import type {
  CapabilityNegotiator,
  FallbackStrategy,
  NegotiationResult,
  SurfaceCapabilities,
} from "./adapter.js";
import type {
  ChoicePrimitive,
  ConfirmPrimitive,
  InfoPrimitive,
  InteractionPrimitive,
  MediaPrimitive,
  MultiChoicePrimitive,
  TextInputPrimitive,
} from "./primitives.js";

export class DefaultCapabilityNegotiator implements CapabilityNegotiator {
  negotiate(
    primitive: InteractionPrimitive,
    caps: SurfaceCapabilities,
  ): NegotiationResult {
    switch (primitive.type) {
      case "choice":
        return this.negotiateChoice(primitive, caps);
      case "multi-choice":
        return this.negotiateMultiChoice(primitive, caps);
      case "confirm":
        return this.negotiateConfirm(primitive, caps);
      case "text-input":
        return this.negotiateTextInput(primitive, caps);
      case "info":
        return this.negotiateInfo(primitive, caps);
      case "media":
        return this.negotiateMedia(primitive, caps);
    }
  }

  private negotiateChoice(
    p: ChoicePrimitive,
    caps: SurfaceCapabilities,
  ): NegotiationResult {
    if (caps.inlineButtons) {
      // Check if options fit
      const totalButtons =
        p.options.length +
        (p.includeBack ? 1 : 0) +
        (p.includeCancel ? 1 : 0);
      if (totalButtons <= caps.maxButtonsPerRow * caps.maxButtonRows) {
        return { strategy: "native" };
      }
    }
    // Text fallback: numbered list
    return {
      strategy: "text-fallback",
      fallbackPrimitive: this.choiceToText(p),
    };
  }

  private negotiateMultiChoice(
    p: MultiChoicePrimitive,
    caps: SurfaceCapabilities,
  ): NegotiationResult {
    if (caps.multiSelectButtons) return { strategy: "native" };
    if (caps.inlineButtons) {
      // Can simulate with toggle buttons
      return { strategy: "native" };
    }
    return {
      strategy: "text-fallback",
      fallbackPrimitive: this.multiChoiceToText(p),
    };
  }

  private negotiateConfirm(
    p: ConfirmPrimitive,
    caps: SurfaceCapabilities,
  ): NegotiationResult {
    if (caps.inlineButtons) return { strategy: "native" };
    return {
      strategy: "text-fallback",
      fallbackPrimitive: this.confirmToText(p),
    };
  }

  private negotiateTextInput(
    _p: TextInputPrimitive,
    _caps: SurfaceCapabilities,
  ): NegotiationResult {
    // Text input always works — user just types a reply
    return { strategy: "native" };
  }

  private negotiateInfo(
    _p: InfoPrimitive,
    _caps: SurfaceCapabilities,
  ): NegotiationResult {
    // Plain text always works
    return { strategy: "native" };
  }

  private negotiateMedia(
    p: MediaPrimitive,
    caps: SurfaceCapabilities,
  ): NegotiationResult {
    if (p.mediaType === "image" || p.mediaType === "file") {
      if (caps.fileUpload) return { strategy: "native" };
      // Fallback: just send a link
      if (p.mediaUrl) {
        return {
          strategy: "text-fallback",
          fallbackPrimitive: {
            type: "info" as const,
            content: `${p.content}\n\n📎 ${p.mediaUrl}`,
            progress: p.progress,
          },
        };
      }
      return {
        strategy: "notify-blocked",
        blockedReason: `This step requires ${p.mediaType} support, which is not available on this surface.`,
      };
    }
    if (p.mediaType === "voice") {
      if (caps.voiceMessages) return { strategy: "native" };
      return {
        strategy: "notify-blocked",
        blockedReason:
          "Voice messages are not supported on this surface. Try connecting via Telegram.",
      };
    }
    return { strategy: "native" };
  }

  // ─── Text fallback primitives ─────────────────────────────────────────

  private choiceToText(p: ChoicePrimitive): InteractionPrimitive {
    const lines = p.options.map((o, i) => `${i + 1}. ${o.label}`);
    let text = `${p.content}\n\n${lines.join("\n")}\n\nReply with a number.`;
    text += this.metaActionsText(p.includeBack, p.includeCancel);
    return {
      type: "info" as const,
      content: text,
      progress: p.progress,
    };
  }

  private multiChoiceToText(p: MultiChoicePrimitive): InteractionPrimitive {
    const lines = p.options.map((o, i) => `${i + 1}. ${o.label}`);
    let text = `${p.content}\n\n${lines.join("\n")}\n\nReply with numbers separated by commas.`;
    text += this.metaActionsText(p.includeBack, p.includeCancel);
    return {
      type: "info" as const,
      content: text,
      progress: p.progress,
    };
  }

  private confirmToText(p: ConfirmPrimitive): InteractionPrimitive {
    let text = `${p.content}\n\nReply yes or no.`;
    text += this.metaActionsText(p.includeBack, p.includeCancel);
    return {
      type: "info" as const,
      content: text,
      progress: p.progress,
    };
  }

  private metaActionsText(includeBack: boolean, includeCancel: boolean): string {
    const parts: string[] = [];
    if (includeCancel) parts.push("'cancel' to exit");
    if (includeBack) parts.push("'back' for previous step");
    return parts.length > 0 ? `\nType ${parts.join(", ")}.` : "";
  }
}
