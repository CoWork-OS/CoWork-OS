import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import {
  AgentRoleData,
  HeartbeatEvent,
  HeartbeatStatus,
  AgentCapability,
  ActivityData,
  MentionData,
  TaskBoardEvent,
} from "../../electron/preload";
import type { Task, Workspace } from "../../shared/types";
import { TASK_EVENT_STATUS_MAP } from "../../shared/task-event-status-map";
import { AgentRoleEditor } from "./AgentRoleEditor";
import { ActivityFeed } from "./ActivityFeed";
import { MentionInput } from "./MentionInput";
import { MentionList } from "./MentionList";
import { StandupReportViewer } from "./StandupReportViewer";
import { AgentTeamsPanel } from "./AgentTeamsPanel";
import { AgentPerformanceReviewViewer } from "./AgentPerformanceReviewViewer";
import { useAgentContext } from "../hooks/useAgentContext";
import type { UiCopyKey } from "../utils/agentMessages";

type AgentRole = AgentRoleData;
type MissionColumn = {
  id: string;
  label: string;
  color: string;
  boardColumn: NonNullable<Task["boardColumn"]>;
};

interface HeartbeatStatusInfo {
  agentRoleId: string;
  agentName: string;
  heartbeatEnabled: boolean;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  nextHeartbeatAt?: number;
}

const BOARD_COLUMNS: MissionColumn[] = [
  { id: "inbox", label: "INBOX", color: "#6b7280", boardColumn: "backlog" },
  { id: "assigned", label: "ASSIGNED", color: "#f59e0b", boardColumn: "todo" },
  { id: "in_progress", label: "IN PROGRESS", color: "#3b82f6", boardColumn: "in_progress" },
  { id: "review", label: "REVIEW", color: "#8b5cf6", boardColumn: "review" },
  { id: "done", label: "DONE", color: "#22c55e", boardColumn: "done" },
];

const AUTONOMY_BADGES: Record<string, { label: string; color: string }> = {
  lead: { label: "LEAD", color: "#f59e0b" },
  specialist: { label: "SPC", color: "#3b82f6" },
  intern: { label: "INT", color: "#6b7280" },
};

interface MissionControlPanelProps {
  onClose?: () => void;
}

