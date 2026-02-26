import * as crypto from "crypto";
import fs from "fs";
import path from "path";

export const SCHEDULED_WORKSPACES_DIR_NAME = "scheduled-workspaces";
export const SCHEDULED_RUNS_RELATIVE_DIR = path.join(".cowork", "scheduled-runs");

const MAX_SLUG_LENGTH = 48;
const DEFAULT_KEEP_RECENT = 40;
const DEFAULT_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const DEFAULT_HARD_LIMIT = 200;
const DEFAULT_TARGET_AFTER_PRUNE = 120;
const DEFAULT_MIN_AGE_FOR_HARD_PRUNE_MS = 24 * 60 * 60 * 1000;

export interface ScheduledRunDirectory {
  path: string;
  relativePath: string;
  runsRoot: string;
}

export interface PruneScheduledRunDirectoriesOptions {
  nowMs?: number;
  keepRecent?: number;
  maxAgeMs?: number;
  hardLimit?: number;
  targetAfterPrune?: number;
  minAgeForHardPruneMs?: number;
}

function sanitizeSlug(value: string, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!normalized) return fallback;
  return normalized.slice(0, MAX_SLUG_LENGTH);
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (parent === child) return false;
  return child.startsWith(`${parent}${path.sep}`);
}

function formatRunTimestamp(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

export function getScheduledWorkspacesRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), SCHEDULED_WORKSPACES_DIR_NAME);
}

export function buildManagedScheduledWorkspacePath(
  userDataDir: string,
  jobName: string,
  jobId: string,
): string {
  const nameSlug = sanitizeSlug(jobName, "scheduled-task");
  const idSlug = sanitizeSlug(jobId, "job");
  return path.join(getScheduledWorkspacesRoot(userDataDir), `${nameSlug}-${idSlug}`);
}

export function isManagedScheduledWorkspacePath(
  workspacePath: string | null | undefined,
  userDataDir: string,
): boolean {
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) return false;
  const root = getScheduledWorkspacesRoot(userDataDir);
  return isPathWithin(root, workspacePath);
}

export function createScheduledRunDirectory(
  workspacePath: string,
  options: PruneScheduledRunDirectoriesOptions = {},
): ScheduledRunDirectory {
  const nowMs = options.nowMs ?? Date.now();
  const workspaceRoot = path.resolve(workspacePath);
  const runsRoot = path.join(workspaceRoot, SCHEDULED_RUNS_RELATIVE_DIR);
  fs.mkdirSync(runsRoot, { recursive: true });

  const runId = `run-${formatRunTimestamp(nowMs)}-${crypto.randomBytes(3).toString("hex")}`;
  const runPath = path.join(runsRoot, runId);
  fs.mkdirSync(runPath, { recursive: true });

  // Best-effort retention cleanup after each run directory creation.
  pruneScheduledRunDirectories(runsRoot, {
    nowMs,
    keepRecent: options.keepRecent,
    maxAgeMs: options.maxAgeMs,
    hardLimit: options.hardLimit,
    targetAfterPrune: options.targetAfterPrune,
    minAgeForHardPruneMs: options.minAgeForHardPruneMs,
  });

  return {
    path: runPath,
    relativePath: path.relative(workspaceRoot, runPath).split(path.sep).join("/"),
    runsRoot,
  };
}

export function pruneScheduledRunDirectories(
  runsRootPath: string,
  options: PruneScheduledRunDirectoriesOptions = {},
): { removed: number; remaining: number } {
  const nowMs = options.nowMs ?? Date.now();
  const keepRecent = Math.max(0, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const hardLimit = Math.max(1, options.hardLimit ?? DEFAULT_HARD_LIMIT);
  const targetAfterPrune = Math.max(
    0,
    Math.min(hardLimit, options.targetAfterPrune ?? DEFAULT_TARGET_AFTER_PRUNE),
  );
  const minAgeForHardPruneMs = Math.max(
    0,
    options.minAgeForHardPruneMs ?? DEFAULT_MIN_AGE_FOR_HARD_PRUNE_MS,
  );

  const runsRoot = path.resolve(runsRootPath);
  if (!fs.existsSync(runsRoot)) {
    return { removed: 0, remaining: 0 };
  }

  const entries = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(runsRoot, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.ctimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const protectedNames = new Set(entries.slice(0, keepRecent).map((entry) => entry.name));
  const toDelete = new Set<string>();

  for (const entry of entries) {
    if (protectedNames.has(entry.name)) continue;
    const ageMs = nowMs - entry.mtimeMs;
    if (ageMs > maxAgeMs) {
      toDelete.add(entry.path);
    }
  }

  let remaining = entries.length - toDelete.size;
  if (remaining > hardLimit) {
    const candidates = entries
      .slice()
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .filter((entry) => !protectedNames.has(entry.name) && !toDelete.has(entry.path));

    for (const entry of candidates) {
      if (remaining <= targetAfterPrune) break;
      const ageMs = nowMs - entry.mtimeMs;
      if (ageMs < minAgeForHardPruneMs) continue;
      toDelete.add(entry.path);
      remaining -= 1;
    }
  }

  let removed = 0;
  for (const dirPath of toDelete) {
    if (!isPathWithin(runsRoot, dirPath)) continue;
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup.
    }
  }

  const remainingCount = Math.max(0, entries.length - removed);
  return { removed, remaining: remainingCount };
}
