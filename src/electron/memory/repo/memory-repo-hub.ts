/**
 * Memory Hub "What CoWork knows" over the memory folder (docs/memory-repo-phase3-design.md
 * §5): the files and entries one workspace sees, and Edit / Delete / Pin / Open file on an
 * entry. Shared by the desktop IPC (memory-repo-handlers.ts) and the browser host.
 *
 * A workspace sees the global files (`MEMORY.md`, `me.md`, `lessons.md`, topic files), its
 * own `workspaces/<slug>.md` and the inbox; another workspace's file is reported exactly
 * like a missing one. Every action names the entry by ref and the hash of its text, so a
 * line that moved or changed since the Hub loaded is never touched.
 */
import {
  MEMORY_REPO_HUB_ENTRIES_PER_FILE,
  type MemoryRepoEntriesReport,
  type MemoryRepoEntryActionResult,
  type MemoryRepoHubEntry,
  type MemoryRepoHubFile,
  type MemoryRepoHubFileRole,
} from "../../../shared/memory-repo-types";
import { redactSensitiveMarkdownContent } from "../markdown-index-sql";
import type { MemoryRepoService } from "./MemoryRepoService";
import {
  MEMORY_REPO_ENTRY_FILE,
  MEMORY_REPO_INBOX_FILE,
  MEMORY_REPO_LESSONS_FILE,
  MEMORY_REPO_ME_FILE,
  MEMORY_REPO_WORKSPACES_DIR,
  memoryRepoRef,
  parseMemoryRepoEntries,
  parseMemoryRepoLine,
  parseMemoryRepoRef,
  splitLines,
  type MemoryRepoEntry,
} from "./memory-repo-format";

export type MemoryRepoHubPort = Pick<
  MemoryRepoService,
  | "isReady"
  | "isWritable"
  | "listFiles"
  | "readFile"
  | "workspaceFile"
  | "updateEntry"
  | "forget"
  | "moveEntry"
  | "resolveFile"
>;

const TASK_SOURCE = /^cowork:\/\/tasks\/([A-Za-z0-9_.:-]{1,128})$/;

const FIXED_ORDER: Record<string, number> = {
  [MEMORY_REPO_ENTRY_FILE]: 0,
  [MEMORY_REPO_ME_FILE]: 1,
  [MEMORY_REPO_LESSONS_FILE]: 2,
};

export function memoryRepoFileRole(relPath: string): MemoryRepoHubFileRole {
  if (relPath === MEMORY_REPO_ENTRY_FILE) return "entry";
  if (relPath === MEMORY_REPO_ME_FILE) return "me";
  if (relPath === MEMORY_REPO_LESSONS_FILE) return "lessons";
  if (relPath === MEMORY_REPO_INBOX_FILE) return "inbox";
  if (relPath.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`)) return "workspace";
  return "topic";
}

/** Whether a workspace's Hub may see a file: global files and the inbox, or its own file. */
function visibleIn(relPath: string, ownWorkspaceFile: string | null): boolean {
  if (!relPath.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`)) return true;
  return relPath === ownWorkspaceFile;
}

