/**
 * Finds the Excel workbooks a shell command created or changed, so their dropped formula results
 * can be restored afterwards (see restoreXlsxFormulaCaches). A snapshot taken before the command
 * records the workbooks in the working folder, the workspace root and any workbook path the
 * command names; comparing it after the command finds the files that are new or modified.
 * Folders are listed without recursion and the number of files is bounded, so a snapshot stays
 * cheap enough to take around every command.
 */
import * as fs from "fs/promises";
import * as path from "path";

const WORKBOOK_EXTENSIONS = new Set([".xlsx", ".xlsm"]);
/** Workbook paths written in a command line, such as "out/report.xlsx" (not paths with spaces). */
const WORKBOOK_PATH_PATTERN = /[^\s'"`<>|;&()=,]+\.xls[xm](?![\w.])/gi;
const MAX_TRACKED_WORKBOOKS = 100;
const MAX_NAMED_WORKBOOKS = 20;

interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface WorkbookSnapshot {
  /** Workbooks that existed before the command, by absolute path. */
  files: Map<string, FileStamp>;
  /** Folders listed for the snapshot. */
  directories: string[];
  /** Workbook paths named by the command, whether or not they existed. */
  namedPaths: string[];
}

function isWorkbookName(name: string): boolean {
  // "~$report.xlsx" is Excel's lock file and dotfiles are temporary copies.
  if (name.startsWith("~$") || name.startsWith(".")) return false;
  return WORKBOOK_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function stampOf(filePath: string): Promise<FileStamp | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
  } catch {
    return null;
  }
}

async function workbooksIn(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isWorkbookName(entry.name))
      .slice(0, MAX_TRACKED_WORKBOOKS)
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

/** Workbook paths written in a command line, resolved against its working folder. */
export function workbookPathsInCommand(command: string, cwd: string): string[] {
  const paths = new Set<string>();
  for (const match of command.matchAll(WORKBOOK_PATH_PATTERN)) {
    const raw = match[0];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue; // URLs
    if (!isWorkbookName(path.basename(raw))) continue;
    paths.add(path.resolve(cwd, raw));
    if (paths.size >= MAX_NAMED_WORKBOOKS) break;
  }
  return [...paths];
}

/** Records the workbooks a command could change: in `directories` and named by `command`. */
export async function snapshotWorkbooks(
  command: string,
  cwd: string,
  directories: string[],
): Promise<WorkbookSnapshot> {
  const uniqueDirectories = [...new Set(directories.map((directory) => path.resolve(directory)))];
  const namedPaths = workbookPathsInCommand(command, cwd);
  const candidates = new Set<string>(namedPaths);
  for (const directory of uniqueDirectories) {
    for (const file of await workbooksIn(directory)) candidates.add(file);
  }
  const files = new Map<string, FileStamp>();
  for (const file of [...candidates].slice(0, MAX_TRACKED_WORKBOOKS)) {
    const stamp = await stampOf(file);
    if (stamp) files.set(file, stamp);
  }
  return { files, directories: uniqueDirectories, namedPaths };
}

/** Workbooks that are new or changed since `snapshot` was taken. */
export async function findChangedWorkbooks(snapshot: WorkbookSnapshot): Promise<string[]> {
  const candidates = new Set<string>([...snapshot.files.keys(), ...snapshot.namedPaths]);
  for (const directory of snapshot.directories) {
    for (const file of await workbooksIn(directory)) candidates.add(file);
  }
  const changed: string[] = [];
  for (const file of [...candidates].slice(0, MAX_TRACKED_WORKBOOKS)) {
    const after = await stampOf(file);
    if (!after) continue;
    const before = snapshot.files.get(file);
    if (!before || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      changed.push(file);
    }
  }
  return changed;
}
