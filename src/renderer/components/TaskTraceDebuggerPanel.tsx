import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./task-trace-debugger.css";
import ReactMarkdown, { type Components } from "react-markdown";
import { Copy, ExternalLink, RefreshCw, Search } from "lucide-react";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type {
  ListTaskTraceRunsRequest,
  TaskTraceRunDetail,
  TaskTraceRunSummary,
  TaskTraceRow,
  TaskTraceRowActor,
  TaskTraceTab,
  Workspace,
} from "../../shared/types";
import {
  buildTaskTraceDebugRows,
  buildTaskTraceTranscriptRows,
  filterTaskTraceRows,
  serializeTaskTraceRows,
  normalizeTaskTraceMarkdownDisplay,
} from "../utils/task-trace-debugger";
import { createRendererLogger } from "../utils/logger";

interface TaskTraceDebuggerPanelProps {
  workspaceId?: string;
  onOpenTask?: (taskId: string) => void;
}

const ALL_WORKSPACES = "__all__";
const STATUS_OPTIONS = [
  "all",
  "pending",
  "executing",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
] as const;
const ACTOR_FILTERS: Array<{ value: TaskTraceRowActor | "all"; label: string }> = [
  { value: "all", label: "All events" },
  { value: "user", label: "User" },
  { value: "agent", label: "Agent" },
  { value: "tool", label: "Tool" },
  { value: "model", label: "Model" },
  { value: "result", label: "Result" },
  { value: "system", label: "System" },
];
const markdownPlugins = [remarkGfm, remarkBreaks];
const logger = createRendererLogger("TaskTraceDebugger");
const inlineMarkdownComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
};

