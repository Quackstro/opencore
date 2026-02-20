/**
 * T-003: Workflow Definition Types
 *
 * TypeScript types for declarative JSON workflow definitions.
 */

import type { ButtonStyle, PrimitiveOption, ValidationRule } from "../primitives.js";

// ─── Tool Call Binding ──────────────────────────────────────────────────────

export interface ToolCallBinding {
  /** Tool name to invoke */
  name: string;
  /**
   * Parameter mapping.
   * Special values:
   *   "$input"                    — current step's user input/selection
   *   "$data.<stepId>"            — data from a previous step
   *   "$data.<stepId>.selection"  — selection from a choice step
   *   "$data.<stepId>.input"      — text input from a text-input step
   * Literal strings are passed as-is.
   */
  paramMap: Record<string, string>;
  /** Step ID to transition to on tool call failure. Default: stay on current step. */
  onError?: string;
}

// ─── Workflow Step Definition ───────────────────────────────────────────────

export interface WorkflowStepDefinition {
  type: "choice" | "multi-choice" | "confirm" | "text-input" | "info" | "media";
  /** Display content. Supports {{data.<stepId>.input}} interpolation. */
  content: string;
  /** Options for choice / multi-choice steps */
  options?: PrimitiveOption[];
  /** Validation for text-input steps */
  validation?: ValidationRule;
  /** Tool call to execute when this step receives input */
  toolCall?: ToolCallBinding;
  /** Branching transitions: optionId → nextStepId (for choice/confirm) */
  transitions?: Record<string, string>;
  /** Linear transition: next step ID */
  next?: string;
  /** If true, workflow ends at this step */
  terminal?: boolean;

  // Type-specific optional fields:
  placeholder?: string;
  confirmLabel?: string;
  denyLabel?: string;
  minSelections?: number;
  maxSelections?: number;
  media?: {
    type: "image" | "file" | "voice";
    url?: string;
    path?: string;
    mimeType?: string;
  };
}

// ─── Workflow Definition ────────────────────────────────────────────────────

export interface WorkflowDefinition {
  /** Unique workflow identifier (e.g., "wallet-onboarding") */
  id: string;
  /** Owning plugin name */
  plugin: string;
  /** Workflow definition version (semver) */
  version: string;
  /** Time-to-live for active instances in ms. Default: 3600000 (1h) */
  ttl?: number;
  /** Show step progress indicator. Default: true */
  showProgress?: boolean;
  /** ID of the first step */
  entryPoint: string;
  /** Step definitions keyed by step ID */
  steps: Record<string, WorkflowStepDefinition>;
}

// ─── Workflow Runtime State ─────────────────────────────────────────────────

export interface StepData {
  selection?: string | string[];
  input?: string;
  timestamp: string;
}

export interface WorkflowState {
  workflowId: string;
  userId: string;
  currentStep: string;
  stepHistory: string[];
  data: Record<string, StepData>;
  startedAt: string;
  lastActiveAt: string;
  originSurface: string;
  lastSurface: string;
  expiresAt: string;
  lastMessageIds: Record<string, string>;
}

// ─── Action Result ──────────────────────────────────────────────────────────

export interface WorkflowActionResult {
  outcome:
    | "advanced"
    | "completed"
    | "cancelled"
    | "validation-error"
    | "tool-error";
  state: WorkflowState | null;
  error?: string;
  toolResult?: unknown;
}
