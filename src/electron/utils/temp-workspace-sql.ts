import type Database from "better-sqlite3";
import { TEMP_WORKSPACE_ID, TEMP_WORKSPACE_ID_PREFIX } from "../../shared/types";
import { createLogger } from "./logger";

const logger = createLogger("TempWorkspace");

export interface TempWorkspaceRow {
  id: string;
  path: string;
  last_used_at: number;
  created_at: number;
}

const TEMP_ID_PREFIX_LENGTH = TEMP_WORKSPACE_ID_PREFIX.length;
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteSqlIdentifier = (identifier: string): string => `"${identifier}"`;

const SQL_IN_CHUNK_SIZE = 500;

type ReferenceAction = "delete" | "nullify";

/**
 * What to do with a row that still references (through a NO ACTION / RESTRICT foreign key) a row
 * removed together with a temp workspace, keyed by `child_table.column`.
 *
 * Relations not listed here fall back to the column's nullability: a NOT NULL reference means the
 * row cannot exist without its parent, so it is deleted; a nullable reference is an optional link,
 * so it is set to NULL and the row is kept. ON DELETE CASCADE relations are always followed as
 * deletes (so their own dependents are handled too); ON DELETE SET NULL / SET DEFAULT relations are
 * left to SQLite. A "nullify" entry on a NOT NULL column is treated as "delete".
 */
const TEMP_WORKSPACE_REFERENCE_POLICY: Record<string, ReferenceAction> = {
  // A team run is owned by its root task. Its items and thoughts go with it via team_run_id
  // (ON DELETE CASCADE), and managed sessions of the temp workspace go via workspace_id.
  "agent_team_runs.root_task_id": "delete",
  // Channel messages are owned by their session, even though the column is nullable.
  "channel_messages.session_id": "delete",
  // Team items/thoughts and managed sessions/events that belong to a removed run or session are
  // removed through that owner. When the owner survives (it lives in another workspace), keep the
  // row and drop only its link to the temp task/run.
  "agent_team_items.source_task_id": "nullify",
  "agent_team_thoughts.source_task_id": "nullify",
  "managed_sessions.backing_task_id": "nullify",
  "managed_sessions.backing_team_run_id": "nullify",
  "managed_session_events.source_task_id": "nullify",
  // Optional provenance/config links from rows that outlive the temp workspace.
  "tasks.branch_from_task_id": "nullify",
  "tasks.parent_task_id": "nullify",
  "eval_cases.source_task_id": "nullify",
  "supervisor_exchanges.linked_task_id": "nullify",
  "dreaming_runs.source_task_id": "nullify",
  "strategic_planner_configs.planning_workspace_id": "nullify",
  "companies.default_workspace_id": "nullify",
};

interface CleanupForeignKey {
  childTable: string;
  childColumn: string;
  childNotNull: boolean;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
}

interface TempWorkspaceCleanupSchema {
  tables: string[];
  columns: Map<string, Set<string>>;
  rowidTables: Set<string>;
  /** Foreign keys keyed by the referenced (parent) table. */
  incoming: Map<string, CleanupForeignKey[]>;
}

