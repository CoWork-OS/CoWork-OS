import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useDeferredValue,
  memo,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  EyeOff,
  AppWindow,
  Bell,
  Archive,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrive,
  ListTree,
  Pencil,
  Pin,
  PinOff,
  Rows3,
  Search,
  Server,
  Workflow,
  HeartPulse,
  Lightbulb,
  Inbox,
  Users,
  UsersRound,
  ListFilter,
  EllipsisVertical,
  Shapes,
  Plus,
  Sparkles,
  Repeat2,
  X,
} from "lucide-react";
import { resolveTwinIcon } from "../utils/twin-icons";
import { stripAllEmojis } from "../utils/emoji-replacer";
import {
  Task,
  Workspace,
  UiDensity,
  InfraStatus,
  UpdateInfo,
  isTempWorkspaceId,
} from "../../shared/types";
import type { MailboxDigestSnapshot, MailboxSyncStatus } from "../../shared/mailbox";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { VirtualList } from "./VirtualList";
import { capitalizeSidebarSessionTitle } from "../utils/sidebar-title";
import { deriveSlashCommandTaskTitle } from "../utils/slash-command-title";
import { BotsPane, type BotRole } from "./BotsPane";
import { BOT_PROFILE_DELETED_EVENT, BOT_PROFILE_UPDATED_EVENT } from "./BotProfileDialog";
import type { BotConversationRosterProjection } from "../../shared/bot-lifecycle";

const SIDEBAR_ITEM_HEIGHT = 22;
const SIDEBAR_DATE_HEADER_HEIGHT = 20;
const SIDEBAR_FOCUSED_ITEM_HEIGHT = 28;
const SIDEBAR_FOCUSED_DATE_HEADER_HEIGHT = 26;
const SIDEBAR_AUTOMATED_HEADER_HEIGHT = 30;
const SIDEBAR_SECTION_HEADER_HEIGHT = 30;
const SIDEBAR_WORKSPACE_HEADER_HEIGHT = 30;
const SIDEBAR_WORKSPACE_SESSION_ACTION_HEIGHT = 28;
const SIDEBAR_WORKSPACE_SESSION_PREVIEW_COUNT = 6;
const SIDEBAR_LOAD_MORE_HEIGHT = 32;
const SIDEBAR_VIRTUALIZATION_MIN_ROWS = 30;
const SIDEBAR_LOAD_MORE_THRESHOLD_PX = 320;

type AgentRoleInfo = BotRole;

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

function getBotProjectionSignature(
  projections?: Readonly<Record<string, BotConversationRosterProjection>>,
): string {
  return Object.entries(projections || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roleId, projection]) => `${roleId}:${projection.state}:${projection.activityLabel}`)
    .join("|");
}

interface SidebarProps {
  workspace: Workspace | null;
  tasks: Task[];
  botTasks?: Task[];
  selectedTaskId: string | null;
  selectedBotConversationProjection?: BotConversationRosterProjection | null;
  botConversationProjections?: Readonly<Record<string, BotConversationRosterProjection>>;
  isBotViewActive?: boolean;
  isAutomationsActive?: boolean;
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
  onOpenAutomations?: () => void;
  onOpenIdeas?: () => void;
  onOpenInboxAgent?: () => void;
  onOpenAgents?: () => void;
  onOpenBot?: (bot: BotRole) => void | Promise<void>;
  onReopenBot?: (task: Task) => void | Promise<void>;
  onBotUpdated?: (bot: BotRole) => void | Promise<void>;
  onBotDeleted?: (botId: string) => void | Promise<void>;
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
  if (task.agentConfig?.videoGenerationMode || task.agentConfig?.taskDomain === "media")
    return "video";
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
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      stroke="currentColor"
      style={{ display: "block" }}
    >
      <path
        d="M 4 6.5 L 20 6.5 Q 21.8 6.5 21.8 8.3 L 21.8 14.1 Q 21.8 15.9 20 15.9 L 4 15.9 Q 2.2 15.9 2.2 14.1 L 2.2 8.3 Q 2.2 6.5 4 6.5 Z"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  if (task.agentConfig?.botConversation === true) return false;
  return !task.targetNodeId;
}

export function isUserCreatedBotRole(
  role: Pick<BotRole, "isActive" | "isSystem" | "roleKind" | "sourceTemplateId">,
): boolean {
  return (
    role.isActive !== false &&
    role.isSystem !== true &&
    role.roleKind !== "system" &&
    role.roleKind !== "persona_template" &&
    !role.sourceTemplateId
  );
}

export function compareTasksByPinAndRecency(a: Task, b: Task): number {
  const pinnedDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDiff !== 0) return pinnedDiff;
  const recencyDiff = (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
  if (recencyDiff !== 0) return recencyDiff;
  return b.createdAt - a.createdAt;
}

export function getSidebarDateGroup(
  task: Pick<Task, "createdAt" | "pinned">,
  now = new Date(),
): string {
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

function stripSidebarTitleEllipsis(value: string): string {
  return value.replace(/(?:\s*(?:\.{3}|…))+\s*$/, "").trim();
}

function normalizeSidebarTitleCandidate(value?: string | null): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const userRequestMatch = trimmed.match(/(?:^|\n)User request:\s*([\s\S]+)/i);
  const candidate = stripSidebarTitleEllipsis(
    (userRequestMatch?.[1] || trimmed).replace(/\s+/g, " ").trim(),
  );
  return stripSidebarTitleEllipsis(deriveSlashCommandTaskTitle(candidate) || candidate);
}

function isGenericSidebarTitle(value: string): boolean {
  return GENERIC_SESSION_TITLES.has(normalizeSidebarSessionSearch(value));
}

export function getSidebarSessionTitle(node: Pick<TaskTreeNode, "displayTitle" | "task">): string {
  const primaryCandidates = [node.displayTitle, node.task.title];
  for (const candidate of primaryCandidates) {
    const normalized = normalizeSidebarTitleCandidate(candidate);
    if (normalized && !isGenericSidebarTitle(normalized))
      return capitalizeSidebarSessionTitle(normalized);
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

  let low = 0;
  let high = normalized.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = normalized.slice(0, mid).trimEnd();
    if (measureText(prefix) <= maxWidth) {
      best = prefix;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
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
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const [displayText, setDisplayText] = useState(normalizedText);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") {
      setDisplayText(normalizedText);
      setIsTruncated(false);
      return;
    }

    const update = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width <= 0) return;

      const context = getSidebarTitleMeasureContext();
      if (!context) {
        setDisplayText(normalizedText);
        setIsTruncated(false);
        return;
      }

      context.font = getElementFont(element);
      const next = truncateSidebarTitleToFit(
        text,
        width,
        (candidate) => context.measureText(candidate).width,
      );
      setDisplayText((current) => (current === next ? current : next));
      setIsTruncated(next !== normalizedText);
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
    <span
      ref={ref}
      className={`${className}${isTruncated ? " cli-task-title--faded" : ""}`}
      title={title}
    >
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
      kind: "section-header";
      id: string;
      label: string;
      action?: "add-workspace";
    }
  | {
      kind: "workspace-empty";
      id: string;
    }
  | {
      kind: "workspace-session-action";
      id: string;
      workspaceId: string;
      expanded: boolean;
      remainingCount: number;
    }
  | {
      kind: "workspace-header";
      id: string;
      workspaceId: string;
      label: string;
      path?: string;
      pinned: boolean;
      recent: boolean;
      current: boolean;
      expanded: boolean;
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
      grouped?: boolean;
    }
  | {
      kind: "load-more";
      id: string;
      loading: boolean;
    };

