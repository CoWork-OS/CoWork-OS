/**
 * SQL of the one-time legacy memory data retirement (LegacyMemoryRetirement.ts), part of
 * the memory domain: each function runs as one transaction unit, in the database worker
 * when memory is routed there. No keychain, network or timer access here; the settings
 * blobs and the backup file are handled by the caller on the host.
 *
 * Retired tables:
 *  - `curated_memory_entries`: copied into `memory_items` by the lane migration;
 *  - `memory_summaries`, `heartbeat_policies`: nothing reads them any more;
 *  - `improvement_*`: the retired self-improvement loop, once the subconscious migration
 *    has copied them (the caller checks its marker);
 *  - `transcript_spans` with its FTS index and bookkeeping tables, once the conversation
 *    index migration has recorded `legacy_transcript_spans_migrated_v1`.
 * Settled `pending_memory_writes` rows are deleted; the table stays (MemoryWriteGate).
 */
import type Database from "better-sqlite3";
import { defineReadUnit, defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { bool, fields, int, json, list, record, str } from "../database/statements/unit-args";
import { MEMORY_ITEMS_LANE_MIGRATION_KEY } from "./memory-items-sql";

export const LEGACY_MEMORY_RETIREMENT_KEY = "legacy_memory_retirement_v1";
/** Completion marker of the transcript span migration (conversation-index-sql.ts). */
export const LEGACY_TRANSCRIPT_SPANS_MIGRATED_KEY = "legacy_transcript_spans_migrated_v1";

export const CURATED_TABLE = "curated_memory_entries";
const DEAD_TABLES = ["memory_summaries", "heartbeat_policies"] as const;
/** FTS index first: it is a virtual table over `transcript_spans`. */
const TRANSCRIPT_TABLES = [
  "transcript_spans_fts",
  "transcript_spans",
  "transcript_span_index_gap",
  "transcript_store_meta",
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasMaintenanceKey(db: Database.Database, key: string): boolean {
  if (!tableExists(db, "maintenance_state")) return false;
  return Boolean(db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(key));
}

function transcriptSpansMigrated(db: Database.Database): boolean {
  if (!tableExists(db, "durable_context_meta")) return false;
  return Boolean(
    db
      .prepare("SELECT 1 FROM durable_context_meta WHERE key = ?")
      .get(LEGACY_TRANSCRIPT_SPANS_MIGRATED_KEY),
  );
}

function improvementTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'improvement\\_%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function countRows(db: Database.Database, table: string): number {
  // Table names come from the fixed lists above or sqlite_master, never from input.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
  return Number(row.n) || 0;
}

/** Tables this run may drop that exist, with their row counts (FTS index not counted). */
function candidateTables(
  db: Database.Database,
  options: { includeImprovement: boolean },
): Record<string, number> {
  const names: string[] = [CURATED_TABLE, ...DEAD_TABLES];
  if (options.includeImprovement) names.push(...improvementTables(db));
  if (transcriptSpansMigrated(db)) names.push(...TRANSCRIPT_TABLES);
  const counts: Record<string, number> = {};
  for (const name of names) {
    if (!tableExists(db, name)) continue;
    counts[name] = name === "transcript_spans_fts" ? 0 : countRows(db, name);
  }
  return counts;
}

/**
 * A cheap fingerprint of the curated table, compared before the drop: a write between the
 * verification and the drop (an older client, a dual write) aborts the run.
 */
function curatedFingerprint(db: Database.Database): string {
  if (!tableExists(db, CURATED_TABLE)) return "absent";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS latest,
              COALESCE(SUM(LENGTH(content)), 0) AS chars,
              COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active
       FROM ${CURATED_TABLE}`,
    )
    .get() as { n: number; latest: number; chars: number; active: number };
  return `${row.n}:${row.latest}:${row.chars}:${row.active}`;
}

function settledPendingWrites(db: Database.Database): number {
  if (!tableExists(db, "pending_memory_writes")) return 0;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM pending_memory_writes WHERE status != 'pending'")
    .get() as { n: number };
  return Number(row.n) || 0;
}

export interface LegacyRetirementStatus {
  done: boolean;
  laneMigrationDone: boolean;
  transcriptSpansMigrated: boolean;
}

export function legacyRetirementStatus(db: Database.Database): LegacyRetirementStatus {
  return {
    done: hasMaintenanceKey(db, LEGACY_MEMORY_RETIREMENT_KEY),
    laneMigrationDone: hasMaintenanceKey(db, MEMORY_ITEMS_LANE_MIGRATION_KEY),
    transcriptSpansMigrated: transcriptSpansMigrated(db),
  };
}

export interface CuratedExportRow {
  id: string;
  workspaceId: string;
  /** False when the workspace row is gone (the lane migration skipped those entries). */
  workspacePresent: boolean;
  taskId: string | null;
  target: string;
  kind: string;
  content: string;
  normalizedKey: string;
  source: string;
  confidence: number;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number | null;
}

export interface LegacyRetirementSnapshot {
  curated: CuratedExportRow[];
  curatedFingerprint: string;
  settledPendingWrites: number;
  /** Row counts of the tables this run would drop. */
  tableCounts: Record<string, number>;
}

export function legacyRetirementSnapshot(
  db: Database.Database,
  options: { includeImprovement: boolean },
): LegacyRetirementSnapshot {
  let curated: CuratedExportRow[] = [];
  if (tableExists(db, CURATED_TABLE)) {
    const workspaces = tableExists(db, "workspaces");
    const rows = db
      .prepare(
        `SELECT c.id, c.workspace_id, c.task_id, c.target, c.kind, c.content, c.normalized_key,
                c.source, c.confidence, c.status, c.created_at, c.updated_at,
                c.last_confirmed_at,
                ${workspaces ? "EXISTS (SELECT 1 FROM workspaces w WHERE w.id = c.workspace_id)" : "0"}
                  AS workspace_present
         FROM ${CURATED_TABLE} c
         ORDER BY c.updated_at ASC, c.rowid ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    curated = rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      workspacePresent: Number(row.workspace_present) === 1,
      taskId: typeof row.task_id === "string" ? row.task_id : null,
      target: String(row.target),
      kind: String(row.kind),
      content: String(row.content),
      normalizedKey: String(row.normalized_key),
      source: String(row.source),
      confidence: Number(row.confidence),
      status: String(row.status),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastConfirmedAt: typeof row.last_confirmed_at === "number" ? row.last_confirmed_at : null,
    }));
  }
  return {
    curated,
    curatedFingerprint: curatedFingerprint(db),
    settledPendingWrites: settledPendingWrites(db),
    tableCounts: candidateTables(db, options),
  };
}

