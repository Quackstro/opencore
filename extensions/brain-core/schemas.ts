/**
 * Brain Core — TypeScript interfaces & LanceDB schemas.
 *
 * All record types for bucket-based memory system.
 * Buckets are configurable via plugin config.
 *
 * LanceDB stores arrays/objects as JSON-serialized strings.
 * Each record carries a `vector` field for semantic search
 * (except AuditEntry which is structured-query-only).
 */

// ============================================================================
// Shared helpers
// ============================================================================

/** Entry in the chronological log attached to most records. */
export interface EntryNote {
  date: string; // ISO 8601
  note: string;
}

/** Milestone for GoalRecord. */
export interface Milestone {
  label: string;
  done: boolean;
  date?: string;
}

/** Recurring schedule. */
export interface RecurringSchedule {
  interval: "daily" | "weekly" | "monthly" | "yearly" | "quarterly";
}

// ============================================================================
// Default bucket configuration
// ============================================================================

/** Default buckets — can be overridden via plugin config. */
export const DEFAULT_BUCKETS = [
  "people",
  "projects",
  "ideas",
  "admin",
  "documents",
  "goals",
  "health",
  "finance",
] as const;

export const SYSTEM_TABLES = ["inbox", "needs_review", "audit_trail"] as const;

export type SystemTable = (typeof SYSTEM_TABLES)[number];

// ============================================================================
// Dynamic bucket types (configured at runtime)
// ============================================================================

/**
 * Create the full list of tables from configured buckets + system tables.
 */
export function getAllTables(buckets: readonly string[]): string[] {
  return [...buckets, ...SYSTEM_TABLES];
}

/**
 * Type helper for bucket names (for type assertions when needed).
 */
export type BucketName = string;

/**
 * Type helper for table names (buckets + system).
 */
export type TableName = string;

// ============================================================================
// 5.1 — Raw Inbox Entry
// ============================================================================

export interface InboxEntry {
  id: string;
  rawText: string;
  source: "drop" | "chat" | "file" | "voice" | "photo";
  timestamp: string; // ISO 8601
  mediaPath?: string;
  /** Explicit bracket tag detected by the tag parser (e.g., "todo", "buy"). */
  inputTag?: string;
  status: "pending" | "classified" | "needs-review" | "archived";
  vector: number[];
}

// ============================================================================
// Generic Bucket Record (base interface)
// ============================================================================

/** Base fields shared by all bucket records. */
export interface BaseBucketRecord {
  id: string;
  /** JSON-serialized string[] */
  nextActions: string;
  /** JSON-serialized EntryNote[] */
  entries: string;
  /** JSON-serialized string[] */
  tags: string;
  /** JSON-serialized Action[] */
  actions?: string;
  vector: number[];
}

/** Generic bucket record with title/description. */
export interface GenericBucketRecord extends BaseBucketRecord {
  title: string;
  description?: string;
  summary?: string;
  name?: string;
  context?: string;
  category?: string;
  status?: string;
  dueDate?: string;
  followUpDate?: string;
  [key: string]: unknown;
}

// ============================================================================
// 5.5 — Audit Trail (no vector — structured queries only)
// ============================================================================

export interface AuditEntry {
  id: string;
  timestamp: string;
  action:
    | "captured"
    | "classified"
    | "routed"
    | "updated"
    | "nudged"
    | "reviewed"
    | "fixed"
    | "archived"
    | "action-routed"
    | "merged"
    | "action-proposed"
    | "action-resolved"
    | "action-policy-check"
    | "action-approved"
    | "action-executing"
    | "action-executed"
    | "action-failed"
    | "action-dismissed"
    | "needs-review";
  inputId: string;
  outputId?: string;
  bucket?: string;
  confidence?: number;
  details: string;
  tokenCost?: number;
}

// ============================================================================
// 5.6 — Needs Review Entry
// ============================================================================

export interface NeedsReviewEntry {
  id: string;
  inboxId: string;
  rawText: string;
  suggestedBucket?: string;
  confidence: number;
  title?: string;
  summary?: string;
  timestamp: string;
  status: "pending" | "resolved" | "trashed";
  vector: number[];
}

// ============================================================================
// Action interface (for payment actions, etc.)
// ============================================================================

/** A proposed or executed action attached to a bucket record. */
export interface Action {
  id: string;
  type: string;
  confidence: number;
  params: Record<string, string>;
  resolvedParams: Record<string, unknown>;
  status: "proposed" | "approved" | "executing" | "complete" | "failed" | "dismissed";
  gating: "auto" | "manual";
  executionScore: number;
  pluginId: string;
  trigger: string | null;
  createdAt: string;
  executedAt: string | null;
  auditId: string | null;
  result: unknown;
  error: string | null;
}

// ============================================================================
// Union type for any record
// ============================================================================

