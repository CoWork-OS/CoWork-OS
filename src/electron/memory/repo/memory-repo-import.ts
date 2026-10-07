/**
 * Importing notes from a folder (docs/memory-repo-phase5-design.md §3): another agent's
 * memory folder in the Agent Memory Repo format, or any folder of markdown notes. The folder
 * is chosen in a native picker in main (never named by the renderer), validated, walked
 * read-only within fixed limits, and its entries (or plain bullets) go to `inbox.md` through
 * `MemoryRepoService.importToInbox`, where the user keeps them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryRepoImportResult } from "../../../shared/memory-repo-types";
import { containsNoMemoryDirective } from "../no-memory-directive";
import type { MemoryRepoImportEntry, MemoryRepoImportOutcome } from "./MemoryRepoService";
import { MEMORY_REPO_INBOX_FILE, parseMemoryRepoEntries } from "./memory-repo-format";
import { memoryRepoPathProblem } from "./memory-repo-paths";

export const MEMORY_REPO_IMPORT_LIMITS = {
  /** Folder levels below the chosen folder. */
  depth: 4,
  files: 200,
  fileBytes: 256 * 1024,
  totalBytes: 2 * 1024 * 1024,
} as const;

export interface MemoryRepoImportService {
  root: string;
  isWritable: () => boolean;
  importToInbox: (
    entries: ReadonlyArray<MemoryRepoImportEntry>,
    label: string,
  ) => Promise<MemoryRepoImportOutcome>;
}

function isWithin(parent: string, child: string): boolean {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  return a === b || b.startsWith(`${a}${path.sep}`);
}

/**
 * Why a folder cannot be imported from, or null: the memory folder rules (absolute, not a
 * disk root, the home folder or a protected location, not a symlink), and not the user's own
 * memory folder or a folder inside it.
 */
export function memoryRepoImportFolderProblem(
  folder: string,
  personalRoot: string | null,
): string | null {
  if (!String(folder || "").trim()) return "Choose a folder.";
  const problem = memoryRepoPathProblem(folder);
  if (problem) return problem;
  if (personalRoot && isWithin(personalRoot, folder)) {
    return "That is your own memory folder.";
  }
  return null;
}

export interface MemoryRepoImportFile {
  /** Path relative to the chosen folder, `/`-separated. */
  path: string;
  text: string;
}

export interface MemoryRepoImportScan {
  files: MemoryRepoImportFile[];
  /** Files left out (too large, not regular, outside the folder once resolved). */
  skipped: number;
  /** A file or byte limit stopped the walk. */
  truncated: boolean;
}

/**
 * Read the folder's markdown files: hidden entries, `.git`, symlinks and the folder's own
 * `inbox.md` (its unreviewed notes) are skipped; every file must resolve inside the folder.
 * `skipDirs` (the user's own memory folder) are never entered.
 */
export async function scanMemoryRepoImportFolder(
  folder: string,
  options: { skipDirs?: string[] } = {},
): Promise<MemoryRepoImportScan> {
  const root = await fs.realpath(folder);
  const skipDirs = await Promise.all(
    (options.skipDirs ?? []).map((dir) => fs.realpath(dir).catch(() => path.resolve(dir))),
  );
  const scan: MemoryRepoImportScan = { files: [], skipped: 0, truncated: false };
  let total = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scan.truncated) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= MEMORY_REPO_IMPORT_LIMITS.depth) continue;
        if (skipDirs.some((skip) => isWithin(skip, absolute))) continue;
        await walk(absolute, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      if (childRel === MEMORY_REPO_INBOX_FILE) continue;
      if (scan.files.length >= MEMORY_REPO_IMPORT_LIMITS.files) {
        scan.truncated = true;
        return;
      }
      const resolved = await fs.realpath(absolute).catch(() => null);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!resolved || !isWithin(root, resolved) || resolved === root || !stat?.isFile()) {
        scan.skipped += 1;
        continue;
      }
      if (stat.size > MEMORY_REPO_IMPORT_LIMITS.fileBytes) {
        scan.skipped += 1;
        continue;
      }
      if (total + stat.size > MEMORY_REPO_IMPORT_LIMITS.totalBytes) {
        scan.truncated = true;
        return;
      }
      const text = await fs.readFile(resolved, "utf8").catch(() => null);
      if (text === null) {
        scan.skipped += 1;
        continue;
      }
      total += stat.size;
      scan.files.push({ path: childRel, text });
    }
  };
  await walk(root, "", 0);
  return scan;
}

const CHECKBOX = /^\[[ xX]\]\s+/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The entries of the scanned files: Agent Memory Repo lines and plain bullets. Only the
 * source's validated `kind` and `added` are kept; everything else about the line (its
 * author, subject, source) is the other agent's and is set again on import. A file that asks
 * not to be remembered (`<no-memory>`) is left out whole.
 */
export function memoryRepoImportEntries(files: MemoryRepoImportFile[]): {
  entries: MemoryRepoImportEntry[];
  skipped: number;
} {
  const entries: MemoryRepoImportEntry[] = [];
  let skipped = 0;
  for (const file of files) {
    if (containsNoMemoryDirective(file.text)) {
      skipped += 1;
      continue;
    }
    for (const entry of parseMemoryRepoEntries(file.text)) {
      // The workspace marker of another CoWork folder is not a note.
      if (entry.metadata.workspace) continue;
      const text = entry.text.replace(CHECKBOX, "").trim();
      if (!text) continue;
      entries.push({
        text,
        kind: entry.kind,
        added: DAY.test(entry.metadata.added ?? "") ? (entry.metadata.added ?? null) : null,
      });
    }
  }
  return { entries, skipped };
}

/** The `import:` metadata value for a folder. */
export function memoryRepoImportLabel(folder: string): string {
  const name = path
    .basename(path.resolve(folder))
    .replace(/[;\][\r\n]+/g, " ")
    .trim();
  return `folder:${(name || "notes").slice(0, 80)}`;
}

/** Validate, scan, parse and import a folder chosen in main. */
export async function importMemoryNotesFromFolder(
  service: MemoryRepoImportService | null,
  folder: string,
): Promise<MemoryRepoImportResult> {
  const empty: MemoryRepoImportResult = {
    files: 0,
    imported: 0,
    duplicates: 0,
    skipped: 0,
    truncated: false,
  };
  if (!service?.isWritable()) return { ...empty, error: "The memory folder is not available." };
  const problem = memoryRepoImportFolderProblem(folder, service.root);
  if (problem) return { ...empty, error: problem };
  const folderName = path.basename(path.resolve(folder));
  let scan: MemoryRepoImportScan;
  try {
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory()) return { ...empty, folderName, error: "Choose a folder." };
    scan = await scanMemoryRepoImportFolder(folder, { skipDirs: [service.root] });
  } catch {
    return { ...empty, folderName, error: "The folder cannot be read." };
  }
  const parsed = memoryRepoImportEntries(scan.files);
  const outcome = await service.importToInbox(parsed.entries, memoryRepoImportLabel(folder));
  return {
    folderName,
    files: scan.files.length,
    imported: outcome.imported,
    duplicates: outcome.duplicates,
    skipped: scan.skipped + parsed.skipped + outcome.skipped,
    truncated: scan.truncated || outcome.truncated,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}