export function MissionControlPanel({ onClose: _onClose }: MissionControlPanelProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRole[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activities, setActivities] = useState<ActivityData[]>([]);
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [heartbeatStatuses, setHeartbeatStatuses] = useState<HeartbeatStatusInfo[]>([]);
  const [events, setEvents] = useState<HeartbeatEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentRole | null>(null);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"feed" | "task">("feed");
  const [feedFilter, setFeedFilter] = useState<"all" | "tasks" | "comments" | "status">("all");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [commentText, setCommentText] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [standupOpen, setStandupOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const tasksRef = useRef<Task[]>([]);
  const workspaceIdRef = useRef<string | null>(null);
  const agentContext = useAgentContext();
  const filterLabels: Record<typeof feedFilter, UiCopyKey> = {
    all: "mcFilterAll",
    tasks: "mcFilterTasks",
    comments: "mcFilterComments",
    status: "mcFilterStatus",
  };

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    workspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setCommentText("");
  }, [selectedTaskId]);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      let tempWorkspace: Workspace | null = null;
      try {
        tempWorkspace = await window.electronAPI.getTempWorkspace();
      } catch {
        tempWorkspace = null;
      }

      const combined = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...loaded.filter((workspace) => workspace.id !== tempWorkspace?.id),
      ];

      if (combined.length === 0) {
        return;
      }

      setWorkspaces(combined);
      if (
        !selectedWorkspaceId ||
        !combined.some((workspace) => workspace.id === selectedWorkspaceId)
      ) {
        setSelectedWorkspaceId(combined[0].id);
      }
    } catch (err) {
      console.error("Failed to load workspaces:", err);
    }
  }, [selectedWorkspaceId]);

  const loadData = useCallback(async (workspaceId: string) => {
    try {
      setLoading(true);
      const [loadedAgents, statuses, loadedTasks, loadedActivities, loadedMentions] =
        await Promise.all([
          window.electronAPI.getAgentRoles(true),
          window.electronAPI.getAllHeartbeatStatus(),
          window.electronAPI.listTasks().catch(() => []),
          window.electronAPI.listActivities({ workspaceId, limit: 200 }).catch(() => []),
          window.electronAPI.listMentions({ workspaceId, limit: 200 }).catch(() => []),
        ]);
      setAgents(loadedAgents);
      setHeartbeatStatuses(statuses);
      const workspaceTasks = loadedTasks.filter((task: Task) => task.workspaceId === workspaceId);
      setTasks(workspaceTasks);
      setActivities(loadedActivities);
      setMentions(loadedMentions);
      setSelectedTaskId((prev) =>
        prev && workspaceTasks.some((task) => task.id === prev) ? prev : null,
      );
    } catch (err) {
      console.error("Failed to load mission control data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleManualRefresh = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    try {
      setIsRefreshing(true);
      const [statuses, loadedTasks, loadedActivities, loadedMentions] = await Promise.all([
        window.electronAPI.getAllHeartbeatStatus().catch(() => []),
        window.electronAPI.listTasks().catch(() => []),
        window.electronAPI
          .listActivities({ workspaceId: selectedWorkspaceId, limit: 200 })
          .catch(() => []),
        window.electronAPI
          .listMentions({ workspaceId: selectedWorkspaceId, limit: 200 })
          .catch(() => []),
      ]);
      setHeartbeatStatuses(statuses);
      const workspaceTasks = loadedTasks.filter(
        (task: Task) => task.workspaceId === selectedWorkspaceId,
      );
      setTasks(workspaceTasks);
      setActivities(loadedActivities);
      setMentions(loadedMentions);
    } catch (err) {
      console.error("Failed to refresh mission control data:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (selectedWorkspaceId) {
      loadData(selectedWorkspaceId);
    }
  }, [selectedWorkspaceId, loadData]);

  // Set up event subscriptions - these use refs to avoid stale closures
  // and minimize re-subscription when workspace changes
  useEffect(() => {
    // Subscribe to heartbeat events (workspace-independent)
    const unsubscribeHeartbeat = window.electronAPI.onHeartbeatEvent((event: HeartbeatEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 100));

      // Update status when event is received
      setHeartbeatStatuses((prev) =>
        prev.map((status) => {
          if (status.agentRoleId === event.agentRoleId) {
            return {
              ...status,
              heartbeatStatus:
                event.type === "started"
                  ? "running"
                  : ["work_found", "no_work", "completed"].includes(event.type)
                    ? "sleeping"
                    : event.type === "error"
                      ? "error"
                      : status.heartbeatStatus,
              lastHeartbeatAt: ["completed", "no_work", "work_found"].includes(event.type)
                ? event.timestamp
                : status.lastHeartbeatAt,
            };
          }
          return status;
        }),
      );
    });

    // Activity events - filter by current workspace using ref
    const unsubscribeActivities = window.electronAPI.onActivityEvent((event) => {
      const currentWorkspaceId = workspaceIdRef.current;
      switch (event.type) {
        case "created":
          if (event.activity?.workspaceId === currentWorkspaceId) {
            setActivities((prev) => [event.activity!, ...prev].slice(0, 200));
          }
          break;
        case "read":
          setActivities((prev) =>
            prev.map((activity) =>
              activity.id === event.id ? { ...activity, isRead: true } : activity,
            ),
          );
          break;
        case "all_read":
          if (event.workspaceId === currentWorkspaceId) {
            setActivities((prev) => prev.map((activity) => ({ ...activity, isRead: true })));
          }
          break;
        case "pinned":
          if (event.activity) {
            setActivities((prev) =>
              prev.map((activity) =>
                activity.id === event.activity!.id ? event.activity! : activity,
              ),
            );
          }
          break;
        case "deleted":
          setActivities((prev) => prev.filter((activity) => activity.id !== event.id));
          break;
      }
    });

    // Mention events - filter by current workspace using ref
    const unsubscribeMentions = window.electronAPI.onMentionEvent((event) => {
      const currentWorkspaceId = workspaceIdRef.current;
      if (!event.mention) return;
      if (event.mention.workspaceId !== currentWorkspaceId) return;
      switch (event.type) {
        case "created":
          setMentions((prev) => [event.mention!, ...prev]);
          break;
        case "acknowledged":
        case "completed":
        case "dismissed":
          setMentions((prev) =>
            prev.map((mention) => (mention.id === event.mention!.id ? event.mention! : mention)),
          );
          break;
      }
    });

    // Task events - handle new tasks and status updates
    const unsubscribeTaskEvents = window.electronAPI.onTaskEvent((event: any) => {
      const currentWorkspaceId = workspaceIdRef.current;
      const isAutoApprovalRequested =
        event.type === "approval_requested" && event.payload?.autoApproved === true;

      if (event.type === "task_created") {
        const isNewTask = !tasksRef.current.some((task) => task.id === event.taskId);
        if (isNewTask && currentWorkspaceId) {
          // Fetch the task and add it if it belongs to current workspace
          window.electronAPI
            .getTask(event.taskId)
            .then((incoming) => {
              if (!incoming) return;
              if (incoming.workspaceId === currentWorkspaceId) {
                setTasks((prev) => {
                  // Avoid duplicates
                  if (prev.some((t) => t.id === incoming.id)) return prev;
                  return [incoming, ...prev];
                });
              }
            })
            .catch((err) => console.debug("Failed to fetch new task", err));
        }
        return;
      }

      const newStatus =
        event.type === "task_status" ? event.payload?.status : TASK_EVENT_STATUS_MAP[event.type];
      if (newStatus && !isAutoApprovalRequested) {
        setTasks((prev) =>
          prev.map((task) =>
            task.id === event.taskId ? { ...task, status: newStatus, updatedAt: Date.now() } : task,
          ),
        );
      }
    });

    // Task board events - handle column moves, priority changes, etc.
    const unsubscribeBoard = window.electronAPI.onTaskBoardEvent((event: TaskBoardEvent) => {
      setTasks((prev) =>
        prev.map((task) => {
          if (task.id !== event.taskId) return task;
          switch (event.type) {
            case "moved":
              return { ...task, boardColumn: event.data?.column };
            case "priorityChanged":
              return { ...task, priority: event.data?.priority };
            case "labelAdded":
              return {
                ...task,
                labels: [...(task.labels || []), event.data?.labelId].filter((l): l is string =>
                  Boolean(l),
                ),
              };
            case "labelRemoved":
              return {
                ...task,
                labels: (task.labels || []).filter((label) => label !== event.data?.labelId),
              };
            case "dueDateChanged":
              return { ...task, dueDate: event.data?.dueDate ?? undefined };
            case "estimateChanged":
              return { ...task, estimatedMinutes: event.data?.estimatedMinutes ?? undefined };
            default:
              return task;
          }
        }),
      );
    });

    return () => {
      unsubscribeHeartbeat();
      unsubscribeActivities();
      unsubscribeMentions();
      unsubscribeTaskEvents();
      unsubscribeBoard();
    };
  }, []); // Empty deps - subscriptions are stable, use refs for current values

  const handleCreateAgent = () => {
    setEditingAgent({
      id: "",
      name: "",
      displayName: "",
      description: "",
      icon: "🤖",
      color: "#6366f1",
      capabilities: ["code"] as AgentCapability[],
      isSystem: false,
      isActive: true,
      sortOrder: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setIsCreatingAgent(true);
  };

  const handleEditAgent = (agent: AgentRole) => {
    setEditingAgent({ ...agent });
    setIsCreatingAgent(false);
  };

  const handleSaveAgent = async (agent: AgentRole) => {
    try {
      setAgentError(null);
      if (isCreatingAgent) {
        const created = await window.electronAPI.createAgentRole({
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description,
          icon: agent.icon,
          color: agent.color,
          personalityId: agent.personalityId,
          modelKey: agent.modelKey,
          providerType: agent.providerType,
          systemPrompt: agent.systemPrompt,
          capabilities: agent.capabilities,
          toolRestrictions: agent.toolRestrictions,
          autonomyLevel: agent.autonomyLevel,
          soul: agent.soul,
          heartbeatEnabled: agent.heartbeatEnabled,
          heartbeatIntervalMinutes: agent.heartbeatIntervalMinutes,
          heartbeatStaggerOffset: agent.heartbeatStaggerOffset,
        });
        setAgents((prev) => [...prev, created]);
      } else {
        const updated = await window.electronAPI.updateAgentRole({
          id: agent.id,
          displayName: agent.displayName,
          description: agent.description,
          icon: agent.icon,
          color: agent.color,
          personalityId: agent.personalityId,
          modelKey: agent.modelKey,
          providerType: agent.providerType,
          systemPrompt: agent.systemPrompt,
          capabilities: agent.capabilities,
          toolRestrictions: agent.toolRestrictions,
          isActive: agent.isActive,
          sortOrder: agent.sortOrder,
          autonomyLevel: agent.autonomyLevel,
          soul: agent.soul,
          heartbeatEnabled: agent.heartbeatEnabled,
          heartbeatIntervalMinutes: agent.heartbeatIntervalMinutes,
          heartbeatStaggerOffset: agent.heartbeatStaggerOffset,
        });
        if (updated) {
          setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
        }
      }
      setEditingAgent(null);
      setIsCreatingAgent(false);
      // Refresh heartbeat statuses
      const statuses = await window.electronAPI.getAllHeartbeatStatus();
      setHeartbeatStatuses(statuses);
    } catch (err: any) {
      setAgentError(err.message || "Failed to save agent");
    }
  };

  const formatRelativeTime = (timestamp?: number) => {
    if (!timestamp) return "";
    const now = Date.now();
    const diff = now - timestamp;
    const abs = Math.abs(diff);
    const format = (value: number, unit: string, suffix: string) => `${value}${unit} ${suffix}`;
    if (abs < 60000) return diff < 0 ? "in <1m" : "just now";
    if (abs < 3600000) {
      const minutes = Math.floor(abs / 60000);
      return diff < 0 ? format(minutes, "m", "from now") : `${minutes}m ago`;
    }
    if (abs < 86400000) {
      const hours = Math.floor(abs / 3600000);
      return diff < 0 ? format(hours, "h", "from now") : `${hours}h ago`;
    }
    const days = Math.floor(abs / 86400000);
    return diff < 0 ? format(days, "d", "from now") : `${days}d ago`;
  };

  const getAgentStatus = (agentId: string): "working" | "idle" | "offline" => {
    const status = heartbeatStatuses.find((s) => s.agentRoleId === agentId);
    if (!status?.heartbeatEnabled) return "offline";
    if (status.heartbeatStatus === "running") return "working";
    return "idle";
  };

  const getMissionColumnForTask = useCallback((task: Task) => {
    if (task.status === "completed") return "done";
    const col = task.boardColumn;
    if (col === "done") return "done";
    if (col === "review") return "review";
    if (col === "in_progress") return "in_progress";
    if (col === "todo") return "assigned";
    if (col === "backlog") return task.assignedAgentRoleId ? "assigned" : "inbox";
    if (col === "assigned" || col === "inbox") return col;
    return task.assignedAgentRoleId ? "assigned" : "inbox";
  }, []);

  const getBoardColumnForMission = useCallback(
    (missionColumnId: string): NonNullable<Task["boardColumn"]> => {
      const column = BOARD_COLUMNS.find((col) => col.id === missionColumnId);
      return column?.boardColumn ?? "backlog";
    },
    [],
  );

  const activeAgentsCount = useMemo(
    () =>
      agents.filter(
        (a) =>
          a.isActive && heartbeatStatuses.some((s) => s.agentRoleId === a.id && s.heartbeatEnabled),
      ).length,
    [agents, heartbeatStatuses],
  );
  const totalTasksInQueue = useMemo(
    () => tasks.filter((t) => getMissionColumnForTask(t) !== "done").length,
    [tasks, getMissionColumnForTask],
  );
  const pendingMentionsCount = useMemo(
    () => mentions.filter((m) => m.status === "pending").length,
    [mentions],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || null,
    [tasks, selectedTaskId],
  );
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
  );
  const tasksByAgent = useMemo(() => {
    const map = new Map<string, Task[]>();
    tasks.forEach((task) => {
      if (!task.assignedAgentRoleId) return;
      const list = map.get(task.assignedAgentRoleId) || [];
      list.push(task);
      map.set(task.assignedAgentRoleId, list);
    });
    map.forEach((list) =>
      list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    );
    return map;
  }, [tasks]);

  // Get tasks by column
  const getTasksByColumn = useCallback(
    (columnId: string) => {
      return tasks.filter((t) => getMissionColumnForTask(t) === columnId);
    },
    [tasks, getMissionColumnForTask],
  );

  // Get agent by ID
  const getAgent = useCallback(
    (agentId?: string) => {
      if (!agentId) return null;
      return agents.find((a) => a.id === agentId);
    },
    [agents],
  );

  const handleMoveTask = useCallback(
    async (taskId: string, missionColumnId: string) => {
      try {
        const boardColumn = getBoardColumnForMission(missionColumnId);
        await window.electronAPI.moveTaskToColumn(taskId, boardColumn);
        setTasks((prev) =>
          prev.map((task) =>
            task.id === taskId ? { ...task, boardColumn, updatedAt: Date.now() } : task,
          ),
        );
      } catch (err) {
        console.error("Failed to move task:", err);
      }
    },
    [getBoardColumnForMission],
  );

  const handleAssignTask = useCallback(async (taskId: string, agentRoleId: string | null) => {
    try {
      await window.electronAPI.assignAgentRoleToTask(taskId, agentRoleId);
      setTasks((prev) =>
        prev.map((task) =>
          task.id === taskId
            ? { ...task, assignedAgentRoleId: agentRoleId ?? undefined, updatedAt: Date.now() }
            : task,
        ),
      );
    } catch (err) {
      console.error("Failed to assign agent:", err);
    }
  }, []);

  const handleTriggerHeartbeat = useCallback(async (agentRoleId: string) => {
    try {
      await window.electronAPI.triggerHeartbeat(agentRoleId);
    } catch (err) {
      console.error("Failed to trigger heartbeat:", err);
    }
  }, []);

  const handlePostComment = useCallback(async () => {
    if (!selectedWorkspaceId || !selectedTask) return;
    const text = commentText.trim();
    if (!text) return;
    try {
      setPostingComment(true);
      await window.electronAPI.createActivity({
        workspaceId: selectedWorkspaceId,
        taskId: selectedTask.id,
        actorType: "user",
        activityType: "comment",
        title: "Comment",
        description: text,
      });
      setCommentText("");
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setPostingComment(false);
    }
  }, [commentText, selectedTask, selectedWorkspaceId]);

  // Build combined feed items with filtering
  const feedItems = useMemo(() => {
    const activityItems = activities.map((activity) => {
      const mappedType =
        activity.activityType === "comment" || activity.activityType === "mention"
          ? "comments"
          : activity.activityType.startsWith("task_") || activity.activityType === "agent_assigned"
            ? "tasks"
            : "status";
      const agentName =
        activity.actorType === "user"
          ? agentContext.getUiCopy("activityActorUser")
          : getAgent(activity.agentRoleId)?.displayName ||
            agentContext.getUiCopy("activityActorSystem");
      const content = activity.description
        ? `${activity.title} — ${activity.description}`
        : activity.title;
      return {
        id: activity.id,
        type: mappedType as "comments" | "tasks" | "status",
        agentId: activity.agentRoleId,
        agentName,
        content,
        taskId: activity.taskId,
        timestamp: activity.createdAt,
      };
    });

    const heartbeatItems = events.map((event) => ({
      id: `event-${event.timestamp}`,
      type: "status" as const,
      agentId: event.agentRoleId,
      agentName: event.agentName,
      content:
        event.type === "work_found"
          ? agentContext.getUiCopy("mcHeartbeatFound", {
              mentions: event.result?.pendingMentions || 0,
              tasks: event.result?.assignedTasks || 0,
            })
          : event.type,
      timestamp: event.timestamp,
      taskId: undefined as string | undefined,
    }));

    return [...heartbeatItems, ...activityItems]
      .filter((item) => {
        if (feedFilter !== "all" && item.type !== feedFilter) return false;
        if (selectedAgent) {
          if (!item.agentId) return false;
          if (item.agentId !== selectedAgent) return false;
        }
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);
  }, [activities, events, feedFilter, selectedAgent, getAgent, agentContext]);

  if (loading) {
    return (
      <div className="mission-control">
        <div className="mc-loading">{agentContext.getUiCopy("mcLoading")}</div>
        <style>{styles}</style>
      </div>
    );
  }

  // Show agent editor modal if editing
  if (editingAgent) {
    return (
      <div className="mission-control">
        <div className="mc-editor-overlay">
          <div className="mc-editor-modal">
            <AgentRoleEditor
              role={editingAgent}
              isCreating={isCreatingAgent}
              onSave={handleSaveAgent}
              onCancel={() => {
                setEditingAgent(null);
                setIsCreatingAgent(false);
                setAgentError(null);
              }}
              error={agentError}
            />
          </div>
        </div>
        <style>{styles}</style>
      </div>
    );
  }

  return (
    <div className="mission-control">
      {/* Header */}
      <header className="mc-header">
        <div className="mc-header-left">
          <h1>{agentContext.getUiCopy("mcTitle")}</h1>
          <div className="mc-workspace-select">
            <span className="mc-workspace-label">{agentContext.getUiCopy("mcWorkspaceLabel")}</span>
            <select
              value={selectedWorkspaceId || ""}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mc-header-stats">
          <div className="mc-stat">
            <span className="mc-stat-value">{activeAgentsCount}</span>
            <span className="mc-stat-label">{agentContext.getUiCopy("mcAgentsActiveLabel")}</span>
          </div>
          <div className="mc-stat">
            <span className="mc-stat-value">{totalTasksInQueue}</span>
            <span className="mc-stat-label">{agentContext.getUiCopy("mcTasksQueueLabel")}</span>
          </div>
          <div className="mc-stat">
            <span className="mc-stat-value">{pendingMentionsCount}</span>
            <span className="mc-stat-label">{agentContext.getUiCopy("mcMentionsLabel")}</span>
          </div>
        </div>
        <div className="mc-header-right">
          <button
            className="mc-refresh-btn"
            onClick={handleManualRefresh}
            disabled={!selectedWorkspaceId || isRefreshing}
            title="Refresh mission control data"
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className="mc-standup-btn"
            onClick={() => setTeamsOpen(true)}
            disabled={!selectedWorkspace}
          >
            Teams
          </button>
          <button
            className="mc-standup-btn"
            onClick={() => setReviewsOpen(true)}
            disabled={!selectedWorkspace}
          >
            Reviews
          </button>
          <button
            className="mc-standup-btn"
            onClick={() => setStandupOpen(true)}
            disabled={!selectedWorkspace}
          >
            {agentContext.getUiCopy("mcStandupButton")}
          </button>
          <span className="mc-time">
            {currentTime.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span className="mc-status-badge online">{agentContext.getUiCopy("mcStatusOnline")}</span>
        </div>
      </header>

      {/* Main Content */}
      <div className="mc-content">
        {/* Left Panel - Agents */}
        <aside className="mc-agents-panel">
          <div className="mc-panel-header">
            <h2>{agentContext.getUiCopy("mcAgentsTitle")}</h2>
            <span className="mc-count">{agents.filter((a) => a.isActive).length}</span>
          </div>
          <div className="mc-agents-list">
            {agents
              .filter((a) => a.isActive)
              .map((agent) => {
                const status = getAgentStatus(agent.id);
                const badge = AUTONOMY_BADGES[agent.autonomyLevel || "specialist"];
                const statusInfo = heartbeatStatuses.find((s) => s.agentRoleId === agent.id);
                const agentTasks = tasksByAgent.get(agent.id) || [];
                const currentTask = agentTasks[0];

                return (
                  <div
                    key={agent.id}
                    className={`mc-agent-item ${selectedAgent === agent.id ? "selected" : ""}`}
                    onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
                    onDoubleClick={() => handleEditAgent(agent)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="mc-agent-avatar" style={{ backgroundColor: agent.color }}>
                      {agent.icon}
                    </div>
                    <div className="mc-agent-info">
                      <div className="mc-agent-name-row">
                        <span className="mc-agent-name">{agent.displayName}</span>
                        <span
                          className="mc-autonomy-badge"
                          style={{ backgroundColor: badge.color }}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <span className="mc-agent-role">
                        {agent.description?.slice(0, 30) || agent.name}
                      </span>
                      <span className="mc-agent-task">
                        {currentTask ? currentTask.title : agentContext.getUiCopy("mcNoActiveTask")}
                      </span>
                    </div>
                    <div className={`mc-agent-status ${status}`}>
                      <span className="mc-status-dot"></span>
                      <span className="mc-status-text">{status.toUpperCase()}</span>
                      {statusInfo?.nextHeartbeatAt && (
                        <span className="mc-heartbeat-time">
                          {agentContext.getUiCopy("mcHeartbeatNext", {
                            time: formatRelativeTime(statusInfo.nextHeartbeatAt),
                          })}
                        </span>
                      )}
                    </div>
                    {statusInfo?.heartbeatEnabled && (
                      <span
                        className="mc-agent-wake"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTriggerHeartbeat(agent.id);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        {agentContext.getUiCopy("mcWakeAgent")}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
          <button className="mc-add-agent-btn" onClick={handleCreateAgent}>
            <Plus size={16} strokeWidth={2} />
            {agentContext.getUiCopy("mcAddAgent")}
          </button>
        </aside>

        {/* Center - Mission Queue */}
        <main className="mc-queue-panel">
          <div className="mc-panel-header">
            <h2>{agentContext.getUiCopy("mcMissionQueueTitle")}</h2>
          </div>
          <div className="mc-kanban">
            {BOARD_COLUMNS.map((column) => {
              const columnTasks = getTasksByColumn(column.id);
              return (
                <div
                  key={column.id}
                  className={`mc-kanban-column ${dragOverColumn === column.id ? "drag-over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverColumn(column.id);
                  }}
                  onDragLeave={() => setDragOverColumn(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const taskId = e.dataTransfer.getData("text/plain");
                    if (taskId) {
                      handleMoveTask(taskId, column.id);
                    }
                    setDragOverColumn(null);
                  }}
                >
                  <div className="mc-column-header">
                    <span
                      className="mc-column-dot"
                      style={{ backgroundColor: column.color }}
                    ></span>
                    <span className="mc-column-label">{column.label}</span>
                    <span className="mc-column-count">{columnTasks.length}</span>
                  </div>
                  <div className="mc-column-tasks">
                    {columnTasks.map((task) => {
                      const assignedAgent = getAgent(task.assignedAgentRoleId);
                      return (
                        <div
                          key={task.id}
                          className={`mc-task-card ${selectedTaskId === task.id ? "selected" : ""}`}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", task.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => {
                            setSelectedTaskId(task.id);
                            setRightTab("task");
                          }}
                        >
                          <div className="mc-task-title">{task.title}</div>
                          {assignedAgent && (
                            <div className="mc-task-assignee">
                              <span
                                className="mc-task-assignee-avatar"
                                style={{ backgroundColor: assignedAgent.color }}
                              >
                                {assignedAgent.icon}
                              </span>
                              <span className="mc-task-assignee-name">
                                {assignedAgent.displayName}
                              </span>
                            </div>
                          )}
                          <div className="mc-task-meta">
                            <span className={`mc-task-status-pill status-${task.status}`}>
                              {task.status.replace("_", " ")}
                            </span>
                            <span className="mc-task-time">
                              {formatRelativeTime(task.updatedAt)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {columnTasks.length === 0 && (
                      <div className="mc-column-empty">
                        {agentContext.getUiCopy("mcColumnEmpty")}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        {/* Right Panel - Live Feed */}
        <aside className="mc-feed-panel">
          <div className="mc-panel-header mc-feed-header">
            <div className="mc-tabs">
              <button
                className={`mc-tab-btn ${rightTab === "feed" ? "active" : ""}`}
                onClick={() => setRightTab("feed")}
              >
                {agentContext.getUiCopy("mcLiveFeedTitle")}
              </button>
              <button
                className={`mc-tab-btn ${rightTab === "task" ? "active" : ""}`}
                onClick={() => setRightTab("task")}
              >
                {agentContext.getUiCopy("mcTaskTab")}
              </button>
            </div>
            {rightTab === "task" && selectedTask && (
              <button className="mc-clear-task" onClick={() => setSelectedTaskId(null)}>
                {agentContext.getUiCopy("mcClearTask")}
              </button>
            )}
          </div>

          {rightTab === "feed" ? (
            <>
              <div className="mc-feed-filters">
                {(["all", "tasks", "comments", "status"] as const).map((filter) => (
                  <button
                    key={filter}
                    className={`mc-filter-btn ${feedFilter === filter ? "active" : ""}`}
                    onClick={() => setFeedFilter(filter)}
                  >
                    {agentContext.getUiCopy(filterLabels[filter])}
                  </button>
                ))}
              </div>
              <div className="mc-feed-agents">
                <span className="mc-feed-agents-label">
                  {agentContext.getUiCopy("mcAllAgentsLabel")}
                </span>
                <div className="mc-feed-agent-chips">
                  {agents
                    .filter((a) => a.isActive)
                    .map((agent) => (
                      <button
                        key={agent.id}
                        className={`mc-agent-chip ${selectedAgent === agent.id ? "active" : ""}`}
                        style={{ borderColor: agent.color }}
                        onClick={() =>
                          setSelectedAgent(selectedAgent === agent.id ? null : agent.id)
                        }
                      >
                        {agent.icon} {agent.displayName.split(" ")[0]}
                      </button>
                    ))}
                </div>
              </div>
              <div className="mc-feed-list">
                {feedItems.length === 0 ? (
                  <div className="mc-feed-empty">{agentContext.getUiCopy("mcFeedEmpty")}</div>
                ) : (
                  feedItems.map((item) => {
                    const agent = getAgent(item.agentId);
                    return (
                      <div key={item.id} className="mc-feed-item">
                        <div className="mc-feed-item-header">
                          {agent && (
                            <span className="mc-feed-agent" style={{ color: agent.color }}>
                              {agent.icon} {agent.displayName}
                            </span>
                          )}
                          {!agent && item.agentName && (
                            <span className="mc-feed-agent system">{item.agentName}</span>
                          )}
                          <span className="mc-feed-time">{formatRelativeTime(item.timestamp)}</span>
                        </div>
                        <div className="mc-feed-content">{item.content}</div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div className="mc-task-detail">
              {selectedTask ? (
                <>
                  <div className="mc-task-detail-header">
                    <div className="mc-task-detail-title">
                      <h3>{selectedTask.title}</h3>
                      <span className={`mc-task-detail-status status-${selectedTask.status}`}>
                        {selectedTask.status.replace("_", " ")}
                      </span>
                    </div>
                    <div className="mc-task-detail-updated">
                      {agentContext.getUiCopy("mcTaskUpdatedAt", {
                        time: formatRelativeTime(selectedTask.updatedAt),
                      })}
                    </div>
                  </div>

                  <div className="mc-task-detail-meta">
                    <label>
                      {agentContext.getUiCopy("mcTaskAssigneeLabel")}
                      <select
                        value={selectedTask.assignedAgentRoleId || ""}
                        onChange={(e) => handleAssignTask(selectedTask.id, e.target.value || null)}
                      >
                        <option value="">{agentContext.getUiCopy("mcTaskUnassigned")}</option>
                        {agents
                          .filter((a) => a.isActive)
                          .map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.displayName}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      {agentContext.getUiCopy("mcTaskStageLabel")}
                      <select
                        value={getMissionColumnForTask(selectedTask)}
                        onChange={(e) => handleMoveTask(selectedTask.id, e.target.value)}
                      >
                        {BOARD_COLUMNS.map((column) => (
                          <option key={column.id} value={column.id}>
                            {column.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mc-task-detail-section">
                    <h4>{agentContext.getUiCopy("mcTaskBriefTitle")}</h4>
                    <p className="mc-task-detail-brief">{selectedTask.prompt}</p>
                  </div>

                  <div className="mc-task-detail-section">
                    <h4>{agentContext.getUiCopy("mcTaskUpdatesTitle")}</h4>
                    {selectedWorkspaceId && (
                      <ActivityFeed
                        workspaceId={selectedWorkspaceId}
                        taskId={selectedTask.id}
                        compact
                        maxItems={20}
                        showFilters={false}
                      />
                    )}
                    <div className="mc-comment-box">
                      <textarea
                        placeholder={agentContext.getUiCopy("mcTaskUpdatePlaceholder")}
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        rows={3}
                      />
                      <button
                        className="mc-comment-submit"
                        onClick={handlePostComment}
                        disabled={postingComment || commentText.trim().length === 0}
                      >
                        {postingComment
                          ? agentContext.getUiCopy("mcTaskPosting")
                          : agentContext.getUiCopy("mcTaskPostUpdate")}
                      </button>
                    </div>
                  </div>

                  <div className="mc-task-detail-section">
                    <h4>{agentContext.getUiCopy("mcTaskMentionsTitle")}</h4>
                    {selectedWorkspaceId && (
                      <>
                        <MentionInput
                          workspaceId={selectedWorkspaceId}
                          taskId={selectedTask.id}
                          placeholder={agentContext.getUiCopy("mcTaskMentionPlaceholder")}
                        />
                        <MentionList workspaceId={selectedWorkspaceId} taskId={selectedTask.id} />
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="mc-task-empty">{agentContext.getUiCopy("mcTaskEmpty")}</div>
              )}
            </div>
          )}
        </aside>
      </div>

      {standupOpen && selectedWorkspace && (
        <div className="mc-editor-overlay">
          <div className="mc-editor-modal mc-standup-modal">
            <StandupReportViewer
              workspaceId={selectedWorkspace.id}
              onClose={() => setStandupOpen(false)}
            />
          </div>
        </div>
      )}

      {teamsOpen && selectedWorkspaceId && (
        <div className="mc-editor-overlay">
          <div className="mc-editor-modal mc-standup-modal">
            <AgentTeamsPanel
              workspaceId={selectedWorkspaceId}
              agents={agents}
              tasks={tasks}
              onOpenTask={(taskId) => {
                setSelectedTaskId(taskId);
                setRightTab("task");
                setTeamsOpen(false);
              }}
            />
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button className="mc-refresh-btn" onClick={() => setTeamsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewsOpen && selectedWorkspaceId && (
        <div className="mc-editor-overlay">
          <div className="mc-editor-modal mc-standup-modal">
            <AgentPerformanceReviewViewer
              workspaceId={selectedWorkspaceId}
              agents={agents}
              onClose={() => setReviewsOpen(false)}
            />
          </div>
        </div>
      )}


      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .mission-control {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-primary);
    font-family: var(--font-ui);
  }

  .mc-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text-secondary);
  }

  /* Header */
  .mc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
  }

  .mc-header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .mc-header h1 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 1px;
    color: var(--color-text-primary);
    margin: 0;
  }

  .mc-workspace-select {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .mc-workspace-label {
    font-size: 10px;
    color: var(--color-text-muted);
    letter-spacing: 0.4px;
  }

  .mc-workspace-select select {
    border: none;
    background: transparent;
    color: var(--color-text-primary);
    font-size: 12px;
    outline: none;
  }

  .mc-header-stats {
    display: flex;
    gap: 40px;
  }

  .mc-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .mc-stat-value {
    font-size: 24px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .mc-stat-label {
    font-size: 10px;
    color: var(--color-text-secondary);
    letter-spacing: 0.5px;
  }

  .mc-header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .mc-refresh-btn {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-refresh-btn:hover:not(:disabled) {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
  }

  .mc-refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mc-standup-btn {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-standup-btn:hover:not(:disabled) {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
  }

  .mc-standup-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mc-time {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
    font-family: var(--font-mono);
  }

  .mc-status-badge {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .mc-status-badge.online {
    background: var(--color-success-subtle);
    color: var(--color-success);
  }

  /* Main Content Layout */
  .mc-content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .mc-panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
  }

  .mc-panel-header h2 {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .mc-count {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  /* Agents Panel */
  .mc-agents-panel {
    width: 280px;
    min-width: 280px;
    background: var(--color-bg-secondary);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .mc-agents-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .mc-agent-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
  }

  .mc-agent-item:hover {
    background: var(--color-bg-tertiary);
  }

  .mc-agent-item.selected {
    background: var(--color-accent-subtle);
  }

  .mc-agent-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }

  .mc-agent-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mc-agent-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mc-agent-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mc-autonomy-badge {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    color: white;
    letter-spacing: 0.3px;
  }

  .mc-agent-role {
    font-size: 11px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mc-agent-task {
    font-size: 10px;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mc-agent-status {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .mc-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .mc-agent-status.working .mc-status-dot {
    background: var(--color-success);
  }

  .mc-agent-status.idle .mc-status-dot {
    background: var(--color-text-muted);
  }

  .mc-agent-status.offline .mc-status-dot {
    background: var(--color-border);
  }

  .mc-status-text {
    font-size: 9px;
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .mc-heartbeat-time {
    font-size: 9px;
    color: var(--color-text-muted);
    margin-left: 6px;
  }

  .mc-agent-wake {
    margin-left: 10px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
  }

  .mc-agent-wake:hover {
    filter: brightness(0.95);
  }

  .mc-add-agent-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 8px;
    padding: 10px;
    background: var(--color-bg-tertiary);
    border: 1px dashed var(--color-border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-add-agent-btn:hover {
    background: var(--color-bg-hover);
    border-color: var(--color-text-muted);
  }

  .mc-add-twin-btn {
    border-style: solid;
    border-color: color-mix(in srgb, var(--color-accent) 30%, transparent);
    background: var(--color-accent-subtle);
    color: var(--color-accent);
  }

  .mc-add-twin-btn:hover {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
    color: var(--color-accent-hover);
  }

  /* Queue Panel (Kanban) */
  .mc-queue-panel {
    flex: 1;
    background: var(--color-bg-primary);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .mc-kanban {
    display: flex;
    flex-wrap: nowrap;
    gap: 16px;
    padding: 16px;
    flex: 1;
    overflow: auto;
    align-content: flex-start;
  }

  .mc-kanban-column {
    flex: 1 1 200px;
    min-width: 180px;
    max-width: 300px;
    display: flex;
    flex-direction: column;
  }

  .mc-kanban-column.drag-over .mc-column-header {
    background: var(--color-bg-tertiary);
    border-radius: 6px;
    padding-left: 8px;
    padding-right: 8px;
  }

  .mc-column-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    margin-bottom: 8px;
  }

  .mc-column-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .mc-column-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    letter-spacing: 0.5px;
  }

  .mc-column-count {
    font-size: 11px;
    color: var(--color-text-muted);
    margin-left: auto;
  }

  .mc-column-tasks {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mc-task-card {
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-task-card:hover {
    box-shadow: var(--shadow-sm);
    transform: translateY(-1px);
  }

  .mc-task-card.selected {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 20%, transparent);
  }

  .mc-task-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-primary);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .mc-task-assignee {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .mc-task-assignee-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
  }

  .mc-task-assignee-name {
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .mc-task-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Shared status pill styles */
  .mc-task-status-pill,
  .mc-task-detail-status {
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
  }

  .mc-task-status-pill.status-completed,
  .mc-task-detail-status.status-completed {
    background: var(--color-success-subtle);
    color: var(--color-success);
  }

  .mc-task-status-pill.status-executing,
  .mc-task-status-pill.status-planning,
  .mc-task-status-pill.status-interrupted,
  .mc-task-detail-status.status-executing,
  .mc-task-detail-status.status-planning,
  .mc-task-detail-status.status-interrupted {
    background: color-mix(in srgb, var(--color-accent) 15%, var(--color-bg-tertiary));
    color: var(--color-accent);
  }

  .mc-task-status-pill.status-queued,
  .mc-task-status-pill.status-pending,
  .mc-task-detail-status.status-queued,
  .mc-task-detail-status.status-pending {
    background: color-mix(in srgb, var(--color-text-muted) 15%, var(--color-bg-tertiary));
    color: var(--color-text-secondary);
  }

  .mc-task-status-pill.status-paused,
  .mc-task-status-pill.status-blocked,
  .mc-task-detail-status.status-paused,
  .mc-task-detail-status.status-blocked {
    background: color-mix(in srgb, #f59e0b 20%, var(--color-bg-tertiary));
    color: #f59e0b;
  }

  .mc-task-status-pill.status-failed,
  .mc-task-status-pill.status-cancelled,
  .mc-task-detail-status.status-failed,
  .mc-task-detail-status.status-cancelled {
    background: color-mix(in srgb, #ef4444 20%, var(--color-bg-tertiary));
    color: #ef4444;
  }

  .mc-task-time {
    font-size: 10px;
    color: var(--color-text-muted);
  }

  .mc-column-more {
    font-size: 11px;
    color: var(--color-text-secondary);
    text-align: center;
    padding: 8px;
  }

  .mc-column-empty {
    font-size: 11px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 20px 8px;
    background: var(--color-bg-secondary);
    border: 1px dashed var(--color-border);
    border-radius: 8px;
  }

  /* Feed Panel */
  .mc-feed-panel {
    width: 300px;
    background: var(--color-bg-secondary);
    border-left: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .mc-feed-header {
    justify-content: space-between;
  }

  .mc-tabs {
    display: flex;
    gap: 6px;
  }

  .mc-tab-btn {
    padding: 4px 10px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: transparent;
    font-size: 11px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-tab-btn.active {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }

  .mc-clear-task {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
    font-size: 10px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .mc-feed-filters {
    display: flex;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .mc-filter-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 11px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .mc-filter-btn:hover {
    background: var(--color-bg-tertiary);
  }

  .mc-filter-btn.active {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }

  .mc-feed-agents {
    padding: 12px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .mc-feed-agents-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    display: block;
    margin-bottom: 8px;
  }

  .mc-feed-agent-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .mc-agent-chip {
    padding: 3px 8px;
    background: var(--color-bg-primary);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 10px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .mc-agent-chip.active {
    background: var(--color-accent-subtle);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .mc-feed-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .mc-feed-item {
    padding: 10px;
    border-radius: 6px;
    transition: background 0.15s;
  }

  .mc-feed-item:hover {
    background: var(--color-bg-tertiary);
  }

  .mc-feed-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .mc-feed-agent {
    font-size: 12px;
    font-weight: 600;
  }

  .mc-feed-agent.system {
    color: var(--color-text-secondary);
  }

  .mc-feed-time {
    font-size: 10px;
    color: var(--color-text-muted);
  }

  .mc-feed-content {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .mc-feed-empty {
    padding: 40px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  .mc-task-detail {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .mc-task-detail-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .mc-task-detail-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mc-task-detail-title h3 {
    margin: 0;
    font-size: 14px;
    color: var(--color-text-primary);
  }

  /* Note: .mc-task-detail-status styles are shared with .mc-task-status-pill above */

  .mc-task-detail-updated {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .mc-task-detail-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .mc-task-detail-meta label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .mc-task-detail-meta select {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--color-bg-primary);
    color: var(--color-text-primary);
    font-size: 12px;
  }

  .mc-task-detail-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mc-task-detail-section h4 {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-secondary);
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  .mc-task-detail-brief {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-primary);
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .mc-comment-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mc-comment-box textarea {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 8px;
    background: var(--color-bg-primary);
    color: var(--color-text-primary);
    font-size: 12px;
    resize: vertical;
  }

  .mc-comment-submit {
    align-self: flex-start;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: white;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .mc-comment-submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .mc-task-empty {
    padding: 40px 16px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  /* Editor Modal */
  .mc-editor-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .mc-editor-modal {
    background: var(--color-bg-elevated);
    border-radius: 12px;
    width: 90%;
    max-width: 600px;
    max-height: 90%;
    overflow: auto;
    box-shadow: var(--shadow-lg);
  }

  .mc-standup-modal {
    max-width: 900px;
  }

  /* Responsive breakpoints */
  @media (max-width: 1200px) {
    .mc-feed-panel {
      width: 240px;
    }
  }

  @media (max-width: 1000px) {
    .mc-content {
      flex-direction: column;
    }

    .mc-agents-panel {
      width: 100%;
      max-height: 200px;
      border-right: none;
      border-bottom: 1px solid var(--color-border);
    }

    .mc-agents-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px;
    }

    .mc-agent-item {
      flex: 0 0 auto;
      width: auto;
      padding: 8px 12px;
    }

    .mc-add-agent-btn {
      flex: 0 0 auto;
      margin: 0;
      padding: 8px 12px;
    }

    .mc-feed-panel {
      width: 100%;
      max-height: 250px;
      border-left: none;
      border-top: 1px solid var(--color-border);
    }
  }

  @media (max-width: 700px) {
    .mc-header {
      flex-wrap: wrap;
      gap: 12px;
      padding: 12px 16px;
    }

    .mc-header-stats {
      gap: 24px;
    }

    .mc-stat-value {
      font-size: 18px;
    }

    .mc-kanban-column {
      flex: 1 1 100%;
      max-width: none;
    }
  }
`;