export function getSidebarProjectSessionPreview<T>(
  items: readonly T[],
  showAll: boolean,
): { visibleItems: T[]; hasMore: boolean; remainingCount: number } {
  const visibleItems = showAll
    ? [...items]
    : items.slice(0, SIDEBAR_WORKSPACE_SESSION_PREVIEW_COUNT);
  const remainingCount = Math.max(0, items.length - visibleItems.length);
  return {
    visibleItems,
    hasMore: remainingCount > 0,
    remainingCount,
  };
}

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
    parts.push(
      `${t.id}:${t.status}:${t.updatedAt ?? 0}:${t.assignedAgentRoleId ?? ""}:${t.agentConfig?.botConversation ? "bot" : ""}`,
    );
  }
  return `${tasks.length}|${parts.join(",")}`;
}

export interface SidebarWorkspaceSettings {
  visibleWorkspaceIds: string[];
  pinnedWorkspaceIds: string[];
  expandedWorkspaceIds: string[];
  collapsedWorkspaceIds: string[];
  labels: Record<string, string>;
}

const SIDEBAR_WORKSPACE_SETTINGS_KEY = "cowork.sidebar.workspace-settings.v1";

const EMPTY_SIDEBAR_WORKSPACE_SETTINGS: SidebarWorkspaceSettings = {
  visibleWorkspaceIds: [],
  pinnedWorkspaceIds: [],
  expandedWorkspaceIds: [],
  collapsedWorkspaceIds: [],
  labels: {},
};

function readSidebarWorkspaceSettings(): SidebarWorkspaceSettings {
  if (typeof window === "undefined" || !window.localStorage) {
    return EMPTY_SIDEBAR_WORKSPACE_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SIDEBAR_WORKSPACE_SETTINGS_KEY);
    if (!raw) return EMPTY_SIDEBAR_WORKSPACE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SidebarWorkspaceSettings>;
    const pinnedWorkspaceIds = Array.isArray(parsed.pinnedWorkspaceIds)
      ? parsed.pinnedWorkspaceIds.filter((value): value is string => typeof value === "string")
      : [];
    return {
      // Older versions only persisted hidden projects, so there was no safe
      // way to know which projects the user explicitly wanted in the sidebar.
      // Start those users with an empty project section and preserve any
      // projects they had explicitly pinned.
      visibleWorkspaceIds: Array.isArray(parsed.visibleWorkspaceIds)
        ? parsed.visibleWorkspaceIds.filter((value): value is string => typeof value === "string")
        : pinnedWorkspaceIds,
      pinnedWorkspaceIds,
      expandedWorkspaceIds: Array.isArray(parsed.expandedWorkspaceIds)
        ? parsed.expandedWorkspaceIds.filter((value): value is string => typeof value === "string")
        : [],
      collapsedWorkspaceIds: Array.isArray(parsed.collapsedWorkspaceIds)
        ? parsed.collapsedWorkspaceIds.filter((value): value is string => typeof value === "string")
        : [],
      labels:
        parsed.labels && typeof parsed.labels === "object"
          ? Object.fromEntries(
              Object.entries(parsed.labels).filter(
                ([key, value]) => typeof key === "string" && typeof value === "string",
              ),
            )
          : {},
    };
  } catch {
    return EMPTY_SIDEBAR_WORKSPACE_SETTINGS;
  }
}

export function getSidebarWorkspaceSelection(
  settings: Pick<SidebarWorkspaceSettings, "visibleWorkspaceIds" | "pinnedWorkspaceIds">,
): Set<string> {
  return new Set([...settings.visibleWorkspaceIds, ...settings.pinnedWorkspaceIds]);
}

function writeSidebarWorkspaceSettings(settings: SidebarWorkspaceSettings): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(SIDEBAR_WORKSPACE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Sidebar organization is a convenience preference. Keep the in-memory
    // state working if storage is unavailable or has been disabled.
  }
}

interface SidebarWorkspaceGroup {
  workspace?: Workspace;
  workspaceId: string;
  label: string;
  path?: string;
  nodes: TaskTreeNode[];
  pinned: boolean;
  recent: boolean;
  current: boolean;
}

/**
 * Workspaces created for short-lived sessions can be persisted in the
 * database without carrying the temp-workspace flag. Keep those folders out
 * of the durable Projects section as well.
 */
export function isSidebarRecentWorkspace(workspace: Workspace): boolean {
  if (workspace.isTemp || isTempWorkspaceId(workspace.id)) return true;

  const normalizedPath = workspace.path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /(?:^|\/)tmp(?:\/|$)|(?:^|\/)temp(?:\/|$)|(?:^|\/)temporary(?:\/|$)|(?:^|\/)cowork-os-temp(?:\/|$)/i.test(
    normalizedPath,
  );
}

const sidebarWorkspaceCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareSidebarWorkspaceGroups(
  left: SidebarWorkspaceGroup,
  right: SidebarWorkspaceGroup,
): number {
  if (left.current !== right.current) return left.current ? -1 : 1;

  const labelComparison = sidebarWorkspaceCollator.compare(left.label, right.label);
  if (labelComparison !== 0) return labelComparison;

  const pathComparison = sidebarWorkspaceCollator.compare(left.path || "", right.path || "");
  if (pathComparison !== 0) return pathComparison;

  return sidebarWorkspaceCollator.compare(left.workspaceId, right.workspaceId);
}

function areSidebarPropsEqual(prev: SidebarProps, next: SidebarProps): boolean {
  return (
    prev.workspace?.id === next.workspace?.id &&
    prev.selectedTaskId === next.selectedTaskId &&
    prev.selectedBotConversationProjection?.state ===
      next.selectedBotConversationProjection?.state &&
    prev.selectedBotConversationProjection?.activityLabel ===
      next.selectedBotConversationProjection?.activityLabel &&
    getBotProjectionSignature(prev.botConversationProjections) ===
      getBotProjectionSignature(next.botConversationProjections) &&
    prev.isBotViewActive === next.isBotViewActive &&
    prev.isAutomationsActive === next.isAutomationsActive &&
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
    getSidebarTaskListSignature(prev.botTasks || []) ===
      getSidebarTaskListSignature(next.botTasks || []) &&
    (prev.completionAttentionTaskIds || []).join(",") ===
      (next.completionAttentionTaskIds || []).join(",") &&
    prev.updateInfo?.latestVersion === next.updateInfo?.latestVersion &&
    prev.onSelectTask === next.onSelectTask &&
    prev.onOpenBot === next.onOpenBot &&
    prev.onReopenBot === next.onReopenBot &&
    prev.onBotUpdated === next.onBotUpdated &&
    prev.onBotDeleted === next.onBotDeleted &&
    prev.onTasksChanged === next.onTasksChanged &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.onOpenMissionControl === next.onOpenMissionControl
  );
}

