import { ALL_WORKSPACES_ID } from "./useMissionControlData";
import type { MissionControlData, MCTab } from "./useMissionControlData";
import { hasHostMethod, hasHostMethods } from "../../host/browser-capabilities";

const TEAM_PANEL_METHODS = [
  "listTeams",
  "listTeamMembers",
  "listTeamRuns",
  "listTeamItems",
  "onTeamRunEvent",
  "createTeam",
  "updateTeam",
  "deleteTeam",
  "addTeamMember",
  "removeTeamMember",
  "updateTeamMember",
  "reorderTeamMembers",
  "createTeamRun",
  "resumeTeamRun",
  "pauseTeamRun",
  "cancelTeamRun",
  "createTeamItem",
  "updateTeamItem",
  "deleteTeamItem",
  "moveTeamItem",
] as const;

const CORE_HARNESS_METHODS = [
  "listCoreFailureRecords",
  "listCoreFailureClusters",
  "listCoreEvalCases",
  "listCoreExperiments",
  "listCoreLearnings",
] as const;

interface MCTopBarProps {
  data: MissionControlData;
  onOpenAgents?: () => void;
}

const TABS: { id: MCTab; label: string; requiresCompany?: boolean }[] = [
  { id: "overview", label: "Brief" },
  { id: "board", label: "Work" },
  { id: "intelligence", label: "Intelligence" },
  { id: "feed", label: "Evidence Feed" },
  { id: "ops", label: "Operations", requiresCompany: true },
];

export function MCTopBar({ data, onOpenAgents }: MCTopBarProps) {
  const {
    workspaces,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedCompanyId,
    activeAgentsCount,
    totalTasksInQueue,
    pendingMentionsCount,
    queueStatusState,
    runtimeRunningCount,
    runtimeQueuedCount,
    runtimeMaxConcurrent,
    isRefreshing,
    handleManualRefresh,
    selectedWorkspace,
    setTeamsOpen,
    activeTab,
    setActiveTab,
    selectedCompany,
    currentTime,
    agentContext,
  } = data;
  const supportsTeams = hasHostMethods(...TEAM_PANEL_METHODS);
  const unavailableBrowserWorkflows =
    typeof window !== "undefined" && window.coworkBrowserHost === true
      ? [
          ...(!supportsTeams ? ["Team management"] : []),
          ...(!hasHostMethod("getCommandCenterSummary") ? ["Command center summaries"] : []),
          ...(!hasHostMethods("getPlannerConfig", "updatePlannerConfig")
            ? ["Planner settings"]
            : []),
          ...(!hasHostMethod("runPlanner") ? ["Planner execution"] : []),
          ...(!hasHostMethod("listPlannerRuns") ? ["Planner run history"] : []),
          ...(!hasHostMethods(...CORE_HARNESS_METHODS) ? ["Core harness review data"] : []),
        ]
      : [];
  const runtimeStatusValue =
    queueStatusState === "ready"
      ? runtimeMaxConcurrent
        ? `${runtimeRunningCount}/${runtimeMaxConcurrent}`
        : String(runtimeRunningCount)
      : "—";
  const runtimeStatusLabel =
    queueStatusState === "loading"
      ? "global runtime loading"
      : queueStatusState === "unavailable" || queueStatusState === "error"
        ? "global runtime unavailable"
        : `global runtime${runtimeQueuedCount > 0 ? ` +${runtimeQueuedCount} waiting` : ""}`;

  return (
    <>
      {/* Top Bar */}
      <header className="mc-v2-topbar">
        <div className="mc-v2-topbar-left">
          <h1>{agentContext.getUiCopy("mcTitle")}</h1>
          <div className="mc-v2-selector">
            <span className="mc-v2-selector-label">
              {agentContext.getUiCopy("mcWorkspaceLabel")}
            </span>
            <select
              value={selectedWorkspaceId || ""}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            >
              <option value={ALL_WORKSPACES_ID}>All Workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mc-v2-stats">
          <span
            className="mc-v2-stat-pill"
            title="Agents enabled for Heartbeat monitoring or automation. They may be idle and are not necessarily running a task."
          >
            <strong>{activeAgentsCount}</strong> heartbeat agents
          </span>
          <span
            className="mc-v2-stat-pill"
            title="Global tasks currently running or waiting for an execution slot. This matches the runtime queue shown in chat."
          >
            <strong>{runtimeStatusValue}</strong>
            {runtimeStatusLabel}
          </span>
          <span
            className="mc-v2-stat-pill"
            title="Open work items tracked on the Mission Control board. This can differ from the live runtime queue."
          >
            <strong>{totalTasksInQueue}</strong> board work
          </span>
          <span
            className="mc-v2-stat-pill"
            title="Mentions waiting for acknowledgement, follow-up, or completion."
          >
            <strong>{pendingMentionsCount}</strong> mentions
          </span>
        </div>
        <div className="mc-v2-topbar-right">
          <button
            className="mc-v2-icon-btn"
            onClick={handleManualRefresh}
            disabled={(!selectedWorkspaceId && !selectedCompanyId) || isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className="mc-v2-icon-btn"
            onClick={() => setTeamsOpen(true)}
            disabled={!selectedWorkspace || !supportsTeams}
            title={
              !selectedWorkspace
                ? "Choose a workspace before opening team management."
                : !supportsTeams
                  ? "Team management is not available in this browser session yet."
                  : undefined
            }
          >
            Teams
          </button>
          <button className="mc-v2-icon-btn" onClick={onOpenAgents}>
            Agents Hub
          </button>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-primary)",
            }}
          >
            {currentTime.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span
            className="mc-v2-online-dot"
            title={agentContext.getUiCopy("mcStatusOnline")}
          ></span>
        </div>
      </header>

      {unavailableBrowserWorkflows.length > 0 && (
        <p className="mc-v2-capability-notice" role="status">
          {unavailableBrowserWorkflows.join(", ")}{" "}
          {unavailableBrowserWorkflows.length === 1 ? "is" : "are"} unavailable because this browser
          host does not expose the required services yet.
        </p>
      )}

      {/* Tab Bar */}
      <nav className="mc-v2-tabbar">
        {TABS.map((tab) => {
          if (tab.requiresCompany && !selectedCompany) return null;
          return (
            <button
              key={tab.id}
              className={`mc-v2-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
    </>
  );
}
