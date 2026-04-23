import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  AgentRoleData,
  HeartbeatStatus,
  AgentCapability,
  ActivityData,
  MentionData,
  TaskLabelData,
  TaskBoardEvent,
} from "../../../electron/preload";
import type {
  Company,
  CompanyCommandCenterSummary,
  CoreEvalCase,
  CoreFailureCluster,
  CoreFailureRecord,
  CoreHarnessExperiment,
  CoreLearningsEntry,
  Goal,
  HeartbeatEvent,
  HeartbeatDispatchKind,
  HeartbeatRun,
  HeartbeatRunEvent,
  HeartbeatSignal,
  HeartbeatSignalFamily,
  Issue,
  IssueComment,
  Project,
  StrategicPlannerConfig,
  StrategicPlannerRun,
  Task,
  Workspace,
} from "../../../shared/types";
import { isTempWorkspaceId } from "../../../shared/types";
import { TASK_EVENT_STATUS_MAP } from "../../../shared/task-event-status-map";
import { useAgentContext } from "../../hooks/useAgentContext";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { createRendererLogger } from "../../utils/logger";

type AgentRole = AgentRoleData;
type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)
const logger = createRendererLogger("MissionControlData");

export const ALL_WORKSPACES_ID = "__all__";

export type MissionColumn = {
  id: string;
  label: string;
  color: string;
  boardColumn: NonNullable<Task["boardColumn"]>;
};

export type TaskPriorityMeta = {
  value: number;
  label: string;
  color: string;
  shortLabel: string;
};

export type TaskDueInfo = {
  label: string;
  tone: "muted" | "soon" | "overdue";
  isOverdue: boolean;
  isDueSoon: boolean;
};

export interface HeartbeatStatusInfo {
  agentRoleId: string;
  agentName: string;
  heartbeatEnabled: boolean;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  nextHeartbeatAt?: number;
  lastPulseResult?: import("../../../shared/types").HeartbeatPulseResultKind;
  lastDispatchKind?: string;
  deferred?: import("../../../shared/types").HeartbeatDeferredState;
  compressedSignalCount?: number;
  dueProactiveCount?: number;
  checklistDueCount?: number;
  dispatchCooldownUntil?: number;
  dispatchesToday?: number;
  maxDispatchesPerDay?: number;
}

export const BOARD_COLUMNS: MissionColumn[] = [
  { id: "inbox", label: "Not started", color: "#91918e", boardColumn: "backlog" },
  { id: "assigned", label: "Ready to start", color: "#f7b955", boardColumn: "todo" },
  { id: "in_progress", label: "Working", color: "#529cca", boardColumn: "in_progress" },
  { id: "review", label: "Needs review", color: "#b07cd8", boardColumn: "review" },
  { id: "done", label: "Done", color: "#4db076", boardColumn: "done" },
];

export const TERMINAL_TASK_STATUSES = new Set<Task["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TASK_PRIORITY_OPTIONS: TaskPriorityMeta[] = [
  { value: 0, label: "None", color: "#6b7280", shortLabel: "P0" },
  { value: 1, label: "Low", color: "#22c55e", shortLabel: "P1" },
  { value: 2, label: "Medium", color: "#f59e0b", shortLabel: "P2" },
  { value: 3, label: "High", color: "#ef4444", shortLabel: "P3" },
  { value: 4, label: "Urgent", color: "#b91c1c", shortLabel: "P4" },
];

const STALE_TASK_AGE_MS = 6 * 60 * 60 * 1000;

export const AUTONOMY_BADGES: Record<string, { label: string; color: string }> = {
  lead: { label: "LEAD", color: "#f59e0b" },
  specialist: { label: "SPC", color: "#3b82f6" },
  intern: { label: "INT", color: "#6b7280" },
};

export type FeedItem = {
  id: string;
  type: "comments" | "tasks" | "status";
  agentId?: string;
  agentName: string;
  content: string;
  taskId?: string;
  workspaceId?: string;
  workspaceName?: string;
  timestamp: number;
};

export type MCTab = "overview" | "agents" | "board" | "feed" | "ops";
export type OpsSubTab = "overview" | "operators" | "outputs" | "execution" | "planner" | "harness";
export type DetailPanelView =
  | { kind: "task"; taskId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "issue"; issueId: string }
  | null;

const DISPLAY_NAME_ALIASES: Record<string, string> = {
  "QA / System Test Engineer Twin": "System QA Twin",
};

function normalizeMissionControlAgentDisplayName(displayName: string): string {
  return DISPLAY_NAME_ALIASES[displayName] || displayName;
}

function normalizeMissionControlAgent(agent: AgentRole): AgentRole {
  return {
    ...agent,
    displayName: normalizeMissionControlAgentDisplayName(agent.displayName),
  };
}

function formatHeartbeatSignalFamily(signalFamily?: HeartbeatSignalFamily): string {
  switch (signalFamily) {
    case "urgent_interrupt":
      return "urgent interrupt";
    case "focus_state":
      return "focus state";
    case "open_loop_pressure":
      return "open loop";
    case "correction_learning":
      return "correction";
    case "memory_drift":
      return "memory";
    case "cross_workspace_patterns":
      return "cross-workspace";
    case "suggestion_aging":
      return "stale suggestion";
    case "awareness_signal":
      return "awareness";
    case "maintenance":
      return "maintenance";
    case "mentions":
      return "mention";
    case "assigned_tasks":
      return "assigned task";
    default:
      return "heartbeat";
  }
}

function formatHeartbeatDispatchKind(dispatchKind?: HeartbeatDispatchKind): string {
  switch (dispatchKind) {
    case "task":
      return "task";
    case "suggestion":
      return "suggestion";
    case "runbook":
      return "runbook";
    case "cron_handoff":
      return "handoff";
    default:
      return "dispatch";
  }
}

function formatHeartbeatSignalText(signal?: HeartbeatSignal): string {
  if (!signal) return "heartbeat signal";
  const reason = signal.reason?.trim();
  if (reason) return reason;
  return `${formatHeartbeatSignalFamily(signal.signalFamily)} signal`;
}

export function getTaskPriorityMeta(priority?: number): TaskPriorityMeta {
  return TASK_PRIORITY_OPTIONS.find((option) => option.value === (priority ?? 0)) || TASK_PRIORITY_OPTIONS[0];
}

