import { ALL_WORKSPACES_ID } from "./useMissionControlData";
import { isTempWorkspaceId } from "../../../shared/types";
import type { MissionControlData, MCTab } from "./useMissionControlData";

interface MCTopBarProps {
  data: MissionControlData;
  onOpenAgents?: () => void;
}

const TABS: { id: MCTab; label: string; requiresCompany?: boolean }[] = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "board", label: "Board" },
  { id: "feed", label: "Feed" },
  { id: "ops", label: "Operations", requiresCompany: true },
];

export function MCTopBar({ data, onOpenAgents }: MCTopBarProps) {
  const {
    workspaces, selectedWorkspaceId, setSelectedWorkspaceId,
    companies, selectedCompanyId, setSelectedCompanyId,
    activeAgentsCount, totalTasksInQueue, pendingMentionsCount,
    isRefreshing, handleManualRefresh, selectedWorkspace,
    setStandupOpen, setTeamsOpen, setReviewsOpen,
    activeTab, setActiveTab, selectedCompany,
    currentTime, agentContext,
  } = data;
  const supportsWorkspaceReports =
    !!selectedWorkspace && !isTempWorkspaceId(selectedWorkspace.id);

  return (
    <>
      {/* Top Bar */}
      <header className="mc-v2-topbar">
        <div className="mc-v2-topbar-left">
          <h1>{agentContext.getUiCopy("mcTitle")}</h1>
          <div className="mc-v2-selector">
            <span className="mc-v2-selector-label">{agentContext.getUiCopy("mcWorkspaceLabel")}</span>
            <select value={selectedWorkspaceId || ""} onChange={(e) => setSelectedWorkspaceId(e.target.value)}>
              <option value={ALL_WORKSPACES_ID}>All Workspaces</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          {companies.length > 0 && (
            <div className="mc-v2-selector">
              <span className="mc-v2-selector-label">Company</span>
              <select value={selectedCompanyId || ""} onChange={(e) => setSelectedCompanyId(e.target.value)}>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="mc-v2-stats">
          <span className="mc-v2-stat-pill"><strong>{activeAgentsCount}</strong> active</span>
          <span className="mc-v2-stat-pill"><strong>{totalTasksInQueue}</strong> tasks</span>
          <span className="mc-v2-stat-pill"><strong>{pendingMentionsCount}</strong> mentions</span>
        </div>
        <div className="mc-v2-topbar-right">
          <button
            className="mc-v2-icon-btn"
            onClick={handleManualRefresh}
            disabled={(!selectedWorkspaceId && !selectedCompanyId) || isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button className="mc-v2-icon-btn" onClick={() => setTeamsOpen(true)} disabled={!selectedWorkspace}>Teams</button>
          <button
            className="mc-v2-icon-btn"
            onClick={() => setReviewsOpen(true)}
            disabled={!supportsWorkspaceReports}
          >
            Reviews
          </button>
          <button
            className="mc-v2-icon-btn"
            onClick={() => setStandupOpen(true)}
            disabled={!supportsWorkspaceReports}
          >
            {agentContext.getUiCopy("mcStandupButton")}
          </button>
          <button className="mc-v2-icon-btn" onClick={onOpenAgents}>
            Agents Hub
          </button>
          <span style={{ fontSize: 13, fontWeight: 500, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
            {currentTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <span className="mc-v2-online-dot" title={agentContext.getUiCopy("mcStatusOnline")}></span>
        </div>
      </header>

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
