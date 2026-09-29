import type Database from "better-sqlite3";
import { buildImportedMemoryFilterSql } from "../database/fts-utils";

/**
 * Embedding cache for the FTS worker's own connection (async SQLite migration plan,
 * DB4). The host reports every repository write or delete; the affected rows are
 * reloaded at the next search. Rows removed without the repository (a cascade from a
 * deleted memory) only cost semantic candidate slots, because the ranking loads full
 * rows and drops missing ones; a periodic full reload bounds even that.
 */

export type EmbeddingInvalidation =
  | { kind: "memories"; memoryIds: string[] }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "all" };

interface CachedEmbedding {
  embedding: Float32Array;
}

const MAX_IMPORTED_EMBEDDINGS = 200_000;
const RELOAD_CHUNK = 500;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;

function parseEmbedding(raw: unknown): Float32Array | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0
      ? Float32Array.from(parsed as number[])
      : null;
  } catch {
    return null;
  }
}

export interface MissingEmbeddingRow {
  memoryId: string;
  workspaceId: string;
  updatedAt: number;
  content: string;
  summary?: string;
}

function mapMissing(rows: Array<Record<string, unknown>>): MissingEmbeddingRow[] {
  return rows.map((row) => ({
    memoryId: row.memory_id as string,
    workspaceId: row.workspace_id as string,
    updatedAt: row.updated_at as number,
    content: row.content as string,
    summary: (row.summary as string) || undefined,
  }));
}

/**
 * Memories whose embedding is missing or older than the memory: the same queries as
 * `MemoryEmbeddingRepository.findMissingOrStale` and `findMissingOrStaleImportedGlobal`,
 * run in the FTS worker so the embedding backfill's scans stay off the host (DB4).
 */
export function findMissingEmbeddingRows(
  db: Database.Database,
  workspaceId: string | null,
  limit: number,
): MissingEmbeddingRow[] {
  const scope =
    workspaceId === null ? buildImportedMemoryFilterSql("m.content") : "m.workspace_id = ?";
  const rows = db
    .prepare(
      `SELECT m.id AS memory_id, m.workspace_id, m.updated_at, m.content, m.summary
       FROM memories m
       LEFT JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE ${scope}
         AND (e.memory_id IS NULL OR e.updated_at < m.updated_at)
       ORDER BY m.updated_at DESC
       LIMIT ?`,
    )
    .all(...(workspaceId === null ? [limit] : [workspaceId, limit])) as Array<
    Record<string, unknown>
  >;
  return mapMissing(rows);
}

export class MemoryEmbeddingCache {
  private readonly byWorkspace = new Map<string, Map<string, CachedEmbedding>>();
  private imported: Map<string, CachedEmbedding> | null = null;
  private readonly dirty = new Set<string>();
  private loadedAt = Date.now();

  constructor(
    private readonly db: Database.Database,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
  ) {}

  invalidate(change: EmbeddingInvalidation): void {
    if (change.kind === "all") {
      this.byWorkspace.clear();
      this.imported = null;
      this.dirty.clear();
      return;
    }
    if (change.kind === "workspace") {
      this.byWorkspace.delete(change.workspaceId);
      // Imported-global entries may belong to that workspace.
      this.imported = null;
      return;
    }
    for (const id of change.memoryIds) this.dirty.add(id);
  }

  workspace(workspaceId: string): Map<string, CachedEmbedding> {
    this.refresh();
    let map = this.byWorkspace.get(workspaceId);
    if (!map) {
      map = new Map();
      const rows = this.db
        .prepare("SELECT memory_id, embedding FROM memory_embeddings WHERE workspace_id = ?")
        .all(workspaceId) as Array<{ memory_id: string; embedding: string }>;
      for (const row of rows) {
        const embedding = parseEmbedding(row.embedding);
        if (embedding) map.set(row.memory_id, { embedding });
      }
      this.byWorkspace.set(workspaceId, map);
    }
    return map;
  }

  importedGlobal(): Map<string, CachedEmbedding> {
    this.refresh();
    if (!this.imported) {
      const map = new Map<string, CachedEmbedding>();
      const rows = this.db
        .prepare(
          `SELECT e.memory_id, e.embedding
           FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id
           WHERE ${buildImportedMemoryFilterSql("m.content")}
           ORDER BY e.updated_at DESC
           LIMIT ?`,
        )
        .all(MAX_IMPORTED_EMBEDDINGS) as Array<{ memory_id: string; embedding: string }>;
      for (const row of rows) {
        const embedding = parseEmbedding(row.embedding);
        if (embedding) map.set(row.memory_id, { embedding });
      }
      this.imported = map;
    }
    return this.imported;
  }

  private refresh(): void {
    if (Date.now() - this.loadedAt > this.maxAgeMs) {
      this.invalidate({ kind: "all" });
      this.loadedAt = Date.now();
      return;
    }
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const map of this.byWorkspace.values()) for (const id of ids) map.delete(id);
    for (const id of ids) this.imported?.delete(id);
    for (let index = 0; index < ids.length; index += RELOAD_CHUNK) {
      const chunk = ids.slice(index, index + RELOAD_CHUNK);
      const rows = this.db
        .prepare(
          `SELECT e.memory_id, e.workspace_id, e.embedding,
                  CASE WHEN ${buildImportedMemoryFilterSql("m.content")} THEN 1 ELSE 0 END AS imported
           FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id
           WHERE e.memory_id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as Array<{
        memory_id: string;
        workspace_id: string;
        embedding: string;
        imported: number;
      }>;
      for (const row of rows) {
        const embedding = parseEmbedding(row.embedding);
        if (!embedding) continue;
        this.byWorkspace.get(row.workspace_id)?.set(row.memory_id, { embedding });
        if (row.imported === 1) this.imported?.set(row.memory_id, { embedding });
      }
    }
  }
}
