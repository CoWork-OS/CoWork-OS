import { ClickableFilePath } from "../MainContent/timeline-event-rendering";
import type { FileChangeKind, FileChangeSummary } from "./file-change-row";

const VERBS: Record<FileChangeKind, { done: string; pending: string }> = {
  created: { done: "Created", pending: "Creating" },
  edited: { done: "Edited", pending: "Editing" },
  deleted: { done: "Deleted", pending: "Deleting" },
};

interface FileChangeTitleProps {
  change: FileChangeSummary;
  /** The tool call has not returned yet. */
  pending?: boolean;
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
}

/** One-line file row: "Created report.md +54 −0 ●", with a marker on new and deleted files. */
export function FileChangeTitle({
  change,
  pending = false,
  workspacePath,
  onOpenViewer,
}: FileChangeTitleProps) {
  const verb = pending ? VERBS[change.kind].pending : VERBS[change.kind].done;
  const fileName = change.path.split("/").pop() || change.path;
  const showStats = !pending && change.added !== null && change.removed !== null;
  return (
    <span className={`file-change-title kind-${change.kind} ${pending ? "pending" : ""}`}>
      <span className="file-change-verb">{verb}</span>
      {change.kind === "deleted" ? (
        <span className="file-change-name" title={change.path}>
          {fileName}
        </span>
      ) : (
        <ClickableFilePath
          path={change.path}
          workspacePath={workspacePath}
          onOpenViewer={onOpenViewer}
          className="file-change-name"
        />
      )}
      {showStats ? (
        <span
          className="file-change-stats"
          aria-label={`${change.added} lines added, ${change.removed} lines removed`}
        >
          <span className="file-change-added">+{change.added}</span>
          <span className="file-change-removed">−{change.removed}</span>
        </span>
      ) : null}
      {!pending && change.kind !== "edited" ? (
        <span
          className="file-change-marker"
          role="img"
          aria-label={change.kind === "created" ? "New file" : "Deleted file"}
          title={change.kind === "created" ? "New file" : "Deleted file"}
        />
      ) : null}
    </span>
  );
}
