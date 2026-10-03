/**
 * SQL of the one-time memory archive cleanup (MemoryCleanupMigration.ts describes the
 * phases). Plain synchronous SQL over the connection it is given; each phase runs as one
 * memory-domain transaction unit (memory-cleanup-units.ts), in the database worker when
 * memory is routed there and in one host transaction otherwise.
 *
 * Free of Electron and service imports so the database worker can load it. Phases take
 * `now` from the caller instead of reading a clock.
 */

import type Database from "better-sqlite3";
import { buildRetentionProtectedMemorySql } from "./memory-retention";
import { neutralizeReservedImportPrefix } from "./memory-visibility";
import { observationContentHash } from "./memory-observation-sql";
import { redactSecrets } from "./sensitive-content";

export const MEMORY_CLEANUP_MIGRATION_KEY = "memory_cleanup_migration_v1";

/** Content prefixes (SQL LIKE patterns) of raw task telemetry rows. */
export const RAW_TELEMETRY_CONTENT_PATTERNS: readonly string[] = [
  "Tool called:%",
  "Tool result for %",
  "Step started:%",
  "Step completed:%",
  '{"stepId"%',
  '{"taskId"%',
  '{"groupId"%',
  // Raw plan payloads: "Plan created:\n{...}" / "Plan revised:\n{...}".
  "Plan created:\n{%",
  "Plan revised:\n{%",
];

export interface MemoryCleanupCounts {
  telemetryDeleted: number;
  duplicatesCollapsed: number;
  memoriesRedacted: number;
  observationsRedacted: number;
  importPrefixesNeutralized: number;
  orphanEmbeddingsDeleted: number;
  orphanObservationsDeleted: number;
}

const BATCH_SIZE = 500;

export function emptyMemoryCleanupCounts(): MemoryCleanupCounts {
  return {
    telemetryDeleted: 0,
    duplicatesCollapsed: 0,
    memoriesRedacted: 0,
    observationsRedacted: 0,
    importPrefixesNeutralized: 0,
    orphanEmbeddingsDeleted: 0,
    orphanObservationsDeleted: 0,
  };
}

export function tableExists(db: Database.Database, name: string): boolean {
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

export function hasMemoryCleanupMigrationRun(db: Database.Database): boolean {
  ensureMarkerTable(db);
  return Boolean(
    db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(MEMORY_CLEANUP_MIGRATION_KEY),
  );
}

function deleteMemoryRows(db: Database.Database, ids: string[]): number {
  let deleted = 0;
  const hasObservations = tableExists(db, "memory_observation_metadata");
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const chunk = JSON.stringify(ids.slice(index, index + BATCH_SIZE));
    db.transaction(() => {
      db.prepare(
        "DELETE FROM memory_embeddings WHERE memory_id IN (SELECT value FROM json_each(?))",
      ).run(chunk);
      if (hasObservations) {
        db.prepare(
          "DELETE FROM memory_observation_metadata WHERE memory_id IN (SELECT value FROM json_each(?))",
        ).run(chunk);
      }
      deleted += db
        .prepare("DELETE FROM memories WHERE id IN (SELECT value FROM json_each(?))")
        .run(chunk).changes;
    })();
  }
  return deleted;
}

interface PhaseContext {
  db: Database.Database;
  counts: MemoryCleanupCounts;
  workspaceIds: Set<string>;
  memoryIds: Set<string>;
  protectedSql: string;
  now: number;
}

/** (a) Raw telemetry rows. */
function deleteRawTelemetry(ctx: PhaseContext): void {
  const likes = RAW_TELEMETRY_CONTENT_PATTERNS.map(() => "m.content LIKE ?").join(" OR ");
  const rows = ctx.db
    .prepare(
      `SELECT m.id, m.workspace_id FROM memories m
       WHERE (${likes}) AND NOT ${ctx.protectedSql}`,
    )
    .all(...RAW_TELEMETRY_CONTENT_PATTERNS) as Array<{ id: string; workspace_id: string }>;
  for (const row of rows) {
    ctx.workspaceIds.add(row.workspace_id);
    ctx.memoryIds.add(row.id);
  }
  ctx.counts.telemetryDeleted = deleteMemoryRows(
    ctx.db,
    rows.map((row) => row.id),
  );
}

