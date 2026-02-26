import React from "react";
import { CheckCircle2, Circle, Loader2, XCircle, ArrowRight } from "lucide-react";

interface WorkflowPhase {
  id: string;
  order: number;
  title: string;
  phaseType: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  taskId?: string;
}

interface WorkflowPipelineViewProps {
  phases: WorkflowPhase[];
  pipelineStatus?: string;
  onRetryPhase?: (phaseId: string) => void;
  onSelectTask?: (taskId: string) => void;
}

const PHASE_TYPE_COLORS: Record<string, string> = {
  research: "#3b82f6",
  create: "#8b5cf6",
  deliver: "#22c55e",
  analyze: "#f59e0b",
  general: "#6b7280",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Circle size={16} style={{ color: "var(--text-tertiary, #555)" }} />,
  running: <Loader2 size={16} style={{ color: "#3b82f6", animation: "spin 1s linear infinite" }} />,
  completed: <CheckCircle2 size={16} style={{ color: "#22c55e" }} />,
  failed: <XCircle size={16} style={{ color: "#ef4444" }} />,
};

export const WorkflowPipelineView: React.FC<WorkflowPipelineViewProps> = ({
  phases,
  pipelineStatus: _pipelineStatus,
  onRetryPhase,
  onSelectTask,
}) => {
  if (!phases || phases.length === 0) return null;

  return (
    <div style={{ padding: "12px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 12,
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-secondary, #999)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        <span>Workflow Pipeline</span>
        <span style={{ fontSize: 11, fontWeight: 400 }}>({phases.length} phases)</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {phases.map((phase, i) => (
          <React.Fragment key={phase.id}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${phase.status === "running" ? "#3b82f6" : "var(--border-color, #333)"}`,
                background:
                  phase.status === "running"
                    ? "var(--accent-bg, #1e3a5f11)"
                    : "var(--surface-secondary, #1a1a1a)",
                cursor: phase.taskId && onSelectTask ? "pointer" : "default",
                transition: "border-color 0.2s",
              }}
              onClick={() => {
                if (phase.taskId && onSelectTask) onSelectTask(phase.taskId);
              }}
            >
              {STATUS_ICONS[phase.status] || STATUS_ICONS.pending}

              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: PHASE_TYPE_COLORS[phase.phaseType] || PHASE_TYPE_COLORS.general,
                  flexShrink: 0,
                }}
              />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color:
                      phase.status === "pending"
                        ? "var(--text-tertiary, #666)"
                        : "var(--text-primary, #e5e5e5)",
                  }}
                >
                  {phase.title}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary, #666)", marginTop: 2 }}>
                  {phase.phaseType}
                  {phase.output && (
                    <span style={{ marginLeft: 8 }}>
                      {phase.output.slice(0, 80)}
                      {phase.output.length > 80 ? "..." : ""}
                    </span>
                  )}
                </div>
              </div>

              {phase.status === "failed" && onRetryPhase && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetryPhase(phase.id);
                  }}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid #ef4444",
                    background: "none",
                    color: "#ef4444",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  Retry
                </button>
              )}
            </div>

            {i < phases.length - 1 && (
              <div style={{ display: "flex", justifyContent: "center", padding: "2px 0" }}>
                <ArrowRight
                  size={14}
                  style={{ color: "var(--text-tertiary, #555)", transform: "rotate(90deg)" }}
                />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
