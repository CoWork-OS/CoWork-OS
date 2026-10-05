import type { MemoryRepoHubEntry, MemoryRepoHubFile } from "../../../shared/memory-repo-types";
import { KIND_LABELS } from "./memory-knowledge-model";
import { folderFileHint } from "./memory-folder-model";
import type { MemoryHubKind } from "../../../shared/memory-hub-types";

export interface MemoryFolderKnowledgeProps {
  /** The files to show (already filtered), inbox excluded. */
  files: MemoryRepoHubFile[];
  /** `inbox.md` (filtered), shown apart as "Unreviewed". */
  inbox: MemoryRepoHubFile | null;
  editing: { ref: string; draft: string } | null;
  busyRef: string | null;
  canWrite: boolean;
  canDelete: boolean;
  canOpenFile: boolean;
  onStartEdit: (entry: MemoryRepoHubEntry) => void;
  onEditDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onPin: (entry: MemoryRepoHubEntry) => void;
  onDelete: (entry: MemoryRepoHubEntry) => void;
  onOpenFile: (path: string) => void;
  /** Open the task an entry was learned in (absent: the task is shown, not linked). */
  onOpenTask?: (taskId: string) => void;
}

function kindLabel(kind: string | null): string | null {
  if (!kind || kind === "identity" || kind === "preference") return null;
  return KIND_LABELS[kind as MemoryHubKind] ?? null;
}

function FolderEntryRow({
  entry,
  file,
  props,
}: {
  entry: MemoryRepoHubEntry;
  file: MemoryRepoHubFile;
  props: MemoryFolderKnowledgeProps;
}) {
  const editing = props.editing?.ref === entry.ref ? props.editing : null;
  const busy = props.busyRef === entry.ref;
  const kind = kindLabel(entry.kind);
  return (
    <li className="memory-knowledge-item" data-entry-ref={entry.ref}>
      {editing ? (
        <div className="memory-knowledge-edit">
          <textarea
            className="settings-input"
            aria-label="Edit memory"
            value={editing.draft}
            maxLength={1000}
            onChange={(event) => props.onEditDraftChange(event.target.value)}
            disabled={busy}
          />
          <div className="memory-knowledge-actions">
            <button
              type="button"
              className="settings-button"
              onClick={props.onSaveEdit}
              disabled={busy || !editing.draft.trim()}
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              className="memory-inline-btn"
              onClick={props.onCancelEdit}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="memory-knowledge-content">{entry.text}</div>
      )}
      <div className="memory-knowledge-meta">
        <span
          className={`settings-badge settings-badge--${entry.by === "user" ? "success" : "neutral"}`}
        >
          {entry.by === "user" ? "By you" : "By CoWork"}
        </span>
        {entry.source === "import" && (
          <span className="settings-badge settings-badge--outline">Imported</span>
        )}
        {kind && <span className="memory-knowledge-kind">{kind}</span>}
        {entry.added && <span>Added {entry.added}</span>}
        {entry.taskId &&
          (props.onOpenTask ? (
            <button
              type="button"
              className="memory-inline-btn"
              onClick={() => props.onOpenTask?.(entry.taskId as string)}
            >
              Source task
            </button>
          ) : (
            <span>From a task</span>
          ))}
      </div>
      {!editing && (
        <div className="memory-knowledge-actions">
          {file.role !== "entry" && (
            <button
              type="button"
              className="memory-inline-btn"
              onClick={() => props.onPin(entry)}
              disabled={busy || !props.canWrite}
              title="Keep it in every prompt (moves it to MEMORY.md)"
            >
              {file.role === "inbox" ? "Keep and pin" : "Pin"}
            </button>
          )}
          <button
            type="button"
            className="memory-inline-btn"
            onClick={() => props.onStartEdit(entry)}
            disabled={busy || !props.canWrite}
          >
            Edit
          </button>
          <button
            type="button"
            className="memory-inline-btn danger"
            onClick={() => props.onDelete(entry)}
            disabled={busy || !props.canDelete}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

function FolderFileSection({
  file,
  props,
}: {
  file: MemoryRepoHubFile;
  props: MemoryFolderKnowledgeProps;
}) {
  return (
    <>
      <h4>
        {file.title} <span className="memory-knowledge-count">{file.entries.length}</span>
        <span className="memory-knowledge-file-path">
          {file.path} · {folderFileHint(file)}
        </span>
        {props.canOpenFile && (
          <button
            type="button"
            className="memory-inline-btn"
            onClick={() => props.onOpenFile(file.path)}
          >
            Open file
          </button>
        )}
      </h4>
      <ul className="memory-knowledge-list">
        {file.entries.map((entry) => (
          <FolderEntryRow key={entry.ref} entry={entry} file={file} props={props} />
        ))}
      </ul>
      {file.truncated && (
        <p className="settings-form-hint">More entries are in the file; open it to see them all.</p>
      )}
    </>
  );
}

/** The memory folder part of "What CoWork knows": one section per file, the inbox apart. */
export function MemoryFolderKnowledge(props: MemoryFolderKnowledgeProps) {
  return (
    <div className="memory-folder-knowledge" data-section="memory-folder">
      {props.files.map((file) => (
        <section
          key={file.path}
          className="memory-knowledge-group"
          aria-label={file.title}
          data-file={file.path}
        >
          <FolderFileSection file={file} props={props} />
        </section>
      ))}
      {props.inbox && props.inbox.entries.length > 0 && (
        <details
          className="memory-knowledge-group memory-knowledge-others"
          data-file={props.inbox.path}
          data-group="unreviewed"
        >
          <summary>
            Unreviewed <span className="memory-knowledge-count">{props.inbox.entries.length}</span>
          </summary>
          <p className="settings-form-hint">
            Saved by CoWork after reading untrusted content. Not used in replies until you keep
            it with "Keep and pin".
          </p>
          <FolderFileSection file={props.inbox} props={props} />
        </details>
      )}
    </div>
  );
}
