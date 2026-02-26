import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { TEMP_WORKSPACE_ID, TEMP_WORKSPACE_ID_PREFIX } from "../../shared/types";

export interface TempWorkspacePruneOptions {
  db: Database.Database;
  tempWorkspaceRoot: string;
  currentWorkspaceId?: string;
  protectedWorkspaceIds?: string[];
  nowMs?: number;
  keepRecent?: number;
  maxAgeMs?: number;
  hardLimit?: number;
  targetAfterPrune?: number;
  activeTaskStatuses?: string[];
  idleSessionProtectMs?: number;
  minAgeForHardPruneMs?: number;
}

interface TempWorkspaceRow {
  id: string;
  path: string;
  last_used_at: number;
  created_at: number;
}

interface TempDirectoryEntry {
  path: string;
  mtimeMs: number;
}

const DEFAULT_KEEP_RECENT = 40;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_HARD_LIMIT = 200;
const DEFAULT_TARGET_AFTER_PRUNE = 120;
const DEFAULT_IDLE_SESSION_PROTECT_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MIN_AGE_FOR_HARD_PRUNE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_TASK_STATUSES = [
  "pending",
  "queued",
  "planning",
  "executing",
  "paused",
  "blocked",
];
const TEMP_ID_PREFIX_LENGTH = TEMP_WORKSPACE_ID_PREFIX.length;
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isSafeTempSubPath = (candidatePath: string, rootPath: string): boolean => {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate === resolvedRoot) return false;
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

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