const readTempWorkspaceCleanupSchema = (db: Database.Database): TempWorkspaceCleanupSchema => {
  const tableRows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: string; sql?: string | null }>;

  const tables: string[] = [];
  const tableByLowerName = new Map<string, string>();
  const rowidTables = new Set<string>();
  for (const row of tableRows) {
    const name = String(row.name || "");
    if (!name || name.startsWith("sqlite_") || !SAFE_SQL_IDENTIFIER.test(name)) continue;
    tables.push(name);
    tableByLowerName.set(name.toLowerCase(), name);
    // Only rowid tables can be tracked row-by-row. WITHOUT ROWID tables in this schema are FTS
    // internals, which carry no foreign keys.
    if (!/\bWITHOUT\s+ROWID\b/i.test(String(row.sql || ""))) rowidTables.add(name);
  }

  const columns = new Map<string, Set<string>>();
  const notNullColumns = new Map<string, Set<string>>();
  const primaryKeys = new Map<string, string[]>();
  for (const tableName of tables) {
    const columnRows = db
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
      .all() as Array<{ name?: string; notnull?: number; pk?: number }>;
    const safeColumns = columnRows.filter((row) =>
      SAFE_SQL_IDENTIFIER.test(String(row.name || "")),
    );
    columns.set(tableName, new Set(safeColumns.map((row) => String(row.name))));
    notNullColumns.set(
      tableName,
      new Set(
        safeColumns.filter((row) => Number(row.notnull) === 1).map((row) => String(row.name)),
      ),
    );
    primaryKeys.set(
      tableName,
      safeColumns
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name)),
    );
  }

  const incoming = new Map<string, CleanupForeignKey[]>();
  for (const childTable of tables) {
    const fkRows = db
      .prepare(`PRAGMA foreign_key_list(${quoteSqlIdentifier(childTable)})`)
      .all() as Array<{
      id?: number;
      table?: string;
      from?: string;
      to?: string | null;
      on_delete?: string;
    }>;
    const fkGroups = new Map<number, typeof fkRows>();
    for (const row of fkRows) {
      const id = Number(row.id);
      fkGroups.set(id, [...(fkGroups.get(id) ?? []), row]);
    }
    for (const group of fkGroups.values()) {
      // Composite foreign keys are not used by this schema; skip rather than guess.
      if (group.length !== 1) continue;
      const [row] = group;
      const parentTable = tableByLowerName.get(String(row.table || "").toLowerCase());
      const childColumn = String(row.from || "");
      if (!parentTable || !columns.get(childTable)?.has(childColumn)) continue;
      const parentPrimaryKey = primaryKeys.get(parentTable) ?? [];
      const parentColumn = row.to
        ? String(row.to)
        : parentPrimaryKey.length === 1
          ? parentPrimaryKey[0]
          : "";
      if (!parentColumn || !columns.get(parentTable)?.has(parentColumn)) continue;
      const foreignKey: CleanupForeignKey = {
        childTable,
        childColumn,
        childNotNull: notNullColumns.get(childTable)?.has(childColumn) ?? false,
        parentTable,
        parentColumn,
        onDelete: String(row.on_delete || "NO ACTION").toUpperCase(),
      };
      incoming.set(parentTable, [...(incoming.get(parentTable) ?? []), foreignKey]);
    }
  }

  return { tables, columns, rowidTables, incoming };
};

const resolveReferenceAction = (foreignKey: CleanupForeignKey): ReferenceAction | null => {
  if (foreignKey.onDelete === "CASCADE") return "delete";
  if (foreignKey.onDelete === "SET NULL" || foreignKey.onDelete === "SET DEFAULT") return null;
  const policy =
    TEMP_WORKSPACE_REFERENCE_POLICY[`${foreignKey.childTable}.${foreignKey.childColumn}`];
  if (policy === "delete" || foreignKey.childNotNull) return "delete";
  return "nullify";
};

const forEachChunk = <T>(values: T[], run: (chunk: T[], placeholders: string) => void): void => {
  for (let i = 0; i < values.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = values.slice(i, i + SQL_IN_CHUNK_SIZE);
    run(chunk, chunk.map(() => "?").join(", "));
  }
};

const selectRowidsWhereIn = (
  db: Database.Database,
  tableName: string,
  columnName: string,
  values: unknown[],
): number[] => {
  const rowids: number[] = [];
  forEachChunk(values, (chunk, placeholders) => {
    const rows = db
      .prepare(
        `SELECT rowid AS rid FROM ${quoteSqlIdentifier(tableName)} WHERE ${quoteSqlIdentifier(columnName)} IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ rid: number }>;
    for (const row of rows) rowids.push(row.rid);
  });
  return rowids;
};

const selectColumnValuesByRowid = (
  db: Database.Database,
  tableName: string,
  columnName: string,
  rowids: number[],
): unknown[] => {
  const values: unknown[] = [];
  forEachChunk(rowids, (chunk, placeholders) => {
    const rows = db
      .prepare(
        `SELECT ${quoteSqlIdentifier(columnName)} AS value FROM ${quoteSqlIdentifier(tableName)} WHERE rowid IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ value: unknown }>;
    for (const row of rows) {
      if (row.value !== null && row.value !== undefined) values.push(row.value);
    }
  });
  return values;
};

const deleteRowsByIds = (
  db: Database.Database,
  tableName: string,
  columnName: string,
  ids: string[],
): void => {
  forEachChunk(ids, (chunk, placeholders) => {
    db.prepare(
      `DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE ${quoteSqlIdentifier(columnName)} IN (${placeholders})`,
    ).run(...chunk);
  });
};

/**
 * Removes a temp workspace and every row that belongs to it, in one transaction.
 *
 * 1. Seed the removal set: the workspace row, rows whose `workspace_id` is the workspace, and rows
 *    whose `task_id` / `session_id` point at the workspace's tasks / channel sessions.
 * 2. Walk `PRAGMA foreign_key_list` from every removed row to the rows still referencing it, and
 *    either add them to the removal set or schedule their reference to be nulled (see
 *    TEMP_WORKSPACE_REFERENCE_POLICY). Discovering references this way keeps new tables covered.
 * 3. Null optional references, then delete children before parents. Foreign keys are deferred to
 *    commit so self-references and cycles (e.g. tasks.branch_from_task_id) cannot fail midway.
 */
