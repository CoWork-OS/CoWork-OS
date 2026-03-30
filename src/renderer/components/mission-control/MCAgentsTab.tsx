import { Plus } from "lucide-react";
import { getEmojiIcon } from "../../utils/emoji-icon-map";
import { AUTONOMY_BADGES } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";

interface MCAgentsTabProps {
  data: MissionControlData;
}

export function MCAgentsTab({ data }: MCAgentsTabProps) {
  const {
    agents, heartbeatStatuses, tasksByAgent,
    detailPanel, setDetailPanel,
    getAgentStatus, handleTriggerHeartbeat,
    handleCreateAgent, handleEditAgent,
    formatRelativeTime, agentContext, isAllWorkspacesSelected, getWorkspaceName,
  } = data;

  const activeAgents = agents.filter((a) => a.isActive);

  return (
    <div className="mc-v2-agents">
      {activeAgents.map((agent) => {
        const status = getAgentStatus(agent.id);
        const badge = AUTONOMY_BADGES[agent.autonomyLevel || "specialist"];
        const statusInfo = heartbeatStatuses.find((s) => s.agentRoleId === agent.id);
        const agentTasks = tasksByAgent.get(agent.id) || [];
        const currentTask = agentTasks[0];
        const isSelected = detailPanel?.kind === "agent" && detailPanel.agentId === agent.id;

        return (
          <div
            key={agent.id}
            className={`mc-v2-agent-card ${isSelected ? "selected" : ""}`}
            onClick={() => setDetailPanel(isSelected ? null : { kind: "agent", agentId: agent.id })}
            onDoubleClick={() => handleEditAgent(agent)}
            role="button"
            tabIndex={0}
          >
            <div className="mc-v2-agent-avatar" style={{ backgroundColor: agent.color }}>
              {(() => { const Icon = getEmojiIcon(agent.icon || "🤖"); return <Icon size={20} strokeWidth={2} />; })()}
            </div>
            <div className="mc-v2-agent-info">
              <div className="mc-v2-agent-name-row">
                <span className="mc-v2-agent-name">{agent.displayName}</span>
                <span className="mc-v2-autonomy-badge" style={{ backgroundColor: badge.color }}>{badge.label}</span>
              </div>
              <span className="mc-v2-agent-desc">{agent.description?.slice(0, 40) || agent.name}</span>
              <span className="mc-v2-agent-task">{currentTask ? currentTask.title : agentContext.getUiCopy("mcNoActiveTask")}</span>
              {isAllWorkspacesSelected && currentTask ? (
                <span className="mc-v2-agent-task-workspace">{getWorkspaceName(currentTask.workspaceId)}</span>
              ) : null}
            </div>
            <div className="mc-v2-agent-right">
              <div className="mc-v2-status-dot-row">
                <span className={`mc-v2-status-dot ${status}`}></span>
                <span className="mc-v2-status-text">{status}</span>
              </div>
              {statusInfo?.nextHeartbeatAt && (
                <span style={{ fontSize: 9, color: "var(--color-text-muted)" }}>
                  {agentContext.getUiCopy("mcHeartbeatNext", { time: formatRelativeTime(statusInfo.nextHeartbeatAt) })}
                </span>
              )}
              {statusInfo?.heartbeatEnabled && (
                <button
                  className="mc-v2-wake-btn"
                  onClick={(e) => { e.stopPropagation(); handleTriggerHeartbeat(agent.id); }}
                >
                  {agentContext.getUiCopy("mcWakeAgent")}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <button className="mc-v2-add-agent-btn" onClick={handleCreateAgent}>
        <Plus size={16} strokeWidth={2} />
        {agentContext.getUiCopy("mcAddAgent")}
      </button>
    </div>
  );
}
