import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DocumentEditSelection,
  DocumentEditorSession,
  DocxBlockSelection,
  PdfRegionSelection,
  Task,
  TaskEvent,
} from "../../shared/types";
import { DOCXDocumentSurface } from "./DOCXDocumentSurface";
import { PDFDocumentSurface } from "./PDFDocumentSurface";

type DocumentEditorModalProps = {
  filePath: string;
  workspacePath?: string;
  onClose: () => void;
};

type TaskFeedItem = {
  text: string;
  kind: "log" | "tool" | "output" | "status";
};

function summarizeTaskEvent(event: TaskEvent): TaskFeedItem | null {
  if (event.type === "log") {
    const msg = String((event.payload as Any)?.message || "").trim();
    if (!msg) return null;
    return { text: msg, kind: "log" };
  }
  if (event.type === "tool_call") {
    const tool = String((event.payload as Any)?.tool || "unknown");
    return { text: `Using ${tool}`, kind: "tool" };
  }
  if (event.type === "file_created" || event.type === "artifact_created") {
    const path = String((event.payload as Any)?.path || "");
    const name = path.split("/").pop() || path;
    return { text: `Created ${name}`, kind: "output" };
  }
  if (event.type === "task_status") {
    const status = String((event.payload as Any)?.status || "");
    if (!status) return null;
    const label: Record<string, string> = {
      running: "Task started",
      completed: "Edit applied successfully",
      failed: "Edit failed",
      cancelled: "Task cancelled",
    };
    return { text: label[status] ?? `Status: ${status}`, kind: "status" };
  }
  return null;
}

function isPdfSelection(selection: DocumentEditSelection | null): selection is PdfRegionSelection {
  return selection?.kind === "pdf";
}

function isDocxSelection(selection: DocumentEditSelection | null): selection is DocxBlockSelection {
  return selection?.kind === "docx";
}

