import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import type { AgentPerformanceReview, AgentReviewGenerateRequest } from "../../shared/types";

type AgentRole = AgentRoleData;

export function AgentPerformanceReviewViewer({
  workspaceId,
  agents,
  onClose,
}: {
  workspaceId: string;
  agents: AgentRole[];
  onClose: () => void;
}) {
  const activeAgents = useMemo(() => agents.filter((a) => a.isActive), [agents]);
  const [selectedAgentRoleId, setSelectedAgentRoleId] = useState<string>(activeAgents[0]?.id || "");
  const [periodDays, setPeriodDays] = useState<number>(7);
  const [reviews, setReviews] = useState<AgentPerformanceReview[]>([]);
  const [latest, setLatest] = useState<AgentPerformanceReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => activeAgents.find((a) => a.id === selectedAgentRoleId) || null,
    [activeAgents, selectedAgentRoleId],
  );

  const load = useCallback(async () => {
    if (!workspaceId || !selectedAgentRoleId) return;
    try {
      setLoading(true);
      setError(null);
      const [list, lat] = await Promise.all([
        window.electronAPI.listAgentReviews({
          workspaceId,
          agentRoleId: selectedAgentRoleId,
          limit: 50,
        }),
        window.electronAPI.getLatestAgentReview(workspaceId, selectedAgentRoleId),
      ]);
      setReviews(list);
      setLatest(lat || null);
    } catch (e: any) {
      setError(e?.message || "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedAgentRoleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGenerate = useCallback(async () => {
    if (!workspaceId || !selectedAgentRoleId) return;
    try {
      setGenerating(true);
      setError(null);
      const req: AgentReviewGenerateRequest = {
        workspaceId,
        agentRoleId: selectedAgentRoleId,
        periodDays,
      };
      const created = await window.electronAPI.generateAgentReview(req);
      setLatest(created);
      setReviews((prev) => [created, ...prev]);
    } catch (e: any) {
      setError(e?.message || "Failed to generate review");
    } finally {
      setGenerating(false);
    }
  }, [workspaceId, selectedAgentRoleId, periodDays]);

  const handleApplyRecommendation = useCallback(async () => {
    if (!selectedAgent || !latest?.recommendedAutonomyLevel) return;
    try {
      setError(null);
      await window.electronAPI.updateAgentRole({
        id: selectedAgent.id,
        autonomyLevel: latest.recommendedAutonomyLevel,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to apply update");
    }
  }, [selectedAgent, latest?.recommendedAutonomyLevel]);

  return (
    <div className="review-viewer">
      <div className="review-header">
        <div className="review-title">
          <h3>Performance Reviews</h3>
          <div className="review-subtitle">
            Generate and track role-level reviews per workspace.
          </div>
        </div>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <div className="review-error">{error}</div>}

      <div className="review-controls">
        <label>
          Agent
          <select
            value={selectedAgentRoleId}
            onChange={(e) => setSelectedAgentRoleId(e.target.value)}
          >
            {activeAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Window (days)
          <input
            type="number"
            min={1}
            max={90}
            value={periodDays}
            onChange={(e) => setPeriodDays(Number(e.target.value) || 7)}
          />
        </label>
        <button
          className="btn primary"
          onClick={handleGenerate}
          disabled={generating || !selectedAgentRoleId}
        >
          {generating ? "Generating..." : "Generate Review"}
        </button>
      </div>

      {loading ? (
        <div className="review-loading">Loading...</div>
      ) : (
        <>
          <div className="review-latest">
            <div className="review-card">
              <div className="review-card-head">
                <div>
                  <div className="review-card-title">Latest</div>
                  <div className="review-card-meta">
                    {latest ? new Date(latest.createdAt).toLocaleString() : "No reviews yet"}
                  </div>
                </div>
                {latest?.recommendedAutonomyLevel && selectedAgent && (
                  <button className="btn" onClick={handleApplyRecommendation}>
                    Apply Recommended Level ({latest.recommendedAutonomyLevel})
                  </button>
                )}
              </div>
              {latest ? (
                <>
                  <div className="review-rating">Rating: {latest.rating}/5</div>
                  <pre className="review-summary">{latest.summary}</pre>
                  {latest.recommendationRationale && (
                    <div className="review-rationale">{latest.recommendationRationale}</div>
                  )}
                </>
              ) : (
                <div className="review-empty">Generate a review to see details.</div>
              )}
            </div>
          </div>

          <div className="review-history">
            <div className="review-history-title">History</div>
            {reviews.length === 0 ? (
              <div className="review-empty">No saved reviews.</div>
            ) : (
              <div className="review-list">
                {reviews.map((r) => (
                  <div key={r.id} className="review-row">
                    <div className="review-row-meta">
                      <div className="review-row-date">
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                      <div className="review-row-rating">{r.rating}/5</div>
                    </div>
                    <div className="review-row-body">
                      <pre className="review-row-summary">{r.summary}</pre>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        .review-viewer {
          padding: 16px;
          width: min(980px, 92vw);
          max-height: 80vh;
          overflow: auto;
          color: var(--color-text-primary);
        }
        .review-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .review-title h3 { margin: 0; font-size: 18px; }
        .review-subtitle { color: var(--color-text-secondary); font-size: 12px; margin-top: 2px; }
        .review-controls {
          display: flex;
          align-items: end;
          gap: 12px;
          flex-wrap: wrap;
          padding: 12px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: 10px;
          margin-bottom: 12px;
        }
        .review-controls label {
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 12px;
          color: var(--color-text-secondary);
        }
        .review-controls select, .review-controls input {
          padding: 8px 10px;
          border: 1px solid var(--color-border);
          border-radius: 8px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          min-width: 220px;
        }
        .review-controls input { min-width: 120px; width: 120px; }
        .btn {
          padding: 8px 12px;
          border: 1px solid var(--color-border);
          border-radius: 8px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          cursor: pointer;
        }
        .btn.primary {
          background: var(--color-accent);
          border-color: var(--color-accent);
          color: white;
        }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .review-error {
          padding: 10px 12px;
          border: 1px solid var(--color-error);
          color: var(--color-error);
          background: rgba(239, 68, 68, 0.08);
          border-radius: 10px;
          margin-bottom: 12px;
        }
        .review-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: 10px;
          padding: 12px;
          margin-bottom: 12px;
        }
        .review-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .review-card-title { font-weight: 600; }
        .review-card-meta { color: var(--color-text-secondary); font-size: 12px; margin-top: 2px; }
        .review-rating { margin-top: 10px; font-weight: 600; }
        .review-summary {
          margin-top: 8px;
          padding: 10px;
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          border-radius: 10px;
          white-space: pre-wrap;
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.35;
        }
        .review-rationale { margin-top: 10px; color: var(--color-text-secondary); font-size: 12px; }
        .review-history-title { font-weight: 600; margin: 6px 0; }
        .review-row {
          border: 1px solid var(--color-border);
          border-radius: 10px;
          padding: 10px 12px;
          background: var(--color-bg-secondary);
          margin-bottom: 8px;
        }
        .review-row-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: var(--color-text-secondary);
          font-size: 12px;
          margin-bottom: 6px;
        }
        .review-row-summary {
          margin: 0;
          white-space: pre-wrap;
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.35;
        }
        .review-loading, .review-empty { color: var(--color-text-secondary); padding: 8px; }
      `}</style>
    </div>
  );
}
