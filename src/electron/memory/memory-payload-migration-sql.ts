/**
 * One-time move of non-memory payloads out of the `memories` archive (audit §2.2, L11,
 * Phase 2 item 6):
 *
 *   - `[SUGGESTION] {json}` rows            -> `suggestions`
 *   - `[suggestion-feedback:<action>] …`    -> `suggestion_feedback`
 *   - generated `[PLAYBOOK] …` rows         -> `playbook_entries`
 *
 * Each moved row is deleted from `memories` together with its embedding and observation
 * metadata (the FTS delete trigger removes its index rows). Playbook entries keep the
 * memory's id, so `playbook_success_evidence.source_memory_id` stays valid and its content
 * hash still matches. Suggestions keep the id inside their JSON (the id the UI and the
 * dismiss/act-on state use), falling back to the memory id.
 *
 * Privacy carries over: a private or redacted memory becomes a private entry; a memory the
 * user deleted in Memory Hub (observation privacy state `suppressed`) is not carried over,
 * only deleted, and Playbook evidence that pointed at it is invalidated as
 * `source_entry_deleted`.
 *
 * Idempotent: inserts are keyed by id (INSERT OR IGNORE) and the moved rows are gone
 * afterwards, so an interrupted run is simply repeated. A marker in `maintenance_state`
 * skips the archive scan once the move completed. Runs synchronously during schema setup
 * (DatabaseManager), before any service reads the new tables.
 *
 * Free of Electron and service imports so the database worker can load it.
 */
import type Database from "better-sqlite3";
import { PlaybookEvidenceStore } from "./PlaybookEvidenceStore";
import {
  PlaybookEntrySqlStore,
  parsePlaybookContent,
  playbookKindOfContent,
} from "./playbook-entries-sql";
import {
  SuggestionSqlStore,
  ensureSuggestionsSchema,
  parseSuggestionFeedbackContent,
} from "./suggestions-sql";

export const MEMORY_PAYLOAD_MIGRATION_KEY = "memory_payload_tables_migration_v1";

/** Suggestions expired seven days after creation when they were archive rows. */
export const LEGACY_SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SUGGESTION_MARKER = "[SUGGESTION]";
const BATCH_SIZE = 500;

export interface MemoryPayloadMigrationCounts {
  suggestionsMoved: number;
  suggestionFeedbackMoved: number;
  playbookEntriesMoved: number;
  /** Rows deleted without a copy: unparseable payloads or rows the user deleted. */
  dropped: number;
  memoriesDeleted: number;
}

export interface MemoryPayloadMigrationResult {
  ran: boolean;
  counts: MemoryPayloadMigrationCounts;
  /** Workspaces whose archive rows changed, so callers can drop their caches. */
  workspaceIds: string[];
}

interface ArchiveRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  content: string;
  is_private: number;
  created_at: number;
  privacy_state: string | null;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
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

export function hasMemoryPayloadMigrationRun(db: Database.Database): boolean {
  ensureMarkerTable(db);
  return Boolean(
    db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(MEMORY_PAYLOAD_MIGRATION_KEY),
  );
}

/** Create the destination tables (idempotent). */
export function ensureMemoryPayloadTables(db: Database.Database): void {
  ensureSuggestionsSchema(db);
  PlaybookEvidenceStore.ensureSchema(db);
}

/** Archive rows whose content starts (after whitespace) with `prefix`, in batches. */
function* selectArchiveRows(db: Database.Database, likePattern: string): Generator<ArchiveRow[]> {
  const hasObservations = tableExists(db, "memory_observation_metadata");
  const select = db.prepare(
    `SELECT m.rowid AS rid, m.id, m.workspace_id, m.task_id, m.content, m.is_private, m.created_at,
            ${hasObservations ? "om.privacy_state" : "NULL"} AS privacy_state
     FROM memories m
     ${hasObservations ? "LEFT JOIN memory_observation_metadata om ON om.memory_id = m.id" : ""}
     WHERE m.rowid > ? AND LTRIM(m.content) LIKE ?
     ORDER BY m.rowid LIMIT ?`,
  );
  let after = 0;
  for (;;) {
    const rows = select.all(after, likePattern, BATCH_SIZE) as Array<ArchiveRow & { rid: number }>;
    if (rows.length === 0) return;
    after = rows[rows.length - 1].rid;
    yield rows;
  }
}

