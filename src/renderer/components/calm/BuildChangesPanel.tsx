import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileDiff, X } from "lucide-react";
import type { BuildFileChange } from "./build-changes";

const STATUS_MARK: Record<BuildFileChange["status"], string> = {
  created: "A",
  modified: "M",
  deleted: "D",
};

/**
 * Review pane for a build: every file the build changed, with the line diff of
 * each write and edit it made. Opens from the status strip's Changes button.
 */
export function BuildChangesPanel({
  changes,
  onClose,
  onOpenFile,
}: {
  changes: BuildFileChange[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(changes[0]?.path ?? null);
  const selected = useMemo(
    () => changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null,
    [changes, selectedPath],
  );
  const totals = useMemo(
    () =>
      changes.reduce(
        (sum, change) => ({
          added: sum.added + change.added,
          removed: sum.removed + change.removed,
        }),
        { added: 0, removed: 0 },
      ),
    [changes],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="build-changes-overlay" onMouseDown={onClose}>
      <section
        className="build-changes-panel"
        role="dialog"
        aria-label="Build changes"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="build-changes-head">
          <FileDiff size={15} aria-hidden="true" />
          <strong>Changes</strong>
          <span className="build-changes-summary">
            {changes.length} file{changes.length === 1 ? "" : "s"}
            <span className="diff-count-added">+{totals.added}</span>
            <span className="diff-count-removed">−{totals.removed}</span>
          </span>
          <button
            type="button"
            className="build-changes-close"
            onClick={onClose}
            aria-label="Close changes"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="build-changes-body">
          <nav className="build-changes-files" aria-label="Changed files">
            {changes.map((change) => (
              <button
                key={change.path}
                type="button"
                className={`build-changes-file${change === selected ? " selected" : ""}`}
                onClick={() => setSelectedPath(change.path)}
                title={change.path}
              >
                <span className={`build-changes-status status-${change.status}`}>
                  {STATUS_MARK[change.status]}
                </span>
                <span className="build-changes-file-name">{change.path}</span>
                <span className="build-changes-file-counts">
                  {change.added > 0 && <span className="diff-count-added">+{change.added}</span>}
                  {change.removed > 0 && (
                    <span className="diff-count-removed">−{change.removed}</span>
                  )}
                </span>
              </button>
            ))}
          </nav>

          <div className="build-changes-diff">
            {selected ? (
              <>
                <div className="build-changes-diff-head">
                  <span className="build-changes-diff-path">{selected.path}</span>
                  {selected.status !== "deleted" && (
                    <button type="button" onClick={() => onOpenFile(selected.path)}>
                      Open file
                    </button>
                  )}
                </div>
                {selected.hunks.length === 0 ? (
                  <p className="build-changes-empty">
                    {selected.status === "deleted"
                      ? "This file was deleted."
                      : "No line changes recorded for this file."}
                  </p>
                ) : (
                  selected.hunks.map((hunk, index) => (
                    <div className="build-changes-hunk" key={index}>
                      <div className="build-changes-hunk-label">
                        {hunk.kind === "write" ? "write" : "edit"} {index + 1} of{" "}
                        {selected.hunks.length}
                        {hunk.truncated && " · shown in part"}
                      </div>
                      <pre className="build-changes-lines">
                        {hunk.lines.map((line, lineIndex) => (
                          <div key={lineIndex} className={`diff-row diff-${line.kind}`}>
                            <span className="diff-gutter" aria-hidden="true">
                              {line.kind === "added"
                                ? "+"
                                : line.kind === "removed"
                                  ? "−"
                                  : line.kind === "fold"
                                    ? "⋯"
                                    : " "}
                            </span>
                            <code>{line.text || " "}</code>
                          </div>
                        ))}
                      </pre>
                    </div>
                  ))
                )}
              </>
            ) : (
              <p className="build-changes-empty">This build has not changed any files yet.</p>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
