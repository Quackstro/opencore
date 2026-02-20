/**
 * T-002: Surface Adapter Interface Contract
 *
 * Every surface adapter implements this interface.
 * Adapters are installable packages — community-maintained, no review gate.
 */

import type { InteractionPrimitive, PrimitiveOption } from "./primitives.js";

// ─── Surface Target ─────────────────────────────────────────────────────────

export interface SurfaceTarget {
  /** Surface identifier (must match adapter's surfaceId) */
  surfaceId: string;
  /** Platform-specific user ID */
  surfaceUserId: string;
  /** Platform-specific channel/chat ID (may differ from userId in group contexts) */
  channelId?: string;
  /** Thread ID for threaded surfaces (Slack, Discord) */
  threadId?: string;
}

// ─── Render Context ─────────────────────────────────────────────────────────

export interface RenderContext {
  workflowId: string;
  stepId: string;
  plugin: string;
  isContinuation: boolean;
  previousSurface?: string;
}

// ─── Parsed User Action ─────────────────────────────────────────────────────

export interface ParsedUserAction {
  kind: "selection" | "text" | "cancel" | "back";
  /** Selected option ID(s) */
  value?: string | string[];
  /** Raw text input */
  text?: string;
  workflowId: string;
  stepId: string;
  surface: SurfaceTarget;
  rawEvent: unknown;
}

// ─── Message Payloads ───────────────────────────────────────────────────────

export interface MessageButton {
  text: string;
  callbackData: string;
  style?: "primary" | "success" | "danger";
}

export interface MessagePayload {
  text?: string;
  richText?: string;
  buttons?: MessageButton[][];
  media?: {
    type: "image" | "file" | "voice";
    url?: string;
    path?: string;
    mimeType?: string;
    caption?: string;
  };
  replyTo?: string;
  silent?: boolean;
}

export interface RenderedMessage {
  messageId: string;
  usedFallback: boolean;
  fallbackType?: "text" | "silent-omit" | "notify-blocked";
}

export interface SendResult {
  messageId: string;
  timestamp?: string;
}

// ─── Surface Capabilities ───────────────────────────────────────────────────

export interface SurfaceCapabilities {
  inlineButtons: boolean;
  multiSelectButtons: boolean;
  reactions: boolean;
  messageEffects: boolean;
  fileUpload: boolean;
  voiceMessages: boolean;
  threading: boolean;
  richText: boolean;
  modals: boolean;
  maxButtonsPerRow: number;
  maxButtonRows: number;
  maxMessageLength: number;
}

// ─── Capability Negotiation ─────────────────────────────────────────────────

export type FallbackStrategy =
  | "native"
  | "text-fallback"
  | "silent-omit"
  | "notify-blocked";

export interface NegotiationResult {
  strategy: FallbackStrategy;
  fallbackPrimitive?: InteractionPrimitive;
  blockedReason?: string;
}

export interface CapabilityNegotiator {
  negotiate(
    primitive: InteractionPrimitive,
    capabilities: SurfaceCapabilities,
  ): NegotiationResult;
}

// ─── Surface Adapter Interface ──────────────────────────────────────────────

export interface SurfaceAdapter {
  readonly surfaceId: string;
  readonly version: string;
  readonly capabilities: SurfaceCapabilities;

  /**
   * Render an abstract interaction primitive to this surface.
   */
  render(
    target: SurfaceTarget,
    primitive: InteractionPrimitive,
    context: RenderContext,
  ): Promise<RenderedMessage>;

  /**
   * Parse a raw inbound event into a structured action.
   * Returns null if the event is not a workflow-related action.
   */
  parseAction(rawEvent: unknown): ParsedUserAction | null;

  /** Send a plain message (non-workflow). */
  sendMessage(
    target: SurfaceTarget,
    message: MessagePayload,
  ): Promise<SendResult>;

  /** Update an existing message (e.g., remove buttons after selection). */
  updateMessage(
    target: SurfaceTarget,
    messageId: string,
    updated: MessagePayload,
  ): Promise<void>;

  /** Delete a message. */
  deleteMessage(
    target: SurfaceTarget,
    messageId: string,
  ): Promise<void>;

  /** Acknowledge a user action (e.g., Telegram answerCallbackQuery). No-op if not needed. */
  acknowledgeAction(rawEvent: unknown, text?: string): Promise<void>;

  /** Optional: called once on adapter registration. */
  initialize?(): Promise<void>;

  /** Optional: called on shutdown. */
  destroy?(): Promise<void>;
}
