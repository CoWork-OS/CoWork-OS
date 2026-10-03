/**
 * Row retention for background-loop history (audit LIFE-3), used by MemoryRetentionService.
 * Each rule deletes one bounded batch per call so the caller can yield between batches;
 * table names and predicates are constants from this file, never caller input.
 *
 * Free of Electron and service imports (only the pure memory-retention.ts predicates) so
 * the database worker can load it; only `loadHostMemoryDatabase` loads MemoryService,
 * lazily, on the host.
 */
import type Database from "better-sqlite3";
import { buildMemoryLastActivitySql, buildRetentionProtectedMemorySql } from "./memory-retention";

export interface RetentionRule {
  /** Name used in logs and result counts. */
  name: string;
  table: string;
  /** SQL predicate; `?` placeholders are bound to `params(cutoff)`. */
  where: string;
  params: (cutoff: number) => unknown[];
}

/** Core clusters still being worked on; their failure records and traces are kept. */
const ACTIVE_CLUSTER_STATUSES = "('open', 'stable', 'evaluating')";

const ACTIVE_CLUSTER_RECORDS = `SELECT m.failure_record_id FROM core_failure_cluster_members m
  JOIN core_failure_clusters c ON c.id = m.cluster_id
  WHERE c.status IN ${ACTIVE_CLUSTER_STATUSES}`;

/**
 * Core learning-loop telemetry, older than the cutoff (30 days by default). Traces cascade
 * to their events, candidates and failure records, so a trace is kept while it is still
 * running, still has a proposed memory candidate, or feeds an active failure cluster.
 */
export const CORE_RETENTION_RULES: RetentionRule[] = [
  {
    name: "core_failure_records",
    table: "core_failure_records",
    where: `created_at < ? AND id NOT IN (${ACTIVE_CLUSTER_RECORDS})`,
    params: (cutoff) => [cutoff],
  },
  {
    name: "core_traces",
    table: "core_traces",
    where: `created_at < ? AND status != 'running'
      AND NOT EXISTS (SELECT 1 FROM core_memory_candidates mc
                      WHERE mc.trace_id = core_traces.id AND mc.status = 'proposed')
      AND NOT EXISTS (SELECT 1 FROM core_failure_records fr
                      WHERE fr.trace_id = core_traces.id AND fr.id IN (${ACTIVE_CLUSTER_RECORDS}))`,
    params: (cutoff) => [cutoff],
  },
  {
    // Events of traces kept above (long-running or cluster evidence) still age out.
    name: "core_trace_events",
    table: "core_trace_events",
    where: `created_at < ? AND trace_id NOT IN (
      SELECT fr.trace_id FROM core_failure_records fr WHERE fr.id IN (${ACTIVE_CLUSTER_RECORDS}))`,
    params: (cutoff) => [cutoff],
  },
  {
    name: "core_learnings_log",
    table: "core_learnings_log",
    where: `created_at < ? AND (related_cluster_id IS NULL OR related_cluster_id NOT IN (
      SELECT id FROM core_failure_clusters WHERE status IN ${ACTIVE_CLUSTER_STATUSES}))`,
    params: (cutoff) => [cutoff],
  },
  {
    name: "core_memory_distill_runs",
    table: "core_memory_distill_runs",
    where: "started_at < ? AND status != 'running'",
    params: (cutoff) => [cutoff],
  },
];

/** Dreaming history older than the cutoff (90 days); proposals awaiting review are kept. */
export const DREAMING_RETENTION_RULES: RetentionRule[] = [
  {
    name: "dreaming_candidates",
    table: "dreaming_candidates",
    where: "created_at < ? AND status != 'proposed'",
    params: (cutoff) => [cutoff],
  },
  {
    // Candidates cascade from their run, so a run with a pending proposal stays.
    name: "dreaming_runs",
    table: "dreaming_runs",
    where: `created_at < ? AND status != 'running' AND NOT EXISTS (
      SELECT 1 FROM dreaming_candidates dc
      WHERE dc.run_id = dreaming_runs.id AND dc.status = 'proposed')`,
    params: (cutoff) => [cutoff],
  },
];

/**
 * Workflow Intelligence (subconscious) history older than the cutoff (90 days). Finished
 * runs cascade to hypotheses, critiques, decisions and dispatch records; a run with a
 * dispatch still queued or in flight is kept. Backlog items keep their row (SET NULL).
 */
export const SUBCONSCIOUS_RETENTION_RULES: RetentionRule[] = [
  {
    name: "subconscious_runs",
    table: "subconscious_runs",
    where: `created_at < ? AND stage IN ('completed', 'blocked', 'failed')
      AND NOT EXISTS (SELECT 1 FROM subconscious_dispatch_records d
                      WHERE d.run_id = subconscious_runs.id
                        AND d.status IN ('queued', 'dispatched'))`,
    params: (cutoff) => [cutoff],
  },
  {
    name: "subconscious_hypotheses",
    table: "subconscious_hypotheses",
    where: "created_at < ? AND run_id NOT IN (SELECT id FROM subconscious_runs)",
    params: (cutoff) => [cutoff],
  },
  {
    name: "subconscious_critiques",
    table: "subconscious_critiques",
    where: "created_at < ? AND run_id NOT IN (SELECT id FROM subconscious_runs)",
    params: (cutoff) => [cutoff],
  },
  {
    name: "subconscious_decisions",
    table: "subconscious_decisions",
    where: "created_at < ? AND run_id NOT IN (SELECT id FROM subconscious_runs)",
    params: (cutoff) => [cutoff],
  },
];

