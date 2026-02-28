/**
 * Brain Actions — Action Detector.
 *
 * Detects actionable intents from classification results and raw text.
 * Uses a combination of:
 * - Explicit input tags (highest priority)
 * - Classifier-detected intent
 * - Keyword/pattern heuristics (fallback)
 */

import type { ClassificationResult } from "@openclaw/brain-core";
import type { DetectedIntent } from "./types.js";

// ============================================================================
// Time-Sensitive Patterns
// ============================================================================

/** Regex patterns for time-sensitive text. */
const TIME_PATTERNS = [
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  /\bat\s+noon\b/i,
  /\bat\s+midnight\b/i,
  /\bby\s+tomorrow\b/i,
  /\bby\s+monday\b/i,
  /\bby\s+tuesday\b/i,
  /\bby\s+wednesday\b/i,
  /\bby\s+thursday\b/i,
  /\bby\s+friday\b/i,
  /\bby\s+saturday\b/i,
  /\bby\s+sunday\b/i,
  /\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|day|week|month|morning|evening|night)\b/i,
];

/** Keyword stems that suggest time-sensitive / reminder intent. */
const REMINDER_KEYWORDS = [
  "remind",
  "don't forget",
  "dont forget",
  "alarm",
  "wake me",
  "notify me",
  "at noon",
  "at midnight",
  "turn on",
  "turn off",
];

// ============================================================================
// Intent Tag Mapping
// ============================================================================

/** Map input tag to detected intent. */
const TAG_TO_INTENT: Record<string, DetectedIntent> = {
  todo: "todo",
  task: "todo",
  buy: "purchase",
  purchase: "purchase",
  shop: "purchase",
  call: "call",
  phone: "call",
  ring: "call",
  reminder: "reminder",
  remind: "reminder",
  alarm: "reminder",
  book: "booking",
  booking: "booking",
  appt: "booking",
  appointment: "booking",
  schedule: "booking",
  pay: "payment",
  send: "payment",
  transfer: "payment",
};

/**
 * Convert an input tag to a detected intent.
 *
 * @param tag - Input tag string
 * @returns Detected intent or "none"
 */
export function tagToIntent(tag: string): DetectedIntent {
  const lower = tag.toLowerCase().trim();
  return TAG_TO_INTENT[lower] ?? "none";
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Check if text contains time-sensitive patterns.
 *
 * @param text - Text to check
 * @returns true if time-sensitive patterns detected
 */
export function hasTimePatterns(text: string): boolean {
  const lower = text.toLowerCase();

  for (const kw of REMINDER_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  for (const pattern of TIME_PATTERNS) {
    if (pattern.test(lower)) return true;
  }

  return false;
}

/**
 * Check if classification suggests a time-sensitive action.
 *
 * @param classification - Classification result
 * @returns true if time-sensitive
 */
export function hasTimeSensitiveClassification(classification: ClassificationResult): boolean {
  // Urgency "now" or "today" with date entities
  if (
    (classification.urgency === "now" || classification.urgency === "today") &&
    classification.entities.dates.length > 0
  ) {
    return true;
  }

  // followUpDate is set
  if (classification.followUpDate) {
    return true;
  }

  return false;
}

/**
 * Quick heuristic: should we invoke the LLM for time extraction?
 *
 * @param classification - The classification result
 * @param rawText - Original raw text
 * @returns true if the action router should attempt time extraction
 */
export function shouldExtractTime(classification: ClassificationResult, rawText: string): boolean {
  return hasTimeSensitiveClassification(classification) || hasTimePatterns(rawText);
}

/**
 * Resolve the effective intent from available signals.
 *
 * Priority:
 * 1. Explicit input tag (user-specified)
 * 2. Classifier detectedIntent
 * 3. "none" (fall back to heuristics)
 *
 * @param inputTag - Explicit bracket tag from input (e.g., "[todo]", "[buy]")
 * @param classification - Classification result with optional detectedIntent
 * @param _rawText - Original raw text (reserved for future keyword heuristics)
 * @returns Resolved intent string
 */
export function resolveIntent(
  inputTag: string | null | undefined,
  classification: ClassificationResult,
  _rawText: string,
): DetectedIntent {
  // Priority 1: Explicit input tag from user
  if (inputTag) {
    const intent = tagToIntent(inputTag);
    if (intent !== "none") return intent;
  }

  // Priority 2: Classifier-detected intent
  const classifierIntent = classification.detectedIntent;
  if (classifierIntent && classifierIntent !== "none") {
    return classifierIntent as DetectedIntent;
  }

  // Priority 3: No explicit intent
  return "none";
}

/**
 * Check if a payment intent is present.
 *
 * @param classification - Classification result
 * @param rawText - Original raw text
 * @returns true if payment intent detected
 */
export function hasPaymentIntent(classification: ClassificationResult, rawText: string): boolean {
  const lower = rawText.toLowerCase();

  // Check for payment keywords
  const paymentKeywords = ["pay ", "send ", "transfer ", "doge to", " doge ", "payment"];
  for (const kw of paymentKeywords) {
    if (lower.includes(kw)) return true;
  }

  // Check classifier proposed actions
  if (classification.proposedActions?.some((a) => a.type === "payment")) {
    return true;
  }

  return false;
}

/**
 * Detect the primary actionable intent from all signals.
 *
 * This is the main entry point for action detection.
 *
 * @param inputTag - Explicit bracket tag from input
 * @param classification - Classification result
 * @param rawText - Original raw text
 * @returns Object with detected intent and whether time extraction is needed
 */
export function detectAction(
  inputTag: string | null | undefined,
  classification: ClassificationResult,
  rawText: string,
): {
  intent: DetectedIntent;
  needsTimeExtraction: boolean;
  shouldRoute: boolean;
} {
  const intent = resolveIntent(inputTag, classification, rawText);

  // Time-sensitive intents always need time extraction
  const timeSensitiveIntents: DetectedIntent[] = ["reminder", "booking"];
  if (timeSensitiveIntents.includes(intent)) {
    return { intent, needsTimeExtraction: true, shouldRoute: true };
  }

  // Non-time-sensitive explicit intents route directly
  const nonTimeIntents: DetectedIntent[] = ["todo", "purchase", "call", "payment"];
  if (nonTimeIntents.includes(intent)) {
    return { intent, needsTimeExtraction: false, shouldRoute: true };
  }

  // No explicit intent — check heuristics
  if (shouldExtractTime(classification, rawText)) {
    return { intent: "reminder", needsTimeExtraction: true, shouldRoute: true };
  }

  // Check for implicit payment intent
  if (hasPaymentIntent(classification, rawText)) {
    return { intent: "payment", needsTimeExtraction: false, shouldRoute: true };
  }

  return { intent: "none", needsTimeExtraction: false, shouldRoute: false };
}

// ============================================================================
// Exports
// ============================================================================

export { TIME_PATTERNS, REMINDER_KEYWORDS, TAG_TO_INTENT };
