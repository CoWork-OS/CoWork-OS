import { useCallback, useEffect, useState } from "react";
import { Archive, CheckCircle2, FolderKanban, Pencil, Play, RotateCw, Search } from "lucide-react";
import type { SessionSearchResult, WorkContext } from "../../shared/types";

interface WorkContextStripProps {
  workspaceId?: string;
  refreshKey?: string | number;
  onSelectTask: (taskId: string) => void;
}

function statusLabel(status: WorkContext["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "paused":
      return "Paused";
    default:
      return "Active";
  }
}

export function WorkContextStrip({ workspaceId, refreshKey, onSelectTask }: WorkContextStripProps) {
  const [contexts, setContexts] = useState<WorkContext[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);

  const load = useCallback(async () => {
    if (!workspaceId || !window.electronAPI?.listWorkContexts) {
      setContexts([]);
      return;
    }
    setLoading(true);
    try {
      const next = await window.electronAPI.listWorkContexts({ workspaceId, limit: 8 });
      setContexts(next || []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load work contexts.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    const normalizedQuery = query.trim();
    if (!workspaceId || normalizedQuery.length < 2 || !window.electronAPI?.searchSessions) {
      setSearchResults([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void window.electronAPI
        .searchSessions({ query: normalizedQuery, workspaceId, limit: 8 })
        .then((results) => {
          if (!cancelled) setSearchResults(results || []);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, workspaceId]);

  const saveName = async (context: WorkContext) => {
    const name = editingName.trim();
    setEditingId(null);
    if (!name || name === context.name || !window.electronAPI?.updateWorkContext) return;
    try {
      const updated = await window.electronAPI.updateWorkContext({
        contextId: context.id,
        name,
      });
      if (updated)
        setContexts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to rename work context.");
    }
  };

  const archive = async (context: WorkContext) => {
    if (!window.electronAPI?.updateWorkContext) return;
    try {
      await window.electronAPI.updateWorkContext({ contextId: context.id, status: "archived" });
      setContexts((current) => current.filter((item) => item.id !== context.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to archive work context.");
    }
  };

  if (!workspaceId) return null;

  return (
    <section className="work-context-strip" aria-label="Work contexts">
      <div className="work-context-strip-header">
        <span className="work-context-strip-title">
          <FolderKanban size={14} aria-hidden="true" />
          Continue work
        </span>
        <button
          type="button"
          className="sidebar-session-action"
          onClick={() => void load()}
          title="Refresh work contexts"
        >
          <RotateCw size={13} aria-hidden="true" />
        </button>
      </div>
      <label className="work-context-search">
        <Search size={12} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
      </label>
      {query.trim().length >= 2 && searchResults.length > 0 ? (
        <div className="work-context-search-results" aria-label="Session search results">
          {searchResults.map((result) => (
            <button
              type="button"
              className="work-context-search-result"
              key={result.task.id}
              onClick={() => onSelectTask(result.task.id)}
            >
              <span className="work-context-row-name">{result.task.title}</span>
              <span className="work-context-row-status">{result.progress.status}</span>
            </button>
          ))}
        </div>
      ) : query.trim().length >= 2 && !loading ? (
        <div className="work-context-search-empty">No matching sessions</div>
      ) : null}
      {error && (
        <div className="work-context-strip-error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="work-context-strip-loading">Loading work…</div>}
      {!loading &&
        contexts.map((context) => {
          const taskId = context.activeTaskId || context.taskIds.at(-1);
          const isEditable = editingId === context.id;
          return (
            <div className="work-context-row" key={context.id}>
              <button
                type="button"
                className="work-context-row-main"
                disabled={!taskId}
                onClick={() => taskId && onSelectTask(taskId)}
                title={taskId ? `Resume ${context.name}` : context.name}
              >
                {context.status === "completed" ? <CheckCircle2 size={13} /> : <Play size={13} />}
                {isEditable ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={() => void saveName(context)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveName(context);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Rename ${context.name}`}
                  />
                ) : (
                  <span className="work-context-row-name">{context.name}</span>
                )}
                <span className="work-context-row-status">{statusLabel(context.status)}</span>
              </button>
              {!isEditable && (
                <button
                  type="button"
                  className="work-context-row-action"
                  onClick={() => {
                    setEditingId(context.id);
                    setEditingName(context.name);
                  }}
                  title="Rename work context"
                  aria-label={`Rename ${context.name}`}
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                type="button"
                className="work-context-row-action"
                onClick={() => void archive(context)}
                title="Archive work context"
                aria-label={`Archive ${context.name}`}
              >
                <Archive size={12} />
              </button>
            </div>
          );
        })}
    </section>
  );
}
