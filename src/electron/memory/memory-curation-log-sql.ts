import type Database from "better-sqlite3";

/**
 * Schema of the memory curator (docs/memory-engine.md §9): the audit log of applied
 * curation operations (`memory_curation_log`, the source of Undo) and the curator's
 * columns on `dreaming_runs` / `dreaming_candidates`. Additive and idempotent; run by the
 * schema initialization after `memory_items` exists.
 *
 * The log keeps before/after snapshots of the items it touched, which quote item content.
 * The scrub helpers below drop those rows whenever an item is really deleted (forget, task
 * purge, Clear All Memories, clear global), so a forgotten fact does not survive here.
 */

export const LEGACY_DREAMING_DISMISSAL =
  "Retired: replaced by the memory curator, which proposes concrete changes to memory items.";

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function addColumns(db: Database.Database, table: string, columns: Record<string, string>): void {
  if (!tableExists(db, table)) return;
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function ensureMemoryCurationSchema(db: Database.Database, now = Date.now()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_curation_log (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT,
      candidate_id TEXT,
      op TEXT NOT NULL,
      origin TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      item_ids TEXT NOT NULL DEFAULT '[]',
      created_ids TEXT NOT NULL DEFAULT '[]',
      before_snapshot TEXT NOT NULL DEFAULT '[]',
      after_snapshot TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      rationale TEXT,
      has_global INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER NOT NULL,
      undone_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_curation_log_workspace
      ON memory_curation_log(workspace_id, applied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_curation_log_fingerprint
      ON memory_curation_log(workspace_id, fingerprint);
  `);
  addColumns(db, "dreaming_runs", {
    applied_count: "INTEGER NOT NULL DEFAULT 0",
    queued_count: "INTEGER NOT NULL DEFAULT 0",
    llm_tokens: "INTEGER NOT NULL DEFAULT 0",
    llm_calls: "INTEGER NOT NULL DEFAULT 0",
    stats: "TEXT",
  });
  addColumns(db, "dreaming_candidates", {
    operation: "TEXT",
    review_reason: "TEXT",
    origin: "TEXT",
    fingerprint: "TEXT",
  });
  if (tableExists(db, "dreaming_candidates")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dreaming_candidates_fingerprint
        ON dreaming_candidates(workspace_id, fingerprint);
    `);
    dismissLegacyDreamingCandidates(db, now);
  }
}

/**
 * The pre-curator Dreaming produced constant-text proposals ("A recent correction should be
 * reviewed…") with nothing to apply. Close the open ones once; curator proposals always
 * carry an `operation`, so they are never matched.
 */
export function dismissLegacyDreamingCandidates(db: Database.Database, now: number): number {
  return db
    .prepare(
      `UPDATE dreaming_candidates
       SET status = 'dismissed', resolution = ?, reviewed_at = ?
       WHERE status IN ('proposed', 'accepted') AND operation IS NULL`,
    )
    .run(LEGACY_DREAMING_DISMISSAL, now).changes;
}

/** Drop log rows that quote any of these items (they were deleted for real). */
export function scrubCurationLogForItems(
  db: Database.Database,
  itemIds: readonly string[],
): number {
  if (itemIds.length === 0 || !tableExists(db, "memory_curation_log")) return 0;
  const statement = db.prepare(
    `DELETE FROM memory_curation_log
     WHERE instr(item_ids, ?) > 0 OR instr(created_ids, ?) > 0`,
  );
  let removed = 0;
  for (const id of itemIds) {
    const quoted = JSON.stringify(id);
    removed += statement.run(quoted, quoted).changes;
  }
  return removed;
}

/** "Clear global memories": log rows that touched a global item. */
export function purgeGlobalCurationLog(db: Database.Database): number {
  if (!tableExists(db, "memory_curation_log")) return 0;
  return db.prepare("DELETE FROM memory_curation_log WHERE has_global = 1").run().changes;
}

/** "Clear All Memories" for a workspace. */
export function purgeWorkspaceCurationLog(db: Database.Database, workspaceId: string): number {
  if (!tableExists(db, "memory_curation_log")) return 0;
  return db.prepare("DELETE FROM memory_curation_log WHERE workspace_id = ?").run(workspaceId)
    .changes;
}
