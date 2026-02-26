import { useState, useEffect, useCallback } from "react";
import {
  TaskBoardColumn as ColumnType,
  TaskLabelData,
  AgentRoleData,
  TaskBoardEvent,
} from "../../electron/preload";
import { TaskBoardColumn } from "./TaskBoardColumn";
import { TaskLabelManager } from "./TaskLabelManager";
import { TaskQuickActions } from "./TaskQuickActions";
import { useAgentContext } from "../hooks/useAgentContext";

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

interface TaskBoardProps {
  workspaceId: string;
  onTaskSelect?: (taskId: string) => void;
}

const COLUMNS: { id: ColumnType; title: string; color: string }[] = [
  { id: "backlog", title: "Backlog", color: "#6b7280" },
  { id: "todo", title: "To Do", color: "#8b5cf6" },
  { id: "in_progress", title: "In Progress", color: "#3b82f6" },
  { id: "review", title: "Review", color: "#f59e0b" },
  { id: "done", title: "Done", color: "#22c55e" },
];

export function TaskBoard({ workspaceId, onTaskSelect }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [labels, setLabels] = useState<TaskLabelData[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentRoleData>>({});
  const [loading, setLoading] = useState(true);
  const [showLabelManager, setShowLabelManager] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [filterLabel, setFilterLabel] = useState<string>("");
  const [filterPriority, setFilterPriority] = useState<string>("");
  const agentContext = useAgentContext();

  // Load all data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Load tasks, labels, and agents in parallel
      const [tasksResult, labelsResult, agentsResult] = await Promise.all([
        window.electronAPI.listTasks(),
        window.electronAPI.listTaskLabels({ workspaceId }),
        window.electronAPI.getAgentRoles(),
      ]);

      // Filter tasks by workspace
      const workspaceTasks = tasksResult.filter((t: Any) => t.workspaceId === workspaceId);
      setTasks(workspaceTasks);
      setLabels(labelsResult);

      // Convert agents array to map
      const agentMap: Record<string, AgentRoleData> = {};
      agentsResult.forEach((a: AgentRoleData) => {
        agentMap[a.id] = a;
      });
      setAgents(agentMap);
    } catch (err) {
      console.error("Failed to load task board data:", err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Subscribe to task board events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTaskBoardEvent((event: TaskBoardEvent) => {
      setTasks((prev) => {
        return prev.map((t) => {
          if (t.id !== event.taskId) return t;

          switch (event.type) {
            case "moved":
              return { ...t, boardColumn: event.data?.column };
            case "priorityChanged":
              return { ...t, priority: event.data?.priority };
            case "labelAdded":
              return {
                ...t,
                labels: [...(t.labels || []), event.data?.labelId].filter((l): l is string =>
                  Boolean(l),
                ),
              };
            case "labelRemoved":
              return {
                ...t,
                labels: (t.labels || []).filter((l) => l !== event.data?.labelId),
              };
            case "dueDateChanged":
              return { ...t, dueDate: event.data?.dueDate ?? undefined };
            case "estimateChanged":
              return { ...t, estimatedMinutes: event.data?.estimatedMinutes ?? undefined };
            default:
              return t;
          }
        });
      });
    });

    return () => unsubscribe();
  }, []);

  // Subscribe to task events for new tasks and status changes
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTaskEvent((event: Any) => {
      if (event.type === "created" && event.task?.workspaceId === workspaceId) {
        setTasks((prev) => [event.task, ...prev]);
      } else if (event.type === "updated" && event.task) {
        setTasks((prev) => prev.map((t) => (t.id === event.task.id ? { ...t, ...event.task } : t)));
      } else if (event.type === "deleted" && event.taskId) {
        setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
      }
    });

    return () => unsubscribe();
  }, [workspaceId]);

  const handleTaskMove = async (taskId: string, column: ColumnType) => {
    try {
      await window.electronAPI.moveTaskToColumn(taskId, column);
      // Optimistic update
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, boardColumn: column } : t)));
    } catch (err) {
      console.error("Failed to move task:", err);
    }
  };

  const handleTaskPriorityChange = async (taskId: string, priority: number) => {
    try {
      await window.electronAPI.setTaskPriority(taskId, priority);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, priority } : t)));
    } catch (err) {
      console.error("Failed to set priority:", err);
    }
  };

  const handleTaskSelect = (task: Task) => {
    setSelectedTask(task);
    onTaskSelect?.(task.id);
  };

  const handleSetDueDate = async (dueDate: number | null) => {
    if (!selectedTask) return;
    try {
      await window.electronAPI.setTaskDueDate(selectedTask.id, dueDate);
      setTasks((prev) =>
        prev.map((t) => (t.id === selectedTask.id ? { ...t, dueDate: dueDate ?? undefined } : t)),
      );
      setSelectedTask((prev) => (prev ? { ...prev, dueDate: dueDate ?? undefined } : null));
    } catch (err) {
      console.error("Failed to set due date:", err);
    }
  };

  const handleSetEstimate = async (minutes: number | null) => {
    if (!selectedTask) return;
    try {
      await window.electronAPI.setTaskEstimate(selectedTask.id, minutes);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === selectedTask.id ? { ...t, estimatedMinutes: minutes ?? undefined } : t,
        ),
      );
      setSelectedTask((prev) =>
        prev ? { ...prev, estimatedMinutes: minutes ?? undefined } : null,
      );
    } catch (err) {
      console.error("Failed to set estimate:", err);
    }
  };

  const handleAddLabel = async (labelId: string) => {
    if (!selectedTask) return;
    try {
      await window.electronAPI.addTaskLabel(selectedTask.id, labelId);
      const newLabels = [...(selectedTask.labels || []), labelId];
      setTasks((prev) =>
        prev.map((t) => (t.id === selectedTask.id ? { ...t, labels: newLabels } : t)),
      );
      setSelectedTask((prev) => (prev ? { ...prev, labels: newLabels } : null));
    } catch (err) {
      console.error("Failed to add label:", err);
    }
  };

  const handleRemoveLabel = async (labelId: string) => {
    if (!selectedTask) return;
    try {
      await window.electronAPI.removeTaskLabel(selectedTask.id, labelId);
      const newLabels = (selectedTask.labels || []).filter((l) => l !== labelId);
      setTasks((prev) =>
        prev.map((t) => (t.id === selectedTask.id ? { ...t, labels: newLabels } : t)),
      );
      setSelectedTask((prev) => (prev ? { ...prev, labels: newLabels } : null));
    } catch (err) {
      console.error("Failed to remove label:", err);
    }
  };

  const handleAssignAgent = async (agentRoleId: string | null) => {
    if (!selectedTask) return;
    try {
      await window.electronAPI.assignAgentRoleToTask(selectedTask.id, agentRoleId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === selectedTask.id ? { ...t, assignedAgentRoleId: agentRoleId ?? undefined } : t,
        ),
      );
      setSelectedTask((prev) =>
        prev ? { ...prev, assignedAgentRoleId: agentRoleId ?? undefined } : null,
      );
    } catch (err) {
      console.error("Failed to assign agent:", err);
    }
  };

  // Filter tasks
  const filteredTasks = tasks.filter((task) => {
    if (filterAgent && task.assignedAgentRoleId !== filterAgent) return false;
    if (filterLabel && !task.labels?.includes(filterLabel)) return false;
    if (filterPriority && task.priority !== parseInt(filterPriority)) return false;
    return true;
  });

  // Group tasks by column
  const tasksByColumn: Record<ColumnType, Task[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    review: [],
    done: [],
  };

  filteredTasks.forEach((task) => {
    const column = (task.boardColumn as ColumnType) || "backlog";
    if (tasksByColumn[column]) {
      tasksByColumn[column].push(task);
    }
  });

  if (loading) {
    return (
      <div className="task-board-loading">
        <p>{agentContext.getUiCopy("taskBoardLoading")}</p>
      </div>
    );
  }

  const agentList = Object.values(agents);

  return (
    <div className="task-board">
      <div className="board-header">
        <div className="board-title">
          <h2>{agentContext.getUiCopy("taskBoardTitle")}</h2>
          <span className="task-count">
            {agentContext.getUiCopy("taskBoardCount", { count: tasks.length })}
          </span>
        </div>

        <div className="board-filters">
          <select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}>
            <option value="">{agentContext.getUiCopy("taskBoardAllAgents")}</option>
            {agentList.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.icon} {agent.displayName}
              </option>
            ))}
          </select>

          <select value={filterLabel} onChange={(e) => setFilterLabel(e.target.value)}>
            <option value="">{agentContext.getUiCopy("taskBoardAllLabels")}</option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>

          <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
            <option value="">{agentContext.getUiCopy("taskBoardAllPriorities")}</option>
            <option value="4">Urgent</option>
            <option value="3">High</option>
            <option value="2">Medium</option>
            <option value="1">Low</option>
            <option value="0">None</option>
          </select>

          <button className="manage-labels-btn" onClick={() => setShowLabelManager(true)}>
            {agentContext.getUiCopy("taskBoardManageLabels")}
          </button>
        </div>
      </div>

      <div className="board-columns">
        {COLUMNS.map((column) => (
          <TaskBoardColumn
            key={column.id}
            column={column.id}
            title={column.title}
            tasks={tasksByColumn[column.id]}
            labels={labels}
            agents={agents}
            onTaskMove={handleTaskMove}
            onTaskPriorityChange={handleTaskPriorityChange}
            onTaskSelect={handleTaskSelect}
            color={column.color}
          />
        ))}
      </div>

      {showLabelManager && (
        <TaskLabelManager
          workspaceId={workspaceId}
          onClose={() => {
            setShowLabelManager(false);
            // Reload labels
            window.electronAPI.listTaskLabels({ workspaceId }).then(setLabels).catch(console.error);
          }}
        />
      )}

      {selectedTask && (
        <TaskQuickActions
          task={selectedTask}
          labels={labels}
          agents={agentList}
          onMoveToColumn={(column) => handleTaskMove(selectedTask.id, column)}
          onSetPriority={(priority) => handleTaskPriorityChange(selectedTask.id, priority)}
          onSetDueDate={handleSetDueDate}
          onSetEstimate={handleSetEstimate}
          onAddLabel={handleAddLabel}
          onRemoveLabel={handleRemoveLabel}
          onAssignAgent={handleAssignAgent}
          onClose={() => setSelectedTask(null)}
        />
      )}

      <style>{`
        .task-board {
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 20px;
          overflow: hidden;
        }

        .task-board-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--color-text-secondary);
        }

        .board-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
          flex-shrink: 0;
        }

        .board-title {
          display: flex;
          align-items: baseline;
          gap: 12px;
        }

        .board-title h2 {
          margin: 0;
          font-size: 20px;
          color: var(--color-text-primary);
        }

        .task-count {
          font-size: 13px;
          color: var(--color-text-muted);
        }

        .board-filters {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .board-filters select {
          padding: 8px 12px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          font-size: 12px;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }

        .board-filters select:focus {
          outline: none;
          border-color: var(--color-accent);
        }

        .manage-labels-btn {
          padding: 8px 14px;
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: 6px;
          color: var(--color-text-primary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .manage-labels-btn:hover {
          background: var(--color-bg-tertiary);
          border-color: var(--color-accent);
        }

        .board-columns {
          display: flex;
          gap: 16px;
          flex: 1;
          overflow-x: auto;
          padding-bottom: 8px;
        }

        .board-columns::-webkit-scrollbar {
          height: 8px;
        }

        .board-columns::-webkit-scrollbar-track {
          background: var(--color-bg-secondary);
          border-radius: 4px;
        }

        .board-columns::-webkit-scrollbar-thumb {
          background: var(--color-bg-tertiary);
          border-radius: 4px;
        }

        .board-columns::-webkit-scrollbar-thumb:hover {
          background: var(--color-border);
        }
      `}</style>
    </div>
  );
}