/**
 * Proactive suggestions (suggestions-sql.ts) past the cutoff: expired ones and ones the
 * user dismissed or acted on, kept 30 days after that so the UI and dedupe still see them.
 */
export const SUGGESTION_RETENTION_RULES: RetentionRule[] = [
  {
    name: "suggestions",
    table: "suggestions",
    where: "(expires_at < ? OR (status != 'active' AND updated_at < ?))",
    params: (cutoff) => [cutoff, cutoff],
  },
];

/** Suggestion feedback rows older than the cutoff (90 days). */
export const SUGGESTION_FEEDBACK_RETENTION_RULES: RetentionRule[] = [
  {
    name: "suggestion_feedback",
    table: "suggestion_feedback",
    where: "created_at < ?",
    params: (cutoff) => [cutoff],
  },
];

/**
 * Playbook entries (playbook-entries-sql.ts) older than the cutoff (180 days): failures,
 * inbox patterns and legacy reinforcement text, and successes that no longer back active
 * evidence. A success that still backs active evidence is kept (deleting it would
 * invalidate the evidence as `source_entry_deleted`); the evidence rows themselves stay so
 * the same task can never be counted twice.
 */
export const PLAYBOOK_RETENTION_RULES: RetentionRule[] = [
  {
    name: "playbook_entries",
    table: "playbook_entries",
    where: `created_at < ? AND (kind != 'success' OR NOT EXISTS (
      SELECT 1 FROM playbook_success_evidence e
      WHERE e.source_memory_id = playbook_entries.id AND e.invalidated_at IS NULL))`,
    params: (cutoff) => [cutoff],
  },
];

/**
 * Memory items (memory-items-sql.ts) at the cutoff, which is the run time: tombstones of
 * forgotten items (their content is already scrubbed when they are forgotten) and items
 * past their own `expires_at`.
 */
export const MEMORY_ITEM_RETENTION_RULES: RetentionRule[] = [
  {
    name: "memory_items_deleted",
    table: "memory_items",
    where: "status = 'deleted' AND updated_at <= ?",
    params: (cutoff) => [cutoff],
  },
  {
    name: "memory_items_expired",
    table: "memory_items",
    where: "expires_at IS NOT NULL AND expires_at <= ?",
    params: (cutoff) => [cutoff],
  },
];

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

/**
 * Delete at most `limit` rows matching `rule` older than `cutoff`. Returns the number
 * deleted; 0 when the table is absent (optional feature never initialized).
 */
export function deleteRetentionBatch(
  db: Database.Database,
  rule: RetentionRule,
  cutoff: number,
  limit: number,
): number {
  if (!tableExists(db, rule.table)) return 0;
  return db
    .prepare(
      `DELETE FROM ${rule.table} WHERE rowid IN (
         SELECT rowid FROM ${rule.table} WHERE ${rule.where} LIMIT ?)`,
    )
    .run(...rule.params(cutoff), Math.max(1, Math.floor(limit))).changes;
}

/**
 * Workspace memory retention (MemoryStore.deleteOlderThan): delete the workspace's
 * archive rows not used (created or referenced) since `cutoff`, keeping imports, explicit
 * saves and curated promotions (memory-retention.ts). Child embeddings go
 * first. Run it inside the caller's transaction.
 */
export function deleteWorkspaceMemoriesOlderThan(
  db: Database.Database,
  workspaceId: string,
  cutoff: number,
): number {
  const where = `workspace_id = ? AND ${buildMemoryLastActivitySql("memories")} < ?
      AND NOT ${buildRetentionProtectedMemorySql("memories.id", "memories.content")}`;
  db.prepare(
    `DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memories WHERE ${where})`,
  ).run(workspaceId, cutoff);
  return db.prepare(`DELETE FROM memories WHERE ${where}`).run(workspaceId, cutoff).changes;
}

export interface RetentionWorkspaceRow {
  id: string;
  path: string;
  permissions: string | null;
  isTemp: boolean;
}

/** Workspaces whose folders hold `.cowork/` artifacts. */
export function listRetentionWorkspaces(db: Database.Database): RetentionWorkspaceRow[] {
  if (!tableExists(db, "workspaces")) return [];
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const tempColumn = columns.has("is_temp") ? "is_temp" : "0";
  const rows = db
    .prepare(`SELECT id, path, permissions, ${tempColumn} AS is_temp FROM workspaces`)
    .all() as Array<{ id: string; path: unknown; permissions: unknown; is_temp: unknown }>;
  return rows
    .filter((row) => typeof row.path === "string" && row.path.length > 0)
    .map((row) => ({
      id: row.id,
      path: row.path as string,
      permissions: typeof row.permissions === "string" ? row.permissions : null,
      isTemp: Number(row.is_temp) === 1,
    }));
}

/** Distinct run artifact directories recorded for Workflow Intelligence runs. */
export function listSubconsciousArtifactRoots(db: Database.Database, limit = 5000): string[] {
  if (!tableExists(db, "subconscious_runs")) return [];
  return (
    db
      .prepare(
        "SELECT DISTINCT artifact_root FROM subconscious_runs ORDER BY artifact_root LIMIT ?",
      )
      .all(limit) as Array<{ artifact_root: unknown }>
  )
    .map((row) => row.artifact_root)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** The host connection the memory services use, or null before memory is initialized. */
export async function loadHostMemoryDatabase(): Promise<Database.Database | null> {
  const { MemoryService } = await import("./MemoryService");
  return MemoryService.getDatabase() ?? null;
}
