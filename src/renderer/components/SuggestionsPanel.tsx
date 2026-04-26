import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProactiveSuggestion, Workspace } from "../../shared/types";

interface SuggestionsPanelProps {
  workspaceId?: string;
  onCreateTask?: (title: string, prompt: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  recurring_pattern: "Automation",
  goal_aligned: "Goal",
  insight: "Insight",
  reverse_prompt: "Idea",
};

const TYPE_COLORS: Record<string, string> = {
  follow_up: "#3b82f6",
  recurring_pattern: "#8b5cf6",
  goal_aligned: "#22c55e",
  insight: "#f59e0b",
  reverse_prompt: "#ec4899",
};

const ALL_WORKSPACES_ID = "__all__";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isValidWorkspaceId(id: string | undefined): id is string {
  return !!id && !id.startsWith("__temp_workspace__");
}

export function SuggestionsPanel({
  workspaceId: _initialWorkspaceId,
  onCreateTask,
}: SuggestionsPanelProps) {
  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(ALL_WORKSPACES_ID);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  // Load workspaces on mount
  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const loaded = await window.electronAPI.listWorkspaces();
      const nonTemp = loaded.filter((w) => !w.id.startsWith("__temp_workspace__"));
      setWorkspaces(nonTemp);
      setSelectedWorkspaceId((prev) => {
        if (prev === ALL_WORKSPACES_ID) return ALL_WORKSPACES_ID;
        if (prev && nonTemp.some((w) => w.id === prev)) return prev;
        return ALL_WORKSPACES_ID;
      });
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const workspaceId = selectedWorkspaceId;
  const isAllWorkspacesSelected = workspaceId === ALL_WORKSPACES_ID;
  const workspaceNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const workspace of workspaces) {
      names.set(workspace.id, workspace.name);
    }
    return names;
  }, [workspaces]);

  const load = useCallback(async (refresh = false) => {
    if (!isAllWorkspacesSelected && !isValidWorkspaceId(workspaceId)) {
      setSuggestions([]);
      return;
    }
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      if (isAllWorkspacesSelected) {
        if (workspaces.length === 0) {
          setSuggestions([]);
          return;
        }
        if (refresh) {
          await window.electronAPI.refreshSuggestionsForWorkspaces(
            workspaces.map((workspace) => workspace.id),
          );
        }
        const result = await window.electronAPI.listSuggestionsForWorkspaces(
          workspaces.map((workspace) => workspace.id),
        );
        const flattened = (result || [])
          .flatMap((entry) =>
            entry.suggestions.map((suggestion) => ({
              ...suggestion,
              workspaceId: suggestion.workspaceId || entry.workspaceId,
            })),
          )
          .sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            return b.createdAt - a.createdAt;
          });
        setSuggestions(flattened);
        return;
      }

      if (refresh) {
        await window.electronAPI.refreshSuggestions(workspaceId);
      }
      const result = await window.electronAPI.listSuggestions(workspaceId);
      setSuggestions(result || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load suggestions");
    } finally {
      if (refresh) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [isAllWorkspacesSelected, workspaceId, workspaces]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDismiss = async (id: string) => {
    const targetWorkspaceId =
      suggestions.find((suggestion) => suggestion.id === id)?.workspaceId || workspaceId;
    if (!isValidWorkspaceId(targetWorkspaceId)) return;
    try {
      await window.electronAPI.dismissSuggestion(targetWorkspaceId, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      // best-effort
    }
  };

  const handleSnooze = async (id: string) => {
    const targetWorkspaceId =
      suggestions.find((suggestion) => suggestion.id === id)?.workspaceId || workspaceId;
    if (!isValidWorkspaceId(targetWorkspaceId)) return;
    try {
      await window.electronAPI.snoozeSuggestion(
        targetWorkspaceId,
        id,
        Date.now() + 24 * 60 * 60 * 1000,
      );
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      // best-effort
    }
  };

  const handleAct = async (suggestion: ProactiveSuggestion) => {
    const targetWorkspaceId = suggestion.workspaceId || workspaceId;
    if (!isValidWorkspaceId(targetWorkspaceId) || !suggestion.actionPrompt) return;
    try {
      const result = await window.electronAPI.actOnSuggestion(targetWorkspaceId, suggestion.id);
      if (result.actionPrompt && onCreateTask) {
        onCreateTask(suggestion.title, result.actionPrompt);
      }
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
    } catch {
      // best-effort
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
          Workflow Intelligence Suggestions
        </h3>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.4,
          }}
        >
          Reviewable next actions based on memory, heartbeat signals, and recent workflow patterns.
          Acting, editing, snoozing, or dismissing them tunes what appears next.
        </p>
      </div>

      {workspacesLoading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
          Loading workspaces...
        </div>
      ) : workspaces.length === 0 ? (
        <div style={{ padding: 24, color: "var(--text-secondary)" }}>
          No workspaces found. Create a workspace first.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "end",
              gap: 12,
              marginBottom: 16,
              flexWrap: "wrap",
            }}
          >
            <div className="settings-form-group" style={{ marginBottom: 0, maxWidth: 260 }}>
              <label className="settings-label">Workspace</label>
              <select
                value={selectedWorkspaceId}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                className="settings-select"
              >
                <option value={ALL_WORKSPACES_ID}>All Workspaces</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 999,
                border: "1px solid var(--border-color, #e5e7eb)",
                background: "var(--card-bg, #fff)",
                color: "var(--text-primary)",
                fontSize: 12,
                fontWeight: 600,
                cursor: loading || refreshing ? "not-allowed" : "pointer",
                opacity: loading || refreshing ? 0.65 : 1,
              }}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {loading && (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
              Loading suggestions...
            </div>
          )}

          {error && (
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                background: "var(--error-bg, #fef2f2)",
                color: "var(--error-text, #dc2626)",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && suggestions.length === 0 && (
            <div
              style={{
                padding: 24,
                fontSize: 13,
                color: "var(--text-secondary)",
                border: "1px dashed var(--border-color, #e5e7eb)",
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
                No active suggestions
              </div>
              <div style={{ lineHeight: 1.6 }}>
                Nothing is queued for this workspace scope right now.
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {suggestions.map((s) => {
              const color = TYPE_COLORS[s.type] || "#6b7280";
              const label = TYPE_LABELS[s.type] || s.type;

              return (
                <div
                  key={s.id}
                  style={{
                    padding: 14,
                    borderRadius: 8,
                    border: "1px solid var(--border-color, #e5e7eb)",
                    background: "var(--card-bg, #fff)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#fff",
                          background: color,
                        }}
                      >
                        {label}
                      </span>
                      {isAllWorkspacesSelected && s.workspaceId && (
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-tertiary, #9ca3af)",
                          }}
                        >
                          {workspaceNameById.get(s.workspaceId) || "Workspace"}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--text-tertiary, #9ca3af)",
                        }}
                      >
                        {timeAgo(s.createdAt)}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-tertiary, #9ca3af)",
                      }}
                    >
                      {Math.round(s.confidence * 100)}% confidence
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      marginBottom: 4,
                    }}
                  >
                    {s.title}
                  </div>

                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      lineHeight: 1.4,
                      marginBottom: 10,
                    }}
                  >
                    {s.description}
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    {s.actionPrompt && onCreateTask && (
                      <button
                        onClick={() => handleAct(s)}
                        style={{
                          padding: "5px 12px",
                          borderRadius: 5,
                          border: "none",
                          background: "var(--accent-color, #3b82f6)",
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 500,
                          cursor: "pointer",
                        }}
                      >
                        Do it
                      </button>
                    )}
                    <button
                      onClick={() => handleSnooze(s.id)}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 5,
                        border: "1px solid var(--border-color, #e5e7eb)",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      Snooze
                    </button>
                    <button
                      onClick={() => handleDismiss(s.id)}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 5,
                        border: "1px solid var(--border-color, #e5e7eb)",
                        background: "transparent",
                        color: "var(--text-secondary)",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {suggestions.length > 0 && (
            <div
              style={{
                marginTop: 16,
                fontSize: 12,
                color: "var(--text-tertiary, #9ca3af)",
                textAlign: "center",
              }}
            >
              Suggestions expire after 7 days. Snooze or dismiss suggestions you do not need now.
            </div>
          )}
        </>
      )}
    </div>
  );
}
