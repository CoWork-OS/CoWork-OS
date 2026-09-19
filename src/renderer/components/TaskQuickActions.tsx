import { useState } from "react";
import { ThemeIcon } from "./ThemeIcon";
import { BotIcon, CalendarIcon, ClockIcon, ColumnsIcon, FlagIcon, TagIcon } from "./LineIcons";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import { TaskBoardColumn, TaskLabelData, AgentRoleData } from "../../electron/preload";

interface Task {
  id: string;
  title: string;
  status: string;
  boardColumn?: string;
  priority?: number;
  labels?: string[];
  dueDate?: number;
  estimatedMinutes?: number;
  assignedAgentRoleId?: string;
}

interface TaskQuickActionsProps {
  task: Task;
  labels: TaskLabelData[];
  agents: AgentRoleData[];
  onMoveToColumn: (column: TaskBoardColumn) => void;
  onSetPriority: (priority: number) => void;
  onSetDueDate: (dueDate: number | null) => void;
  onSetEstimate: (minutes: number | null) => void;
  onAddLabel: (labelId: string) => void;
  onRemoveLabel: (labelId: string) => void;
  onAssignAgent: (agentRoleId: string | null) => void;
  onClose: () => void;
}

const COLUMNS: { id: TaskBoardColumn; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "#6b7280" },
  { id: "todo", label: "To Do", color: "#8b5cf6" },
  { id: "in_progress", label: "In Progress", color: "#3b82f6" },
  { id: "review", label: "Review", color: "#f59e0b" },
  { id: "done", label: "Done", color: "#22c55e" },
];

const PRIORITIES = [
  { value: 0, label: "None", color: "#6b7280" },
  { value: 1, label: "Low", color: "#22c55e" },
  { value: 2, label: "Medium", color: "#f59e0b" },
  { value: 3, label: "High", color: "#ef4444" },
  { value: 4, label: "Urgent", color: "#dc2626" },
];

const ESTIMATE_OPTIONS = [
  { value: null, label: "No estimate" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "1 day" },
  { value: 960, label: "2 days" },
  { value: 2400, label: "1 week" },
];