function deleteArchiveRows(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const chunk = JSON.stringify(ids);
  if (tableExists(db, "memory_embeddings")) {
    db.prepare(
      "DELETE FROM memory_embeddings WHERE memory_id IN (SELECT value FROM json_each(?))",
    ).run(chunk);
  }
  if (tableExists(db, "memory_observation_metadata")) {
    db.prepare(
      "DELETE FROM memory_observation_metadata WHERE memory_id IN (SELECT value FROM json_each(?))",
    ).run(chunk);
  }
  return db.prepare("DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?))").run(chunk)
    .changes;
}

const isUserDeleted = (row: ArchiveRow) => row.privacy_state === "suppressed";
const isPrivate = (row: ArchiveRow) => row.is_private === 1 || row.privacy_state === "redacted";

/**
 * SQL LIKE is case-insensitive, so the candidates are re-checked here: only the exact
 * prefixes the service wrote are generated rows. Anything else is user text and stays.
 */
const GENERATED_SUGGESTION = /^\s*\[SUGGESTION\] \{/;
const GENERATED_FEEDBACK =
  /^\s*\[suggestion-feedback:(?:acted_on|dismissed|snoozed|edited|ignored)\] /;

function parseSuggestionPayload(content: string): Record<string, unknown> | null {
  const index = content.indexOf(SUGGESTION_MARKER);
  if (index === -1) return null;
  try {
    const value = JSON.parse(content.slice(index + SUGGESTION_MARKER.length).trim());
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function moveSuggestions(
  db: Database.Database,
  counts: MemoryPayloadMigrationCounts,
  workspaces: Set<string>,
): void {
  const store = new SuggestionSqlStore(db);
  for (const rows of selectArchiveRows(db, `${SUGGESTION_MARKER}%`)) {
    const moved: string[] = [];
    db.transaction(() => {
      for (const row of rows) {
        if (!GENERATED_SUGGESTION.test(row.content)) continue;
        moved.push(row.id);
        workspaces.add(row.workspace_id);
        // A generated row that no longer parses (truncated) has nothing worth keeping.
        const payload = isUserDeleted(row) ? null : parseSuggestionPayload(row.content);
        if (!payload) {
          counts.dropped += 1;
          continue;
        }
        const id = typeof payload.id === "string" && payload.id ? payload.id : row.id;
        if (
          store.insert({
            id,
            workspaceId: row.workspace_id,
            payload: { ...payload, id },
            isPrivate: isPrivate(row),
            createdAt: row.created_at,
            expiresAt: row.created_at + LEGACY_SUGGESTION_TTL_MS,
          })
        ) {
          counts.suggestionsMoved += 1;
        }
      }
      counts.memoriesDeleted += deleteArchiveRows(db, moved);
    })();
  }
}

function moveSuggestionFeedback(
  db: Database.Database,
  counts: MemoryPayloadMigrationCounts,
  workspaces: Set<string>,
): void {
  const store = new SuggestionSqlStore(db);
  for (const rows of selectArchiveRows(db, "[suggestion-feedback:%")) {
    const moved: string[] = [];
    db.transaction(() => {
      for (const row of rows) {
        if (!GENERATED_FEEDBACK.test(row.content)) continue;
        moved.push(row.id);
        workspaces.add(row.workspace_id);
        const parsed = isUserDeleted(row) ? null : parseSuggestionFeedbackContent(row.content);
        if (!parsed) {
          counts.dropped += 1;
          continue;
        }
        if (
          store.insertFeedback({
            id: row.id,
            workspaceId: row.workspace_id,
            suggestionId: null,
            ...parsed,
            isPrivate: isPrivate(row),
            createdAt: row.created_at,
          })
        ) {
          counts.suggestionFeedbackMoved += 1;
        }
      }
      counts.memoriesDeleted += deleteArchiveRows(db, moved);
    })();
  }
}

function movePlaybookRows(
  db: Database.Database,
  counts: MemoryPayloadMigrationCounts,
  workspaces: Set<string>,
): void {
  const entries = new PlaybookEntrySqlStore(db);
  const evidence = db.prepare(
    "SELECT id, pattern_key FROM playbook_success_evidence WHERE source_memory_id = ?",
  );
  const invalidate = db.prepare(
    `UPDATE playbook_success_evidence SET invalidated_at = ?, invalidation_reason = 'source_entry_deleted'
     WHERE source_memory_id = ? AND invalidated_at IS NULL`,
  );
  for (const rows of selectArchiveRows(db, "[PLAYBOOK]%")) {
    const moved: string[] = [];
    db.transaction(() => {
      for (const row of rows) {
        const kind = playbookKindOfContent(row.content);
        // Only generated records move; user text that starts with the marker stays memory.
        if (!kind) continue;
        moved.push(row.id);
        workspaces.add(row.workspace_id);
        if (isUserDeleted(row)) {
          invalidate.run(row.created_at, row.id);
          counts.dropped += 1;
          continue;
        }
        const ledger = evidence.get(row.id) as { id: string; pattern_key: string } | undefined;
        const parsed = parsePlaybookContent(row.content);
        if (
          entries.insertRow({
            id: row.id,
            workspaceId: row.workspace_id,
            taskId: row.task_id,
            kind,
            parsed,
            patternKey: ledger?.pattern_key ?? "",
            content: row.content,
            isPrivate: isPrivate(row),
            createdAt: row.created_at,
          })
        ) {
          counts.playbookEntriesMoved += 1;
        }
      }
      counts.memoriesDeleted += deleteArchiveRows(db, moved);
    })();
  }
  // Reinforcement counts from the durable links that already exist.
  db.prepare(
    `UPDATE playbook_entries SET reinforcement_count = (
       SELECT COUNT(*) FROM playbook_success_links l
       JOIN playbook_success_evidence e ON e.id = l.reinforces_evidence_id
       WHERE e.source_memory_id = playbook_entries.id
     )
     WHERE id IN (SELECT source_memory_id FROM playbook_success_evidence)`,
  ).run();
  db.prepare(
    `UPDATE playbook_entries SET status = 'invalidated'
     WHERE status = 'active' AND id IN (
       SELECT source_memory_id FROM playbook_success_evidence WHERE invalidated_at IS NOT NULL
     )`,
  ).run();
}

/**
 * Move every non-memory payload out of the archive, once. Returns `ran: false` (and changes
 * nothing) when the marker exists or the database has no memories table. Throws on failure,
 * leaving the marker unset so the next start repeats the (idempotent) move.
 */
export function runMemoryPayloadMigration(
  db: Database.Database,
  now: number,
): MemoryPayloadMigrationResult {
  const counts: MemoryPayloadMigrationCounts = {
    suggestionsMoved: 0,
    suggestionFeedbackMoved: 0,
    playbookEntriesMoved: 0,
    dropped: 0,
    memoriesDeleted: 0,
  };
  if (!tableExists(db, "memories")) return { ran: false, counts, workspaceIds: [] };
  ensureMemoryPayloadTables(db);
  if (hasMemoryPayloadMigrationRun(db)) return { ran: false, counts, workspaceIds: [] };

  const workspaces = new Set<string>();
  moveSuggestions(db, counts, workspaces);
  moveSuggestionFeedback(db, counts, workspaces);
  movePlaybookRows(db, counts, workspaces);

  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MEMORY_PAYLOAD_MIGRATION_KEY, JSON.stringify(counts), now);
  return { ran: true, counts, workspaceIds: [...workspaces] };
}
