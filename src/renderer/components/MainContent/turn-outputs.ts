import type { TaskEvent, TaskStatus } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { dedupeOutputPaths } from "../../utils/task-outputs";
import { getSidePanelViewerKind } from "../../utils/open-file-in-panel";

export type TurnOutputAction = "created" | "updated";

export interface TurnOutputFile {
  path: string;
  action: TurnOutputAction;
}

/** Files one finished conversation turn wrote, shown as a single line at the end of the turn. */
export interface TurnOutputSummary {
  /** Stable for the turn: the id of the event that opened it. */
  key: string;
  files: TurnOutputFile[];
  /** Event-stream index range [startIndex, endIndex] the turn covers. */
  startIndex: number;
  endIndex: number;
}

// Working files the agent writes for itself: never deliverables.
const SCRATCH_PATH_SEGMENTS = new Set([
  ".cowork",
  ".git",
  ".cache",
  ".venv",
  ".tmp",
  "__pycache__",
  "node_modules",
  "scratch",
  "tmp",
  "temp",
  "venv",
]);
const SCRATCH_ABSOLUTE_PREFIX_RE = /^\/(?:private\/)?(?:tmp|var\/folders)\//;
const SCRATCH_FILE_NAME_RE = /^(?:~\$|\.DS_Store$|\.~lock\.)/;

function normalizeOutputPath(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\\/g, "/") : "";
}

export function isScratchOutputPath(filePath: string): boolean {
  const normalized = normalizeOutputPath(filePath);
  if (!normalized) return true;
  if (SCRATCH_ABSOLUTE_PREFIX_RE.test(normalized)) return true;
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] || "";
  if (SCRATCH_FILE_NAME_RE.test(fileName)) return true;
  return segments.slice(0, -1).some((segment) => SCRATCH_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/** Paths an event says the agent wrote, split into newly created and changed files. */
function getWrittenPaths(event: TaskEvent): { created: string[]; updated: string[] } {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "file_created") {
    if (event.payload?.type === "directory") return { created: [], updated: [] };
    return { created: [normalizeOutputPath(event.payload?.path)], updated: [] };
  }
  if (effectiveType === "artifact_created" || event.type === "timeline_artifact_emitted") {
    return { created: [normalizeOutputPath(event.payload?.path)], updated: [] };
  }
  if (effectiveType === "file_modified") {
    return {
      created: [],
      updated: [normalizeOutputPath(event.payload?.path || event.payload?.to)],
    };
  }
  return { created: [], updated: [] };
}

function summarizeTurn(
  events: TaskEvent[],
  startIndex: number,
  endIndex: number,
): TurnOutputSummary | null {
  const created: string[] = [];
  const updated: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const written = getWrittenPaths(events[index]);
    for (const path of written.created) {
      if (path && !isScratchOutputPath(path)) created.push(path);
    }
    for (const path of written.updated) {
      if (path && !isScratchOutputPath(path)) updated.push(path);
    }
  }
  // A turn that made new files lists those; edits only show when nothing new was made.
  const createdPaths = dedupeOutputPaths(created);
  const files: TurnOutputFile[] =
    createdPaths.length > 0
      ? createdPaths.map((path) => ({ path, action: "created" }))
      : dedupeOutputPaths(updated).map((path) => ({ path, action: "updated" }));
  if (files.length === 0) return null;
  const opener = events[startIndex];
  return {
    key: opener?.id || `index:${startIndex}`,
    files,
    startIndex,
    endIndex,
  };
}

/**
 * One output summary per finished turn (a user message opens a turn; the task prompt opens
 * the first). The turn still running has none, so the line never jumps while work continues.
 */
export function collectTurnOutputSummaries(
  events: TaskEvent[],
  options: { isTaskWorking: boolean },
): TurnOutputSummary[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const turnStarts: number[] = [0];
  events.forEach((event, index) => {
    if (index > 0 && getEffectiveTaskEventType(event) === "user_message") turnStarts.push(index);
  });
  const summaries: TurnOutputSummary[] = [];
  turnStarts.forEach((startIndex, turnIndex) => {
    const isLastTurn = turnIndex === turnStarts.length - 1;
    if (isLastTurn && options.isTaskWorking) return;
    const endIndex = isLastTurn ? events.length - 1 : turnStarts[turnIndex + 1] - 1;
    const summary = summarizeTurn(events, startIndex, endIndex);
    if (summary) summaries.push(summary);
  });
  return summaries;
}

