import type Database from "better-sqlite3";
import { TEMP_WORKSPACE_ID, TEMP_WORKSPACE_ID_PREFIX } from "../../shared/types";

export interface TempWorkspaceRow {
  id: string;
  path: string;
  last_used_at: number;
  created_at: number;
}

const TEMP_ID_PREFIX_LENGTH = TEMP_WORKSPACE_ID_PREFIX.length;
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteSqlIdentifier = (identifier: string): string => `"${identifier}"`;

const deleteRowsByIds = (
  db: Database.Database,
  tableName: string,
  columnName: string,
  ids: string[],
): void => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE ${quoteSqlIdentifier(columnName)} IN (${placeholders})`,
  ).run(...ids);
};

export function deleteWorkspaceAndRelatedData(db: Database.Database, workspaceId: string): boolean {
  try {
    const runCleanup = db.transaction(() => {
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name?: string }>;

      const tables = tableRows
        .map((row) => String(row.name || ""))
        .filter(
          (name) =>
            !!name &&
            !name.startsWith("sqlite_") &&
            SAFE_SQL_IDENTIFIER.test(name) &&
            name !== "workspaces",
        );

      const tableColumns = new Map<string, Set<string>>();
      for (const tableName of tables) {
        const columnRows = db
          .prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
          .all() as Array<{ name?: string }>;
        const columns = new Set(
          columnRows
            .map((row) => String(row.name || ""))
            .filter((name) => SAFE_SQL_IDENTIFIER.test(name)),
        );
        tableColumns.set(tableName, columns);
      }

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

      for (const tableName of tables) {
        const columns = tableColumns.get(tableName);
        if (!columns) continue;
        if (columns.has("task_id")) {
          deleteRowsByIds(db, tableName, "task_id", taskIds);
        }
        if (columns.has("session_id")) {
          deleteRowsByIds(db, tableName, "session_id", sessionIds);
        }
      }

      for (const tableName of tables) {
        const columns = tableColumns.get(tableName);
        if (!columns || !columns.has("workspace_id")) continue;
        db.prepare(`DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE workspace_id = ?`).run(
          workspaceId,
        );
      }

      db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    });

    runCleanup();
    return true;
  } catch {
    try {
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      return true;
    } catch {
      return false;
    }
  }
}

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
