/**
 * Brain Actions — Type Definitions.
 *
 * Generic action types, results, and configuration interfaces.
 * No hardcoded integrations — all delivery is via configurable hooks.
 */

import type { ClassificationResult, EmbeddingProvider, BrainStore } from "@openclaw/brain-core";

// ============================================================================
// Action Types
// ============================================================================

/** All supported action types. */
export type ActionType =
  | "no-action"
  | "reminder-created"
  | "booking-created"
  | "todo-tagged"
  | "purchase-tagged"
  | "call-tagged"
  | "payment-proposed"
  | "payment-resolved"
  | "payment-executed"
  | "payment-auto-executed"
  | "payment-pending"
  | "payment-failed";

/** Intent types that can be detected from input. */
export type DetectedIntent =
  | "reminder"
  | "booking"
  | "todo"
  | "purchase"
  | "call"
  | "payment"
  | "none";

// ============================================================================
// Action Result
// ============================================================================

/** Result from routing an action. */
export interface ActionResult {
  action: ActionType;
  triggerJobId?: string;
  nagJobId?: string;
  name?: string;
  reminderAt?: string;
  details?: string;
  actionId?: string;
}

// ============================================================================
// Time Extraction
// ============================================================================

/** Output from LLM time extraction. */
export interface TimeExtraction {
  date: string | null;
  time: string | null;
  timezone: string;
  recurring: string | null;
  reminderText: string;
}

// ============================================================================
// Reminder Types
// ============================================================================

/** Reminder creation parameters. */
export interface ReminderParams {
  text: string;
  reminderAt: Date | string;
  recurring?: string;
  timezone: string;
}

/** Persistent reminder result. */
export interface PersistentReminderResult {
  triggerJobId: string | null;
  nagJobId: string;
  name: string;
}

// ============================================================================
// Payment Types
// ============================================================================

/** Payment entity resolution result. */
export interface PaymentResolution {
  recipientName: string | null;
  dogeAddress: string | null;
  amount: number | null;
  reason: string | null;
  resolutionScore: number;
  errors: string[];
  addressSource: "explicit" | "brain-lookup" | "unknown";
  amountSource: "explicit" | "inferred" | "unknown";
}

/** Payment action object (persisted). */
export interface PaymentAction {
  id: string;
  type: "payment";
  params: Record<string, string>;
  resolvedParams: {
    to?: string;
    amount?: number;
    reason?: string;
    recipientName?: string;
  };
  status:
    | "proposed"
    | "approved"
    | "executing"
    | "complete"
    | "failed"
    | "dismissed"
    | "awaiting-unlock"
    | "awaiting-confirmation"
    | "expired";
  gating: "auto" | "manual";
  executionScore: number;
  createdAt: string;
  executedAt: string | null;
  txid: string | null;
  fee: number | null;
  error: string | null;
}

/** Policy evaluation decision. */
export type PolicyDecision = "auto" | "prompt" | "prompt-warning" | "pending";

/** Policy evaluation result. */
export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

// ============================================================================
// Configuration
// ============================================================================

/** Action router configuration (from plugin config + runtime). */
export interface ActionRouterConfig {
  /** Gateway API token for LLM calls. */
  gatewayToken: string;
  /** Gateway URL (default: http://127.0.0.1:18789). */
  gatewayUrl?: string;
  /** User timezone (default: America/New_York). */
  timezone?: string;
  /** LLM model for time extraction (default: claude-haiku-3.5). */
  extractionModel?: string;
  /** Enable action routing (default: true). */
  enabled?: boolean;
  /** Embedding provider for payment entity resolution. */
  embedder?: EmbeddingProvider;
  /** Enable/disable specific action types. */
  actionTypes?: {
    reminder?: boolean;
    booking?: boolean;
    todo?: boolean;
    purchase?: boolean;
    call?: boolean;
    payment?: boolean;
  };
  /** Reminder-specific config. */
  reminder?: {
    nagIntervalMinutes?: number;
    defaultTime?: string;
  };
  /** Payment-specific config. */
  payment?: {
    autoApproveThreshold?: number;
    promptThreshold?: number;
    maxAutoAmount?: number;
  };
}

// ============================================================================
// Hook Interfaces
// ============================================================================

/** Reminder delivery hook. */
export type ReminderDeliverHook = (
  reminderText: string,
  nagJobId: string,
  config: ActionRouterConfig,
) => Promise<void>;

/** Payment approval hook. */
export type PaymentApprovalHook = (
  action: PaymentAction,
  policyDecision: PolicyDecision,
) => Promise<void>;

/** Payment execution hook. Returns txid on success. */
export type PaymentExecuteHook = (
  address: string,
  amount: number,
  reason: string,
) => Promise<{ txid: string; fee?: number } | { error: string }>;

/** Payment completion notification hook. */
export type PaymentCompleteHook = (action: PaymentAction, txid: string) => Promise<void>;

/** Payment failure notification hook. */
export type PaymentFailedHook = (action: PaymentAction, error: string) => Promise<void>;

/** Action routed notification hook (for audit/logging). */
export type ActionRoutedHook = (
  actionType: ActionType,
  result: ActionResult,
  inboxId: string,
) => Promise<void>;

/** All hooks bundled together. */
export interface ActionHooks {
  onReminderDeliver?: ReminderDeliverHook;
  onPaymentApprove?: PaymentApprovalHook;
  onPaymentExecute?: PaymentExecuteHook;
  onPaymentComplete?: PaymentCompleteHook;
  onPaymentFailed?: PaymentFailedHook;
  onActionRouted?: ActionRoutedHook;
}

// ============================================================================
// Router Context
// ============================================================================

/** Context passed to action handlers. */
export interface ActionContext {
  store: BrainStore;
  config: ActionRouterConfig;
  hooks: ActionHooks;
  classification: ClassificationResult;
  rawText: string;
  inboxId: string;
  inputTag?: string | null;
}

// ============================================================================
// Handler Interface
// ============================================================================

/** Generic action handler signature. */
export type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;
