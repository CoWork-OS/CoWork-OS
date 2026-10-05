import type Database from "better-sqlite3";
import { defineReadUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { fields, int, str } from "../database/statements/unit-args";
import { buildImportedMemoryFilterSql } from "../database/fts-utils";
import {
  MEMORY_HEALTH_MAINTENANCE_KEYS,
  type MemorySourceCount,
} from "../../shared/memory-health-types";

/**
 * Aggregate queries behind the Memory Hub "Sources" and "Health" tabs (audit §8.4). Read
 * units only: counts, ratios and timestamps, never memory content. The health SQL is the
 * same as scripts/qa/memory-health.mjs (Appendix A of the memory audit); both read their
 * thresholds from src/shared/memory-health-thresholds.json. A table that does not exist
 * yields null, which the service reports as a skipped check.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column),
  );
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number | null } | undefined;
  return Number(row?.n ?? 0) || 0;
}

function keyCounts(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): Array<{ key: string; count: number }> {
  return (db.prepare(sql).all(...params) as Array<{ key: string | null; n: number }>).map(
    (row) => ({ key: row.key ?? "(none)", count: Number(row.n) || 0 }),
  );
}

// ---------------------------------------------------------------------------------------
// Sources (per workspace)

export interface MemorySourcesCounts {
  facts: {
    total: number;
    bySource: MemorySourceCount[];
    byStore: MemorySourceCount[];
    imported: number;
  };
  archive: {
    total: number;
    private: number;
    byType: Array<{ key: string; count: number }>;
    byOrigin: Array<{ key: string; count: number }>;
    imported: number;
    screenContext: number;
  };
  supermemoryRemoteRefs: number;
  knowledgeGraph: {
    entities: number;
    edges: number;
    observations: number;
    byType: Array<{ key: string; count: number }>;
  };
}

/** Facts visible in the workspace's Hub view, pivoted into workspace / global / contacts. */
function factCounts(
  db: Database.Database,
  workspaceId: string,
  keyExpr: string,
): MemorySourceCount[] {
  const rows = db
    .prepare(
      `SELECT ${keyExpr} AS key,
         sum(CASE WHEN scope = 'global' THEN 0 WHEN workspace_id = ? THEN 1 ELSE 0 END) AS workspace,
         sum(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global,
         sum(CASE WHEN scope <> 'global' AND workspace_id IS NULL THEN 1 ELSE 0 END) AS contacts
       FROM memory_items
       WHERE status = 'active' AND (workspace_id IS NULL OR workspace_id = ?)
       GROUP BY 1 ORDER BY count(*) DESC, 1`,
    )
    .all(workspaceId, workspaceId) as Array<{
    key: string | null;
    workspace: number;
    global: number;
    contacts: number;
  }>;
  return rows.map((row) => ({
    key: row.key ?? "(none)",
    workspace: Number(row.workspace) || 0,
    global: Number(row.global) || 0,
    contacts: Number(row.contacts) || 0,
  }));
}

export function collectMemorySources(
  db: Database.Database,
  args: { workspaceId: string },
): MemorySourcesCounts {
  const { workspaceId } = args;
  const result: MemorySourcesCounts = {
    facts: { total: 0, bySource: [], byStore: [], imported: 0 },
    archive: { total: 0, private: 0, byType: [], byOrigin: [], imported: 0, screenContext: 0 },
    supermemoryRemoteRefs: 0,
    knowledgeGraph: { entities: 0, edges: 0, observations: 0, byType: [] },
  };

  if (tableExists(db, "memory_items")) {
    result.facts.bySource = factCounts(db, workspaceId, "source");
    result.facts.byStore = factCounts(db, workspaceId, "json_extract(source_ref, '$.store')");
    result.facts.total = result.facts.bySource.reduce(
      (sum, row) => sum + row.workspace + row.global + row.contacts,
      0,
    );
    const imported = result.facts.bySource.find((row) => row.key === "import");
    result.facts.imported = imported ? imported.workspace + imported.global + imported.contacts : 0;
  }

  if (tableExists(db, "memories")) {
    const totals = db
      .prepare(
        `SELECT count(*) AS total, COALESCE(sum(is_private = 1), 0) AS private,
           COALESCE(sum(type = 'screen_context'), 0) AS screen,
           COALESCE(sum(${buildImportedMemoryFilterSql("content")}), 0) AS imported
         FROM memories WHERE workspace_id = ?`,
      )
      .get(workspaceId) as { total: number; private: number; screen: number; imported: number };
    result.archive.total = Number(totals.total) || 0;
    result.archive.private = Number(totals.private) || 0;
    result.archive.screenContext = Number(totals.screen) || 0;
    result.archive.imported = Number(totals.imported) || 0;
    result.archive.byType = keyCounts(
      db,
      `SELECT type AS key, count(*) AS n FROM memories WHERE workspace_id = ?
       GROUP BY 1 ORDER BY 2 DESC, 1`,
      workspaceId,
    );
    result.archive.byOrigin = tableExists(db, "memory_observation_metadata")
      ? keyCounts(
          db,
          `SELECT COALESCE(om.origin, 'unknown') AS key, count(*) AS n
           FROM memories m LEFT JOIN memory_observation_metadata om ON om.memory_id = m.id
           WHERE m.workspace_id = ? GROUP BY 1 ORDER BY 2 DESC, 1`,
          workspaceId,
        )
      : [];
  }

  if (tableExists(db, "supermemory_remote_refs")) {
    result.supermemoryRemoteRefs = count(
      db,
      "SELECT count(*) AS n FROM supermemory_remote_refs WHERE workspace_id = ?",
      workspaceId,
    );
  }

  if (tableExists(db, "kg_entities")) {
    const kg = result.knowledgeGraph;
    kg.entities = count(
      db,
      "SELECT count(*) AS n FROM kg_entities WHERE workspace_id = ?",
      workspaceId,
    );
    kg.byType = tableExists(db, "kg_entity_types")
      ? keyCounts(
          db,
          `SELECT COALESCE(t.name, 'unknown') AS key, count(*) AS n
           FROM kg_entities e LEFT JOIN kg_entity_types t ON t.id = e.entity_type_id
           WHERE e.workspace_id = ? GROUP BY 1 ORDER BY 2 DESC, 1`,
          workspaceId,
        )
      : [];
    if (tableExists(db, "kg_edges")) {
      kg.edges = count(
        db,
        "SELECT count(*) AS n FROM kg_edges WHERE workspace_id = ?",
        workspaceId,
      );
    }
    if (tableExists(db, "kg_observations")) {
      kg.observations = count(
        db,
        `SELECT count(*) AS n FROM kg_observations o
         JOIN kg_entities e ON e.id = o.entity_id WHERE e.workspace_id = ?`,
        workspaceId,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// Health (whole profile database)

/** The archive's telemetry classes, as in scripts/qa/memory-health.mjs. */
const TELEMETRY_KIND_SQL = `CASE
  WHEN content LIKE 'Tool called:%' OR content LIKE 'Tool result for%'
    OR content LIKE 'Step completed:%' OR content LIKE '{"stepId"%'
    OR content LIKE '{"taskId"%' OR content LIKE '{"groupId"%' THEN 'raw_event'
  WHEN content LIKE '[core-trace:%' THEN 'core_trace'
  ELSE 'other' END`;

export interface MemoryHealthCounts {
  archive: { total: number; telemetry: number; duplicateRows: number } | null;
  memoryItems: { active: number; duplicateRows: number } | null;
  heartbeat: { stuck: number } | null;
  dreaming: {
    stuck: number;
    lastRunAt: number | null;
    failedLast7d: number;
    /** LLM tokens of runs created in the last 24 hours; null without the column. */
    llmTokensLastDay: number | null;
  } | null;
  embeddings: { total: number; orphans: number } | null;
  pendingWrites: { pending: number } | null;
  database: { totalBytes: number; freelistBytes: number };
  markers: Array<{ key: string; present: boolean; updatedAt: number | null }> | null;
}

export function collectMemoryHealth(
  db: Database.Database,
  args: { now: number; stuckAfterMs: number },
): MemoryHealthCounts {
  const stuckBefore = args.now - args.stuckAfterMs;
  const pageSize = Number(db.pragma("page_size", { simple: true })) || 0;
  const result: MemoryHealthCounts = {
    archive: null,
    memoryItems: null,
    heartbeat: null,
    dreaming: null,
    embeddings: null,
    pendingWrites: null,
    database: {
      totalBytes: pageSize * (Number(db.pragma("page_count", { simple: true })) || 0),
      freelistBytes: pageSize * (Number(db.pragma("freelist_count", { simple: true })) || 0),
    },
    markers: null,
  };

  if (tableExists(db, "memories")) {
    const total = count(db, "SELECT count(*) AS n FROM memories");
    const telemetry = count(
      db,
      `SELECT count(*) AS n FROM memories WHERE (${TELEMETRY_KIND_SQL}) <> 'other'`,
    );
    // Rows beyond the first per (workspace, type, normalized content).
    const groups = count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM memories
       GROUP BY COALESCE(workspace_id, ''), type, lower(trim(content)))`,
    );
    result.archive = { total, telemetry, duplicateRows: total - groups };
  }

  if (tableExists(db, "memory_items")) {
    const active = count(db, "SELECT count(*) AS n FROM memory_items WHERE status = 'active'");
    const groups = count(
      db,
      `SELECT count(*) AS n FROM (SELECT 1 FROM memory_items WHERE status = 'active'
       GROUP BY COALESCE(workspace_id, ''), scope, COALESCE(scope_ref, ''), kind, content_hash)`,
    );
    result.memoryItems = { active, duplicateRows: active - groups };
  }

  if (tableExists(db, "heartbeat_runs")) {
    const start = hasColumn(db, "heartbeat_runs", "started_at")
      ? "COALESCE(started_at, created_at)"
      : "created_at";
    result.heartbeat = {
      stuck: count(
        db,
        `SELECT count(*) AS n FROM heartbeat_runs WHERE status = 'running' AND ${start} < ?`,
        stuckBefore,
      ),
    };
  }

  if (tableExists(db, "dreaming_runs")) {
    const last = db.prepare("SELECT max(started_at) AS t FROM dreaming_runs").get() as {
      t: number | null;
    };
    result.dreaming = {
      stuck: count(
        db,
        "SELECT count(*) AS n FROM dreaming_runs WHERE status = 'running' AND started_at < ?",
        stuckBefore,
      ),
      lastRunAt: typeof last.t === "number" ? last.t : null,
      failedLast7d: count(
        db,
        "SELECT count(*) AS n FROM dreaming_runs WHERE status = 'failed' AND started_at >= ?",
        args.now - 7 * DAY_MS,
      ),
      llmTokensLastDay: hasColumn(db, "dreaming_runs", "llm_tokens")
        ? count(
            db,
            "SELECT COALESCE(sum(llm_tokens), 0) AS n FROM dreaming_runs WHERE created_at >= ?",
            args.now - DAY_MS,
          )
        : null,
    };
  }

  if (tableExists(db, "memory_embeddings")) {
    const total = count(db, "SELECT count(*) AS n FROM memory_embeddings");
    const orphans = tableExists(db, "memories")
      ? count(
          db,
          `SELECT count(*) AS n FROM memory_embeddings e
           WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.memory_id)`,
        )
      : total;
    result.embeddings = { total, orphans };
  }

  if (tableExists(db, "pending_memory_writes")) {
    result.pendingWrites = {
      pending: count(
        db,
        "SELECT count(*) AS n FROM pending_memory_writes WHERE status = 'pending'",
      ),
    };
  }

  if (tableExists(db, "maintenance_state")) {
    const marker = db.prepare(
      "SELECT updated_at AS updatedAt FROM maintenance_state WHERE key = ?",
    );
    result.markers = MEMORY_HEALTH_MAINTENANCE_KEYS.map((key) => {
      const row = marker.get(key) as { updatedAt: number | null } | undefined;
      return { key, present: Boolean(row), updatedAt: row?.updatedAt ?? null };
    });
  }
  return result;
}

export const MEMORY_HEALTH_UNITS = {
  memoryHealth_sources: defineReadUnit(
    fields({ workspaceId: (value: unknown, path: string) => str(value, path, 512) }),
    (db: Database.Database, args) => collectMemorySources(db, args),
  ),
  memoryHealth_check: defineReadUnit(
    fields({
      now: (value: unknown, path: string) => int(value, path),
      stuckAfterMs: (value: unknown, path: string) => int(value, path, 1, 30 * DAY_MS),
    }),
    (db: Database.Database, args) => collectMemoryHealth(db, args),
  ),
} satisfies UnitCatalog;
