/**
 * Settings > Storage: how much of the profile folder each kind of data takes.
 *
 * The scan is asynchronous and reads only sizes (`lstat`, never following links), so it
 * does not hold up the main thread or leave the profile folder. It stops after a file
 * count or a time budget and then reports `partial`. Each top-level entry is put in one
 * category by name; the browser's per-workspace partitions are split so their caches
 * count as cache, not browser data.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  STORAGE_CATEGORY_IDS,
  type StorageBreakdown,
  type StorageCategoryId,
  type StorageDatabaseCopy,
  type StorageTrashResult,
} from "../../shared/storage-usage";
import { DATABASE_FILE_NAME } from "../database/connection";

export const BACKUPS_FOLDER = "backups";
const PARTITIONS_FOLDER = "Partitions";
const MAX_ENTRIES = 400_000;
const MAX_SCAN_MS = 20_000;

/** Chromium and CoWork caches: rebuilt on demand. */
export const CACHE_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "GrShaderCache",
  "Shared Dictionary",
  "cache",
  ".skill-scan-cache",
  "model-metadata-cache.json",
]);

const BROWSER_DATA_NAMES = new Set([
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Cookies",
  "Cookies-journal",
  "Service Worker",
  "WebStorage",
  "blob_storage",
  "databases",
  "Network Persistent State",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "DIPS",
  "DIPS-wal",
  "DIPS-shm",
  "SharedStorage",
  "SharedStorage-wal",
]);

const NAMED_CATEGORIES: Record<string, StorageCategoryId> = {
  "artifact-revisions": "undo_history",
  "turn-changes": "undo_history",
  "task-mutation-ledgers": "undo_history",
  chronicle: "chronicle",
  canvas: "files",
  "meeting-artifacts": "files",
  loom: "files",
  meshy: "files",
  "composer-draft-attachments": "files",
  "space-runs": "files",
  "scheduled-workspaces": "files",
  "company-workspaces": "files",
  skills: "skills_tools",
  extensions: "skills_tools",
  "plugin-data": "skills_tools",
  quarantine: "skills_tools",
  "mcp-data": "skills_tools",
  "computer-use-helper": "skills_tools",
  agents: "skills_tools",
  bots: "skills_tools",
  "memory-repo": "memory",
};

const LIVE_DATABASE_NAMES = new Set(
  ["", "-wal", "-shm", "-journal"].map((suffix) => `${DATABASE_FILE_NAME}${suffix}`),
);

/** A database copy's own name: `x.db-wal` and `x.db-shm` belong to `x.db`. */
export function databaseCopyBaseName(name: string): string {
  return name.replace(/-(wal|shm|journal)$/, "");
}

/**
 * A copy of the database left in the profile folder itself (not the live database).
 * Temporary, lock and migration files next to the live database are never copies: they
 * may be in use.
 */
export function isProfileDatabaseCopy(name: string): boolean {
  if (LIVE_DATABASE_NAMES.has(name)) return false;
  if (!/^cowork-os\b.*\.(db|bak)\b/i.test(name)) return false;
  return !/(^|[-.])(tmp|temp|lock|locked|migrat\w*|swap|partial)($|[-.])/i.test(name);
}

/** Files that hold the only copy of data CoWork retired (named in the Trash prompt). */
export function isRetiredDataBackup(name: string): boolean {
  return /^legacy-memory-.*\.enc$/i.test(name);
}

export function categoryForEntry(name: string): StorageCategoryId {
  if (LIVE_DATABASE_NAMES.has(name)) return "database";
  if (name === BACKUPS_FOLDER || isProfileDatabaseCopy(name)) return "database_copies";
  if (CACHE_NAMES.has(name)) return "cache";
  if (BROWSER_DATA_NAMES.has(name)) return "browser_data";
  const named = NAMED_CATEGORIES[name];
  if (named) return named;
  if (name.startsWith("workspace-")) return "files";
  return "other";
}

interface ScanBudget {
  entries: number;
  deadline: number;
  partial: boolean;
}

interface Size {
  bytes: number;
  files: number;
  modifiedAt: number;
}

/** Size of a file or folder, not following links. */
async function sizeOf(target: string, budget: ScanBudget): Promise<Size> {
  const total: Size = { bytes: 0, files: 0, modifiedAt: 0 };
  const stack = [target];
  while (stack.length > 0) {
    if (budget.entries >= MAX_ENTRIES || Date.now() > budget.deadline) {
      budget.partial = true;
      break;
    }
    const current = stack.pop() as string;
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch {
      continue;
    }
    budget.entries += 1;
    total.modifiedAt = Math.max(total.modifiedAt, stat.mtimeMs);
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = await fs.readdir(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      total.bytes += stat.size;
      total.files += 1;
    }
  }
  return total;
}

