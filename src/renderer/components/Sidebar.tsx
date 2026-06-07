import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useDeferredValue, memo } from "react";
import { ChevronDown, ChevronRight, SlidersHorizontal, EyeOff, AppWindow, Bell, HardDrive, Rows3, Search, Server, Workflow, HeartPulse, Lightbulb, Inbox, Users, UsersRound, ListFilter, EllipsisVertical, Shapes, Plus, Sparkles, Repeat2 } from "lucide-react";
import { resolveTwinIcon } from "../utils/twin-icons";
import { stripAllEmojis } from "../utils/emoji-replacer";
import { Task, Workspace, UiDensity, InfraStatus, UpdateInfo } from "../../shared/types";
import type { MailboxDigestSnapshot, MailboxSyncStatus } from "../../shared/mailbox";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { VirtualList } from "./VirtualList";
import { capitalizeSidebarSessionTitle } from "../utils/sidebar-title";
import { deriveSlashCommandTaskTitle } from "../utils/slash-command-title";

const SIDEBAR_ITEM_HEIGHT = 22;
const SIDEBAR_DATE_HEADER_HEIGHT = 20;
const SIDEBAR_FOCUSED_ITEM_HEIGHT = 28;
const SIDEBAR_FOCUSED_DATE_HEADER_HEIGHT = 26;
const SIDEBAR_AUTOMATED_HEADER_HEIGHT = 30;
const SIDEBAR_LOAD_MORE_HEIGHT = 32;
const SIDEBAR_VIRTUALIZATION_MIN_ROWS = 30;
const SIDEBAR_LOAD_MORE_THRESHOLD_PX = 320;

interface AgentRoleInfo {
  id: string;
  displayName: string;
  color: string;
  icon?: string;
}

export function formatRelativeShort(timestamp?: number): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 12) return `${Math.max(1, months)}mo`;
  const years = Math.round(days / 365);
  return `${Math.max(1, years)}y`;
}

interface SidebarProps {
  workspace: Workspace | null;
  tasks: Task[];
  selectedTaskId: string | null;
  isHomeActive?: boolean;
  isIdeasActive?: boolean;
  isInboxAgentActive?: boolean;
  isAgentsActive?: boolean;
  isEverydayAgentActive?: boolean;
  isMissionControlActive?: boolean;
  isHealthActive?: boolean;
  isLoadingSessions?: boolean;
  isLoadingMoreTasks?: boolean;
  completionAttentionTaskIds?: string[];
  onSelectTask: (id: string | null) => void;
  onOpenHome?: () => void;
  onOpenIdeas?: () => void;
  onOpenInboxAgent?: () => void;
  onOpenAgents?: () => void;
  onOpenEverydayAgent?: () => void;
  onOpenHealth?: () => void;
  onNewSession?: () => void;
  onOpenSettings: () => void;
  onOpenMissionControl: () => void;
  onOpenDevices?: () => void;
  isDevicesActive?: boolean;

  onTasksChanged: () => void;
  onLoadMoreTasks?: () => void;
  hasMoreTasks?: boolean;
  uiDensity?: UiDensity;
  updateInfo?: UpdateInfo | null;
  onViewUpdate?: () => void;
}

/** Visual session mode derived from task metadata */
export type SessionMode =
  | "standard"
  | "autonomous"
  | "collab"
  | "multitask"
  | "multi-llm"
  | "scheduled"
  | "think"
  | "comparison"
  | "video";

const SESSION_MODE_META: Record<SessionMode, { label: string; shortLabel: string; color: string }> =
  {
    standard: { label: "Standard", shortLabel: "STD", color: "standard" },
    autonomous: { label: "Autonomous", shortLabel: "AUTO", color: "autonomous" },
    collab: { label: "Collaborative", shortLabel: "COLLAB", color: "collab" },
    multitask: { label: "Multitask", shortLabel: "MULTI", color: "collab" },
    "multi-llm": { label: "Multi-LLM", shortLabel: "MULTI", color: "multi-llm" },
    scheduled: { label: "Scheduled", shortLabel: "SCHED", color: "scheduled" },
    think: { label: "Think", shortLabel: "THINK", color: "think" },
    comparison: { label: "Comparison", shortLabel: "CMP", color: "comparison" },
    video: { label: "Video", shortLabel: "VID", color: "video" },
  };

/** Derive the primary session mode from task metadata */
export function getSessionMode(task: Task): SessionMode {
  if (task.agentConfig?.videoGenerationMode || task.agentConfig?.taskDomain === "media") return "video";
  if (task.agentConfig?.multitaskMode) return "multitask";
  if (task.agentConfig?.collaborativeMode) return "collab";
  if (task.agentConfig?.multiLlmMode) return "multi-llm";
  if (task.agentConfig?.autonomousMode) return "autonomous";
  if (task.agentConfig?.conversationMode === "think") return "think";
  if (task.comparisonSessionId) return "comparison";
  if (task.source === "cron" || task.title?.startsWith("Scheduled:")) return "scheduled";
  return "standard";
}

/** Returns true for sessions that were created automatically (not by the user
 *  directly). These are grouped into a collapsible "Automated" folder at the
 *  bottom of the sidebar so they don't push user sessions off screen. */
export function isAutomatedSession(task: Task): boolean {
  return isAutomatedTaskLike(task);
}

const HIDDEN_FOCUSED_STATUSES: ReadonlySet<Task["status"]> = new Set(["failed", "cancelled"]);
const ACTIVE_SESSION_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "executing",
  "planning",
  "interrupted",
]);
const AWAITING_SESSION_STATUSES: ReadonlySet<Task["status"]> = new Set(["paused", "blocked"]);

function MacMiniIcon({ className, size = 18 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" style={{ display: 'block' }}>
      <path d="M 4 6.5 L 20 6.5 Q 21.8 6.5 21.8 8.3 L 21.8 14.1 Q 21.8 15.9 20 15.9 L 4 15.9 Q 2.2 15.9 2.2 14.1 L 2.2 8.3 Q 2.2 6.5 4 6.5 Z" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 6.5 16.2 Q 12 19.1 17.5 16.2" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="17.0" cy="11.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19.6" cy="11.2" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function isActiveSessionStatus(status: Task["status"]): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export function isAwaitingSessionStatus(status: Task["status"]): boolean {
  return AWAITING_SESSION_STATUSES.has(status);
}

export function shouldShowTaskInSidebarSessions(task: Task): boolean {
  if (task.source === "managed_agent_panel") return false;
  return !task.targetNodeId;
}

export function compareTasksByPinAndRecency(a: Task, b: Task): number {
  const pinnedDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDiff !== 0) return pinnedDiff;
  const recencyDiff = (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
  if (recencyDiff !== 0) return recencyDiff;
  return b.createdAt - a.createdAt;
}

export function getSidebarDateGroup(task: Pick<Task, "createdAt" | "pinned">, now = new Date()): string {
  if (task.pinned) return "Pinned";

  const date = new Date(task.createdAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  return "Earlier";
}

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function shouldShowRootTaskInSidebar(
  task: Task,
  uiDensity: UiDensity,
  showFailedSessions: boolean,
  hasPinnedDescendant = false,
): boolean {
  if (uiDensity !== "focused") return true;
  if (showFailedSessions) return true;
  if (task.pinned) return true;
  if (hasPinnedDescendant) return true;
  return !HIDDEN_FOCUSED_STATUSES.has(task.status);
}

export function countHiddenFailedSessions(tasks: Task[], uiDensity: UiDensity): number {
  const cache = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentTaskId) {
      const siblings = cache.get(task.parentTaskId) || [];
      siblings.push(task);
      cache.set(task.parentTaskId, siblings);
    }
  }

  const hasPinnedDescendant = (taskId: string): boolean => {
    const stack = [...(cache.get(taskId) || [])];
    const seen = new Set<string>();

    while (stack.length > 0) {
      const task = stack.pop();
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);

      if (task.pinned) return true;

      const children = cache.get(task.id) || [];
      for (const child of children) {
        if (!seen.has(child.id)) {
          stack.push(child);
        }
      }
    }

    return false;
  };

  if (uiDensity !== "focused") return 0;
  return tasks.filter(
    (task) =>
      shouldShowTaskInSidebarSessions(task) &&
      !task.parentTaskId &&
      !task.pinned &&
      !hasPinnedDescendant(task.id) &&
      HIDDEN_FOCUSED_STATUSES.has(task.status),
  ).length;
}

// Tree node structure for hierarchical display
export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
  synthetic?: boolean;
  displayTitle?: string;
}

const GENERIC_SESSION_TITLES = new Set([
  "...",
  "new session",
  "new task",
  "run",
  "run...",
  "untitled",
  "untitled session",
  "untitled task",
]);

function normalizeSidebarTitleCandidate(value?: string | null): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const userRequestMatch = trimmed.match(/(?:^|\n)User request:\s*([\s\S]+)/i);
  const candidate = (userRequestMatch?.[1] || trimmed).replace(/\s+/g, " ").trim();
  return deriveSlashCommandTaskTitle(candidate) || candidate;
}

