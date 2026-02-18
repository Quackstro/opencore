/**
 * T-001: Abstract Interaction Primitives
 *
 * Minimal set of primitives covering all existing plugin workflows:
 * choice, multi-choice, confirm, text-input, info, media.
 *
 * Source of truth: specs/channel-abstraction/contracts/surface-adapter.ts
 */

// ─── Button / Option styles ─────────────────────────────────────────────────

export type ButtonStyle = "primary" | "success" | "danger";

// ─── Shared sub-types ───────────────────────────────────────────────────────

export interface PrimitiveOption {
  /** Unique option identifier (used in transitions and callback data) */
  id: string;
  /** Display label */
  label: string;
  /** Optional description (rendered on surfaces that support it) */
  description?: string;
  /** Visual style hint */
  style?: ButtonStyle;
}

export interface StepProgress {
  current: number;
  total: number;
}

export interface ValidationRule {
  minLength?: number;
  maxLength?: number;
  /** Regex pattern the input must match */
  pattern?: string;
  /** Custom error message on validation failure */
  errorMessage?: string;
}

// ─── Primitive types ────────────────────────────────────────────────────────

export interface ChoicePrimitive {
  readonly type: "choice";
  content: string;
  /** Max 7 options (Miller's Law) */
  options: PrimitiveOption[];
  includeBack: boolean;
  includeCancel: boolean;
  progress?: StepProgress;
}

export interface MultiChoicePrimitive {
  readonly type: "multi-choice";
  content: string;
  /** Max 7 options (Miller's Law) */
  options: PrimitiveOption[];
  minSelections?: number;
  maxSelections?: number;
  submitLabel?: string;
  includeBack: boolean;
  includeCancel: boolean;
  progress?: StepProgress;
}

export interface ConfirmPrimitive {
  readonly type: "confirm";
  content: string;
  confirmLabel: string;
  denyLabel: string;
  includeBack: boolean;
  includeCancel: boolean;
  progress?: StepProgress;
}

export interface TextInputPrimitive {
  readonly type: "text-input";
  content: string;
  placeholder?: string;
  validation?: ValidationRule;
  includeBack: boolean;
  includeCancel: boolean;
  progress?: StepProgress;
}

export interface InfoPrimitive {
  readonly type: "info";
  content: string;
  terminal?: boolean;
  progress?: StepProgress;
}

export interface MediaPrimitive {
  readonly type: "media";
  content: string;
  mediaType: "image" | "file" | "voice";
  mediaUrl?: string;
  mediaPath?: string;
  mimeType?: string;
  includeBack: boolean;
  includeCancel: boolean;
  progress?: StepProgress;
}

// ─── Union type ─────────────────────────────────────────────────────────────

export type InteractionPrimitive =
  | ChoicePrimitive
  | MultiChoicePrimitive
  | ConfirmPrimitive
  | TextInputPrimitive
  | InfoPrimitive
  | MediaPrimitive;

// ─── Meta-actions ───────────────────────────────────────────────────────────

export type MetaAction = "cancel" | "back";
