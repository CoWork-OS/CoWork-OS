import type Database from "better-sqlite3";
import type { MemoryObservationMetadata } from "../../shared/types";
import { upsertMemoryEmbeddingRows } from "../database/memory-embedding-sql";
import { stricterPrivacyState } from "./memory-visibility";

/**
 * The writes of one memory capture as SQL only (async SQLite migration plan, DB6): the
 * memory row, its embedding and its structured observation. The host computes every
 * value (ids, timestamps, the summary, the embedding, the observation), so the same
 * function runs on the host connection or in the database worker, in one transaction.
 */

export type ObservationMetadataRow = Omit<
  MemoryObservationMetadata,
  "content" | "estimatedDetailTokens"
>;

export interface CapturedMemoryWrite {
  memory: {
    id: string;
    workspaceId: string;
    taskId: string | null;
    type: string;
    content: string;
    summary: string | null;
    tokens: number;
    isCompressed: boolean;
    isPrivate: boolean;
    createdAt: number;
    updatedAt: number;
  };
  embedding?: { values: number[]; updatedAt: number };
  observation?: ObservationMetadataRow;
  /**
   * Content-hash dedupe (audit DATA-2): when a memory of the same workspace and type with
   * the same normalized content hash was created at or after `since`, nothing is
   * inserted; that memory's reference count and `last_referenced_at` are bumped instead.
   */
  dedupe?: CaptureDedupe;
}

export interface CaptureDedupe {
  /** `observationContentHash` of the memory's content. */
  contentHash: string;
  /** Oldest `created_at` a duplicate may have (the retention window). */
  since: number;
}

export interface CapturedMemoryResult {
  observationStored: boolean;
  /** Set when the capture matched an existing memory and nothing was inserted. */
  duplicateOf?: string;
}

const MAX_ARRAY_ITEMS = 12;

