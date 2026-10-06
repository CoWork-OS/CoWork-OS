/**
 * Memory Hub "What CoWork knows" over the memory folder (docs/memory-repo-phase3-design.md
 * §5): filtering, labels and the IPC flows behind the folder part of the tab. Kept free of
 * React so the flows can be tested with a mocked API.
 */
import type { MemoryHubKind, MemoryHubSource } from "../../../shared/memory-hub-types";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoEntryActionResult,
  MemoryRepoHubEntry,
  MemoryRepoHubFile,
  MemoryRepoKeepTarget,
} from "../../../shared/memory-repo-types";

export type MemoryFolderApi = {
  getMemoryRepoEntries: (data: { workspaceId: string }) => Promise<MemoryRepoEntriesReport>;
  updateMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
    text: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  removeMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  pinMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  /** Keep an inbox entry (move it to me.md, lessons.md or the workspace's file). */
  keepMemoryRepoEntry?: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
    target: MemoryRepoKeepTarget;
  }) => Promise<MemoryRepoEntryActionResult>;
  /** Desktop only. */
  openMemoryRepoFile?: (data: { workspaceId: string; path: string }) => Promise<{ success: true }>;
};

export const MEMORY_FOLDER_METHODS = [
  "getMemoryRepoEntries",
  "updateMemoryRepoEntry",
  "removeMemoryRepoEntry",
  "pinMemoryRepoEntry",
] as const;

export const EMPTY_FOLDER_REPORT: MemoryRepoEntriesReport = {
  available: false,
  writable: false,
  files: [],
  inbox: null,
};

/** What a file holds, under its title. */
export function folderFileHint(file: Pick<MemoryRepoHubFile, "role">): string {
  switch (file.role) {
    case "entry":
      return "Pinned: in every prompt";
    case "me":
      return "About you";
    case "lessons":
      return "Lessons";
    case "workspace":
      return "This workspace";
    case "inbox":
      return "Unreviewed: not used until you keep it";
    default:
      return "Topic";
  }
}

export interface FolderFilters {
  query: string;
  kind: MemoryHubKind | "";
  source: MemoryHubSource | "";
  pinnedOnly: boolean;
}

function entryMatches(entry: MemoryRepoHubEntry, file: MemoryRepoHubFile, filters: FolderFilters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query && !entry.text.toLowerCase().includes(query)) return false;
  if (filters.kind && entry.kind !== filters.kind) return false;
  if (filters.pinnedOnly && file.role !== "entry") return false;
  switch (filters.source) {
    case "":
      return true;
    case "user_stated":
    case "user_confirmed":
      return entry.by === "user";
    case "import":
      return entry.source === "import";
    case "third_party":
      // Third-party text never goes to the memory folder.
      return false;
    default:
      return entry.by === "agent" && entry.source !== "import";
  }
}

/** The files with only the entries that pass the filters; empty files are dropped. */
export function filterFolderFiles(
  files: MemoryRepoHubFile[],
  filters: FolderFilters,
): MemoryRepoHubFile[] {
  return files
    .map((file) => ({ ...file, entries: file.entries.filter((entry) => entryMatches(entry, file, filters)) }))
    .filter((file) => file.entries.length > 0);
}

export function countFolderEntries(report: MemoryRepoEntriesReport): number {
  return report.files.reduce((total, file) => total + file.entries.length, 0);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface FolderFlowResult {
  /** The folder as it is after the change (reloaded), or as it was on an error. */
  report: MemoryRepoEntriesReport;
  error?: string;
  notice?: string;
  cancelled?: boolean;
}

async function runAndReload(
  api: MemoryFolderApi,
  workspaceId: string,
  report: MemoryRepoEntriesReport,
  run: () => Promise<MemoryRepoEntryActionResult>,
  notice: string,
  failure: string,
): Promise<FolderFlowResult> {
  try {
    const result = await run();
    if (!result.ok) {
      // The file may have changed under the Hub: show it as it is now.
      const fresh = await api.getMemoryRepoEntries({ workspaceId }).catch(() => report);
      return { report: fresh, error: result.error || failure };
    }
    return { report: await api.getMemoryRepoEntries({ workspaceId }), notice };
  } catch (error) {
    return { report, error: errorMessage(error, failure) };
  }
}

export function editFolderEntry(
  api: MemoryFolderApi,
  workspaceId: string,
  report: MemoryRepoEntriesReport,
  entry: MemoryRepoHubEntry,
  text: string,
): Promise<FolderFlowResult> {
  const trimmed = text.trim();
  if (!trimmed) return Promise.resolve({ report, error: "A memory cannot be empty." });
  return runAndReload(
    api,
    workspaceId,
    report,
    () => api.updateMemoryRepoEntry({ workspaceId, ref: entry.ref, hash: entry.hash, text: trimmed }),
    "Memory updated.",
    "Failed to update the memory.",
  );
}

export function deleteFolderEntry(
  api: MemoryFolderApi,
  workspaceId: string,
  report: MemoryRepoEntriesReport,
  entry: MemoryRepoHubEntry,
  confirm: (message: string) => boolean,
): Promise<FolderFlowResult> {
  if (!confirm("Forget this memory? CoWork stops using it right away.")) {
    return Promise.resolve({ report, cancelled: true });
  }
  return runAndReload(
    api,
    workspaceId,
    report,
    () => api.removeMemoryRepoEntry({ workspaceId, ref: entry.ref, hash: entry.hash }),
    "Memory forgotten.",
    "Failed to forget the memory.",
  );
}

/** Pin = move to MEMORY.md (kept in every prompt). */
export function pinFolderEntry(
  api: MemoryFolderApi,
  workspaceId: string,
  report: MemoryRepoEntriesReport,
  entry: MemoryRepoHubEntry,
): Promise<FolderFlowResult> {
  return runAndReload(
    api,
    workspaceId,
    report,
    () => api.pinMemoryRepoEntry({ workspaceId, ref: entry.ref, hash: entry.hash }),
    "Memory pinned: CoWork keeps it in every prompt.",
    "Failed to pin the memory.",
  );
}

const KEEP_NOTICES: Record<MemoryRepoKeepTarget, string> = {
  me: "Kept in About you.",
  lessons: "Kept in Lessons.",
  workspace: "Kept for this workspace.",
};

/** Keep = move an inbox entry to me.md, lessons.md or the workspace's file, as yours. */
export function keepFolderEntry(
  api: MemoryFolderApi,
  workspaceId: string,
  report: MemoryRepoEntriesReport,
  entry: MemoryRepoHubEntry,
  target: MemoryRepoKeepTarget,
): Promise<FolderFlowResult> {
  const keep = api.keepMemoryRepoEntry;
  if (!keep) return Promise.resolve({ report, error: "Keeping is not available here." });
  return runAndReload(
    api,
    workspaceId,
    report,
    () => keep({ workspaceId, ref: entry.ref, hash: entry.hash, target }),
    KEEP_NOTICES[target],
    "Failed to keep the memory.",
  );
}
