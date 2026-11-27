import { useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  TURN_FILE_UNDO_BLOCK_TEXT,
  type TurnChangeSet,
  type TurnChangesUndoResult,
  type TurnFileChange,
} from "../../../shared/turn-changes";
import { FileChipIcon } from "../markdown-components";
import { useFileActionMenu } from "../FileActionMenu";
import type { TurnOutputFile } from "./turn-outputs";

const MAX_VISIBLE_FILES = 3;

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export function describeTurnOutputs(files: TurnOutputFile[]): string {
  const count = files.length;
  const noun = count === 1 ? "file" : "files";
  return files.every((file) => file.action === "updated")
    ? `Updated ${count} ${noun}`
    : `Created ${count} ${noun}`;
}

/** Lines added and removed across a turn's files, or null when none had counts. */
export function summarizeLineChanges(
  files: readonly TurnFileChange[],
): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const file of files) {
    if (typeof file.added !== "number" || typeof file.removed !== "number") continue;
    counted = true;
    added += file.added;
    removed += file.removed;
  }
  return counted ? { added, removed } : null;
}

/** Why a turn's changes cannot be undone, naming the first file in the way, or null. */
export function describeUndoBlock(changeSet: TurnChangeSet): string | null {
  if (changeSet.undoneAt) return "Already undone";
  const blocked = changeSet.files.filter((file) => file.blocked);
  if (blocked.length === 0) return null;
  const first = blocked[0];
  const more = blocked.length > 1 ? ` (and ${blocked.length - 1} more)` : "";
  return `Can't undo: ${getFileName(first.displayPath)} ${TURN_FILE_UNDO_BLOCK_TEXT[first.blocked!]}${more}`;
}

const KIND_TEXT: Record<TurnFileChange["kind"], string> = {
  created: "new",
  modified: "changed",
  deleted: "deleted",
};

/**
 * Confirm before putting a turn's files back: lists each file with what happens to it.
 */
function TurnUndoConfirm({
  changeSet,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  changeSet: TurnChangeSet;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="turn-undo-confirm" role="group" aria-label="Undo this turn's file changes">
      <div className="turn-undo-confirm-title">
        Put {changeSet.files.length === 1 ? "this file" : `these ${changeSet.files.length} files`}{" "}
        back as they were before this turn?
      </div>
      <ul className="turn-undo-files">
        {changeSet.files.map((file) => (
          <li key={file.path} className="turn-undo-file" title={file.path}>
            <span className="turn-undo-file-name">{file.displayPath}</span>
            <span className="turn-undo-file-meta">
              {file.kind === "created" ? "moves to the Trash" : KIND_TEXT[file.kind]}
              {typeof file.added === "number" && typeof file.removed === "number"
                ? ` · +${file.added} −${file.removed}`
                : ""}
              {file.blocked ? ` · ${TURN_FILE_UNDO_BLOCK_TEXT[file.blocked]}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="turn-undo-confirm-note">
        Changes made by commands or other apps are not undone.
      </div>
      {error && (
        <div className="turn-undo-confirm-error" role="alert">
          {error}
        </div>
      )}
      <div className="turn-undo-confirm-actions">
        <button
          type="button"
          className="turn-undo-confirm-primary"
          onClick={onConfirm}
          disabled={busy || !changeSet.canUndo}
        >
          {busy ? "Undoing…" : "Undo changes"}
        </button>
        <button
          type="button"
          className="turn-undo-confirm-cancel"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The single end-of-turn line listing the files a turn wrote. Each file opens in the side
 * panel (right-click for other apps or Finder); "View all" opens the Files list.
 */
export function TurnOutputsRow({
  files,
  workspacePath,
  onOpenFile,
  onViewAll,
  changeSet,
  onUndo,
}: {
  files: TurnOutputFile[];
  workspacePath: string;
  onOpenFile: (path: string) => void;
  onViewAll?: (primaryPath: string) => void;
  /** What the turn changed through the file tools, when recorded; enables Undo. */
  changeSet?: TurnChangeSet;
  onUndo?: () => Promise<TurnChangesUndoResult>;
}) {
  const { openFileActionMenu, menu } = useFileActionMenu({
    workspacePath,
    onOpenInPanel: onOpenFile,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (files.length === 0) return null;
  const lineChanges = changeSet ? summarizeLineChanges(changeSet.files) : null;
  const undoBlock = changeSet ? describeUndoBlock(changeSet) : null;
  const confirmUndo = async () => {
    if (!onUndo) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onUndo();
      if (result.ok) setConfirming(false);
      else setError(result.error || "These changes could not be undone.");
    } finally {
      setBusy(false);
    }
  };
  const visibleFiles = files.slice(0, MAX_VISIBLE_FILES);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className="turn-outputs" role="group" aria-label="Files from this turn">
      <span className="turn-outputs-label">{describeTurnOutputs(files)}</span>
      <span className="turn-outputs-files">
        {visibleFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            className="turn-outputs-file"
            onClick={() => onOpenFile(file.path)}
            onContextMenu={(event) => openFileActionMenu(event, file.path)}
            title={`${file.path}\n\nClick to open - Right-click for more options`}
          >
            <FileChipIcon filePath={file.path} />
            <span className="turn-outputs-file-name">{getFileName(file.path)}</span>
          </button>
        ))}
        {hiddenCount > 0 && <span className="turn-outputs-more">+{hiddenCount} more</span>}
      </span>
      {lineChanges && (
        <span className="turn-outputs-lines" aria-label="Lines added and removed">
          <span className="turn-outputs-lines-added">+{lineChanges.added}</span>{" "}
          <span className="turn-outputs-lines-removed">−{lineChanges.removed}</span>
        </span>
      )}
      {onViewAll && (
        <button
          type="button"
          className="turn-outputs-view-all"
          onClick={() => onViewAll(files[0].path)}
        >
          View all
        </button>
      )}
      {changeSet?.undoneAt ? (
        <span className="turn-outputs-undone">Undone</span>
      ) : changeSet && onUndo ? (
        <button
          type="button"
          className="turn-outputs-undo"
          aria-expanded={confirming}
          title={undoBlock ?? "Put the files this turn changed back as they were"}
          onClick={() => {
            setError(null);
            setConfirming((open) => !open);
          }}
        >
          <RotateCcw size={12} aria-hidden="true" />
          Undo
        </button>
      ) : null}
      {confirming && changeSet && !changeSet.undoneAt && (
        <TurnUndoConfirm
          changeSet={changeSet}
          busy={busy}
          error={error ?? undoBlock}
          onConfirm={() => void confirmUndo()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {menu}
    </div>
  );
}
