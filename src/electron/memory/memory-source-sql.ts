import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import {
  defineReadUnit,
  defineUnit,
  type UnitCatalog,
} from "../database/statements/statement-catalog";
import { int, nullableStr, oneOf, str, strList, tuple } from "../database/statements/unit-args";

/**
 * Where a memory came from (WP15): a workspace file or a connector record, with the file's
 * content hash when the memory was saved. When the source changes, the memory is flagged
 * `needs_recheck` until it is reviewed. One row links one memory to one source.
 *
 * `memory_ref` is `repo-entry:<file>#<entry hash>` for a memory folder entry (the hash
 * survives line moves) or `memory:<item id>` for a memory item.
 */

export const MEMORY_SOURCE_KINDS = ["file", "connector"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemorySourceRow {
  id: string;
  workspaceId: string | null;
  sourceKind: MemorySourceKind;
  /** Workspace-relative path (`/` separators) or the connector record's URI. */
  sourceKey: string;
  /** Absolute path of a file source when it was saved. */
  sourcePath: string | null;
  /** SHA-256 of the file when it was saved or last reviewed. */
  contentHash: string | null;
  observedAt: number;
  memoryRef: string;
  needsRecheck: boolean;
  changedAt: number | null;
  createdAt: number;
}

export interface TrackMemorySourceInput {
  workspaceId: string | null;
  sourceKind: MemorySourceKind;
  sourceKey: string;
  sourcePath: string | null;
  contentHash: string | null;
  memoryRef: string;
  now: number;
}

export function ensureMemorySourcesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_path TEXT,
      content_hash TEXT,
      observed_at INTEGER NOT NULL,
      memory_ref TEXT NOT NULL,
      needs_recheck INTEGER NOT NULL DEFAULT 0,
      changed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(memory_ref, source_kind, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_sources_source
      ON memory_sources(source_kind, source_key);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_recheck
      ON memory_sources(needs_recheck, changed_at DESC);
  `);
}

function mapRow(row: Record<string, unknown>): MemorySourceRow {
  return {
    id: String(row.id),
    workspaceId: (row.workspace_id as string | null) ?? null,
    sourceKind: row.source_kind as MemorySourceKind,
    sourceKey: String(row.source_key),
    sourcePath: (row.source_path as string | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    observedAt: Number(row.observed_at),
    memoryRef: String(row.memory_ref),
    needsRecheck: Number(row.needs_recheck) === 1,
    changedAt:
      row.changed_at === null || row.changed_at === undefined ? null : Number(row.changed_at),
    createdAt: Number(row.created_at),
  };
}

export class MemorySourceStore {
  constructor(private readonly db: Database.Database) {}

  /** Link a memory to its source as of now; a repeated link refreshes it and clears the flag. */
  track(input: TrackMemorySourceInput): MemorySourceRow {
    this.db
      .prepare(
        `INSERT INTO memory_sources (
           id, workspace_id, source_kind, source_key, source_path, content_hash, observed_at,
           memory_ref, needs_recheck, changed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(memory_ref, source_kind, source_key) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           source_path = excluded.source_path,
           content_hash = excluded.content_hash,
           observed_at = excluded.observed_at,
           needs_recheck = 0,
           changed_at = NULL`,
      )
      .run(
        randomUUID(),
        input.workspaceId,
        input.sourceKind,
        input.sourceKey,
        input.sourcePath,
        input.contentHash,
        input.now,
        input.memoryRef,
        input.now,
      );
    const row = this.db
      .prepare(
        "SELECT * FROM memory_sources WHERE memory_ref = ? AND source_kind = ? AND source_key = ?",
      )
      .get(input.memoryRef, input.sourceKind, input.sourceKey) as Record<string, unknown>;
    return mapRow(row);
  }

  /** The memories that came from one source (a file in a workspace, or a connector record). */
  listForSource(
    sourceKind: MemorySourceKind,
    sourceKey: string,
    workspaceId: string | null,
  ): MemorySourceRow[] {
    const rows =
      workspaceId === null
        ? this.db
            .prepare(
              "SELECT * FROM memory_sources WHERE source_kind = ? AND source_key = ? LIMIT 200",
            )
            .all(sourceKind, sourceKey)
        : this.db
            .prepare(
              `SELECT * FROM memory_sources
               WHERE source_kind = ? AND source_key = ? AND workspace_id = ? LIMIT 200`,
            )
            .all(sourceKind, sourceKey, workspaceId);
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  /** The source changed: these memories need a recheck. */
  markChanged(ids: string[], now: number): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return this.db
      .prepare(
        `UPDATE memory_sources SET needs_recheck = 1, changed_at = ?
         WHERE id IN (${placeholders})`,
      )
      .run(now, ...ids).changes;
  }

  /** Reviewed against the current source: the flag clears and the current hash is kept. */
  markReviewed(id: string, contentHash: string | null, now: number): number {
    return this.db
      .prepare(
        `UPDATE memory_sources
         SET needs_recheck = 0, changed_at = NULL, content_hash = ?, observed_at = ?
         WHERE id = ?`,
      )
      .run(contentHash, now, id).changes;
  }

  listFlagged(limit: number): MemorySourceRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_sources WHERE needs_recheck = 1
           ORDER BY changed_at DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map(mapRow);
  }

  /** Links whose memory no longer exists (rewritten or removed). */
  deleteByIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.prepare(`DELETE FROM memory_sources WHERE id IN (${placeholders})`).run(...ids)
      .changes;
  }
}

const id = (value: unknown, path: string) => str(value, path, 200);
const sourceKind = (value: unknown, path: string) => oneOf(value, path, MEMORY_SOURCE_KINDS);
const time = (value: unknown, path: string) => int(value, path);
const ids = (value: unknown, path: string) => strList(value, path).slice(0, 500);

export const MEMORY_SOURCE_UNITS = {
  memorySources_track: defineUnit(
    tuple((value: unknown, path: string): TrackMemorySourceInput => {
      const input = (value ?? {}) as Record<string, unknown>;
      return {
        workspaceId: nullableStr(input.workspaceId, `${path}.workspaceId`, 200),
        sourceKind: sourceKind(input.sourceKind, `${path}.sourceKind`),
        sourceKey: str(input.sourceKey, `${path}.sourceKey`, 2_048),
        sourcePath: nullableStr(input.sourcePath, `${path}.sourcePath`, 4_096),
        contentHash: nullableStr(input.contentHash, `${path}.contentHash`, 128),
        memoryRef: str(input.memoryRef, `${path}.memoryRef`, 2_048),
        now: time(input.now, `${path}.now`),
      };
    }),
    (db: Database.Database, [input]) => new MemorySourceStore(db).track(input),
  ),
  memorySources_listForSource: defineReadUnit(
    tuple(
      sourceKind,
      (value: unknown, path: string) => str(value, path, 2_048),
      (value, path) => nullableStr(value, path, 200),
    ),
    (db: Database.Database, [kind, key, workspaceId]) =>
      new MemorySourceStore(db).listForSource(kind, key, workspaceId),
  ),
  memorySources_markChanged: defineUnit(tuple(ids, time), (db: Database.Database, [rowIds, now]) =>
    new MemorySourceStore(db).markChanged(rowIds, now),
  ),
  memorySources_markReviewed: defineUnit(
    tuple(id, (value: unknown, path: string) => nullableStr(value, path, 128), time),
    (db: Database.Database, [rowId, hash, now]) =>
      new MemorySourceStore(db).markReviewed(rowId, hash, now),
  ),
  memorySources_listFlagged: defineReadUnit(
    tuple((value: unknown, path: string) => int(value, path, 1, 1_000)),
    (db: Database.Database, [limit]) => new MemorySourceStore(db).listFlagged(limit),
  ),
  memorySources_delete: defineUnit(tuple(ids), (db: Database.Database, [rowIds]) =>
    new MemorySourceStore(db).deleteByIds(rowIds),
  ),
} satisfies UnitCatalog;
