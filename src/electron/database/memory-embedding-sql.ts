import type Database from "better-sqlite3";

/**
 * Writing memory embeddings, shared by `MemoryEmbeddingRepository` on the host and the
 * database worker's `memory.upsertEmbeddings` (async SQLite migration plan, DB4).
 */

export interface MemoryEmbeddingRow {
  memoryId: string;
  workspaceId: string;
  embedding: number[];
  /** The memory's `updated_at` the embedding was computed from. */
  updatedAt: number;
}

export const MAX_EMBEDDING_UPSERT_ROWS = 500;

/**
 * Upsert embeddings inside the caller's transaction; returns the ids written.
 *
 * With `ifCurrent`, a row is skipped when its memory is gone or has been updated past
 * the row's `updatedAt`, and never replaces a stored embedding computed from a newer
 * version: a slow backfill cannot overwrite a fresher embedding. Without it the row
 * is written as given, the repository's long-standing `upsert` behaviour.
 */
export function upsertMemoryEmbeddingRows(
  db: Database.Database,
  rows: readonly MemoryEmbeddingRow[],
  options: { ifCurrent: boolean },
): string[] {
  if (rows.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at)
    SELECT @memoryId, @workspaceId, @embedding, @updatedAt
    WHERE @ifCurrent = 0
       OR EXISTS (SELECT 1 FROM memories m WHERE m.id = @memoryId AND m.updated_at <= @updatedAt)
    ON CONFLICT(memory_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
    WHERE @ifCurrent = 0 OR memory_embeddings.updated_at <= excluded.updated_at
  `);
  const written: string[] = [];
  const ifCurrent = options.ifCurrent ? 1 : 0;
  for (const row of rows) {
    const { changes } = stmt.run({
      memoryId: row.memoryId,
      workspaceId: row.workspaceId,
      embedding: JSON.stringify(row.embedding),
      updatedAt: row.updatedAt,
      ifCurrent,
    });
    if (changes > 0) written.push(row.memoryId);
  }
  return written;
}