const deleteWorkspaceAndRelatedData = (db: Database.Database, workspaceId: string): boolean => {
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

      const taskIds = (db.prepare("SELECT id FROM tasks WHERE workspace_id = ?").all(workspaceId) as Array<{
        id?: string;
      }>)
        .map((row) => String(row.id || ""))
        .filter(Boolean);
      const sessionIds = (
        db.prepare("SELECT id FROM channel_sessions WHERE workspace_id = ?").all(workspaceId) as Array<{
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
        db.prepare(`DELETE FROM ${quoteSqlIdentifier(tableName)} WHERE workspace_id = ?`).run(workspaceId);
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
};

const hasWorkspaceReferences = (
  db: Database.Database,
  workspaceId: string,
  activeTaskStatuses: string[],
  sessionActiveCutoffMs: number,
): boolean => {
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
};

const listTempDirectories = (rootPath: string): TempDirectoryEntry[] => {
  if (!fs.existsSync(rootPath)) return [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const dirs: TempDirectoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.resolve(path.join(rootPath, entry.name));
    if (!isSafeTempSubPath(fullPath, rootPath)) continue;
    try {
      const stat = fs.statSync(fullPath);
      dirs.push({
        path: fullPath,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.ctimeMs,
      });
    } catch {
      // Ignore unreadable entries.
    }
  }

  return dirs;
};

export function pruneTempWorkspaces(options: TempWorkspacePruneOptions): {
  removedDirs: number;
  removedRows: number;
} {
  const nowMs = options.nowMs ?? Date.now();
  const keepRecent = Math.max(0, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const hardLimit = Math.max(1, options.hardLimit ?? DEFAULT_HARD_LIMIT);
  const idleSessionProtectMs = Math.max(0, options.idleSessionProtectMs ?? DEFAULT_IDLE_SESSION_PROTECT_MS);
  const minAgeForHardPruneMs = Math.max(
    0,
    options.minAgeForHardPruneMs ?? DEFAULT_MIN_AGE_FOR_HARD_PRUNE_MS,
  );
  const activeTaskStatuses = Array.from(
    new Set(
      (options.activeTaskStatuses && options.activeTaskStatuses.length > 0
        ? options.activeTaskStatuses
        : DEFAULT_ACTIVE_TASK_STATUSES
      ).map((status) => String(status || "").trim()).filter(Boolean),
    ),
  );
  const sessionActiveCutoffMs = nowMs - idleSessionProtectMs;
  const targetAfterPrune = Math.max(
    0,
    Math.min(hardLimit, options.targetAfterPrune ?? DEFAULT_TARGET_AFTER_PRUNE),
  );

  const resolvedRoot = path.resolve(options.tempWorkspaceRoot);

  const rows = options.db
    .prepare(`
    SELECT id, path, created_at, COALESCE(last_used_at, created_at) AS last_used_at
    FROM workspaces
    WHERE id = ? OR substr(id, 1, ?) = ?
    ORDER BY COALESCE(last_used_at, created_at) DESC
  `)
    .all(TEMP_WORKSPACE_ID, TEMP_ID_PREFIX_LENGTH, TEMP_WORKSPACE_ID_PREFIX) as TempWorkspaceRow[];

  const taskStatusPlaceholders = activeTaskStatuses.map(() => "?").join(", ");
  const taskRefRows = activeTaskStatuses.length
    ? (options.db
        .prepare(`
    SELECT DISTINCT workspace_id
    FROM tasks
    WHERE (workspace_id = ? OR substr(workspace_id, 1, ?) = ?)
      AND status IN (${taskStatusPlaceholders})
  `)
        .all(
          TEMP_WORKSPACE_ID,
          TEMP_ID_PREFIX_LENGTH,
          TEMP_WORKSPACE_ID_PREFIX,
          ...activeTaskStatuses,
        ) as Array<{
        workspace_id: string | null;
      }>)
    : [];
  const taskReferencedWorkspaceIds = new Set(
    taskRefRows
      .map((row) => (typeof row.workspace_id === "string" ? row.workspace_id : ""))
      .filter(Boolean),
  );

  const sessionRefRows = options.db
    .prepare(`
    SELECT DISTINCT workspace_id
    FROM channel_sessions
    WHERE (workspace_id = ? OR substr(workspace_id, 1, ?) = ?)
      AND (state != 'idle' OR COALESCE(last_activity_at, created_at) >= ?)
  `)
    .all(
      TEMP_WORKSPACE_ID,
      TEMP_ID_PREFIX_LENGTH,
      TEMP_WORKSPACE_ID_PREFIX,
      sessionActiveCutoffMs,
    ) as Array<{
    workspace_id: string | null;
  }>;
  const sessionReferencedWorkspaceIds = new Set(
    sessionRefRows
      .map((row) => (typeof row.workspace_id === "string" ? row.workspace_id : ""))
      .filter(Boolean),
  );

  const protectedWorkspaceIds = new Set<string>();
  if (options.currentWorkspaceId) {
    protectedWorkspaceIds.add(options.currentWorkspaceId);
  }
  for (const workspaceId of options.protectedWorkspaceIds ?? []) {
    if (workspaceId) protectedWorkspaceIds.add(workspaceId);
  }
  for (const workspaceId of taskReferencedWorkspaceIds) {
    protectedWorkspaceIds.add(workspaceId);
  }
  for (const workspaceId of sessionReferencedWorkspaceIds) {
    protectedWorkspaceIds.add(workspaceId);
  }

  const protectedIds = new Set<string>();
  for (let i = 0; i < rows.length && i < keepRecent; i += 1) {
    protectedIds.add(rows[i].id);
  }
  for (const workspaceId of protectedWorkspaceIds) {
    protectedIds.add(workspaceId);
  }

  const removableRows = rows.filter((row) => !protectedIds.has(row.id));
  const toDeleteIds = new Set<string>();

  for (const row of removableRows) {
    const ageMs = nowMs - Number(row.last_used_at || row.created_at || nowMs);
    if (ageMs > maxAgeMs) {
      toDeleteIds.add(row.id);
    }
  }

  let remainingCount = rows.length - toDeleteIds.size;
  if (remainingCount > hardLimit) {
    for (let i = removableRows.length - 1; i >= 0 && remainingCount > targetAfterPrune; i -= 1) {
      const id = removableRows[i].id;
      if (toDeleteIds.has(id)) continue;
      const row = removableRows[i];
      const ageMs = nowMs - Number(row.last_used_at || row.created_at || nowMs);
      if (ageMs < minAgeForHardPruneMs) continue;
      toDeleteIds.add(id);
      remainingCount -= 1;
    }
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  let removedDirs = 0;
  let removedRows = 0;

  for (const workspaceId of toDeleteIds) {
    const row = rowsById.get(workspaceId);
    if (!row) continue;

    if (hasWorkspaceReferences(options.db, workspaceId, activeTaskStatuses, sessionActiveCutoffMs)) {
      continue;
    }

    try {
      if (row.path && isSafeTempSubPath(row.path, resolvedRoot) && fs.existsSync(row.path)) {
        fs.rmSync(row.path, { recursive: true, force: true });
        removedDirs += 1;
      }
    } catch {
      // Best-effort cleanup; keep going.
    }

    try {
      if (deleteWorkspaceAndRelatedData(options.db, workspaceId)) {
        removedRows += 1;
      }
    } catch {
      // Best-effort DB cleanup; keep going.
    }
  }

  const rowsAfterDbPrune = options.db
    .prepare(`
    SELECT id, path, created_at, COALESCE(last_used_at, created_at) AS last_used_at
    FROM workspaces
    WHERE id = ? OR substr(id, 1, ?) = ?
    ORDER BY COALESCE(last_used_at, created_at) DESC
  `)
    .all(TEMP_WORKSPACE_ID, TEMP_ID_PREFIX_LENGTH, TEMP_WORKSPACE_ID_PREFIX) as TempWorkspaceRow[];

  const protectedPaths = new Set<string>();
  const workspaceIdsByPath = new Map<string, string[]>();
  for (const row of rowsAfterDbPrune) {
    const resolvedPath = path.resolve(row.path);
    if (!isSafeTempSubPath(resolvedPath, resolvedRoot)) continue;
    protectedPaths.add(resolvedPath);
    const existing = workspaceIdsByPath.get(resolvedPath) ?? [];
    existing.push(row.id);
    workspaceIdsByPath.set(resolvedPath, existing);
  }

  const deleteDirectoryAndStaleRows = (directoryPath: string): boolean => {
    if (!isSafeTempSubPath(directoryPath, resolvedRoot)) return false;
    if (!fs.existsSync(directoryPath)) return false;

    try {
      fs.rmSync(directoryPath, { recursive: true, force: true });
      removedDirs += 1;
    } catch {
      return false;
    }

    const workspaceIds = workspaceIdsByPath.get(directoryPath) ?? [];
    for (const workspaceId of workspaceIds) {
      if (hasWorkspaceReferences(options.db, workspaceId, activeTaskStatuses, sessionActiveCutoffMs)) {
        continue;
      }
      try {
        if (deleteWorkspaceAndRelatedData(options.db, workspaceId)) {
          removedRows += 1;
        }
      } catch {
        // Best-effort DB cleanup.
      }
    }
    return true;
  };

  // Filesystem-level cleanup pass:
  // 1) remove stale orphan dirs by age
  // 2) enforce hard folder cap even when DB rows don't reflect all on-disk dirs
  const directories = listTempDirectories(resolvedRoot);
  const orphanDirectories = directories.filter((entry) => !protectedPaths.has(entry.path));

  for (const entry of orphanDirectories) {
    const ageMs = nowMs - entry.mtimeMs;
    if (ageMs > maxAgeMs) {
      deleteDirectoryAndStaleRows(entry.path);
    }
  }

  const directoriesAfterAgePrune = listTempDirectories(resolvedRoot);
  let remainingDirCount = directoriesAfterAgePrune.length;
  if (remainingDirCount > hardLimit) {
    const candidateDirs = directoriesAfterAgePrune
      .filter((entry) => !protectedPaths.has(entry.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const entry of candidateDirs) {
      if (remainingDirCount <= targetAfterPrune) break;
      if (nowMs - entry.mtimeMs < minAgeForHardPruneMs) continue;
      if (deleteDirectoryAndStaleRows(entry.path)) {
        remainingDirCount -= 1;
      }
    }
  }

  return { removedDirs, removedRows };
}