function stringifyArray(value: string[] | undefined): string {
  return JSON.stringify(
    (value || [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_ARRAY_ITEMS),
  );
}

export function insertMemoryRow(
  db: Database.Database,
  memory: CapturedMemoryWrite["memory"],
): void {
  db.prepare(`
    INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.workspaceId,
    memory.taskId,
    memory.type,
    memory.content,
    memory.summary,
    memory.tokens,
    memory.isCompressed ? 1 : 0,
    memory.isPrivate ? 1 : 0,
    memory.createdAt,
    memory.updatedAt,
  );
}

/**
 * Store a memory's structured observation; a near-identical recent capture is marked.
 *
 * Regenerating an existing row (Rebuild Metadata, a source re-sync) never loosens its
 * privacy: a suppressed (deleted), redacted or private row keeps that state. A
 * migration rebuild also leaves manually edited rows (`generated_by = 'manual'`) alone.
 */
export function writeObservationMetadata(
  db: Database.Database,
  metadata: ObservationMetadataRow,
): { duplicate: boolean } {
  const current = db
    .prepare(
      "SELECT privacy_state, generated_by FROM memory_observation_metadata WHERE memory_id = ?",
    )
    .get(metadata.memoryId) as { privacy_state?: string; generated_by?: string } | undefined;
  if (current && current.generated_by === "manual" && metadata.generatedBy === "migration") {
    return { duplicate: false };
  }
  if (current) {
    metadata = {
      ...metadata,
      privacyState: stricterPrivacyState(current.privacy_state, metadata.privacyState),
    };
  }
  const existing = db
    .prepare(
      `SELECT memory_id FROM memory_observation_metadata
       WHERE workspace_id = ? AND content_hash = ? AND created_at BETWEEN ? AND ?
       LIMIT 1`,
    )
    .get(
      metadata.workspaceId,
      metadata.contentHash,
      metadata.createdAt - 5 * 60 * 1000,
      metadata.createdAt + 5 * 60 * 1000,
    ) as { memory_id?: string } | undefined;
  // An upsert, not INSERT OR REPLACE: REPLACE deletes the old row without firing the FTS
  // delete trigger and leaves a stale index entry (audit DATA-8); the update trigger keeps
  // memory_observation_metadata_fts in step.
  db.prepare(`
    INSERT INTO memory_observation_metadata (
      memory_id, workspace_id, task_id, origin, observation_type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, tools, source_event_ids, content_hash,
      capture_reason, privacy_state, generated_by, migration_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      task_id = excluded.task_id,
      origin = excluded.origin,
      observation_type = excluded.observation_type,
      title = excluded.title,
      subtitle = excluded.subtitle,
      narrative = excluded.narrative,
      facts = excluded.facts,
      concepts = excluded.concepts,
      files_read = excluded.files_read,
      files_modified = excluded.files_modified,
      tools = excluded.tools,
      source_event_ids = excluded.source_event_ids,
      content_hash = excluded.content_hash,
      capture_reason = excluded.capture_reason,
      privacy_state = excluded.privacy_state,
      generated_by = excluded.generated_by,
      migration_status = excluded.migration_status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(
    metadata.memoryId,
    metadata.workspaceId,
    metadata.taskId || null,
    metadata.origin,
    metadata.observationType,
    metadata.title,
    metadata.subtitle || null,
    metadata.narrative,
    stringifyArray(metadata.facts),
    stringifyArray(metadata.concepts),
    stringifyArray(metadata.filesRead),
    stringifyArray(metadata.filesModified),
    stringifyArray(metadata.tools),
    stringifyArray(metadata.sourceEventIds),
    metadata.contentHash,
    existing?.memory_id ? "duplicate_memory_capture" : metadata.captureReason,
    metadata.privacyState,
    metadata.generatedBy,
    metadata.migrationStatus,
    metadata.createdAt,
    metadata.updatedAt,
  );
  return { duplicate: Boolean(existing?.memory_id) };
}

/**
 * The oldest memory of the same workspace and type whose normalized content hash matches,
 * created inside the dedupe window. The observation hash index answers most lookups; rows
 * without an observation (structured observations off) fall back to exact content.
 */
export function findDuplicateCapture(
  db: Database.Database,
  memory: CapturedMemoryWrite["memory"],
  dedupe: CaptureDedupe,
): string | null {
  const byHash = db
    .prepare(
      `SELECT m.id FROM memory_observation_metadata o
       JOIN memories m ON m.id = o.memory_id
       WHERE o.workspace_id = ? AND o.content_hash = ? AND m.type = ? AND m.created_at >= ?
       ORDER BY m.created_at ASC
       LIMIT 1`,
    )
    .get(memory.workspaceId, dedupe.contentHash, memory.type, dedupe.since) as
    | { id?: string }
    | undefined;
  if (byHash?.id) return byHash.id;
  const byContent = db
    .prepare(
      `SELECT id FROM memories
       WHERE workspace_id = ? AND type = ? AND created_at >= ? AND content = ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(memory.workspaceId, memory.type, dedupe.since, memory.content) as
    | { id?: string }
    | undefined;
  return byContent?.id ?? null;
}

/**
 * Apply one capture inside the caller's transaction. The observation is an auxiliary
 * index: it commits in a savepoint, so its failure keeps the memory (as before).
 *
 * A duplicate (see `CapturedMemoryWrite.dedupe`) inserts nothing and only bumps the
 * existing row's reference bookkeeping; `updated_at` is left alone so the stored
 * embedding stays current and the FTS update trigger does not fire.
 */
export function insertCapturedMemory(
  db: Database.Database,
  write: CapturedMemoryWrite,
): CapturedMemoryResult {
  if (write.dedupe) {
    const duplicateOf = findDuplicateCapture(db, write.memory, write.dedupe);
    if (duplicateOf) {
      db.prepare(
        `UPDATE memories
         SET reference_count = COALESCE(reference_count, 0) + 1,
             last_referenced_at = MAX(COALESCE(last_referenced_at, 0), ?)
         WHERE id = ?`,
      ).run(write.memory.createdAt, duplicateOf);
      return { observationStored: false, duplicateOf };
    }
  }
  insertMemoryRow(db, write.memory);
  if (write.embedding) {
    upsertMemoryEmbeddingRows(
      db,
      [
        {
          memoryId: write.memory.id,
          workspaceId: write.memory.workspaceId,
          embedding: write.embedding.values,
          updatedAt: write.embedding.updatedAt,
        },
      ],
      { ifCurrent: false },
    );
  }
  if (!write.observation) return { observationStored: false };
  const observation = write.observation;
  try {
    db.transaction(() => writeObservationMetadata(db, observation))();
    return { observationStored: true };
  } catch {
    return { observationStored: false };
  }
}
