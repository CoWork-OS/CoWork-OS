import { useState } from "react";
import { TaskLabelData, AgentRoleData } from "../../electron/preload";
import { TaskStatusBadge } from "../host-shared/TaskStatusBadge";

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
  createdAt: number;
}

interface TaskBoardCardProps {
  task: Task;
  labels: TaskLabelData[];
  agents: Record<string, AgentRoleData>;
  onPriorityChange: (taskId: string, priority: number) => void;
  onSelect: (task: Task) => void;
  isDragging?: boolean;
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "None", color: "#6b7280" },
  1: { label: "Low", color: "#22c55e" },
  2: { label: "Medium", color: "#f59e0b" },
  3: { label: "High", color: "#ef4444" },
  4: { label: "Urgent", color: "#dc2626" },
};

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

function formatDueDate(timestamp: number): { text: string; isOverdue: boolean } {
  const now = Date.now();
  const diffMs = timestamp - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { text: `${Math.abs(diffDays)}d overdue`, isOverdue: true };
  }
  if (diffDays === 0) {
    return { text: "Due today", isOverdue: false };
  }
  if (diffDays === 1) {
    return { text: "Due tomorrow", isOverdue: false };
  }
  if (diffDays <= 7) {
    return { text: `Due in ${diffDays}d`, isOverdue: false };
  }

  return { text: new Date(timestamp).toLocaleDateString(), isOverdue: false };
}

export function TaskBoardCard({
  task,
  labels,
  agents,
  onPriorityChange,
  onSelect,
  isDragging,
}: TaskBoardCardProps) {
  const [showActions, setShowActions] = useState(false);

  const taskLabels = labels.filter((l) => task.labels?.includes(l.id));
  const assignedAgent = task.assignedAgentRoleId ? agents[task.assignedAgentRoleId] : null;
  const priority = PRIORITY_LABELS[task.priority || 0];
  const dueInfo = task.dueDate ? formatDueDate(task.dueDate) : null;

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      className={`task-board-card ${isDragging ? "dragging" : ""}`}
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelect(task)}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="card-header">
        <div className="card-labels">
          {taskLabels.map((label) => (
            <span key={label.id} className="card-label" style={{ backgroundColor: label.color }}>
              {label.name}
            </span>
          ))}
        </div>
        {task.priority !== undefined && task.priority > 0 && (
          <span
            className="card-priority"
            style={{ backgroundColor: priority.color }}
            title={`Priority: ${priority.label}`}
          >
            {priority.label}
          </span>
        )}
      </div>

      <div className="card-title" title={task.title}>
        {task.title}
      </div>

      <div className="card-meta">
        {assignedAgent && (
          <div className="card-agent" title={assignedAgent.displayName}>
            <span className="agent-avatar" style={{ backgroundColor: assignedAgent.color }}>
              {assignedAgent.icon}
            </span>
            <span className="agent-name">{assignedAgent.displayName}</span>
          </div>
        )}
        {dueInfo && (
          <span className={`card-due ${dueInfo.isOverdue ? "overdue" : ""}`}>{dueInfo.text}</span>
        )}
        {task.estimatedMinutes && (
          <span className="card-estimate">
            {task.estimatedMinutes < 60
              ? `${task.estimatedMinutes}m`
              : `${Math.round(task.estimatedMinutes / 60)}h`}
          </span>
        )}
      </div>

      <div className="card-footer">
        <span className="card-time">{formatTimeAgo(task.createdAt)}</span>
        <TaskStatusBadge className="card-status" status={task.status} />
      </div>

      {showActions && (
        <div className="card-quick-actions">
          <button
            className="quick-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              const newPriority = ((task.priority || 0) + 1) % 5;
              onPriorityChange(task.id, newPriority);
            }}
            title="Cycle priority"
          >
            !
          </button>
        </div>
      )}

      <style>{`
        .task-board-card {
          background: var(--color-bg-primary);
          border-radius: 8px;
          padding: 12px;
          cursor: pointer;
          transition: all 0.15s ease;
          border: 1px solid var(--color-border);
          position: relative;
        }

        .task-board-card:hover {
          border-color: var(--color-accent);
          box-shadow: var(--shadow-sm);
        }

        .task-board-card:focus-visible {
          outline: 2px solid var(--color-accent);
          outline-offset: 2px;
        }

        .task-board-card.dragging {
          opacity: 0.5;
          transform: rotate(2deg);
        }

        .card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
          min-height: 20px;
        }

        .card-labels {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .card-label {
          font-size: 10px;
          font-weight: 500;
          color: white;
          padding: 2px 6px;
          border-radius: 3px;
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .card-priority {
          font-size: 9px;
          font-weight: 600;
          color: white;
          padding: 2px 6px;
          border-radius: 3px;
          text-transform: uppercase;
          flex-shrink: 0;
        }

        .card-title {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
          line-height: 1.4;
          margin-bottom: 8px;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .card-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 8px;
        }

        .card-agent {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .card-agent .agent-avatar {
          width: 18px;
          height: 18px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
        }

        .card-agent .agent-name {
          font-size: 11px;
          color: var(--color-text-secondary);
        }

        .card-due {
          font-size: 11px;
          color: var(--color-text-secondary);
        }

        .card-due.overdue {
          color: var(--color-error);
          font-weight: 500;
        }

        .card-estimate {
          font-size: 11px;
          color: var(--color-text-muted);
          background: var(--color-bg-secondary);
          padding: 1px 4px;
          border-radius: 3px;
        }

        .card-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .card-time {
          font-size: 10px;
          color: var(--color-text-muted);
        }

        .card-status {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
          background: var(--color-bg-secondary);
          color: var(--color-text-secondary);
        }

        .card-status.status-executing,
        .card-status.status-planning,
        .card-status.status-running {
          background: var(--color-accent-subtle);
          color: var(--color-accent);
        }

        .card-status.status-completed {
          background: var(--color-success-subtle);
          color: var(--color-success);
        }

        .card-status.status-paused,
        .card-status.status-blocked {
          background: rgba(251, 191, 36, 0.15);
          color: var(--color-warning);
        }

        .card-status.status-failed,
        .card-status.status-cancelled {
          background: var(--color-error-subtle);
          color: var(--color-error);
        }

        .card-quick-actions {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 4px;
        }

        .quick-action-btn {
          width: 22px;
          height: 22px;
          border: 1px solid var(--color-border);
          border-radius: 4px;
          background: var(--color-bg-elevated);
          color: var(--color-text-secondary);
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .quick-action-btn:hover {
          background: var(--color-accent);
          border-color: var(--color-accent);
          color: white;
        }
      `}</style>
    </div>
  );
}
