/**
 * The Agent Memory Repo file format (docs/memory-repo-phase1-design.md §3): pure parsing and
 * rendering, no filesystem access.
 *
 * An entry is one bullet on one line with optional metadata at the end:
 *   `- Prefers concise answers [by: user; added: 2026-10-05]`
 * CoWork adds the open keys `by` (`user` | `agent`), `kind`, `subject` and `workspace` to the
 * spec's `source` and `added`. A line without `by` counts as the user's (a hand edit).
 */
import {
  MEMORY_ITEM_KINDS,
  hashMemoryItemContent,
  normalizeMemoryItemContent,
  normalizeSubjectKey,
  type MemoryItemKind,
} from "../memory-items-types";

export const MEMORY_REPO_ENTRY_FILE = "MEMORY.md";
export const MEMORY_REPO_ME_FILE = "me.md";
export const MEMORY_REPO_LESSONS_FILE = "lessons.md";
export const MEMORY_REPO_INBOX_FILE = "inbox.md";
export const MEMORY_REPO_WORKSPACES_DIR = "workspaces";
/**
 * Shared notes of agents working on one goal (docs/memory-repo-phase5-design.md §2):
 * `swarms/<slug>/`. Not the user's memory: never linked from MEMORY.md, never in the Hub,
 * never read by dreams.
 */
export const MEMORY_REPO_SWARMS_DIR = "swarms";
export const MEMORY_REPO_INDEX_HEADING = "## Index";

/** Size limits (§3). */
export const MEMORY_REPO_LIMITS = {
  entryFileBytes: 4 * 1024,
  fileBytes: 64 * 1024,
  entryChars: 500,
  files: 2000,
} as const;

export type MemoryRepoAuthor = "user" | "agent";

export interface MemoryRepoMetadata {
  source?: string;
  added?: string;
  by?: string;
  kind?: string;
  subject?: string;
  workspace?: string;
  [key: string]: string | undefined;
}

export interface MemoryRepoEntry {
  /** 1-based line number in its file. */
  line: number;
  /** The entry text without the bullet and the metadata. */
  text: string;
  metadata: MemoryRepoMetadata;
  /** `user` unless the line says `by: agent`. */
  by: MemoryRepoAuthor;
  kind: MemoryItemKind | null;
  subject: string | null;
  /** Hash of the normalized text (the `memory_items` content-hash rule). */
  hash: string;
}

const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const METADATA = /\s*\[((?:\s*[A-Za-z][\w-]*\s*:[^;\]]*;?)+)\]\s*$/;
const LINK = /^\[\[[^\]]+\]\]$/;

/** Parse one line; null when it is not an entry (headings, prose, index links). */
export function parseMemoryRepoLine(raw: string, line: number): MemoryRepoEntry | null {
  const bullet = BULLET.exec(raw);
  if (!bullet) return null;
  let body = bullet[1];
  const metadata: MemoryRepoMetadata = {};
  const meta = METADATA.exec(body);
  if (meta && meta.index > 0) {
    for (const part of meta[1].split(";")) {
      const colon = part.indexOf(":");
      if (colon <= 0) continue;
      const key = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (key && value) metadata[key] = value;
    }
    body = body.slice(0, meta.index);
  }
  const text = normalizeMemoryItemContent(body);
  if (!text || LINK.test(text)) return null;
  const kind = (MEMORY_ITEM_KINDS as readonly string[]).includes(metadata.kind ?? "")
    ? (metadata.kind as MemoryItemKind)
    : null;
  return {
    line,
    text,
    metadata,
    by: metadata.by === "agent" ? "agent" : "user",
    kind,
    subject: normalizeSubjectKey(metadata.subject) ?? null,
    hash: hashMemoryItemContent(text),
  };
}

/** Every entry of a file, in order. */
export function parseMemoryRepoEntries(markdown: string): MemoryRepoEntry[] {
  const entries: MemoryRepoEntry[] = [];
  splitLines(markdown).forEach((raw, index) => {
    const entry = parseMemoryRepoLine(raw, index + 1);
    if (entry) entries.push(entry);
  });
  return entries;
}

export function splitLines(markdown: string): string[] {
  return String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
}

/**
 * Entry text as stored: one line, no bullet, no trailing metadata-looking bracket (so the
 * text can never smuggle its own `by: user`), at most `MEMORY_REPO_LIMITS.entryChars`.
 */