export function TaskQuickActions({
  task,
  labels,
  agents,
  onMoveToColumn,
  onSetPriority,
  onSetDueDate,
  onSetEstimate,
  onAddLabel,
  onRemoveLabel,
  onAssignAgent,
  onClose,
}: TaskQuickActionsProps) {
  const [activePanel, setActivePanel] = useState<
    "column" | "priority" | "labels" | "agent" | "due" | "estimate" | null
  >(null);
  const [customDueDate, setCustomDueDate] = useState<string>("");

  const taskLabels = task.labels || [];

  const handleDueDateQuickSet = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(23, 59, 59, 999);
    onSetDueDate(date.getTime());
    setActivePanel(null);
  };

  const handleCustomDueDate = () => {
    if (customDueDate) {
      const date = new Date(customDueDate);
      date.setHours(23, 59, 59, 999);
      onSetDueDate(date.getTime());
      setActivePanel(null);
    }
  };

  return (
    <div className="task-quick-actions-overlay" onClick={onClose}>
      <div className="task-quick-actions" onClick={(e) => e.stopPropagation()}>
        <div className="actions-header">
          <h4>Task Actions</h4>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="action-buttons">
          <button
            className={`action-btn ${activePanel === "column" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "column" ? null : "column")}
          >
            <ThemeIcon className="action-icon" emoji="📋" icon={<ColumnsIcon size={16} />} />
            Move to Column
          </button>

          <button
            className={`action-btn ${activePanel === "priority" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "priority" ? null : "priority")}
          >
            <ThemeIcon className="action-icon" emoji="!" icon={<FlagIcon size={16} />} />
            Set Priority
          </button>

          <button
            className={`action-btn ${activePanel === "labels" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "labels" ? null : "labels")}
          >
            <ThemeIcon className="action-icon" emoji="🏷️" icon={<TagIcon size={16} />} />
            Labels
          </button>

          <button
            className={`action-btn ${activePanel === "agent" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "agent" ? null : "agent")}
          >
            <ThemeIcon className="action-icon" emoji="🤖" icon={<BotIcon size={16} />} />
            Assign Agent
          </button>

          <button
            className={`action-btn ${activePanel === "due" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "due" ? null : "due")}
          >
            <ThemeIcon className="action-icon" emoji="📅" icon={<CalendarIcon size={16} />} />
            Due Date
          </button>

          <button
            className={`action-btn ${activePanel === "estimate" ? "active" : ""}`}
            onClick={() => setActivePanel(activePanel === "estimate" ? null : "estimate")}
          >
            <ThemeIcon className="action-icon" emoji="⏱️" icon={<ClockIcon size={16} />} />
            Estimate
          </button>
        </div>

        {activePanel === "column" && (
          <div className="action-panel">
            {COLUMNS.map((col) => (
              <button
                key={col.id}
                className={`panel-option ${task.boardColumn === col.id ? "selected" : ""}`}
                onClick={() => {
                  onMoveToColumn(col.id);
                  setActivePanel(null);
                }}
              >
                <span className="option-dot" style={{ backgroundColor: col.color }} />
                {col.label}
              </button>
            ))}
          </div>
        )}

        {activePanel === "priority" && (
          <div className="action-panel">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                className={`panel-option ${task.priority === p.value ? "selected" : ""}`}
                onClick={() => {
                  onSetPriority(p.value);
                  setActivePanel(null);
                }}
              >
                <span className="option-dot" style={{ backgroundColor: p.color }} />
                {p.label}
              </button>
            ))}
          </div>
        )}

        {activePanel === "labels" && (
          <div className="action-panel">
            {labels.length === 0 ? (
              <div className="panel-empty">No labels available</div>
            ) : (
              labels.map((label) => {
                const isAssigned = taskLabels.includes(label.id);
                return (
                  <button
                    key={label.id}
                    className={`panel-option ${isAssigned ? "selected" : ""}`}
                    onClick={() => {
                      if (isAssigned) {
                        onRemoveLabel(label.id);
                      } else {
                        onAddLabel(label.id);
                      }
                    }}
                  >
                    <span className="label-preview" style={{ backgroundColor: label.color }}>
                      {label.name}
                    </span>
                    {isAssigned && <span className="check-mark">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        )}

        {activePanel === "agent" && (
          <div className="action-panel">
            <p className="agent-assignment-help">
              Assigning a bot runs it on this task. Use the Bots tab to start a dedicated bot
              conversation.
            </p>
            <button
              className={`panel-option ${!task.assignedAgentRoleId ? "selected" : ""}`}
              onClick={() => {
                onAssignAgent(null);
                setActivePanel(null);
              }}
            >
              <span className="option-dot" style={{ backgroundColor: "#6b7280" }} />
              Unassigned
            </button>
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`panel-option ${task.assignedAgentRoleId === agent.id ? "selected" : ""}`}
                onClick={() => {
                  onAssignAgent(agent.id);
                  setActivePanel(null);
                }}
              >
                <span className="agent-avatar" style={{ backgroundColor: agent.color }}>
                  {(() => {
                    const Icon = getEmojiIcon(agent.icon || "🤖");
                    return <Icon size={16} strokeWidth={2} />;
                  })()}
                </span>
                {agent.displayName}
              </button>
            ))}
          </div>
        )}

        {activePanel === "due" && (
          <div className="action-panel">
            <button
              className="panel-option"
              onClick={() => {
                onSetDueDate(null);
                setActivePanel(null);
              }}
            >
              No due date
            </button>
            <button className="panel-option" onClick={() => handleDueDateQuickSet(0)}>
              Today
            </button>
            <button className="panel-option" onClick={() => handleDueDateQuickSet(1)}>
              Tomorrow
            </button>
            <button className="panel-option" onClick={() => handleDueDateQuickSet(7)}>
              Next week
            </button>
            <div className="custom-date-row">
              <input
                type="date"
                value={customDueDate}
                onChange={(e) => setCustomDueDate(e.target.value)}
              />
              <button className="apply-btn" onClick={handleCustomDueDate} disabled={!customDueDate}>
                Set
              </button>
            </div>
          </div>
        )}

        {activePanel === "estimate" && (
          <div className="action-panel">
            {ESTIMATE_OPTIONS.map((opt) => (
              <button
                key={opt.value ?? "none"}
                className={`panel-option ${task.estimatedMinutes === opt.value ? "selected" : ""}`}
                onClick={() => {
                  onSetEstimate(opt.value);
                  setActivePanel(null);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <style>{`
          .task-quick-actions-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }

          .task-quick-actions {
            background: var(--color-bg-primary);
            border-radius: 12px;
            padding: 16px;
            width: 320px;
            max-height: 80vh;
            overflow-y: auto;
          }

          .actions-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
          }

          .actions-header h4 {
            margin: 0;
            font-size: 14px;
            color: var(--color-text-primary);
          }

          .close-btn {
            background: none;
            border: none;
            color: var(--color-text-secondary);
            cursor: pointer;
            font-size: 16px;
            padding: 4px;
          }

          .action-buttons {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .action-btn {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            background: var(--color-bg-secondary);
            border: 1px solid transparent;
            border-radius: 6px;
            color: var(--color-text-primary);
            cursor: pointer;
            font-size: 13px;
            text-align: left;
          }

          .action-btn:hover {
            background: var(--color-bg-tertiary);
          }

          .action-btn.active {
            border-color: var(--color-accent);
            background: var(--color-bg-tertiary);
          }

          .action-icon {
            font-size: 14px;
            width: 20px;
            text-align: center;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }

          .action-panel {
            margin-top: 12px;
            padding: 8px;
            background: var(--color-bg-secondary);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }

          .panel-option {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            background: transparent;
            border: none;
            border-radius: 4px;
            color: var(--color-text-primary);
            cursor: pointer;
            font-size: 13px;
            text-align: left;
          }

          .panel-option:hover {
            background: var(--color-bg-tertiary);
          }

          .panel-option.selected {
            background: var(--color-accent)20;
          }

          .option-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            flex-shrink: 0;
          }

          .label-preview {
            font-size: 11px;
            font-weight: 500;
            color: white;
            padding: 3px 8px;
            border-radius: 4px;
          }

          .check-mark {
            margin-left: auto;
            color: var(--color-accent);
          }

          .agent-avatar {
            width: 22px;
            height: 22px;
            border-radius: 5px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            flex-shrink: 0;
          }

          .panel-empty {
            text-align: center;
            color: var(--color-text-secondary);
            padding: 16px;
            font-size: 13px;
          }

          .custom-date-row {
            display: flex;
            gap: 8px;
            padding: 8px 10px;
          }

          .custom-date-row input {
            flex: 1;
            padding: 6px 8px;
            border: 1px solid var(--color-border);
            border-radius: 4px;
            background: var(--color-bg-primary);
            color: var(--color-text-primary);
            font-size: 12px;
          }

          .apply-btn {
            padding: 6px 12px;
            background: var(--color-accent);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          }

          .apply-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `}</style>
      </div>
    </div>
  );
}
