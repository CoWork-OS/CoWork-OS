import type { TaskEvent } from "../../../shared/types";
import { countLineChanges } from "../../../shared/line-change-stats";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

export type FileChangeKind = "created" | "edited" | "deleted";

export interface FileChangeSummary {
  kind: FileChangeKind;
  path: string;
  /** Null when the change's size is unknown (e.g. an overwrite of a very large file). */
  added: number | null;
  removed: number | null;
}

const FILE_CHANGE_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);
const FILE_EVENT_TYPES = new Set(["file_created", "file_modified", "file_deleted"]);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** Workspace-relative, forward-slash form used to match a tool call with its file event. */
export function normalizeFileChangePath(path: string, workspacePath?: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  const root = (workspacePath ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  return normalized.replace(/^\.\//, "");
}

function getToolName(event: TaskEvent): string {
  return asString(asObject(event.payload).tool).trim();
}

/** Path a write/edit/delete tool call targets, or null for any other event. */
export function getFileChangeToolPath(event: TaskEvent): string | null {
  if (getEffectiveTaskEventType(event) !== "tool_call") return null;
  const tool = getToolName(event);
  if (!FILE_CHANGE_TOOLS.has(tool)) return null;
  const input = asObject(asObject(event.payload).input);
  const path = asString(tool === "edit_file" ? input.file_path : input.path).trim();
  return path || null;
}

function getFileEventPath(event: TaskEvent): string {
  return asString(asObject(event.payload).path).trim();
}

export function isFileChangeEvent(event: TaskEvent): boolean {
  return FILE_EVENT_TYPES.has(getEffectiveTaskEventType(event));
}

/**
 * True when a standalone file event repeats a write/edit/delete tool call that already
 * appears in the activity list, so the feed can show that change once.
 */
export function isFileEventCoveredByToolCall(
  event: TaskEvent,
  events: TaskEvent[],
  workspacePath?: string,
): boolean {
  if (!isFileChangeEvent(event)) return false;
  const eventPath = getFileEventPath(event);
  if (!eventPath) return false;
  const target = normalizeFileChangePath(eventPath, workspacePath);
  return events.some((candidate) => {
    if (candidate.taskId !== event.taskId || candidate.timestamp > event.timestamp) return false;
    const callPath = getFileChangeToolPath(candidate);
    return callPath !== null && normalizeFileChangePath(callPath, workspacePath) === target;
  });
}

function findFileEventForCall(
  callEvent: TaskEvent,
  callPath: string,
  events: TaskEvent[],
  workspacePath?: string,
): TaskEvent | undefined {
  const target = normalizeFileChangePath(callPath, workspacePath);
  return events.find(
    (candidate) =>
      candidate.taskId === callEvent.taskId &&
      candidate.timestamp >= callEvent.timestamp &&
      isFileChangeEvent(candidate) &&
      normalizeFileChangePath(getFileEventPath(candidate), workspacePath) === target,
  );
}

/**
 * Describes a write/edit/delete tool call as a file row: what happened to which file, with
 * approximate line counts. Returns null for any other event.
 */
export function summarizeFileChange(
  callEvent: TaskEvent,
  resultEvent: TaskEvent | undefined,
  events: TaskEvent[],
  workspacePath?: string,
): FileChangeSummary | null {
  const callPath = getFileChangeToolPath(callEvent);
  if (!callPath) return null;
  const tool = getToolName(callEvent);
  const input = asObject(asObject(callEvent.payload).input);
  const path = normalizeFileChangePath(callPath, workspacePath);

  if (tool === "delete_file") {
    return { kind: "deleted", path, added: null, removed: null };
  }

  if (tool === "edit_file") {
    const result = asObject(asObject(resultEvent?.payload).result);
    const replacements = Math.max(1, asCount(result.replacements) ?? 1);
    const stats = countLineChanges(asString(input.old_string), asString(input.new_string));
    return {
      kind: "edited",
      path,
      added: stats.added * replacements,
      removed: stats.removed * replacements,
    };
  }

  // write_file reports whether it replaced a file and by how much on its file_created event.
  const fileEvent = findFileEventForCall(callEvent, callPath, events, workspacePath);
  const filePayload = asObject(fileEvent?.payload);
  const existed = filePayload.existed === true;
  const reportedAdded = asCount(filePayload.linesAdded);
  const reportedRemoved = asCount(filePayload.linesRemoved);
  if (reportedAdded !== null && reportedRemoved !== null) {
    return {
      kind: existed ? "edited" : "created",
      path,
      added: reportedAdded,
      removed: reportedRemoved,
    };
  }
  if (existed) return { kind: "edited", path, added: null, removed: null };
  const content = asString(input.content);
  return {
    kind: "created",
    path,
    added: content ? countLineChanges("", content).added : asCount(filePayload.lineCount),
    removed: 0,
  };
}
