import "./mission-control.css";
import { isTempWorkspaceId } from "../../../shared/types";
import { useMissionControlData } from "./useMissionControlData";
import { MCTopBar } from "./MCTopBar";
import { MCOverviewTab } from "./MCOverviewTab";
import { MCAgentsTab } from "./MCAgentsTab";
import { MCBoardTab } from "./MCBoardTab";
import { MCFeedTab } from "./MCFeedTab";
import { MCOpsTab } from "./MCOpsTab";
import { MCDetailPanel } from "./MCDetailPanel";
import { AgentRoleEditor } from "../AgentRoleEditor";
import { StandupReportViewer } from "../StandupReportViewer";
import { AgentTeamsPanel } from "../AgentTeamsPanel";
import { AgentPerformanceReviewViewer } from "../AgentPerformanceReviewViewer";

interface MissionControlPanelProps {
  onClose?: () => void;
  onOpenAgents?: () => void;
  initialCompanyId?: string | null;
  /** When opening from Inbox Agent (or elsewhere), focus this issue in Ops. */
  initialIssueId?: string | null;
}

export function MissionControlPanel({
  onClose: _onClose,
  onOpenAgents,
  initialCompanyId = null,
  initialIssueId = null,
}: MissionControlPanelProps) {
  const data = useMissionControlData(initialCompanyId, initialIssueId);

  const {
    loading, activeTab,
    editingAgent, setEditingAgent, isCreatingAgent, agentError, handleSaveAgent,
    standupOpen, setStandupOpen, selectedWorkspace,
    teamsOpen, setTeamsOpen, agents, tasks, setDetailPanel,
    reviewsOpen, setReviewsOpen,
    agentContext, detailPanel,
  } = data;
  const supportsWorkspaceReports =
    !!selectedWorkspace && !isTempWorkspaceId(selectedWorkspace.id);

  if (loading) {
    return (
      <div className="mc-v2">
        <div className="mc-v2-loading">{agentContext.getUiCopy("mcLoading")}</div>
      </div>
    );
  }

  if (editingAgent) {
    return (
      <div className="mc-v2">
        <div className="mc-v2-editor-overlay">
          <div className="mc-v2-editor-modal">
            <AgentRoleEditor
              role={editingAgent}
              isCreating={isCreatingAgent}
              onSave={handleSaveAgent}
              onCancel={() => { setEditingAgent(null); }}
              error={agentError}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-v2">
      <MCTopBar data={data} onOpenAgents={onOpenAgents} />

      <div className="mc-v2-body">
        <div className="mc-v2-tab-content">
          {activeTab === "overview" && <MCOverviewTab data={data} />}
          {activeTab === "agents" && <MCAgentsTab data={data} />}
          {activeTab === "board" && <MCBoardTab data={data} />}
          {activeTab === "feed" && <MCFeedTab data={data} />}
          {activeTab === "ops" && <MCOpsTab data={data} />}
        </div>
        {detailPanel && <MCDetailPanel data={data} />}
      </div>

      {/* Modals */}
      {standupOpen && supportsWorkspaceReports && selectedWorkspace && (
        <div className="mc-v2-editor-overlay">
          <div className="mc-v2-editor-modal mc-v2-standup-modal">
            <StandupReportViewer
              workspaceId={selectedWorkspace.id}
              onClose={() => setStandupOpen(false)}
            />
          </div>
        </div>
      )}

      {teamsOpen && selectedWorkspace && (
        <div className="mc-v2-editor-overlay">
          <div className="mc-v2-editor-modal mc-v2-standup-modal">
            <AgentTeamsPanel
              workspaceId={selectedWorkspace.id}
              agents={agents}
              tasks={tasks}
              onOpenTask={(taskId) => {
                setDetailPanel({ kind: "task", taskId });
                setTeamsOpen(false);
              }}
            />
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", padding: "0 16px 16px" }}>
              <button className="mc-v2-icon-btn" onClick={() => setTeamsOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {reviewsOpen && supportsWorkspaceReports && selectedWorkspace && (
        <div className="mc-v2-editor-overlay">
          <div className="mc-v2-editor-modal mc-v2-standup-modal">
            <AgentPerformanceReviewViewer
              workspaceId={selectedWorkspace.id}
              agents={agents}
              onClose={() => setReviewsOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
