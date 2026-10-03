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
  db.prepare(`
    INSERT OR REPLACE INTO memory_observation_metadata (
      memory_id, workspace_id, task_id, origin, observation_type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, tools, source_event_ids, content_hash,
      capture_reason, privacy_state, generated_by, migration_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 * Apply one capture inside the caller's transaction. The observation is an auxiliary
 * index: it commits in a savepoint, so its failure keeps the memory (as before).
 */
export function insertCapturedMemory(
  db: Database.Database,
  write: CapturedMemoryWrite,
): { observationStored: boolean } {
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