export type AnyRecord = InboxEntry | GenericBucketRecord | NeedsReviewEntry | AuditEntry;

// ============================================================================
// Classification output (from sorter / llm-task)
// ============================================================================

/** Detected actionable intent values. */
export type DetectedIntent =
  | "reminder"
  | "todo"
  | "purchase"
  | "call"
  | "booking"
  | "payment"
  | "none";

export interface ClassificationResult {
  bucket: string;
  confidence: number;
  title: string;
  summary: string;
  nextActions: string[];
  entities: {
    people: string[];
    dates: string[];
    amounts: string[];
    locations: string[];
  };
  urgency: "now" | "today" | "this-week" | "someday";
  followUpDate: string | null;
  tags: string[];
  /** Inferred actionable intent from classifier (when no explicit bracket tag). */
  detectedIntent?: DetectedIntent;
  /** Proposed actions extracted by the classifier (e.g. payment details). */
  proposedActions?: Array<{
    type: string;
    confidence: number;
    params: Record<string, string>;
  }>;
}

// ============================================================================
// Embedding provider interface
// ============================================================================

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dim: number;
  readonly name: string;
}

// ============================================================================
// LanceDB row template builders
// ============================================================================

/**
 * Return a "schema seed" row for a given table.
 * LanceDB infers its schema from the first row inserted.
 * We insert a dummy row and immediately delete it.
 */
export function schemaSeed(
  table: string,
  vectorDim: number,
  buckets: readonly string[],
): Record<string, unknown> {
  const zeroVec = new Array(vectorDim).fill(0);

  // System tables have fixed schemas
  switch (table) {
    case "inbox":
      return {
        id: "__schema__",
        rawText: "",
        source: "drop",
        timestamp: "",
        mediaPath: "",
        inputTag: "",
        status: "pending",
        vector: zeroVec,
      };

    case "needs_review":
      return {
        id: "__schema__",
        inboxId: "",
        rawText: "",
        suggestedBucket: "",
        confidence: 0,
        title: "",
        summary: "",
        timestamp: "",
        status: "pending",
        vector: zeroVec,
      };

    case "audit_trail":
      return {
        id: "__schema__",
        timestamp: "",
        action: "captured",
        inputId: "",
        outputId: "",
        bucket: "",
        confidence: 0,
        details: "",
        tokenCost: 0,
      };
  }

  // Bucket-specific schemas (known buckets get special handling)
  if (buckets.includes(table)) {
    return getBucketSchemaSeed(table, zeroVec);
  }

  // Generic bucket schema for custom buckets
  return {
    id: "__schema__",
    title: "",
    description: "",
    summary: "",
    category: "",
    status: "",
    nextActions: "[]",
    dueDate: "",
    entries: "[]",
    tags: "[]",
    actions: "[]",
    vector: zeroVec,
  };
}

/**
 * Get bucket-specific schema seed for known bucket types.
 */
function getBucketSchemaSeed(bucket: string, zeroVec: number[]): Record<string, unknown> {
  switch (bucket) {
    case "people":
      return {
        id: "__schema__",
        name: "",
        context: "",
        company: "",
        contactInfo: "",
        nextActions: "[]",
        followUpDate: "",
        lastInteraction: "",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "projects":
      return {
        id: "__schema__",
        name: "",
        description: "",
        status: "active",
        nextActions: "[]",
        blockers: "[]",
        relatedPeople: "[]",
        dueDate: "",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "ideas":
      return {
        id: "__schema__",
        title: "",
        description: "",
        nextActions: "[]",
        potential: "explore",
        relatedTo: "[]",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "admin":
      return {
        id: "__schema__",
        title: "",
        category: "other",
        nextActions: "[]",
        dueDate: "",
        recurring: "",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "documents":
      return {
        id: "__schema__",
        title: "",
        summary: "",
        sourceUrl: "",
        filePath: "",
        nextActions: "[]",
        relatedTo: "[]",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "goals":
      return {
        id: "__schema__",
        title: "",
        description: "",
        timeframe: "short-term",
        status: "active",
        milestones: "[]",
        nextActions: "[]",
        relatedProjects: "[]",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "health":
      return {
        id: "__schema__",
        title: "",
        category: "wellness",
        description: "",
        nextActions: "[]",
        provider: "",
        followUpDate: "",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    case "finance":
      return {
        id: "__schema__",
        title: "",
        category: "other",
        amount: 0,
        currency: "",
        dueDate: "",
        recurring: "",
        nextActions: "[]",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };

    default:
      // Generic bucket
      return {
        id: "__schema__",
        title: "",
        description: "",
        summary: "",
        category: "",
        status: "",
        nextActions: "[]",
        dueDate: "",
        entries: "[]",
        tags: "[]",
        actions: "[]",
        vector: zeroVec,
      };
  }
}
