/**
 * Brain Core — Confidence check + bucket routing.
 *
 * The "Bouncer": decides whether a classified thought is routable
 * (confidence ≥ threshold) or needs human review.
 *
 * Includes duplicate detection via cosine similarity.
 */

import { logAudit } from "./audit.js";
import { bucketToTable } from "./classifier.js";
import type { ClassificationResult, EmbeddingProvider } from "./schemas.js";
import type { BrainStore } from "./store.js";

// ============================================================================
// Constants
// ============================================================================

/** Default confidence threshold. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** Cosine similarity threshold for auto-merge. */
export const DEDUP_SIMILARITY_THRESHOLD = 0.92;

/** Max input length before suggesting split. */
export const MAX_INPUT_WORDS = 500;

// ============================================================================
// Confidence check
// ============================================================================

export interface ConfidenceCheckResult {
  routable: boolean;
  bucket: string | null;
  confidence: number;
  reason?: string;
  classification: ClassificationResult;
}

/**
 * Check whether a classification result meets the confidence threshold
 * for automatic routing.
 *
 * @param classification - The output from the classifier
 * @param buckets - List of valid bucket names
 * @param threshold - Confidence threshold (default 0.80)
 * @returns ConfidenceCheckResult with routing decision
 */
export function checkConfidence(
  classification: ClassificationResult,
  buckets: readonly string[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): ConfidenceCheckResult {
  const { bucket, confidence } = classification;

  // Unknown bucket always goes to needs_review
  if (bucket === "unknown") {
    return {
      routable: false,
      bucket: null,
      confidence,
      reason: "Classifier returned unknown bucket",
      classification,
    };
  }

  // Map classifier bucket to table name
  const tableName = bucketToTable(bucket, buckets);
  if (!tableName) {
    return {
      routable: false,
      bucket: null,
      confidence,
      reason: `Unrecognized bucket: ${bucket}`,
      classification,
    };
  }

  // Check confidence threshold
  if (confidence < threshold) {
    return {
      routable: false,
      bucket: tableName,
      confidence,
      reason: `Confidence ${confidence.toFixed(2)} below threshold ${threshold.toFixed(2)}`,
      classification,
    };
  }

  return {
    routable: true,
    bucket: tableName,
    confidence,
    classification,
  };
}

// ============================================================================
// Record builder
// ============================================================================

/**
 * Build a bucket record from a classification result.
 * Transforms the flat classification output into the appropriate
 * bucket-specific schema.
 *
 * @param classification - The classification result
 * @param bucket - The target bucket table name
 * @param inboxId - The source inbox entry ID
 * @returns A record ready to be inserted into the bucket table
 */
export function buildBucketRecord(
  classification: ClassificationResult,
  bucket: string,
  inboxId: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const entryNote = JSON.stringify([{ date: now, note: classification.summary }]);
  const nextActions = JSON.stringify(classification.nextActions);
  const tags = JSON.stringify(classification.tags);

  // Common fields across all bucket types
  const base = {
    nextActions,
    entries: entryNote,
    tags,
  };

  switch (bucket) {
    case "people":
      return {
        ...base,
        name: classification.title,
        context: classification.summary,
        company: "",
        contactInfo: "",
        followUpDate: classification.followUpDate ?? "",
        lastInteraction: now.split("T")[0],
      };

    case "projects":
      return {
        ...base,
        name: classification.title,
        description: classification.summary,
        status: "active",
        blockers: "[]",
        relatedPeople: "[]",
        dueDate: classification.followUpDate ?? "",
      };

    case "ideas":
      return {
        ...base,
        title: classification.title,
        description: classification.summary,
        potential: "explore",
        relatedTo: "[]",
      };

    case "admin":
      return {
        ...base,
        title: classification.title,
        category: inferAdminCategory(classification),
        dueDate: classification.followUpDate ?? "",
        recurring: "",
      };

    case "documents":
      return {
        ...base,
        title: classification.title,
        summary: classification.summary,
        sourceUrl: "",
        filePath: "",
        relatedTo: "[]",
      };

    case "goals":
      return {
        ...base,
        title: classification.title,
        description: classification.summary,
        timeframe: inferGoalTimeframe(classification),
        status: "active",
        milestones: "[]",
        relatedProjects: "[]",
      };

    case "health":
      return {
        ...base,
        title: classification.title,
        category: inferHealthCategory(classification),
        description: classification.summary,
        provider: extractProvider(classification),
        followUpDate: classification.followUpDate ?? "",
      };

    case "finance":
      return {
        ...base,
        title: classification.title,
        category: inferFinanceCategory(classification),
        amount: extractAmount(classification),
        currency: "",
        dueDate: classification.followUpDate ?? "",
        recurring: "",
      };

    default:
      // Generic bucket record
      return {
        ...base,
        title: classification.title,
        description: classification.summary,
        category: "",
        status: "active",
        dueDate: classification.followUpDate ?? "",
      };
  }
}

// ============================================================================
// Category inference helpers
// ============================================================================

function inferAdminCategory(
  c: ClassificationResult,
): "appointment" | "errand" | "bill" | "logistics" | "other" {
  const text = `${c.title} ${c.summary}`.toLowerCase();
  if (text.includes("appointment") || text.includes("dentist") || text.includes("meeting"))
    return "appointment";
  if (text.includes("errand") || text.includes("pick up") || text.includes("buy")) return "errand";
  if (text.includes("bill") || text.includes("pay")) return "bill";
  if (text.includes("ship") || text.includes("move") || text.includes("travel")) return "logistics";
  return "other";
}

function inferGoalTimeframe(c: ClassificationResult): "short-term" | "medium-term" | "long-term" {
  const text = `${c.title} ${c.summary}`.toLowerCase();
  if (text.includes("this week") || text.includes("today") || text.includes("tomorrow"))
    return "short-term";
  if (text.includes("this month") || text.includes("this quarter")) return "medium-term";
  if (text.includes("this year") || text.includes("long") || text.includes("life"))
    return "long-term";
  return "medium-term";
}

function inferHealthCategory(
  c: ClassificationResult,
): "medical" | "fitness" | "nutrition" | "mental" | "wellness" {
  const text = `${c.title} ${c.summary}`.toLowerCase();
  if (
    text.includes("doctor") ||
    text.includes("dentist") ||
    text.includes("appointment") ||
    text.includes("lab") ||
    text.includes("prescription") ||
    text.includes("medical")
  )
    return "medical";
  if (
    text.includes("gym") ||
    text.includes("workout") ||
    text.includes("exercise") ||
    text.includes("run")
  )
    return "fitness";
  if (text.includes("diet") || text.includes("nutrition") || text.includes("meal"))
    return "nutrition";
  if (
    text.includes("therapy") ||
    text.includes("mental") ||
    text.includes("stress") ||
    text.includes("meditation")
  )
    return "mental";
  return "wellness";
}

function inferFinanceCategory(
  c: ClassificationResult,
): "bill" | "investment" | "expense" | "income" | "budget" | "tax" | "other" {
  const text = `${c.title} ${c.summary}`.toLowerCase();
  if (
    text.includes("bill") ||
    text.includes("pay") ||
    text.includes("electricity") ||
    text.includes("rent")
  )
    return "bill";
  if (text.includes("invest") || text.includes("stock") || text.includes("portfolio"))
    return "investment";
  if (text.includes("income") || text.includes("salary") || text.includes("revenue"))
    return "income";
  if (text.includes("budget") || text.includes("plan")) return "budget";
  if (text.includes("tax") || text.includes("irs")) return "tax";
  if (text.includes("spend") || text.includes("cost") || text.includes("purchase"))
    return "expense";
  return "bill"; // default for finance items
}

function extractProvider(c: ClassificationResult): string {
  // Use people entities if available
  if (c.entities.people.length > 0) return c.entities.people[0];
  return "";
}

function extractAmount(c: ClassificationResult): number {
  // Try to find an amount from entities
  if (c.entities.amounts.length > 0) {
    const raw = c.entities.amounts[0].replace(/[^0-9.]/g, "");
    const num = parseFloat(raw);
    if (!isNaN(num)) return num;
  }
  return 0;
}

// ============================================================================
// Duplicate detection (cosine similarity)
// ============================================================================

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingId?: string;
  similarity?: number;
}

