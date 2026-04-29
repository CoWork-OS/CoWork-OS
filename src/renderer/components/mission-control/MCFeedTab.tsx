import type { MissionControlCategory, MissionControlSeverity } from "../../../shared/types";
import type { MissionControlData } from "./useMissionControlData";

interface MCFeedTabProps {
  data: MissionControlData;
}

const CATEGORY_FILTERS: Array<{ id: "all" | MissionControlCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Attention" },
  { id: "work", label: "Work" },
  { id: "reviews", label: "Reviews" },
  { id: "learnings", label: "Learnings" },
  { id: "awareness", label: "Awareness" },
  { id: "evidence", label: "Evidence" },
];

const SEVERITY_FILTERS: Array<{ id: "all" | MissionControlSeverity; label: string }> = [
  { id: "all", label: "Any status" },
  { id: "action_needed", label: "Action needed" },
  { id: "monitor_only", label: "Monitor only" },
  { id: "successful", label: "Successful" },
  { id: "failed", label: "Failed" },
];

const CATEGORY_LABELS: Record<MissionControlCategory, string> = {
  attention: "Attention",
  work: "Work",
  reviews: "Reviews",
  learnings: "Learnings",
  awareness: "Awareness",
  evidence: "Evidence",
};

const SEVERITY_LABELS: Record<MissionControlSeverity, string> = {
  action_needed: "Action needed",
  monitor_only: "Monitor only",
  successful: "Successful",
  failed: "Failed",
};

function severityTone(severity: MissionControlSeverity): string {
  if (severity === "failed") return "danger";
  if (severity === "action_needed") return "attention";
  if (severity === "successful") return "healthy";
  return "";
}

export function MCFeedTab({ data }: MCFeedTabProps) {
  const {
    missionControlItems,
    missionControlEvidence,
    expandedMissionControlItems,
    feedFilter,
    setFeedFilter,
    feedSeverityFilter,
    setFeedSeverityFilter,
    selectedAgent,
    setSelectedAgent,
    agents,
    formatRelativeTime,
    toggleMissionControlEvidence,
    setDetailPanel,
    isAllWorkspacesSelected,
  } = data;

  const activeAgents = agents.filter((agent) => agent.isActive);

  return (
    <div className="mc-v2-feed mc-v2-evidence-feed">
      <div className="mc-v2-feed-toolbar">
        <div className="mc-v2-feed-filter-stack">
          <div className="mc-v2-feed-filters">
            {CATEGORY_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={`mc-v2-filter-btn ${feedFilter === filter.id ? "active" : ""}`}
                onClick={() => setFeedFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="mc-v2-feed-filters subtle">
            {SEVERITY_FILTERS.map((filter) => (
              <button
                key={filter.id}
                className={`mc-v2-filter-btn ${feedSeverityFilter === filter.id ? "active" : ""}`}
                onClick={() => setFeedSeverityFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mc-v2-feed-agent-chips">
          {activeAgents.map((agent) => (
            <button
              key={agent.id}
              className={`mc-v2-agent-chip ${selectedAgent === agent.id ? "active" : ""}`}
              style={{ borderColor: agent.color }}
              onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
            >
              {agent.displayName.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="mc-v2-feed-list">
        {missionControlItems.length === 0 ? (
          <div className="mc-v2-empty">No grouped Mission Control items yet.</div>
        ) : (
          missionControlItems.map((item) => {
            const expanded = Boolean(expandedMissionControlItems[item.id]);
            const evidence = missionControlEvidence[item.id] || [];
            return (
              <article key={item.id} className={`mc-v2-feed-item mc-v2-intel-item ${severityTone(item.severity)}`}>
                <div className="mc-v2-feed-item-header">
                  <div className="mc-v2-feed-item-meta">
                    <span className={`mc-v2-status-pill ${severityTone(item.severity)}`}>
                      {SEVERITY_LABELS[item.severity]}
                    </span>
                    <span className="mc-v2-brief-kicker">{CATEGORY_LABELS[item.category]}</span>
                    {item.agentName && <span className="mc-v2-feed-agent">{item.agentName}</span>}
                    {isAllWorkspacesSelected && item.workspaceName ? (
                      <span className="mc-v2-workspace-tag">{item.workspaceName}</span>
                    ) : null}
                  </div>
                  <span className="mc-v2-feed-time">{formatRelativeTime(item.timestamp)}</span>
                </div>

                <div className="mc-v2-intel-body">
                  <h3>{item.title}</h3>
                  <p>{item.summary}</p>
                  {(item.decision || item.nextStep) && (
                    <div className="mc-v2-brief-disposition">
                      {item.decision && <span>{item.decision}</span>}
                      {item.nextStep && <strong>{item.nextStep}</strong>}
                    </div>
                  )}
                </div>

                <div className="mc-v2-intel-actions">
                  {item.taskId && (
                    <button className="mc-v2-inline-action" onClick={() => setDetailPanel({ kind: "task", taskId: item.taskId! })}>
                      Open task
                    </button>
                  )}
                  <button className="mc-v2-inline-action" onClick={() => toggleMissionControlEvidence(item.id)}>
                    {expanded ? "Hide evidence" : `Show evidence (${item.evidenceCount})`}
                  </button>
                </div>

                {expanded && (
                  <div className="mc-v2-evidence-list">
                    {evidence.length === 0 ? (
                      <div className="mc-v2-empty mc-v2-empty-compact">No evidence rows loaded.</div>
                    ) : (
                      evidence.map((entry) => (
                        <div key={entry.id} className="mc-v2-evidence-row">
                          <div>
                            <strong>{entry.title}</strong>
                            {entry.summary && <p>{entry.summary}</p>}
                          </div>
                          <div className="mc-v2-evidence-meta">
                            <span>{entry.sourceType.replace(/_/g, " ")}</span>
                            <span>{formatRelativeTime(entry.timestamp)}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
