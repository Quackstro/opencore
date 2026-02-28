/**
 * Brain Core — LanceDB store manager.
 *
 * Manages tables: inbox, configurable main buckets, needs_review, audit_trail.
 * Follows the lazy-init pattern from doc-RAG.
 *
 * Store location: configurable (default ~/.openclaw/brain/)
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { SYSTEM_TABLES, getAllTables, schemaSeed } from "./schemas.js";

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  record: Record<string, unknown>;
  score: number;
}

export interface BucketStats {
  table: string;
  count: number;
}

export interface BrainStoreConfig {
  dbPath: string;
  vectorDim?: number;
  buckets: readonly string[];
}

// ============================================================================
// BrainStore
// ============================================================================

export class BrainStore {
  private db: lancedb.Connection | null = null;
  private tables: Map<string, lancedb.Table> = new Map();
  private initPromise: Promise<void> | null = null;
  private readonly allTables: string[];

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number = 1536,
    private readonly buckets: readonly string[] = [],
  ) {
    this.allTables = getAllTables(buckets);
  }

  /**
   * Get the configured bucket names.
   */
  getBuckets(): readonly string[] {
    return this.buckets;
  }

  /**
   * Get all table names (buckets + system tables).
   */
  getAllTableNames(): string[] {
    return this.allTables;
  }

  // --------------------------------------------------------------------------
  // Lazy initialization
  // --------------------------------------------------------------------------

  async ensureInitialized(): Promise<void> {
    if (this.db && this.tables.size === this.allTables.length) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await fs.mkdir(this.dbPath, { recursive: true });
    this.db = await lancedb.connect(this.dbPath);
    const existingTables = await this.db.tableNames();

    for (const tableName of this.allTables) {
      if (existingTables.includes(tableName)) {
        this.tables.set(tableName, await this.db.openTable(tableName));
      } else {
        // Create table with schema seed, then delete the seed row
        const seed = schemaSeed(tableName, this.vectorDim, this.buckets);
        const table = await this.db.createTable(tableName, [seed]);
        await table.delete("id = '__schema__'");
        this.tables.set(tableName, table);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Table accessor
  // --------------------------------------------------------------------------

  private async getTable(name: string): Promise<lancedb.Table> {
    await this.ensureInitialized();
    const table = this.tables.get(name);
    if (!table) throw new Error(`Table not found: ${name}`);
    return table;
  }

  // --------------------------------------------------------------------------
  // CRUD operations
  // --------------------------------------------------------------------------

  /**
   * Create a record in the specified table.
   * Auto-generates `id` if not provided.
   */
  async create(
    tableName: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const table = await this.getTable(tableName);

    const row = {
      ...record,
      id: (record.id as string) || randomUUID(),
    };

    await table.add([row]);
    return row;
  }

  /**
   * Get a record by ID from the specified table.
   * Returns null if not found.
   */
  async get(tableName: string, id: string): Promise<Record<string, unknown> | null> {
    const table = await this.getTable(tableName);
    const rows = await table
      .query()
      .where(`id = '${this.esc(id)}'`)
      .limit(1)
      .toArray();

    if (rows.length === 0) return null;
    return this.cleanRow(rows[0]);
  }

  /**
   * Update a record by ID. Performs delete + re-insert (LanceDB pattern).
   * Returns the updated record or null if not found.
   */
  async update(
    tableName: string,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const table = await this.getTable(tableName);

    // Read existing
    const existing = await this.get(tableName, id);
    if (!existing) return null;

    // Delete old row
    await table.delete(`id = '${this.esc(id)}'`);

    // Merge updates
    const updated = { ...existing, ...updates, id };

    // Re-insert
    await table.add([updated]);
    return updated;
  }

  /**
   * Delete a record by ID from the specified table.
   * Returns true if the record existed and was deleted.
   */
  async delete(tableName: string, id: string): Promise<boolean> {
    const table = await this.getTable(tableName);

    const existing = await this.get(tableName, id);
    if (!existing) return false;

    await table.delete(`id = '${this.esc(id)}'`);
    return true;
  }

  /**
   * List all records in a table, with optional limit.
   */
  async list(tableName: string, limit?: number): Promise<Record<string, unknown>[]> {
    const table = await this.getTable(tableName);
    let query = table.query();
    if (limit) query = query.limit(limit);
    const rows = await query.toArray();
    return rows.map((r) => this.cleanRow(r));
  }

  /**
   * Count records in a table.
   */
  async count(tableName: string): Promise<number> {
    const table = await this.getTable(tableName);
    return table.countRows();
  }

  // --------------------------------------------------------------------------
  // Semantic search
  // --------------------------------------------------------------------------

  /**
   * Vector similarity search within a table.
   * Only works on tables that have a `vector` column (not audit_trail).
   */
  async search(
    tableName: string,
    vector: number[],
    limit: number = 5,
    filter?: string,
  ): Promise<SearchResult[]> {
    if (tableName === "audit_trail") {
      throw new Error("audit_trail does not support vector search");
    }

    const table = await this.getTable(tableName);
    let searchBuilder = table.vectorSearch(vector).limit(limit * 2);

    if (filter) {
      searchBuilder = searchBuilder.where(filter);
    }

    const rows = await searchBuilder.toArray();

    return rows.slice(0, limit).map((row) => {
      const distance = (row._distance as number) ?? 0;
      const score = 1 / (1 + distance);
      return {
        record: this.cleanRow(row),
        score,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  /**
   * Get record counts for all tables.
   */
  async stats(): Promise<BucketStats[]> {
    await this.ensureInitialized();
    const results: BucketStats[] = [];
    for (const tableName of this.allTables) {
      const count = await this.count(tableName);
      results.push({ table: tableName, count });
    }
    return results;
  }

  /**
   * Measure total disk usage in MB.
   */
  async diskUsageMb(): Promise<number> {
    return dirSizeMb(this.dbPath);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /** Escape single quotes for LanceDB SQL-like filter strings. */
  private esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Clean a LanceDB row: convert Arrow typed arrays to plain JS arrays,
   * strip internal fields like _distance, _rowid.
   */
  private cleanRow(row: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("_")) continue; // Skip _distance, _rowid, etc.
      cleaned[key] = toPlainValue(value);
    }
    return cleaned;
  }
}

// ============================================================================
// Filesystem helpers
// ============================================================================

/**
 * Convert Arrow typed arrays (Float32Array, etc.) to plain JS arrays.
 * Leaves strings, numbers, booleans, and nulls as-is.
 */
function toPlainValue(value: unknown): unknown {
  if (value == null) return value;
  // Primitives pass through unchanged
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // Plain JS arrays pass through
  if (Array.isArray(value)) return value;
  // Arrow typed arrays (Float32Array, etc.) → plain number[]
  if (typeof (value as any)[Symbol.iterator] === "function") {
    return Array.from(value as Iterable<number>);
  }
  return value;
}

/**
 * Recursively compute total size of a directory in MB.
 */
async function dirSizeMb(dirPath: string): Promise<number> {
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          totalBytes += stat.size;
        } catch {
          // file disappeared
        }
      }
    }
  }

  await walk(dirPath);
  return totalBytes / (1024 * 1024);
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Create a BrainStore instance from config.
 */
export function createBrainStore(config: BrainStoreConfig): BrainStore {
  return new BrainStore(config.dbPath, config.vectorDim ?? 1536, config.buckets);
}
