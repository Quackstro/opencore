/**
 * Brain Core — /drop command handler.
 *
 * Behavior:
 * - One message = one thought
 * - No tagging, no organizing, no decisions
 * - Immediately acknowledged: "✅ Captured"
 * - Writes raw input to inbox table with timestamp + source
 * - Fires classification pipeline asynchronously (don't block the user)
 *
 * Photo support:
 * - Accepts photos: /drop + attached photo → OCR → extract text → classify
 * - Source types: "drop" for text, "photo" for images
 */

import { logAudit } from "../audit.js";
import type { ClassifierFn } from "../classifier.js";
import { routeClassification, DEFAULT_CONFIDENCE_THRESHOLD } from "../router.js";
import type { EmbeddingProvider, ClassificationResult } from "../schemas.js";
import type { BrainStore } from "../store.js";
import { parseInputTags } from "../tag-parser.js";

// ============================================================================
// Types
// ============================================================================

export interface DropResult {
  id: string;
  status: "captured";
  message: string;
  /** Explicit bracket tag detected by the tag parser, if any. */
  inputTag?: string | null;
}

export interface DropOptions {
  /** Optional classifier function (for async processing) */
  classifierFn?: ClassifierFn;
  /** Confidence threshold override */
  confidenceThreshold?: number;
  /** Fire classification asynchronously (default: true in production) */
  async?: boolean;
  /** Configured bucket list */
  buckets: readonly string[];
  /** Optional callback for action routing (payment, reminder, etc.) */
  onClassified?: (
    classification: ClassificationResult,
    inboxId: string,
    rawText: string,
    inputTag: string | null,
  ) => Promise<void>;
}

// ============================================================================
// OCR support
// ============================================================================

/**
 * Attempt OCR on an image file.
 * Uses tesseract CLI if available (same approach as doc-RAG).
 *
 * @param imagePath - Path to the image file
 * @returns Extracted text, or null if OCR is unavailable
 */
export async function ocrImage(imagePath: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Check if tesseract is available
    try {
      await execFileAsync("which", ["tesseract"], { timeout: 5000 });
    } catch {
      // Tesseract not installed — return null
      return null;
    }

    // Run tesseract on the image
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng"], {
      timeout: 30000,
    });

    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Drop handler
// ============================================================================

/**
 * Handle a /drop command: write raw input to inbox, ack, fire pipeline.
 *
 * @param store - BrainStore instance
 * @param embedder - Embedding provider for vector generation
 * @param rawText - The raw thought text
 * @param source - Where the thought came from
 * @param mediaPath - Optional path to attached media
 * @param options - Drop options (classifier, threshold, async, buckets)
 */
export async function handleDrop(
  store: BrainStore,
  embedder: EmbeddingProvider,
  rawText: string,
  source: "drop" | "chat" | "file" | "voice" | "photo" = "drop",
  mediaPath?: string,
  options?: DropOptions,
): Promise<DropResult> {
  const buckets = options?.buckets ?? store.getBuckets();
  let textToProcess = rawText;

  // If this is a photo drop with a media path, attempt OCR
  if (source === "photo" && mediaPath) {
    const ocrText = await ocrImage(mediaPath);
    if (ocrText) {
      textToProcess = ocrText;
    }
    // If OCR fails, fall back to any provided rawText
  }

  // ── Tag Parser (runs BEFORE classification) ──────────────────────────
  // Detects bracket tags like [ToDo], [Buy], [Reminder] at the start
  // of the text, strips them, and passes the tag to the action router.
  const { tag: inputTag, cleanText } = parseInputTags(textToProcess);
  const textForClassification = cleanText || textToProcess;

  // Generate embedding for the clean text (without bracket tag noise)
  const vector = await embedder.embed(textForClassification);

  // Write to inbox (preserve original rawText + detected tag for traceability)
  const record = await store.create("inbox", {
    rawText: textToProcess,
    source,
    timestamp: new Date().toISOString(),
    mediaPath: mediaPath ?? "",
    inputTag: inputTag ?? "",
    status: "pending",
    vector,
  });

  const inboxId = record.id as string;

  // Log "captured" audit entry (include tag detection if present)
  const tagNote = inputTag ? ` [tag: ${inputTag}]` : "";
  await logAudit(store, {
    action: "captured",
    inputId: inboxId,
    details: `Captured ${source} drop${tagNote}: "${textForClassification.slice(0, 100)}${textForClassification.length > 100 ? "..." : ""}"`,
  });

  // Fire classification pipeline
  if (options?.classifierFn) {
    const classifyAndRoute = async () => {
      try {
        // Classify the clean text (bracket tag already stripped)
        const { classification, tokensUsed } = await options.classifierFn!(textForClassification);

        // Inject explicit input tag into classification tags for storage
        if (inputTag && !classification.tags.includes(inputTag)) {
          classification.tags.push(inputTag);
        }

        // Log classification audit
        await logAudit(store, {
          action: "classified",
          inputId: inboxId,
          bucket: classification.bucket,
          confidence: classification.confidence,
          details: `Classified as ${classification.bucket} (${classification.confidence.toFixed(2)}): "${classification.title}"${inputTag ? ` [inputTag: ${inputTag}, intent: ${classification.detectedIntent ?? "none"}]` : ` [intent: ${classification.detectedIntent ?? "none"}]`}`,
          tokenCost: tokensUsed,
        });

        // Route the classification
        await routeClassification(
          store,
          embedder,
          classification,
          inboxId,
          textForClassification,
          buckets,
          options?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
        );

        // Call optional onClassified hook for action routing
        if (options?.onClassified) {
          try {
            await options.onClassified(classification, inboxId, textForClassification, inputTag);
          } catch (err) {
            console.error(`[brain-core] onClassified hook error (non-fatal):`, err);
          }
        }
      } catch (err) {
        // Log classification failure to audit trail
        await logAudit(store, {
          action: "needs-review",
          inputId: inboxId,
          details: `Classification failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    if (options?.async !== false) {
      // Fire and forget — don't block the user
      classifyAndRoute().catch(() => {
        /* swallow — already logged to audit */
      });
    } else {
      // Synchronous mode (for testing)
      await classifyAndRoute();
    }
  }

  return {
    id: inboxId,
    status: "captured",
    message: inputTag ? `✅ Captured [${inputTag}]` : "✅ Captured",
    inputTag,
  };
}

// ============================================================================
// Full pipeline function (used by index.ts and CLI)
// ============================================================================

/**
 * Run the full drop → classify → route pipeline synchronously.
 * This is the direct function call fallback (no Lobster needed).
 *
 * @param store - BrainStore instance
 * @param embedder - Embedding provider
 * @param classifierFn - Classifier function
 * @param rawText - Raw thought text
 * @param source - Source type
 * @param mediaPath - Optional media path
 * @param buckets - Configured bucket list
 * @param confidenceThreshold - Optional threshold override
 * @returns Drop result with full pipeline completion
 */
export async function dropAndClassify(
  store: BrainStore,
  embedder: EmbeddingProvider,
  classifierFn: ClassifierFn,
  rawText: string,
  source: "drop" | "chat" | "file" | "voice" | "photo" = "drop",
  mediaPath?: string,
  buckets?: readonly string[],
  confidenceThreshold?: number,
): Promise<DropResult> {
  return handleDrop(store, embedder, rawText, source, mediaPath, {
    classifierFn,
    confidenceThreshold,
    async: false, // synchronous for direct calls
    buckets: buckets ?? store.getBuckets(),
  });
}