export function DocumentEditorModal({
  filePath,
  workspacePath,
  onClose,
}: DocumentEditorModalProps) {
  const [session, setSession] = useState<DocumentEditorSession | null>(null);
  const [selection, setSelection] = useState<DocumentEditSelection | null>(null);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const taskFeedRef = useRef<HTMLDivElement | null>(null);
  const taskWatchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskWatchPathRef = useRef<string | null>(null);

  const loadSession = async (targetPath = filePath) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.openDocumentEditorSession({
        filePath: targetPath,
        workspacePath,
      });
      setSession(result);
      setSelection(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Failed to open document editor");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
  }, [filePath, workspacePath]);

  useEffect(() => {
    if (!activeTask?.id || !window.electronAPI?.onTaskEvent) return;
    const unsubscribe = window.electronAPI.onTaskEvent(async (event: TaskEvent) => {
      if (event.taskId !== activeTask.id) return;
      setTaskEvents((prev) => [...prev, event]);
      if (
        event.type === "task_status" &&
        ["completed", "failed", "cancelled"].includes(String((event.payload as Any)?.status || ""))
      ) {
        const latestTask = await window.electronAPI.getTask(activeTask.id);
        setActiveTask(latestTask as Task);
        if ((latestTask as Task)?.status === "completed") {
          await loadSession(session?.currentPath || filePath);
        }
      }
    });
    return unsubscribe;
  }, [activeTask?.id, filePath, session?.currentPath]);

  useEffect(() => {
    const stopWatching = () => {
      if (taskWatchTimerRef.current) {
        clearInterval(taskWatchTimerRef.current);
        taskWatchTimerRef.current = null;
      }
    };

    if (!activeTask?.id || !window.electronAPI?.getTask) {
      stopWatching();
      return stopWatching;
    }

    const watchPath = taskWatchPathRef.current || session?.currentPath || filePath;
    let settled = false;

    const pollTask = async () => {
      if (settled) return;
      try {
        const latestTask = (await window.electronAPI.getTask(activeTask.id)) as Task | null;
        if (!latestTask) return;
        setActiveTask(latestTask);
        if (["completed", "failed", "cancelled"].includes(latestTask.status)) {
          settled = true;
          stopWatching();
          if (latestTask.status === "completed") {
            await loadSession(watchPath);
          }
        }
      } catch {
        // Keep polling; task status may not be visible yet.
      }
    };

    void pollTask();
    taskWatchTimerRef.current = setInterval(() => {
      void pollTask();
    }, 500);

    return () => {
      stopWatching();
    };
  }, [activeTask?.id, filePath, session?.currentPath]);

  const taskFeed = useMemo(
    () =>
      taskEvents
        .map((event) => summarizeTaskEvent(event))
        .filter((value): value is TaskFeedItem => Boolean(value))
        .slice(-20),
    [taskEvents],
  );

  useEffect(() => {
    const el = taskFeedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [taskFeed]);

  const canSubmit =
    session !== null &&
    selection !== null &&
    instruction.trim().length > 0 &&
    ((isPdfSelection(selection) && selection.w > 0 && selection.h > 0) ||
      (isDocxSelection(selection) && selection.blockIds.length > 0));

  const handleSubmit = async () => {
    if (!session || !selection || !instruction.trim()) return;
    setSubmitting(true);
    setError(null);
    setTaskEvents([]);
    try {
      taskWatchPathRef.current = session.currentPath;
      const task = (await window.electronAPI.startDocumentEditTask({
        sessionId: session.sessionId,
        selection,
        instruction: instruction.trim(),
      })) as Task;
      setActiveTask(task);
      setInstruction("");
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Failed to start edit task");
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="file-viewer-overlay" onClick={onClose}>
      <div className="document-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="document-editor-header">
          <div>
            <div className="document-editor-title">{session?.currentFileName || "Document editor"}</div>
            <div className="document-editor-subtitle">
              {session?.fileType === "pdf"
                ? "Drag a region on the page and describe the change."
                : "Drag across blocks to select a section and describe the change."}
            </div>
          </div>
          <div className="document-editor-header-actions">
            <button
              className="file-viewer-action-btn"
              onClick={() => void window.electronAPI.openFile(session?.currentPath || filePath, workspacePath)}
              title="Open in external app"
            >
              Open
            </button>
            <button className="file-viewer-action-btn file-viewer-close-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="document-editor-body">
          <div className="document-editor-main">
            {loading ? (
              <div className="document-editor-empty">Loading document…</div>
            ) : error ? (
              <div className="document-editor-error">{error}</div>
            ) : session?.fileType === "pdf" && session.pdfDataBase64 ? (
              <PDFDocumentSurface
                fileName={session.currentFileName}
                pdfDataBase64={session.pdfDataBase64}
                selection={isPdfSelection(selection) ? selection : null}
                onSelectionChange={setSelection}
              />
            ) : session?.fileType === "docx" ? (
              <DOCXDocumentSurface
                blocks={session.docxBlocks || []}
                selection={isDocxSelection(selection) ? selection : null}
                onSelectionChange={setSelection}
              />
            ) : (
              <div className="document-editor-empty">This document is not editable inline.</div>
            )}
          </div>

          <aside className="document-editor-sidebar">
            <div className="document-editor-panel">
              <div className="document-editor-panel-title">Versions</div>
              <div className="document-editor-versions">
                {(session?.versions || []).map((version) => (
                  <button
                    key={version.path}
                    type="button"
                    className={`document-editor-version-btn ${version.isCurrent ? "active" : ""}`}
                    onClick={() => void loadSession(version.path)}
                  >
                    <span>{version.fileName}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="document-editor-panel">
              <div className="document-editor-panel-title">Selection</div>
              <div className="document-editor-selection-copy">
                {selection?.excerpt || "Select a PDF region or DOCX blocks to begin."}
              </div>
            </div>

            {session?.fileType === "pdf" && session.pdfReviewSummary && (
              <div className="document-editor-panel">
                <div className="document-editor-panel-title">PDF review</div>
                <div className="document-editor-pdf-stats">
                  <div>
                    <span>Pages</span>
                    <strong>{session.pdfReviewSummary.pageCount}</strong>
                  </div>
                  <div>
                    <span>Native</span>
                    <strong>{session.pdfReviewSummary.nativeTextPages}</strong>
                  </div>
                  <div>
                    <span>OCR</span>
                    <strong>{session.pdfReviewSummary.ocrPages}</strong>
                  </div>
                </div>
                <div className="document-editor-pdf-pages">
                  {session.pdfReviewSummary.pages.slice(0, 4).map((page) => (
                    <div key={page.pageIndex} className="document-editor-pdf-page">
                      <div className="document-editor-pdf-page-label">
                        Page {page.pageIndex + 1}
                        {page.usedOcr ? " • OCR" : ""}
                        {page.truncated ? " • clipped" : ""}
                      </div>
                      <div className="document-editor-pdf-page-text">{page.text}</div>
                    </div>
                  ))}
                </div>
                {session.pdfReviewSummary.truncatedPages && (
                  <div className="document-editor-pdf-note">
                    Preview limited to the first extracted pages.
                  </div>
                )}
              </div>
            )}

            <div className="document-editor-panel">
              <div className="document-editor-panel-title">Describe the change</div>
              <textarea
                className="document-editor-textarea"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Turn this section into a chart, rewrite the paragraph, tighten the language, update the title..."
              />
              <button
                type="button"
                className="document-editor-submit"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit || submitting}
              >
                {submitting ? "Starting edit…" : "Apply edit"}
              </button>
            </div>

            <div className="document-editor-panel">
              <div className="document-editor-panel-title">Task timeline</div>
              {activeTask ? (
                <>
                  <div className="document-editor-task-header">
                    <span className="document-editor-task-name">{activeTask.title}</span>
                    <span className={`document-editor-task-badge document-editor-task-badge--${activeTask.status}`}>
                      {(activeTask.status === "executing" || activeTask.status === "planning") && (
                        <span className="document-editor-spinner" />
                      )}
                      {activeTask.status}
                    </span>
                  </div>
                  <div className="document-editor-task-feed" ref={taskFeedRef}>
                    {taskFeed.length === 0 ? (
                      <div className="document-editor-task-item document-editor-task-item--status">
                        Waiting for updates…
                      </div>
                    ) : (
                      taskFeed.map((item, index) => (
                        <div
                          key={`${item.text}-${index}`}
                          className={`document-editor-task-item document-editor-task-item--${item.kind}`}
                        >
                          <span className="document-editor-task-item-dot" />
                          <span>{item.text}</span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="document-editor-task-empty">No edit task started yet.</div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
