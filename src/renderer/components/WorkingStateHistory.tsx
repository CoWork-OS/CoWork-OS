import { useState, useEffect, useCallback } from "react";
import { AgentWorkingStateData, WorkingStateType } from "../../electron/preload";
import { useAgentContext } from "../hooks/useAgentContext";
import { ThemeIcon } from "./ThemeIcon";
import { ChartIcon, ClipboardIcon, EditIcon, TargetIcon } from "./LineIcons";

interface WorkingStateHistoryProps {
  agentRoleId: string;
  workspaceId: string;
  onRestore: (state: AgentWorkingStateData) => void;
  onClose: () => void;
}

const STATE_TYPE_LABELS: Record<WorkingStateType, { label: string; icon: React.ReactNode }> = {
  context: { label: "Context", icon: <ThemeIcon emoji="📋" icon={<ClipboardIcon size={14} />} /> },
  progress: { label: "Progress", icon: <ThemeIcon emoji="📊" icon={<ChartIcon size={14} />} /> },
  notes: { label: "Notes", icon: <ThemeIcon emoji="📝" icon={<EditIcon size={14} />} /> },
  plan: { label: "Plan", icon: <ThemeIcon emoji="🎯" icon={<TargetIcon size={14} />} /> },
};

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isToday) {
    return `Today at ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${time}`;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WorkingStateHistory({
  agentRoleId,
  workspaceId,
  onRestore,
  onClose,
}: WorkingStateHistoryProps) {
  const [history, setHistory] = useState<AgentWorkingStateData[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<WorkingStateType | "">("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const agentContext = useAgentContext();

  const loadHistory = useCallback(async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI.getWorkingStateHistory({
        agentRoleId,
        workspaceId,
        limit: 100,
      });
      setHistory(result);
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }, [agentRoleId, workspaceId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleRestore = async (state: AgentWorkingStateData) => {
    try {
      setRestoring(state.id);
      const restored = await window.electronAPI.restoreWorkingState(state.id);
      if (restored) {
        onRestore(restored);
      }
    } catch (err) {
      console.error("Failed to restore state:", err);
    } finally {
      setRestoring(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(agentContext.getUiCopy("workingStateHistoryDeleteConfirm"))) return;

    try {
      await window.electronAPI.deleteWorkingState(id);
      setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch (err) {
      console.error("Failed to delete state:", err);
    }
  };

  const filteredHistory = filterType ? history.filter((h) => h.stateType === filterType) : history;

  // Group by date
  const groupedHistory: Record<string, AgentWorkingStateData[]> = {};
  filteredHistory.forEach((item) => {
    const dateKey = new Date(item.updatedAt).toDateString();
    if (!groupedHistory[dateKey]) {
      groupedHistory[dateKey] = [];
    }
    groupedHistory[dateKey].push(item);
  });

  if (loading) {
    return (
      <div className="history-overlay" onClick={onClose}>
        <div className="history-panel" onClick={(e) => e.stopPropagation()}>
          <div className="history-loading">
            {agentContext.getUiCopy("workingStateHistoryLoading")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="history-header">
          <h3>{agentContext.getUiCopy("workingStateHistoryTitle")}</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="history-filters">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as WorkingStateType | "")}
          >
            <option value="">{agentContext.getUiCopy("workingStateHistoryAllTypes")}</option>
            <option value="context">Context</option>
            <option value="progress">Progress</option>
            <option value="notes">Notes</option>
            <option value="plan">Plan</option>
          </select>
          <span className="history-count">
            {agentContext.getUiCopy("workingStateHistoryEntries", {
              count: filteredHistory.length,
            })}
          </span>
        </div>

        <div className="history-list">
          {filteredHistory.length === 0 ? (
            <div className="history-empty">
              <p>{agentContext.getUiCopy("workingStateHistoryEmpty")}</p>
            </div>
          ) : (
            Object.entries(groupedHistory).map(([dateKey, items]) => (
              <div key={dateKey} className="history-group">
                <div className="group-header">
                  {new Date(dateKey).toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                </div>
                {items.map((item) => {
                  const config = STATE_TYPE_LABELS[item.stateType];
                  const isExpanded = expandedId === item.id;

                  return (
                    <div
                      key={item.id}
                      className={`history-item ${item.isCurrent ? "current" : ""}`}
                    >
                      <div
                        className="item-header"
                        onClick={() => setExpandedId(isExpanded ? null : item.id)}
                      >
                        <div className="item-info">
                          <span className="item-icon">{config.icon}</span>
                          <span className="item-type">{config.label}</span>
                          <span className="item-time">{formatDate(item.updatedAt)}</span>
                          {item.isCurrent && (
                            <span className="current-badge">
                              {agentContext.getUiCopy("workingStateHistoryCurrent")}
                            </span>
                          )}
                        </div>
                        <span className="expand-icon">{isExpanded ? "▼" : "▶"}</span>
                      </div>

                      {isExpanded && (
                        <div className="item-content">
                          <div className="content-preview">
                            {item.content.length > 500
                              ? item.content.slice(0, 500) + "..."
                              : item.content}
                          </div>
                          {item.fileReferences && item.fileReferences.length > 0 && (
                            <div className="file-refs">
                              <span className="refs-label">
                                {agentContext.getUiCopy("workingStateHistoryFilesLabel")}
                              </span>
                              {item.fileReferences.map((file, idx) => (
                                <span key={idx} className="file-ref">
                                  {file}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="item-actions">
                            {!item.isCurrent && (
                              <button
                                className="restore-btn"
                                onClick={() => handleRestore(item)}
                                disabled={restoring === item.id}
                              >
                                {restoring === item.id
                                  ? agentContext.getUiCopy("workingStateHistoryRestoring")
                                  : agentContext.getUiCopy("workingStateHistoryRestore")}
                              </button>
                            )}
                            <button className="delete-btn" onClick={() => handleDelete(item.id)}>
                              {agentContext.getUiCopy("workingStateHistoryDelete")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <style>{`
          .history-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }

          .history-panel {
            background: var(--color-bg-primary);
            border-radius: 12px;
            width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
          }

          .history-loading {
            padding: 40px;
            text-align: center;
            color: var(--color-text-secondary);
          }

          .history-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--color-border);
          }

          .history-header h3 {
            margin: 0;
            font-size: 16px;
            color: var(--color-text-primary);
          }

          .close-btn {
            background: none;
            border: none;
            color: var(--color-text-secondary);
            cursor: pointer;
            font-size: 18px;
            padding: 4px 8px;
          }

          .history-filters {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            border-bottom: 1px solid var(--color-border);
          }

          .history-filters select {
            padding: 8px 12px;
            border: 1px solid var(--color-border);
            border-radius: 6px;
            background: var(--color-bg-secondary);
            color: var(--color-text-primary);
            font-size: 12px;
          }

          .history-count {
            font-size: 12px;
            color: var(--color-text-muted);
          }

          .history-list {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
          }

          .history-empty {
            text-align: center;
            color: var(--color-text-secondary);
            padding: 40px;
          }

          .history-group {
            margin-bottom: 20px;
          }

          .history-group:last-child {
            margin-bottom: 0;
          }

          .group-header {
            font-size: 12px;
            font-weight: 600;
            color: var(--color-text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
          }

          .history-item {
            background: var(--color-bg-secondary);
            border-radius: 8px;
            margin-bottom: 8px;
            overflow: hidden;
          }

          .history-item.current {
            border-left: 3px solid var(--color-accent);
          }

          .item-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 14px;
            cursor: pointer;
          }

          .item-header:hover {
            background: var(--color-bg-tertiary);
          }

          .item-info {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .item-icon {
            font-size: 14px;
          }

          .item-type {
            font-weight: 500;
            color: var(--color-text-primary);
          }

          .item-time {
            font-size: 11px;
            color: var(--color-text-muted);
          }

          .current-badge {
            font-size: 10px;
            color: var(--color-accent);
            background: var(--color-accent)20;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 500;
          }

          .expand-icon {
            font-size: 10px;
            color: var(--color-text-muted);
          }

          .item-content {
            padding: 0 14px 14px;
          }

          .content-preview {
            font-size: 12px;
            color: var(--color-text-secondary);
            line-height: 1.5;
            white-space: pre-wrap;
            background: var(--color-bg-primary);
            padding: 12px;
            border-radius: 6px;
          }

          .file-refs {
            margin-top: 10px;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
          }

          .refs-label {
            font-size: 11px;
            color: var(--color-text-muted);
          }

          .file-ref {
            font-size: 10px;
            color: var(--color-text-secondary);
            background: var(--color-bg-primary);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--font-mono);
          }

          .item-actions {
            margin-top: 12px;
            display: flex;
            gap: 8px;
          }

          .restore-btn,
          .delete-btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
          }

          .restore-btn {
            background: var(--color-accent);
            color: white;
          }

          .restore-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .delete-btn {
            background: var(--color-bg-tertiary);
            color: var(--color-text-secondary);
          }

          .delete-btn:hover {
            background: #ef4444;
            color: white;
          }
        `}</style>
      </div>
    </div>
  );
}