function SidebarComponent({
  workspace,
  tasks,
  botTasks: botTasksOverride,
  selectedTaskId,
  selectedBotConversationProjection,
  botConversationProjections,
  isBotViewActive = false,
  isAutomationsActive = false,
  isIdeasActive = false,
  isInboxAgentActive = false,
  isAgentsActive = false,
  isEverydayAgentActive = false,
  isMissionControlActive = false,
  isHealthActive = false,
  isLoadingSessions = false,
  completionAttentionTaskIds = [],
  onSelectTask,
  onOpenAutomations,
  onOpenIdeas,
  onOpenInboxAgent,
  onOpenAgents,
  onOpenBot,
  onReopenBot,
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
  onBotUpdated,
  onBotDeleted,
}: SidebarProps) {
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [menuOpenTaskId, setMenuOpenTaskId] = useState<string | null>(null);
  const [renameTaskId, setRenameTaskId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const [agentRoles, setAgentRoles] = useState<Map<string, AgentRoleInfo>>(new Map());
  const [sidebarTab, setSidebarTab] = useState<"sessions" | "bots">("sessions");
  const [isLoadingBots, setIsLoadingBots] = useState(false);
  const [botsError, setBotsError] = useState<string | null>(null);
  // Keep the full session history visible by default. Users can still hide
  // failed/cancelled roots from the optional session filter panel.
  const [showFailedSessions, setShowFailedSessions] = useState(true);
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
  const [sidebarWorkspaces, setSidebarWorkspaces] = useState<Workspace[]>([]);
  const [workspaceNavSettings, setWorkspaceNavSettings] = useState<SidebarWorkspaceSettings>(() =>
    readSidebarWorkspaceSettings(),
  );
  const [workspaceMenuOpenId, setWorkspaceMenuOpenId] = useState<string | null>(null);
  const [workspaceSessionListsExpanded, setWorkspaceSessionListsExpanded] = useState<Set<string>>(
    new Set(),
  );
  const [workspaceSectionMenuOpen, setWorkspaceSectionMenuOpen] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  // Automated sessions folder is collapsed by default to keep the sidebar clean
  const [automatedFolderCollapsed, setAutomatedFolderCollapsed] = useState(true);
  const [mailboxDigest, setMailboxDigest] = useState<MailboxDigestSnapshot | null>(null);
  const [mailboxStatus, setMailboxStatus] = useState<MailboxSyncStatus | null>(null);
  const pinActionErrorTimeoutRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const workspaceSectionMenuRef = useRef<HTMLDivElement>(null);
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

  const loadSidebarWorkspaces = useCallback(async () => {
    if (!window.electronAPI?.listWorkspaces) return;
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      setSidebarWorkspaces(Array.isArray(loaded) ? loaded : []);
    } catch (error) {
      console.error("Failed to load sidebar workspaces:", error);
    }
  }, []);

  useEffect(() => {
    void loadSidebarWorkspaces();
  }, [loadSidebarWorkspaces, workspace?.id]);

  const updateWorkspaceNavSettings = useCallback(
    (update: (current: SidebarWorkspaceSettings) => SidebarWorkspaceSettings) => {
      setWorkspaceNavSettings((current) => {
        const next = update(current);
        writeSidebarWorkspaceSettings(next);
        return next;
      });
    },
    [],
  );

  const knownSidebarWorkspaces = useMemo(() => {
    const byId = new Map(sidebarWorkspaces.map((candidate) => [candidate.id, candidate]));
    if (workspace && !workspace.isTemp && !isTempWorkspaceId(workspace.id)) {
      byId.set(workspace.id, workspace);
    }
    return Array.from(byId.values()).filter(
      (candidate) => !candidate.isTemp && !isTempWorkspaceId(candidate.id),
    );
  }, [sidebarWorkspaces, workspace]);

  const workspaceById = useMemo(
    () => new Map(knownSidebarWorkspaces.map((candidate) => [candidate.id, candidate])),
    [knownSidebarWorkspaces],
  );

  const sidebarWorkspaceIds = useMemo(
    () => getSidebarWorkspaceSelection(workspaceNavSettings),
    [workspaceNavSettings],
  );

  const isWorkspaceExpanded = useCallback(
    (workspaceId: string) => {
      if (workspaceNavSettings.expandedWorkspaceIds.includes(workspaceId)) return true;
      if (workspaceNavSettings.collapsedWorkspaceIds.includes(workspaceId)) return false;
      return workspace?.id === workspaceId;
    },
    [
      workspace?.id,
      workspaceNavSettings.collapsedWorkspaceIds,
      workspaceNavSettings.expandedWorkspaceIds,
    ],
  );

  const getWorkspaceLabel = useCallback(
    (candidate: Workspace) => workspaceNavSettings.labels[candidate.id]?.trim() || candidate.name,
    [workspaceNavSettings.labels],
  );

  const handleAddWorkspace = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.selectFolder || !api?.listWorkspaces || !api?.createWorkspace) return;

    try {
      const folderPath = await api.selectFolder();
      if (!folderPath) return;

      const existingWorkspaces = await api.listWorkspaces();
      let addedWorkspace = existingWorkspaces.find((candidate) => candidate.path === folderPath);
      if (!addedWorkspace) {
        const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
        addedWorkspace = await api.createWorkspace({
          name: folderName,
          path: folderPath,
          permissions: {
            read: true,
            write: true,
            delete: true,
            network: true,
            shell: false,
          },
        });
      }

      setSidebarWorkspaces((current) => {
        const next = current.filter((candidate) => candidate.id !== addedWorkspace!.id);
        return [addedWorkspace!, ...next];
      });
      updateWorkspaceNavSettings((current) => ({
        ...current,
        visibleWorkspaceIds: Array.from(
          new Set([...current.visibleWorkspaceIds, addedWorkspace!.id]),
        ),
        collapsedWorkspaceIds: current.collapsedWorkspaceIds.filter(
          (workspaceId) => workspaceId !== addedWorkspace!.id,
        ),
        expandedWorkspaceIds: Array.from(
          new Set([...current.expandedWorkspaceIds, addedWorkspace!.id]),
        ),
      }));
      setWorkspaceActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add that folder.";
      console.error("Failed to add sidebar workspace:", error);
      setWorkspaceActionError(message);
    }
  }, [updateWorkspaceNavSettings]);

  const handleAddAllWorkspaces = useCallback(() => {
    const workspaceIds = knownSidebarWorkspaces
      .filter((candidate) => !isSidebarRecentWorkspace(candidate))
      .map((candidate) => candidate.id);
    updateWorkspaceNavSettings((current) => ({
      ...current,
      visibleWorkspaceIds: Array.from(new Set([...current.visibleWorkspaceIds, ...workspaceIds])),
    }));
    setWorkspaceSectionMenuOpen(false);
    setWorkspaceActionError(null);
  }, [knownSidebarWorkspaces, updateWorkspaceNavSettings]);

  const handleRemoveAllWorkspaces = useCallback(() => {
    updateWorkspaceNavSettings((current) => ({
      ...current,
      visibleWorkspaceIds: [],
      pinnedWorkspaceIds: [],
      expandedWorkspaceIds: [],
      collapsedWorkspaceIds: [],
    }));
    setWorkspaceSessionListsExpanded(new Set());
    setWorkspaceSectionMenuOpen(false);
    setWorkspaceMenuOpenId(null);
    setWorkspaceActionError(null);
  }, [updateWorkspaceNavSettings]);

  const handleToggleWorkspacePin = useCallback(
    (workspaceId: string) => {
      updateWorkspaceNavSettings((current) => {
        const pinned = new Set(current.pinnedWorkspaceIds);
        if (pinned.has(workspaceId)) {
          pinned.delete(workspaceId);
        } else {
          pinned.add(workspaceId);
        }
        return { ...current, pinnedWorkspaceIds: Array.from(pinned) };
      });
      setWorkspaceMenuOpenId(null);
    },
    [updateWorkspaceNavSettings],
  );

  const handleToggleWorkspaceExpanded = useCallback(
    (workspaceId: string) => {
      const currentlyExpanded = isWorkspaceExpanded(workspaceId);
      updateWorkspaceNavSettings((current) => {
        const expanded = new Set(current.expandedWorkspaceIds);
        const collapsed = new Set(current.collapsedWorkspaceIds);
        expanded.delete(workspaceId);
        collapsed.delete(workspaceId);
        (currentlyExpanded ? collapsed : expanded).add(workspaceId);
        return {
          ...current,
          expandedWorkspaceIds: Array.from(expanded),
          collapsedWorkspaceIds: Array.from(collapsed),
        };
      });
    },
    [isWorkspaceExpanded, updateWorkspaceNavSettings],
  );

  const handleToggleWorkspaceSessionList = useCallback((workspaceId: string) => {
    setWorkspaceSessionListsExpanded((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  const handleEditWorkspace = useCallback(
    (candidate: Workspace) => {
      const currentLabel = getWorkspaceLabel(candidate);
      const nextLabel = window.prompt("Rename project", currentLabel)?.trim();
      if (!nextLabel || nextLabel === currentLabel) {
        setWorkspaceMenuOpenId(null);
        return;
      }
      updateWorkspaceNavSettings((current) => ({
        ...current,
        labels: { ...current.labels, [candidate.id]: nextLabel },
      }));
      setWorkspaceMenuOpenId(null);
    },
    [getWorkspaceLabel, updateWorkspaceNavSettings],
  );

  const handleRevealWorkspace = useCallback(async (candidate: Workspace) => {
    setWorkspaceMenuOpenId(null);
    if (!window.electronAPI?.showInFinder) return;
    try {
      await window.electronAPI.showInFinder(".", candidate.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reveal that folder.";
      console.error("Failed to reveal sidebar workspace:", error);
      setWorkspaceActionError(message);
    }
  }, []);

  const handleArchiveWorkspace = useCallback(
    async (workspaceId: string) => {
      setWorkspaceMenuOpenId(null);
      setWorkspaceActionError(null);
      const taskIds = tasks
        .filter((task) => task.workspaceId === workspaceId && !task.parentTaskId)
        .map((task) => task.id);
      if (taskIds.length === 0 || !window.electronAPI?.archiveTask) return;

      const results = await Promise.allSettled(
        taskIds.map((taskId) => window.electronAPI.archiveTask(taskId)),
      );
      if (results.some((result) => result.status === "rejected")) {
        setWorkspaceActionError("Some project sessions could not be archived.");
      }
      if (tasks.some((task) => task.workspaceId === workspaceId && task.id === selectedTaskId)) {
        onSelectTask(null);
      }
      onTasksChanged();
    },
    [onSelectTask, onTasksChanged, selectedTaskId, tasks],
  );

  const handleRemoveWorkspace = useCallback(
    (workspaceId: string) => {
      updateWorkspaceNavSettings((current) => ({
        ...current,
        visibleWorkspaceIds: current.visibleWorkspaceIds.filter((id) => id !== workspaceId),
        pinnedWorkspaceIds: current.pinnedWorkspaceIds.filter((id) => id !== workspaceId),
        expandedWorkspaceIds: current.expandedWorkspaceIds.filter((id) => id !== workspaceId),
        collapsedWorkspaceIds: current.collapsedWorkspaceIds.filter((id) => id !== workspaceId),
      }));
      setWorkspaceSessionListsExpanded((current) => {
        if (!current.has(workspaceId)) return current;
        const next = new Set(current);
        next.delete(workspaceId);
        return next;
      });
      setWorkspaceMenuOpenId(null);
    },
    [updateWorkspaceNavSettings],
  );

  const loadAgentRoles = useCallback(async () => {
    if (!window.electronAPI?.getAgentRoles) return;
    setIsLoadingBots(true);
    setBotsError(null);
    try {
      const roles = (await window.electronAPI.getAgentRoles(false)) as Array<
        BotRole & { roleKind?: string }
      >;
      const map = new Map<string, AgentRoleInfo>();
      for (const role of roles || []) {
        map.set(role.id, {
          id: role.id,
          name: role.name,
          roleKind: role.roleKind,
          sourceTemplateId: role.sourceTemplateId,
          displayName: role.displayName,
          description: role.description,
          color: role.color || "#6366f1",
          icon: role.icon,
          isActive: role.isActive,
          isSystem: role.isSystem,
          sortOrder: role.sortOrder,
          updatedAt: role.updatedAt,
        });
      }
      setAgentRoles(map);
    } catch (error) {
      setBotsError(error instanceof Error ? error.message : "Could not load bots.");
    } finally {
      setIsLoadingBots(false);
    }
  }, []);

  // Keep role labels available for existing Sessions rows immediately on
  // startup, then refresh again when the Bots surface is opened.
  useEffect(() => {
    void loadAgentRoles();
  }, [loadAgentRoles]);

  useEffect(() => {
    const refreshRoles = () => void loadAgentRoles();
    window.addEventListener(BOT_PROFILE_UPDATED_EVENT, refreshRoles);
    window.addEventListener(BOT_PROFILE_DELETED_EVENT, refreshRoles);
    return () => {
      window.removeEventListener(BOT_PROFILE_UPDATED_EVENT, refreshRoles);
      window.removeEventListener(BOT_PROFILE_DELETED_EVENT, refreshRoles);
    };
  }, [loadAgentRoles]);

  useEffect(() => {
    if (sidebarTab !== "bots") return;
    void loadAgentRoles();
  }, [loadAgentRoles, sidebarTab]);

  const botRoles = useMemo(
    () => Array.from(agentRoles.values()).filter(isUserCreatedBotRole),
    [agentRoles],
  );
  const botTasks = useMemo(
    () =>
      botTasksOverride ??
      tasks.filter(
        (task) =>
          task.workspaceId === workspace?.id &&
          task.agentConfig?.botConversation === true &&
          task.source !== "side_chat",
      ),
    [botTasksOverride, tasks, workspace?.id],
  );
  const visibleSidebarTab = isBotViewActive ? "bots" : sidebarTab;

  const handleBotCreated = useCallback((bot: BotRole) => {
    if (bot.isSystem) return;
    setAgentRoles((current) => {
      const next = new Map(current);
      next.set(bot.id, {
        ...bot,
        color: bot.color || "#6366f1",
      });
      return next;
    });
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
    inboxUnreadCount > 0 ? `Inbox (${inboxUnreadCount > 99 ? "99+" : inboxUnreadCount})` : "Inbox";
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

  const pinnedTaskTree = useMemo(
    () =>
      [...filteredTaskTree, ...filteredAutomatedTaskTree]
        .filter((node) => node.task.pinned)
        .sort(compareTaskTreeNodes),
    [filteredAutomatedTaskTree, filteredTaskTree],
  );
  const unpinnedTaskTree = useMemo(
    () => filteredTaskTree.filter((node) => !node.task.pinned),
    [filteredTaskTree],
  );
  const unpinnedAutomatedTaskTree = useMemo(
    () => visibleAutomatedTaskTree.filter((node) => !node.task.pinned),
    [visibleAutomatedTaskTree],
  );

  const workspaceGroups = useMemo(() => {
    const nodesByWorkspaceId = new Map<string, TaskTreeNode[]>();
    const recentNodes: TaskTreeNode[] = [];

    for (const node of unpinnedTaskTree) {
      const workspaceId = node.task.workspaceId;
      const knownWorkspace = workspaceById.get(workspaceId);
      if (
        !knownWorkspace ||
        isSidebarRecentWorkspace(knownWorkspace) ||
        !sidebarWorkspaceIds.has(workspaceId)
      ) {
        recentNodes.push(node);
        continue;
      }
      const nodes = nodesByWorkspaceId.get(workspaceId) || [];
      nodes.push(node);
      nodesByWorkspaceId.set(workspaceId, nodes);
    }

    const shouldHideEmptyGroups = hasSessionSearch || activeModeFilters.size > 0;
    const pinnedWorkspaceOrder = new Map(
      workspaceNavSettings.pinnedWorkspaceIds.map((workspaceId, index) => [workspaceId, index]),
    );
    const groups: SidebarWorkspaceGroup[] = knownSidebarWorkspaces
      .filter(
        (candidate) =>
          sidebarWorkspaceIds.has(candidate.id) && !isSidebarRecentWorkspace(candidate),
      )
      .map((candidate) => {
        const nodes = nodesByWorkspaceId.get(candidate.id) || [];
        return {
          workspace: candidate,
          workspaceId: candidate.id,
          label: getWorkspaceLabel(candidate),
          path: candidate.path,
          nodes,
          pinned: workspaceNavSettings.pinnedWorkspaceIds.includes(candidate.id),
          recent: false,
          current: candidate.id === workspace?.id,
        };
      })
      .filter((group) => !shouldHideEmptyGroups || group.nodes.length > 0)
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.pinned && right.pinned) {
          const leftOrder = pinnedWorkspaceOrder.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder = pinnedWorkspaceOrder.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER;
          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        }
        return compareSidebarWorkspaceGroups(left, right);
      });

    return {
      groups,
      recentNodes: recentNodes.sort((a, b) => compareTaskTreeNodes(a, b)),
    };
  }, [
    activeModeFilters.size,
    getWorkspaceLabel,
    hasSessionSearch,
    knownSidebarWorkspaces,
    sidebarWorkspaceIds,
    unpinnedTaskTree,
    workspace,
    workspaceById,
    workspaceNavSettings.pinnedWorkspaceIds,
  ]);

  const pinnedWorkspaceGroups = useMemo(
    () => workspaceGroups.groups.filter((group) => group.pinned),
    [workspaceGroups.groups],
  );
  const regularWorkspaceGroups = useMemo(
    () => workspaceGroups.groups.filter((group) => !group.pinned),
    [workspaceGroups.groups],
  );
  const automatedRowsExpanded = hasSessionSearch || !automatedFolderCollapsed;
  const sidebarVirtualRows = useMemo(() => {
    const rows: SidebarVirtualRow[] = [];

    const appendTaskRows = (
      nodes: TaskTreeNode[],
      section: "user" | "automated",
      grouped = false,
      maxRows?: number,
    ): number => {
      const taskRows = flattenVisibleTaskRows(nodes, effectiveCollapsedTasks);
      const visibleTaskRows =
        maxRows === undefined
          ? taskRows
          : getSidebarProjectSessionPreview(taskRows, false).visibleItems;
      rows.push(
        ...visibleTaskRows.map(
          (row): SidebarVirtualRow => ({ kind: "task", row, section, grouped }),
        ),
      );
      return taskRows.length;
    };

    const appendWorkspaceGroup = (group: SidebarWorkspaceGroup) => {
      const expanded = isWorkspaceExpanded(group.workspaceId);
      const showAllSessions = workspaceSessionListsExpanded.has(group.workspaceId);
      rows.push({
        kind: "workspace-header",
        id: `workspace:${group.workspaceId}`,
        workspaceId: group.workspaceId,
        label: group.label,
        path: group.path,
        pinned: group.pinned,
        recent: group.recent,
        current: group.current,
        expanded,
      });
      if (!expanded) return;

      const totalTaskRows = appendTaskRows(
        group.nodes,
        "user",
        true,
        showAllSessions ? undefined : SIDEBAR_WORKSPACE_SESSION_PREVIEW_COUNT,
      );
      if (totalTaskRows > SIDEBAR_WORKSPACE_SESSION_PREVIEW_COUNT) {
        rows.push({
          kind: "workspace-session-action",
          id: `workspace-session-action:${group.workspaceId}`,
          workspaceId: group.workspaceId,
          expanded: showAllSessions,
          remainingCount: Math.max(0, totalTaskRows - SIDEBAR_WORKSPACE_SESSION_PREVIEW_COUNT),
        });
      }
    };

    if (pinnedTaskTree.length > 0 || pinnedWorkspaceGroups.length > 0) {
      rows.push({ kind: "section-header", id: "section:pinned", label: "Pinned" });
      appendTaskRows(pinnedTaskTree, "user");
      for (const group of pinnedWorkspaceGroups) appendWorkspaceGroup(group);
    }

    const shouldShowProjectsSection =
      regularWorkspaceGroups.length > 0 ||
      (pinnedWorkspaceGroups.length === 0 && !hasSessionSearch && activeModeFilters.size === 0);

    if (shouldShowProjectsSection) {
      rows.push({
        kind: "section-header",
        id: "section:projects",
        label: "Projects",
        action: "add-workspace",
      });
      for (const group of regularWorkspaceGroups) appendWorkspaceGroup(group);
      if (pinnedWorkspaceGroups.length === 0 && regularWorkspaceGroups.length === 0) {
        rows.push({ kind: "workspace-empty", id: "workspace-empty" });
      }
    }

    const hasRecentContent =
      workspaceGroups.recentNodes.length > 0 || unpinnedAutomatedTaskTree.length > 0;
    if (hasRecentContent) {
      rows.push({ kind: "section-header", id: "section:recents", label: "Recents" });
      if (unpinnedAutomatedTaskTree.length > 0) {
        rows.push({
          kind: "automated-header",
          id: "automated-header",
          count: unpinnedAutomatedTaskTree.length,
          expanded: automatedRowsExpanded,
          hasActive: unpinnedAutomatedTaskTree.some((node) =>
            isActiveSessionStatus(node.task.status),
          ),
        });
        if (automatedRowsExpanded) {
          appendTaskRows(unpinnedAutomatedTaskTree, "automated", true);
        }
      }
      appendTaskRows(workspaceGroups.recentNodes, "user", true);
    }

    if (hasMoreTasks && (!hasSessionSearch || rows.length > 0)) {
      rows.push({ kind: "load-more", id: "load-more", loading: isLoadingMoreTasks });
    }
    return rows;
  }, [
    automatedRowsExpanded,
    effectiveCollapsedTasks,
    hasMoreTasks,
    hasSessionSearch,
    activeModeFilters.size,
    isLoadingMoreTasks,
    isWorkspaceExpanded,
    pinnedTaskTree,
    pinnedWorkspaceGroups,
    regularWorkspaceGroups,
    workspaceSessionListsExpanded,
    unpinnedAutomatedTaskTree,
    workspaceGroups.recentNodes,
  ]);

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
      if (!menuRef.current?.contains(target)) {
        setMenuOpenTaskId(null);
      }
      if (!workspaceMenuRef.current?.contains(target)) {
        setWorkspaceMenuOpenId(null);
      }
      if (!workspaceSectionMenuRef.current?.contains(target)) {
        setWorkspaceSectionMenuOpen(false);
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
    setWorkspaceMenuOpenId(null);
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
      await window.electronAPI.archiveTask(taskId);
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
            <span
              className="cli-session-indicator cli-session-indicator-active"
              aria-hidden="true"
            />
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
                <span
                  className="cli-session-indicator cli-session-indicator-invisible"
                  aria-hidden="true"
                />
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
          <Icon className="cli-subagent-icon" size={14} strokeWidth={2} />
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

  const remoteTasks = useMemo(() => tasks.filter((task) => !!task.targetNodeId), [tasks]);

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
          task.terminalStatus === "awaiting_verification" ||
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
    grouped = false,
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
            className="task-item-menu sidebar-workspace-menu sidebar-session-menu"
            role="menu"
            aria-label="Session actions"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="sidebar-workspace-menu-option"
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
              <Pencil size={16} />
              <span>Rename</span>
            </button>
            <button
              type="button"
              className="sidebar-workspace-menu-option"
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
              {task.pinned ? <PinOff size={16} /> : <Pin size={16} />}
              <span>{task.pinned ? "Unpin" : "Pin"}</span>
            </button>
            <div className="sidebar-workspace-menu-separator" role="separator" />
            <button
              type="button"
              className="sidebar-workspace-menu-option sidebar-workspace-menu-option-danger"
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
              <Archive size={16} />
              <span>Archive</span>
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
            "--cli-task-padding-left":
              depth === 0
                ? grouped
                  ? "28px"
                  : "12px"
                : `${4 + depth * 12 + (grouped ? 16 : 0)}px`,
          } as React.CSSProperties
        }
        title={taskMode && taskMode !== "standard" ? SESSION_MODE_META[taskMode].label : undefined}
      >
        {/* Tree connector for sub-agents */}
        {depth > 0 && <span className="cli-tree-prefix">{treePrefix}</span>}

        <span className="cli-task-num">
          {depth === 0 ? String(rootIndex + 1).padStart(2, "0") : "··"}
        </span>

        {!isAwaitingSession && (
          <span
            className={`cli-task-status ${getStatusClass(task.status, showCompletionAttention)} ${isActiveSessionStatus(task.status) ? "cli-task-status-leading" : ""}`}
          >
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
            <div
              className={`cli-task-title-row ${isAwaitingSession ? "cli-task-title-row-awaiting" : ""}`}
            >
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
                <span className="cli-task-action-wrap">{sessionActions}</span>
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

  const renderWorkspaceMenu = (workspaceId: string): React.ReactNode => {
    const candidate = workspaceById.get(workspaceId);
    if (!candidate || workspaceMenuOpenId !== workspaceId) return null;
    const isPinned = workspaceNavSettings.pinnedWorkspaceIds.includes(workspaceId);

    return (
      <div
        ref={workspaceMenuRef}
        className="task-item-menu sidebar-workspace-menu"
        role="menu"
        aria-label={`${getWorkspaceLabel(candidate)} project actions`}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="sidebar-workspace-menu-option"
          role="menuitem"
          data-menu-option="pin"
          onClick={() => handleToggleWorkspacePin(workspaceId)}
        >
          {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
          <span>{isPinned ? "Unpin" : "Pin"}</span>
        </button>
        <button
          type="button"
          className="sidebar-workspace-menu-option"
          role="menuitem"
          data-menu-option="edit"
          onClick={() => handleEditWorkspace(candidate)}
        >
          <Pencil size={16} />
          <span>Edit</span>
        </button>
        <div className="sidebar-workspace-menu-separator" role="separator" />
        <button
          type="button"
          className="sidebar-workspace-menu-option sidebar-workspace-menu-option-disabled"
          role="menuitem"
          data-menu-option="section"
          disabled
          title="Sections are not available for folders yet"
        >
          <ListTree size={16} />
          <span>Section</span>
          <ChevronRight size={15} className="sidebar-workspace-menu-chevron" />
        </button>
        <button
          type="button"
          className="sidebar-workspace-menu-option"
          role="menuitem"
          data-menu-option="reveal"
          onClick={() => void handleRevealWorkspace(candidate)}
        >
          <FolderOpen size={16} />
          <span>Reveal in Finder</span>
        </button>
        <button
          type="button"
          className="sidebar-workspace-menu-option sidebar-workspace-menu-option-disabled"
          role="menuitem"
          data-menu-option="worktree"
          disabled
          title="Permanent worktrees are created from a session's worktree controls"
        >
          <GitBranch size={16} />
          <span>Create permanent worktree</span>
        </button>
        <div className="sidebar-workspace-menu-separator" role="separator" />
        <button
          type="button"
          className="sidebar-workspace-menu-option"
          role="menuitem"
          data-menu-option="archive"
          onClick={() => void handleArchiveWorkspace(workspaceId)}
        >
          <Archive size={16} />
          <span>Archive chats</span>
        </button>
        <div className="sidebar-workspace-menu-separator" role="separator" />
        <button
          type="button"
          className="sidebar-workspace-menu-option sidebar-workspace-menu-option-danger"
          role="menuitem"
          data-menu-option="remove"
          onClick={() => handleRemoveWorkspace(workspaceId)}
        >
          <X size={16} />
          <span>Remove project</span>
        </button>
      </div>
    );
  };

  const renderSidebarVirtualRow = (row: SidebarVirtualRow): React.ReactNode => {
    if (row.kind === "date-header") {
      return <div className="sidebar-date-group">{row.label}</div>;
    }
    if (row.kind === "section-header") {
      return (
        <div
          ref={row.action === "add-workspace" ? workspaceSectionMenuRef : undefined}
          className="sidebar-navigation-section-header"
        >
          <span>{row.label}</span>
          {row.action === "add-workspace" && (
            <>
              <button
                type="button"
                className={`sidebar-navigation-section-action ${workspaceSectionMenuOpen ? "active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setWorkspaceMenuOpenId(null);
                  setWorkspaceSectionMenuOpen((current) => !current);
                }}
                title="Organize projects"
                aria-label="Organize projects"
                aria-haspopup="menu"
                aria-expanded={workspaceSectionMenuOpen}
              >
                <Plus size={15} strokeWidth={2.1} />
              </button>
              {workspaceSectionMenuOpen && (
                <div
                  className="task-item-menu sidebar-workspace-section-menu"
                  role="menu"
                  aria-label="Project sidebar actions"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="sidebar-workspace-menu-option"
                    role="menuitem"
                    data-menu-option="add-folder"
                    onClick={() => {
                      setWorkspaceSectionMenuOpen(false);
                      void handleAddWorkspace();
                    }}
                  >
                    <Folder size={16} />
                    <span>Add folder or project</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-workspace-menu-option"
                    role="menuitem"
                    data-menu-option="add-all"
                    onClick={handleAddAllWorkspaces}
                  >
                    <ListTree size={16} />
                    <span>Add all worked-on projects</span>
                  </button>
                  <div className="sidebar-workspace-menu-separator" role="separator" />
                  <button
                    type="button"
                    className="sidebar-workspace-menu-option sidebar-workspace-menu-option-danger"
                    role="menuitem"
                    data-menu-option="remove-all"
                    onClick={handleRemoveAllWorkspaces}
                    disabled={sidebarWorkspaceIds.size === 0}
                  >
                    <X size={16} />
                    <span>Remove all projects from sidebar</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      );
    }
    if (row.kind === "workspace-empty") {
      return (
        <div className="sidebar-navigation-section-empty">
          <span>No projects added</span>
          <small>Use + to add a folder or all worked-on projects.</small>
        </div>
      );
    }
    if (row.kind === "workspace-session-action") {
      const label = row.expanded
        ? "Show less"
        : row.remainingCount > 0
          ? `Show more (${row.remainingCount})`
          : "Show more";
      return (
        <button
          type="button"
          className="sidebar-workspace-session-action"
          onClick={() => handleToggleWorkspaceSessionList(row.workspaceId)}
          aria-expanded={row.expanded}
          aria-label={`${label} sessions`}
        >
          <span>{label}</span>
        </button>
      );
    }
    if (row.kind === "workspace-header") {
      const workspaceMenuOpen = workspaceMenuOpenId === row.workspaceId;
      return (
        <div
          className={`sidebar-workspace-node ${workspaceMenuOpen ? "sidebar-workspace-menu-open" : ""} ${row.current ? "current" : ""}`}
        >
          <div className="sidebar-workspace-row">
            <button
              type="button"
              className="sidebar-workspace-toggle"
              onClick={() => handleToggleWorkspaceExpanded(row.workspaceId)}
              aria-expanded={row.expanded}
              title={row.path || row.label}
            >
              <span className="sidebar-workspace-chevron" aria-hidden="true">
                {row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <span className="sidebar-workspace-icon" aria-hidden="true">
                {row.expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
              </span>
              <span className="sidebar-workspace-label">{row.label}</span>
              {row.current && (
                <span className="sidebar-workspace-current-dot" aria-label="Current project" />
              )}
            </button>
            <div className="sidebar-workspace-actions">
              <button
                type="button"
                className="sidebar-workspace-more"
                aria-haspopup="menu"
                aria-expanded={workspaceMenuOpen}
                aria-label={`Project actions for ${row.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpenTaskId(null);
                  setWorkspaceMenuOpenId((current) =>
                    current === row.workspaceId ? null : row.workspaceId,
                  );
                }}
              >
                <EllipsisVertical size={15} strokeWidth={2.2} />
              </button>
              {renderWorkspaceMenu(row.workspaceId)}
            </div>
          </div>
        </div>
      );
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
        {renderTaskRow(row.row.node, row.row.rootIndex, row.row.depth, row.row.isLast, row.grouped)}
      </div>
    );
  };

  return (
    <div className="sidebar cli-sidebar">
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
                <span
                  className="sidebar-home-btn-icon"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
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
                <span
                  className="sidebar-home-btn-icon"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
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
                <span
                  className="sidebar-home-btn-icon"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
                  <Inbox size={16} strokeWidth={2} style={{ display: "block" }} />
                </span>
                <span>{inboxNavLabel}</span>
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`new-task-btn cli-new-task-btn cli-action-btn sidebar-home-btn sidebar-nav-item ${isAutomationsActive ? "active" : ""}`}
            onClick={onOpenAutomations}
            aria-pressed={isAutomationsActive}
            title="Automations"
          >
            <span className="cli-btn-text">
              <span className="terminal-only">automation</span>
              <span className="modern-only cli-new-task-modern-label">
                <span
                  className="sidebar-home-btn-icon"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
                  <Workflow size={16} strokeWidth={2} style={{ display: "block" }} />
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
                <span
                  className="sidebar-home-btn-icon"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
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
                <span
                  className="sidebar-home-btn-icon sidebar-more-dots"
                  aria-hidden="true"
                  style={{ display: "flex" }}
                >
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
                    <span
                      className="sidebar-home-btn-icon"
                      aria-hidden="true"
                      style={{ display: "flex" }}
                    >
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
                    <span
                      className="sidebar-home-btn-icon"
                      aria-hidden="true"
                      style={{ display: "flex" }}
                    >
                      <HeartPulse size={16} strokeWidth={2} style={{ display: "block" }} />
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
                    <span
                      className="sidebar-home-btn-icon"
                      aria-hidden="true"
                      style={{ display: "flex" }}
                    >
                      <Lightbulb size={16} strokeWidth={2} style={{ display: "block" }} />
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
              <button
                type="button"
                className="devices-sidebar-home-btn active"
                onClick={() => navigateDevicesSection("overview")}
              >
                <span className="devices-sidebar-home-icon">
                  <Server size={14} />
                </span>
                <span>Fleet Home</span>
                <span className="devices-sidebar-home-count">{remoteDeviceIds.size}</span>
              </button>
            </div>
            <div className="devices-sidebar-grid">
              <button
                type="button"
                className="devices-sidebar-link"
                onClick={() => triggerDevicesAction("pairing")}
              >
                <Server size={14} />
                <span>Pair remote</span>
                <strong>+</strong>
              </button>
              <button
                type="button"
                className="devices-sidebar-link"
                onClick={() => navigateDevicesSection("alerts")}
              >
                <Bell size={14} />
                <span>Attention queue</span>
                <strong>{remoteAttentionCount}</strong>
              </button>
              <button
                type="button"
                className="devices-sidebar-link"
                onClick={() => navigateDevicesSection("apps")}
              >
                <AppWindow size={14} />
                <span>Setup inbox</span>
              </button>
              <button
                type="button"
                className="devices-sidebar-link"
                onClick={() => navigateDevicesSection("storage")}
              >
                <HardDrive size={14} />
                <span>Isolation check</span>
              </button>
            </div>
          </div>

          <div className="devices-sidebar-subhead">
            <span>Observer</span>
            <button
              type="button"
              className="devices-sidebar-sort"
              onClick={() => navigateDevicesSection("alerts")}
            >
              Attention {remoteAttentionCount > 0 ? `(${remoteAttentionCount})` : ""}
            </button>
          </div>

          <div className="devices-sidebar-list">
            <button
              type="button"
              className="devices-sidebar-item featured"
              onClick={() => navigateDevicesSection("tasks")}
            >
              <div className="devices-sidebar-item-top">
                <Rows3 size={14} />
                <span className="devices-sidebar-item-label">Execution lane</span>
                <span className="devices-sidebar-item-dot" />
              </div>
              <strong>
                {remoteTasks.length > 0
                  ? `${remoteTasks.length} remote runs in view`
                  : "No remote runs yet"}
              </strong>
              <span>Use this page to launch and supervise work happening on paired remotes.</span>
            </button>
            <button
              type="button"
              className="devices-sidebar-item"
              onClick={() => triggerDevicesAction("pairing")}
            >
              <div className="devices-sidebar-item-top">
                <Server size={14} />
                <span>Fleet shape</span>
              </div>
              <strong>
                {remoteDeviceIds.size > 0
                  ? `${remoteDeviceIds.size} remotes paired or active`
                  : "Start with your first remote"}
              </strong>
              <span>
                Separate work, personal, archive, or automation machines without mixing disks.
              </span>
            </button>
            <button
              type="button"
              className="devices-sidebar-item"
              onClick={() => navigateDevicesSection("alerts")}
            >
              <div className="devices-sidebar-item-top">
                <Bell size={14} />
                <span>Observer feed</span>
              </div>
              <strong>
                {remoteAttentionCount > 0
                  ? `${remoteAttentionCount} issues waiting`
                  : "Observer is quiet"}
              </strong>
              <span>Approvals, failed app connections, and offline remotes surface here.</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sidebar-session-tabs" role="tablist" aria-label="Workspace views">
            <button
              type="button"
              role="tab"
              className={`sidebar-session-tab ${visibleSidebarTab === "sessions" ? "active" : ""}`}
              aria-selected={visibleSidebarTab === "sessions"}
              onClick={() => setSidebarTab("sessions")}
            >
              Sessions
            </button>
            <button
              type="button"
              role="tab"
              className={`sidebar-session-tab ${visibleSidebarTab === "bots" ? "active" : ""}`}
              aria-selected={visibleSidebarTab === "bots"}
              onClick={() => setSidebarTab("bots")}
            >
              Bots
            </button>
          </div>

          {visibleSidebarTab === "bots" ? (
            <BotsPane
              roles={botRoles}
              tasks={botTasks}
              selectedTaskId={selectedTaskId}
              selectedConversationProjection={selectedBotConversationProjection}
              conversationProjections={botConversationProjections}
              isLoading={isLoadingBots}
              error={botsError}
              onRetry={() => void loadAgentRoles()}
              onSelectTask={onSelectTask}
              onOpenBot={onOpenBot}
              onReopenBot={onReopenBot}
              onOpenAgents={onOpenAgents}
              onBotCreated={handleBotCreated}
              onBotUpdated={async (bot) => {
                setAgentRoles((current) => {
                  const next = new Map(current);
                  next.set(bot.id, { ...bot, color: bot.color || "#6366f1" });
                  return next;
                });
                await onBotUpdated?.(bot);
              }}
              onBotDeleted={async (botId) => {
                setAgentRoles((current) => {
                  const next = new Map(current);
                  next.delete(botId);
                  return next;
                });
                await onBotDeleted?.(botId);
              }}
            />
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
                    <span className="cli-section-prompt terminal-only">
                      {sessionsCollapsed ? "▸" : "▾"}
                    </span>
                    <span className="terminal-only">SESSIONS</span>
                    <span className="modern-only cli-new-task-modern-label">
                      <span className="sidebar-home-btn-icon cli-sessions-icon" aria-hidden="true">
                        <SlidersHorizontal size={16} strokeWidth={2} style={{ display: "block" }} />
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

                {(pinActionError || archiveActionError || workspaceActionError) && (
                  <div
                    className="cli-sidebar-error"
                    role="alert"
                    style={{ marginTop: "4px", marginLeft: "4px", marginRight: "4px" }}
                  >
                    {pinActionError || archiveActionError || workspaceActionError}
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
                    {sidebarVirtualRows.length === 0 ? (
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
                          if (row.kind === "task")
                            return `${row.section ?? "user"}:${row.row.node.task.id}`;
                          return row.id;
                        }}
                        getItemHeight={(row) =>
                          row.kind === "section-header"
                            ? SIDEBAR_SECTION_HEADER_HEIGHT
                            : row.kind === "workspace-empty"
                              ? SIDEBAR_SECTION_HEADER_HEIGHT + 20
                              : row.kind === "workspace-session-action"
                                ? SIDEBAR_WORKSPACE_SESSION_ACTION_HEIGHT
                                : row.kind === "workspace-header"
                                  ? SIDEBAR_WORKSPACE_HEADER_HEIGHT
                                  : row.kind === "date-header"
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
                          uiDensity === "focused"
                            ? SIDEBAR_FOCUSED_ITEM_HEIGHT
                            : SIDEBAR_ITEM_HEIGHT
                        }
                        overscan={10}
                        enabled
                        suppressAutoScrollOnItemsChange
                        className="sidebar-virtual-list"
                        style={{ height: "100%" }}
                        role="list"
                        onScrollNearEnd={onLoadMoreTasks}
                      />
                    ) : (
                      sidebarVirtualRows.map((row) => (
                        <div
                          key={
                            row.kind === "task"
                              ? `${row.section ?? "user"}:${row.row.node.task.id}`
                              : row.id
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
          {updateInfo?.available && !updateDismissed && (
            <div className="sidebar-update-actions">
              <button
                type="button"
                className="update-banner"
                aria-label={
                  updateInfo.supported === false
                    ? "View update system requirements"
                    : "Open update settings"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onViewUpdate?.();
                }}
              >
                {updateInfo.supported === false ? "Requires macOS 13+" : "Update"}
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
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M9 3L3 9M3 3L9 9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          )}
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
