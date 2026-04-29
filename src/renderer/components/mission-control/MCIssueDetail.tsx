import { useEffect } from "react";
import type { MissionControlData } from "./useMissionControlData";

interface MCIssueDetailProps {
  data: MissionControlData;
  issueId: string;
}

export function MCIssueDetail({ data, issueId }: MCIssueDetailProps) {
  const {
    issues, goals, projects,
    issueComments, issueRuns, runEvents,
    selectedIssueRunId, setSelectedIssueRunId,
    selectedIssueRun, setDetailPanel,
    getAgent, formatRelativeTime,
    setSelectedIssueId,
  } = data;

  const issue = issues.find((i) => i.id === issueId);

  useEffect(() => {
    if (issueId !== data.selectedIssueId) {
      setSelectedIssueId(issueId);
    }
  }, [data.selectedIssueId, issueId, setSelectedIssueId]);

  if (!issue) return <div className="mc-v2-empty">Issue not found</div>;

  const goalName = issue.goalId ? goals.find((g) => g.id === issue.goalId)?.title : "No goal";
  const projectName = issue.projectId ? projects.find((p) => p.id === issue.projectId)?.name : "No project";
  const sourceLabel =
    issue.metadata?.source === "mailbox_handoff"
      ? "Inbox"
      : issue.metadata?.source === "strategic_planner"
        ? "Planner"
        : null;

  return (
    <>
      <div>
        <div className="mc-v2-task-detail-title">
          <h3>{issue.title}</h3>
          {sourceLabel && <span className="mc-v2-ops-pill">{sourceLabel}</span>}
          <span className={`mc-v2-ops-pill status-${issue.status}`}>{issue.status}</span>
        </div>
        <div className="mc-v2-detail-updated">
          {goalName || "No goal"} &middot; {projectName || "No project"}
        </div>
      </div>

      {issue.description && (
        <div className="mc-v2-detail-section">
          <h4>Description</h4>
          <p className="mc-v2-detail-brief">{issue.description}</p>
        </div>
      )}

      {issue.taskId && (
        <button
          className="mc-v2-icon-btn"
          onClick={async () => {
            const task = await window.electronAPI.getTask(issue.taskId!);
            if (task) setDetailPanel({ kind: "task", taskId: task.id });
          }}
        >
          Open linked task
        </button>
      )}

      <div className="mc-v2-detail-section">
        <h4>Comments ({issueComments.length})</h4>
        <div className="mc-v2-ops-list">
          {issueComments.length === 0 ? (
            <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No comments yet</div>
          ) : (
            issueComments.slice(-6).map((c) => (
              <div key={c.id} className="mc-v2-ops-row">
                <div>
                  <div className="mc-v2-ops-row-title">
                    {c.authorType === "agent" ? getAgent(c.authorAgentRoleId)?.displayName || "Agent" : c.authorType}
                  </div>
                  <div className="mc-v2-ops-row-subtitle">{c.body}</div>
                </div>
                <span className="mc-v2-ops-pill">{formatRelativeTime(c.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mc-v2-detail-section">
        <h4>Recent Runs ({issueRuns.length})</h4>
        <div className="mc-v2-ops-list">
          {issueRuns.length === 0 ? (
            <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No runs yet</div>
          ) : (
            issueRuns.slice(0, 6).map((run) => (
              <button
                key={run.id}
                type="button"
                className={`mc-v2-ops-row mc-v2-ops-row-btn ${selectedIssueRunId === run.id ? "selected" : ""}`}
                onClick={() => setSelectedIssueRunId(run.id)}
              >
                <div>
                  <div className="mc-v2-ops-row-title">{run.summary || `Run ${run.id.slice(0, 8)}`}</div>
                  <div className="mc-v2-ops-row-subtitle">
                    {formatRelativeTime(run.updatedAt)}{run.taskId ? " · task linked" : ""}
                  </div>
                </div>
                <span className={`mc-v2-ops-pill status-${run.status}`}>{run.status}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {selectedIssueRun && (
        <div className="mc-v2-detail-section">
          <h4>Run Timeline</h4>
          <div className="mc-v2-planner-run-metrics">
            <span>{selectedIssueRun.taskId ? "Task linked" : "No task"}</span>
            <span>{selectedIssueRun.agentRoleId ? "Agent assigned" : "Unassigned"}</span>
          </div>
          <div className="mc-v2-ops-list">
            {runEvents.length === 0 ? (
              <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No events</div>
            ) : (
              runEvents.slice(-8).map((ev) => (
                <div key={ev.id} className="mc-v2-ops-row">
                  <div>
                    <div className="mc-v2-ops-row-title">{ev.type}</div>
                    <div className="mc-v2-ops-row-subtitle">
                      {Object.entries(ev.payload || {}).slice(0, 2).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
                    </div>
                  </div>
                  <span className="mc-v2-ops-pill">{formatRelativeTime(ev.timestamp)}</span>
                </div>
              ))
            )}
          </div>
          {selectedIssueRun.error && (
            <div className="mc-v2-ops-row">
              <div>
                <div className="mc-v2-ops-row-title">Error</div>
                <div className="mc-v2-ops-row-subtitle">{selectedIssueRun.error}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