/**
 * Check if a new item is a duplicate of an existing item in the target bucket.
 * Uses vector search to find nearest neighbors, then checks cosine similarity.
 *
 * @param store - BrainStore instance
 * @param bucket - Target bucket table name
 * @param vector - Embedding vector of the new item
 * @param threshold - Cosine similarity threshold (default 0.92)
 * @returns Duplicate check result
 */
export async function checkDuplicate(
  store: BrainStore,
  bucket: string,
  vector: number[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): Promise<DuplicateCheckResult> {
  try {
    const results = await store.search(bucket, vector, 3);

    for (const result of results) {
      const existingVector = result.record.vector as number[] | undefined;
      if (!existingVector || !Array.isArray(existingVector)) continue;

      const similarity = cosineSimilarity(vector, existingVector);
      if (similarity >= threshold) {
        return {
          isDuplicate: true,
          existingId: result.record.id as string,
          similarity,
        };
      }
    }
  } catch {
    // If search fails (empty table, etc.), no duplicate
  }

  return { isDuplicate: false };
}

/**
 * Merge a new entry into an existing record by appending to its entries log.
 *
 * @param store - BrainStore instance
 * @param bucket - Target bucket table name
 * @param existingId - ID of the existing record to merge into
 * @param classification - New classification data to merge
 * @returns The updated record
 */
export async function mergeIntoExisting(
  store: BrainStore,
  bucket: string,
  existingId: string,
  classification: ClassificationResult,
): Promise<Record<string, unknown> | null> {
  const existing = await store.get(bucket, existingId);
  if (!existing) return null;

  const now = new Date().toISOString();

  // Parse existing entries and append new one
  let entries: Array<{ date: string; note: string }> = [];
  try {
    entries = JSON.parse(existing.entries as string);
  } catch {
    entries = [];
  }
  entries.push({ date: now, note: classification.summary });

  // Merge nextActions (append new, deduplicate)
  let existingActions: string[] = [];
  try {
    existingActions = JSON.parse(existing.nextActions as string);
  } catch {
    existingActions = [];
  }
  const mergedActions = [...new Set([...existingActions, ...classification.nextActions])];

  // Update the record
  const updates: Record<string, unknown> = {
    entries: JSON.stringify(entries),
    nextActions: JSON.stringify(mergedActions),
  };

  // Update followUpDate if the new one is more recent
  if (classification.followUpDate) {
    const existingFollowUp = (existing.followUpDate as string) || "";
    if (!existingFollowUp || classification.followUpDate < existingFollowUp) {
      updates.followUpDate = classification.followUpDate;
    }
  }

  return store.update(bucket, existingId, updates);
}

// ============================================================================
// Full routing pipeline
// ============================================================================

export interface RouteResult {
  action: "routed" | "needs-review" | "merged";
  bucket?: string;
  recordId?: string;
  mergedIntoId?: string;
  confidence: number;
  reason?: string;
}

/**
 * Full routing pipeline:
 * 1. Check confidence → routable or not
 * 2. If routable: check for duplicates → merge or create
 * 3. If not routable: send to needs_review
 * 4. Log audit trail entries
 *
 * @param store - BrainStore instance
 * @param embedder - Embedding provider for vector generation
 * @param classification - Classification result from the LLM
 * @param inboxId - ID of the source inbox entry
 * @param rawText - Original raw text (for needs_review)
 * @param buckets - List of valid bucket names
 * @param threshold - Confidence threshold
 * @returns Routing result
 */
export async function routeClassification(
  store: BrainStore,
  embedder: EmbeddingProvider,
  classification: ClassificationResult,
  inboxId: string,
  rawText: string,
  buckets: readonly string[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): Promise<RouteResult> {
  // Step 1: Check confidence
  const check = checkConfidence(classification, buckets, threshold);

  if (!check.routable || !check.bucket) {
    // Route to needs_review
    const embText = `${classification.title} ${classification.summary}`;
    const vector = await embedder.embed(embText);

    const reviewRecord = await store.create("needs_review", {
      inboxId,
      rawText,
      suggestedBucket: classification.bucket,
      confidence: classification.confidence,
      title: classification.title,
      summary: classification.summary,
      timestamp: new Date().toISOString(),
      status: "pending",
      vector,
    });

    // Update inbox status
    await store.update("inbox", inboxId, { status: "needs-review" });

    // Log audit
    await logAudit(store, {
      action: "needs-review",
      inputId: inboxId,
      outputId: reviewRecord.id as string,
      bucket: classification.bucket,
      confidence: classification.confidence,
      details: `Routed to needs-review: ${check.reason ?? "below threshold"}`,
    });

    return {
      action: "needs-review",
      bucket: classification.bucket,
      recordId: reviewRecord.id as string,
      confidence: classification.confidence,
      reason: check.reason,
    };
  }

  // Step 2: Build record + embedding
  const bucket = check.bucket;
  const record = buildBucketRecord(classification, bucket, inboxId);
  const embText = `${classification.title} ${classification.summary}`;
  const vector = await embedder.embed(embText);

  // Step 3: Check for duplicates
  const dupCheck = await checkDuplicate(store, bucket, vector);

  if (dupCheck.isDuplicate && dupCheck.existingId) {
    // Auto-merge
    const merged = await mergeIntoExisting(store, bucket, dupCheck.existingId, classification);

    // Update inbox status
    await store.delete("inbox", inboxId);

    // Log audit
    await logAudit(store, {
      action: "merged",
      inputId: inboxId,
      outputId: dupCheck.existingId,
      bucket,
      confidence: classification.confidence,
      details: `Auto-merged into existing record (similarity: ${dupCheck.similarity?.toFixed(3)})`,
    });

    return {
      action: "merged",
      bucket,
      mergedIntoId: dupCheck.existingId,
      confidence: classification.confidence,
    };
  }

  // Step 4: Create new record in bucket
  record.vector = vector;
  const created = await store.create(bucket, record);

  // Clean up inbox entry
  await store.delete("inbox", inboxId);

  // Log audit
  await logAudit(store, {
    action: "routed",
    inputId: inboxId,
    outputId: created.id as string,
    bucket,
    confidence: classification.confidence,
    details: `Routed to ${bucket} with confidence ${classification.confidence.toFixed(2)}`,
  });

  return {
    action: "routed",
    bucket,
    recordId: created.id as string,
    confidence: classification.confidence,
  };
}
