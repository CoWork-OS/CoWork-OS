import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { fields, int } from "../database/statements/unit-args";
import { upsertMemoryEmbeddingRows } from "../database/memory-embedding-sql";
import { createLocalEmbedding } from "./local-embedding";
import { deriveObservationText } from "./memory-observation-sql";
import {
  buildDeterministicSummary,
  legacyDeterministicSummary,
  memoryEmbeddingText,
} from "./memory-summary";

/**
 * One-time re-index of archive summaries, embeddings and observation text (audit DATA-5),
 * as SQL units of the memory domain (in the database worker when memory is routed there).
 * `MemorySummaryReindex.ts` claims the run and calls one chunk at a time.
 *
 * Per row, oldest first:
 *  - rows deleted or redacted in the Inspector, and rows whose observation was edited by
 *    hand (`generated_by = 'manual'`), are skipped entirely;
 *  - a deterministic summary (empty, or equal to what the old first-line rule produced) is
 *    recomputed with the new rule, and `tokens` becomes the content's estimate. Any other
 *    summary (written by the AI compression, a source sync or a digest) is kept;
 *  - the embedding is rebuilt from the summary and the content;
 *  - an existing observation gets its title, narrative, facts, concepts and file lists
 *    derived again. Its privacy state, origin and provenance are not touched, and no
 *    observation is created (the Rebuild Metadata backfill does that).
 * `updated_at` is not changed, so recency ranking and Inspector order stay as they were.
 * Progress (the last rowid and the counts) is stored with every chunk, so an interrupted
 * run resumes where it stopped; rows created after the run started are already current.
 */

export const MEMORY_SUMMARY_REINDEX_KEY = "memory_summary_reindex_v1";
const PROGRESS_KEY = `${MEMORY_SUMMARY_REINDEX_KEY}:progress`;
export const MEMORY_SUMMARY_REINDEX_MAX_CHUNK = 500;

export interface MemorySummaryReindexCounts {
  scanned: number;
  summariesRewritten: number;
  embeddingsRewritten: number;
  observationsRewritten: number;
  /** Deleted, redacted or hand-edited rows left alone. */
  skippedEdited: number;
  /** Rows whose summary was not deterministic (kept; embedding still rebuilt). */
  keptCustomSummary: number;
}

export function emptyMemorySummaryReindexCounts(): MemorySummaryReindexCounts {
  return {
    scanned: 0,
    summariesRewritten: 0,
    embeddingsRewritten: 0,
    observationsRewritten: 0,
    skippedEdited: 0,
    keptCustomSummary: 0,
  };
}

const COUNT_KEYS = Object.keys(emptyMemorySummaryReindexCounts()) as Array<
  keyof MemorySummaryReindexCounts
>;

interface ReindexProgress {
  afterRowid: number;
  startedAt: number;
  counts: MemorySummaryReindexCounts;
}

export interface MemorySummaryReindexChunk {
  done: boolean;
  counts: MemorySummaryReindexCounts;
  /** Workspaces and memories whose summary or embedding changed (cache invalidation). */
  workspaceIds: string[];
  memoryIds: string[];
}

function ensureMarkerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function writeState(db: Database.Database, key: string, value: unknown, now: number): void {
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

function readProgress(db: Database.Database): ReindexProgress | null {
  const row = db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(PROGRESS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ReindexProgress>;
    const counts = emptyMemorySummaryReindexCounts();
    for (const key of COUNT_KEYS) {
      const value = Number(parsed.counts?.[key] ?? 0);
      counts[key] = Number.isFinite(value) ? value : 0;
    }
    return {
      afterRowid: Number(parsed.afterRowid) || 0,
      startedAt: Number(parsed.startedAt) || 0,
      counts,
    };
  } catch {
    return null;
  }
}

/** Whether the re-index still has to run (no marker yet and an archive to re-index). */
export function isMemorySummaryReindexPending(db: Database.Database): boolean {
  ensureMarkerTable(db);
  if (!tableExists(db, "memories") || !tableExists(db, "memory_embeddings")) return false;
  return !db
    .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
    .get(MEMORY_SUMMARY_REINDEX_KEY);
}

/** The text before an `[Imported from …]` header was part of the stored summary. */
function importedBody(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("[Imported from ")) return trimmed;
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? "" : trimmed.slice(newline + 1);
}

