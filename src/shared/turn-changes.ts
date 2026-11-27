/**
 * The files one conversation turn changed through CoWork's file tools, and undoing them.
 * Recorded in the main process (`src/electron/turn-changes/`); shown at the end of each turn.
 */

/** The opener of a task's first turn, which is the task prompt, not a user message. */
export const FIRST_TURN_KEY = "first-turn";

export type TurnFileChangeKind = "created" | "modified" | "deleted";

/** Why a file in a turn cannot be put back. */
export type TurnFileUndoBlock =
  | "changed_since" // the file is not as the turn left it
  | "not_kept" // the earlier copy was too large to keep, or has expired
  | "secret" // a key or .env file, whose contents are never copied
  | "outside_workspace" // only files in the task's workspace are put back
  | "protected"; // never written by undo

export interface TurnFileChange {
  /** Absolute path. */
  path: string;
  /** Path relative to the workspace when inside it. */
  displayPath: string;
  kind: TurnFileChangeKind;
  /** Lines added and removed, for text files whose two versions are kept. */
  added?: number;
  removed?: number;
  /** Set when this file cannot be put back. */
  blocked?: TurnFileUndoBlock;
}

export interface TurnChangeSet {
  /** The id of the user message that opened the turn, or FIRST_TURN_KEY. */
  turnKey: string;
  files: TurnFileChange[];
  /** When the turn's changes were undone. */
  undoneAt?: number;
  /** True when every file can be put back and the turn has not been undone. */
  canUndo: boolean;
}

export interface TurnChangesUndoResult {
  ok: boolean;
  /** Files put back (restored, removed or recreated). */
  restored: string[];
  error?: string;
  /** The turn as it stands after the attempt. */
  changeSet?: TurnChangeSet;
}

/** Reads after a file name: "a.ts was changed after this turn". */
export const TURN_FILE_UNDO_BLOCK_TEXT: Record<TurnFileUndoBlock, string> = {
  changed_since: "was changed after this turn",
  not_kept: "was too large to keep a copy of",
  secret: "may hold secrets, so no copy was kept",
  outside_workspace: "is outside the workspace",
  protected: "is in a protected folder",
};
