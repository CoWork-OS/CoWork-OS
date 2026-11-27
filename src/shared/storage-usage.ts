/** Settings > Storage: what CoWork keeps in its profile folder, by kind. */

export const STORAGE_CATEGORY_IDS = [
  "database",
  "database_copies",
  "browser_data",
  "cache",
  "undo_history",
  "chronicle",
  "files",
  "skills_tools",
  "memory",
  "other",
] as const;
export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

export const STORAGE_CATEGORY_LABELS: Record<StorageCategoryId, { label: string; hint: string }> = {
  database: { label: "Database", hint: "Sessions, messages, settings and history" },
  database_copies: {
    label: "Backups",
    hint: "Copies of the database and memory made before upgrades and cleanups",
  },
  browser_data: {
    label: "Browser data",
    hint: "Sign-ins, cookies and site data for the built-in browser",
  },
  cache: { label: "Cache", hint: "Saved pages, scripts and graphics; safe to clear" },
  undo_history: {
    label: "Undo history",
    hint: "Earlier versions of files, kept so turns and edits can be undone",
  },
  chronicle: { label: "Chronicle", hint: "Recent screen captures" },
  files: {
    label: "Files CoWork made",
    hint: "Canvases, recordings, attachments and scheduled-task folders",
  },
  skills_tools: { label: "Skills and tools", hint: "Skills, extensions and MCP server data" },
  memory: { label: "Memory", hint: "The memory folder" },
  other: { label: "Other", hint: "Logs, settings files and everything else" },
};

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  files: number;
}

/** A backup (a database copy or another file in the backups folder), with any `-wal` and `-shm` files counted in. */
export interface StorageDatabaseCopy {
  /** `<folder>/<name>`: what Move to Trash names. */
  id: string;
  /** File or folder name. */
  name: string;
  /** `backups` for the backups folder, `profile` for the profile folder itself. */
  folder: "backups" | "profile";
  /** The only copy of data CoWork retired (old memory); the Trash prompt says so. */
  onlyCopy?: boolean;
  bytes: number;
  modifiedAt: number;
}

export interface StorageBreakdown {
  totalBytes: number;
  categories: StorageCategoryUsage[];
  databaseCopies: StorageDatabaseCopy[];
  /** The disk the profile folder is on; null when it can't be read. */
  disk: { freeBytes: number; totalBytes: number } | null;
  scannedAt: number;
  /** The scan stopped early (too many files or too long); sizes are at least these. */
  partial: boolean;
}

export interface StorageClearCacheResult {
  /** Cache bytes before and after, from a fresh scan. */
  before: number;
  after: number;
}

export interface StorageTrashResult {
  trashed: string[];
  failed: Array<{ name: string; reason: string }>;
}

/** Sizes as Finder shows them: powers of 1000, one decimal from a megabyte up. */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.max(1, Math.round(value))} KB`;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