export const deleteWorkspaceAndRelatedData = (
  db: Database.Database,
  workspaceId: string,
  // Read inside the transaction by default; each unit is one workspace, so its schema read
  // cannot go stale between units.
  getSchema: () => TempWorkspaceCleanupSchema = () => readTempWorkspaceCleanupSchema(db),
): boolean => {
  try {
    const runCleanup = db.transaction(() => {
      const schema = getSchema();
      const doomed = new Map<string, Set<number>>();
      const pending: Array<{ table: string; rowids: number[] }> = [];
      const doom = (table: string, rowids: number[]): void => {
        const existing = doomed.get(table) ?? new Set<number>();
        doomed.set(table, existing);
        const fresh = rowids.filter((rowid) => !existing.has(rowid));
        for (const rowid of fresh) existing.add(rowid);
        if (fresh.length > 0) pending.push({ table, rowids: fresh });
      };

      const taskIds = (
        db.prepare("SELECT id FROM tasks WHERE workspace_id = ?").all(workspaceId) as Array<{
          id?: string;
        }>
      )
        .map((row) => String(row.id || ""))
        .filter(Boolean);
      const sessionIds = (
        db
          .prepare("SELECT id FROM channel_sessions WHERE workspace_id = ?")
          .all(workspaceId) as Array<{
          id?: string;
        }>
      )
        .map((row) => String(row.id || ""))
        .filter(Boolean);

      doom("workspaces", selectRowidsWhereIn(db, "workspaces", "id", [workspaceId]));
      for (const tableName of schema.tables) {
        const columns = schema.columns.get(tableName);
        if (!columns || tableName === "workspaces") continue;
        const seeds: Array<[string, string[]]> = [
          ["task_id", taskIds],
          ["session_id", sessionIds],
          ["workspace_id", [workspaceId]],
        ];
        for (const [columnName, ids] of seeds) {
          if (!columns.has(columnName)) continue;
          if (schema.rowidTables.has(tableName)) {
            doom(tableName, selectRowidsWhereIn(db, tableName, columnName, ids));
          } else {
            deleteRowsByIds(db, tableName, columnName, ids);
          }
        }
      }

      const nullifications = new Map<
        string,
        { foreignKey: CleanupForeignKey; rowids: Set<number> }
      >();
      for (let index = 0; index < pending.length; index += 1) {
        const { table, rowids } = pending[index];
        for (const foreignKey of schema.incoming.get(table) ?? []) {
          if (!schema.rowidTables.has(foreignKey.childTable)) continue;
          const action = resolveReferenceAction(foreignKey);
          if (!action) continue;
          const keys = selectColumnValuesByRowid(db, table, foreignKey.parentColumn, rowids);
          if (keys.length === 0) continue;
          const childRowids = selectRowidsWhereIn(
            db,
            foreignKey.childTable,
            foreignKey.childColumn,
            keys,
          );
          if (childRowids.length === 0) continue;
          if (action === "delete") {
            doom(foreignKey.childTable, childRowids);
            continue;
          }
          const key = `${foreignKey.childTable}.${foreignKey.childColumn}`;
          const entry = nullifications.get(key) ?? { foreignKey, rowids: new Set<number>() };
          nullifications.set(key, entry);
          for (const rowid of childRowids) entry.rowids.add(rowid);
        }
      }

      db.pragma("defer_foreign_keys = ON");

      for (const { foreignKey, rowids } of nullifications.values()) {
        const removed = doomed.get(foreignKey.childTable);
        const survivors = Array.from(rowids).filter((rowid) => !removed?.has(rowid));
        forEachChunk(survivors, (chunk, placeholders) => {
          db.prepare(
            `UPDATE ${quoteSqlIdentifier(foreignKey.childTable)} SET ${quoteSqlIdentifier(foreignKey.childColumn)} = NULL WHERE rowid IN (${placeholders})`,
          ).run(...chunk);
        });
      }

      // Post-order walk over "is referenced by" edges: referencing tables come before the tables
      // they reference. Cycles are broken arbitrarily; deferred foreign keys cover them.
      const deletionOrder: string[] = [];
      const visited = new Set<string>();
      const visit = (table: string): void => {
        if (visited.has(table)) return;
        visited.add(table);
        for (const foreignKey of schema.incoming.get(table) ?? []) {
          if (doomed.has(foreignKey.childTable)) visit(foreignKey.childTable);
        }
        deletionOrder.push(table);
      };
      for (const table of doomed.keys()) visit(table);

      for (const table of deletionOrder) {
        forEachChunk(Array.from(doomed.get(table) ?? []), (chunk, placeholders) => {
          db.prepare(
            `DELETE FROM ${quoteSqlIdentifier(table)} WHERE rowid IN (${placeholders})`,
          ).run(...chunk);
        });
      }
    });

    runCleanup();
    return true;
  } catch (error) {
    try {
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      logger.warn(
        `Could not remove related data for temp workspace ${workspaceId}; removed the workspace row only:`,
        error,
      );
      return true;
    } catch {
      logger.warn(
        `Could not remove temp workspace ${workspaceId}; it will be retried on the next prune:`,
        error,
      );
      return false;
    }
  }
};