function displayText(text: string): string {
  return redactSensitiveMarkdownContent(text)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fileTitle(relPath: string, markdown: string): string {
  const heading = splitLines(markdown).find((line) => /^#\s+\S/.test(line));
  const title = heading ? heading.replace(/^#\s+/, "").trim() : "";
  return (title || relPath.replace(/\.md$/i, "")).slice(0, 200);
}

export function toMemoryRepoHubEntry(relPath: string, entry: MemoryRepoEntry): MemoryRepoHubEntry {
  const source = entry.metadata.source ?? null;
  const task = source ? TASK_SOURCE.exec(source) : null;
  return {
    ref: memoryRepoRef(relPath, entry.line),
    path: relPath,
    line: entry.line,
    text: displayText(entry.text),
    by: entry.by,
    kind: entry.kind,
    added: /^\d{4}-\d{2}-\d{2}$/.test(entry.metadata.added ?? "") ? entry.metadata.added! : null,
    taskId: task ? task[1] : null,
    hash: entry.hash,
    source: source && !task ? source.slice(0, 200) : null,
  };
}

async function hubFile(service: MemoryRepoHubPort, relPath: string): Promise<MemoryRepoHubFile | null> {
  const markdown = await service.readFile(relPath);
  if (markdown === null) return null;
  const entries = parseMemoryRepoEntries(markdown).filter((entry) => !entry.metadata.workspace);
  return {
    path: relPath,
    title: fileTitle(relPath, markdown),
    role: memoryRepoFileRole(relPath),
    entries: entries
      .slice(0, MEMORY_REPO_HUB_ENTRIES_PER_FILE)
      .map((entry) => toMemoryRepoHubEntry(relPath, entry)),
    ...(entries.length > MEMORY_REPO_HUB_ENTRIES_PER_FILE ? { truncated: true } : {}),
  };
}

/** The files and entries the workspace's Hub shows; `available: false` when the folder is off. */
export async function listMemoryRepoEntries(
  service: MemoryRepoHubPort | null,
  workspaceId: string,
): Promise<MemoryRepoEntriesReport> {
  if (!service?.isReady()) return { available: false, writable: false, files: [], inbox: null };
  const own = await service.workspaceFile(workspaceId);
  const paths = (await service.listFiles()).filter(
    (file) => file !== MEMORY_REPO_INBOX_FILE && visibleIn(file, own),
  );
  const rank = (file: string) =>
    FIXED_ORDER[file] ?? (file.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`) ? 4 : 3);
  paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const files: MemoryRepoHubFile[] = [];
  for (const file of paths) {
    const view = await hubFile(service, file);
    if (view) files.push(view);
  }
  return {
    available: true,
    writable: service.isWritable(),
    files,
    inbox: await hubFile(service, MEMORY_REPO_INBOX_FILE),
  };
}

export interface MemoryRepoEntryRequest {
  workspaceId: string;
  ref: string;
  hash: string;
}

/** The ref's file and line when the workspace may act on it; otherwise an error. */
async function resolveRef(
  service: MemoryRepoHubPort | null,
  request: MemoryRepoEntryRequest,
): Promise<{ service: MemoryRepoHubPort; path: string; line: number } | { error: string }> {
  if (!service?.isWritable()) return { error: "The memory folder is not available." };
  const parsed = parseMemoryRepoRef(request.ref);
  if (!parsed) return { error: "Not a memory folder entry." };
  if (!visibleIn(parsed.path, await service.workspaceFile(request.workspaceId))) {
    return { error: "No such memory file." };
  }
  return { service, ...parsed };
}

export async function updateMemoryRepoEntry(
  service: MemoryRepoHubPort | null,
  request: MemoryRepoEntryRequest & { text: string },
): Promise<MemoryRepoEntryActionResult> {
  const target = await resolveRef(service, request);
  if ("error" in target) return { ok: false, error: target.error };
  const result = await target.service.updateEntry(target.path, target.line, request.text, {
    expectHash: request.hash,
    by: "user",
    origin: "memory_hub",
  });
  if (!result.entry) return { ok: false, error: result.error ?? "The memory was not changed." };
  return { ok: true, ref: memoryRepoRef(target.path, result.entry.line) };
}

export async function removeMemoryRepoEntry(
  service: MemoryRepoHubPort | null,
  request: MemoryRepoEntryRequest,
): Promise<MemoryRepoEntryActionResult> {
  const target = await resolveRef(service, request);
  if ("error" in target) return { ok: false, error: target.error };
  const markdown = (await target.service.readFile(target.path)) ?? "";
  const entry = parseMemoryRepoLine(splitLines(markdown)[target.line - 1] ?? "", target.line);
  // The workspace marker line keeps the file mapped to its workspace.
  if (entry?.metadata.workspace) {
    return { ok: false, error: "That line names the workspace; it cannot be deleted here." };
  }
  const result = await target.service.forget(target.path, target.line, {
    expectHash: request.hash,
    origin: "memory_hub",
  });
  if (!result.removed) return { ok: false, error: result.error ?? "The memory was not deleted." };
  return { ok: true };
}

/** Pin = move to `MEMORY.md` (kept in every prompt) as the user's line. */
export async function pinMemoryRepoEntry(
  service: MemoryRepoHubPort | null,
  request: MemoryRepoEntryRequest,
): Promise<MemoryRepoEntryActionResult> {
  const target = await resolveRef(service, request);
  if ("error" in target) return { ok: false, error: target.error };
  const result = await target.service.moveEntry(target.path, target.line, MEMORY_REPO_ENTRY_FILE, {
    expectHash: request.hash,
    by: "user",
    origin: "memory_hub",
  });
  if (!result.moved) return { ok: false, error: result.error ?? "The memory was not pinned." };
  return { ok: true, ref: memoryRepoRef(result.moved.path, result.moved.line) };
}

/** The absolute path "Open file" may open: a file this workspace's Hub shows. */
export async function memoryRepoFileToOpen(
  service: MemoryRepoHubPort | null,
  request: { workspaceId: string; path: string },
): Promise<string> {
  if (!service?.isReady()) throw new Error("The memory folder is not available.");
  if (!visibleIn(request.path, await service.workspaceFile(request.workspaceId))) {
    throw new Error("No such memory file.");
  }
  const absolute = await service.resolveFile(request.path);
  if (!absolute) throw new Error("No such memory file.");
  return absolute;
}
