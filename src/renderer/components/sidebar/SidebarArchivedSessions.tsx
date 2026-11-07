import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, ChevronLeft } from "lucide-react";
import type { Task, Workspace } from "../../../shared/types";
import { isTempWorkspaceId } from "../../../shared/types";
import "./sidebar-archived.css";

/** Archived sessions loaded per request. The view says so when there are more. */
export const ARCHIVED_SESSION_LOAD = 200;

// Same exclusions as the main session list: side chats and managed-agent
// panels are not sessions there, so they are not sessions here either.
const ARCHIVED_EXCLUDED_SOURCES: Array<NonNullable<Task["source"]>> = [
  "managed_agent_panel",
  "side_chat",
];

/**
 * One row per archived session. A continued session has several top-level
 * tasks; the newest stands for it, since unarchiving restores all of them.
 */
export function collapseArchivedSessions(tasks: readonly Task[]): Task[] {
  const bySession = new Map<string, Task>();
  for (const task of tasks) {
    if (task.parentTaskId || task.sessionArchived !== true) continue;
    const sessionId = task.sessionId || task.id;
    const current = bySession.get(sessionId);
    const taskTime = task.updatedAt || task.createdAt;
    if (!current || taskTime > (current.updatedAt || current.createdAt)) {
      bySession.set(sessionId, task);
    }
  }
  return Array.from(bySession.values()).sort(
    (a, b) =>
      (b.sessionArchivedAt ?? 0) - (a.sessionArchivedAt ?? 0) ||
      (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
  );
}

/** When a session was archived, short enough for the row's second line. */
export function formatArchivedAt(archivedAt: number | undefined, now = Date.now()): string {
  if (!archivedAt) return "";
  const elapsed = Math.max(0, now - archivedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "just now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} h ago`;
  const date = new Date(archivedAt);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date);
  } catch {
    return "";
  }
}

function matchesArchivedSearch(task: Task, title: string, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [title, task.title, task.sidebarPromptPreview, task.id]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .includes(normalizedSearch);
}

export interface SidebarArchivedSessionsViewProps {
  sessions: Task[];
  loading: boolean;
  loadError: string | null;
  hasMore: boolean;
  normalizedSearch: string;
  workspaces: readonly Workspace[];
  restoringTaskId: string | null;
  restored: { taskId: string; title: string } | null;
  actionError: string | null;
  titleFor: (task: Task) => string;
  onClose: () => void;
  onUnarchive: (task: Task) => void;
  onOpenRestored: (taskId: string) => void;
}

