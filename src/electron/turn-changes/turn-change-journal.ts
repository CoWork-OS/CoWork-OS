import fs from "node:fs/promises";
import path from "node:path";
import type { FileSnapshot, RevisionSnapshotStore } from "../annotations/revision-snapshots";
import {
  canonicalizeAccessPath,
  isAccessPathWithin,
  isProtectedFilesystemPath,
  isProtectedWorkspacePath,
} from "../security/access-profile-paths";
import { isScratchOutputPath } from "../../shared/scratch-paths";
import {
  FIRST_TURN_KEY,
  type TurnChangeSet,
  type TurnChangesUndoResult,
  type TurnFileChange,
} from "../../shared/turn-changes";

/**
 * A per-task record of what CoWork's file tools changed: each file's state before and after
 * every write, rename, copy and delete, with the bytes kept in the revision snapshot store.
 * Turns are cut at the task's user messages, so a turn's changes can be listed and put back.
 *
 * Stored as one JSON line per change in `<root>/<taskId>.jsonl`. Commands the agent runs in a
 * shell and files written by other tools are not recorded, so they are never undone.
 */

/**
 * A file's state: absent, or present with a hash (and kept bytes when small enough), and its
 * permission bits when known.
 */
export type FileState = { exists: false } | ({ exists: true; mode?: number } & FileSnapshot);

const SECRET_FILE_NAME_RE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:pem|key|p12|pfx|keystore|jks)$/i;

/** Files whose contents may be secrets: hashed so a change is seen, never copied. */
export function isSecretLikePath(filePath: string): boolean {
  return SECRET_FILE_NAME_RE.test(path.basename(filePath));
}

interface ChangeLine {
  kind: "change";
  at: number;
  path: string;
  before: FileState;
  after: FileState;
}

interface UndoLine {
  kind: "undo";
  at: number;
  turnKey: string;
  paths: string[];
}

/** The agent has been told about this undo. */
interface NotedLine {
  kind: "noted";
  at: number;
  turnKey: string;
}

type JournalLine = ChangeLine | UndoLine | NotedLine;

export interface TurnStart {
  /** The id of the user message that opened the turn. */
  key: string;
  at: number;
}

