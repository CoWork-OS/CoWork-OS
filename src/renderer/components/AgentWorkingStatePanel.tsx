import { useState, useEffect, useCallback } from "react";
import { AgentWorkingStateData, WorkingStateType, AgentRoleData } from "../../electron/preload";
import { useAgentContext } from "../hooks/useAgentContext";
import { ThemeIcon } from "./ThemeIcon";
import { ChartIcon, ClipboardIcon, EditIcon, TargetIcon } from "./LineIcons";

interface AgentWorkingStatePanelProps {
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  onEdit?: (state: AgentWorkingStateData) => void;
}

const STATE_TYPE_LABELS: Record<
  WorkingStateType,
  { label: string; icon: React.ReactNode; description: string }
> = {
  context: {
    label: "Context",
    icon: <ThemeIcon emoji="📋" icon={<ClipboardIcon size={16} />} />,
    description: "Background information and current understanding",
  },
  progress: {
    label: "Progress",
    icon: <ThemeIcon emoji="📊" icon={<ChartIcon size={16} />} />,
    description: "Current work progress and status",
  },
  notes: {
    label: "Notes",
    icon: <ThemeIcon emoji="📝" icon={<EditIcon size={16} />} />,
    description: "Important observations and reminders",
  },
  plan: {
    label: "Plan",
    icon: <ThemeIcon emoji="🎯" icon={<TargetIcon size={16} />} />,
    description: "Action plan and next steps",
  },
};

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

