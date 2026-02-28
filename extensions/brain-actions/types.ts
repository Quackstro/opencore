/**
 * Brain Actions — Type Definitions.
 *
 * Interfaces for action detection, routing, and handling.
 * All handlers are generic with configurable hooks for delivery.
 */

import type { BrainStore, ClassificationResult, EmbeddingProvider } from "@openclaw/brain-core";

// ============================================================================
// Action Types
// ============================================================================

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

export type DetectedIntent =
  | "reminder"
  | "booking"
  | "todo"
  | "purchase"
  | "call"
  | "payment"
  | "none";

// ============================================================================
// Action Results
// ============================================================================

export interface ActionResult {
  action: ActionType;
  triggerJobId?: string;
  nagJobId?: string;
  name?: string;
  reminderAt?: string;
  paymentId?: string;
  txid?: string;
  recipient?: string;
  amount?: number;
  currency?: string;
  details?: string;
}

// ============================================================================
// Time Extraction
// ============================================================================

export interface TimeExtraction {
  date: string | null;
  time: string | null;
  timezone: string;
  recurring: string | null; // Cron expression for recurring
  reminderText: string;
}

export interface PersistentReminderResult {
  triggerJobId: string | null;
  nagJobId: string;
  name: string;
}

// ============================================================================
// Payment Types
// ============================================================================

export interface PaymentParams {
  recipient: string;
  amount: number;
  currency: string;
  reason: string;
}

export interface PaymentResolution {
  resolved: boolean;
  address?: string;
  recipientName?: string;
  confidence?: number;
  error?: string;
}

export interface PaymentActionResult extends ActionResult {
  paymentId?: string;
  resolution?: PaymentResolution;
  params?: PaymentParams;
}

// ============================================================================
// Hooks (configurable callbacks)
// ============================================================================

/**
 * Hook called when a reminder needs to be delivered.
 * Implementation handles actual notification (Telegram, email, etc.)
 */
export type ReminderDeliverHook = (
  reminderText: string,
  nagJobId: string,
  options: { enableNag: boolean },
) => Promise<void>;

/**
 * Hook called to resolve a payment recipient to an address.
 * Implementation searches personal contacts/Brain people bucket.
 */
export type PaymentResolverHook = (
  recipient: string,
  embedder: EmbeddingProvider,
) => Promise<PaymentResolution>;

/**
 * Hook called to execute a payment after approval.
 * Implementation calls wallet_send or similar.
 */
export type PaymentExecuteHook = (
  params: PaymentParams,
  resolution: PaymentResolution,
) => Promise<{ success: boolean; txid?: string; error?: string }>;

/**
 * Hook called to request payment approval from user.
 * Implementation sends Telegram inline buttons or similar.
 */
export type PaymentApprovalHook = (
  params: PaymentParams,
  resolution: PaymentResolution,
  actionId: string,
) => Promise<void>;

/**
 * Hook called when an action is routed (for audit/notification).
 */
export type ActionRoutedHook = (
  actionType: ActionType,
  result: ActionResult,
  inboxId: string,
) => Promise<void>;

export interface ActionHooks {
  onReminderDeliver?: ReminderDeliverHook;
  onPaymentResolve?: PaymentResolverHook;
  onPaymentExecute?: PaymentExecuteHook;
  onPaymentApproval?: PaymentApprovalHook;
  onActionRouted?: ActionRoutedHook;
}

// ============================================================================
// Configuration
// ============================================================================

export interface ActionRouterConfig {
  enabled?: boolean;
  gatewayToken: string;
  gatewayUrl?: string;
  timezone?: string;
  extractionModel?: string;

  reminder?: {
    enabled?: boolean;
    nagIntervalMinutes?: number;
    defaultTime?: string; // Default time if only date specified
  };

  payment?: {
    enabled?: boolean;
    autoExecuteThreshold?: number; // Score above which to auto-execute
    maxAutoExecuteAmount?: number; // Max amount for auto-execute
  };
}

// ============================================================================
// Context passed to handlers
// ============================================================================

export interface ActionContext {
  store: BrainStore;
  embedder: EmbeddingProvider;
  config: ActionRouterConfig;
  hooks: ActionHooks;
  classification: ClassificationResult;
  rawText: string;
  inboxId: string;
  inputTag?: string;
}
