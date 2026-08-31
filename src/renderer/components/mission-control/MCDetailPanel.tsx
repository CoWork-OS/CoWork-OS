import { useEffect } from "react";
import { X } from "lucide-react";
import { MCTaskDetail } from "./MCTaskDetail";
import { MCAgentDetail } from "./MCAgentDetail";
import { MCIssueDetail } from "./MCIssueDetail";
import type { MissionControlData } from "./useMissionControlData";

interface MCDetailPanelProps {
  data: MissionControlData;
}

export function MCDetailPanel({ data }: MCDetailPanelProps) {
  const { detailPanel, setDetailPanel } = data;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailPanel(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setDetailPanel]);

  if (!detailPanel) return null;

  const typeLabel =
    detailPanel.kind === "task" ? "Task" : detailPanel.kind === "agent" ? "Agent" : "Issue";

  return (
    <aside className="mc-v2-detail-panel">
      <div className="mc-v2-detail-header">
        <div className="mc-v2-detail-header-left">
          <span className="mc-v2-detail-type">{typeLabel}</span>
        </div>
        <button
          className="mc-v2-detail-close"
          onClick={() => setDetailPanel(null)}
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mc-v2-detail-body">
        {detailPanel.kind === "task" && <MCTaskDetail data={data} taskId={detailPanel.taskId} />}
        {detailPanel.kind === "agent" && (
          <MCAgentDetail data={data} agentId={detailPanel.agentId} />
        )}
        {detailPanel.kind === "issue" && (
          <MCIssueDetail data={data} issueId={detailPanel.issueId} />
        )}
      </div>
    </aside>
  );
}
