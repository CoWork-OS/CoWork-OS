import { useState } from "react";
import type { MouseEvent } from "react";

/**
 * Undo for the change the agent made at a place the user pointed to: restores the revision the
 * user pointed at. The main process refuses when the file changed again since.
 */
export function AnnotationUndoButton({
  annotationId,
  undoToken,
}: {
  annotationId: string;
  undoToken: string;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [error, setError] = useState("");
  if (typeof window === "undefined" || !window.electronAPI?.undoAnnotationChange) return null;
  if (state === "done") return <span className="annotation-undo-status">Undone</span>;

  const undo = async (event: MouseEvent) => {
    event.stopPropagation();
    setState("working");
    setError("");
    try {
      const result = await window.electronAPI.undoAnnotationChange(annotationId, undoToken);
      if (result.ok) {
        setState("done");
      } else {
        setState("failed");
        setError(result.error || "This change could not be undone.");
      }
    } catch (caught) {
      setState("failed");
      setError(caught instanceof Error ? caught.message : "This change could not be undone.");
    }
  };

  return (
    <>
      <button
        type="button"
        className="annotation-undo-btn"
        onClick={(event) => void undo(event)}
        disabled={state === "working"}
      >
        {state === "working" ? "Undoing…" : "Undo"}
      </button>
      {state === "failed" && error && (
        <span className="annotation-undo-error" role="status">
          {error}
        </span>
      )}
    </>
  );
}
