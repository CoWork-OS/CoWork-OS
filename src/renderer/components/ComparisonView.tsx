import { useCallback, useEffect, useState } from "react";

interface ComparisonTaskResult {
  taskId: string;
  label: string;
  status: string;
  branchName?: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  duration: number;
  summary?: string;
}

interface ComparisonResult {
  taskResults: ComparisonTaskResult[];
  diffSummary?: string;
}

interface ComparisonSession {
  id: string;
  title: string;
  prompt: string;
  status: string;
  taskIds: string[];
  createdAt: number;
  completedAt?: number;
  comparisonResult?: ComparisonResult;
}

interface ComparisonViewProps {
  sessionId: string;
  onSelectTask?: (taskId: string) => void;
}

export function ComparisonView({ sessionId, onSelectTask }: ComparisonViewProps) {
  const [session, setSession] = useState<ComparisonSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const s = await window.electronAPI.getComparison(sessionId);
      setSession(s ?? null);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load comparison session";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!session || session.status !== "running") return;
    const interval = window.setInterval(() => {
      void loadSession();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [session?.id, session?.status, loadSession]);

  const handleCancel = async () => {
    try {
      await window.electronAPI.cancelComparison(sessionId);
      await loadSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to cancel comparison";
      setError(message);
    }
  };

  const formatDuration = (ms: number) => {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins}m ${remaining}s`;
  };

  if (loading) {
    return (
      <div className="comparison-view" style={{ padding: "24px", opacity: 0.6 }}>
        Loading comparison session...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="comparison-view" style={{ padding: "24px", opacity: 0.6 }}>
        Comparison session not found.
      </div>
    );
  }

  const isRunning = session.status === "running";
  const results = session.comparisonResult?.taskResults || [];

  return (
    <div className="comparison-view" style={{ padding: "24px" }}>
      <div style={{ marginBottom: "16px" }}>
        <h2 style={{ margin: "0 0 4px 0" }}>{session.title}</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.75rem",
              backgroundColor: isRunning
                ? "var(--color-accent)"
                : session.status === "completed"
                  ? "var(--color-success, #34d399)"
                  : "var(--color-error, #f87171)",
              color: "#000",
              fontWeight: 600,
            }}
          >
            {session.status}
          </span>
          <span style={{ opacity: 0.6, fontSize: "0.875rem" }}>
            {session.taskIds.length} agents
          </span>
          {isRunning && (
            <button
              onClick={handleCancel}
              style={{
                background: "none",
                border: "1px solid var(--color-error, #f87171)",
                color: "var(--color-error, #f87171)",
                padding: "2px 8px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "0.75rem",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div style={{ marginBottom: "16px", opacity: 0.8 }}>
        <strong>Prompt:</strong> {session.prompt}
      </div>

      {error && (
        <div style={{ marginBottom: "16px", color: "var(--color-error, #f87171)" }}>{error}</div>
      )}

      {results.length > 0 ? (
        <div style={{ display: "grid", gap: "12px" }}>
          {results.map((result) => (
            <div
              key={result.taskId}
              style={{
                padding: "16px",
                borderRadius: "8px",
                backgroundColor: "var(--color-bg-elevated, rgba(255,255,255,0.05))",
                border: "1px solid var(--color-border)",
                cursor: onSelectTask ? "pointer" : "default",
              }}
              onClick={() => onSelectTask?.(result.taskId)}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "8px",
                }}
              >
                <span style={{ fontWeight: 600 }}>{result.label}</span>
                <span
                  style={{
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontSize: "0.7rem",
                    backgroundColor:
                      result.status === "completed"
                        ? "var(--color-success, #34d399)"
                        : result.status === "failed"
                          ? "var(--color-error, #f87171)"
                          : "var(--color-accent)",
                    color: "#000",
                  }}
                >
                  {result.status}
                </span>
              </div>

              {result.branchName && (
                <div
                  style={{
                    fontSize: "0.75rem",
                    opacity: 0.7,
                    marginBottom: "8px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {result.branchName}
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: "8px",
                  fontSize: "0.75rem",
                }}
              >
                <div>
                  <div style={{ opacity: 0.6 }}>Files</div>
                  <div style={{ fontWeight: 600 }}>{result.filesChanged}</div>
                </div>
                <div>
                  <div style={{ opacity: 0.6 }}>Added</div>
                  <div style={{ fontWeight: 600, color: "var(--color-success, #34d399)" }}>
                    +{result.linesAdded}
                  </div>
                </div>
                <div>
                  <div style={{ opacity: 0.6 }}>Removed</div>
                  <div style={{ fontWeight: 600, color: "var(--color-error, #f87171)" }}>
                    -{result.linesRemoved}
                  </div>
                </div>
                <div>
                  <div style={{ opacity: 0.6 }}>Duration</div>
                  <div style={{ fontWeight: 600 }}>{formatDuration(result.duration)}</div>
                </div>
              </div>

              {result.summary && (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "0.8rem",
                    opacity: 0.8,
                    borderTop: "1px solid var(--color-border)",
                    paddingTop: "8px",
                  }}
                >
                  {result.summary}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : isRunning ? (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "32px" }}>
          Agents are working... Results will appear here when tasks complete.
        </div>
      ) : (
        <div style={{ opacity: 0.6, textAlign: "center", padding: "32px" }}>
          No results available.
        </div>
      )}
    </div>
  );
}
