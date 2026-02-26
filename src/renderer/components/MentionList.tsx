import { useState, useEffect, useCallback } from "react";
import {
  MentionData,
  MentionEvent,
  MentionType,
  MentionStatus,
  AgentRoleData,
} from "../../electron/preload";
import { useAgentContext } from "../hooks/useAgentContext";

interface MentionListProps {
  workspaceId?: string;
  taskId?: string;
  toAgentRoleId?: string;
  showFilters?: boolean;
  onMentionClick?: (mention: MentionData) => void;
}

const MENTION_TYPE_LABELS: Record<MentionType, string> = {
  request: "Request",
  handoff: "Handoff",
  review: "Review",
  fyi: "FYI",
};

const STATUS_COLORS: Record<MentionStatus, string> = {
  pending: "#f59e0b",
  acknowledged: "#3b82f6",
  completed: "#22c55e",
  dismissed: "#6b7280",
};

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

export function MentionList({
  workspaceId,
  taskId,
  toAgentRoleId,
  showFilters = true,
  onMentionClick,
}: MentionListProps) {
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentRoleData>>({});
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<MentionStatus | "">("");
  const [filterType, setFilterType] = useState<MentionType | "">("");
  const agentContext = useAgentContext();

  // Load agents for display names
  useEffect(() => {
    const loadAgents = async () => {
      try {
        const roles = await window.electronAPI.getAgentRoles();
        const agentMap: Record<string, AgentRoleData> = {};
        roles.forEach((r: AgentRoleData) => {
          agentMap[r.id] = r;
        });
        setAgents(agentMap);
      } catch (err) {
        console.error("Failed to load agents:", err);
      }
    };
    loadAgents();
  }, []);

  const loadMentions = useCallback(async () => {
    try {
      setLoading(true);
      const query: Any = {};
      if (workspaceId) query.workspaceId = workspaceId;
      if (taskId) query.taskId = taskId;
      if (toAgentRoleId) query.toAgentRoleId = toAgentRoleId;
      if (filterStatus) query.status = filterStatus;

      const result = await window.electronAPI.listMentions(query);

      // Filter by type client-side if needed
      let filtered = result;
      if (filterType) {
        filtered = result.filter((m: MentionData) => m.mentionType === filterType);
      }

      setMentions(filtered);
    } catch (err) {
      console.error("Failed to load mentions:", err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, taskId, toAgentRoleId, filterStatus, filterType]);

  useEffect(() => {
    loadMentions();
  }, [loadMentions]);

  // Subscribe to real-time mention events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMentionEvent((event: MentionEvent) => {
      switch (event.type) {
        case "created":
          if (event.mention) {
            const matches =
              (!workspaceId || event.mention.workspaceId === workspaceId) &&
              (!taskId || event.mention.taskId === taskId) &&
              (!toAgentRoleId || event.mention.toAgentRoleId === toAgentRoleId);
            if (matches) {
              setMentions((prev) => [event.mention!, ...prev]);
            }
          }
          break;
        case "acknowledged":
        case "completed":
        case "dismissed":
          if (event.mention) {
            setMentions((prev) =>
              prev.map((m) => (m.id === event.mention!.id ? event.mention! : m)),
            );
          }
          break;
      }
    });

    return () => unsubscribe();
  }, [workspaceId, taskId, toAgentRoleId]);

  const handleAcknowledge = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.electronAPI.acknowledgeMention(id);
    } catch (err) {
      console.error("Failed to acknowledge mention:", err);
    }
  };

  const handleComplete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.electronAPI.completeMention(id);
    } catch (err) {
      console.error("Failed to complete mention:", err);
    }
  };

  const handleDismiss = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.electronAPI.dismissMention(id);
    } catch (err) {
      console.error("Failed to dismiss mention:", err);
    }
  };

  const getAgentName = (agentId: string | undefined): string => {
    if (!agentId) return agentContext.getUiCopy("mentionUser");
    return agents[agentId]?.displayName || agentContext.getUiCopy("mentionUnknownAgent");
  };

  const getAgentIcon = (agentId: string | undefined): { icon: string; color: string } => {
    if (!agentId) return { icon: "?", color: "#6366f1" };
    const agent = agents[agentId];
    return agent ? { icon: agent.icon, color: agent.color } : { icon: "?", color: "#6366f1" };
  };

  if (loading) {
    return <div className="mention-loading">{agentContext.getUiCopy("mentionLoading")}</div>;
  }

  return (
    <div className="mention-list">
      {showFilters && (
        <div className="mention-filters">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as MentionStatus | "")}
          >
            <option value="">{agentContext.getUiCopy("mentionAllStatuses")}</option>
            <option value="pending">{agentContext.getUiCopy("mentionStatusPending")}</option>
            <option value="acknowledged">
              {agentContext.getUiCopy("mentionStatusAcknowledged")}
            </option>
            <option value="completed">{agentContext.getUiCopy("mentionStatusCompleted")}</option>
            <option value="dismissed">{agentContext.getUiCopy("mentionStatusDismissed")}</option>
          </select>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as MentionType | "")}
          >
            <option value="">{agentContext.getUiCopy("mentionAllTypes")}</option>
            <option value="request">{agentContext.getUiCopy("mentionTypeRequest")}</option>
            <option value="handoff">{agentContext.getUiCopy("mentionTypeHandoff")}</option>
            <option value="review">{agentContext.getUiCopy("mentionTypeReview")}</option>
            <option value="fyi">{agentContext.getUiCopy("mentionTypeFyi")}</option>
          </select>
        </div>
      )}

      {mentions.length === 0 ? (
        <div className="mention-empty">
          <p>{agentContext.getUiCopy("mentionEmpty")}</p>
        </div>
      ) : (
        <div className="mention-items">
          {mentions.map((mention) => {
            const fromAgent = getAgentIcon(mention.fromAgentRoleId);
            const toAgent = getAgentIcon(mention.toAgentRoleId);

            return (
              <div
                key={mention.id}
                className={`mention-item status-${mention.status}`}
                onClick={() => onMentionClick?.(mention)}
              >
                <div className="mention-header">
                  <div className="mention-agents">
                    <span className="agent-avatar" style={{ backgroundColor: fromAgent.color }}>
                      {fromAgent.icon}
                    </span>
                    <span className="mention-arrow">→</span>
                    <span className="agent-avatar" style={{ backgroundColor: toAgent.color }}>
                      {toAgent.icon}
                    </span>
                  </div>

                  <div className="mention-meta">
                    <span
                      className="mention-type"
                      style={{ backgroundColor: STATUS_COLORS[mention.status] }}
                    >
                      {MENTION_TYPE_LABELS[mention.mentionType]}
                    </span>
                    <span className="mention-time">{formatTimeAgo(mention.createdAt)}</span>
                  </div>
                </div>

                <div className="mention-body">
                  <div className="mention-from-to">
                    <strong>{getAgentName(mention.fromAgentRoleId)}</strong>
                    {" → "}
                    <strong>{getAgentName(mention.toAgentRoleId)}</strong>
                  </div>
                  {mention.context && <p className="mention-context">{mention.context}</p>}
                </div>

                {mention.status === "pending" && (
                  <div className="mention-actions">
                    <button
                      className="btn-action btn-acknowledge"
                      onClick={(e) => handleAcknowledge(mention.id, e)}
                    >
                      Acknowledge
                    </button>
                    <button
                      className="btn-action btn-complete"
                      onClick={(e) => handleComplete(mention.id, e)}
                    >
                      Complete
                    </button>
                    <button
                      className="btn-action btn-dismiss"
                      onClick={(e) => handleDismiss(mention.id, e)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {mention.status === "acknowledged" && (
                  <div className="mention-actions">
                    <button
                      className="btn-action btn-complete"
                      onClick={(e) => handleComplete(mention.id, e)}
                    >
                      Mark Complete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .mention-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .mention-filters {
          display: flex;
          gap: 8px;
        }

        .mention-filters select {
          padding: 6px 10px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 12px;
        }

        .mention-items {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .mention-item {
          padding: 12px;
          background: var(--color-bg-secondary);
          border-radius: 8px;
          border-left: 3px solid transparent;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .mention-item:hover {
          background: var(--color-bg-tertiary);
        }

        .mention-item.status-pending {
          border-left-color: #f59e0b;
        }

        .mention-item.status-acknowledged {
          border-left-color: #3b82f6;
        }

        .mention-item.status-completed {
          border-left-color: #22c55e;
          opacity: 0.7;
        }

        .mention-item.status-dismissed {
          border-left-color: #6b7280;
          opacity: 0.5;
        }

        .mention-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .mention-agents {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .agent-avatar {
          width: 24px;
          height: 24px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
        }

        .mention-arrow {
          color: var(--color-text-muted);
          font-size: 12px;
        }

        .mention-meta {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .mention-type {
          font-size: 10px;
          font-weight: 600;
          color: white;
          padding: 2px 6px;
          border-radius: 4px;
          text-transform: uppercase;
        }

        .mention-time {
          font-size: 11px;
          color: var(--color-text-muted);
        }

        .mention-body {
          margin-bottom: 8px;
        }

        .mention-from-to {
          font-size: 13px;
          color: var(--color-text-primary);
          margin-bottom: 4px;
        }

        .mention-context {
          font-size: 12px;
          color: var(--color-text-secondary);
          margin: 0;
          white-space: pre-wrap;
        }

        .mention-actions {
          display: flex;
          gap: 8px;
        }

        .btn-action {
          padding: 6px 12px;
          border: none;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .btn-acknowledge {
          background: #3b82f6;
          color: white;
        }

        .btn-acknowledge:hover {
          background: #2563eb;
        }

        .btn-complete {
          background: #22c55e;
          color: white;
        }

        .btn-complete:hover {
          background: #16a34a;
        }

        .btn-dismiss {
          background: var(--color-bg-tertiary);
          color: var(--color-text-secondary);
        }

        .btn-dismiss:hover {
          background: var(--color-bg-primary);
        }

        .mention-empty {
          text-align: center;
          padding: 40px 20px;
          color: var(--color-text-secondary);
        }

        .mention-loading {
          text-align: center;
          padding: 20px;
          color: var(--color-text-secondary);
        }
      `}</style>
    </div>
  );
}