/** The list itself, without data loading, so it renders in tests. */
export function SidebarArchivedSessionsView({
  sessions,
  loading,
  loadError,
  hasMore,
  normalizedSearch,
  workspaces,
  restoringTaskId,
  restored,
  actionError,
  titleFor,
  onClose,
  onUnarchive,
  onOpenRestored,
}: SidebarArchivedSessionsViewProps) {
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const rows = sessions
    .map((task) => ({ task, title: titleFor(task) }))
    .filter(({ task, title }) => matchesArchivedSearch(task, title, normalizedSearch));

  return (
    <section className="sidebar-archived" aria-label="Archived sessions">
      <div className="sidebar-archived-header">
        <button
          type="button"
          className="sidebar-archived-back"
          onClick={onClose}
          aria-label="Back to sessions"
          title="Back to sessions"
        >
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <h2 className="sidebar-archived-title">Archived sessions</h2>
        {!loading && sessions.length > 0 && (
          <span className="sidebar-archived-count">
            {sessions.length}
            {hasMore ? "+" : ""}
          </span>
        )}
      </div>

      {restored && (
        <div className="sidebar-archived-status" role="status">
          <span>“{restored.title}” is back in your sessions.</span>
          <button type="button" onClick={() => onOpenRestored(restored.taskId)}>
            Open
          </button>
        </div>
      )}
      {(actionError || loadError) && (
        <div className="sidebar-archived-status sidebar-archived-status-error" role="alert">
          <span>{actionError || loadError}</span>
        </div>
      )}

      {loading ? (
        <div className="sidebar-session-skeleton" aria-label="Loading archived sessions">
          <span className="sidebar-session-skeleton-line" />
          <span className="sidebar-session-skeleton-line" />
          <span className="sidebar-session-skeleton-line" />
        </div>
      ) : rows.length === 0 ? (
        loadError ? null : (
          <div className="sidebar-session-filter-empty" role="status">
            <p>
              {normalizedSearch && sessions.length > 0
                ? "No matching archived sessions"
                : "No archived sessions"}
            </p>
            <span>
              {normalizedSearch && sessions.length > 0
                ? "Try a different title or session ID."
                : "Sessions you archive stay here until you unarchive them."}
            </span>
          </div>
        )
      ) : (
        <ul className="sidebar-archived-list">
          {rows.map(({ task, title }) => {
            const workspaceName =
              task.workspaceId && !isTempWorkspaceId(task.workspaceId)
                ? workspaceNames.get(task.workspaceId)
                : undefined;
            const restoring = restoringTaskId === task.id;
            const archivedWhen = formatArchivedAt(task.sessionArchivedAt);
            const meta = [workspaceName, archivedWhen].filter(Boolean).join(" · ");
            return (
              <li key={task.sessionId || task.id} className="sidebar-archived-row">
                <div className="sidebar-archived-row-copy">
                  <span className="sidebar-archived-row-title" title={title}>
                    {title}
                  </span>
                  {meta && (
                    <span
                      className="sidebar-archived-row-meta"
                      title={archivedWhen ? `Archived ${archivedWhen}` : undefined}
                    >
                      {meta}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="sidebar-archived-row-action"
                  onClick={() => onUnarchive(task)}
                  disabled={restoringTaskId !== null}
                  aria-label={`Unarchive ${title}`}
                  aria-busy={restoring || undefined}
                  title={restoring ? "Restoring…" : "Unarchive"}
                >
                  <ArchiveRestore size={16} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </li>
            );
          })}
          {hasMore && (
            <li className="sidebar-archived-more">
              Showing the {ARCHIVED_SESSION_LOAD} most recently archived sessions.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export interface SidebarArchivedSessionsProps {
  normalizedSearch: string;
  workspaces: readonly Workspace[];
  titleFor: (task: Task) => string;
  onClose: () => void;
  /** Called after a session is unarchived, so the main list can reload. */
  onUnarchived: (taskId: string) => void;
  onOpenRestored: (taskId: string) => void;
}

export function SidebarArchivedSessions({
  normalizedSearch,
  workspaces,
  titleFor,
  onClose,
  onUnarchived,
  onOpenRestored,
}: SidebarArchivedSessionsProps) {
  const [sessions, setSessions] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ taskId: string; title: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const listSidebarTasks = window.electronAPI?.listSidebarTasks;
    if (!listSidebarTasks) {
      setLoading(false);
      setLoadError("Archived sessions are not available here.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const page = (await listSidebarTasks({
        limit: ARCHIVED_SESSION_LOAD + 1,
        offset: 0,
        archivedSessionsOnly: true,
        excludeBotConversations: true,
        excludeSources: ARCHIVED_EXCLUDED_SOURCES,
      })) as Task[];
      if (!mountedRef.current) return;
      setHasMore(page.length > ARCHIVED_SESSION_LOAD);
      setSessions(collapseArchivedSessions(page.slice(0, ARCHIVED_SESSION_LOAD)));
    } catch (error) {
      console.error("Failed to load archived sessions:", error);
      if (mountedRef.current) setLoadError("Archived sessions could not be loaded.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnarchive = useCallback(
    async (task: Task) => {
      const unarchiveTask = window.electronAPI?.unarchiveTask;
      if (!unarchiveTask || restoringTaskId) return;
      setRestoringTaskId(task.id);
      setActionError(null);
      setRestored(null);
      try {
        await unarchiveTask(task.id);
        if (!mountedRef.current) return;
        const sessionId = task.sessionId || task.id;
        setSessions((current) =>
          current.filter((candidate) => (candidate.sessionId || candidate.id) !== sessionId),
        );
        setRestored({ taskId: task.id, title: titleFor(task) });
        onUnarchived(task.id);
      } catch (error) {
        console.error("Failed to unarchive session:", error);
        if (mountedRef.current) {
          setActionError(
            error instanceof Error && error.message
              ? `Could not unarchive: ${error.message}`
              : "Could not unarchive that session.",
          );
        }
      } finally {
        if (mountedRef.current) setRestoringTaskId(null);
      }
    },
    [onUnarchived, restoringTaskId, titleFor],
  );

  return (
    <SidebarArchivedSessionsView
      sessions={sessions}
      loading={loading}
      loadError={loadError}
      hasMore={hasMore}
      normalizedSearch={normalizedSearch}
      workspaces={workspaces}
      restoringTaskId={restoringTaskId}
      restored={restored}
      actionError={actionError}
      titleFor={titleFor}
      onClose={onClose}
      onUnarchive={(task) => void handleUnarchive(task)}
      onOpenRestored={onOpenRestored}
    />
  );
}