function isGenericSidebarTitle(value: string): boolean {
  return GENERIC_SESSION_TITLES.has(normalizeSidebarSessionSearch(value));
}

export function getSidebarSessionTitle(node: Pick<TaskTreeNode, "displayTitle" | "task">): string {
  const primaryCandidates = [node.displayTitle, node.task.title];
  for (const candidate of primaryCandidates) {
    const normalized = normalizeSidebarTitleCandidate(candidate);
    if (normalized && !isGenericSidebarTitle(normalized)) return capitalizeSidebarSessionTitle(normalized);
  }

  const fallbackCandidates = [
    node.task.sidebarPromptPreview,
    node.task.userPrompt,
    node.task.rawPrompt,
    node.task.prompt,
    node.task.semanticSummary,
    node.task.resultSummary,
    node.task.bestKnownOutcome?.resultSummary,
    node.task.branchLabel,
    ...primaryCandidates,
  ];
  for (const candidate of fallbackCandidates) {
    const normalized = normalizeSidebarTitleCandidate(candidate);
    if (normalized) return capitalizeSidebarSessionTitle(normalized);
  }

  return "Untitled session";
}

const SIDEBAR_TITLE_ELLIPSIS = "...";

type TextMeasurer = (value: string) => number;

export function truncateSidebarTitleToFit(
  value: string,
  maxWidth: number,
  measureText: TextMeasurer,
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (maxWidth <= 0) return normalized;
  if (measureText(normalized) <= maxWidth) return normalized;

  const ellipsisWidth = measureText(SIDEBAR_TITLE_ELLIPSIS);
  if (ellipsisWidth > maxWidth) return "";

  let low = 0;
  let high = normalized.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = normalized.slice(0, mid).trimEnd();
    const candidate = `${prefix}${SIDEBAR_TITLE_ELLIPSIS}`;
    if (measureText(candidate) <= maxWidth) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best || SIDEBAR_TITLE_ELLIPSIS;
}

let sidebarTitleMeasureCanvas: HTMLCanvasElement | null = null;

function getSidebarTitleMeasureContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  sidebarTitleMeasureCanvas ||= document.createElement("canvas");
  return sidebarTitleMeasureCanvas.getContext("2d");
}

function getElementFont(element: HTMLElement): string {
  const style = window.getComputedStyle(element);
  if (style.font) return style.font;
  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
}

function SidebarWordBoundaryTitle({
  text,
  className,
  title,
}: {
  text: string;
  className: string;
  title: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [displayText, setDisplayText] = useState(() => text.replace(/\s+/g, " ").trim());

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") {
      setDisplayText(text.replace(/\s+/g, " ").trim());
      return;
    }

    const update = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width <= 0) return;

      const context = getSidebarTitleMeasureContext();
      if (!context) {
        setDisplayText(text.replace(/\s+/g, " ").trim());
        return;
      }

      context.font = getElementFont(element);
      const next = truncateSidebarTitleToFit(
        text,
        width,
        (candidate) => context.measureText(candidate).width,
      );
      setDisplayText((current) => (current === next ? current : next));
    };

    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={ref} className={className} title={title}>
      {displayText}
    </span>
  );
}

