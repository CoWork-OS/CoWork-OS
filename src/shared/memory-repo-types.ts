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
  /** Private-remote sync (docs/memory-repo-phase4-design.md §1); absent when sync is off. */
  sync?: MemoryRepoSyncStatus | null;
  /** Team memory repos read next to the folder (docs/memory-repo-phase4-design.md §2). */
  team?: TeamMemoryRepoStatus[];
}

/** One configured team memory repo (read-only), as the renderer sees it. */
export interface TeamMemoryRepoStatus {
  name: string;
  /** The resolved folder. */
  root: string;
  /** The folder is a memory repo CoWork reads. */
  ready: boolean;
  /** Why it is not read (missing, not a memory repo, refused path, ...). */
  problem?: string;
  /** Workspaces it applies to; empty = all. */
  workspaceIds: string[];
  /** Last fast-forward from its remote (ms), or null. */
  lastPullAt: number | null;
  lastPullError: string | null;
}

/** `memoryRepo:syncNow`: the sync state after the pull and push, or why nothing ran. */
export type MemoryRepoSyncNowResult = MemoryRepoSyncStatus | { error: string };

/** `memoryRepo:syncNow` while the memory folder is off. */
export const MEMORY_REPO_SYNC_FOLDER_OFF_ERROR = "The memory folder is off.";
/** `memoryRepo:syncNow` while no confirmed private remote is set. */
export const MEMORY_REPO_SYNC_OFF_ERROR =
  "Sync is off: add your private repository's URL and confirm it is private and yours.";

/** Most team memory repos (`memoryRepoTeamRepos`). */
export const MEMORY_REPO_TEAM_REPOS_MAX = 3;