export interface TurnChangeJournalDeps {
  root: string;
  snapshots: RevisionSnapshotStore;
  /** Move a file to the Trash; used to put back a file the turn created. */
  trash: (filePath: string) => Promise<void>;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Line counts are computed for text files up to this size. */
const MAX_LINE_STATS_BYTES = 2 * 1024 * 1024;

function sameState(a: FileState, b: FileState): boolean {
  if (!a.exists || !b.exists) return a.exists === b.exists;
  return a.sha256 === b.sha256;
}

function isText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

/** Lines added and removed, counted as a multiset (order-insensitive, cheap, close enough). */
export function countLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
  const counts = new Map<string, number>();
  const split = (text: string) => {
    if (text.length === 0) return [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    // A final newline ends the last line; it does not start another.
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  for (const line of split(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of split(after)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

export class TurnChangeJournal {
  private readonly now: () => number;
  /** Writes per task, in order. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly undoing = new Set<string>();

  constructor(private readonly deps: TurnChangeJournalDeps) {
    this.now = deps.now ?? Date.now;
  }

  private file(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error("Invalid task id");
    return path.join(this.deps.root, `${taskId}.jsonl`);
  }

  private append(taskId: string, line: JournalLine): Promise<void> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.deps.root, { recursive: true, mode: 0o700 });
        await fs.appendFile(this.file(taskId), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      });
    this.queues.set(taskId, next);
    return next;
  }

  private async read(taskId: string): Promise<JournalLine[]> {
    await (this.queues.get(taskId) ?? Promise.resolve()).catch(() => {});
    let text: string;
    try {
      text = await fs.readFile(this.file(taskId), "utf8");
    } catch {
      return [];
    }
    const lines: JournalLine[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as JournalLine);
      } catch {
        // A line cut short by a crash; the rest still counts.
      }
    }
    return lines;
  }

  /** The state of a file now, keeping its bytes when small enough and not secret-like. */
  async captureState(filePath: string): Promise<FileState> {
    const snapshot = await this.deps.snapshots.capture(filePath, {
      keep: !isSecretLikePath(filePath),
    });
    if (!snapshot) return { exists: false };
    const mode = (await fs.stat(filePath).catch(() => undefined))?.mode;
    return { exists: true, ...snapshot, ...(mode !== undefined ? { mode: mode & 0o7777 } : {}) };
  }

  async stateOfBytes(bytes: Buffer | null, filePath: string): Promise<FileState> {
    return bytes
      ? {
          exists: true,
          ...(await this.deps.snapshots.captureBytes(bytes, { keep: !isSecretLikePath(filePath) })),
        }
      : { exists: false };
  }

  /** Whether `filePath`, resolved through symlinks, may be written by undo. */
  private undoTarget(
    filePath: string,
    workspaceRoot: string,
  ): "ok" | "outside_workspace" | "protected" {
    const canonical = canonicalizeAccessPath(filePath);
    if (!isAccessPathWithin(workspaceRoot, canonical)) return "outside_workspace";
    if (
      isProtectedFilesystemPath(canonical) ||
      isProtectedWorkspacePath(workspaceRoot, canonical)
    ) {
      return "protected";
    }
    return "ok";
  }

  /** Record one change, made at `at`. Nothing is recorded when the file did not change. */
  async record(
    taskId: string,
    filePath: string,
    before: FileState,
    after: FileState,
    at = this.now(),
  ): Promise<void> {
    if (sameState(before, after)) return;
    await this.append(taskId, { kind: "change", at, path: path.resolve(filePath), before, after });
  }

  /** The journal's clock, for callers that record a change later than they made it. */
  timestamp(): number {
    return this.now();
  }

  /** A turn's net change per file: its state before the turn's first change and after its last. */
  private async turnChanges(
    lines: JournalLine[],
    turnStarts: readonly TurnStart[],
  ): Promise<Map<string, Map<string, { before: FileState; after: FileState }>>> {
    const starts = [...turnStarts].sort((a, b) => a.at - b.at);
    const turnOf = (at: number) => {
      let key = FIRST_TURN_KEY;
      for (const start of starts) {
        if (start.at <= at) key = start.key;
        else break;
      }
      return key;
    };
    const turns = new Map<string, Map<string, { before: FileState; after: FileState }>>();
    for (const line of lines) {
      if (line.kind !== "change") continue;
      const key = turnOf(line.at);
      const files = turns.get(key) ?? new Map();
      const existing = files.get(line.path);
      if (existing) existing.after = line.after;
      else files.set(line.path, { before: line.before, after: line.after });
      turns.set(key, files);
    }
    return turns;
  }

  private async matchesNow(filePath: string, expected: FileState): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return !expected.exists;
    }
    if (!expected.exists || !stat.isFile() || stat.size !== expected.size) return false;
    const current = await this.deps.snapshots.capture(filePath);
    return current?.sha256 === expected.sha256;
  }

  private async lineStats(
    before: FileState,
    after: FileState,
  ): Promise<{ added: number; removed: number } | undefined> {
    const read = async (state: FileState) => {
      if (!state.exists) return Buffer.alloc(0);
      if (!state.kept || state.size > MAX_LINE_STATS_BYTES) return null;
      return this.deps.snapshots.read(state.sha256);
    };
    const [a, b] = await Promise.all([read(before), read(after)]);
    if (!a || !b || !isText(a) || !isText(b)) return undefined;
    return countLineChanges(a.toString("utf8"), b.toString("utf8"));
  }

  private async describe(
    turnKey: string,
    files: Map<string, { before: FileState; after: FileState }>,
    workspaceRoot: string | undefined,
    undoneAt: number | undefined,
  ): Promise<TurnChangeSet | null> {
    const changes: TurnFileChange[] = [];
    for (const [filePath, { before, after }] of files) {
      if (sameState(before, after)) continue;
      const inside = !!workspaceRoot && isAccessPathWithin(workspaceRoot, filePath);
      const displayPath = inside
        ? path
            .relative(canonicalizeAccessPath(workspaceRoot!), canonicalizeAccessPath(filePath))
            .split(path.sep)
            .join("/")
        : filePath;
      if (isScratchOutputPath(displayPath)) continue;
      const change: TurnFileChange = {
        path: filePath,
        displayPath,
        kind: !before.exists ? "created" : !after.exists ? "deleted" : "modified",
        ...(await this.lineStats(before, after)),
      };
      const target = inside ? this.undoTarget(filePath, workspaceRoot!) : "outside_workspace";
      if (target !== "ok") change.blocked = target;
      else if (before.exists && (!before.kept || !(await this.deps.snapshots.has(before.sha256)))) {
        change.blocked = isSecretLikePath(filePath) ? "secret" : "not_kept";
      } else if (!(await this.matchesNow(filePath, after))) {
        change.blocked = "changed_since";
      }
      changes.push(change);
    }
    if (changes.length === 0) return null;
    changes.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    return {
      turnKey,
      files: changes,
      ...(undoneAt ? { undoneAt } : {}),
      canUndo: !undoneAt && changes.every((change) => !change.blocked),
    };
  }

  /** Every turn with file changes, in turn order. */
  async list(
    taskId: string,
    turnStarts: readonly TurnStart[],
    workspaceRoot: string | undefined,
  ): Promise<TurnChangeSet[]> {
    const lines = await this.read(taskId);
    const turns = await this.turnChanges(lines, turnStarts);
    const undone = new Map<string, number>();
    for (const line of lines) if (line.kind === "undo") undone.set(line.turnKey, line.at);
    const order = [
      FIRST_TURN_KEY,
      ...[...turnStarts].sort((a, b) => a.at - b.at).map((s) => s.key),
    ];
    const result: TurnChangeSet[] = [];
    for (const key of order) {
      const files = turns.get(key);
      if (!files) continue;
      const set = await this.describe(key, files, workspaceRoot, undone.get(key));
      if (set) result.push(set);
    }
    return result;
  }

  /**
   * Put a turn's files back as they were before the turn: restore changed and deleted files,
   * move files it created to the Trash. Only when every file can be put back.
   */
  async undo(
    taskId: string,
    turnKey: string,
    turnStarts: readonly TurnStart[],
    workspaceRoot: string | undefined,
  ): Promise<TurnChangesUndoResult> {
    const lockKey = `${taskId}\u0000${turnKey}`;
    if (this.undoing.has(lockKey)) {
      return { ok: false, restored: [], error: "These changes are already being undone." };
    }
    this.undoing.add(lockKey);
    try {
      const lines = await this.read(taskId);
      const files = (await this.turnChanges(lines, turnStarts)).get(turnKey);
      const undoneAt = lines.find(
        (line): line is UndoLine => line.kind === "undo" && line.turnKey === turnKey,
      )?.at;
      const set = files ? await this.describe(turnKey, files, workspaceRoot, undoneAt) : null;
      if (!set || !files) {
        return { ok: false, restored: [], error: "This turn has no file changes to undo." };
      }
      if (!set.canUndo) {
        return {
          ok: false,
          restored: [],
          error: set.undoneAt
            ? "These changes were already undone."
            : "Some of these files can't be put back.",
          changeSet: set,
        };
      }
      const restored: string[] = [];
      try {
        for (const change of set.files) {
          const { before, after } = files.get(change.path)!;
          // Check again right before writing: a folder may have become a symlink, or the file
          // may have changed, since the list was made.
          const canonical = canonicalizeAccessPath(change.path);
          if (
            this.undoTarget(change.path, workspaceRoot!) !== "ok" ||
            !(await this.matchesNow(canonical, after))
          ) {
            throw new Error(`${change.displayPath} changed while undoing`);
          }
          if (before.exists) {
            await fs.mkdir(path.dirname(canonical), { recursive: true });
            await this.deps.snapshots.restore(before.sha256, canonical);
            if (before.mode !== undefined) await fs.chmod(canonical, before.mode);
          } else {
            await this.deps.trash(canonical);
          }
          restored.push(change.path);
        }
      } catch (error) {
        this.deps.log?.("Undoing a turn's file changes stopped part way", error);
        if (restored.length > 0) {
          await this.append(taskId, { kind: "undo", at: this.now(), turnKey, paths: restored });
        }
        return {
          ok: false,
          restored,
          error: `Stopped after ${restored.length} of ${set.files.length} files: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      await this.append(taskId, { kind: "undo", at: this.now(), turnKey, paths: restored });
      const after = await this.list(taskId, turnStarts, workspaceRoot);
      return { ok: true, restored, changeSet: after.find((s) => s.turnKey === turnKey) };
    } finally {
      this.undoing.delete(lockKey);
    }
  }

  /** Undos the agent has not been told about yet. */
  async untoldUndos(taskId: string): Promise<Array<{ turnKey: string; paths: string[] }>> {
    const lines = await this.read(taskId);
    const told = new Set(
      lines.filter((line): line is NotedLine => line.kind === "noted").map((line) => line.turnKey),
    );
    return lines
      .filter((line): line is UndoLine => line.kind === "undo" && !told.has(line.turnKey))
      .map((line) => ({ turnKey: line.turnKey, paths: line.paths }));
  }

  /** Mark undos as told, once the message carrying the note was accepted. */
  async markUndosTold(taskId: string, turnKeys: readonly string[]): Promise<void> {
    for (const turnKey of new Set(turnKeys)) {
      await this.append(taskId, { kind: "noted", at: this.now(), turnKey });
    }
  }

  /** Remove a task's record (its kept bytes expire on their own). */
  async forget(taskId: string): Promise<void> {
    await fs.rm(this.file(taskId), { force: true });
  }
}

let activeJournal: TurnChangeJournal | null = null;

/** Set by the daemon at start; file tools record through it when it is set. */
export function setActiveTurnChangeJournal(journal: TurnChangeJournal | null): void {
  activeJournal = journal;
}

export function getActiveTurnChangeJournal(): TurnChangeJournal | null {
  return activeJournal;
}

/**
 * Capture the given files before a tool changes them; call `commit` after the change (also when
 * it failed part way) to record what changed. Never throws: recording is best effort and must
 * not fail the tool.
 */
export async function watchFileChanges(
  taskId: string | undefined,
  filePaths: readonly string[],
): Promise<{ commit: () => Promise<void> }> {
  const journal = activeJournal;
  if (!journal || !taskId || !TASK_ID_PATTERN.test(taskId)) return { commit: async () => {} };
  const unique = [...new Set(filePaths.map((p) => path.resolve(p)))];
  const before = new Map<string, FileState>();
  for (const filePath of unique) {
    try {
      before.set(filePath, await journal.captureState(filePath));
    } catch {
      // Not recorded, so this file is never undone.
    }
  }
  return {
    commit: async () => {
      for (const [filePath, state] of before) {
        try {
          await journal.record(taskId, filePath, state, await journal.captureState(filePath));
        } catch {
          // Best effort.
        }
      }
    },
  };
}

/** Record a change whose bytes the caller already holds. Never throws. */
export async function recordFileBytesChange(
  taskId: string | undefined,
  filePath: string,
  before: Buffer | null,
  after: Buffer | null,
): Promise<void> {
  const journal = activeJournal;
  if (!journal || !taskId || !TASK_ID_PATTERN.test(taskId)) return;
  const at = journal.timestamp();
  try {
    await journal.record(
      taskId,
      filePath,
      await journal.stateOfBytes(before, filePath),
      await journal.stateOfBytes(after, filePath),
      at,
    );
  } catch {
    // Best effort.
  }
}
