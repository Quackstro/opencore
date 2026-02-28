/**
 * Brain Actions — Action Detector.
 *
 * Detects actionable intents from classification results and input tags.
 */

import type { ClassificationResult } from "@openclaw/brain-core";
import type { DetectedIntent } from "./types.js";

// ============================================================================
// Intent Keywords
// ============================================================================

const REMINDER_KEYWORDS = [
  "remind",
  "reminder",
  "notify",
  "alert",
  "don't forget",
  "remember to",
  "need to",
  "at ",
  "by ",
  "before ",
  "tomorrow",
  "next week",
  "on monday",
  "on tuesday",
  "on wednesday",
  "on thursday",
  "on friday",
  "on saturday",
  "on sunday",
  "tonight",
  "this evening",
];

const BOOKING_KEYWORDS = [
  "book",
  "schedule",
  "appointment",
  "reservation",
  "meeting with",
  "call with",
  "interview",
  "dentist",
  "doctor",
  "haircut",
];

const PAYMENT_KEYWORDS = [
  "send",
  "pay",
  "tip",
  "transfer",
  "reimburse",
  "owe",
  "doge",
  "crypto",
  "wallet",
];

const TODO_KEYWORDS = [
  "todo",
  "to-do",
  "task",
  "action item",
  "need to",
  "should",
  "must",
  "have to",
  "gonna",
  "going to",
];

const PURCHASE_KEYWORDS = ["buy", "purchase", "order", "get", "pick up", "shop"];

const CALL_KEYWORDS = ["call", "phone", "ring", "dial", "reach out"];

// ============================================================================
// Intent Detection
// ============================================================================

/**
 * Check if text contains any of the keywords (case-insensitive).
 */
function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Map an input tag to an intent.
 */
export function tagToIntent(tag: string | undefined): DetectedIntent | null {
  if (!tag) return null;

  const normalized = tag.toLowerCase().replace(/[^a-z]/g, "");

  switch (normalized) {
    case "reminder":
    case "remind":
    case "remindme":
      return "reminder";
    case "book":
    case "booking":
    case "appointment":
      return "booking";
    case "todo":
    case "task":
      return "todo";
    case "buy":
    case "purchase":
      return "purchase";
    case "call":
    case "phone":
      return "call";
    case "pay":
    case "send":
    case "tip":
    case "payment":
      return "payment";
    default:
      return null;
  }
}

/**
 * Detect the primary actionable intent from a classification result.
 * Priority: explicit tag > classification detectedIntent > keyword heuristics.
 */
export function detectIntent(
  classification: ClassificationResult,
  rawText: string,
  inputTag?: string,
): DetectedIntent {
  // 1. Explicit bracket tag has highest priority
  const tagIntent = tagToIntent(inputTag);
  if (tagIntent) return tagIntent;

  // 2. Classification's detected intent
  if (classification.detectedIntent && classification.detectedIntent !== "none") {
    return classification.detectedIntent as DetectedIntent;
  }

  // 3. Keyword heuristics on raw text
  if (containsKeyword(rawText, PAYMENT_KEYWORDS)) {
    // Check for payment-specific patterns
    const hasAmount = /\d+(?:\.\d+)?\s*(?:doge|Ð|D)/i.test(rawText);
    const hasRecipient = /(?:to|for|@)\s+\w+/i.test(rawText);
    if (hasAmount || hasRecipient) return "payment";
  }

  if (containsKeyword(rawText, BOOKING_KEYWORDS)) return "booking";
  if (containsKeyword(rawText, REMINDER_KEYWORDS)) return "reminder";
  if (containsKeyword(rawText, CALL_KEYWORDS)) return "call";
  if (containsKeyword(rawText, PURCHASE_KEYWORDS)) return "purchase";
  if (containsKeyword(rawText, TODO_KEYWORDS)) return "todo";

  // 4. Check classification urgency for time-sensitive items
  if (classification.urgency === "high" && classification.followUpDate) {
    return "reminder";
  }

  return "none";
}

/**
 * Check if an intent is time-sensitive (needs time extraction).
 */
export function isTimeSensitive(intent: DetectedIntent): boolean {
  return intent === "reminder" || intent === "booking";
}

/**
 * Check if an intent involves payment.
 */
export function isPaymentIntent(intent: DetectedIntent): boolean {
  return intent === "payment";
}

/**
 * Check if an intent should be tagged only (no cron job).
 */
export function isTagOnlyIntent(intent: DetectedIntent): boolean {
  return intent === "todo" || intent === "purchase" || intent === "call";
}
