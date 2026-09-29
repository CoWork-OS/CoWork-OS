import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import type { TempWorkspaceRow } from "./temp-workspace-sql";
import { TEMP_WORKSPACE_ID, TEMP_WORKSPACE_ID_PREFIX } from "../../shared/types";

export interface TempWorkspacePruneOptions {
  db: Database.Database;
  tempWorkspaceRoot: string;
  currentWorkspaceId?: string;
  protectedWorkspaceIds?: string[];
  dryRun?: boolean;
  nowMs?: number;
  keepRecent?: number;
  maxAgeMs?: number;
  hardLimit?: number;
  targetAfterPrune?: number;
  activeTaskStatuses?: string[];
  idleSessionProtectMs?: number;
  minAgeForHardPruneMs?: number;
}

export interface TempWorkspacePruneResult {
  removedDirs: number;
  removedRows: number;
  candidateWorkspaceIds: string[];
  candidateDirPaths: string[];
  checkedRows: number;
  checkedDirs: number;
  dryRun: boolean;
}

export interface TempWorkspaceDirectoryResult {
  slug: string;
  path: string;
  workspaceId: string;
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
const TEMP_WORKSPACE_DIR_MODE = 0o700;
const DEFAULT_ACTIVE_TASK_STATUSES = [
  "pending",
  "queued",
  "planning",
  "executing",
  "paused",
  "blocked",
];

const isSafeTempSubPath = (candidatePath: string, rootPath: string): boolean => {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate === resolvedRoot) return false;
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

const sanitizeTempPathSegment = (raw: string): string => {
  const safe = String(raw || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || "session";
};

const isPosix = (): boolean => process.platform !== "win32";

const ensurePrivateDirectoryMode = (directoryPath: string): void => {
  if (!isPosix()) return;
  const stat = fs.statSync(directoryPath);
  const getUid = process.getuid;
  if (typeof getUid === "function" && stat.uid !== getUid()) {
    throw new Error(`Temp workspace directory is owned by another user: ${directoryPath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(directoryPath, TEMP_WORKSPACE_DIR_MODE);
  }
};

export function ensureTempWorkspaceRootSync(tempWorkspaceRoot: string): string {
  const resolvedRoot = path.resolve(tempWorkspaceRoot);
  fs.mkdirSync(resolvedRoot, {
    recursive: true,
    mode: TEMP_WORKSPACE_DIR_MODE,
  });

  const stat = fs.lstatSync(resolvedRoot);
  if (stat.isSymbolicLink()) {
    throw new Error(`Temp workspace root must not be a symlink: ${resolvedRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Temp workspace root must be a directory: ${resolvedRoot}`);
  }

  ensurePrivateDirectoryMode(resolvedRoot);
  return resolvedRoot;
}

const isSafeExistingTempDirectory = (candidatePath: string, rootPath: string): boolean => {
  if (!isSafeTempSubPath(candidatePath, rootPath)) return false;
  try {
    const stat = fs.lstatSync(candidatePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;

    const realRoot = fs.realpathSync(rootPath);
    const realCandidate = fs.realpathSync(candidatePath);
    if (realCandidate === realRoot) return false;
    return realCandidate.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
};

export function ensureTempWorkspaceDirectorySync(tempWorkspaceRoot: string, slug: string): string {
  const resolvedRoot = ensureTempWorkspaceRootSync(tempWorkspaceRoot);
  if (path.basename(slug) !== slug || slug.includes(path.sep)) {
    throw new Error(`Invalid temp workspace slug: ${slug}`);
  }

  const workspacePath = path.join(resolvedRoot, slug);
  if (!isSafeTempSubPath(workspacePath, resolvedRoot)) {
    throw new Error(`Temp workspace path escapes root: ${workspacePath}`);
  }

  try {
    fs.mkdirSync(workspacePath, {
      mode: TEMP_WORKSPACE_DIR_MODE,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error;
    }
  }

  if (!isSafeExistingTempDirectory(workspacePath, resolvedRoot)) {
    throw new Error(`Temp workspace path is not a safe directory: ${workspacePath}`);
  }
  ensurePrivateDirectoryMode(workspacePath);
  return workspacePath;
}

export function ensureTempWorkspaceDirectoryPathSync(
  tempWorkspaceRoot: string,
  workspacePath: string,
): string {
  const resolvedRoot = ensureTempWorkspaceRootSync(tempWorkspaceRoot);
  const resolvedWorkspacePath = path.resolve(workspacePath);
  if (
    !isSafeTempSubPath(resolvedWorkspacePath, resolvedRoot) ||
    path.dirname(resolvedWorkspacePath) !== resolvedRoot
  ) {
    throw new Error(`Temp workspace path must be a direct child of root: ${workspacePath}`);
  }
  return ensureTempWorkspaceDirectorySync(resolvedRoot, path.basename(resolvedWorkspacePath));
}

export function createUniqueScopedTempWorkspaceDirectorySync(
  tempWorkspaceRoot: string,
  scope: string,
  keyPrefix: string = "session",
): TempWorkspaceDirectoryResult {
  const resolvedRoot = ensureTempWorkspaceRootSync(tempWorkspaceRoot);
  const safeScope = sanitizeTempPathSegment(scope);
  const safePrefix = sanitizeTempPathSegment(keyPrefix);
  const workspacePath = fs.mkdtempSync(path.join(resolvedRoot, `${safeScope}-${safePrefix}-`));
  if (!isSafeExistingTempDirectory(workspacePath, resolvedRoot)) {
    throw new Error(`Temp workspace path is not a safe directory: ${workspacePath}`);
  }
  ensurePrivateDirectoryMode(workspacePath);
  const slug = path.basename(workspacePath);
  return {
    slug,
    path: workspacePath,
    workspaceId: `${TEMP_WORKSPACE_ID_PREFIX}${slug}`,
  };
}

const listTempDirectories = (rootPath: string): TempDirectoryEntry[] => {
  if (!fs.existsSync(rootPath)) return [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const dirs: TempDirectoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const fullPath = path.resolve(path.join(rootPath, entry.name));
    if (!isSafeExistingTempDirectory(fullPath, rootPath)) continue;
    try {
      const stat = fs.lstatSync(fullPath);
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

/**
 * Prune stale temp workspaces: their directories on the host, their rows (and dependent
 * rows) through services-domain units (DB6). A workspace an active task or session uses is
 * kept; the check and the delete share one unit.
 */
export async function pruneTempWorkspaces(
  options: TempWorkspacePruneOptions,
): Promise<TempWorkspacePruneResult> {
  const sql = serviceStatements(options.db);
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun === true;
  const keepRecent = Math.max(0, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const hardLimit = Math.max(1, options.hardLimit ?? DEFAULT_HARD_LIMIT);
  const idleSessionProtectMs = Math.max(
    0,
    options.idleSessionProtectMs ?? DEFAULT_IDLE_SESSION_PROTECT_MS,
  );
  const minAgeForHardPruneMs = Math.max(
    0,
    options.minAgeForHardPruneMs ?? DEFAULT_MIN_AGE_FOR_HARD_PRUNE_MS,
  );
  const activeTaskStatuses = Array.from(
    new Set(
      (options.activeTaskStatuses && options.activeTaskStatuses.length > 0
        ? options.activeTaskStatuses
        : DEFAULT_ACTIVE_TASK_STATUSES
      )
        .map((status) => String(status || "").trim())
        .filter(Boolean),
    ),
  );
  const sessionActiveCutoffMs = nowMs - idleSessionProtectMs;
  const targetAfterPrune = Math.max(
    0,
    Math.min(hardLimit, options.targetAfterPrune ?? DEFAULT_TARGET_AFTER_PRUNE),
  );

  const resolvedRoot = ensureTempWorkspaceRootSync(options.tempWorkspaceRoot);

  const rows = await sql.unit("tempWorkspace_tempWorkspaceRows", []);
  const taskReferencedWorkspaceIds = new Set(
    await sql.unit("tempWorkspace_activeTaskWorkspaceIds", [activeTaskStatuses]),
  );
  const sessionReferencedWorkspaceIds = new Set(
    await sql.unit("tempWorkspace_activeSessionWorkspaceIds", [sessionActiveCutoffMs]),
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
  const candidateWorkspaceIds = new Set<string>();
  const candidateDirPaths = new Set<string>();

  for (const workspaceId of toDeleteIds) {
    const row = rowsById.get(workspaceId);
    if (!row) continue;

    if (
      await sql.unit("tempWorkspace_isReferenced", [
        workspaceId,
        activeTaskStatuses,
        sessionActiveCutoffMs,
      ])
    ) {
      continue;
    }

    candidateWorkspaceIds.add(workspaceId);
    if (row.path && isSafeExistingTempDirectory(row.path, resolvedRoot)) {
      candidateDirPaths.add(path.resolve(row.path));
    }
    if (dryRun) {
      continue;
    }

    try {
      if (row.path && isSafeExistingTempDirectory(row.path, resolvedRoot)) {
        fs.rmSync(row.path, { recursive: true, force: true });
        removedDirs += 1;
      }
    } catch {
      // Best-effort cleanup; keep going.
    }

    try {
      if (
        await sql.unit("tempWorkspace_deleteUnreferencedWorkspace", [
          workspaceId,
          activeTaskStatuses,
          sessionActiveCutoffMs,
        ])
      ) {
        removedRows += 1;
      }
    } catch {
      // Best-effort DB cleanup; keep going.
    }
  }

  const rowsAfterDbPrune = dryRun
    ? rows.filter((row) => !candidateWorkspaceIds.has(row.id))
    : await sql.unit("tempWorkspace_tempWorkspaceRows", []);

  const protectedPaths = new Set<string>();
  const workspaceIdsByPath = new Map<string, string[]>();
  for (const row of rowsAfterDbPrune) {
    const resolvedPath = path.resolve(row.path);
    if (!isSafeExistingTempDirectory(resolvedPath, resolvedRoot)) continue;
    protectedPaths.add(resolvedPath);
    const existing = workspaceIdsByPath.get(resolvedPath) ?? [];
    existing.push(row.id);
    workspaceIdsByPath.set(resolvedPath, existing);
  }

  const deleteDirectoryAndStaleRows = async (directoryPath: string): Promise<boolean> => {
    if (!isSafeExistingTempDirectory(directoryPath, resolvedRoot)) return false;

    const workspaceIds = workspaceIdsByPath.get(directoryPath) ?? [];
    if (dryRun) {
      candidateDirPaths.add(path.resolve(directoryPath));
      for (const workspaceId of workspaceIds) {
        if (
          await sql.unit("tempWorkspace_isReferenced", [
            workspaceId,
            activeTaskStatuses,
            sessionActiveCutoffMs,
          ])
        ) {
          continue;
        }
        candidateWorkspaceIds.add(workspaceId);
      }
      return true;
    }

    try {
      fs.rmSync(directoryPath, { recursive: true, force: true });
      removedDirs += 1;
    } catch {
      return false;
    }

    for (const workspaceId of workspaceIds) {
      try {
        if (
          await sql.unit("tempWorkspace_deleteUnreferencedWorkspace", [
            workspaceId,
            activeTaskStatuses,
            sessionActiveCutoffMs,
          ])
        ) {
          candidateWorkspaceIds.add(workspaceId);
          removedRows += 1;
        } else if (
          !(await sql.unit("tempWorkspace_isReferenced", [
            workspaceId,
            activeTaskStatuses,
            sessionActiveCutoffMs,
          ]))
        ) {
          // Not referenced, but the delete did not happen: still a candidate, as before.
          candidateWorkspaceIds.add(workspaceId);
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
      await deleteDirectoryAndStaleRows(entry.path);
    }
  }

  const directoriesAfterAgePrune = listTempDirectories(resolvedRoot).filter(
    (entry) => !dryRun || !candidateDirPaths.has(entry.path),
  );
  let remainingDirCount = directoriesAfterAgePrune.length;
  if (remainingDirCount > hardLimit) {
    const candidateDirs = directoriesAfterAgePrune
      .filter((entry) => !protectedPaths.has(entry.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const entry of candidateDirs) {
      if (remainingDirCount <= targetAfterPrune) break;
      if (nowMs - entry.mtimeMs < minAgeForHardPruneMs) continue;
      if (await deleteDirectoryAndStaleRows(entry.path)) {
        remainingDirCount -= 1;
      }
    }
  }

  return {
    removedDirs,
    removedRows,
    candidateWorkspaceIds: Array.from(candidateWorkspaceIds),
    candidateDirPaths: Array.from(candidateDirPaths),
    checkedRows: rows.length,
    checkedDirs: directories.length,
    dryRun,
  };
}