/** Every non-scratch file the task created or changed, in first-write order. */
export function collectWrittenFilePaths(events: TaskEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    const written = getWrittenPaths(event);
    for (const path of [...written.created, ...written.updated]) {
      if (path && !isScratchOutputPath(path)) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * The file to open in the side panel when a turn finishes: the turn's one newly created
 * document, sheet, deck or page. Edits, or several such files, are ambiguous and open nothing.
 */
export function pickTurnOutputToAutoOpen(summary: TurnOutputSummary): string | null {
  const candidates = summary.files.filter(
    (file) => file.action === "created" && getSidePanelViewerKind(file.path) !== null,
  );
  return candidates.length === 1 ? candidates[0].path : null;
}

/** Task states in which the turn has not ended: still running, or waiting on the user. */
const TURN_UNFINISHED_STATUSES = new Set<TaskStatus>([
  "planning",
  "executing",
  "paused",
  "blocked",
  "interrupted",
]);

/**
 * Whether the task's turn has ended, so its output may open. A task paused for an approval
 * or an answer stops working without finishing, and the task's status can trail the event
 * that stopped the work, so the status decides.
 */
export function isTurnSettledForAutoOpen(status: TaskStatus | undefined): boolean {
  return status !== undefined && !TURN_UNFINISHED_STATUSES.has(status);
}

/**
 * One step of watching a turn for auto-open. `watching` is the task whose turn the user saw
 * working (or null). Returns what to watch next, and whether the turn just ended, so its
 * output may open now.
 */
export function stepTurnAutoOpenWatch(
  watching: string | null,
  task: { id: string | null; working: boolean; status: TaskStatus | undefined },
): { watching: string | null; turnEnded: boolean } {
  if (task.working) return { watching: task.id, turnEnded: false };
  // Another task is shown now: the watched turn's end is not this task's.
  if (!watching || watching !== task.id) return { watching: null, turnEnded: false };
  if (!isTurnSettledForAutoOpen(task.status)) return { watching, turnEnded: false };
  return { watching: null, turnEnded: true };
}

/**
 * The file to auto-open for the turn that just finished: only the stream's final turn, and
 * only once per turn (`openedTurnKeys` holds the turns already handled).
 */
export function getFinishedTurnAutoOpen(
  events: TaskEvent[],
  openedTurnKeys: ReadonlySet<string>,
): { turnKey: string; path: string } | null {
  const lastTurn = collectTurnOutputSummaries(events, { isTaskWorking: false }).at(-1);
  if (!lastTurn || lastTurn.endIndex !== events.length - 1) return null;
  if (openedTurnKeys.has(lastTurn.key)) return null;
  const path = pickTurnOutputToAutoOpen(lastTurn);
  return path ? { turnKey: lastTurn.key, path } : null;
}

/**
 * Resolves inline `code` text in an answer (`report.docx`, `out/report.docx`) to a file the
 * task wrote, so it renders as an openable chip. Bare names only match when unambiguous.
 */
export function buildWrittenFileResolver(writtenPaths: string[]): (text: string) => string | null {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string | null>();
  for (const path of writtenPaths) {
    byPath.set(path.toLowerCase(), path);
    const name = (path.split("/").pop() || path).toLowerCase();
    const existing = byName.get(name);
    byName.set(name, existing === undefined || existing === path ? path : null);
  }
  return (text: string) => {
    if (byPath.size === 0) return null;
    const candidate = text.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (!candidate || /\s/.test(candidate) || !/\.[a-z0-9]{1,8}$/.test(candidate)) return null;
    const exact = byPath.get(candidate);
    if (exact) return exact;
    if (candidate.includes("/")) {
      for (const [key, path] of byPath) {
        if (key.endsWith(`/${candidate}`)) return path;
      }
      return null;
    }
    return byName.get(candidate) ?? null;
  };
}

/**
 * An emitted artifact for a file the stream also shows being written: the write row already
 * names the file, so the artifact row would only repeat it.
 */
export function isArtifactEventCoveredByFileWrite(event: TaskEvent, events: TaskEvent[]): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType !== "artifact_created" && event.type !== "timeline_artifact_emitted") {
    return false;
  }
  const path = normalizeOutputPath(event.payload?.path);
  if (!path) return false;
  return events.some((candidate) => {
    if (candidate === event) return false;
    const type = getEffectiveTaskEventType(candidate);
    if (type !== "file_created" && type !== "file_modified") return false;
    const written = normalizeOutputPath(candidate.payload?.path || candidate.payload?.to);
    return dedupeOutputPaths([written, path]).length === 1;
  });
}