export function AgentWorkingStatePanel({
  agentRoleId,
  workspaceId,
  taskId,
  onEdit,
}: AgentWorkingStatePanelProps) {
  const [states, setStates] = useState<AgentWorkingStateData[]>([]);
  const [agent, setAgent] = useState<AgentRoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<WorkingStateType | null>(null);
  const agentContext = useAgentContext();

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Load agent info
      const agentData = await window.electronAPI.getAgentRole(agentRoleId);
      setAgent(agentData ?? null);

      // Load all current working states for this agent/workspace
      const stateTypes: WorkingStateType[] = ["context", "progress", "notes", "plan"];
      const loadedStates: AgentWorkingStateData[] = [];

      for (const stateType of stateTypes) {
        const state = await window.electronAPI.getCurrentWorkingState({
          agentRoleId,
          workspaceId,
          taskId,
          stateType,
        });
        if (state) {
          loadedStates.push(state);
        }
      }

      setStates(loadedStates);
    } catch (err) {
      console.error("Failed to load working states:", err);
    } finally {
      setLoading(false);
    }
  }, [agentRoleId, workspaceId, taskId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const getStateByType = (type: WorkingStateType): AgentWorkingStateData | undefined => {
    return states.find((s) => s.stateType === type);
  };

  if (loading) {
    return (
      <div className="working-state-panel loading">
        <p>{agentContext.getUiCopy("workingStateLoading")}</p>
      </div>
    );
  }

  return (
    <div className="working-state-panel">
      <div className="panel-header">
        {agent && (
          <div className="agent-info">
            <span className="agent-avatar" style={{ backgroundColor: agent.color }}>
              {agent.icon}
            </span>
            <div className="agent-details">
              <span className="agent-name">{agent.displayName}</span>
              <span className="agent-context">{agentContext.getUiCopy("workingStateTitle")}</span>
            </div>
          </div>
        )}
      </div>

      <div className="state-sections">
        {(Object.keys(STATE_TYPE_LABELS) as WorkingStateType[]).map((type) => {
          const config = STATE_TYPE_LABELS[type];
          const state = getStateByType(type);
          const isExpanded = expandedType === type;

          return (
            <div
              key={type}
              className={`state-section ${state ? "has-content" : "empty"} ${isExpanded ? "expanded" : ""}`}
            >
              <div
                className="section-header"
                onClick={() => setExpandedType(isExpanded ? null : type)}
              >
                <div className="section-title">
                  <span className="section-icon">{config.icon}</span>
                  <span className="section-name">{config.label}</span>
                  {state && (
                    <span className="section-updated">
                      Updated {formatTimeAgo(state.updatedAt)}
                    </span>
                  )}
                </div>
                <div className="section-actions">
                  {onEdit && (
                    <button
                      className="edit-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (state) {
                          onEdit(state);
                        } else {
                          // Create new state
                          onEdit({
                            id: "",
                            agentRoleId,
                            workspaceId,
                            taskId,
                            stateType: type,
                            content: "",
                            isCurrent: true,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                          });
                        }
                      }}
                    >
                      {state
                        ? agentContext.getUiCopy("workingStateEdit")
                        : agentContext.getUiCopy("workingStateAdd")}
                    </button>
                  )}
                  <span className="expand-icon">{isExpanded ? "▼" : "▶"}</span>
                </div>
              </div>

              {isExpanded && (
                <div className="section-content">
                  {state ? (
                    <>
                      <div className="content-text">{state.content}</div>
                      {state.fileReferences && state.fileReferences.length > 0 && (
                        <div className="file-references">
                          <span className="ref-label">
                            {agentContext.getUiCopy("workingStateReferencedFiles")}
                          </span>
                          {state.fileReferences.map((file, idx) => (
                            <span key={idx} className="file-ref">
                              {file}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>{config.description}</p>
                      <p className="hint">
                        {agentContext.getUiCopy("workingStateEmptyHint", {
                          label: config.label.toLowerCase(),
                        })}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <style>{`
        .working-state-panel {
          background: var(--color-bg-secondary);
          border-radius: 12px;
          overflow: hidden;
        }

        .working-state-panel.loading {
          padding: 40px;
          text-align: center;
          color: var(--color-text-secondary);
        }

        .panel-header {
          padding: 16px;
          border-bottom: 1px solid var(--color-border);
        }

        .agent-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .agent-avatar {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
        }

        .agent-details {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .agent-name {
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .agent-context {
          font-size: 12px;
          color: var(--color-text-muted);
        }

        .state-sections {
          display: flex;
          flex-direction: column;
        }

        .state-section {
          border-bottom: 1px solid var(--color-border);
        }

        .state-section:last-child {
          border-bottom: none;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .section-header:hover {
          background: var(--color-bg-tertiary);
        }

        .section-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .section-icon {
          font-size: 16px;
        }

        .section-name {
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .section-updated {
          font-size: 11px;
          color: var(--color-text-muted);
          margin-left: 8px;
        }

        .section-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .edit-btn {
          padding: 4px 10px;
          font-size: 11px;
          background: var(--color-bg-tertiary);
          border: none;
          border-radius: 4px;
          color: var(--color-text-secondary);
          cursor: pointer;
        }

        .edit-btn:hover {
          background: var(--color-accent);
          color: white;
        }

        .expand-icon {
          font-size: 10px;
          color: var(--color-text-muted);
        }

        .section-content {
          padding: 0 16px 16px 48px;
        }

        .content-text {
          font-size: 13px;
          color: var(--color-text-primary);
          white-space: pre-wrap;
          line-height: 1.6;
        }

        .file-references {
          margin-top: 12px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
        }

        .ref-label {
          font-size: 11px;
          color: var(--color-text-muted);
        }

        .file-ref {
          font-size: 11px;
          color: var(--color-text-secondary);
          background: var(--color-bg-primary);
          padding: 2px 8px;
          border-radius: 4px;
          font-family: var(--font-mono);
        }

        .empty-state {
          color: var(--color-text-muted);
          font-size: 13px;
        }

        .empty-state p {
          margin: 0 0 4px 0;
        }

        .empty-state .hint {
          font-size: 12px;
          opacity: 0.7;
        }

        .state-section.empty .section-name {
          color: var(--color-text-muted);
        }

        .state-section.has-content .section-name {
          color: var(--color-text-primary);
        }

        .state-section.has-content .section-header::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          background: var(--color-accent);
        }

        .state-section {
          position: relative;
        }
      `}</style>
    </div>
  );
}
