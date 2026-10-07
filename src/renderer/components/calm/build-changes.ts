import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

/** "fold" stands in for a run of unchanged lines that is not shown. */
export type DiffLine = { kind: "context" | "added" | "removed" | "fold"; text: string };

export interface BuildChangeHunk {
  /** "write" replaces the whole file; "edit" swaps one passage. */
  kind: "write" | "edit";
  lines: DiffLine[];
  /** The diff was skipped because the change is too large to show inline. */
  truncated: boolean;
}

export interface BuildFileChange {
  path: string;
  status: "created" | "modified" | "deleted";
  added: number;
  removed: number;
  hunks: BuildChangeHunk[];
}

/** Line-diffs bigger than this (old × new lines) are shown as plain content. */
const MAX_DIFF_CELLS = 400_000;
const MAX_SHOWN_LINES = 1_500;
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Longest-common-subsequence line diff; small inputs only. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return null;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });
  return out;
}

/** Keeps changed lines plus a little context, folding long unchanged runs. */
export function trimContext(lines: DiffLine[]): DiffLine[] {
  const keep: boolean[] = Array.from({ length: lines.length }, () => false);
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    for (
      let k = Math.max(0, index - CONTEXT_LINES);
      k <= Math.min(lines.length - 1, index + CONTEXT_LINES);
      k += 1
    ) {
      keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ kind: "fold", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) {
    out.push({ kind: "fold", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  }
  return out;
}

function capLines(lines: DiffLine[]): { lines: DiffLine[]; truncated: boolean } {
  return lines.length > MAX_SHOWN_LINES
    ? { lines: lines.slice(0, MAX_SHOWN_LINES), truncated: true }
    : { lines, truncated: false };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeBuildPath(path: string, workspacePath?: string): string {
  const clean = path.replace(/\\/g, "/");
  const root = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && clean.startsWith(`${root}/`)) return clean.slice(root.length + 1);
  return clean.replace(/^\.\//, "");
}

/** Pair persisted calls with their outcomes, including older events without IDs. */
function successfulBuildCalls(events: TaskEvent[]): Set<TaskEvent> {
  const successful = new Set<TaskEvent>();
  const pendingById = new Map<string, TaskEvent>();
  const legacyByTool = new Map<string, TaskEvent[]>();
  for (const event of events) {
    const type = getEffectiveTaskEventType(event);
    const payload = event.payload;
    const tool = payload?.tool;
    if (tool !== "write_file" && tool !== "edit_file") continue;
    const id = asString(payload.toolUseId) ?? asString(payload.tool_use_id);
    if (type === "tool_call") {
      if (id) pendingById.set(id, event);
      else {
        const pending = legacyByTool.get(tool) ?? [];
        pending.push(event);
        legacyByTool.set(tool, pending);
      }
      continue;
    }
    if (type !== "tool_result" && type !== "tool_error") continue;
    const call = id ? pendingById.get(id) : legacyByTool.get(tool)?.shift();
    if (!call) continue;
    if (id) pendingById.delete(id);
    const result = payload.result;
    if (
      type === "tool_result" &&
      result &&
      !payload.error &&
      payload.is_error !== true &&
      payload.cancelled !== true &&
      result.success !== false &&
      !result.error
    ) {
      successful.add(call);
    }
  }
  return successful;
}

/**
 * Rebuilds what a build changed from its tool calls: each write_file and
 * edit_file becomes a hunk with a line diff. A rewrite of a file the build
 * already wrote is diffed against that earlier content; a first write over a
 * pre-existing file is shown as its new content, since the old file content is
 * not in the event log.
 */
export function deriveBuildChanges(
  events: TaskEvent[],
  options: { workspacePath?: string; changedPaths: ReadonlyMap<string, BuildFileChange["status"]> },
): BuildFileChange[] {
  const byPath = new Map<string, BuildFileChange>();
  const lastContent = new Map<string, string>();
  const successfulCalls = successfulBuildCalls(events);

  const entryFor = (path: string): BuildFileChange | null => {
    const status = options.changedPaths.get(path);
    if (!status) return null;
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, status, added: 0, removed: 0, hunks: [] };
      byPath.set(path, entry);
    }
    return entry;
  };

  for (const event of events) {
    if (!successfulCalls.has(event)) continue;
    const tool = event.payload?.tool;
    const input = event.payload?.input as Record<string, unknown> | undefined;
    if (!input) continue;

    if (tool === "write_file") {
      const rawPath = asString(input.path);
      const content = asString(input.content);
      if (!rawPath || content === null) continue;
      const path = normalizeBuildPath(rawPath, options.workspacePath);
      const entry = entryFor(path);
      if (!entry) continue;
      const previous = lastContent.get(path);
      const diff = previous !== undefined ? diffLines(previous, content) : diffLines("", content);
      const lines = diff
        ? previous !== undefined
          ? trimContext(diff)
          : diff
        : splitLines(content).map((text) => ({ kind: "added" as const, text }));
      const capped = capLines(lines);
      entry.hunks.push({ kind: "write", ...capped, truncated: capped.truncated || !diff });
      lastContent.set(path, content);
      continue;
    }

    if (tool === "edit_file") {
      const rawPath = asString(input.file_path) ?? asString(input.path);
      const before = asString(input.old_string);
      const after = asString(input.new_string);
      if (!rawPath || before === null || after === null) continue;
      const path = normalizeBuildPath(rawPath, options.workspacePath);
      const entry = entryFor(path);
      if (!entry) continue;
      const diff = diffLines(before, after);
      const lines = diff ?? [
        ...splitLines(before).map((text) => ({ kind: "removed" as const, text })),
        ...splitLines(after).map((text) => ({ kind: "added" as const, text })),
      ];
      const capped = capLines(lines);
      entry.hunks.push({ kind: "edit", ...capped, truncated: capped.truncated });
      const known = lastContent.get(path);
      if (known !== undefined && known.includes(before)) {
        lastContent.set(
          path,
          input.replace_all === true
            ? known.split(before).join(after)
            : known.replace(before, () => after),
        );
      }
    }
  }

  // Files the build touched without a diffable tool call (deletes, copies,
  // renames, other tools) are still listed.
  for (const [path] of options.changedPaths) entryFor(path);

  for (const entry of byPath.values()) {
    for (const hunk of entry.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") entry.added += 1;
        else if (line.kind === "removed") entry.removed += 1;
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