function MarkdownInline({ text }: { text: string }) {
  return (
    <div className="task-trace-markdown-inline">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={inlineMarkdownComponents}>
        {normalizeTaskTraceMarkdownDisplay(text)}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="markdown-content task-trace-markdown-block">
      <ReactMarkdown remarkPlugins={markdownPlugins}>
        {normalizeTaskTraceMarkdownDisplay(text)}
      </ReactMarkdown>
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatMetricNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatRuntime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function shortenSessionId(sessionId: string): string {
  return sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId;
}

function rowToneClass(row: TaskTraceRow): string {
  const actor = row.actor;
  const status = row.status || "";
  if (/failed|blocked|cancelled|error/i.test(status)) return "error";
  if (/completed|success/i.test(status)) return "success";
  if (/running|progress/i.test(status)) return "active";
  return actor;
}

function isTaskActive(status: string | undefined): boolean {
  return status === "pending" || status === "executing" || status === "interrupted";
}

export function TaskTraceDebuggerPanel({
  workspaceId: initialWorkspaceId,
  onOpenTask,
}: TaskTraceDebuggerPanelProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    initialWorkspaceId || ALL_WORKSPACES,
  );
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_OPTIONS)[number]>("all");
  const [runSearch, setRunSearch] = useState("");
  const [actorFilter, setActorFilter] = useState<TaskTraceRowActor | "all">("all");
  const [rowSearch, setRowSearch] = useState("");
  const [activeTab, setActiveTab] = useState<TaskTraceTab>("transcript");
  const [runs, setRuns] = useState<TaskTraceRunSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskTraceRunDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Partial<Record<TaskTraceTab, string>>>({});
  const [copied, setCopied] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const reloadTimerRef = useRef<number | null>(null);

  const deferredRunSearch = useDeferredValue(runSearch);
  const deferredRowSearch = useDeferredValue(rowSearch);

  const workspaceMap = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  const loadWorkspaces = useCallback(async () => {
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      startTransition(() => {
        setWorkspaces(loaded || []);
      });
    } catch (loadError) {
      logger.error("Failed to load workspaces for trace debugger:", loadError);
    }
  }, []);

  const loadRuns = useCallback(
    async (nextSelectedTaskId?: string | null) => {
      setListLoading(true);
      setError(null);
      try {
        const request: ListTaskTraceRunsRequest = {
          ...(selectedWorkspaceId !== ALL_WORKSPACES ? { workspaceId: selectedWorkspaceId } : {}),
          ...(statusFilter !== "all" ? { status: statusFilter } : {}),
          ...(deferredRunSearch.trim() ? { query: deferredRunSearch.trim() } : {}),
          limit: 80,
        };
        const loadedRuns = await window.electronAPI.listTaskTraceRuns(request);
        startTransition(() => {
          setRuns(loadedRuns || []);
          setSelectedTaskId((previous) => {
            const desired = nextSelectedTaskId ?? previous;
            if (desired && loadedRuns.some((item) => item.taskId === desired)) return desired;
            return loadedRuns[0]?.taskId || null;
          });
        });
      } catch (loadError) {
        logger.error("Failed to load task trace runs:", loadError);
        setError(loadError instanceof Error ? loadError.message : "Failed to load trace runs.");
        setRuns([]);
        setSelectedTaskId(null);
      } finally {
        setListLoading(false);
      }
    },
    [deferredRunSearch, selectedWorkspaceId, statusFilter],
  );

  const loadDetail = useCallback(async (taskId: string | null) => {
    if (!taskId) {
      setDetail(null);
      return;
    }

    setDetailLoading(true);
    setError(null);
    try {
      const loadedDetail = await window.electronAPI.getTaskTraceRun(taskId);
      startTransition(() => {
        setDetail(loadedDetail || null);
      });
    } catch (loadError) {
      logger.error("Failed to load task trace detail:", loadError);
      setError(loadError instanceof Error ? loadError.message : "Failed to load trace detail.");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    void loadDetail(selectedTaskId);
  }, [loadDetail, selectedTaskId]);

  const transcriptRows = useMemo(
    () =>
      detail
        ? buildTaskTraceTranscriptRows(detail.semanticTimeline || [], detail.rawEvents || [])
        : [],
    [detail],
  );
  const debugRows = useMemo(
    () => (detail ? buildTaskTraceDebugRows(detail.rawEvents || []) : []),
    [detail],
  );
  const currentRows = activeTab === "transcript" ? transcriptRows : debugRows;
  const visibleRows = useMemo(
    () => filterTaskTraceRows(currentRows, actorFilter, deferredRowSearch),
    [actorFilter, currentRows, deferredRowSearch],
  );

  useEffect(() => {
    if (visibleRows.length === 0) return;
    const selectedRowId = selectedRowIds[activeTab];
    if (selectedRowId && visibleRows.some((row) => row.id === selectedRowId)) return;
    setSelectedRowIds((previous) => ({ ...previous, [activeTab]: visibleRows[0]?.id }));
  }, [activeTab, selectedRowIds, visibleRows]);

  const selectedRow = useMemo(
    () => visibleRows.find((row) => row.id === selectedRowIds[activeTab]) || visibleRows[0] || null,
    [activeTab, selectedRowIds, visibleRows],
  );

  useEffect(() => {
    const targetId = selectedRow?.id;
    if (!targetId) return;
    const rowElement = rowRefs.current.get(targetId);
    if (!rowElement) return;
    rowElement.scrollIntoView({ block: "nearest" });
  }, [selectedRow?.id]);

  useEffect(() => {
    if (!detail || !isTaskActive(detail.task.status)) return;

    const unsubscribe = window.electronAPI.onTaskEvent((event) => {
      if (event?.taskId !== detail.task.id) return;
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        void loadDetail(detail.task.id);
        void loadRuns(detail.task.id);
      }, 300);
    });

    return () => {
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [detail, loadDetail, loadRuns]);

  const handleCopyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(serializeTaskTraceRows(visibleRows, activeTab));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (copyError) {
      logger.error("Failed to copy trace rows:", copyError);
      setError("Clipboard access failed while copying trace output.");
    }
  }, [activeTab, visibleRows]);

  return (
    <div className="task-trace-debugger">
      <div className="task-trace-debugger-toolbar">
        <div className="task-trace-debugger-toolbar-group task-trace-debugger-toolbar-group-wide">
          <label className="task-trace-debugger-search">
            <Search size={14} />
            <input
              type="search"
              placeholder="Search sessions, task titles, session ids"
              value={runSearch}
              onChange={(event) => setRunSearch(event.target.value)}
            />
          </label>
          <select
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
          >
            <option value={ALL_WORKSPACES}>All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as (typeof STATUS_OPTIONS)[number])
            }
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : status.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="task-trace-debugger-toolbar-group">
          <button
            type="button"
            className="task-trace-action-btn"
            onClick={() => void loadRuns(selectedTaskId)}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      <div className="task-trace-debugger-body">
        <aside className="task-trace-debugger-runs">
          <div className="task-trace-pane-header">
            <h3>Runs</h3>
            <span>{listLoading ? "Loading…" : `${runs.length} sessions`}</span>
          </div>
          <div className="task-trace-run-list">
            {runs.map((run) => {
              const workspace = workspaceMap.get(run.workspaceId);
              const isSelected = run.taskId === selectedTaskId;
              return (
                <button
                  key={run.sessionId}
                  type="button"
                  className={`task-trace-run-card ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedTaskId(run.taskId)}
                >
                  <div className="task-trace-run-card-top">
                    <span className={`task-trace-run-status status-${run.status}`}>
                      {run.status.replace(/_/g, " ")}
                    </span>
                    <span className="task-trace-run-updated">
                      {formatRelativeTime(run.updatedAt)}
                    </span>
                  </div>
                  <div className="task-trace-run-title">{run.title}</div>
                  <div className="task-trace-run-meta">
                    <span>{shortenSessionId(run.sessionId)}</span>
                    <span>
                      {run.runCount} run{run.runCount === 1 ? "" : "s"}
                    </span>
                    {workspace && <span>{workspace.name}</span>}
                  </div>
                </button>
              );
            })}
            {!listLoading && runs.length === 0 && (
              <div className="task-trace-empty">No task traces match the current filters.</div>
            )}
          </div>
        </aside>

        <section className="task-trace-debugger-main">
          {detail ? (
            <>
              <div className="task-trace-session-header">
                <div className="task-trace-session-header-top">
                  <div className="task-trace-breadcrumb">
                    <span>Sessions</span>
                    <span>/</span>
                    <span>{shortenSessionId(detail.sessionId)}</span>
                  </div>
                  <div className="task-trace-session-actions">
                    <button type="button" className="task-trace-action-btn" onClick={handleCopyAll}>
                      <Copy size={14} />
                      {copied ? "Copied" : "Copy all"}
                    </button>
                    <button
                      type="button"
                      className="task-trace-action-btn"
                      onClick={() => onOpenTask?.(detail.task.id)}
                    >
                      <ExternalLink size={14} />
                      Open task
                    </button>
                  </div>
                </div>
                <div className="task-trace-session-title-row">
                  <h2>{detail.task.title}</h2>
                  <span className={`task-trace-run-status status-${detail.task.status}`}>
                    {detail.task.status.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="task-trace-run-switcher">
                  {detail.siblingRuns.map((run) => (
                    <button
                      key={run.taskId}
                      type="button"
                      className={`task-trace-run-chip ${run.taskId === detail.task.id ? "active" : ""}`}
                      onClick={() => setSelectedTaskId(run.taskId)}
                    >
                      <span>
                        {run.continuationWindow ? `Run ${run.continuationWindow}` : "Run"}
                      </span>
                      {run.branchLabel && <span>{run.branchLabel}</span>}
                    </button>
                  ))}
                </div>
                <div className="task-trace-metrics">
                  <div className="task-trace-metric-chip">
                    <span>Runtime</span>
                    <strong>{formatRuntime(detail.metrics.runtimeMs)}</strong>
                  </div>
                  <div className="task-trace-metric-chip">
                    <span>Tokens</span>
                    <strong>
                      {formatMetricNumber(detail.metrics.inputTokens)} /{" "}
                      {formatMetricNumber(detail.metrics.outputTokens)}
                    </strong>
                  </div>
                  <div className="task-trace-metric-chip">
                    <span>Cached</span>
                    <strong>{formatMetricNumber(detail.metrics.cachedTokens)}</strong>
                  </div>
                  <div className="task-trace-metric-chip">
                    <span>Tool calls</span>
                    <strong>{detail.metrics.toolCallCount}</strong>
                  </div>
                  <div className="task-trace-metric-chip">
                    <span>Events</span>
                    <strong>{detail.metrics.eventCount}</strong>
                  </div>
                  <div className="task-trace-metric-chip">
                    <span>Started</span>
                    <strong>{formatRelativeTime(detail.metrics.startedAt)}</strong>
                  </div>
                </div>
              </div>

              <div className="task-trace-tabs">
                <div className="task-trace-tab-buttons">
                  <button
                    type="button"
                    className={activeTab === "transcript" ? "active" : ""}
                    onClick={() => setActiveTab("transcript")}
                  >
                    Transcript
                  </button>
                  <button
                    type="button"
                    className={activeTab === "debug" ? "active" : ""}
                    onClick={() => setActiveTab("debug")}
                  >
                    Debug
                  </button>
                </div>
                <div className="task-trace-tab-controls">
                  <select
                    value={actorFilter}
                    onChange={(event) =>
                      setActorFilter(event.target.value as TaskTraceRowActor | "all")
                    }
                  >
                    {ACTOR_FILTERS.map((filter) => (
                      <option key={filter.value} value={filter.value}>
                        {filter.label}
                      </option>
                    ))}
                  </select>
                  <label className="task-trace-inline-search">
                    <Search size={14} />
                    <input
                      type="search"
                      placeholder="Search visible rows"
                      value={rowSearch}
                      onChange={(event) => setRowSearch(event.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div className="task-trace-strip" aria-label="Trace scrubber">
                {visibleRows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`task-trace-strip-segment tone-${rowToneClass(row)} ${selectedRow?.id === row.id ? "selected" : ""}`}
                    onClick={() =>
                      setSelectedRowIds((previous) => ({ ...previous, [activeTab]: row.id }))
                    }
                    title={`${row.label}: ${row.title}`}
                  />
                ))}
              </div>

              <div className="task-trace-content">
                <div className="task-trace-feed">
                  {detailLoading ? (
                    <div className="task-trace-empty">Loading trace detail…</div>
                  ) : visibleRows.length === 0 ? (
                    <div className="task-trace-empty">No rows match the current view filters.</div>
                  ) : (
                    visibleRows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        ref={(element) => {
                          if (element) {
                            rowRefs.current.set(row.id, element);
                          } else {
                            rowRefs.current.delete(row.id);
                          }
                        }}
                        className={`task-trace-feed-row ${selectedRow?.id === row.id ? "selected" : ""}`}
                        onClick={() =>
                          setSelectedRowIds((previous) => ({ ...previous, [activeTab]: row.id }))
                        }
                      >
                        <div className={`task-trace-feed-label tone-${rowToneClass(row)}`}>
                          {row.label}
                        </div>
                        <div className="task-trace-feed-body">
                          <div className="task-trace-feed-title">
                            <MarkdownInline text={row.title} />
                          </div>
                          {row.body && (
                            <div className="task-trace-feed-text">
                              <MarkdownInline text={row.body} />
                            </div>
                          )}
                          <div className="task-trace-feed-meta">
                            <span>{new Date(row.timestamp).toLocaleTimeString()}</span>
                            {row.badges.map((badge) => (
                              <span
                                key={`${row.id}:${badge.label}`}
                                className={`task-trace-feed-badge tone-${badge.tone || "neutral"}`}
                              >
                                {badge.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <aside className="task-trace-inspector">
                  {selectedRow ? (
                    <>
                      <div className="task-trace-pane-header">
                        <h3>{selectedRow.label} Message</h3>
                        <span>{new Date(selectedRow.timestamp).toLocaleString()}</span>
                      </div>
                      <div className="task-trace-inspector-content">
                        <div className="task-trace-inspector-title">
                          <MarkdownInline text={selectedRow.inspector.title} />
                        </div>
                        {selectedRow.inspector.subtitle && (
                          <div className="task-trace-inspector-subtitle">
                            <MarkdownInline text={selectedRow.inspector.subtitle} />
                          </div>
                        )}
                        {selectedRow.inspector.content && (
                          <div className="task-trace-inspector-block">
                            <div className="task-trace-inspector-block-title">Content</div>
                            <MarkdownBlock text={selectedRow.inspector.content} />
                          </div>
                        )}
                        {selectedRow.inspector.fields.length > 0 && (
                          <div className="task-trace-inspector-grid">
                            {selectedRow.inspector.fields.map((field) => (
                              <div
                                key={`${selectedRow.id}:${field.label}`}
                                className="task-trace-inspector-field"
                              >
                                <span>{field.label}</span>
                                <strong>{field.value}</strong>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="task-trace-inspector-block">
                          <div className="task-trace-inspector-block-title">Raw event ids</div>
                          <pre>{selectedRow.inspector.rawEventIds.join("\n")}</pre>
                        </div>
                        {typeof selectedRow.inspector.json !== "undefined" && (
                          <div className="task-trace-inspector-block">
                            <div className="task-trace-inspector-block-title">Payload</div>
                            <pre>{JSON.stringify(selectedRow.inspector.json, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="task-trace-empty">Select a trace row to inspect it.</div>
                  )}
                </aside>
              </div>
            </>
          ) : (
            <div className="task-trace-empty task-trace-empty-large">
              {error ||
                (listLoading
                  ? "Loading trace debugger…"
                  : "Select a task session to inspect its trace.")}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