/** (b) Exact duplicates: keep the oldest row of each (workspace, type, content). */
function collapseDuplicates(ctx: PhaseContext): void {
  const referenced: string[] = [];
  if (tableExists(ctx.db, "playbook_success_evidence")) {
    referenced.push("SELECT source_memory_id FROM playbook_success_evidence");
  }
  if (tableExists(ctx.db, "box_brain_items")) {
    referenced.push("SELECT memory_id FROM box_brain_items WHERE memory_id IS NOT NULL");
  }
  const notReferenced = referenced.length ? `AND d.id NOT IN (${referenced.join(" UNION ")})` : "";
  const rows = ctx.db
    .prepare(
      `WITH ranked AS (
         SELECT id, workspace_id, content,
                COALESCE(reference_count, 0) AS reference_count,
                last_referenced_at,
                FIRST_VALUE(id) OVER w AS keeper_id,
                ROW_NUMBER() OVER w AS rn
         FROM memories
         WINDOW w AS (PARTITION BY workspace_id, type, content ORDER BY created_at, rowid)
       )
       SELECT d.id, d.workspace_id, d.keeper_id, d.reference_count, d.last_referenced_at
       FROM ranked d
       WHERE d.rn > 1
         AND NOT ${buildRetentionProtectedMemorySql("d.id", "d.content")}
         ${notReferenced}`,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    keeper_id: string;
    reference_count: number;
    last_referenced_at: number | null;
  }>;
  if (rows.length === 0) return;

  const bump = ctx.db.prepare(
    `UPDATE memories
     SET reference_count = COALESCE(reference_count, 0) + ?,
         last_referenced_at = MAX(COALESCE(last_referenced_at, 0), ?)
     WHERE id = ?`,
  );
  const bumps = new Map<string, { references: number; lastReferencedAt: number }>();
  for (const row of rows) {
    const current = bumps.get(row.keeper_id) ?? { references: 0, lastReferencedAt: 0 };
    current.references += 1 + Math.max(0, Number(row.reference_count) || 0);
    current.lastReferencedAt = Math.max(current.lastReferencedAt, row.last_referenced_at ?? 0);
    bumps.set(row.keeper_id, current);
    ctx.workspaceIds.add(row.workspace_id);
    ctx.memoryIds.add(row.id);
  }
  ctx.db.transaction(() => {
    for (const [keeperId, value] of bumps) {
      bump.run(value.references, value.lastReferencedAt, keeperId);
    }
  })();
  ctx.counts.duplicatesCollapsed = deleteMemoryRows(
    ctx.db,
    rows.map((row) => row.id),
  );
}