function isDeterministicSummary(summary: string, content: string): boolean {
  if (!summary.trim()) return true;
  return (
    summary === legacyDeterministicSummary(content) ||
    summary === legacyDeterministicSummary(importedBody(content)) ||
    summary === buildDeterministicSummary(content)
  );
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

interface ReindexRow {
  rowid: number;
  id: string;
  workspace_id: string;
  type: string;
  content: string | null;
  summary: string | null;
  tokens: number | null;
  created_at: number;
  updated_at: number;
  has_observation: number;
  privacy_state: string | null;
  generated_by: string | null;
  title: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
}

const stringifyList = (values: string[]) => JSON.stringify(values.slice(0, 12));

/** Re-index the next chunk of rows and store the progress, in one transaction. */
export function runMemorySummaryReindexChunk(
  db: Database.Database,
  args: { limit: number; now: number },
): MemorySummaryReindexChunk {
  ensureMarkerTable(db);
  const progress = readProgress(db) ?? {
    afterRowid: 0,
    startedAt: args.now,
    counts: emptyMemorySummaryReindexCounts(),
  };
  const counts = emptyMemorySummaryReindexCounts();
  const workspaceIds = new Set<string>();
  const memoryIds = new Set<string>();
  const hasObservations = tableExists(db, "memory_observation_metadata");

  const rows = db
    .prepare(
      `SELECT m.rowid AS rowid, m.id, m.workspace_id, m.type, m.content, m.summary, m.tokens,
              m.created_at, m.updated_at,
              ${hasObservations ? "CASE WHEN om.memory_id IS NULL THEN 0 ELSE 1 END" : "0"} AS has_observation,
              ${hasObservations ? "om.privacy_state, om.generated_by, om.title, om.narrative, om.facts, om.concepts, om.files_read, om.files_modified" : "NULL AS privacy_state, NULL AS generated_by, NULL AS title, NULL AS narrative, NULL AS facts, NULL AS concepts, NULL AS files_read, NULL AS files_modified"}
       FROM memories m
       ${hasObservations ? "LEFT JOIN memory_observation_metadata om ON om.memory_id = m.id" : ""}
       WHERE m.rowid > ? AND m.created_at < ?
       ORDER BY m.rowid ASC
       LIMIT ?`,
    )
    .all(progress.afterRowid, progress.startedAt, args.limit) as ReindexRow[];

  const updateSummary = db.prepare(
    "UPDATE memories SET summary = ?, tokens = ? WHERE id = ? AND updated_at = ?",
  );
  const updateTokens = db.prepare(
    "UPDATE memories SET tokens = ? WHERE id = ? AND updated_at = ? AND COALESCE(tokens, -1) != ?",
  );
  const updateObservation = hasObservations
    ? db.prepare(
        `UPDATE memory_observation_metadata
         SET title = ?, narrative = ?, facts = ?, concepts = ?, files_read = ?, files_modified = ?,
             updated_at = ?
         WHERE memory_id = ? AND generated_by != 'manual'
           AND privacy_state NOT IN ('redacted', 'suppressed')`,
      )
    : null;

  let lastRowid = progress.afterRowid;
  for (const row of rows) {
    lastRowid = row.rowid;
    counts.scanned += 1;
    if (
      row.privacy_state === "redacted" ||
      row.privacy_state === "suppressed" ||
      row.generated_by === "manual"
    ) {
      counts.skippedEdited += 1;
      continue;
    }
    const content = row.content || "";
    const storedSummary = row.summary || "";
    let summary = storedSummary;
    const contentTokens = estimateTokens(content);
    if (isDeterministicSummary(storedSummary, content)) {
      const next = buildDeterministicSummary(content);
      if (next && next !== storedSummary) {
        if (updateSummary.run(next, contentTokens, row.id, row.updated_at).changes > 0) {
          summary = next;
          counts.summariesRewritten += 1;
          workspaceIds.add(row.workspace_id);
          memoryIds.add(row.id);
        } else {
          // Changed meanwhile: a newer write already computed its summary.
          continue;
        }
      } else {
        updateTokens.run(contentTokens, row.id, row.updated_at, contentTokens);
      }
    } else {
      counts.keptCustomSummary += 1;
    }

    const written = upsertMemoryEmbeddingRows(
      db,
      [
        {
          memoryId: row.id,
          workspaceId: row.workspace_id,
          embedding: createLocalEmbedding(memoryEmbeddingText(summary, content)),
          updatedAt: row.updated_at,
        },
      ],
      { ifCurrent: true },
    );
    if (written.length > 0) {
      counts.embeddingsRewritten += 1;
      workspaceIds.add(row.workspace_id);
      memoryIds.add(row.id);
    }

    if (updateObservation && row.has_observation) {
      const text = deriveObservationText({
        type: row.type,
        content,
        summary: summary || undefined,
      });
      const next = [
        text.title,
        text.narrative,
        stringifyList(text.facts),
        stringifyList(text.concepts),
        stringifyList(text.filesRead),
        stringifyList(text.filesModified),
      ];
      const current = [
        row.title,
        row.narrative,
        row.facts,
        row.concepts,
        row.files_read,
        row.files_modified,
      ];
      if (next.some((value, index) => value !== current[index])) {
        const changes = updateObservation.run(...next, args.now, row.id).changes;
        if (changes > 0) counts.observationsRewritten += 1;
      }
    }
  }

  const done = rows.length < args.limit;
  for (const key of COUNT_KEYS) progress.counts[key] += counts[key];
  progress.afterRowid = lastRowid;
  writeState(db, PROGRESS_KEY, progress, args.now);
  return { done, counts, workspaceIds: [...workspaceIds], memoryIds: [...memoryIds] };
}

/** Record the completion marker with the run's total counts and drop the progress row. */
export function completeMemorySummaryReindex(
  db: Database.Database,
  now: number,
): MemorySummaryReindexCounts {
  ensureMarkerTable(db);
  const counts = readProgress(db)?.counts ?? emptyMemorySummaryReindexCounts();
  writeState(db, MEMORY_SUMMARY_REINDEX_KEY, { counts, completedAt: now }, now);
  db.prepare("DELETE FROM maintenance_state WHERE key = ?").run(PROGRESS_KEY);
  return counts;
}

export const MEMORY_SUMMARY_REINDEX_UNITS = {
  // Not read-only: checking the marker creates its table when missing.
  memorySummaryReindex_pending: defineUnit(
    () => ({}),
    (db: Database.Database) => isMemorySummaryReindexPending(db),
  ),
  memorySummaryReindex_chunk: defineUnit(
    fields({
      limit: (value: unknown, path: string) =>
        int(value, path, 1, MEMORY_SUMMARY_REINDEX_MAX_CHUNK),
      now: (value: unknown, path: string) => int(value, path),
    }),
    (db: Database.Database, args) => runMemorySummaryReindexChunk(db, args),
  ),
  memorySummaryReindex_complete: defineUnit(
    fields({ now: (value: unknown, path: string) => int(value, path) }),
    (db: Database.Database, args) => completeMemorySummaryReindex(db, args.now),
  ),
} satisfies UnitCatalog;