export function getTaskDueInfo(dueDate?: number, now = Date.now()): TaskDueInfo | null {
  if (!dueDate) return null;
  const diffMs = dueDate - now;
  const diffMinutes = Math.ceil(diffMs / 60000);
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffMinutes < 0) {
    if (Math.abs(diffMinutes) < 60) {
      return { label: `${Math.abs(diffMinutes)}m overdue`, tone: "overdue", isOverdue: true, isDueSoon: false };
    }
    if (Math.abs(diffMinutes) < 24 * 60) {
      return {
        label: `${Math.ceil(Math.abs(diffMinutes) / 60)}h overdue`,
        tone: "overdue",
        isOverdue: true,
        isDueSoon: false,
      };
    }
    return { label: `${Math.abs(diffDays)}d overdue`, tone: "overdue", isOverdue: true, isDueSoon: false };
  }
  if (diffMinutes <= 24 * 60) {
    if (diffMinutes <= 60) {
      return { label: `Due in ${Math.max(diffMinutes, 1)}m`, tone: "soon", isOverdue: false, isDueSoon: true };
    }
    return {
      label: `Due in ${Math.ceil(diffMinutes / 60)}h`,
      tone: "soon",
      isOverdue: false,
      isDueSoon: true,
    };
  }
  if (diffDays <= 7) {
    return { label: `Due in ${diffDays}d`, tone: "muted", isOverdue: false, isDueSoon: false };
  }
  return {
    label: new Date(dueDate).toLocaleDateString(),
    tone: "muted",
    isOverdue: false,
    isDueSoon: false,
  };
}

export function formatTaskEstimate(minutes?: number): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

export function isTerminalTaskStatus(status: Task["status"]): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function resolveMissionColumnForTask(task: Pick<Task, "status" | "boardColumn" | "assignedAgentRoleId">): MissionColumn["id"] {
  if (isTerminalTaskStatus(task.status)) return "done";
  const col: Task["boardColumn"] | undefined = task.boardColumn;
  const isTerminalBoardColumn = col === "done" || col === "review";
  if (col === "done") return "done";
  if (col === "review") return "review";
  if ((task.status === "planning" || task.status === "executing") && !isTerminalBoardColumn) {
    return "in_progress";
  }
  if (col === "in_progress") return "in_progress";
  if (col === "todo") return "assigned";
  if (col === "backlog") return task.assignedAgentRoleId ? "assigned" : "inbox";
  if (col === "assigned" || col === "inbox") return col;
  return task.assignedAgentRoleId ? "assigned" : "inbox";
}

export function isTaskStaleForUi(
  task: Pick<Task, "status" | "updatedAt" | "createdAt">,
  now = Date.now(),
): boolean {
  if (isTerminalTaskStatus(task.status)) return false;
  const lastTouchedAt = task.updatedAt || task.createdAt;
  return now - lastTouchedAt >= STALE_TASK_AGE_MS;
}