export interface LegacySourceRef {
  store: string;
  id: string;
}

/** The refs with no `memory_items` row (any status) as primary source ref or alias. */
export function missingLegacySourceRefs(
  db: Database.Database,
  refs: LegacySourceRef[],
): LegacySourceRef[] {
  if (refs.length === 0) return [];
  if (!tableExists(db, "memory_items")) return refs;
  const statement = db.prepare(
    `SELECT 1 FROM memory_items
     WHERE (json_extract(source_ref, '$.store') = ? AND json_extract(source_ref, '$.id') = ?)
        OR EXISTS (SELECT 1 FROM json_each(memory_items.source_ref, '$.aliases') alias
                   WHERE alias.value = ?)
     LIMIT 1`,
  );
  return refs.filter((ref) => !statement.get(ref.store, ref.id, `${ref.store}:${ref.id}`));
}

/**
 * Drop order: a table goes only after every other table in the set that references it.
 * Tables referenced by a table outside the set are not dropped (returned as blocked).
 */
function planDrops(db: Database.Database, wanted: string[]): { order: string[]; blocked: string[] } {
  const all = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  const referencesOf = new Map<string, Set<string>>();
  for (const name of all) {
    // Virtual tables have no foreign keys; the pragma returns no rows for them.
    const parents = (
      db.prepare("SELECT DISTINCT \"table\" AS parent FROM pragma_foreign_key_list(?)").all(
        name,
      ) as Array<{ parent: string }>
    ).map((row) => row.parent);
    referencesOf.set(name, new Set(parents));
  }
  const set = new Set(wanted);
  const blocked = new Set<string>();
  for (;;) {
    let changed = false;
    for (const table of set) {
      for (const [child, parents] of referencesOf) {
        if (child !== table && !set.has(child) && parents.has(table)) {
          set.delete(table);
          blocked.add(table);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  // Children before parents; the FTS index before its content table.
  const order: string[] = [];
  const remaining = new Set(set);
  for (const virtual of ["transcript_spans_fts"]) {
    if (remaining.delete(virtual)) order.push(virtual);
  }
  while (remaining.size > 0) {
    const next = [...remaining].find(
      (table) =>
        ![...remaining].some(
          (other) => other !== table && referencesOf.get(other)?.has(table) === true,
        ),
    );
    // A reference cycle inside the set: drop in name order (SQLite checks at statement end).
    const pick = next ?? [...remaining].sort()[0];
    remaining.delete(pick);
    order.push(pick);
  }
  return { order, blocked: [...blocked].sort() };
}

/** Triggers and views on other tables whose SQL names a table being dropped. */
function dependentObjects(
  db: Database.Database,
  dropped: string[],
): Array<{ type: "trigger" | "view"; name: string }> {
  if (dropped.length === 0) return [];
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('trigger', 'view')",
    )
    .all() as Array<{ type: "trigger" | "view"; name: string; tbl_name: string; sql: string | null }>;
  const droppedSet = new Set(dropped);
  return rows
    .filter((row) => !(row.type === "trigger" && droppedSet.has(row.tbl_name)))
    .filter((row) =>
      dropped.some((table) => new RegExp(`(^|[^A-Za-z0-9_])${table}([^A-Za-z0-9_]|$)`).test(row.sql ?? "")),
    )
    .map((row) => ({ type: row.type, name: row.name }));
}

export interface LegacyRetirementFinishResult {
  status: "retired" | "done" | "changed";
  droppedTables: string[];
  blockedTables: string[];
  droppedObjects: string[];
  rowsDropped: Record<string, number>;
  pendingWritesDeleted: number;
}

/**
 * Drop the retired tables, delete settled pending writes and record the marker, in one
 * transaction. Returns `changed` (and changes nothing) when the curated table differs from
 * the verified snapshot, and `done` when another run already finished.
 */
export function finishLegacyRetirement(
  db: Database.Database,
  args: {
    includeImprovement: boolean;
    curatedFingerprint: string;
    summary?: unknown;
    now: number;
  },
): LegacyRetirementFinishResult {
  const result: LegacyRetirementFinishResult = {
    status: "retired",
    droppedTables: [],
    blockedTables: [],
    droppedObjects: [],
    rowsDropped: {},
    pendingWritesDeleted: 0,
  };
  if (hasMaintenanceKey(db, LEGACY_MEMORY_RETIREMENT_KEY)) return { ...result, status: "done" };
  if (curatedFingerprint(db) !== args.curatedFingerprint) return { ...result, status: "changed" };

  if (tableExists(db, "pending_memory_writes")) {
    result.pendingWritesDeleted = db
      .prepare("DELETE FROM pending_memory_writes WHERE status != 'pending'")
      .run().changes;
  }

  const counts = candidateTables(db, { includeImprovement: args.includeImprovement });
  const plan = planDrops(db, Object.keys(counts));
  result.blockedTables = plan.blocked;
  for (const object of dependentObjects(db, plan.order)) {
    db.exec(`DROP ${object.type === "trigger" ? "TRIGGER" : "VIEW"} IF EXISTS "${object.name}"`);
    result.droppedObjects.push(object.name);
  }
  for (const table of plan.order) {
    // Indexes and triggers on the table go with it; FTS shadow tables go with the index.
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
    result.droppedTables.push(table);
    result.rowsDropped[table] = counts[table] ?? 0;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const marker = {
    ...(args.summary && typeof args.summary === "object" ? args.summary : {}),
    droppedTables: result.droppedTables,
    blockedTables: result.blockedTables,
    droppedObjects: result.droppedObjects,
    rowsDropped: result.rowsDropped,
    pendingWritesDeleted: result.pendingWritesDeleted,
    completedAt: args.now,
  };
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LEGACY_MEMORY_RETIREMENT_KEY, JSON.stringify(marker), args.now);
  return result;
}

const includeImprovementArgs = fields({
  includeImprovement: (value: unknown, path: string) => bool(value, path),
});

function sourceRef(value: unknown, path: string): LegacySourceRef {
  const input = record(value, path);
  return { store: str(input.store, `${path}.store`, 100), id: str(input.id, `${path}.id`, 500) };
}

export const LEGACY_MEMORY_RETIREMENT_UNITS = {
  legacyRetirement_status: defineReadUnit(
    () => ({}),
    (db: Database.Database) => legacyRetirementStatus(db),
  ),
  legacyRetirement_snapshot: defineReadUnit(includeImprovementArgs, (db: Database.Database, args) =>
    legacyRetirementSnapshot(db, args),
  ),
  legacyRetirement_missingRefs: defineReadUnit(
    fields({
      refs: (value: unknown, path: string) => list(value, path, sourceRef, 50_000),
    }),
    (db: Database.Database, args) => missingLegacySourceRefs(db, args.refs),
  ),
  legacyRetirement_finish: defineUnit(
    fields({
      includeImprovement: (value: unknown, path: string) => bool(value, path),
      curatedFingerprint: (value: unknown, path: string) => str(value, path, 200),
      summary: (value: unknown, path: string) => json(value, path, 100_000),
      now: (value: unknown, path: string) => int(value, path),
    }),
    (db: Database.Database, args) => finishLegacyRetirement(db, args),
  ),
} satisfies UnitCatalog;
