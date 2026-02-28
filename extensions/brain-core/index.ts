/**
 * Brain Core — OpenClaw Plugin Entry Point.
 *
 * Generic bucket-based memory system with LLM classification.
 * Captures thoughts, classifies them into configurable buckets,
 * and provides semantic search.
 *
 * This is the core engine — personal integrations (payments, calendars)
 * should be added via separate plugins or the clawd workspace.
 */

import { Type } from "@sinclair/typebox";
import { getAuditTrail } from "./audit.js";
import { createClassifier, type ClassifierFn } from "./classifier.js";
import { handleDrop } from "./commands/drop.js";
import { handleFix } from "./commands/fix.js";
import { createEmbeddingProvider, getVectorDimension } from "./embeddings.js";
import { DEFAULT_BUCKETS, SYSTEM_TABLES, type EmbeddingProvider } from "./schemas.js";
import { BrainStore } from "./store.js";

// ============================================================================
// Re-exports for extension consumers
// ============================================================================

export { BrainStore, type BrainStoreConfig } from "./store.js";
export * from "./schemas.js";
export {
  createEmbeddingProvider,
  BrainGeminiEmbeddings,
  BrainOpenAIEmbeddings,
  getVectorDimension,
} from "./embeddings.js";
export {
  createClassifier,
  classifyText,
  bucketToTable,
  type ClassifierFn,
  type ClassifyOptions,
  type ClassifyResult,
} from "./classifier.js";
export { parseInputTags, tagToIntent, type InputTag, type TagParseResult } from "./tag-parser.js";
export { logAudit, getAuditTrail, type AuditAction, type LogAuditParams } from "./audit.js";
export {
  routeClassification,
  checkConfidence,
  buildBucketRecord,
  cosineSimilarity,
  checkDuplicate,
  mergeIntoExisting,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEDUP_SIMILARITY_THRESHOLD,
} from "./router.js";
export {
  handleDrop,
  dropAndClassify,
  ocrImage,
  type DropResult,
  type DropOptions,
} from "./commands/drop.js";
export { handleFix, type FixResult } from "./commands/fix.js";

// ============================================================================
// Config parser
// ============================================================================

interface BrainCoreConfig {
  storage: {
    dbPath: string;
  };
  buckets: readonly string[];
  embedding: {
    provider?: "gemini" | "openai" | "auto";
    apiKey: string;
    model?: string;
    baseURL?: string;
  };
  classifier: {
    apiKey?: string;
    model?: string;
  };
  confidenceThreshold: number;
}