/** Sync with the user's private remote, as the renderer sees it. */
export interface MemoryRepoSyncStatus {
  /** The remote URL without user info. */
  remoteUrl: string | null;
  lastPullAt: number | null;
  lastPushAt: number | null;
  ahead: number;
  behind: number;
  /** A pull hit a conflict: sync is paused until the user resolves it. */
  conflict: string | null;
  lastError: string | null;
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

// ---------------------------------------------------------------------------
// Dreaming over the memory folder (docs/memory-repo-phase2-design.md §5-§7)
// ---------------------------------------------------------------------------

/** One operation of a dream as the Review tab shows it. */
export interface MemoryRepoDreamOperation {
  /** `auto` (applied), `review` (waiting), `rejected` (invalid) or `skipped` (no longer applied). */
  decision: string;
  description: string;
  /** The model's reason for the change. */
  reason?: string;
  /** Why it needs review, or why it was rejected or skipped. */
  why?: string;
}

/** One dream run, without git internals (branch names, full shas). */
export interface MemoryRepoDreamSummary {
  id: string;
  trigger: "daily" | "manual";
  status: "completed" | "skipped" | "failed";
  startedAt: number;
  finishedAt: number;
  summary: string;
  skipReason?: string;
  error?: string;
  tokens: number;
  /** Changes applied automatically (one commit on main). */
  autoCount: number;
  /** Short sha of the automatic commit, when it still exists. */
  autoCommitShort?: string;
  /** When the automatic commit was undone. */
  undoneAt?: number;
  undone: boolean;
  /** The automatic commit exists and was not undone. */
  canUndo: boolean;
  /** Changes waiting for review (one commit on a review branch). */
  reviewCount: number;
  reviewStatus: "pending" | "accepted" | "rejected" | "stale" | null;
  /** Operations dropped as invalid. */
  rejected: number;
  operations: MemoryRepoDreamOperation[];
  /** Why the automatic commit is gone (history compacted). */
  historyNote?: string;
}

export interface MemoryRepoDreamsReport {
  /** Newest first. */
  dreams: MemoryRepoDreamSummary[];
  /** Tokens dreams used in the last 24 hours. */
  tokensUsedToday: number;
  dailyBudget: number;
  /** Whether `memoryRepoDreamingEnabled` is on. */
  dreamingEnabled: boolean;
  /** Whether the memory folder is on and ready (dreams can run and be reviewed). */
  folderReady: boolean;
  /** Dreams whose review part waits for Accept or Reject. */
  pendingReviews: number;
}

export type MemoryRepoDreamPart = "review" | "auto";

/** Result of Accept, Reject and Undo on a dream. */
export interface MemoryRepoDreamActionResult {
  ok: boolean;
  error?: string;
}

/** Result of "Dream now". */
export interface MemoryRepoDreamNowResult {
  ran: boolean;
  /** Why no dream ran (unavailable, no_git, disabled, nothing_new, budget, busy, failed). */
  reason?: string;
  error?: string;
  dream?: MemoryRepoDreamSummary;
}

/** Longest dream diff sent to the renderer (characters). */
export const MEMORY_REPO_DREAM_DIFF_MAX = 200_000;
/** Dreams listed by `memoryRepo:dreams`. */
export const MEMORY_REPO_DREAMS_LIMIT = 30;

// ---------------------------------------------------------------------------
// Memory Hub "What CoWork knows" over the memory folder (docs/memory-repo-phase3-design.md §5)
// ---------------------------------------------------------------------------

/** One entry of a memory folder file as the Memory Hub shows it. */
export interface MemoryRepoHubEntry {
  /** `repo:<path>#L<n>`. */
  ref: string;
  path: string;
  line: number;
  /** The entry text (redacted for display). */
  text: string;
  by: "user" | "agent";
  kind: string | null;
  /** `added` day (`YYYY-MM-DD`), when the line has one. */
  added: string | null;
  /** The task it was learned in (`source: cowork://tasks/<id>`), when there is one. */
  taskId: string | null;
  /** Hash of the entry text: sent back with edits so a shifted line is never changed. */
  hash: string;
  /** Other source (`import`), when the line names one that is not a task. */
  source: string | null;
}

export type MemoryRepoHubFileRole = "entry" | "me" | "lessons" | "workspace" | "topic" | "inbox";

export interface MemoryRepoHubFile {
  path: string;
  /** The file's `# ` heading, or its name. */
  title: string;
  role: MemoryRepoHubFileRole;
  entries: MemoryRepoHubEntry[];
  /** More entries than the Hub lists. */
  truncated?: boolean;
}

/** `memoryRepo:entries`: the folder as seen from one workspace. */
export interface MemoryRepoEntriesReport {
  /** The folder is on and ready (otherwise the Hub shows `memory_items` facts). */
  available: boolean;
  writable: boolean;
  /** `MEMORY.md`, `me.md`, `lessons.md`, global topic files, then this workspace's file. */
  files: MemoryRepoHubFile[];
  /** `inbox.md`: saved after reading untrusted content, not used until reviewed. */
  inbox: MemoryRepoHubFile | null;
}

/** Result of Edit, Delete and Pin on a memory folder entry. */
export interface MemoryRepoEntryActionResult {
  ok: boolean;
  error?: string;
  /** The entry's ref after the change (Edit, Pin). */
  ref?: string;
}

/** Entries listed per file by `memoryRepo:entries`. */
export const MEMORY_REPO_HUB_ENTRIES_PER_FILE = 500;

// ---------------------------------------------------------------------------
// Importing notes from a folder (docs/memory-repo-phase5-design.md §3)
// ---------------------------------------------------------------------------

/** Where Keep moves an inbox entry: `me.md`, `lessons.md` or the workspace's file. */
export const MEMORY_REPO_KEEP_TARGETS = ["me", "lessons", "workspace"] as const;
export type MemoryRepoKeepTarget = (typeof MEMORY_REPO_KEEP_TARGETS)[number];

/** `memoryRepo:importFolder`: what came over from the chosen folder into `inbox.md`. */
export interface MemoryRepoImportResult {
  /** The user closed the folder picker. */
  cancelled?: boolean;
  error?: string;
  /** The chosen folder's name (never its full path). */
  folderName?: string;
  /** Markdown files read. */
  files: number;
  /** Entries added to the inbox. */
  imported: number;
  /** Entries the memory folder already holds. */
  duplicates: number;
  /** Entries refused by screening (too short, only a secret, `<no-memory>`) and files skipped. */
  skipped: number;
  /** A limit was reached (files, bytes, or the inbox size): some notes were not read or added. */
  truncated: boolean;
}