function hasWorkspaceReferences(
  db: Database.Database,
  workspaceId: string,
  activeTaskStatuses: string[],
  sessionActiveCutoffMs: number,
): boolean {
  const statusPlaceholders = activeTaskStatuses.map(() => "?").join(", ");
  const taskRef = db
    .prepare(
      `SELECT 1 FROM tasks WHERE workspace_id = ? AND status IN (${statusPlaceholders}) LIMIT 1`,
    )
    .get(workspaceId, ...activeTaskStatuses);
  if (taskRef) return true;
  const sessionRef = db
    .prepare(
      "SELECT 1 FROM channel_sessions WHERE workspace_id = ? AND (state != 'idle' OR COALESCE(last_activity_at, created_at) >= ?) LIMIT 1",
    )
    .get(workspaceId, sessionActiveCutoffMs);
  return !!sessionRef;
}

/**
 * Temp workspace pruning's SQL (async SQLite migration plan, DB6): the temp workspace rows,
 * which of them active tasks or channel sessions still use, and deleting a workspace with
 * its dependent rows. As services-domain units these run in the database worker when the
 * domain is routed there; directory removal stays on the host in `pruneTempWorkspaces`.
 */
export class TempWorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  tempWorkspaceRows(): TempWorkspaceRow[] {
    return this.db
      .prepare(
        `
    SELECT id, path, created_at, COALESCE(last_used_at, created_at) AS last_used_at
    FROM workspaces
    WHERE id = ? OR substr(id, 1, ?) = ?
    ORDER BY COALESCE(last_used_at, created_at) DESC
  `,
      )
      .all(
        TEMP_WORKSPACE_ID,
        TEMP_ID_PREFIX_LENGTH,
        TEMP_WORKSPACE_ID_PREFIX,
      ) as TempWorkspaceRow[];
  }

  /** Temp workspaces referenced by a task in one of `activeTaskStatuses`. */
  activeTaskWorkspaceIds(activeTaskStatuses: string[]): string[] {
    if (activeTaskStatuses.length === 0) return [];
    const taskStatusPlaceholders = activeTaskStatuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
    SELECT DISTINCT workspace_id
    FROM tasks
    WHERE (workspace_id = ? OR substr(workspace_id, 1, ?) = ?)
      AND status IN (${taskStatusPlaceholders})
  `,
      )
      .all(
        TEMP_WORKSPACE_ID,
        TEMP_ID_PREFIX_LENGTH,
        TEMP_WORKSPACE_ID_PREFIX,
        ...activeTaskStatuses,
      ) as Array<{ workspace_id: string | null }>;
    return rows
      .map((row) => (typeof row.workspace_id === "string" ? row.workspace_id : ""))
      .filter(Boolean);
  }

  /** Temp workspaces with a non-idle or recently active channel session. */
  activeSessionWorkspaceIds(sessionActiveCutoffMs: number): string[] {
    const rows = this.db
      .prepare(
        `
    SELECT DISTINCT workspace_id
    FROM channel_sessions
    WHERE (workspace_id = ? OR substr(workspace_id, 1, ?) = ?)
      AND (state != 'idle' OR COALESCE(last_activity_at, created_at) >= ?)
  `,
      )
      .all(
        TEMP_WORKSPACE_ID,
        TEMP_ID_PREFIX_LENGTH,
        TEMP_WORKSPACE_ID_PREFIX,
        sessionActiveCutoffMs,
      ) as Array<{ workspace_id: string | null }>;
    return rows
      .map((row) => (typeof row.workspace_id === "string" ? row.workspace_id : ""))
      .filter(Boolean);
  }

  /**
   * Delete a workspace and its dependent rows unless an active task or session uses it;
   * as a unit the check and the delete share one transaction. Returns whether it was
   * deleted.
   */
  deleteUnreferencedWorkspace(
    workspaceId: string,
    activeTaskStatuses: string[],
    sessionActiveCutoffMs: number,
  ): boolean {
    if (hasWorkspaceReferences(this.db, workspaceId, activeTaskStatuses, sessionActiveCutoffMs)) {
      return false;
    }
    return deleteWorkspaceAndRelatedData(this.db, workspaceId);
  }

  isReferenced(
    workspaceId: string,
    activeTaskStatuses: string[],
    sessionActiveCutoffMs: number,
  ): boolean {
    return hasWorkspaceReferences(this.db, workspaceId, activeTaskStatuses, sessionActiveCutoffMs);
  }
}
