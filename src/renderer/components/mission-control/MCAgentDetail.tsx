import { getEmojiIcon } from "../../utils/emoji-icon-map";
import { AUTONOMY_BADGES } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";

interface MCAgentDetailProps {
  data: MissionControlData;
  agentId: string;
}

export function MCAgentDetail({ data, agentId }: MCAgentDetailProps) {
  const {
    agents, heartbeatStatuses, tasksByAgent,
    getAgentStatus, handleTriggerHeartbeat, handleEditAgent,
    setDetailPanel, formatRelativeTime, agentContext, isAllWorkspacesSelected, getWorkspaceName,
  } = data;

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return <div className="mc-v2-empty">Agent not found</div>;

  const status = getAgentStatus(agent.id);
  const badge = AUTONOMY_BADGES[agent.autonomyLevel || "specialist"];
  const statusInfo = heartbeatStatuses.find((s) => s.agentRoleId === agent.id);
  const agentTasks = tasksByAgent.get(agent.id) || [];

  return (
    <>
      <div className="mc-v2-agent-detail-header">
        <div className="mc-v2-agent-avatar" style={{ backgroundColor: agent.color }}>
          {(() => { const Icon = getEmojiIcon(agent.icon || "🤖"); return <Icon size={24} strokeWidth={2} />; })()}
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mc-v2-agent-detail-name">{agent.displayName}</span>
            <span className="mc-v2-autonomy-badge" style={{ backgroundColor: badge.color }}>{badge.label}</span>
            <span className={`mc-v2-status-dot ${status}`}></span>
            <span className="mc-v2-status-text">{status}</span>
          </div>
          <div className="mc-v2-agent-detail-desc">{agent.description || agent.name}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="mc-v2-icon-btn" onClick={() => handleEditAgent(agent)}>Edit Agent</button>
        {statusInfo?.heartbeatEnabled && (
          <button className="mc-v2-wake-btn" onClick={() => handleTriggerHeartbeat(agent.id)}>
            {agentContext.getUiCopy("mcWakeAgent")}
          </button>
        )}
      </div>

      {statusInfo && (
        <div className="mc-v2-detail-section">
          <h4>Heartbeat</h4>
          <div className="mc-v2-card-items">
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Status</span>
              <span className="mc-v2-card-item-value">{statusInfo.heartbeatStatus}</span>
            </div>
            {statusInfo.lastHeartbeatAt && (
              <div className="mc-v2-card-item">
                <span className="mc-v2-card-item-label">Last heartbeat</span>
                <span className="mc-v2-card-item-value">{formatRelativeTime(statusInfo.lastHeartbeatAt)}</span>
              </div>
            )}
            {statusInfo.nextHeartbeatAt && (
              <div className="mc-v2-card-item">
                <span className="mc-v2-card-item-label">Next heartbeat</span>
                <span className="mc-v2-card-item-value">{formatRelativeTime(statusInfo.nextHeartbeatAt)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mc-v2-detail-section">
        <h4>Assigned Tasks ({agentTasks.length})</h4>
        <div className="mc-v2-agent-detail-tasks">
          {agentTasks.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{agentContext.getUiCopy("mcNoActiveTask")}</div>
          ) : (
            agentTasks.slice(0, 10).map((task) => (
              <div
                key={task.id}
                className="mc-v2-agent-detail-task"
                onClick={() => setDetailPanel({ kind: "task", taskId: task.id })}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.title}
                  {isAllWorkspacesSelected ? (
                    <span className="mc-v2-agent-detail-task-workspace-inline">
                      {getWorkspaceName(task.workspaceId)}
                    </span>
                  ) : null}
                </span>
                <span className={`mc-v2-status-pill status-${task.status}`}>{task.status.replace("_", " ")}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
