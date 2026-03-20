import type { MissionControlData, OpsSubTab } from "./useMissionControlData";

interface MCOpsTabProps {
  data: MissionControlData;
}

const OPS_TABS: { id: OpsSubTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "operators", label: "Operators" },
  { id: "outputs", label: "Outputs & Review" },
  { id: "execution", label: "Execution Map" },
  { id: "planner", label: "Planner" },
];

export function MCOpsTab({ data }: MCOpsTabProps) {
  const {
    opsSubTab, setOpsSubTab,
    selectedCompany, commandCenterSummary,
    commandCenterOutputs, commandCenterReviewQueue,
    commandCenterOperators, commandCenterExecutionMap,
    plannerConfig, plannerRuns, plannerRunning, plannerSaving, plannerLoading,
    selectedPlannerRunId, setSelectedPlannerRunId, selectedPlannerRun,
    plannerRunIssues, setSelectedIssueId, setDetailPanel,
    workspaces, agents,
    handlePlannerConfigChange, handleRunPlanner,
    formatRelativeTime,
  } = data;

  if (!selectedCompany) {
    return <div className="mc-v2-empty">Select a company to view operations.</div>;
  }

  return (
    <div className="mc-v2-ops">
      <nav className="mc-v2-ops-subtabs">
        {OPS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`mc-v2-ops-subtab ${opsSubTab === tab.id ? "active" : ""}`}
            onClick={() => setOpsSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="mc-v2-ops-content">
        {opsSubTab === "overview" && (
          <OpsOverview company={selectedCompany} summary={commandCenterSummary} />
        )}
        {opsSubTab === "operators" && (
          <OpsOperators operators={commandCenterOperators} formatRelativeTime={formatRelativeTime} />
        )}
        {opsSubTab === "outputs" && (
          <OpsOutputs
            outputs={commandCenterOutputs}
            reviewQueue={commandCenterReviewQueue}
            setSelectedIssueId={setSelectedIssueId}
            setDetailPanel={setDetailPanel}
            formatRelativeTime={formatRelativeTime}
            selectedIssueId={data.selectedIssueId}
          />
        )}
        {opsSubTab === "execution" && (
          <OpsExecutionMap
            executionMap={commandCenterExecutionMap}
            setSelectedIssueId={setSelectedIssueId}
            setDetailPanel={setDetailPanel}
            selectedIssueId={data.selectedIssueId}
          />
        )}
        {opsSubTab === "planner" && (
          <OpsPlanner
            config={plannerConfig}
            runs={plannerRuns}
            running={plannerRunning}
            saving={plannerSaving}
            loading={plannerLoading}
            selectedRunId={selectedPlannerRunId}
            setSelectedRunId={setSelectedPlannerRunId}
            selectedRun={selectedPlannerRun}
            runIssues={plannerRunIssues}
            workspaces={workspaces}
            agents={agents}
            onConfigChange={handlePlannerConfigChange}
            onRun={handleRunPlanner}
            setSelectedIssueId={setSelectedIssueId}
            setDetailPanel={setDetailPanel}
            formatRelativeTime={formatRelativeTime}
            selectedIssueId={data.selectedIssueId}
          />
        )}
      </div>
    </div>
  );
}

// ── Ops Overview ──
function OpsOverview({ company, summary }: { company: any; summary: any }) {
  if (!summary) return <div className="mc-v2-empty">Loading operations data...</div>;
  return (
    <div className="mc-v2-ops-kpis">
      <div>
        <p className="mc-v2-ops-company-name">{company.name}</p>
        {company.description && <p className="mc-v2-ops-company-desc">{company.description}</p>}
      </div>
      <div className="mc-v2-ops-stats">
        {[
          { label: "Active goals", value: summary.overview.activeGoalCount },
          { label: "Active projects", value: summary.overview.activeProjectCount },
          { label: "Open issues", value: summary.overview.openIssueCount },
          { label: "Pending review", value: summary.overview.pendingReviewCount },
          { label: "Valuable outputs", value: summary.overview.valuableOutputCount },
        ].map((stat) => (
          <div key={stat.label} className="mc-v2-ops-stat-card">
            <span className="mc-v2-ops-stat-value">{stat.value}</span>
            <span className="mc-v2-ops-stat-label">{stat.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Ops Operators ──
function OpsOperators({ operators, formatRelativeTime }: { operators: any[]; formatRelativeTime: (t?: number) => string }) {
  if (operators.length === 0) return <div className="mc-v2-empty">No operators linked to this company yet.</div>;
  return (
    <div className="mc-v2-ops-operators">
      {operators.map((op: any) => (
        <div key={op.agentRoleId} className="mc-v2-ops-row">
          <div>
            <div className="mc-v2-ops-row-title">
              <span style={{ color: op.color }}>{op.icon} {op.displayName}</span>
            </div>
            <div className="mc-v2-ops-row-subtitle">
              {(op.operatorMandate || "No mandate set") + (op.currentBottleneck ? ` · Bottleneck: ${op.currentBottleneck}` : "")}
            </div>
            <div className="mc-v2-ops-row-subtitle">
              Last useful output {op.lastUsefulOutputAt ? formatRelativeTime(op.lastUsefulOutputAt) : "never"} · heartbeat {op.heartbeatStatus || "idle"}
            </div>
          </div>
          <span className="mc-v2-ops-pill">
            {typeof op.operatorHealthScore === "number" ? `${Math.round(op.operatorHealthScore * 100)} health` : op.activeLoop || "idle"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Ops Outputs & Review ──
function OpsOutputs({ outputs, reviewQueue, setSelectedIssueId, setDetailPanel, formatRelativeTime, selectedIssueId }: any) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h3 style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: "var(--color-text-secondary)", textTransform: "uppercase" as const }}>Operations Feed</h3>
        <div className="mc-v2-ops-list">
          {outputs.length === 0 ? (
            <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No valuable outputs yet.</div>
          ) : (
            outputs.map((output: any) => (
              <button
                key={output.id}
                type="button"
                className={`mc-v2-ops-row mc-v2-ops-row-btn ${selectedIssueId === output.issueId ? "selected" : ""}`}
                onClick={() => {
                  if (output.issueId) {
                    setSelectedIssueId(output.issueId);
                    setDetailPanel({ kind: "issue", issueId: output.issueId });
                  }
                }}
              >
                <div>
                  <div className="mc-v2-ops-row-title">{output.title}</div>
                  <div className="mc-v2-ops-row-subtitle">{output.outputType} · {output.valueReason}</div>
                  {(output.whatChanged || output.nextStep) && (
                    <div className="mc-v2-ops-row-subtitle">{[output.whatChanged, output.nextStep].filter(Boolean).join(" · ")}</div>
                  )}
                </div>
                <span className={`mc-v2-ops-pill status-${output.status || "idle"}`}>
                  {output.reviewRequired ? "review" : output.outputType}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      <div>
        <h3 style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: "var(--color-text-secondary)", textTransform: "uppercase" as const }}>Review Queue</h3>
        <div className="mc-v2-ops-list">
          {reviewQueue.length === 0 ? (
            <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No human review gates queued.</div>
          ) : (
            reviewQueue.map((item: any) => (
              <button
                key={item.id}
                type="button"
                className={`mc-v2-ops-row mc-v2-ops-row-btn ${selectedIssueId === item.issueId ? "selected" : ""}`}
                onClick={() => {
                  if (item.issueId) {
                    setSelectedIssueId(item.issueId);
                    setDetailPanel({ kind: "issue", issueId: item.issueId });
                  }
                }}
              >
                <div>
                  <div className="mc-v2-ops-row-title">{item.title}</div>
                  <div className="mc-v2-ops-row-subtitle">{item.reviewReason} · {item.outputType || item.sourceType}</div>
                  {item.summary && <div className="mc-v2-ops-row-subtitle">{item.summary}</div>}
                </div>
                <span className="mc-v2-ops-pill">{formatRelativeTime(item.createdAt)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Ops Execution Map ──
function OpsExecutionMap({ executionMap, setSelectedIssueId, setDetailPanel, selectedIssueId }: any) {
  if (executionMap.length === 0) return <div className="mc-v2-empty">No execution lineage yet.</div>;
  return (
    <div className="mc-v2-ops-execution-map">
      {executionMap.slice(0, 20).map((entry: any) => (
        <button
          key={entry.issueId}
          type="button"
          className={`mc-v2-ops-row mc-v2-ops-row-btn ${selectedIssueId === entry.issueId ? "selected" : ""}`}
          onClick={() => {
            setSelectedIssueId(entry.issueId);
            setDetailPanel({ kind: "issue", issueId: entry.issueId });
          }}
        >
          <div>
            <div className="mc-v2-ops-row-title">{entry.issueTitle}</div>
            <div className="mc-v2-ops-row-subtitle">
              {[entry.goalTitle, entry.projectName, entry.outputType, entry.taskStatus ? `task:${entry.taskStatus}` : undefined].filter(Boolean).join(" · ")}
            </div>
          </div>
          <span className={`mc-v2-ops-pill status-${entry.issueStatus}`}>{entry.stale ? "stale" : entry.issueStatus}</span>
        </button>
      ))}
    </div>
  );
}

// ── Ops Planner ──
function OpsPlanner({
  config, runs, running, saving, loading,
  selectedRunId, setSelectedRunId, selectedRun, runIssues,
  workspaces, agents, onConfigChange, onRun,
  setSelectedIssueId, setDetailPanel, formatRelativeTime, selectedIssueId,
}: any) {
  return (
    <div className="mc-v2-planner-config">
      <div className="mc-v2-planner-status-row">
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Strategic Planner</h3>
        <span className={`mc-v2-planner-status-badge ${config?.enabled ? "enabled" : "disabled"}`}>
          {config?.enabled ? "Enabled" : "Disabled"}
        </span>
        {saving && <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Saving...</span>}
        {loading && <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Loading...</span>}
      </div>

      {config && (
        <div className="mc-v2-planner-fields">
          <label className="mc-v2-planner-field checkbox">
            <input type="checkbox" checked={config.enabled} onChange={(e) => void onConfigChange({ enabled: e.target.checked })} />
            <span>Schedule runs</span>
          </label>
          <label className="mc-v2-planner-field checkbox">
            <input type="checkbox" checked={config.autoDispatch} onChange={(e) => void onConfigChange({ autoDispatch: e.target.checked })} />
            <span>Auto-dispatch</span>
          </label>
          <label className="mc-v2-planner-field">
            <span>Interval</span>
            <input type="number" min={5} step={5} value={config.intervalMinutes}
              onChange={(e) => void onConfigChange({ intervalMinutes: Math.max(5, Number(e.target.value) || 5) })} />
          </label>
          <label className="mc-v2-planner-field">
            <span>Workspace</span>
            <select value={config.planningWorkspaceId || ""} onChange={(e) => void onConfigChange({ planningWorkspaceId: e.target.value || null })}>
              <option value="">None</option>
              {workspaces.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="mc-v2-planner-field">
            <span>Agent</span>
            <select value={config.plannerAgentRoleId || ""} onChange={(e) => void onConfigChange({ plannerAgentRoleId: e.target.value || null })}>
              <option value="">Auto-pick</option>
              {agents.filter((a: any) => a.isActive).map((a: any) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
            </select>
          </label>
          <label className="mc-v2-planner-field">
            <span>Approval</span>
            <select value={config.approvalPreset} onChange={(e) => void onConfigChange({ approvalPreset: e.target.value })}>
              <option value="manual">Manual</option>
              <option value="safe_autonomy">Safe autonomy</option>
              <option value="founder_edge">Founder edge</option>
            </select>
          </label>
          <button className="mc-v2-icon-btn" onClick={() => void onRun()} disabled={running}>
            {running ? "Running..." : "Run Planner"}
          </button>
        </div>
      )}

      <div className="mc-v2-detail-section">
        <h4>Recent Runs</h4>
        <div className="mc-v2-planner-runs">
          {runs.length === 0 ? (
            <div className="mc-v2-empty" style={{ padding: "12px 0" }}>No planner runs yet.</div>
          ) : (
            runs.map((run: any) => (
              <button
                key={run.id}
                className={`mc-v2-planner-run ${selectedRunId === run.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  const md = run.metadata as any;
                  const nextId = md?.createdIssueIds?.[0] || md?.updatedIssueIds?.[0];
                  if (nextId) {
                    setSelectedIssueId(nextId);
                    setDetailPanel({ kind: "issue", issueId: nextId });
                  }
                }}
                type="button"
              >
                <div className="mc-v2-planner-run-main">
                  <span className={`mc-v2-planner-run-status ${run.status}`}>{run.status}</span>
                  <span className="mc-v2-planner-run-summary">
                    {run.summary || `${run.createdIssueCount} created, ${run.dispatchedTaskCount} dispatched`}
                  </span>
                </div>
                <span className="mc-v2-planner-run-time">
                  {new Date(run.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {selectedRun && (
        <div className="mc-v2-planner-run-detail">
          <div className="mc-v2-ops-row">
            <div>
              <div className="mc-v2-ops-row-title">{selectedRun.summary || "Planner cycle"}</div>
              <div className="mc-v2-ops-row-subtitle">{selectedRun.trigger} · {formatRelativeTime(selectedRun.createdAt)}</div>
            </div>
            <span className={`mc-v2-ops-pill status-${selectedRun.status}`}>{selectedRun.status}</span>
          </div>
          <div className="mc-v2-planner-run-metrics">
            <span>{selectedRun.createdIssueCount} created</span>
            <span>{selectedRun.updatedIssueCount} updated</span>
            <span>{selectedRun.dispatchedTaskCount} dispatched</span>
          </div>
          <div className="mc-v2-ops-list">
            {runIssues.length === 0 ? (
              <div className="mc-v2-empty" style={{ padding: "8px 0" }}>No issue details for this planner cycle.</div>
            ) : (
              runIssues.map((issue: any) => (
                <button
                  key={issue.id}
                  type="button"
                  className={`mc-v2-ops-row mc-v2-ops-row-btn ${selectedIssueId === issue.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedIssueId(issue.id);
                    setDetailPanel({ kind: "issue", issueId: issue.id });
                  }}
                >
                  <div>
                    <div className="mc-v2-ops-row-title">{issue.title}</div>
                    <div className="mc-v2-ops-row-subtitle">{issue.projectId ? "Project-linked" : "Goal-linked"}</div>
                  </div>
                  <span className={`mc-v2-ops-pill status-${issue.status}`}>{issue.status}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
