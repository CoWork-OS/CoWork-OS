import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Calendar,
  Clock3,
  Eye,
  Flag,
  Plus,
  Search,
  User,
  Zap,
} from "lucide-react";
import { BOARD_COLUMNS, TASK_PRIORITY_OPTIONS } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";
import { resolveTwinIcon } from "../../utils/twin-icons";

interface MCBoardTabProps {
  data: MissionControlData;
}

const NEW_TASK_ID_PREFIX = "__new__:";
const LINK_TASK_ID_PREFIX = "__link__:";

export function MCBoardTab({ data }: MCBoardTabProps) {
  const {
    agents,
    tasks,
    taskLabels,
    workspaces,
    getAgent,
    getAgentStatus,
    detailPanel,
    setDetailPanel,
    handleMoveTask,
    dragOverColumn,
    setDragOverColumn,
    handleTriggerHeartbeat,
    handleSetTaskPriority,
    formatRelativeTime,
    formatTaskEstimate,
    getTaskDueInfo,
    getTaskPriorityMeta,
    getMissionColumnForTask,
    getTaskLabels,
    getTaskAttentionReason,
    getTaskNextMissionColumn,
    isTaskTerminal,
    isTaskStale,
    isTaskAttentionRequired,
    agentContext,
    isAllWorkspacesSelected,
    getWorkspaceName,
  } = data;

  const [viewMode, setViewMode] = useState<"active" | "attention" | "all">("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [labelFilter, setLabelFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [sortMode, setSortMode] = useState<"urgency" | "updated" | "due" | "priority">("urgency");
  const [hideEmptyColumns, setHideEmptyColumns] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const selectedTaskId = detailPanel?.kind === "task" ? detailPanel.taskId : null;
  const query = searchQuery.trim().toLowerCase();

  const agentOptions = useMemo(
    () =>
      agents
        .filter((agent) => agent.isActive)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [agents],
  );

  const statusOptions = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.status))).sort(),
    [tasks],
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const assignee = getAgent(task.assignedAgentRoleId);
      const attentionReason = getTaskAttentionReason(task)?.toLowerCase() || "";
      const labels = getTaskLabels(task).map((label) => label.name.toLowerCase());
      const workspaceName = getWorkspaceName(task.workspaceId).toLowerCase();

      if (viewMode === "active" && isTaskTerminal(task)) return false;
      if (
        viewMode === "attention" &&
        task.status !== "failed" &&
        task.status !== "interrupted" &&
        !isTaskAttentionRequired(task)
      ) {
        return false;
      }
      if (!showHistory && getMissionColumnForTask(task) === "done" && viewMode !== "all")
        return false;
      if (agentFilter !== "all" && task.assignedAgentRoleId !== agentFilter) return false;
      if (labelFilter !== "all" && !task.labels?.includes(labelFilter)) return false;
      if (priorityFilter !== "all" && String(task.priority ?? 0) !== priorityFilter) return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (workspaceFilter !== "all" && task.workspaceId !== workspaceFilter) return false;
      if (!query) return true;

      return [
        task.title,
        task.prompt,
        assignee?.displayName || "",
        attentionReason,
        workspaceName,
        ...labels,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [
    agentFilter,
    getAgent,
    getMissionColumnForTask,
    getTaskAttentionReason,
    getTaskLabels,
    getWorkspaceName,
    isTaskAttentionRequired,
    isTaskTerminal,
    labelFilter,
    priorityFilter,
    query,
    showHistory,
    statusFilter,
    tasks,
    viewMode,
    workspaceFilter,
  ]);

  const sortedTasks = useMemo(() => {
    const compareByDue = (a: (typeof tasks)[number], b: (typeof tasks)[number]) => {
      if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    };

    return [...filteredTasks].sort((a, b) => {
      if (sortMode === "updated")
        return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
      if (sortMode === "due") {
        const dueCompare = compareByDue(a, b);
        if (dueCompare !== 0) return dueCompare;
        return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
      }
      if (sortMode === "priority") {
        const priorityCompare = (b.priority ?? 0) - (a.priority ?? 0);
        if (priorityCompare !== 0) return priorityCompare;
        return compareByDue(a, b) || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
      }

      const attentionCompare =
        Number(isTaskAttentionRequired(b)) - Number(isTaskAttentionRequired(a));
      if (attentionCompare !== 0) return attentionCompare;
      const overdueCompare =
        Number(Boolean(getTaskDueInfo(b.dueDate)?.isOverdue)) -
        Number(Boolean(getTaskDueInfo(a.dueDate)?.isOverdue));
      if (overdueCompare !== 0) return overdueCompare;
      const priorityCompare = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityCompare !== 0) return priorityCompare;
      const staleCompare = Number(isTaskStale(b)) - Number(isTaskStale(a));
      if (staleCompare !== 0) return staleCompare;
      return compareByDue(a, b) || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    });
  }, [filteredTasks, getTaskDueInfo, isTaskAttentionRequired, isTaskStale, sortMode, tasks]);

  const tasksByColumn = useMemo(() => {
    const grouped = new Map<string, typeof tasks>();
    BOARD_COLUMNS.forEach((column) => grouped.set(column.id, []));
    sortedTasks.forEach((task) => {
      const columnId = getMissionColumnForTask(task);
      grouped.set(columnId, [...(grouped.get(columnId) || []), task]);
    });
    return grouped;
  }, [getMissionColumnForTask, sortedTasks, tasks]);

  const summary = useMemo(() => {
    const overdue = filteredTasks.filter((task) =>
      Boolean(getTaskDueInfo(task.dueDate)?.isOverdue),
    ).length;
    const stale = filteredTasks.filter((task) => isTaskStale(task)).length;
    const attention = filteredTasks.filter((task) => isTaskAttentionRequired(task)).length;
    const unassigned = filteredTasks.filter(
      (task) => !task.assignedAgentRoleId && !isTaskTerminal(task),
    ).length;
    return { overdue, stale, attention, unassigned };
  }, [filteredTasks, getTaskDueInfo, isTaskAttentionRequired, isTaskStale, isTaskTerminal]);

  const visibleColumns = useMemo(() => {
    return BOARD_COLUMNS.filter((column) => {
      if (column.id === "done" && !showHistory && viewMode !== "all") return false;
      if (!hideEmptyColumns) return true;
      return (tasksByColumn.get(column.id) || []).length > 0;
    });
  }, [hideEmptyColumns, showHistory, tasksByColumn, viewMode]);

  return (
    <div className="mc-v2-board">
      <div className="mc-v2-board-header">
        <div className="mc-v2-board-header-main">
          <div>
            <h2>{agentContext.getUiCopy("mcMissionQueueTitle")}</h2>
            <p className="mc-v2-board-subtitle">
              Tracked board work for assignment, intervention, and review. Runtime queue tasks are
              summarized in the Brief.
            </p>
          </div>
          <div className="mc-v2-board-summary">
            <span className="mc-v2-board-summary-pill">
              <AlertTriangle size={12} />
              {summary.attention} attention
            </span>
            <span className="mc-v2-board-summary-pill">
              <Calendar size={12} />
              {summary.overdue} overdue
            </span>
            <span className="mc-v2-board-summary-pill">
              <Clock3 size={12} />
              {summary.stale} stale
            </span>
            <span className="mc-v2-board-summary-pill">
              <User size={12} />
              {summary.unassigned} unassigned
            </span>
          </div>
        </div>
        <div className="mc-v2-board-toolbar">
          <div className="mc-v2-board-presets">
            {[
              { id: "active", label: "Active" },
              { id: "attention", label: "Needs attention" },
              { id: "all", label: "All tasks" },
            ].map((preset) => (
              <button
                key={preset.id}
                className={`mc-v2-filter-btn ${viewMode === preset.id ? "active" : ""}`}
                onClick={() => setViewMode(preset.id as typeof viewMode)}
              >
                {preset.label}
              </button>
            ))}
            <button
              className={`mc-v2-filter-btn ${showHistory ? "active" : ""}`}
              onClick={() => setShowHistory((value) => !value)}
            >
              History
            </button>
          </div>
          <label className="mc-v2-board-search">
            <Search size={14} />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search title, label, owner, reason"
            />
          </label>
          <div className="mc-v2-board-selects">
            <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">All agents</option>
              {agentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
            <select value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}>
              <option value="all">All labels</option>
              {taskLabels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.target.value)}
            >
              <option value="all">All priorities</option>
              {TASK_PRIORITY_OPTIONS.map((priority) => (
                <option key={priority.value} value={String(priority.value)}>
                  {priority.label}
                </option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status.replace("_", " ")}
                </option>
              ))}
            </select>
            {isAllWorkspacesSelected && (
              <select
                value={workspaceFilter}
                onChange={(event) => setWorkspaceFilter(event.target.value)}
              >
                <option value="all">All workspaces</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            )}
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as typeof sortMode)}
            >
              <option value="urgency">Sort: urgency</option>
              <option value="updated">Sort: updated</option>
              <option value="due">Sort: due date</option>
              <option value="priority">Sort: priority</option>
            </select>
            <button
              className={`mc-v2-filter-btn ${!hideEmptyColumns ? "active" : ""}`}
              onClick={() => setHideEmptyColumns((value) => !value)}
            >
              Show empty
            </button>
          </div>
        </div>
      </div>
      <div className="mc-v2-kanban">
        {visibleColumns.length === 0 && (
          <div className="mc-v2-column-empty" style={{ minWidth: 280 }}>
            No board work matches the current filters. Runtime queue items may still be running or
            waiting outside this board view.
          </div>
        )}
        {visibleColumns.map((column) => {
          const columnTasks = tasksByColumn.get(column.id) || [];
          const attentionCount = columnTasks.filter((task) => isTaskAttentionRequired(task)).length;
          const overdueCount = columnTasks.filter((task) =>
            Boolean(getTaskDueInfo(task.dueDate)?.isOverdue),
          ).length;
          const staleCount = columnTasks.filter((task) => isTaskStale(task)).length;
          const wipLimit =
            column.id === "assigned"
              ? 8
              : column.id === "in_progress"
                ? 5
                : column.id === "review"
                  ? 4
                  : null;
          const overLimit = wipLimit !== null && columnTasks.length > wipLimit;

          return (
            <div
              key={column.id}
              className={`mc-v2-kanban-column ${dragOverColumn === column.id ? "drag-over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverColumn(column.id);
              }}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(event) => {
                event.preventDefault();
                const taskId = event.dataTransfer.getData("text/plain");
                if (taskId) void handleMoveTask(taskId, column.id);
                setDragOverColumn(null);
              }}
            >
              <div className="mc-v2-column-header">
                <div className="mc-v2-column-header-top">
                  <span
                    className="mc-v2-column-dot"
                    style={{ backgroundColor: column.color }}
                  ></span>
                  <span className="mc-v2-column-label">{column.label}</span>
                  <span className={`mc-v2-column-count ${overLimit ? "over-limit" : ""}`}>
                    {columnTasks.length}
                  </span>
                </div>
                {(attentionCount > 0 || overdueCount > 0 || staleCount > 0) && (
                  <div className="mc-v2-column-signals">
                    {attentionCount > 0 && (
                      <span className="mc-v2-column-signal attention">
                        {attentionCount} attention
                      </span>
                    )}
                    {overdueCount > 0 && (
                      <span className="mc-v2-column-signal overdue">{overdueCount} overdue</span>
                    )}
                    {staleCount > 0 && (
                      <span className="mc-v2-column-signal stale">{staleCount} stale</span>
                    )}
                  </div>
                )}
              </div>
              <div className="mc-v2-column-tasks">
                {columnTasks.map((task) => {
                  const assignedAgent = getAgent(task.assignedAgentRoleId);
                  const labels = getTaskLabels(task);
                  const dueInfo = getTaskDueInfo(task.dueDate);
                  const priority = getTaskPriorityMeta(task.priority);
                  const attentionReason = getTaskAttentionReason(task);
                  const stale = isTaskStale(task);
                  const estimate = formatTaskEstimate(task.estimatedMinutes);
                  const agentStatus = assignedAgent ? getAgentStatus(assignedAgent.id) : "offline";
                  const AssignedAgentIcon = assignedAgent
                    ? resolveTwinIcon(assignedAgent.icon)
                    : null;
                  const hasBadges = Boolean(task.priority) || labels.length > 0;
                  const taskUpdatedAt = formatRelativeTime(task.updatedAt || task.createdAt);

                  return (
                    <div
                      key={task.id}
                      className={`mc-v2-task-card ${selectedTaskId === task.id ? "selected" : ""} ${attentionReason ? "attention" : ""}`}
                      draggable
                      tabIndex={0}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", task.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => setDetailPanel({ kind: "task", taskId: task.id })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setDetailPanel({ kind: "task", taskId: task.id });
                        }
                      }}
                    >
                      <div className="mc-v2-task-card-top">
                        {hasBadges ? (
                          <div className="mc-v2-task-card-badges">
                            {task.priority ? (
                              <span
                                className="mc-v2-priority-pill"
                                style={{ backgroundColor: priority.color }}
                              >
                                {priority.shortLabel}
                              </span>
                            ) : null}
                            {labels.slice(0, 2).map((label) => (
                              <span
                                key={label.id}
                                className="mc-v2-label-pill"
                                style={{
                                  backgroundColor: `${label.color}22`,
                                  borderColor: `${label.color}44`,
                                  color: label.color,
                                }}
                              >
                                {label.name}
                              </span>
                            ))}
                            {labels.length > 2 && (
                              <span className="mc-v2-label-pill muted">+{labels.length - 2}</span>
                            )}
                          </div>
                        ) : (
                          <div />
                        )}
                        <div className="mc-v2-task-card-actions">
                          <button
                            className="mc-v2-task-action-btn"
                            title="Open details"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDetailPanel({ kind: "task", taskId: task.id });
                            }}
                          >
                            <Eye size={12} />
                          </button>
                          <button
                            className="mc-v2-task-action-btn"
                            title="Cycle priority"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleSetTaskPriority(
                                task.id,
                                ((task.priority ?? 0) + 1) % TASK_PRIORITY_OPTIONS.length,
                              );
                            }}
                          >
                            <Flag size={12} />
                          </button>
                          {assignedAgent && !isTaskTerminal(task) && (
                            <button
                              className="mc-v2-task-action-btn"
                              title="Wake owner"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleTriggerHeartbeat(assignedAgent.id);
                              }}
                            >
                              <Zap size={12} />
                            </button>
                          )}
                          {getMissionColumnForTask(task) !== "done" && (
                            <button
                              className="mc-v2-task-action-btn"
                              title="Move to next stage"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleMoveTask(task.id, getTaskNextMissionColumn(task));
                              }}
                            >
                              <ArrowRight size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mc-v2-task-title">{task.title}</div>
                      <div className="mc-v2-task-meta">
                        <span className={`mc-v2-status-pill status-${task.status}`}>
                          {task.status}
                        </span>
                        {taskUpdatedAt && (
                          <span className="mc-v2-task-time">Updated {taskUpdatedAt}</span>
                        )}
                      </div>
                      {attentionReason && (
                        <div className="mc-v2-task-reason">{attentionReason}</div>
                      )}
                      {isAllWorkspacesSelected && (
                        <div className="mc-v2-task-workspace">
                          {getWorkspaceName(task.workspaceId)}
                        </div>
                      )}
                      {assignedAgent && (
                        <div className="mc-v2-task-assignee">
                          <span
                            className="mc-v2-task-assignee-avatar"
                            style={{ backgroundColor: assignedAgent.color }}
                          >
                            {AssignedAgentIcon ? (
                              <AssignedAgentIcon size={12} strokeWidth={2} aria-hidden="true" />
                            ) : null}
                          </span>
                          <span className="mc-v2-task-assignee-name">
                            {assignedAgent.displayName}
                          </span>
                          <span className={`mc-v2-status-dot ${agentStatus}`}></span>
                        </div>
                      )}
                      {(dueInfo || estimate || stale) && (
                        <div className="mc-v2-task-meta">
                          {dueInfo && (
                            <span className={`mc-v2-inline-chip ${dueInfo.tone}`}>
                              {dueInfo.label}
                            </span>
                          )}
                          {estimate && <span className="mc-v2-inline-chip">{estimate}</span>}
                          {stale && <span className="mc-v2-inline-chip stale">Stale</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {columnTasks.length === 0 && (
                  <div className="mc-v2-column-empty">
                    {viewMode === "attention"
                      ? "No tasks need attention"
                      : agentContext.getUiCopy("mcColumnEmpty")}
                  </div>
                )}
              </div>
              {column.id !== "done" && (
                <div className="mc-v2-column-footer">
                  <button
                    className="mc-v2-column-footer-btn"
                    onClick={() => {
                      setDetailPanel({ kind: "task", taskId: `${NEW_TASK_ID_PREFIX}${column.id}` });
                    }}
                  >
                    <Plus size={14} /> New task
                  </button>
                  <button
                    className="mc-v2-column-footer-btn"
                    onClick={() => {
                      setDetailPanel({
                        kind: "task",
                        taskId: `${LINK_TASK_ID_PREFIX}${column.id}`,
                      });
                    }}
                  >
                    <ArrowUpRight size={13} /> Link existing
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
