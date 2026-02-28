/**
 * Brain Core — Input Tag Parser.
 *
 * Detects user-typed bracket tags at the start of drop text.
 * Runs BEFORE classification to strip tags and pass them to the action router.
 *
 * Supported tags: [ToDo], [Reminder], [Buy], [Call], [Book]
 * Case-insensitive matching.
 */

// ============================================================================
// Types
// ============================================================================

/** Supported input tag types (normalized to lowercase). */
export type InputTag = "todo" | "reminder" | "buy" | "call" | "book";

/** Result of parsing input tags from raw text. */
export interface TagParseResult {
  /** The detected tag (normalized lowercase), or null if none found. */
  tag: InputTag | null;
  /** The clean text with the bracket tag stripped. */
  cleanText: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Map of supported bracket tags to their normalized form. */
const TAG_MAP: Record<string, InputTag> = {
  todo: "todo",
  reminder: "reminder",
  buy: "buy",
  call: "call",
  book: "book",
};

/**
 * Regex to detect bracket tags at the start of text.
 * Matches: [ToDo], [REMINDER], [buy], etc.
 * Captures the tag name (group 1) and the rest of the text (group 2).
 */
const TAG_REGEX = /^\s*\[(\w+)\]\s*([\s\S]*)/i;

// ============================================================================
// Tag Parser
// ============================================================================

/**
 * Parse input tags from raw drop text.
 *
 * Detects bracket tags like [ToDo], [Reminder], [Buy], [Call], [Book]
 * at the start of the text. Case-insensitive.
 *
 * Examples:
 *   "[ToDo] buy groceries"  → { tag: "todo",     cleanText: "buy groceries" }
 *   "[Buy] new headphones"  → { tag: "buy",      cleanText: "new headphones" }
 *   "[Reminder] call mom"   → { tag: "reminder", cleanText: "call mom" }
 *   "just a regular note"   → { tag: null,       cleanText: "just a regular note" }
 *   "[Unknown] something"   → { tag: null,       cleanText: "[Unknown] something" }
 *
 * @param rawText - The raw drop text
 * @returns Object with detected tag (or null) and clean text
 */
export function parseInputTags(rawText: string): TagParseResult {
  if (!rawText) {
    return { tag: null, cleanText: "" };
  }

  const match = TAG_REGEX.exec(rawText);

  if (!match) {
    return { tag: null, cleanText: rawText.trim() };
  }

  const tagName = match[1].toLowerCase();
  const restText = match[2];

  const normalizedTag = TAG_MAP[tagName] ?? null;

  if (!normalizedTag) {
    // Unknown bracket tag — don't strip it, return original text
    return { tag: null, cleanText: rawText.trim() };
  }

  return {
    tag: normalizedTag,
    cleanText: restText.trim(),
  };
}

/**
 * Map an InputTag to the corresponding detectedIntent value
 * used by the action router.
 *
 * @param tag - The parsed input tag
 * @returns The intent string for the action router
 */
export function tagToIntent(tag: InputTag): string {
  const mapping: Record<InputTag, string> = {
    todo: "todo",
    reminder: "reminder",
    buy: "purchase",
    call: "call",
    book: "booking",
  };
  return mapping[tag];
}