export function cleanEntryText(value: string): string {
  let text = normalizeMemoryItemContent(String(value || "").replace(/[\r\n]+/g, " "));
  text = text.replace(/^\s*[-*]\s+/, "");
  for (let i = 0; i < 3 && METADATA.test(text); i += 1) text = text.replace(METADATA, "").trim();
  if (text.length > MEMORY_REPO_LIMITS.entryChars) {
    const cut = text.slice(0, MEMORY_REPO_LIMITS.entryChars - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space > MEMORY_REPO_LIMITS.entryChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return text;
}

/** Metadata values cannot contain `;`, `]` or line breaks. */
function cleanMetaValue(value: string): string {
  return String(value || "")
    .replace(/[;\]\[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const META_ORDER = ["by", "kind", "subject", "workspace", "source", "added"];

export function renderMemoryRepoEntry(text: string, metadata: MemoryRepoMetadata): string {
  const keys = [
    ...META_ORDER.filter((key) => metadata[key]),
    ...Object.keys(metadata)
      .filter((key) => !META_ORDER.includes(key) && metadata[key])
      .sort(),
  ];
  const parts = keys
    .map((key) => [key, cleanMetaValue(metadata[key] ?? "")] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  return `- ${cleanEntryText(text)}${parts.length ? ` [${parts.join("; ")}]` : ""}`;
}

/** `YYYY-MM-DD` in UTC. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function initialEntryFile(owner?: string | null): string {
  const title = owner && owner.trim() ? `# Memory: ${owner.trim()}` : "# Memory";
  return `${title}\n\n${MEMORY_REPO_INDEX_HEADING}\n- [[me]]\n- [[lessons]]\n`;
}

export function initialTopicFile(title: string): string {
  return `# ${title}\n\n`;
}

/** Link target of a repo path: root-relative, `.md` omitted (spec). */
export function linkTarget(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/\.md$/i, "");
}

/**
 * Add `- [[target]]` under `## Index` of MEMORY.md unless it is already linked. Creates the
 * heading at the end when missing.
 */
export function ensureIndexLink(entryFile: string, relPath: string): string {
  const target = linkTarget(relPath);
  if (entryFile.includes(`[[${target}]]`)) return entryFile;
  const lines = splitLines(entryFile);
  const heading = lines.findIndex((line) => line.trim() === MEMORY_REPO_INDEX_HEADING);
  if (heading < 0) {
    const body = entryFile.replace(/\s*$/, "");
    return `${body}\n\n${MEMORY_REPO_INDEX_HEADING}\n- [[${target}]]\n`;
  }
  let insertAt = heading + 1;
  while (insertAt < lines.length && /^\s*[-*]\s+\[\[/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, `- [[${target}]]`);
  return lines.join("\n");
}

/**
 * Insert an entry line. In MEMORY.md, entries go above `## Index` (spec); elsewhere at the
 * end of the file.
 */
export function insertEntryLine(markdown: string, entryLine: string, isEntryFile: boolean): string {
  const lines = splitLines(markdown);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (isEntryFile) {
    const heading = lines.findIndex((line) => line.trim() === MEMORY_REPO_INDEX_HEADING);
    if (heading >= 0) {
      let at = heading;
      while (at > 0 && lines[at - 1].trim() === "") at -= 1;
      const before = lines.slice(0, at);
      const after = lines.slice(heading);
      const lastBefore = before[before.length - 1] ?? "";
      const spacer = BULLET.test(lastBefore) ? [] : [""];
      return [...before, ...spacer, entryLine, "", ...after].join("\n") + "\n";
    }
  }
  const last = lines[lines.length - 1] ?? "";
  const spacer = lines.length === 0 || BULLET.test(last) ? [] : [""];
  return [...lines, ...spacer, entryLine].join("\n") + "\n";
}

export function replaceLine(markdown: string, line: number, next: string | null): string {
  const lines = splitLines(markdown);
  if (line < 1 || line > lines.length) return markdown;
  if (next === null) lines.splice(line - 1, 1);
  else lines[line - 1] = next;
  return lines.join("\n");
}

/** A file-name slug for a workspace name. */
export function workspaceSlug(name: string): string {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "workspace";
}

/** `repo:<path>#L<n>` refs used by recall, attribution and memory_forget. */
export function memoryRepoRef(relPath: string, line: number): string {
  return `repo:${relPath.replace(/\\/g, "/")}#L${line}`;
}

export function parseMemoryRepoRef(raw: string): { path: string; line: number } | null {
  const match = /^repo:(.+)#L(\d+)$/.exec(String(raw || "").trim());
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  const relPath = match[1].replace(/\\/g, "/");
  if (!isSafeRepoPath(relPath)) return null;
  return { path: relPath, line };
}

/** Team memory repo names (settings: letters, digits, spaces, `.`, `_`, `-`; no `:`). */
const TEAM_MEMORY_NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;

/**
 * `team:<name>:<path>#L<n>` refs of read-only team memory repos
 * (docs/memory-repo-phase4-design.md §2).
 */
export function teamMemoryRef(name: string, relPath: string, line: number): string {
  return `team:${name}:${relPath.replace(/\\/g, "/")}#L${line}`;
}

export function parseTeamMemoryRef(
  raw: string,
): { name: string; path: string; line: number } | null {
  const match = /^team:([^:]+):(.+)#L(\d+)$/.exec(String(raw || "").trim());
  if (!match) return null;
  const name = match[1].trim();
  if (!TEAM_MEMORY_NAME.test(name)) return null;
  const line = Number(match[3]);
  if (!Number.isInteger(line) || line < 1) return null;
  const relPath = match[2].replace(/\\/g, "/");
  if (!isSafeRepoPath(relPath)) return null;
  return { name, path: relPath, line };
}

/** Root-relative markdown path without `.`/`..`/empty segments, hidden files or `.git`. */
export function isSafeRepoPath(relPath: string): boolean {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  if (!/\.md$/i.test(normalized)) return false;
  return normalized
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

/** Whether a repo-relative path is inside `swarms/`. */
export function isSwarmRepoPath(relPath: string): boolean {
  return String(relPath || "")
    .replace(/\\/g, "/")
    .startsWith(`${MEMORY_REPO_SWARMS_DIR}/`);
}