export function normalizeSidebarSessionSearch(value: string): string {
  return stripAllEmojis(value).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function getTaskTreeNodeSearchText(node: TaskTreeNode): string {
  return normalizeSidebarSessionSearch(
    [
      getSidebarSessionTitle(node),
      node.displayTitle,
      node.task.title,
      node.task.sidebarPromptPreview,
      node.task.userPrompt,
      node.task.rawPrompt,
      node.task.prompt,
      node.task.semanticSummary,
      node.task.resultSummary,
      node.task.branchLabel,
      node.task.id,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" "),
  );
}

function filterTaskTreeBySearchInternal(
  nodes: TaskTreeNode[],
  normalizedQuery: string,
): TaskTreeNode[] {
  return nodes.flatMap((node) => {
    const matchesSelf = getTaskTreeNodeSearchText(node).includes(normalizedQuery);
    if (matchesSelf) {
      return [node];
    }

    const filteredChildren = filterTaskTreeBySearchInternal(node.children, normalizedQuery);

    if (filteredChildren.length === 0) {
      return [];
    }

    return [{ ...node, children: filteredChildren }];
  });
}

export function filterTaskTreeBySearch(nodes: TaskTreeNode[], query: string): TaskTreeNode[] {
  const normalizedQuery = normalizeSidebarSessionSearch(query);
  if (!normalizedQuery) return nodes;
  return filterTaskTreeBySearchInternal(nodes, normalizedQuery);
}

export interface SidebarVisibleRow {
  node: TaskTreeNode;
  depth: number;
  isLast: boolean;
  rootIndex: number;
}

export type SidebarVirtualRow =
  | {
      kind: "date-header";
      id: string;
      label: string;
    }
  | {
      kind: "automated-header";
      id: string;
      count: number;
      expanded: boolean;
      hasActive: boolean;
    }
  | {
      kind: "task";
      row: SidebarVisibleRow;
      section?: "user" | "automated";
    }
  | {
      kind: "load-more";
      id: string;
      loading: boolean;
    };

export function flattenVisibleTaskRows(
  nodes: TaskTreeNode[],
  collapsedTaskIds: ReadonlySet<string>,
): SidebarVisibleRow[] {
  const rows: SidebarVisibleRow[] = [];

  const visit = (siblings: TaskTreeNode[], depth: number, rootIndex: number) => {
    siblings.forEach((node, siblingIndex) => {
      const resolvedRootIndex = depth === 0 ? siblingIndex : rootIndex;
      rows.push({
        node,
        depth,
        isLast: siblingIndex === siblings.length - 1,
        rootIndex: resolvedRootIndex,
      });

      if (node.children.length > 0 && !collapsedTaskIds.has(node.task.id)) {
        visit(node.children, depth + 1, resolvedRootIndex);
      }
    });
  };

  visit(nodes, 0, 0);
  return rows;
}

export function buildSidebarVirtualRows(
  taskRows: SidebarVisibleRow[],
  options: { showDateHeaders: boolean; now?: Date },
): SidebarVirtualRow[] {
  if (!options.showDateHeaders) {
    return taskRows.map((row) => ({ kind: "task", row, section: "user" }));
  }

  const rows: SidebarVirtualRow[] = [];
  const now = options.now ?? new Date();
  let previousRootGroup = "";

  taskRows.forEach((row, index) => {
    if (row.depth === 0) {
      const group = getSidebarDateGroup(row.node.task, now);
      if (group !== previousRootGroup) {
        rows.push({
          kind: "date-header",
          id: `date:${group}:${row.node.task.id}:${index}`,
          label: group,
        });
        previousRootGroup = group;
      }
    }
    rows.push({ kind: "task", row, section: "user" });
  });

  return rows;
}

function compareTaskTreeNodes(a: TaskTreeNode, b: TaskTreeNode): number {
  return compareTasksByPinAndRecency(a.task, b.task);
}

function getSidebarTaskListSignature(tasks: Task[]): string {
  if (tasks.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < Math.min(tasks.length, 100); i++) {
    const t = tasks[i];
    parts.push(`${t.id}:${t.status}:${t.updatedAt ?? 0}`);
  }
  return `${tasks.length}|${parts.join(",")}`;
}

function areSidebarPropsEqual(prev: SidebarProps, next: SidebarProps): boolean {
  return (
    prev.workspace?.id === next.workspace?.id &&
    prev.selectedTaskId === next.selectedTaskId &&
    prev.isHomeActive === next.isHomeActive &&
    prev.isIdeasActive === next.isIdeasActive &&
    prev.isInboxAgentActive === next.isInboxAgentActive &&
    prev.isAgentsActive === next.isAgentsActive &&
    prev.isEverydayAgentActive === next.isEverydayAgentActive &&
    prev.isMissionControlActive === next.isMissionControlActive &&
    prev.isHealthActive === next.isHealthActive &&
    prev.isDevicesActive === next.isDevicesActive &&
    prev.isLoadingSessions === next.isLoadingSessions &&
    prev.isLoadingMoreTasks === next.isLoadingMoreTasks &&
    prev.hasMoreTasks === next.hasMoreTasks &&
    prev.uiDensity === next.uiDensity &&
    getSidebarTaskListSignature(prev.tasks) === getSidebarTaskListSignature(next.tasks) &&
    (prev.completionAttentionTaskIds || []).join(",") === (next.completionAttentionTaskIds || []).join(",") &&
    prev.updateInfo?.latestVersion === next.updateInfo?.latestVersion &&
    prev.onSelectTask === next.onSelectTask &&
    prev.onTasksChanged === next.onTasksChanged &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.onOpenMissionControl === next.onOpenMissionControl
  );
}

function SidebarComponent({
  workspace,
  tasks,
  selectedTaskId,
  isHomeActive = false,
  isIdeasActive = false,
  isInboxAgentActive = false,
  isAgentsActive = false,
  isEverydayAgentActive = false,
  isMissionControlActive = false,
  isHealthActive = false,
  isLoadingSessions = false,
  completionAttentionTaskIds = [],
  onSelectTask,
  onOpenHome,
  onOpenIdeas,
  onOpenInboxAgent,
  onOpenAgents,
  onOpenEverydayAgent,
  onOpenHealth,
  onNewSession,
  onOpenSettings,
  onOpenMissionControl,
  onOpenDevices,
  isDevicesActive = false,
  isLoadingMoreTasks = false,

  onTasksChanged,
  onLoadMoreTasks,
  hasMoreTasks = false,
  uiDensity = "focused",
  updateInfo,
  onViewUpdate,
}: SidebarProps) {
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [menuOpenTaskId, setMenuOpenTaskId] = useState<string | null>(null);
  const [renameTaskId, setRenameTaskId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const [agentRoles, setAgentRoles] = useState<Map<string, AgentRoleInfo>>(new Map());
  const [showFailedSessions, setShowFailedSessions] = useState(false);
  const [showAutomatedSessions, setShowAutomatedSessions] = useState(false);
  const [showSessionSearch, setShowSessionSearch] = useState(false);
  const [showSessionFilters, setShowSessionFilters] = useState(false);
  const [pinActionError, setPinActionError] = useState<string | null>(null);
  const [archiveActionError, setArchiveActionError] = useState<string | null>(null);
  const [activeModeFilters, setActiveModeFilters] = useState<Set<SessionMode>>(new Set());
  const [showFilterBar] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [moreCollapsed, setMoreCollapsed] = useState(true);
  const [sessionSearch, setSessionSearch] = useState("");
  // Automated sessions folder is collapsed by default to keep the sidebar clean
  const [automatedFolderCollapsed, setAutomatedFolderCollapsed] = useState(true);
  const [mailboxDigest, setMailboxDigest] = useState<MailboxDigestSnapshot | null>(null);
  const [mailboxStatus, setMailboxStatus] = useState<MailboxSyncStatus | null>(null);
  const pinActionErrorTimeoutRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const renameInputRef = useRef<HTMLInputElement>(null);
  const taskListRef = useRef<HTMLDivElement>(null);
  const completionAttentionSet = useMemo(
    () => new Set(completionAttentionTaskIds),
    [completionAttentionTaskIds],
  );
  const deferredSessionSearch = useDeferredValue(sessionSearch);
  const normalizedSessionSearch = useMemo(
    () => normalizeSidebarSessionSearch(deferredSessionSearch),
    [deferredSessionSearch],
  );
  const hasSessionSearch = normalizedSessionSearch.length > 0;
  const isMoreActive = isMissionControlActive || isHealthActive || isIdeasActive;
  const isMoreExpanded = isMoreActive || !moreCollapsed;

  useEffect(() => {
    window.electronAPI
      .getAgentRoles(false)
      .then((roles: { id: string; displayName: string; color?: string; icon?: string }[]) => {
        const map = new Map<string, AgentRoleInfo>();
        for (const r of roles) {
          map.set(r.id, {
            id: r.id,
            displayName: r.displayName,
            color: r.color || "#6366f1",
            icon: r.icon,
          });
        }
        setAgentRoles(map);
      })
      .catch(() => {});
  }, []);

  const loadMailboxInboxUnread = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getMailboxDigest || !api?.getMailboxSyncStatus) return;
    const [digest, status] = await Promise.all([
      api.getMailboxDigest(workspace?.id).catch(() => null),
      api.getMailboxSyncStatus().catch(() => null),
    ]);
    setMailboxDigest(digest);
    setMailboxStatus(status);
  }, [workspace?.id]);

  useEffect(() => {
    void loadMailboxInboxUnread();
  }, [loadMailboxInboxUnread]);

  const mailboxEventDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMailboxEvent) return;
    const unsubscribe = api.onMailboxEvent(() => {
      if (mailboxEventDebounceRef.current !== null) {
        clearTimeout(mailboxEventDebounceRef.current);
      }
      mailboxEventDebounceRef.current = setTimeout(() => {
        mailboxEventDebounceRef.current = null;
        void loadMailboxInboxUnread();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (mailboxEventDebounceRef.current !== null) {
        clearTimeout(mailboxEventDebounceRef.current);
      }
    };
  }, [loadMailboxInboxUnread]);

  const inboxUnreadCount = mailboxDigest?.unreadCount ?? mailboxStatus?.unreadCount ?? 0;
  const inboxNavLabel =
    inboxUnreadCount > 0
      ? `Inbox (${inboxUnreadCount > 99 ? "99+" : inboxUnreadCount})`
      : "Inbox";
  // Build task tree from flat list
  const taskTree = useMemo(() => {
    const childrenMap = new Map<string, Task[]>();

    // Index all tasks
    for (const task of tasks) {
      if (task.parentTaskId) {
        const siblings = childrenMap.get(task.parentTaskId) || [];
        siblings.push(task);
        childrenMap.set(task.parentTaskId, siblings);
      }
    }

    const hasPinnedDescendant = (taskId: string): boolean => {
      const stack = [...(childrenMap.get(taskId) || [])];
      const seen = new Set<string>();

      while (stack.length > 0) {
        const task = stack.pop();
        if (!task || seen.has(task.id)) continue;
        seen.add(task.id);

        if (task.pinned) return true;

        const children = childrenMap.get(task.id) || [];
        for (const child of children) {
          if (!seen.has(child.id)) {
            stack.push(child);
          }
        }
      }

      return false;
    };

    // Build tree nodes recursively
    const buildNode = (task: Task): TaskTreeNode => {
      const children = childrenMap.get(task.id) || [];
      // Sort children: pinned sessions first, then newest first
      children.sort(compareTasksByPinAndRecency);
      return {
        task,
        children: children.map(buildNode),
      };
    };

    // Get root tasks (no parent) and sort by creation time (newest first)
    let rootTasks = tasks
      .filter((t) => !t.parentTaskId && shouldShowTaskInSidebarSessions(t))
      .filter((t) =>
        shouldShowRootTaskInSidebar(t, uiDensity, showFailedSessions, hasPinnedDescendant(t.id)),
      )
      .sort(compareTasksByPinAndRecency);

    const groupedNodes: TaskTreeNode[] = [];
    const consumed = new Set<string>();
    const improvementRoots = rootTasks.filter(
      (task) => task.source === "improvement" || task.source === "subconscious",
    );

    for (const task of improvementRoots) {
      if (consumed.has(task.id)) continue;
      const match = task.title.match(/^Improve \(([^)]+)\):\s*(.+)$/);
      if (!match) continue;
      const suffix = match[2].trim();
      const siblings = improvementRoots.filter((candidate) => {
        if (consumed.has(candidate.id)) return false;
        const candidateMatch = candidate.title.match(/^Improve \(([^)]+)\):\s*(.+)$/);
        if (!candidateMatch) return false;
        if (candidateMatch[2].trim() !== suffix) return false;
        return Math.abs(candidate.createdAt - task.createdAt) <= 60_000;
      });
      if (siblings.length < 2) continue;

      siblings.sort(compareTasksByPinAndRecency);
      for (const sibling of siblings) consumed.add(sibling.id);

      const syntheticTask: Task = {
        ...siblings[0],
        id: `improvement-group:${suffix}:${task.createdAt}`,
        title: `Improve campaign: ${suffix}`,
        status: siblings.some((item) => isActiveSessionStatus(item.status))
          ? "executing"
          : siblings.some((item) => isAwaitingSessionStatus(item.status))
            ? "paused"
            : siblings.every((item) => item.status === "completed")
              ? "completed"
              : siblings.every((item) => item.status === "failed" || item.status === "cancelled")
                ? "failed"
                : siblings[0].status,
        createdAt: Math.min(...siblings.map((item) => item.createdAt)),
        updatedAt: Math.max(...siblings.map((item) => item.updatedAt)),
      };

      groupedNodes.push({
        task: syntheticTask,
        synthetic: true,
        displayTitle: syntheticTask.title,
        children: siblings.map((child) => buildNode(child)),
      });
    }

    const remainingNodes = rootTasks.filter((task) => !consumed.has(task.id)).map(buildNode);
    return [...groupedNodes, ...remainingNodes].sort(compareTaskTreeNodes);
  }, [tasks, uiDensity, showFailedSessions]);

  // Split root tasks into user-created vs automated sessions.
  // Automated sessions (improvement, cron, hook, api, heartbeat) are rendered
  // in a separate collapsible folder so they don't crowd out user sessions.
  const { userTaskTree, automatedTaskTree } = useMemo(() => {
    const user: TaskTreeNode[] = [];
    const automated: TaskTreeNode[] = [];
    for (const node of taskTree) {
      if (isAutomatedSession(node.task)) {
        automated.push(node);
      } else {
        user.push(node);
      }
    }
    return { userTaskTree: user, automatedTaskTree: automated };
  }, [taskTree]);

  // Count hidden failed sessions for the toggle label
  const failedSessionCount = useMemo(() => {
    return countHiddenFailedSessions(tasks, uiDensity);
  }, [tasks, uiDensity]);

  // Count root tasks per session mode (for filter badge counts).
  // Automated sessions live in their own folder, so they're excluded from
  // the mode-filter bar counts.
  const modeCounts = useMemo(() => {
    const counts = new Map<SessionMode, number>();
    for (const node of userTaskTree) {
      const mode = getSessionMode(node.task);
      counts.set(mode, (counts.get(mode) || 0) + 1);
    }
    return counts;
  }, [userTaskTree]);

  // Which modes are actually present in current sessions
  const availableModes = useMemo(() => {
    const modes: SessionMode[] = [];
    for (const mode of Object.keys(SESSION_MODE_META) as SessionMode[]) {
      if ((modeCounts.get(mode) || 0) > 0) modes.push(mode);
    }
    return modes;
  }, [modeCounts]);
  const availableModeSet = useMemo(() => new Set(availableModes), [availableModes]);

  // Remove stale filters when workspace/task data changes and previously
  // selected modes are no longer available.
  useEffect(() => {
    if (activeModeFilters.size === 0) return;

    let hasStaleFilter = false;
    for (const mode of activeModeFilters) {
      if (!availableModeSet.has(mode)) {
        hasStaleFilter = true;
        break;
      }
    }
    if (!hasStaleFilter) return;

    setActiveModeFilters((prev) => {
      let changed = false;
      const next = new Set<SessionMode>();
      for (const mode of prev) {
        if (availableModeSet.has(mode)) {
          next.add(mode);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeModeFilters, availableModeSet]);

  // Apply mode filter to user sessions only; automated sessions are always
  // shown in their own folder regardless of the active mode filter.
  const modeFilteredTaskTree = useMemo(() => {
    if (activeModeFilters.size === 0) return userTaskTree;
    return userTaskTree.filter((node) => activeModeFilters.has(getSessionMode(node.task)));
  }, [userTaskTree, activeModeFilters]);

  const filteredTaskTree = useMemo(
    () => filterTaskTreeBySearch(modeFilteredTaskTree, normalizedSessionSearch),
    [modeFilteredTaskTree, normalizedSessionSearch],
  );

  const filteredAutomatedTaskTree = useMemo(
    () => filterTaskTreeBySearch(automatedTaskTree, normalizedSessionSearch),
    [automatedTaskTree, normalizedSessionSearch],
  );
  const visibleAutomatedTaskTree = useMemo(
    () => (hasSessionSearch || showAutomatedSessions ? filteredAutomatedTaskTree : []),
    [filteredAutomatedTaskTree, hasSessionSearch, showAutomatedSessions],
  );

  const effectiveCollapsedTasks = useMemo(
    () => (hasSessionSearch ? new Set<string>() : collapsedTasks),
    [collapsedTasks, hasSessionSearch],
  );

  const toggleModeFilter = useCallback((mode: SessionMode) => {
    setActiveModeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (pinActionErrorTimeoutRef.current !== null) {
        window.clearTimeout(pinActionErrorTimeoutRef.current);
      }
    };
  }, []);

  const virtualizedTaskRows = useMemo(
    () => flattenVisibleTaskRows(filteredTaskTree, effectiveCollapsedTasks),
    [effectiveCollapsedTasks, filteredTaskTree],
  );
  const automatedTaskRows = useMemo(
    () => flattenVisibleTaskRows(visibleAutomatedTaskTree, effectiveCollapsedTasks),
    [effectiveCollapsedTasks, visibleAutomatedTaskTree],
  );
  const automatedRowsExpanded = hasSessionSearch || !automatedFolderCollapsed;
  const sidebarVirtualRows = useMemo(
    () => {
      const rows: SidebarVirtualRow[] = [];
      if (visibleAutomatedTaskTree.length > 0) {
        rows.push({
          kind: "automated-header",
          id: "automated-header",
          count: visibleAutomatedTaskTree.length,
          expanded: automatedRowsExpanded,
          hasActive: visibleAutomatedTaskTree.some((node) => isActiveSessionStatus(node.task.status)),
        });
        if (automatedRowsExpanded) {
          rows.push(
            ...automatedTaskRows.map(
              (row): SidebarVirtualRow => ({ kind: "task", row, section: "automated" }),
            ),
          );
        }
      }
      rows.push(
        ...buildSidebarVirtualRows(virtualizedTaskRows, {
          showDateHeaders: uiDensity === "focused",
        }),
      );
      if (hasMoreTasks) {
        rows.push({ kind: "load-more", id: "load-more", loading: isLoadingMoreTasks });
      }
      return rows;
    },
    [
      automatedRowsExpanded,
      automatedTaskRows,
      hasMoreTasks,
      isLoadingMoreTasks,
      uiDensity,
      virtualizedTaskRows,
      visibleAutomatedTaskTree,
    ],
  );

  const useVirtualizedTaskRows = sidebarVirtualRows.length > SIDEBAR_VIRTUALIZATION_MIN_ROWS;

  // Auto-collapse sub-agent trees in focused mode
  const hasInitializedCollapse = useRef(false);
  useEffect(() => {
    const parentByTaskId = new Map<string, string>();
    const parentsWithChildren = new Set<string>();

    for (const task of tasks) {
      if (task.parentTaskId) {
        parentByTaskId.set(task.id, task.parentTaskId);
        parentsWithChildren.add(task.parentTaskId);
      }
    }

    const expandAncestorsForPinned = (collapsed: Set<string>): void => {
      for (const task of tasks) {
        if (!task.pinned) continue;

        let currentParent = task.parentTaskId;
        const seen = new Set<string>();
        while (currentParent && !seen.has(currentParent)) {
          seen.add(currentParent);
          collapsed.delete(currentParent);
          const nextParent = parentByTaskId.get(currentParent);
          if (!nextParent) break;
          currentParent = nextParent;
        }
      }
    };

    if (uiDensity === "focused") {
      if (!hasInitializedCollapse.current) {
        expandAncestorsForPinned(parentsWithChildren);
        if (parentsWithChildren.size > 0) {
          setCollapsedTasks((prev) =>
            areStringSetsEqual(prev, parentsWithChildren) ? prev : parentsWithChildren,
          );
        }
        hasInitializedCollapse.current = true;
      } else {
        setCollapsedTasks((prev) => {
          const next = new Set(prev);
          expandAncestorsForPinned(next);
          return areStringSetsEqual(prev, next) ? prev : next;
        });
      }
    }
    if (uiDensity === "full") {
      hasInitializedCollapse.current = false;
    }
  }, [uiDensity, tasks]);

  // Infinite scroll — load the next page when the user scrolls near the bottom
  useEffect(() => {
    if (useVirtualizedTaskRows) return;
    const el = taskListRef.current;
    if (!el || !onLoadMoreTasks) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - scrollTop - clientHeight < SIDEBAR_LOAD_MORE_THRESHOLD_PX) {
        onLoadMoreTasks();
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [onLoadMoreTasks, useVirtualizedTaskRows]);

  // If the first page does not fill the scroll container (for example because
  // focused mode hides failed sessions), keep paging until the list can scroll.
  useEffect(() => {
    if (useVirtualizedTaskRows || sessionsCollapsed || !hasMoreTasks || !onLoadMoreTasks) return;

    const frame = window.requestAnimationFrame(() => {
      const el = taskListRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight + SIDEBAR_LOAD_MORE_THRESHOLD_PX) {
        onLoadMoreTasks();
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    filteredTaskTree.length,
    hasMoreTasks,
    onLoadMoreTasks,
    sessionsCollapsed,
    useVirtualizedTaskRows,
    visibleAutomatedTaskTree.length,
  ]);

  // Close menu when clicking outside (use 'click' not 'mousedown' so moving from outside to menu still allows selection)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpenTaskId(null);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renameTaskId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTaskId]);

  const handleMenuToggle = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setMenuOpenTaskId(menuOpenTaskId === taskId ? null : taskId);
  };

  const focusMenuButton = (taskId: string) => {
    const button = menuButtonRef.current.get(taskId);
    if (button) {
      button.focus();
    }
  };

  const focusFirstMenuItem = () => {
    const menu = menuRef.current;
    const first = menu?.querySelector<HTMLButtonElement>("button[data-menu-option]");
    first?.focus();
  };

  const focusMenuItem = (offset: 1 | -1) => {
    const menu = menuRef.current;
    if (!menu) return;

    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("button[data-menu-option]"),
    );
    if (options.length === 0) return;

    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    const next = options[nextIndex];
    next?.focus();
  };

  const closeMenu = (taskId: string) => {
    setMenuOpenTaskId(null);
    focusMenuButton(taskId);
  };

  const handleMenuButtonKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      const nextOpen = menuOpenTaskId === taskId ? null : taskId;
      setMenuOpenTaskId(nextOpen);
      if (nextOpen) {
        requestAnimationFrame(() => focusFirstMenuItem());
      }
      return;
    }

    if (e.key === "Escape") {
      closeMenu(taskId);
    }
  };

  const handleMenuItemKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusMenuItem(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusMenuItem(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(taskId);
      return;
    }
  };

  const handleRenameClick = (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpenTaskId(null);
    setRenameTaskId(task.id);
    setRenameValue(task.title);
  };

  const handleRenameSubmit = async (taskId: string) => {
    if (renameValue.trim()) {
      await window.electronAPI.renameTask(taskId, renameValue.trim());
      onTasksChanged();
    }
    setRenameTaskId(null);
    setRenameValue("");
  };

  const handlePinClick = async (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpenTaskId(null);
    setPinActionError(null);
    try {
      await window.electronAPI.toggleTaskPin(task.id);
      onTasksChanged();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to update pin state. Please try again.";
      console.error("Failed to toggle pin:", error);
      setPinActionError(message);
      if (pinActionErrorTimeoutRef.current !== null) {
        window.clearTimeout(pinActionErrorTimeoutRef.current);
      }
      pinActionErrorTimeoutRef.current = window.setTimeout(() => {
        setPinActionError(null);
      }, 2500);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === "Enter") {
      handleRenameSubmit(taskId);
    } else if (e.key === "Escape") {
      setRenameTaskId(null);
      setRenameValue("");
    }
  };

  const handleArchiveClick = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuOpenTaskId(null);
    setArchiveActionError(null);
    try {
      await window.electronAPI.deleteTask(taskId);
      if (selectedTaskId === taskId) {
        onSelectTask(null);
      }
      onTasksChanged();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to archive session. Please try again.";
      console.error("Failed to archive task:", error);
      setArchiveActionError(message);
      if (pinActionErrorTimeoutRef.current !== null) {
        window.clearTimeout(pinActionErrorTimeoutRef.current);
      }
      pinActionErrorTimeoutRef.current = window.setTimeout(() => {
        setArchiveActionError(null);
      }, 2500);
    }
  };

  const toggleCollapse = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const getStatusIndicator = (status: Task["status"], showCompletionAttention = false) => {
    if (isActiveSessionStatus(status)) {
      return (
        <>
          <span className="terminal-only">[~]</span>
          <span className="modern-only">
            <span className="cli-session-indicator cli-session-indicator-active" aria-hidden="true" />
          </span>
        </>
      );
    }

    if (isAwaitingSessionStatus(status)) {
      return (
        <>
          <span className="terminal-only">[?]</span>
          <span className="modern-only">
            <span
              className="cli-session-indicator cli-session-indicator-awaiting"
              aria-hidden="true"
            />
          </span>
        </>
      );
    }

    switch (status) {
      case "completed":
        if (!showCompletionAttention) {
          return (
            <>
              <span className="terminal-only">[ ]</span>
              <span className="modern-only">
                <span className="cli-session-indicator cli-session-indicator-invisible" aria-hidden="true" />
              </span>
            </>
          );
        }
        return (
          <>
            <span className="terminal-only">[•]</span>
            <span className="modern-only">
              <span
                className="cli-session-indicator cli-session-indicator-completed"
                aria-hidden="true"
              />
            </span>
          </>
        );
      case "failed":
      case "cancelled":
        return (
          <>
            <span className="terminal-only">[✗]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          </>
        );
      default:
        return (
          <>
            <span className="terminal-only">[ ]</span>
            <span className="modern-only">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" opacity="0.3"></circle>
              </svg>
            </span>
          </>
        );
    }
  };

  const getStatusClass = (status: Task["status"], showCompletionAttention = false) => {
    if (isActiveSessionStatus(status)) return "active";
    if (isAwaitingSessionStatus(status)) return "awaiting";
    if (status === "completed" && showCompletionAttention) return "completed";

    switch (status) {
      case "failed":
      case "cancelled":
        return "failed";
      default:
        return "";
    }
  };

  const getSubagentIcon = (task: Task) => {
    if (!task.parentTaskId) return null;
    const role = task.assignedAgentRoleId ? agentRoles.get(task.assignedAgentRoleId) : undefined;
    if (role?.icon) {
      const Icon = resolveTwinIcon(role.icon);
      return (
        <span title={role.displayName}>
          <Icon
            className="cli-subagent-icon"
            size={14}
            strokeWidth={2}
          />
        </span>
      );
    }
    if (task.agentType === "parallel") {
      return (
        <span title="Parallel agent">
          <Workflow
            className="cli-subagent-icon cli-subagent-icon-parallel"
            size={14}
            strokeWidth={2}
          />
        </span>
      );
    }
    return null;
  };

  const handleNewTask = () => {
    if (onNewSession) {
      onNewSession();
      return;
    }
    // Fallback: deselect current task to show the welcome/new task screen
    onSelectTask(null);
  };

  const navigateDevicesSection = useCallback(
    (section: "overview" | "tasks" | "devices" | "apps" | "storage" | "alerts") => {
      window.dispatchEvent(new CustomEvent("devices:navigate", { detail: { section } }));
    },
    [],
  );

  const triggerDevicesAction = useCallback((action: "pairing") => {
    window.dispatchEvent(new CustomEvent("devices:action", { detail: { action } }));
  }, []);

  const remoteTasks = useMemo(
    () => tasks.filter((task) => !!task.targetNodeId),
    [tasks],
  );

  const remoteDeviceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of remoteTasks) {
      if (task.targetNodeId) ids.add(task.targetNodeId);
    }
    return ids;
  }, [remoteTasks]);

  const remoteAttentionCount = useMemo(
    () =>
      remoteTasks.filter(
        (task) =>
          task.status === "blocked" ||
          task.status === "failed" ||
          task.terminalStatus === "awaiting_approval" ||
          task.terminalStatus === "needs_user_action",
      ).length,
    [remoteTasks],
  );

  // Render a task node and its children recursively
  const renderTaskRow = (
    node: TaskTreeNode,
    rootIndex: number,
    depth: number = 0,
    isLast: boolean = true,
  ): React.ReactNode => {
    const { task, children } = node;
    const hasChildren = children.length > 0;
    const isCollapsed = !hasSessionSearch && collapsedTasks.has(task.id);
    const isSubAgent = !!task.parentTaskId;

    // Tree connector prefix based on depth
    const treePrefix = depth > 0 ? (isLast ? "└─" : "├─") : "";
    const taskMode = depth === 0 ? getSessionMode(task) : null;
    const modeClass = taskMode && taskMode !== "standard" ? `session-mode-${taskMode}` : "";
    const isChatSession =
      task.agentConfig?.executionMode === "chat" &&
      task.agentConfig?.executionModeSource === "user";
    const showCompletionAttention =
      task.status === "completed" &&
      !isChatSession &&
      selectedTaskId !== task.id &&
      completionAttentionSet.has(task.id);
    const isAwaitingSession = isAwaitingSessionStatus(task.status);
    const isAutomatedTask = isAutomatedSession(task);
    const sessionTitle = getSidebarSessionTitle(node);
    const sessionActions = !node.synthetic ? (
      <div
        className="task-item-actions cli-task-actions"
        ref={menuOpenTaskId === task.id ? menuRef : null}
      >
        <button
          type="button"
          className="task-item-more cli-more-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpenTaskId === task.id}
          aria-controls={`task-menu-${task.id}`}
          aria-label={`Session actions for ${sessionTitle}`}
          onClick={(e) => handleMenuToggle(e, task.id)}
          onKeyDown={(e) => handleMenuButtonKeyDown(e, task.id)}
          ref={(el) => {
            if (el) {
              menuButtonRef.current.set(task.id, el);
            } else {
              menuButtonRef.current.delete(task.id);
            }
          }}
        >
          <EllipsisVertical size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
        {menuOpenTaskId === task.id && (
          <div
            id={`task-menu-${task.id}`}
            className="task-item-menu cli-task-menu"
            role="menu"
            aria-label="Session actions"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="task-item-menu-option cli-menu-option"
              role="menuitem"
              data-menu-option="rename"
              onMouseDown={(e) => {
                if (e.button === 0) {
                  e.preventDefault();
                  handleRenameClick(e as unknown as React.MouseEvent, task);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleRenameClick(e as unknown as React.MouseEvent, task);
                }
                handleMenuItemKeyDown(e, task.id);
              }}
            >
              <span className="cli-menu-prefix">&gt;</span>
              rename
            </button>
            <button
              type="button"
              className="task-item-menu-option cli-menu-option"
              role="menuitem"
              data-menu-option="pin"
              onMouseDown={(e) => {
                if (e.button === 0) {
                  e.preventDefault();
                  handlePinClick(e as unknown as React.MouseEvent, task);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handlePinClick(e as unknown as React.MouseEvent, task);
                }
                handleMenuItemKeyDown(e, task.id);
              }}
            >
              <span className="cli-menu-prefix">&gt;</span>
              {task.pinned ? "unpin" : "pin"}
            </button>
            <button
              type="button"
              className="task-item-menu-option task-item-menu-option-danger cli-menu-option cli-menu-danger"
              role="menuitem"
              data-menu-option="archive"
              onMouseDown={(e) => {
                if (e.button === 0) {
                  e.preventDefault();
                  handleArchiveClick(e as unknown as React.MouseEvent, task.id);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleArchiveClick(e as unknown as React.MouseEvent, task.id);
                }
                handleMenuItemKeyDown(e, task.id);
              }}
            >
              <span className="cli-menu-prefix">&gt;</span>
              archive
            </button>
          </div>
        )}
      </div>
    ) : null;

    return (
      <div
        className={`task-item cli-task-item ${selectedTaskId === task.id ? "task-item-selected" : ""} ${isSubAgent ? "task-item-subagent" : ""} ${node.synthetic ? "task-item-group-root" : ""} ${modeClass} ${hasChildren ? "task-item-has-children" : ""} ${showCompletionAttention ? "task-completion-unread" : ""}`}
        data-task-id={node.synthetic ? undefined : task.id}
        onClick={() => {
          if (node.synthetic) return;
          if (renameTaskId === task.id) return;
          onSelectTask(task.id);
        }}
        style={
          {
            "--cli-task-padding-left": depth === 0 ? "12px" : `${4 + depth * 12}px`,
          } as React.CSSProperties
        }
        title={
          taskMode && taskMode !== "standard" ? SESSION_MODE_META[taskMode].label : undefined
        }
      >
          {/* Tree connector for sub-agents */}
          {depth > 0 && <span className="cli-tree-prefix">{treePrefix}</span>}

          <span className="cli-task-num">
            {depth === 0 ? String(rootIndex + 1).padStart(2, "0") : "··"}
          </span>

          {!isAwaitingSession && (
            <span className={`cli-task-status ${getStatusClass(task.status, showCompletionAttention)}`}>
              {getStatusIndicator(task.status, showCompletionAttention)}
            </span>
          )}

          {task.pinned && (
            <span className="cli-task-pinned" title="Pinned">
              📌
            </span>
          )}

          {/* Lucide icon for sub-agents */}
          {getSubagentIcon(task)}

          {/* Git branch indicator for worktree-isolated tasks */}
          {task.worktreeBranch && (
            <span
              className="cli-task-branch"
              title={task.worktreeBranch}
              style={{
                display: "inline-flex",
                alignItems: "center",
                marginRight: "4px",
                color: "var(--color-accent)",
                opacity: 0.7,
                flexShrink: 0,
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </span>
          )}

          <div className="task-item-content cli-task-content">
            {renameTaskId === task.id ? (
              <input
                ref={renameInputRef}
                type="text"
                className="task-item-rename-input cli-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => handleRenameKeyDown(e, task.id)}
                onBlur={() => handleRenameSubmit(task.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className={`cli-task-title-row ${isAwaitingSession ? "cli-task-title-row-awaiting" : ""}`}>
                {isSubAgent && task.assignedAgentRoleId ? (
                  <span
                    className="cli-task-title cli-task-title-with-agent cli-task-title-subagent-role"
                    title={sessionTitle}
                  >
                    {(() => {
                      const role = agentRoles.get(task.assignedAgentRoleId!);
                      const label = role
                        ? stripAllEmojis(role.displayName)
                        : stripAllEmojis(sessionTitle);
                      return (
                        <span
                          className="cli-task-agent-name"
                          style={role ? { color: role.color } : undefined}
                        >
                          {label}
                        </span>
                      );
                    })()}
                  </span>
                ) : (
                  <SidebarWordBoundaryTitle
                    text={sessionTitle}
                    className="cli-task-title"
                    title={sessionTitle}
                  />
                )}
                {isAwaitingSession && (
                  <span className="cli-task-awaiting-badge">Awaiting response</span>
                )}
                {hasChildren && !hasSessionSearch && (
                  <button
                    className="cli-collapse-btn cli-collapse-btn-inline"
                    onClick={(e) => toggleCollapse(e, task.id)}
                    title={isCollapsed ? "Expand" : "Collapse"}
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                )}
                {!isAwaitingSession && (
                  <span className="cli-task-time-wrap">
                    {showCompletionAttention && (
                      <span className="task-completion-unread-dot" aria-hidden="true" />
                    )}
                    {isAutomatedTask && (
                      <span
                        className="cli-task-automation-icon"
                        title="Automated task"
                        aria-label="Automated task"
                      >
                        <Repeat2 size={13} strokeWidth={2} />
                      </span>
                    )}
                    <span className="cli-task-time" aria-hidden="true">
                      {formatRelativeShort(task.updatedAt || task.createdAt)}
                    </span>
                    {sessionActions}
                  </span>
                )}
                {isAwaitingSession && sessionActions && (
                  <span className="cli-task-action-wrap">
                    {sessionActions}
                  </span>
                )}
              </div>
            )}
          </div>

      </div>
    );
  };

  const renderTaskNode = (
    node: TaskTreeNode,
    index: number,
    depth: number = 0,
    isLast: boolean = true,
  ): React.ReactNode => {
    const { task, children } = node;
    const isCollapsed = !hasSessionSearch && collapsedTasks.has(task.id);
    const hasChildren = children.length > 0;

    return (
      <div
        key={task.id}
        className={`task-tree-node ${menuOpenTaskId === task.id ? "task-item-menu-open" : ""}`}
      >
        {renderTaskRow(node, index, depth, isLast)}

        {/* Render children if not collapsed */}
        {hasChildren && !isCollapsed && (
          <div className="task-tree-children">
            {children.map((child, childIndex) =>
              renderTaskNode(child, childIndex, depth + 1, childIndex === children.length - 1),
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSidebarVirtualRow = (row: SidebarVirtualRow): React.ReactNode => {
    if (row.kind === "date-header") {
      return <div className="sidebar-date-group">{row.label}</div>;
    }
    if (row.kind === "automated-header") {
      return (
        <button
          type="button"
          className="automated-folder-header"
          onClick={() => setAutomatedFolderCollapsed((value) => !value)}
          aria-expanded={row.expanded}
          title={row.expanded ? "Hide automated sessions" : "Show automated sessions"}
        >
          <span className="automated-folder-label">
            <span className="terminal-only">AUTOMATED</span>
            <span className="modern-only">Automated</span>
            <span className="automated-folder-chevron" aria-hidden="true">
              {row.expanded ? "▾" : "▸"}
            </span>
          </span>
          <span className="automated-folder-count">{row.count}</span>
          {row.hasActive && (
            <span
              className="cli-session-indicator cli-session-indicator-active automated-folder-active"
              aria-label="Has active session"
            />
          )}
        </button>
      );
    }
    if (row.kind === "load-more") {
      return (
        <button
          type="button"
          className={`task-list-load-more ${row.loading ? "loading" : "idle"}`}
          onClick={row.loading ? undefined : onLoadMoreTasks}
          disabled={row.loading || !onLoadMoreTasks}
          aria-busy={row.loading}
        >
          <span className="terminal-only">
            {row.loading ? "loading more..." : "load more sessions"}
          </span>
          <span className="modern-only">
            {row.loading ? "Loading more sessions..." : "Load more sessions"}
          </span>
        </button>
      );
    }

    return (
      <div
        className={`task-tree-node ${row.row.depth > 0 ? "task-tree-node-child" : ""} ${row.section === "automated" ? "task-tree-node-automated" : ""} ${menuOpenTaskId === row.row.node.task.id ? "task-item-menu-open" : ""}`}
      >
        {renderTaskRow(row.row.node, row.row.rootIndex, row.row.depth, row.row.isLast)}
      </div>
    );
  };

  return (
    <div className="sidebar cli-sidebar">
      {updateInfo?.available && !updateDismissed && (
        <div className="sidebar-update-slot">
          <button
            type="button"
            className="update-banner"
            aria-label="Open update settings"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onViewUpdate?.();
            }}
          >
            Update
          </button>
          <button
            type="button"
            className="update-banner-dismiss"
            aria-label="Dismiss update banner"
            onClick={(event) => {
              event.stopPropagation();
              setUpdateDismissed(true);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* New Session Button */}
      <div className="sidebar-header">
        <div className="cli-header-actions sidebar-nav">
          <button
            className="new-task-btn cli-new-task-btn cli-action-btn sidebar-new-session-btn"
            onClick={handleNewTask}
          >
            <span className="terminal-only">
              <span className="cli-btn-bracket">[</span>
              <span className="cli-btn-plus">+</span>
              <span className="cli-btn-bracket">]</span>
            </span>
            <span className="cli-btn-text">
              <span className="terminal-only">new_session</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon sidebar-new-session-icon" aria-hidden="true">
                  <Plus size={16} strokeWidth={2} style={{ display: "block" }} />
                </span>
                <span>New</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isAgentsActive ? "active" : ""}`}
            onClick={onOpenAgents}
            aria-pressed={isAgentsActive}
            title="Agents"
          >
            <span className="cli-btn-text">
              <span className="terminal-only">agents</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: "flex" }}>
                  <UsersRound size={16} strokeWidth={2} style={{ display: "block" }} />
                </span>
                <span>Agents</span>
              </span>
            </span>
          </button>

          <button
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-devices-btn cli-devices-btn sidebar-nav-item ${isDevicesActive ? "active" : ""}`}
            onClick={onOpenDevices}
            title="Devices"
          >
            <span className="terminal-only">
              <span className="cli-btn-bracket">[</span>
              <span className="cli-btn-accent">DV</span>
              <span className="cli-btn-bracket">]</span>
            </span>
            <span className="cli-btn-text">
              <span className="terminal-only">devices</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: 'flex' }}>
                  <MacMiniIcon size={16} />
                </span>
                <span>Devices</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isInboxAgentActive ? "active" : ""}`}
            onClick={onOpenInboxAgent}
            aria-pressed={isInboxAgentActive}
            title={inboxNavLabel}
            aria-label={inboxNavLabel}
          >
            <span className="cli-btn-text">
              <span className="terminal-only">inbox</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: 'flex' }}>
                  <Inbox size={16} strokeWidth={2} style={{ display: 'block' }} />
                </span>
                <span>{inboxNavLabel}</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isHomeActive ? "active" : ""}`}
            onClick={onOpenHome}
            aria-pressed={isHomeActive}
            title="Automations"
          >
            <span className="cli-btn-text">
              <span className="terminal-only">automation</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: 'flex' }}>
                  <Workflow size={16} strokeWidth={2} style={{ display: 'block' }} />
                </span>
                <span>Automations</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isEverydayAgentActive ? "active" : ""}`}
            onClick={onOpenEverydayAgent}
            aria-pressed={isEverydayAgentActive}
            title="Everyday Agent"
          >
            <span className="cli-btn-text">
              <span className="terminal-only">everyday_agent</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: "flex" }}>
                  <Sparkles size={16} strokeWidth={2} style={{ display: "block" }} />
                </span>
                <span>Everyday</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className="new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item sidebar-more-toggle"
            onClick={() => setMoreCollapsed((value) => !value)}
            aria-expanded={isMoreExpanded}
            title={isMoreExpanded ? "Collapse More" : "Expand More"}
          >
            <span className="cli-btn-text">
              <span className="terminal-only">more</span>
              <span className="modern-only cli-new-task-modern-label">
                <span className="sidebar-home-btn-icon sidebar-more-dots" aria-hidden="true" style={{ display: "flex" }}>
                  <Shapes size={16} strokeWidth={2.1} style={{ display: "block" }} />
                </span>
                <span>More</span>
              </span>
            </span>
          </button>

          {isMoreExpanded && (
            <div className="sidebar-more-items">
              <button
                type="button"
                className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isMissionControlActive ? "active" : ""}`}
                onClick={onOpenMissionControl}
                aria-pressed={isMissionControlActive}
                title="Mission Control"
              >
                <span className="cli-btn-text">
                  <span className="terminal-only">mission_control</span>
                  <span className="modern-only cli-new-task-modern-label">
                    <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: "flex" }}>
                      <Users size={16} strokeWidth={2} style={{ display: "block" }} />
                    </span>
                    <span>Mission Control</span>
                  </span>
                </span>
              </button>

              <button
                type="button"
                className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isHealthActive ? "active" : ""}`}
                onClick={onOpenHealth}
                aria-pressed={isHealthActive}
                title="Health"
              >
                <span className="cli-btn-text">
                  <span className="terminal-only">health</span>
                  <span className="modern-only cli-new-task-modern-label">
                    <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: 'flex' }}>
                      <HeartPulse size={16} strokeWidth={2} style={{ display: 'block' }} />
                    </span>
                    <span>Health</span>
                  </span>
                </span>
              </button>

              <button
                type="button"
                className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-ideas-btn sidebar-nav-item ${isIdeasActive ? "active" : ""}`}
                onClick={onOpenIdeas}
                aria-pressed={isIdeasActive}
                title="Ideas"
              >
                <span className="cli-btn-text">
                  <span className="terminal-only">ideas</span>
                  <span className="modern-only cli-new-task-modern-label">
                    <span className="sidebar-home-btn-icon" aria-hidden="true" style={{ display: 'flex' }}>
                      <Lightbulb size={16} strokeWidth={2} style={{ display: 'block' }} />
                    </span>
                    <span>Ideas</span>
                  </span>
                </span>
              </button>
            </div>
          )}

        </div>
      </div>

      {isDevicesActive ? (
        <div className="devices-sidebar-panel">
          <div className="devices-sidebar-header">
            <div className="devices-sidebar-home">
              <button type="button" className="devices-sidebar-home-btn active" onClick={() => navigateDevicesSection("overview")}>
                <span className="devices-sidebar-home-icon">
                  <Server size={14} />
                </span>
                <span>Fleet Home</span>
                <span className="devices-sidebar-home-count">{remoteDeviceIds.size}</span>
              </button>
            </div>
            <div className="devices-sidebar-grid">
              <button type="button" className="devices-sidebar-link" onClick={() => triggerDevicesAction("pairing")}>
                <Server size={14} />
                <span>Pair remote</span>
                <strong>+</strong>
              </button>
              <button type="button" className="devices-sidebar-link" onClick={() => navigateDevicesSection("alerts")}>
                <Bell size={14} />
                <span>Attention queue</span>
                <strong>{remoteAttentionCount}</strong>
              </button>
              <button type="button" className="devices-sidebar-link" onClick={() => navigateDevicesSection("apps")}>
                <AppWindow size={14} />
                <span>Setup inbox</span>
              </button>
              <button type="button" className="devices-sidebar-link" onClick={() => navigateDevicesSection("storage")}>
                <HardDrive size={14} />
                <span>Isolation check</span>
              </button>
            </div>
          </div>

          <div className="devices-sidebar-subhead">
            <span>Observer</span>
            <button type="button" className="devices-sidebar-sort" onClick={() => navigateDevicesSection("alerts")}>
              Attention {remoteAttentionCount > 0 ? `(${remoteAttentionCount})` : ""}
            </button>
          </div>

          <div className="devices-sidebar-list">
            <button type="button" className="devices-sidebar-item featured" onClick={() => navigateDevicesSection("tasks")}>
              <div className="devices-sidebar-item-top">
                <Rows3 size={14} />
                <span className="devices-sidebar-item-label">Execution lane</span>
                <span className="devices-sidebar-item-dot" />
              </div>
              <strong>{remoteTasks.length > 0 ? `${remoteTasks.length} remote runs in view` : "No remote runs yet"}</strong>
              <span>Use this page to launch and supervise work happening on paired remotes.</span>
            </button>
            <button type="button" className="devices-sidebar-item" onClick={() => triggerDevicesAction("pairing")}>
              <div className="devices-sidebar-item-top">
                <Server size={14} />
                <span>Fleet shape</span>
              </div>
              <strong>{remoteDeviceIds.size > 0 ? `${remoteDeviceIds.size} remotes paired or active` : "Start with your first remote"}</strong>
              <span>Separate work, personal, archive, or automation machines without mixing disks.</span>
            </button>
            <button type="button" className="devices-sidebar-item" onClick={() => navigateDevicesSection("alerts")}>
              <div className="devices-sidebar-item-top">
                <Bell size={14} />
                <span>Observer feed</span>
              </div>
              <strong>{remoteAttentionCount > 0 ? `${remoteAttentionCount} issues waiting` : "Observer is quiet"}</strong>
              <span>Approvals, failed app connections, and offline remotes surface here.</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Sessions List Header */}
          <div className="sidebar-header-sessions">
                <div className="new-task-btn cli-new-task-btn cli-action-btn cli-sessions-header">
                  <button
                    type="button"
                    className="cli-list-header-toggle"
                    onClick={() => setSessionsCollapsed((value) => !value)}
                    aria-expanded={!sessionsCollapsed}
                    title={sessionsCollapsed ? "Expand sessions" : "Collapse sessions"}
                  >
                    <span className="cli-section-prompt terminal-only">{sessionsCollapsed ? "▸" : "▾"}</span>
                    <span className="terminal-only">SESSIONS</span>
                    <span className="modern-only cli-new-task-modern-label">
                      <span className="sidebar-home-btn-icon cli-sessions-icon" aria-hidden="true">
                        <SlidersHorizontal size={16} strokeWidth={2} style={{ display: 'block' }} />
                      </span>
                      <span className="cli-sessions-title">Sessions</span>
                      <span className="cli-sessions-collapse-indicator" aria-hidden="true">
                        {sessionsCollapsed ? (
                          <ChevronRight size={14} strokeWidth={2.5} />
                        ) : (
                          <ChevronDown size={14} strokeWidth={2.5} />
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="cli-list-header-actions">
                    <button
                      type="button"
                      className={`sidebar-session-action ${showSessionSearch ? "active" : ""}`}
                      onClick={() => {
                        setSessionsCollapsed(false);
                        setShowSessionSearch((value) => {
                          if (value) setSessionSearch("");
                          return !value;
                        });
                      }}
                      aria-pressed={showSessionSearch}
                      title={showSessionSearch ? "Hide search" : "Search sessions"}
                    >
                      <Search size={16} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      className={`sidebar-session-action ${showSessionFilters ? "active" : ""}`}
                      onClick={() => {
                        setSessionsCollapsed(false);
                        setShowSessionFilters((value) => !value);
                      }}
                      aria-pressed={showSessionFilters}
                      title={showSessionFilters ? "Hide filters" : "Filter sessions"}
                    >
                      <ListFilter size={16} strokeWidth={2} />
                    </button>
                  </div>
                </div>

                {(pinActionError || archiveActionError) && (
                  <div className="cli-sidebar-error" role="alert" style={{ marginTop: '4px', marginLeft: '4px', marginRight: '4px' }}>
                    {pinActionError || archiveActionError}
                  </div>
                )}

                {!sessionsCollapsed && showSessionFilters && (
                  <div className="sidebar-session-filter-panel">
                    <button
                      type="button"
                      className={`sidebar-session-filter-option ${showFailedSessions ? "active" : ""}`}
                      onClick={() => setShowFailedSessions((value) => !value)}
                      disabled={failedSessionCount === 0}
                    >
                      <span>Failed</span>
                      {failedSessionCount > 0 && <span>{failedSessionCount}</span>}
                    </button>
                    <button
                      type="button"
                      className={`sidebar-session-filter-option ${showAutomatedSessions ? "active" : ""}`}
                      onClick={() => {
                        setShowAutomatedSessions((value) => !value);
                        setAutomatedFolderCollapsed(false);
                      }}
                    >
                      <span>Automated</span>
                      {automatedTaskTree.length > 0 && <span>{automatedTaskTree.length}</span>}
                    </button>
                  </div>
                )}

                {!sessionsCollapsed && showSessionSearch && (
                  <label className="sidebar-sessions-search">
                    <Search size={14} />
                    <input
                      type="search"
                      aria-label="Search sessions"
                      placeholder="Search"
                      value={sessionSearch}
                      onChange={(event) => setSessionSearch(event.target.value)}
                    />
                  </label>
                )}

                {showFilterBar && (
                  <div className="session-filters-bar cli-session-filters">
                    <div className="session-filters-scroll">
                      <button
                        type="button"
                        className={`session-filter-chip standard ${activeModeFilters.size === 0 ? "active" : ""}`}
                        onClick={() => setActiveModeFilters(new Set())}
                      >
                        All
                      </button>
                      {availableModes.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={`session-filter-chip ${mode} ${activeModeFilters.has(mode) ? "active" : ""}`}
                          onClick={() => toggleModeFilter(mode)}
                        >
                          <span className="filter-chip-dot" />
                          {mode}
                        </button>
                      ))}
                    </div>
                    {activeModeFilters.size > 0 && (
                      <button
                        type="button"
                        className="session-filter-clear"
                        onClick={() => setActiveModeFilters(new Set())}
                        title="Clear filters"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>

          {/* Sessions Scrollable List */}
          <div
            className={`task-list cli-task-list ${useVirtualizedTaskRows ? "task-list-virtualized" : ""}`}
            ref={taskListRef}
          >
            {!sessionsCollapsed && (
              <>
            {filteredTaskTree.length === 0 && visibleAutomatedTaskTree.length === 0 ? (
              isLoadingSessions && !hasSessionSearch && activeModeFilters.size === 0 ? (
                <div className="sidebar-session-skeleton" aria-label="Loading sessions">
                  <span className="sidebar-session-skeleton-line" />
                  <span className="sidebar-session-skeleton-line" />
                  <span className="sidebar-session-skeleton-line" />
                </div>
              ) : hasSessionSearch ? (
                <div
                  className={`sidebar-empty cli-empty ${uiDensity === "focused" ? "sidebar-empty-focused" : ""}`}
                >
                  <div className="sidebar-empty-message sidebar-search-empty-message">
                    <Search size={32} style={{ opacity: 0.3 }} />
                    <p>No matching sessions</p>
                    <span>Try a different title, prompt, or session id</span>
                  </div>
                </div>
              ) : activeModeFilters.size > 0 ? null : (
                <div
                  className={`sidebar-empty cli-empty ${uiDensity === "focused" ? "sidebar-empty-focused" : ""}`}
                >
                  <pre className="cli-tree terminal-only">{`├── (no sessions yet)
└── ...`}</pre>
                  {uiDensity === "focused" ? (
                    <div className="sidebar-empty-message">
                      <EyeOff size={32} style={{ opacity: 0.3 }} />
                      <p>Your conversations will appear here</p>
                      <span>Start a new session to get going</span>
                    </div>
                  ) : (
                    <p className="cli-hint">
                      <span className="terminal-only"># start a new session above</span>
                      <span className="modern-only">Start a new session to begin</span>
                    </p>
                  )}
                </div>
              )
            ) : useVirtualizedTaskRows ? (
              <VirtualList
                items={sidebarVirtualRows}
                getItemKey={(row) => {
                  if (row.kind === "task") return `${row.section ?? "user"}:${row.row.node.task.id}`;
                  return row.id;
                }}
                getItemHeight={(row) =>
                  row.kind === "date-header"
                    ? uiDensity === "focused"
                      ? SIDEBAR_FOCUSED_DATE_HEADER_HEIGHT
                      : SIDEBAR_DATE_HEADER_HEIGHT
                    : row.kind === "automated-header"
                      ? SIDEBAR_AUTOMATED_HEADER_HEIGHT
                      : row.kind === "load-more"
                        ? SIDEBAR_LOAD_MORE_HEIGHT
                        : uiDensity === "focused"
                          ? SIDEBAR_FOCUSED_ITEM_HEIGHT
                          : SIDEBAR_ITEM_HEIGHT
                }
                renderItem={(row) => renderSidebarVirtualRow(row)}
                estimatedItemHeight={
                  uiDensity === "focused" ? SIDEBAR_FOCUSED_ITEM_HEIGHT : SIDEBAR_ITEM_HEIGHT
                }
                overscan={10}
                enabled
                className="sidebar-virtual-list"
                style={{ height: "100%" }}
                role="list"
                onScrollNearEnd={onLoadMoreTasks}
              />
            ) : (
              sidebarVirtualRows.map((row) => (
                <div
                  key={
                    row.kind === "task" ? `${row.section ?? "user"}:${row.row.node.task.id}` : row.id
                  }
                >
                  {renderSidebarVirtualRow(row)}
                </div>
              ))
            )}

              </>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      <div className="sidebar-footer cli-sidebar-footer">
        <InfraWalletBadge onOpenSettings={onOpenSettings} />
        <div className="cli-footer-actions">
          <button
            className="settings-btn cli-settings-btn"
            onClick={onOpenSettings}
            title="Settings"
          >
            <span className="terminal-only">[cfg]</span>
            <span className="modern-only">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function InfraWalletBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [balance, setBalance] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const ipcAPI = window.electronAPI;
    if (!ipcAPI?.infraGetStatus || !ipcAPI?.infraGetSettings) return;

    const load = async () => {
      try {
        const [status, settings] = await Promise.all([
          ipcAPI.infraGetStatus(),
          ipcAPI.infraGetSettings(),
        ]);
        if (settings?.showWalletInSidebar && status?.enabled && status?.wallet?.balanceUsdc) {
          setBalance(status.wallet.balanceUsdc);
          setVisible(true);
        } else {
          setVisible(false);
        }
      } catch {
        setVisible(false);
      }
    };

    load();

    const unsubscribe = ipcAPI.onInfraStatusChange?.((status: InfraStatus) => {
      if (status?.enabled && status?.wallet?.balanceUsdc) {
        setBalance(status.wallet.balanceUsdc);
        setVisible(true);
      }
    });
    return () => unsubscribe?.();
  }, []);

  if (!visible || !balance) return null;

  return (
    <button
      type="button"
      className="infra-wallet-badge"
      onClick={onOpenSettings}
      title="Infrastructure — click to open settings"
      aria-label="Open Infrastructure settings"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="infra-wallet-balance">{balance} USDC</span>
    </button>
  );
}

export const Sidebar = memo(SidebarComponent, areSidebarPropsEqual);