async function readNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function diskOf(root: string): Promise<StorageBreakdown["disk"]> {
  try {
    const stat = await fs.statfs(root);
    return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

export async function scanStorage(
  root: string,
  options: { nowMs?: number; maxScanMs?: number } = {},
): Promise<StorageBreakdown> {
  const budget: ScanBudget = {
    entries: 0,
    deadline: Date.now() + (options.maxScanMs ?? MAX_SCAN_MS),
    partial: false,
  };
  const totals = new Map<StorageCategoryId, { bytes: number; files: number }>(
    STORAGE_CATEGORY_IDS.map((id) => [id, { bytes: 0, files: 0 }]),
  );
  const add = (id: StorageCategoryId, size: Size) => {
    const entry = totals.get(id) as { bytes: number; files: number };
    entry.bytes += size.bytes;
    entry.files += size.files;
  };
  const copies = new Map<string, StorageDatabaseCopy>();
  const addCopy = (name: string, folder: StorageDatabaseCopy["folder"], size: Size) => {
    const base = databaseCopyBaseName(name);
    const key = `${folder}/${base}`;
    const existing = copies.get(key);
    if (existing) {
      existing.bytes += size.bytes;
      existing.modifiedAt = Math.max(existing.modifiedAt, size.modifiedAt);
    } else {
      copies.set(key, {
        id: key,
        name: base,
        folder,
        ...(isRetiredDataBackup(base) ? { onlyCopy: true } : {}),
        bytes: size.bytes,
        modifiedAt: size.modifiedAt,
      });
    }
  };

  for (const name of await readNames(root)) {
    const full = path.join(root, name);
    if (name === PARTITIONS_FOLDER) {
      for (const partition of await readNames(full)) {
        for (const child of await readNames(path.join(full, partition))) {
          const size = await sizeOf(path.join(full, partition, child), budget);
          add(CACHE_NAMES.has(child) ? "cache" : "browser_data", size);
        }
      }
      continue;
    }
    if (name === BACKUPS_FOLDER) {
      for (const child of await readNames(full)) {
        const size = await sizeOf(path.join(full, child), budget);
        add("database_copies", size);
        addCopy(child, "backups", size);
      }
      continue;
    }
    const size = await sizeOf(full, budget);
    const category = categoryForEntry(name);
    add(category, size);
    if (category === "database_copies") addCopy(name, "profile", size);
  }

  const categories = STORAGE_CATEGORY_IDS.map((id) => ({
    id,
    ...(totals.get(id) as { bytes: number; files: number }),
  }));
  return {
    totalBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
    categories,
    databaseCopies: [...copies.values()].sort((a, b) => b.modifiedAt - a.modifiedAt),
    disk: await diskOf(root),
    scannedAt: options.nowMs ?? Date.now(),
    partial: budget.partial,
  };
}

/**
 * The files that make up one database copy (`x.db` with its `-wal` and `-shm`), read
 * fresh from disk. Empty for an unknown id, and never the live database.
 */
export async function databaseCopyFiles(root: string, id: string): Promise<string[]> {
  const match = /^(backups|profile)\/([^/\\]+)$/.exec(id);
  if (!match) return [];
  const [, folder, base] = match;
  if (base === "." || base === "..") return [];
  const dir = folder === "backups" ? path.join(root, BACKUPS_FOLDER) : root;
  const names = await readNames(dir);
  return names
    .filter(
      (name) =>
        databaseCopyBaseName(name) === base &&
        (folder === "backups" || isProfileDatabaseCopy(name)),
    )
    .map((name) => path.join(dir, name));
}

/** Move database copies to the Trash by id; each copy goes with its `-wal` and `-shm`. */
export async function trashDatabaseCopies(
  root: string,
  ids: readonly string[],
  trashItem: (target: string) => Promise<void>,
): Promise<StorageTrashResult> {
  const result: StorageTrashResult = { trashed: [], failed: [] };
  for (const id of new Set(ids)) {
    const files = await databaseCopyFiles(root, id);
    if (files.length === 0) {
      result.failed.push({ name: id, reason: "Not found." });
      continue;
    }
    try {
      for (const file of files) await trashItem(file);
      result.trashed.push(id);
    } catch {
      // The Trash's own message can hold an absolute path; it stays out of the renderer.
      result.failed.push({ name: id, reason: "The Trash refused it." });
    }
  }
  return result;
}
