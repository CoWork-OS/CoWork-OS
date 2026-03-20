import type { MissionControlData } from "./useMissionControlData";
import { BOARD_COLUMNS } from "./useMissionControlData";

interface MCOverviewTabProps {
  data: MissionControlData;
}

export function MCOverviewTab({ data }: MCOverviewTabProps) {
  const {
    activeAgentsCount, totalTasksInQueue, pendingMentionsCount,
    agents, tasks, getTasksByColumn,
    commandCenterSummary, commandCenterReviewQueue,
    selectedCompany, plannerConfig, plannerRuns,
    feedItems, setActiveTab, setOpsSubTab, getAgentStatus,
    agentContext, formatRelativeTime,
  } = data;

  const reviewCount = commandCenterReviewQueue.length;
  const attentionCount = reviewCount + pendingMentionsCount + tasks.filter((t) => t.status === "blocked").length;

  const workingAgents = agents
    .filter((a) => a.isActive && getAgentStatus(a.id) === "working")
    .slice(0, 4);

  const lastRun = plannerRuns[0];

  return (
    <div className="mc-v2-overview">
      {/* Needs Attention */}
      <div className="mc-v2-card" onClick={() => setActiveTab("feed")}>
        <div className="mc-v2-card-header">
          <span className="mc-v2-card-title">Needs Attention</span>
          {attentionCount > 0 && <span className="mc-v2-card-badge attention">{attentionCount}</span>}
        </div>
        <div className="mc-v2-card-value">{attentionCount}</div>
        <div className="mc-v2-card-items">
          <div className="mc-v2-card-item">
            <span className="mc-v2-card-item-label">Pending reviews</span>
            <span className="mc-v2-card-item-value">{reviewCount}</span>
          </div>
          <div className="mc-v2-card-item">
            <span className="mc-v2-card-item-label">Unread mentions</span>
            <span className="mc-v2-card-item-value">{pendingMentionsCount}</span>
          </div>
          <div className="mc-v2-card-item">
            <span className="mc-v2-card-item-label">Blocked tasks</span>
            <span className="mc-v2-card-item-value">{tasks.filter((t) => t.status === "blocked").length}</span>
          </div>
        </div>
      </div>

      {/* Active Work */}
      <div className="mc-v2-card" onClick={() => setActiveTab("agents")}>
        <div className="mc-v2-card-header">
          <span className="mc-v2-card-title">Active Work</span>
          <span className="mc-v2-card-badge healthy">{activeAgentsCount} active</span>
        </div>
        <div className="mc-v2-card-value">{activeAgentsCount}</div>
        <div className="mc-v2-card-items">
          {workingAgents.length === 0 ? (
            <div className="mc-v2-card-item" style={{ color: "var(--color-text-muted)" }}>No agents working</div>
          ) : (
            workingAgents.map((a) => (
              <div key={a.id} className="mc-v2-card-item">
                <span className="mc-v2-card-item-label">
                  <span style={{ color: a.color }}>{a.icon}</span> {a.displayName}
                </span>
                <span className="mc-v2-card-item-value" style={{ fontSize: 10, fontWeight: 400 }}>working</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Task Pipeline */}
      <div className="mc-v2-card" onClick={() => setActiveTab("board")}>
        <div className="mc-v2-card-header">
          <span className="mc-v2-card-title">Task Pipeline</span>
          <span className="mc-v2-card-badge">{totalTasksInQueue} in queue</span>
        </div>
        <div className="mc-v2-pipeline-bar">
          {BOARD_COLUMNS.map((col) => {
            const count = getTasksByColumn(col.id).length;
            if (count === 0) return null;
            return (
              <div
                key={col.id}
                className="mc-v2-pipeline-segment"
                style={{ flex: count, backgroundColor: col.color }}
                title={`${col.label}: ${count}`}
              >
                {count}
              </div>
            );
          })}
          {totalTasksInQueue === 0 && tasks.length === 0 && (
            <div style={{ flex: 1, background: "var(--color-bg-tertiary)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--color-text-muted)" }}>
              Empty
            </div>
          )}
        </div>
        <div className="mc-v2-card-items">
          {BOARD_COLUMNS.map((col) => (
            <div key={col.id} className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.color, display: "inline-block" }}></span>
                {col.label}
              </span>
              <span className="mc-v2-card-item-value">{getTasksByColumn(col.id).length}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="mc-v2-card" onClick={() => setActiveTab("feed")}>
        <div className="mc-v2-card-header">
          <span className="mc-v2-card-title">Recent Activity</span>
        </div>
        <div className="mc-v2-card-items">
          {feedItems.slice(0, 5).map((item) => (
            <div key={item.id} className="mc-v2-card-item">
              <span className="mc-v2-card-item-label" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <strong>{item.agentName}</strong> {item.content.slice(0, 50)}
              </span>
              <span style={{ fontSize: 10, color: "var(--color-text-muted)", flexShrink: 0 }}>
                {formatRelativeTime(item.timestamp)}
              </span>
            </div>
          ))}
          {feedItems.length === 0 && (
            <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>{agentContext.getUiCopy("mcFeedEmpty")}</div>
          )}
        </div>
      </div>

      {/* Planner Health */}
      {selectedCompany && (
        <div className="mc-v2-card" onClick={() => { setActiveTab("ops"); setOpsSubTab("planner"); }}>
          <div className="mc-v2-card-header">
            <span className="mc-v2-card-title">Planner Health</span>
            <span className={`mc-v2-card-badge ${plannerConfig?.enabled ? "healthy" : ""}`}>
              {plannerConfig?.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div className="mc-v2-card-items">
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Last run</span>
              <span className="mc-v2-card-item-value">{lastRun ? formatRelativeTime(lastRun.createdAt) : "never"}</span>
            </div>
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Total runs</span>
              <span className="mc-v2-card-item-value">{plannerRuns.length}</span>
            </div>
            {lastRun && (
              <div className="mc-v2-card-item">
                <span className="mc-v2-card-item-label">Last result</span>
                <span className="mc-v2-card-item-value">{lastRun.createdIssueCount} created, {lastRun.dispatchedTaskCount} dispatched</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Operations Summary */}
      {selectedCompany && commandCenterSummary && (
        <div className="mc-v2-card" onClick={() => { setActiveTab("ops"); setOpsSubTab("overview"); }}>
          <div className="mc-v2-card-header">
            <span className="mc-v2-card-title">Operations</span>
          </div>
          <div className="mc-v2-card-items">
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Open issues</span>
              <span className="mc-v2-card-item-value">{commandCenterSummary.overview.openIssueCount}</span>
            </div>
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Pending review</span>
              <span className="mc-v2-card-item-value">{commandCenterSummary.overview.pendingReviewCount}</span>
            </div>
            <div className="mc-v2-card-item">
              <span className="mc-v2-card-item-label">Valuable outputs</span>
              <span className="mc-v2-card-item-value">{commandCenterSummary.overview.valuableOutputCount}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
