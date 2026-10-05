/**
 * Memory folder (memory repo, docs/memory-repo-phase1-design.md §9) as the renderer sees it:
 * the `memoryRepo:*` IPC results. Mirrors `MemoryRepoStatus` of the main-process service
 * (src/electron/memory/repo/MemoryRepoService.ts) plus the `memoryRepoEnabled` setting.
 */

export interface MemoryRepoStatusReport {
  /** Whether `memoryRepoEnabled` is on. */
  enabled: boolean;
  /** The resolved folder (the configured path or the default). */
  root: string;
  /** The folder exists and was adopted or created. */
  ready: boolean;
  writable: boolean;
  gitAvailable: boolean;
  /** Why the folder is not ready (missing, not a memory repo, symlinked root, ...). */
  problem?: string;
  /** Whether the work tree has no uncommitted changes (unset without git). */
  clean?: boolean;
  head?: string | null;
  /** Time of the last commit (ms), or null. */
  lastCommitAt?: number | null;
  /** Size of `MEMORY.md` in bytes. */
  entryFileBytes?: number;
  /** Entries waiting in `inbox.md`. */
  inboxEntries?: number;
  lastWriteError?: string | null;
}

export interface MemoryRepoCompactResult {
  compacted: boolean;
  error?: string;
}

/** One entry line of the memory folder, by its `repo:<path>#L<n>` ref. */
export interface MemoryRepoLine {
  ref: string;
  /** The entry text (no bullet, no metadata); empty when the line is gone or not an entry. */
  text: string;
  path: string;
  by: "user" | "agent" | null;
}

/** Most refs one `memoryRepo:readLines` request may name. */
export const MEMORY_REPO_READ_LINES_MAX = 50;