/** (c) Secret values in stored text. */
function redactStoredSecrets(ctx: PhaseContext): void {
  const select = ctx.db.prepare(
    `SELECT rowid, id, workspace_id, content, summary FROM memories
     WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const updateMemory = ctx.db.prepare(
    "UPDATE memories SET content = ?, summary = ?, updated_at = ? WHERE id = ?",
  );
  // The embedding was computed from the secret-bearing text; the backfill recomputes it.
  const dropEmbedding = ctx.db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
  const hasObservations = tableExists(ctx.db, "memory_observation_metadata");
  const updateHash = hasObservations
    ? ctx.db.prepare("UPDATE memory_observation_metadata SET content_hash = ? WHERE memory_id = ?")
    : null;
  const now = ctx.now;
  let afterRowid = 0;
  for (;;) {
    const rows = select.all(afterRowid, BATCH_SIZE) as Array<{
      rowid: number;
      id: string;
      workspace_id: string;
      content: string | null;
      summary: string | null;
    }>;
    if (rows.length === 0) break;
    afterRowid = rows[rows.length - 1].rowid;
    ctx.db.transaction(() => {
      for (const row of rows) {
        const content = redactSecrets(row.content || "");
        const summary = row.summary ? redactSecrets(row.summary) : null;
        if (content.count === 0 && (!summary || summary.count === 0)) continue;
        updateMemory.run(content.text, summary ? summary.text : row.summary, now, row.id);
        dropEmbedding.run(row.id);
        updateHash?.run(observationContentHash(content.text), row.id);
        ctx.counts.memoriesRedacted += 1;
        ctx.workspaceIds.add(row.workspace_id);
        ctx.memoryIds.add(row.id);
      }
    })();
  }

  if (!hasObservations) return;
  const selectObservations = ctx.db.prepare(
    `SELECT rowid, memory_id, title, subtitle, narrative FROM memory_observation_metadata
     WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  const updateObservation = ctx.db.prepare(
    `UPDATE memory_observation_metadata
     SET title = ?, subtitle = ?, narrative = ?, updated_at = ?
     WHERE memory_id = ?`,
  );
  afterRowid = 0;
  for (;;) {
    const rows = selectObservations.all(afterRowid, BATCH_SIZE) as Array<{
      rowid: number;
      memory_id: string;
      title: string | null;
      subtitle: string | null;
      narrative: string | null;
    }>;
    if (rows.length === 0) break;
    afterRowid = rows[rows.length - 1].rowid;
    ctx.db.transaction(() => {
      for (const row of rows) {
        const title = redactSecrets(row.title || "");
        const subtitle = redactSecrets(row.subtitle || "");
        const narrative = redactSecrets(row.narrative || "");
        if (title.count + subtitle.count + narrative.count === 0) continue;
        updateObservation.run(
          title.text,
          row.subtitle === null ? null : subtitle.text,
          narrative.text,
          now,
          row.memory_id,
        );
        ctx.counts.observationsRedacted += 1;
      }
    })();
  }
}

/** (d) Spoofed import prefixes on rows a non-import capture wrote. */
function neutralizeSpoofedImportPrefixes(ctx: PhaseContext): void {
  if (!tableExists(ctx.db, "memory_observation_metadata")) return;
  const rows = ctx.db
    .prepare(
      `SELECT m.id, m.workspace_id, m.content FROM memories m
       JOIN memory_observation_metadata o ON o.memory_id = m.id
       WHERE o.generated_by = 'capture' AND o.origin <> 'import'
         AND (LTRIM(m.content) LIKE '[Imported from %'
              OR LTRIM(m.content) LIKE '[cowork:prompt_recall=ignore]%')`,
    )
    .all() as Array<{ id: string; workspace_id: string; content: string }>;
  if (rows.length === 0) return;
  const update = ctx.db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?");
  const updateHash = ctx.db.prepare(
    "UPDATE memory_observation_metadata SET content_hash = ? WHERE memory_id = ?",
  );
  const now = ctx.now;
  ctx.db.transaction(() => {
    for (const row of rows) {
      const neutralized = neutralizeReservedImportPrefix(row.content);
      if (neutralized === row.content) continue;
      update.run(neutralized, now, row.id);
      updateHash.run(observationContentHash(neutralized), row.id);
      ctx.counts.importPrefixesNeutralized += 1;
      ctx.workspaceIds.add(row.workspace_id);
      ctx.memoryIds.add(row.id);
    }
  })();
}

/** (e) Child rows whose memory is gone. */
function deleteOrphans(ctx: PhaseContext): void {
  ctx.counts.orphanEmbeddingsDeleted = ctx.db
    .prepare(
      `DELETE FROM memory_embeddings
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_embeddings.memory_id)`,
    )
    .run().changes;
  if (tableExists(ctx.db, "memory_observation_metadata")) {
    ctx.counts.orphanObservationsDeleted = ctx.db
      .prepare(
        `DELETE FROM memory_observation_metadata
         WHERE NOT EXISTS (
           SELECT 1 FROM memories m WHERE m.id = memory_observation_metadata.memory_id
         )`,
      )
      .run().changes;
  }
}

export const MEMORY_CLEANUP_PHASES = [
  "rawTelemetry",
  "duplicates",
  "secrets",
  "importPrefixes",
  "orphans",
] as const;
export type MemoryCleanupPhase = (typeof MEMORY_CLEANUP_PHASES)[number];

const PHASES: Record<MemoryCleanupPhase, (ctx: PhaseContext) => void> = {
  rawTelemetry: deleteRawTelemetry,
  duplicates: collapseDuplicates,
  secrets: redactStoredSecrets,
  importPrefixes: neutralizeSpoofedImportPrefixes,
  orphans: deleteOrphans,
};

export interface MemoryCleanupPhaseResult {
  /** Only the counts this phase sets are non-zero. */
  counts: MemoryCleanupCounts;
  workspaceIds: string[];
  memoryIds: string[];
}

/** Whether the cleanup still has to run: the memories table exists and no marker does. */
export function isMemoryCleanupMigrationPending(db: Database.Database): boolean {
  return tableExists(db, "memories") && !hasMemoryCleanupMigrationRun(db);
}

/** Run one cleanup phase over the archive. */
export function runMemoryCleanupPhase(
  db: Database.Database,
  phase: MemoryCleanupPhase,
  now: number,
): MemoryCleanupPhaseResult {
  const ctx: PhaseContext = {
    db,
    counts: emptyMemoryCleanupCounts(),
    workspaceIds: new Set(),
    memoryIds: new Set(),
    protectedSql: buildRetentionProtectedMemorySql("m.id", "m.content"),
    now,
  };
  PHASES[phase](ctx);
  return {
    counts: ctx.counts,
    workspaceIds: [...ctx.workspaceIds],
    memoryIds: [...ctx.memoryIds],
  };
}

/** Record the marker (with the final counts) so the cleanup never runs again. */
export function recordMemoryCleanupMigration(
  db: Database.Database,
  counts: MemoryCleanupCounts,
  now: number,
): void {
  ensureMarkerTable(db);
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MEMORY_CLEANUP_MIGRATION_KEY, JSON.stringify(counts), now);
}