export function useMissionControlData(
  initialCompanyId: string | null = null,
  initialIssueId: string | null = null,
) {
  // ── Core state ──
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(ALL_WORKSPACES_ID);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRole[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskLabels, setTaskLabels] = useState<TaskLabelData[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [activities, setActivities] = useState<ActivityData[]>([]);
  const [mentions, setMentions] = useState<MentionData[]>([]);
  const [heartbeatStatuses, setHeartbeatStatuses] = useState<HeartbeatStatusInfo[]>([]);
  const [events, setEvents] = useState<HeartbeatEvent[]>([]);

  // ── Issue context ──
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssueRunId, setSelectedIssueRunId] = useState<string | null>(null);
  const [issueComments, setIssueComments] = useState<IssueComment[]>([]);
  const [issueRuns, setIssueRuns] = useState<HeartbeatRun[]>([]);
  const [runEvents, setRunEvents] = useState<HeartbeatRunEvent[]>([]);
  const [selectedGoalFilter, setSelectedGoalFilter] = useState<string>("all");
  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string>("all");

  // ── Planner ──
  const [plannerConfig, setPlannerConfig] = useState<StrategicPlannerConfig | null>(null);
  const [plannerRuns, setPlannerRuns] = useState<StrategicPlannerRun[]>([]);
  const [selectedPlannerRunId, setSelectedPlannerRunId] = useState<string | null>(null);
  const [commandCenterSummary, setCommandCenterSummary] = useState<CompanyCommandCenterSummary | null>(null);
  const [coreFailureRecords, setCoreFailureRecords] = useState<CoreFailureRecord[]>([]);
  const [coreFailureClusters, setCoreFailureClusters] = useState<CoreFailureCluster[]>([]);
  const [coreEvalCases, setCoreEvalCases] = useState<CoreEvalCase[]>([]);
  const [coreExperiments, setCoreExperiments] = useState<CoreHarnessExperiment[]>([]);
  const [coreLearnings, setCoreLearnings] = useState<CoreLearningsEntry[]>([]);
  const [plannerLoading, setPlannerLoading] = useState(false);
  const [plannerSaving, setPlannerSaving] = useState(false);
  const [plannerRunning, setPlannerRunning] = useState(false);

  // ── UI state ──
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<MCTab>("overview");
  const [opsSubTab, setOpsSubTab] = useState<OpsSubTab>("overview");
  const [detailPanel, setDetailPanel] = useState<DetailPanelView>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<"all" | "tasks" | "comments" | "status">("all");
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());

  // ── Agent editor ──
  const [editingAgent, setEditingAgent] = useState<AgentRole | null>(null);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // ── Comment ──
  const [commentText, setCommentText] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  // ── Modals ──
  const [standupOpen, setStandupOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);

  // ── Refs for stable subscriptions ──
  const tasksRef = useRef<Task[]>([]);
  const workspaceIdRef = useRef<string | null>(null);
  const visibleWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const agentContext = useAgentContext();

  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { workspaceIdRef.current = selectedWorkspaceId; }, [selectedWorkspaceId]);
  useEffect(() => { setCommentText(""); }, [detailPanel]);
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (selectedWorkspaceId === ALL_WORKSPACES_ID) {
      setStandupOpen(false);
      setTeamsOpen(false);
      setReviewsOpen(false);
      return;
    }
    if (!isTempWorkspaceId(selectedWorkspaceId)) return;
    setStandupOpen(false);
    setReviewsOpen(false);
  }, [selectedWorkspaceId]);
  useEffect(() => {
    visibleWorkspaceIdsRef.current =
      selectedWorkspaceId === ALL_WORKSPACES_ID
        ? new Set(workspaces.map((workspace) => workspace.id))
        : new Set(selectedWorkspaceId ? [selectedWorkspaceId] : []);
  }, [workspaces, selectedWorkspaceId]);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ── Data loading ──
  const loadWorkspaces = useCallback(async () => {
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      let tempWorkspace: Workspace | null = null;
      try { tempWorkspace = await window.electronAPI.getTempWorkspace(); } catch { tempWorkspace = null; }
      const combined = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...loaded.filter((w) => w.id !== tempWorkspace?.id),
      ];
      setWorkspaces(combined);
      setSelectedWorkspaceId((prev) => {
        if (prev === ALL_WORKSPACES_ID) return ALL_WORKSPACES_ID;
        if (prev && combined.some((workspace) => workspace.id === prev)) return prev;
        return combined[0]?.id || null;
      });
    } catch (err) { logger.error("Failed to load workspaces:", err); }
  }, [selectedWorkspaceId]);

  const loadCompanies = useCallback(async () => {
    try {
      const loaded = await window.electronAPI.listCompanies();
      setCompanies(loaded);
      setSelectedCompanyId((prev) => {
        if (prev && loaded.some((c) => c.id === prev)) return prev;
        if (initialCompanyId && loaded.some((c) => c.id === initialCompanyId)) return initialCompanyId;
        return loaded[0]?.id || null;
      });
    } catch (err) { logger.error("Failed to load companies:", err); }
  }, [initialCompanyId]);

  const loadPlannerData = useCallback(async (companyId: string) => {
    try {
      setPlannerLoading(true);
      const [config, runs] = await Promise.all([
        window.electronAPI.getPlannerConfig(companyId),
        window.electronAPI.listPlannerRuns(companyId, 6),
      ]);
      setPlannerConfig(config);
      setPlannerRuns(runs);
      setSelectedPlannerRunId((prev) =>
        prev && runs.some((r) => r.id === prev) ? prev : runs[0]?.id || null,
      );
    } catch (err) {
      logger.error("Failed to load planner data:", err);
      setPlannerConfig(null); setPlannerRuns([]); setSelectedPlannerRunId(null);
    } finally { setPlannerLoading(false); }
  }, []);

  const loadCompanyOps = useCallback(async (companyId: string) => {
    try {
      const [g, p, i] = await Promise.all([
        window.electronAPI.listCompanyGoals(companyId),
        window.electronAPI.listCompanyProjects(companyId),
        window.electronAPI.listCompanyIssues(companyId, 100),
      ]);
      setGoals(g); setProjects(p); setIssues(i);
      setSelectedIssueId((prev) => prev && i.some((x) => x.id === prev) ? prev : i[0]?.id || null);
    } catch (err) {
      logger.error("Failed to load company ops:", err);
      setGoals([]); setProjects([]); setIssues([]); setSelectedIssueId(null);
    }
  }, []);

  const loadCommandCenterSummary = useCallback(async (companyId: string) => {
    try {
      const summary = await window.electronAPI.getCommandCenterSummary(companyId);
      setCommandCenterSummary(summary);
    } catch (err) {
      logger.error("Failed to load command center summary:", err);
      setCommandCenterSummary(null);
    }
  }, []);

  const loadCoreHarnessData = useCallback(async (workspaceId: string | null) => {
    try {
      const workspaceScope =
        workspaceId && workspaceId !== ALL_WORKSPACES_ID ? { workspaceId } : undefined;
      const [failures, clusters, evals, experiments, learnings] = await Promise.all([
        window.electronAPI.listCoreFailureRecords({
          ...(workspaceScope || {}),
          limit: 20,
        }),
        window.electronAPI.listCoreFailureClusters({
          ...(workspaceScope || {}),
          limit: 20,
        }),
        window.electronAPI.listCoreEvalCases({
          ...(workspaceScope || {}),
          limit: 20,
        }),
        window.electronAPI.listCoreExperiments({
          ...(workspaceScope || {}),
          limit: 20,
        }),
        window.electronAPI.listCoreLearnings({
          ...(workspaceScope || {}),
          limit: 25,
        }),
      ]);
      setCoreFailureRecords(failures);
      setCoreFailureClusters(clusters);
      setCoreEvalCases(evals);
      setCoreExperiments(experiments);
      setCoreLearnings(learnings);
    } catch (err) {
      logger.error("Failed to load core harness data:", err);
      setCoreFailureRecords([]);
      setCoreFailureClusters([]);
      setCoreEvalCases([]);
      setCoreExperiments([]);
      setCoreLearnings([]);
    }
  }, []);

  const loadIssueContext = useCallback(async (companyId: string, issueId: string) => {
    try {
      const [comments, runs] = await Promise.all([
        window.electronAPI.listIssueComments(issueId),
        window.electronAPI.listCompanyRuns(companyId, issueId, 20),
      ]);
      setIssueComments(comments); setIssueRuns(runs);
      setSelectedIssueRunId((prev) =>
        prev && runs.some((r) => r.id === prev) ? prev : runs[0]?.id || null,
      );
    } catch (err) {
      logger.error("Failed to load issue context:", err);
      setIssueComments([]); setIssueRuns([]); setSelectedIssueRunId(null); setRunEvents([]);
    }
  }, []);

  const loadWorkspaceScopedData = useCallback(async (workspaceId: string, workspaceList: Workspace[]) => {
    const [loadedAgents, statuses, loadedTasks] = await Promise.all([
      window.electronAPI.getAgentRoles(true),
      window.electronAPI.getAllHeartbeatStatus(),
      window.electronAPI.listTasks().catch(() => []),
    ]);
    const normalizedAgents = loadedAgents.map(normalizeMissionControlAgent);

    if (workspaceId === ALL_WORKSPACES_ID) {
      const workspaceIds = workspaceList.map((workspace) => workspace.id);
      const workspaceIdSet = new Set(workspaceIds);
      const [activityGroups, mentionGroups] = await Promise.all([
        Promise.all(
          workspaceIds.map((id) =>
            window.electronAPI.listActivities({ workspaceId: id, limit: 200 }).catch(() => []),
          ),
        ),
        Promise.all(
          workspaceIds.map((id) =>
            window.electronAPI.listMentions({ workspaceId: id, limit: 200 }).catch(() => []),
          ),
        ),
      ]);
      return {
        loadedAgents: normalizedAgents,
        statuses,
        loadedTasks: loadedTasks.filter((task: Task) => workspaceIdSet.has(task.workspaceId)),
        loadedTaskLabels: (
          await Promise.all(
            workspaceIds.map((id) => window.electronAPI.listTaskLabels({ workspaceId: id }).catch(() => [])),
          )
        )
          .flat()
          .filter((label, index, array) => array.findIndex((item) => item.id === label.id) === index),
        loadedActivities: activityGroups.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
        loadedMentions: mentionGroups.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
      };
    }

    const [loadedActivities, loadedMentions] = await Promise.all([
      window.electronAPI.listActivities({ workspaceId, limit: 200 }).catch(() => []),
      window.electronAPI.listMentions({ workspaceId, limit: 200 }).catch(() => []),
    ]);
    return {
      loadedAgents: normalizedAgents,
      statuses,
      loadedTasks: loadedTasks.filter((task: Task) => task.workspaceId === workspaceId),
      loadedTaskLabels: await window.electronAPI.listTaskLabels({ workspaceId }).catch(() => []),
      loadedActivities,
      loadedMentions,
    };
  }, []);

  const loadData = useCallback(async (workspaceId: string) => {
    try {
      setLoading(true);
      const [result] = await Promise.all([
        loadWorkspaceScopedData(workspaceId, workspaces),
        loadCoreHarnessData(workspaceId),
      ]);
      setAgents(result.loadedAgents);
      setHeartbeatStatuses(result.statuses);
      setTasks(result.loadedTasks);
      setTaskLabels(result.loadedTaskLabels);
      setActivities(result.loadedActivities);
      setMentions(result.loadedMentions);
    } catch (err) { logger.error("Failed to load mission control data:", err); }
    finally { setLoading(false); }
  }, [loadCoreHarnessData, loadWorkspaceScopedData, workspaces]);

  const handleManualRefresh = useCallback(async () => {
    if (!selectedWorkspaceId && !selectedCompanyId) return;
    try {
      setIsRefreshing(true);
      if (selectedWorkspaceId) {
        const [result] = await Promise.all([
          loadWorkspaceScopedData(selectedWorkspaceId, workspaces),
          loadCoreHarnessData(selectedWorkspaceId),
        ]);
        setHeartbeatStatuses(result.statuses);
        setTasks(result.loadedTasks);
        setTaskLabels(result.loadedTaskLabels);
        setActivities(result.loadedActivities);
        setMentions(result.loadedMentions);
      }
      if (selectedCompanyId) {
        await loadPlannerData(selectedCompanyId);
        await loadCompanyOps(selectedCompanyId);
        await loadCommandCenterSummary(selectedCompanyId);
      }
    } catch (err) { logger.error("Failed to refresh:", err); }
    finally { setIsRefreshing(false); }
  }, [loadCommandCenterSummary, loadCompanyOps, loadCoreHarnessData, loadPlannerData, loadWorkspaceScopedData, selectedCompanyId, selectedWorkspaceId, workspaces]);

  // ── Effects: Load on selection change ──
  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);
  useEffect(() => { loadCompanies(); }, [loadCompanies]);
  useEffect(() => { if (selectedWorkspaceId) loadData(selectedWorkspaceId); }, [selectedWorkspaceId, loadData]);

  useEffect(() => {
    if (selectedCompanyId) {
      void loadPlannerData(selectedCompanyId);
      void loadCompanyOps(selectedCompanyId);
      void loadCommandCenterSummary(selectedCompanyId);
    } else {
      setPlannerConfig(null); setPlannerRuns([]); setCommandCenterSummary(null);
      setGoals([]); setProjects([]); setIssues([]);
      setSelectedPlannerRunId(null); setSelectedIssueId(null); setSelectedIssueRunId(null);
      setIssueComments([]); setIssueRuns([]); setRunEvents([]);
    }
    setSelectedGoalFilter("all"); setSelectedProjectFilter("all");
  }, [selectedCompanyId, loadCommandCenterSummary, loadCompanyOps, loadPlannerData]);

  useEffect(() => {
    if (!initialCompanyId) return;
    if (companies.some((c) => c.id === initialCompanyId)) setSelectedCompanyId(initialCompanyId);
  }, [companies, initialCompanyId]);

  useEffect(() => {
    if (selectedCompanyId && selectedIssueId) void loadIssueContext(selectedCompanyId, selectedIssueId);
    else { setIssueComments([]); setIssueRuns([]); setRunEvents([]); }
  }, [loadIssueContext, selectedCompanyId, selectedIssueId]);

  useEffect(() => {
    if (selectedIssueRunId) {
      void window.electronAPI.listRunEvents(selectedIssueRunId)
        .then((ev) => setRunEvents(ev))
        .catch(() => setRunEvents([]));
    } else { setRunEvents([]); }
  }, [selectedIssueRunId]);

  // ── Event subscriptions (stable, empty deps) ──
  useEffect(() => {
    const isWorkspaceVisible = (workspaceId?: string | null) => {
      if (!workspaceId) return false;
      if (workspaceIdRef.current === ALL_WORKSPACES_ID) {
        return visibleWorkspaceIdsRef.current.has(workspaceId);
      }
      return workspaceIdRef.current === workspaceId;
    };

    const unsubHeartbeat = window.electronAPI.onHeartbeatEvent((event: HeartbeatEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 100));
      setHeartbeatStatuses((prev) =>
        prev.map((s) => {
          if (s.agentRoleId !== event.agentRoleId) return s;
          return {
            ...s,
            heartbeatStatus:
              event.type === "started" ? "running"
                : ["work_found", "no_work", "completed"].includes(event.type) ? "sleeping"
                : event.type === "error" ? "error"
                : s.heartbeatStatus,
            lastHeartbeatAt: ["completed", "no_work", "work_found"].includes(event.type)
              ? event.timestamp : s.lastHeartbeatAt,
          };
        }),
      );
    });

    const unsubActivities = window.electronAPI.onActivityEvent((event) => {
      switch (event.type) {
        case "created":
          if (isWorkspaceVisible(event.activity?.workspaceId)) {
            setActivities((prev) => [event.activity!, ...prev].slice(0, 200));
          }
          break;
        case "read":
          setActivities((prev) => prev.map((a) => a.id === event.id ? { ...a, isRead: true } : a));
          break;
        case "all_read":
          if (isWorkspaceVisible(event.workspaceId)) {
            setActivities((prev) =>
              prev.map((activity) =>
                activity.workspaceId === event.workspaceId ? { ...activity, isRead: true } : activity,
              ),
            );
          }
          break;
        case "pinned":
          if (event.activity) setActivities((prev) => prev.map((a) => a.id === event.activity!.id ? event.activity! : a));
          break;
        case "deleted":
          setActivities((prev) => prev.filter((a) => a.id !== event.id));
          break;
      }
    });

    const unsubMentions = window.electronAPI.onMentionEvent((event) => {
      if (!event.mention || !isWorkspaceVisible(event.mention.workspaceId)) return;
      switch (event.type) {
        case "created": setMentions((prev) => [event.mention!, ...prev]); break;
        case "acknowledged": case "completed": case "dismissed":
          setMentions((prev) => prev.map((m) => m.id === event.mention!.id ? event.mention! : m));
          break;
      }
    });

    const unsubTaskEvents = window.electronAPI.onTaskEvent((event: Any) => {
      const effectiveType = getEffectiveTaskEventType(event as Any);
      const isAutoApproval = effectiveType === "approval_requested" && event.payload?.autoApproved === true;
      if (effectiveType === "task_created") {
        const isNew = !tasksRef.current.some((t) => t.id === event.taskId);
        if (isNew && workspaceIdRef.current) {
          window.electronAPI.getTask(event.taskId)
            .then((incoming) => {
              if (!incoming || !isWorkspaceVisible(incoming.workspaceId)) return;
              setTasks((prev) => prev.some((t) => t.id === incoming.id) ? prev : [incoming, ...prev]);
            })
            .catch(() => {});
        }
        return;
      }
      const newStatus = effectiveType === "task_status"
        ? event.payload?.status
        : TASK_EVENT_STATUS_MAP[effectiveType as keyof typeof TASK_EVENT_STATUS_MAP];
      if (newStatus && !isAutoApproval) {
        setTasks((prev) => prev.map((t) => {
          if (t.id !== event.taskId) return t;
          // Never downgrade a terminal status — post-completion events (e.g. verification_passed)
          // must not flip a completed task back to "executing".
          if (isTerminalTaskStatus(t.status) && !isTerminalTaskStatus(newStatus)) return t;
          return { ...t, status: newStatus, updatedAt: Date.now() };
        }));
      }
    });

    const unsubBoard = window.electronAPI.onTaskBoardEvent((event: TaskBoardEvent) => {
      setTasks((prev) =>
        prev.map((task) => {
          if (task.id !== event.taskId) return task;
          switch (event.type) {
            case "moved": return { ...task, boardColumn: event.data?.column };
            case "priorityChanged": return { ...task, priority: event.data?.priority };
            case "labelAdded": return { ...task, labels: [...(task.labels || []), event.data?.labelId].filter((l): l is string => Boolean(l)) };
            case "labelRemoved": return { ...task, labels: (task.labels || []).filter((l) => l !== event.data?.labelId) };
            case "dueDateChanged": return { ...task, dueDate: event.data?.dueDate ?? undefined };
            case "estimateChanged": return { ...task, estimatedMinutes: event.data?.estimatedMinutes ?? undefined };
            default: return task;
          }
        }),
      );
    });

    return () => { unsubHeartbeat(); unsubActivities(); unsubMentions(); unsubTaskEvents(); unsubBoard(); };
  }, []);

  // ── Agent actions ──
  const handleCreateAgent = useCallback(() => {
    setEditingAgent({
      id: "", name: "", displayName: "", description: "", icon: "🤖", color: "#6366f1",
      capabilities: ["code"] as AgentCapability[], isSystem: false, isActive: true,
      sortOrder: 100, createdAt: Date.now(), updatedAt: Date.now(),
    });
    setIsCreatingAgent(true);
  }, []);

  const handleEditAgent = useCallback((agent: AgentRole) => {
    setEditingAgent({ ...agent });
    setIsCreatingAgent(false);
  }, []);

  const handleSaveAgent = useCallback(async (agent: AgentRole) => {
    try {
      setAgentError(null);
      if (isCreatingAgent) {
        const created = await window.electronAPI.createAgentRole({
          name: agent.name, displayName: agent.displayName, description: agent.description,
          icon: agent.icon, color: agent.color, personalityId: agent.personalityId,
          modelKey: agent.modelKey, providerType: agent.providerType, systemPrompt: agent.systemPrompt,
          capabilities: agent.capabilities, toolRestrictions: agent.toolRestrictions,
          autonomyLevel: agent.autonomyLevel, soul: agent.soul,
        });
        setAgents((prev) => [...prev, normalizeMissionControlAgent(created)]);
      } else {
        const updated = await window.electronAPI.updateAgentRole({
          id: agent.id, displayName: agent.displayName, description: agent.description,
          icon: agent.icon, color: agent.color, personalityId: agent.personalityId,
          modelKey: agent.modelKey, providerType: agent.providerType, systemPrompt: agent.systemPrompt,
          capabilities: agent.capabilities, toolRestrictions: agent.toolRestrictions,
          isActive: agent.isActive, sortOrder: agent.sortOrder,
          autonomyLevel: agent.autonomyLevel, soul: agent.soul,
        });
        if (updated) {
          const normalized = normalizeMissionControlAgent(updated);
          setAgents((prev) => prev.map((a) => a.id === normalized.id ? normalized : a));
        }
      }
      setEditingAgent(null); setIsCreatingAgent(false);
      const statuses = await window.electronAPI.getAllHeartbeatStatus();
      setHeartbeatStatuses(statuses);
    } catch (err: Any) { setAgentError(err.message || "Failed to save agent"); }
  }, [isCreatingAgent]);

  // ── Task actions ──
  const getMissionColumnForTask = useCallback((task: Task) => {
    return resolveMissionColumnForTask(task);
  }, []);

  const getBoardColumnForMission = useCallback((missionColumnId: string): NonNullable<Task["boardColumn"]> => {
    const column = BOARD_COLUMNS.find((col) => col.id === missionColumnId);
    return column?.boardColumn ?? "backlog";
  }, []);

  const handleMoveTask = useCallback(async (taskId: string, missionColumnId: string) => {
    try {
      const boardColumn = getBoardColumnForMission(missionColumnId);
      await window.electronAPI.moveTaskToColumn(taskId, boardColumn);
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, boardColumn, updatedAt: Date.now() } : t));
    } catch (err) { logger.error("Failed to move task:", err); }
  }, [getBoardColumnForMission]);

  const handleAssignTask = useCallback(async (taskId: string, agentRoleId: string | null) => {
    try {
      await window.electronAPI.assignAgentRoleToTask(taskId, agentRoleId);
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, assignedAgentRoleId: agentRoleId ?? undefined, updatedAt: Date.now() } : t));
    } catch (err) { logger.error("Failed to assign agent:", err); }
  }, []);

  const handleSetTaskPriority = useCallback(async (taskId: string, priority: number) => {
    try {
      await window.electronAPI.setTaskPriority(taskId, priority);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, priority, updatedAt: Date.now() } : t)));
    } catch (err) {
      logger.error("Failed to set task priority:", err);
    }
  }, []);

  const handleSetTaskDueDate = useCallback(async (taskId: string, dueDate: number | null) => {
    try {
      await window.electronAPI.setTaskDueDate(taskId, dueDate);
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, dueDate: dueDate ?? undefined, updatedAt: Date.now() } : t)),
      );
    } catch (err) {
      logger.error("Failed to set task due date:", err);
    }
  }, []);

  const handleSetTaskEstimate = useCallback(async (taskId: string, estimatedMinutes: number | null) => {
    try {
      await window.electronAPI.setTaskEstimate(taskId, estimatedMinutes);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, estimatedMinutes: estimatedMinutes ?? undefined, updatedAt: Date.now() } : t,
        ),
      );
    } catch (err) {
      logger.error("Failed to set task estimate:", err);
    }
  }, []);

  const handleAddTaskLabel = useCallback(async (taskId: string, labelId: string) => {
    try {
      await window.electronAPI.addTaskLabel(taskId, labelId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, labels: [...new Set([...(t.labels || []), labelId])], updatedAt: Date.now() } : t,
        ),
      );
    } catch (err) {
      logger.error("Failed to add task label:", err);
    }
  }, []);

  const handleRemoveTaskLabel = useCallback(async (taskId: string, labelId: string) => {
    try {
      await window.electronAPI.removeTaskLabel(taskId, labelId);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, labels: (t.labels || []).filter((current) => current !== labelId), updatedAt: Date.now() }
            : t,
        ),
      );
    } catch (err) {
      logger.error("Failed to remove task label:", err);
    }
  }, []);

  const getTaskLabels = useCallback((task: Task) => {
    if (!task.labels?.length) return [];
    const labelIdSet = new Set(task.labels);
    return taskLabels.filter((label) => labelIdSet.has(label.id));
  }, [taskLabels]);

  const isTaskTerminal = useCallback((task: Task) => isTerminalTaskStatus(task.status), []);

  const isTaskStale = useCallback((task: Task) => {
    return isTaskStaleForUi(task);
  }, []);

  const getTaskAttentionReason = useCallback((task: Task) => {
    if (task.terminalStatus === "awaiting_approval") return "Awaiting approval";
    if (task.terminalStatus === "needs_user_action" || task.awaitingUserInputReasonCode) return "Waiting on you";
    if (task.status === "blocked") return "Blocked";
    if (task.status === "paused") return "Paused";
    if (task.status === "failed") return "Run failed";
    if (task.status === "interrupted") return "Interrupted";
    if (task.failureClass === "dependency_unavailable") return "Dependency unavailable";
    if (task.failureClass === "provider_quota") return "Provider quota issue";
    if (task.failureClass === "user_blocker") return "Needs decision";
    if (!task.assignedAgentRoleId) return "Needs owner";
    const due = getTaskDueInfo(task.dueDate);
    if (due?.isOverdue) return "Overdue";
    if (getMissionColumnForTask(task) === "review") return "Needs review";
    if (isTaskStale(task)) return "Stale";
    return null;
  }, [getMissionColumnForTask, isTaskStale]);

  const isTaskAttentionRequired = useCallback((task: Task) => Boolean(getTaskAttentionReason(task)), [getTaskAttentionReason]);

  const getTaskNextMissionColumn = useCallback((task: Task): MissionColumn["id"] => {
    const columnOrder: MissionColumn["id"][] = ["inbox", "assigned", "in_progress", "review", "done"];
    const currentColumn = getMissionColumnForTask(task);
    const currentIndex = columnOrder.indexOf(currentColumn);
    if (currentIndex === -1 || currentIndex === columnOrder.length - 1) return "done";
    return columnOrder[currentIndex + 1];
  }, [getMissionColumnForTask]);

  const handleTriggerHeartbeat = useCallback(async (agentRoleId: string) => {
    try { await window.electronAPI.triggerHeartbeat(agentRoleId); }
    catch (err) { logger.error("Failed to trigger background review:", err); }
  }, []);

  // ── Planner actions ──
  const handlePlannerConfigChange = useCallback(async (
    updates: Partial<{
      enabled: boolean; intervalMinutes: number; planningWorkspaceId: string | null;
      plannerAgentRoleId: string | null; autoDispatch: boolean;
      approvalPreset: "manual" | "safe_autonomy" | "founder_edge";
      maxIssuesPerRun: number; staleIssueDays: number;
    }>,
  ) => {
    if (!selectedCompanyId) return;
    try {
      setPlannerSaving(true);
      const next = await window.electronAPI.updatePlannerConfig({ companyId: selectedCompanyId, ...updates });
      setPlannerConfig(next);
    } catch (err) { logger.error("Failed to update planner config:", err); }
    finally { setPlannerSaving(false); }
  }, [selectedCompanyId]);

  const handleRunPlanner = useCallback(async () => {
    if (!selectedCompanyId) return;
    try {
      setPlannerRunning(true);
      const run = await window.electronAPI.runPlanner(selectedCompanyId);
      setPlannerRuns((prev) => [run, ...prev].slice(0, 6));
      setSelectedPlannerRunId(run.id);
      await loadPlannerData(selectedCompanyId);
      await loadCompanyOps(selectedCompanyId);
      if (selectedWorkspaceId) await handleManualRefresh();
    } catch (err) { logger.error("Failed to run planner:", err); }
    finally { setPlannerRunning(false); }
  }, [handleManualRefresh, loadCompanyOps, loadPlannerData, selectedCompanyId, selectedWorkspaceId]);

  // ── Comment action ──
  const handlePostComment = useCallback(async () => {
    if (!detailPanel || detailPanel.kind !== "task") return;
    const text = commentText.trim();
    if (!text) return;
    const task = tasks.find((t) => t.id === detailPanel.taskId);
    if (!task) return;
    try {
      setPostingComment(true);
      await window.electronAPI.createActivity({
        workspaceId: task.workspaceId, taskId: task.id,
        actorType: "user", activityType: "comment", title: "Comment", description: text,
      });
      setCommentText("");
    } catch (err) { logger.error("Failed to post comment:", err); }
    finally { setPostingComment(false); }
  }, [commentText, detailPanel, tasks]);

  // ── Computed values ──
  const activeAgentsCount = useMemo(() =>
    agents.filter((a) => a.isActive && heartbeatStatuses.some((s) => s.agentRoleId === a.id && s.heartbeatEnabled)).length,
    [agents, heartbeatStatuses],
  );

  const totalTasksInQueue = useMemo(() =>
    tasks.filter((t) => getMissionColumnForTask(t) !== "done").length,
    [tasks, getMissionColumnForTask],
  );

  const workspaceNameById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name] as const)),
    [workspaces],
  );

  const isAllWorkspacesSelected = selectedWorkspaceId === ALL_WORKSPACES_ID;

  const getWorkspaceName = useCallback((workspaceId?: string | null) => {
    if (!workspaceId) return "Unknown workspace";
    return workspaceNameById.get(workspaceId) || workspaceId;
  }, [workspaceNameById]);

  const pendingMentionsCount = useMemo(() =>
    mentions.filter((m) => m.status === "pending").length,
    [mentions],
  );

  const selectedWorkspace = useMemo(() =>
    workspaces.find((w) => w.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
  );

  const selectedCompany = useMemo(() =>
    companies.find((c) => c.id === selectedCompanyId) || null,
    [companies, selectedCompanyId],
  );

  const selectedTask = useMemo(() => {
    if (!detailPanel || detailPanel.kind !== "task") return null;
    return tasks.find((t) => t.id === detailPanel.taskId) || null;
  }, [tasks, detailPanel]);

  const tasksByAgent = useMemo(() => {
    const map = new Map<string, Task[]>();
    tasks.forEach((t) => {
      if (!t.assignedAgentRoleId) return;
      const list = map.get(t.assignedAgentRoleId) || [];
      list.push(t);
      map.set(t.assignedAgentRoleId, list);
    });
    map.forEach((list) => list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)));
    return map;
  }, [tasks]);

  const getTasksByColumn = useCallback((columnId: string) =>
    tasks.filter((t) => getMissionColumnForTask(t) === columnId),
    [tasks, getMissionColumnForTask],
  );

  const getAgent = useCallback((agentId?: string) => {
    if (!agentId) return null;
    return agents.find((a) => a.id === agentId);
  }, [agents]);

  const getAgentStatus = useCallback((agentId: string): "working" | "idle" | "offline" => {
    const status = heartbeatStatuses.find((s) => s.agentRoleId === agentId);
    if (!status?.heartbeatEnabled) return "offline";
    if (status.heartbeatStatus === "running") return "working";
    return "idle";
  }, [heartbeatStatuses]);

  const commandCenterOutputs = commandCenterSummary?.outputs || [];
  const commandCenterReviewQueue = commandCenterSummary?.reviewQueue || [];
  const commandCenterOperators = commandCenterSummary?.operators || [];
  const commandCenterExecutionMap = commandCenterSummary?.executionMap || [];

  const selectedPlannerRun = useMemo(() =>
    plannerRuns.find((r) => r.id === selectedPlannerRunId) || null,
    [plannerRuns, selectedPlannerRunId],
  );

  const plannerManagedIssues = useMemo(() =>
    issues.filter((i) => i.metadata?.plannerManaged === true),
    [issues],
  );

  const selectedIssue = useMemo(() =>
    issues.find((i) => i.id === selectedIssueId) || null,
    [issues, selectedIssueId],
  );

  const selectedIssueRun = useMemo(() =>
    issueRuns.find((r) => r.id === selectedIssueRunId) || null,
    [issueRuns, selectedIssueRunId],
  );

  const filteredIssues = useMemo(() =>
    plannerManagedIssues.filter((i) => {
      if (selectedGoalFilter !== "all" && i.goalId !== selectedGoalFilter) return false;
      if (selectedProjectFilter !== "all" && i.projectId !== selectedProjectFilter) return false;
      return true;
    }),
    [plannerManagedIssues, selectedGoalFilter, selectedProjectFilter],
  );

  useEffect(() => {
    setSelectedIssueId((prev) => {
      if (prev && issues.some((i) => i.id === prev)) return prev;
      return filteredIssues[0]?.id || null;
    });
  }, [filteredIssues, issues]);

  const lastAppliedInitialIssueIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialIssueId) {
      lastAppliedInitialIssueIdRef.current = null;
      return;
    }
    if (lastAppliedInitialIssueIdRef.current === initialIssueId) return;
    const match = issues.find((i) => i.id === initialIssueId);
    if (match) {
      lastAppliedInitialIssueIdRef.current = initialIssueId;
      setSelectedIssueId(initialIssueId);
      setDetailPanel({ kind: "issue", issueId: initialIssueId });
      setActiveTab("ops");
      setOpsSubTab("overview");
    }
  }, [initialIssueId, issues]);

  const plannerRunIssueIds = useMemo(() => {
    const metadata = selectedPlannerRun?.metadata as { createdIssueIds?: string[]; updatedIssueIds?: string[] } | undefined;
    return new Set([...(metadata?.createdIssueIds || []), ...(metadata?.updatedIssueIds || [])]);
  }, [selectedPlannerRun]);

  const plannerRunIssues = useMemo(() =>
    issues.filter((i) => plannerRunIssueIds.has(i.id)),
    [issues, plannerRunIssueIds],
  );

  // ── Feed items ──
  const feedItems = useMemo(() => {
    const formatHeartbeatEventContent = (event: HeartbeatEvent): string => {
      switch (event.type) {
        case "work_found":
          return agentContext.getUiCopy("mcHeartbeatFound", {
            mentions: event.result?.pendingMentions || 0,
            tasks: event.result?.assignedTasks || 0,
          });
        case "signal_received":
          return `received signal: ${formatHeartbeatSignalText(event.signal)}`;
        case "signal_merged": {
          const mergeCount = event.signal?.mergedCount && event.signal.mergedCount > 1
            ? ` (${event.signal.mergedCount}x)`
            : "";
          return `merged repeated signal: ${formatHeartbeatSignalText(event.signal)}${mergeCount}`;
        }
        case "pulse_started":
          return "started background review";
        case "pulse_completed":
          return event.result?.triggerReason
            ? `completed background review: ${event.result.triggerReason}`
            : "completed background review";
        case "pulse_deferred":
          return event.result?.deferredReason || event.deferred?.reason
            ? `deferred background review: ${event.result?.deferredReason || event.deferred?.reason}`
            : "deferred background review";
        case "dispatch_started":
          return `started ${formatHeartbeatDispatchKind(event.dispatchKind)} dispatch`;
        case "dispatch_completed":
          return event.result?.taskCreated
            ? `completed ${formatHeartbeatDispatchKind(event.dispatchKind)} dispatch and created a task`
            : `completed ${formatHeartbeatDispatchKind(event.dispatchKind)} dispatch`;
        case "dispatch_skipped":
          return event.result?.triggerReason
            ? `skipped ${formatHeartbeatDispatchKind(event.dispatchKind)} dispatch: ${event.result.triggerReason}`
            : `skipped ${formatHeartbeatDispatchKind(event.dispatchKind)} dispatch`;
        case "wake_queued":
          return event.wake?.text ? `queued wake: ${event.wake.text}` : "queued background review wake";
        case "wake_coalesced":
          return event.wake?.text ? `coalesced wake: ${event.wake.text}` : "coalesced repeated wake";
        case "wake_queue_saturated":
          return "dropped wake because the queue was saturated";
        case "wake_immediate_deferred":
          return "deferred immediate wake until the next review";
        case "no_work":
          return event.result?.triggerReason
            ? `no action needed: ${event.result.triggerReason}`
            : "no action needed";
        case "started":
          return "background review started";
        case "completed":
          return "background review completed";
        case "error":
          return event.error ? `background review error: ${event.error}` : "background review error";
        default:
          return event.type;
      }
    };

    const activityItems = activities.map((activity) => {
      const mappedType =
        activity.activityType === "comment" || activity.activityType === "mention" ? "comments"
        : activity.activityType.startsWith("task_") || activity.activityType === "agent_assigned" ? "tasks"
        : "status";
      const agentName =
        activity.actorType === "user" ? agentContext.getUiCopy("activityActorUser")
        : getAgent(activity.agentRoleId)?.displayName || agentContext.getUiCopy("activityActorSystem");
      const content = activity.description ? `${activity.title} — ${activity.description}` : activity.title;
      return {
        id: activity.id,
        type: mappedType as FeedItem["type"],
        agentId: activity.agentRoleId,
        agentName,
        content,
        taskId: activity.taskId,
        workspaceId: activity.workspaceId,
        workspaceName: getWorkspaceName(activity.workspaceId),
        timestamp: activity.createdAt,
      };
    });

    const heartbeatItems = events
      .filter((e) => { if (e.type === "completed") return false; if (e.type === "no_work" && e.result?.silent) return false; return true; })
      .map<FeedItem>((e) => ({
        id: `event-${e.timestamp}`,
        type: "status",
        agentId: e.agentRoleId,
        agentName: normalizeMissionControlAgentDisplayName(e.agentName),
        content: formatHeartbeatEventContent(e),
        timestamp: e.timestamp,
        taskId: undefined,
        workspaceId: undefined,
        workspaceName: undefined,
      }));

    return [...heartbeatItems, ...activityItems]
      .filter((item) => {
        if (feedFilter !== "all" && item.type !== feedFilter) return false;
        if (selectedAgent) { if (!item.agentId || item.agentId !== selectedAgent) return false; }
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);
  }, [activities, events, feedFilter, selectedAgent, getAgent, agentContext, getWorkspaceName]);

  // ── Utilities ──
  const formatRelativeTime = useCallback((timestamp?: number) => {
    if (!timestamp) return "";
    const now = Date.now();
    const diff = now - timestamp;
    const abs = Math.abs(diff);
    const fmt = (v: number, u: string, s: string) => `${v}${u} ${s}`;
    if (abs < 60000) return diff < 0 ? "in <1m" : "just now";
    if (abs < 3600000) { const m = Math.floor(abs / 60000); return diff < 0 ? fmt(m, "m", "from now") : `${m}m ago`; }
    if (abs < 86400000) { const h = Math.floor(abs / 3600000); return diff < 0 ? fmt(h, "h", "from now") : `${h}h ago`; }
    const d = Math.floor(abs / 86400000);
    return diff < 0 ? fmt(d, "d", "from now") : `${d}d ago`;
  }, []);

  return {
    // Core data
    workspaces, selectedWorkspaceId, setSelectedWorkspaceId,
    companies, selectedCompanyId, setSelectedCompanyId,
    agents, tasks, goals, projects, issues, activities, mentions,
    heartbeatStatuses, events,

    // Issue context
    selectedIssueId, setSelectedIssueId,
    selectedIssueRunId, setSelectedIssueRunId,
    issueComments, issueRuns, runEvents,
    selectedGoalFilter, setSelectedGoalFilter,
    selectedProjectFilter, setSelectedProjectFilter,

    // Planner
    plannerConfig, plannerRuns, selectedPlannerRunId, setSelectedPlannerRunId,
    commandCenterSummary, plannerLoading, plannerSaving, plannerRunning,
    coreFailureRecords, coreFailureClusters, coreEvalCases, coreExperiments, coreLearnings,

    // UI state
    loading, isRefreshing, activeTab, setActiveTab,
    opsSubTab, setOpsSubTab,
    detailPanel, setDetailPanel,
    selectedAgent, setSelectedAgent,
    feedFilter, setFeedFilter,
    dragOverColumn, setDragOverColumn,
    currentTime,

    // Agent editor
    editingAgent, setEditingAgent, isCreatingAgent, agentError,

    // Comment
    commentText, setCommentText, postingComment,

    // Modals
    standupOpen, setStandupOpen,
    teamsOpen, setTeamsOpen,
    reviewsOpen, setReviewsOpen,

    // Computed
    activeAgentsCount, totalTasksInQueue, pendingMentionsCount,
    selectedWorkspace, selectedCompany, selectedTask,
    isAllWorkspacesSelected, getWorkspaceName,
    tasksByAgent, feedItems,
    taskLabels,
    commandCenterOutputs, commandCenterReviewQueue,
    commandCenterOperators, commandCenterExecutionMap,
    selectedPlannerRun, plannerManagedIssues,
    selectedIssue, selectedIssueRun,
    filteredIssues, plannerRunIssueIds, plannerRunIssues,

    // Callbacks
    getTasksByColumn, getAgent, getAgentStatus, getMissionColumnForTask,
    getTaskLabels, getTaskAttentionReason, getTaskNextMissionColumn,
    isTaskTerminal, isTaskStale, isTaskAttentionRequired,
    handleManualRefresh, handleMoveTask, handleAssignTask, handleTriggerHeartbeat,
    handleSetTaskPriority, handleSetTaskDueDate, handleSetTaskEstimate,
    handleAddTaskLabel, handleRemoveTaskLabel,
    handlePlannerConfigChange, handleRunPlanner, handlePostComment,
    handleCreateAgent, handleEditAgent, handleSaveAgent,
    formatRelativeTime, formatTaskEstimate, getTaskDueInfo, getTaskPriorityMeta,
    agentContext,
  };
}

export type MissionControlData = ReturnType<typeof useMissionControlData>;
