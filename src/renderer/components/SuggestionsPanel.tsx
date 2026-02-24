import { useCallback, useEffect, useState } from "react";

interface Suggestion {
  id: string;
  type: string;
  title: string;
  description: string;
  actionPrompt?: string;
  confidence: number;
  createdAt: number;
  expiresAt: number;
}

interface SuggestionsPanelProps {
  workspaceId?: string;
  onCreateTask?: (prompt: string, title: string) => void;
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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SuggestionsPanel({ workspaceId, onCreateTask }: SuggestionsPanelProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.listSuggestions(workspaceId);
      setSuggestions(result || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load suggestions");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDismiss = async (id: string) => {
    if (!workspaceId) return;
    try {
      await window.electronAPI.dismissSuggestion(workspaceId, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      // best-effort
    }
  };

  const handleAct = async (suggestion: Suggestion) => {
    if (!workspaceId || !suggestion.actionPrompt) return;
    try {
      const result = await window.electronAPI.actOnSuggestion(workspaceId, suggestion.id);
      if (result.actionPrompt && onCreateTask) {
        onCreateTask(result.actionPrompt, suggestion.title);
      }
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
    } catch {
      // best-effort
    }
  };

  if (!workspaceId) {
    return (
      <div style={{ padding: 24, color: "var(--text-secondary)" }}>
        Select a workspace to view suggestions.
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
          Proactive Suggestions
        </h3>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.4,
          }}
        >
          AI-generated suggestions based on your task patterns, goals, and knowledge graph. Updated
          after each completed task and during daily briefings.
        </p>
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
            padding: 32,
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: 13,
            border: "1px dashed var(--border-color, #e5e7eb)",
            borderRadius: 8,
          }}
        >
          No suggestions yet. Complete tasks, set goals in your profile, or add observations to your
          knowledge graph to generate suggestions.
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
          Suggestions expire after 7 days. Dismiss suggestions you don't need.
        </div>
      )}
    </div>
  );
}