function parseConfig(raw: unknown): BrainCoreConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;

  const embRaw = (cfg.embedding ?? {}) as Record<string, unknown>;
  if (typeof embRaw.apiKey !== "string") {
    // No API key — plugin inactive
    return null;
  }

  const stoRaw = (cfg.storage ?? {}) as Record<string, unknown>;
  const classRaw = (cfg.classifier ?? {}) as Record<string, unknown>;
  const bucketsRaw = cfg.buckets as string[] | undefined;

  return {
    storage: {
      dbPath: (stoRaw.dbPath as string) ?? "~/.openclaw/brain/lancedb",
    },
    buckets: bucketsRaw && Array.isArray(bucketsRaw) ? bucketsRaw : DEFAULT_BUCKETS,
    embedding: {
      provider: embRaw.provider as "gemini" | "openai" | "auto" | undefined,
      apiKey: embRaw.apiKey as string,
      model: embRaw.model as string | undefined,
      baseURL: embRaw.baseURL as string | undefined,
    },
    classifier: {
      apiKey: classRaw.apiKey as string | undefined,
      model: classRaw.model as string | undefined,
    },
    confidenceThreshold: (cfg.confidenceThreshold as number) ?? 0.8,
  };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const brainCorePlugin = {
  id: "brain-core",
  name: "Brain Core",
  description:
    "Generic bucket-based memory system — captures thoughts, classifies them into " +
    "configurable buckets, and provides semantic search.",
  kind: "memory" as const,

  register(api: any) {
    const cfg = parseConfig(api.pluginConfig);
    if (!cfg) {
      api.logger?.info?.(
        "brain-core: no config provided, plugin inactive. Add brain-core config to openclaw.json to activate.",
      );
      return;
    }

    const resolvedDbPath = api.resolvePath(cfg.storage.dbPath);

    // Create embedding provider
    const embedder = createEmbeddingProvider({
      provider: cfg.embedding.provider,
      apiKey: cfg.embedding.apiKey,
      model: cfg.embedding.model,
      baseURL: cfg.embedding.baseURL,
    });

    // Create store with configured buckets
    const store = new BrainStore(resolvedDbPath, embedder.dim, cfg.buckets);

    // Create classifier (if API key is configured)
    let classifierFn: ClassifierFn | undefined;
    if (cfg.classifier.apiKey) {
      classifierFn = createClassifier({
        apiKey: cfg.classifier.apiKey,
        model: cfg.classifier.model ?? "claude-haiku-3.5",
        buckets: cfg.buckets,
      });
    }

    api.logger.info(
      `brain-core: registered (db: ${resolvedDbPath}, buckets: ${cfg.buckets.length}, embeddings: ${embedder.name}, classifier: ${classifierFn ? "active" : "no API key"})`,
    );

    // Store references for extension consumers
    (api as any)._brainCore = {
      store,
      embedder,
      classifierFn,
      config: cfg,
    };

    // ==================================================================
    // Tool: brain_drop
    // ==================================================================

    api.registerTool(
      {
        name: "brain_drop",
        label: "Brain Drop",
        description:
          "Capture a thought into the Brain. One thought per drop — no organizing needed. " +
          "Automatically classifies and routes to the appropriate bucket.",
        parameters: Type.Object({
          text: Type.String({ description: "The raw thought to capture" }),
          source: Type.Optional(
            Type.String({
              description: "Source: drop, chat, file, voice, photo",
              enum: ["drop", "chat", "file", "voice", "photo"],
            }),
          ),
          mediaPath: Type.Optional(
            Type.String({ description: "Path to attached media (for photo OCR)" }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const text = params.text ?? params.command;
            if (!text) {
              return {
                content: [{ type: "text", text: "❌ No text provided." }],
                details: { error: true },
              };
            }

            const result = await handleDrop(
              store,
              embedder,
              text,
              params.source ?? "drop",
              params.mediaPath,
              {
                classifierFn,
                confidenceThreshold: cfg.confidenceThreshold,
                async: true,
                buckets: cfg.buckets,
              },
            );
            return {
              content: [{ type: "text", text: result.message }],
              details: { ...result, inputTag: result.inputTag ?? null },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Drop failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "brain_drop" },
    );

    // ==================================================================
    // Tool: brain_search
    // ==================================================================

    api.registerTool(
      {
        name: "brain_search",
        label: "Brain Search",
        description:
          "Search Brain stores by semantic similarity. Query across all buckets or a specific one.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query" }),
          bucket: Type.Optional(
            Type.String({
              description: `Specific bucket to search (${cfg.buckets.join(", ")})`,
            }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const vector = await embedder.embed(params.query);
            const limit = params.limit ?? 5;
            const bucketsToSearch = params.bucket ? [params.bucket] : [...cfg.buckets];

            const allResults: Array<{
              bucket: string;
              record: Record<string, unknown>;
              score: number;
            }> = [];

            for (const bucket of bucketsToSearch) {
              try {
                const results = await store.search(bucket, vector, limit);
                for (const r of results) {
                  allResults.push({ bucket, ...r });
                }
              } catch {
                // Skip empty tables or errors
              }
            }

            // Sort by score descending
            allResults.sort((a, b) => b.score - a.score);
            const topResults = allResults.slice(0, limit);

            if (topResults.length === 0) {
              return {
                content: [{ type: "text", text: "No results found." }],
                details: { count: 0 },
              };
            }

            const text = topResults
              .map(
                (r, i) =>
                  `${i + 1}. [${r.bucket}] ${(r.record as any).title || (r.record as any).name || r.record.id} (${(r.score * 100).toFixed(0)}%)`,
              )
              .join("\n");

            return {
              content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${text}` }],
              details: { count: topResults.length, results: topResults },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Search failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "brain_search" },
    );

    // ==================================================================
    // Tool: brain_stats
    // ==================================================================

    api.registerTool(
      {
        name: "brain_stats",
        label: "Brain Stats",
        description: "Show record counts and health for all Brain buckets.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const stats = await store.stats();
            const lines = stats.map((s) => `  ${s.table}: ${s.count} records`);
            const total = stats.reduce((sum, s) => sum + s.count, 0);
            const disk = await store.diskUsageMb();
            lines.push(`\n  Total: ${total} records`);
            lines.push(`  Disk: ${disk.toFixed(1)} MB`);
            return {
              content: [{ type: "text", text: `📊 Brain Stats:\n${lines.join("\n")}` }],
              details: { stats, totalRecords: total, diskMb: disk },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Stats failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "brain_stats" },
    );

    // ==================================================================
    // Tool: brain_audit
    // ==================================================================

    api.registerTool(
      {
        name: "brain_audit",
        label: "Brain Audit Trail",
        description: "View the audit trail for a specific item or recent actions.",
        parameters: Type.Object({
          inputId: Type.Optional(
            Type.String({ description: "Show audit entries for this input ID" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max entries to show (default 10)" })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            let entries: Record<string, unknown>[];
            if (params.inputId) {
              entries = await getAuditTrail(store, params.inputId);
            } else {
              entries = await store.list("audit_trail", params.limit ?? 10);
            }

            if (entries.length === 0) {
              return {
                content: [{ type: "text", text: "No audit entries found." }],
                details: { count: 0 },
              };
            }

            const text = entries
              .map((e) => `[${(e.timestamp as string).slice(0, 19)}] ${e.action} — ${e.details}`)
              .join("\n");

            return {
              content: [
                { type: "text", text: `📋 Audit Trail (${entries.length} entries):\n\n${text}` },
              ],
              details: { count: entries.length, entries },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Audit query failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "brain_audit" },
    );

    // ==================================================================
    // Tool: brain_fix
    // ==================================================================

    api.registerTool(
      {
        name: "brain_fix",
        label: "Brain Fix",
        description:
          "Fix/correct a Brain item: move between buckets, trash, update actions, merge items, or show details.",
        parameters: Type.Object({
          id: Type.String({ description: "The item ID to fix" }),
          correction: Type.Optional(
            Type.String({
              description:
                'Fix syntax: "→ people", "→ trash", "action: call them", "merge abc123", or omit to show details',
            }),
          ),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const result = await handleFix(
              store,
              params.id,
              params.correction,
              cfg.buckets,
              embedder,
            );
            return {
              content: [{ type: "text", text: result.message }],
              details: result,
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `Fix failed: ${err.message ?? err}` }],
              details: { error: true },
            };
          }
        },
      },
      { name: "brain_fix" },
    );

    // ==================================================================
    // CLI Commands
    // ==================================================================

    api.registerCli(
      ({ program }: any) => {
        const brain = program.command("brain").description("Brain Core plugin commands");

        brain
          .command("stats")
          .description("Show bucket counts")
          .action(async () => {
            const stats = await store.stats();
            for (const s of stats) {
              console.log(`  ${s.table}: ${s.count}`);
            }
          });

        brain
          .command("list")
          .description("List records in a bucket")
          .argument("<bucket>", "Bucket name")
          .option("--limit <n>", "Max records", "20")
          .action(async (bucket: string, opts: any) => {
            const records = await store.list(bucket, parseInt(opts.limit));
            if (records.length === 0) {
              console.log(`No records in ${bucket}.`);
              return;
            }
            for (const r of records) {
              const label = (r as any).title || (r as any).name || r.id;
              console.log(`  ${(r.id as string).slice(0, 8)}  ${label}`);
            }
          });

        brain
          .command("drop")
          .description("Drop a thought into the Brain")
          .argument("<text>", "The thought to capture")
          .option("--source <source>", "Source type", "drop")
          .action(async (text: string, opts: any) => {
            const result = await handleDrop(
              store,
              embedder,
              text,
              opts.source ?? "drop",
              undefined,
              {
                classifierFn,
                confidenceThreshold: cfg.confidenceThreshold,
                async: false,
                buckets: cfg.buckets,
              },
            );
            console.log(result.message);
            console.log(`  ID: ${result.id}`);
          });

        brain
          .command("audit")
          .description("Show audit trail")
          .option("--id <inputId>", "Filter by input ID")
          .option("--limit <n>", "Max entries", "20")
          .action(async (opts: any) => {
            let entries: Record<string, unknown>[];
            if (opts.id) {
              entries = await getAuditTrail(store, opts.id);
            } else {
              entries = await store.list("audit_trail", parseInt(opts.limit));
            }
            if (entries.length === 0) {
              console.log("No audit entries.");
              return;
            }
            for (const e of entries) {
              console.log(`  [${(e.timestamp as string).slice(0, 19)}] ${e.action} — ${e.details}`);
            }
          });
      },
      { commands: ["brain"] },
    );

    // ==================================================================
    // Service
    // ==================================================================

    api.registerService({
      id: "brain-core",
      start: () => {
        api.logger.info(`brain-core: initialized (db: ${resolvedDbPath})`);
      },
      stop: () => {
        api.logger.info("brain-core: stopped");
      },
    });
  },
};

export default brainCorePlugin;
