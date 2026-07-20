import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useDeferredValue,
  lazy,
  Suspense,
  startTransition,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useReplayMode, type ReplayControls } from "./hooks/useReplayMode";
import { useTaskDuration } from "./hooks/useTaskDuration";
import { Sidebar } from "./components/Sidebar";
import type { SpreadsheetTurnContext } from "./components/SpreadsheetArtifactViewer";
import { ResizableDividerHandle } from "./components/ResizableDividerHandle";
import { DisclaimerModal } from "./components/DisclaimerModal";
import { Onboarding } from "./components/Onboarding";
// TaskQueuePanel moved to RightPanel
import { ToastContainer } from "./components/Toast";
import {
  ComputerUseApprovalDialog,
  isComputerUseAppGrantApproval,
} from "./components/ComputerUseApprovalDialog";
import {
  BrowserUseApprovalDialog,
  isBrowserUseDomainApproval,
} from "./components/BrowserUseApprovalDialog";
import { GenericApprovalDialog } from "./components/GenericApprovalDialog";
import { ApproveAllSessionWarningDialog } from "./components/ApproveAllSessionWarningDialog";
import { QuickTaskFAB } from "./components/QuickTaskFAB";
import { NotificationPanel } from "./components/NotificationPanel";
import { WebAccessClient } from "./components/WebAccessClient";
import {
  Task,
  Workspace,
  TaskEvent,
  LLMModelInfo,
  LLMProviderInfo,
  UpdateInfo,
  ThemeMode,
  VisualTheme,
  AccentColor,
  UiDensity,
  QueueStatus,
  ToastNotification,
  ApprovalRequest,
  InputRequest,
  InputRequestResponse,
  ApprovalResponseAction,
  isTempWorkspaceId,
  ImageAttachment,
  MultiLlmConfig,
  QuotedAssistantMessage,
  ExecutionMode,
  TaskDomain,
  AgentConfig,
  LlmProfile,
  PermissionMode,
  LLMProviderType,
  LLMReasoningEffort,
  IntegrationMentionSelection,
  TaskTimelinePageCursor,
} from "../shared/types";
import { TASK_EVENT_STATUS_MAP } from "../shared/task-event-status-map";
import { getEffectiveTaskEventType } from "./utils/task-event-compat";
import { isLlmRequestCancelledEvent } from "./utils/task-event-visibility";
import { appendRendererTaskEvents, capTaskEvents } from "./utils/task-event-append";
import { invalidateGlobalMeasurer } from "./utils/pretext-adapter";
import {
  hasTaskOutputs,
  resolveTaskOutputSummaryFromCompletionEvent,
} from "./utils/task-outputs";
import {
  addUniqueTaskId,
  buildTaskCompletionToast,
  decideCompletionPanelBehavior,
  recordCompletionToastShown,
  removeTaskId,
  shouldClearUnseenOutputBadges,
  shouldShowCompletionToast,
  shouldNotifyForTaskCompletionTerminalStatus,
  shouldTrackUnseenCompletion,
} from "./utils/task-completion-ux";
import { isSpawnSubagentsPrompt } from "../shared/spawn-intent-detection";
import { findMultitaskCommand, parseMultitaskCommand } from "../shared/multitask-command";
import { isSynthesisChildTask } from "../shared/synthesis-agent-detection";
import { classifyShellPermissionDecision } from "../shared/shell-permission-intents";
import { isAutomatedTaskLike } from "../shared/automated-task-detection";
import { resolveTaskStatusUpdateFromEvent } from "../shared/task-status";
import {
  getFirstRunReadiness,
  getFirstRunReadinessActionLabel,
} from "../shared/first-run-readiness";
import {
  noteRendererTaskEventQueued,
  noteRendererTaskEventReceived,
  noteRendererTaskEventsAppendDispatched,
  noteRendererTaskEventsAppended,
  flushRendererStartupMarks,
  markRendererPerfEvent,
  markRendererStartup,
  measureRendererPerf,
  recordRendererPerfSample,
  recordRendererRender,
} from "./utils/renderer-perf";
import {
  deriveSharedTaskEventUiState,
  type SharedTaskEventUiState,
} from "./utils/task-event-derived";
import { isTaskActivelyWorking } from "./utils/task-working-state";
import { deriveReplayTaskSnapshot } from "./utils/task-replay-state";
import {
  getTaskEventIdentity,
  mergeTaskEventsByIdentity,
  shouldIncludeTaskEventInSelectedSession,
  shouldRefreshCanonicalEventsForTerminalUpdate,
} from "./utils/task-event-stream";
import {
  hasTaskHydrationAttempted,
  mergeSidebarInitialPageWithSelectedTask,
  mergeSidebarTaskSummariesWithExisting,
  pruneTaskHydrationAttemptKeys,
  recordTaskHydrationAttemptSuccess,
  shouldHydrateTaskSummary,
} from "./utils/sidebar-task-summaries";
import { classifyLiveTaskEvent } from "./utils/live-task-event-policy";

const Settings = lazy(() =>
  import("./components/Settings").then((module) => ({ default: module.Settings })),
);
const mainContentModulePromise = import("./components/MainContent");
void mainContentModulePromise.catch(() => {});
const MainContent = lazy(() =>
  mainContentModulePromise.then((module) => ({ default: module.MainContent })),
);
const RightPanel = lazy(() =>
  import("./components/RightPanel").then((module) => ({ default: module.RightPanel })),
);
const SideChatPanel = lazy(() =>
  import("./components/SideChatPanel").then((module) => ({ default: module.SideChatPanel })),
);
const TerminalTabsDock = lazy(() =>
  import("./components/TerminalTabsDock").then((module) => ({ default: module.TerminalTabsDock })),
);
const SpreadsheetArtifactViewer = lazy(() =>
  import("./components/SpreadsheetArtifactViewer").then((module) => ({
    default: module.SpreadsheetArtifactViewer,
  })),
);
const DocumentArtifactViewer = lazy(() =>
  import("./components/DocumentArtifactViewer").then((module) => ({
    default: module.DocumentArtifactViewer,
  })),
);
const PresentationArtifactViewer = lazy(() =>
  import("./components/PresentationArtifactViewer").then((module) => ({
    default: module.PresentationArtifactViewer,
  })),
);
const WebArtifactViewer = lazy(() =>
  import("./components/WebArtifactViewer").then((module) => ({ default: module.WebArtifactViewer })),
);
const BrowserWorkbenchView = lazy(() =>
  import("./components/BrowserWorkbenchView").then((module) => ({
    default: module.BrowserWorkbenchView,
  })),
);
const SpawnedAgentSidebar = lazy(() =>
  import("./components/SpawnedAgentSidebar").then((module) => ({
    default: module.SpawnedAgentSidebar,
  })),
);
const BrowserView = lazy(() =>
  import("./components/BrowserView").then((module) => ({ default: module.BrowserView })),
);
const HomeDashboard = lazy(() =>
  import("./components/HomeDashboard").then((module) => ({ default: module.HomeDashboard })),
);
const AutomationStudioPanel = lazy(() => import("./components/AutomationStudioPanel"));
const HealthPanel = lazy(() =>
  import("./components/HealthPanel").then((module) => ({ default: module.HealthPanel })),
);
const DevicesPanel = lazy(() =>
  import("./components/DevicesPanel").then((module) => ({ default: module.DevicesPanel })),
);
const IdeasPanel = lazy(() =>
  import("./components/IdeasPanel").then((module) => ({ default: module.IdeasPanel })),
);
const InboxAgentPanel = lazy(() =>
  import("./components/InboxAgentPanel").then((module) => ({ default: module.InboxAgentPanel })),
);
const AgentsHubPanel = lazy(() =>
  import("./components/AgentsHubPanel").then((module) => ({ default: module.AgentsHubPanel })),
);
const EverydayAgentPanel = lazy(() =>
  import("./components/EverydayAgentPanel").then((module) => ({
    default: module.EverydayAgentPanel,
  })),
);
const MissionControlPanel = lazy(() =>
  import("./components/mission-control").then((module) => ({
    default: module.MissionControlPanel,
  })),
);

const SPREADSHEET_SIDEBAR_DEFAULT_WIDTH = 720;
const SPREADSHEET_SIDEBAR_MIN_WIDTH = 420;
const SPREADSHEET_MAIN_MIN_WIDTH = 390;
const SPREADSHEET_SIDEBAR_WIDTH_STORAGE_KEY = "cowork:spreadsheetSidebarWidth";
type ActiveArtifactKind = "spreadsheet" | "document" | "presentation" | "webpage";
type BrowserWorkbenchOpenRequest = {
  requestId: string;
  taskId: string;
  sessionId: string;
  url?: string;
};

function readPersistedSpreadsheetSidebarWidth(): number {
  try {
    const rawValue = window.localStorage.getItem(SPREADSHEET_SIDEBAR_WIDTH_STORAGE_KEY);
    const parsedValue = rawValue ? Number(rawValue) : NaN;
    if (!Number.isFinite(parsedValue)) return SPREADSHEET_SIDEBAR_DEFAULT_WIDTH;
    return Math.max(Math.round(parsedValue), SPREADSHEET_SIDEBAR_MIN_WIDTH);
  } catch {
    return SPREADSHEET_SIDEBAR_DEFAULT_WIDTH;
  }
}

function normalizeWorkspacePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/");
}

function getSpreadsheetFileName(filePath: string): string {
  const normalized = normalizeWorkspacePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function cleanTurnText(value: unknown, maxLength = 220): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getEventText(event: TaskEvent | undefined): string {
  if (!event) return "";
  const payload = event.payload || {};
  const step = payload.step && typeof payload.step === "object" ? payload.step as Record<string, unknown> : null;
  return cleanTurnText(
    payload.message ??
      payload.resultSummary ??
      payload.semanticSummary ??
      payload.text ??
      step?.description,
  );
}

function getSpreadsheetTurnEventKind(event: TaskEvent): {
  kind: "step" | "assistant";
  tone?: "muted" | "active" | "done";
} | null {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message") return { kind: "assistant" };
  if (effectiveType === "progress_update") return { kind: "step", tone: "active" };
  if (event.type === "timeline_step_started" || event.type === "timeline_step_updated") {
    return { kind: "step", tone: "active" };
  }
  if (event.type === "timeline_step_finished" || effectiveType === "step_completed") {
    return { kind: "step", tone: "done" };
  }
  return null;
}

function getSpreadsheetTurnEventText(event: TaskEvent): string {
  const effectiveType = getEffectiveTaskEventType(event);
  const payload = event.payload || {};
  const step = payload.step && typeof payload.step === "object" ? payload.step as Record<string, unknown> : null;
  const path =
    typeof payload.path === "string"
      ? payload.path
      : typeof payload.to === "string"
        ? payload.to
        : "";
  if (
    effectiveType === "file_created" ||
    effectiveType === "artifact_created" ||
    effectiveType === "file_modified"
  ) {
    return path ? getSpreadsheetFileName(path) : getEventText(event);
  }
  if (effectiveType === "tool_call") {
    return cleanTurnText(payload.command ?? payload.description ?? payload.tool, 180);
  }
  return cleanTurnText(
    payload.message ??
      payload.resultSummary ??
      payload.semanticSummary ??
      payload.text ??
      step?.description,
    260,
  );
}

function buildSpreadsheetTurnEvents(args: {
  events: TaskEvent[];
  taskId?: string;
  sinceTimestamp?: number | null;
  limit?: number;
}): SpreadsheetTurnContext["events"] {
  const rows: NonNullable<SpreadsheetTurnContext["events"]> = [];
  for (const event of args.events) {
    if (args.taskId && event.taskId !== args.taskId) continue;
    if (args.sinceTimestamp && event.timestamp < args.sinceTimestamp) continue;
    const eventKind = getSpreadsheetTurnEventKind(event);
    if (!eventKind) continue;
    if (event.payload?.internal === true && eventKind.kind === "assistant") continue;
    const text = getSpreadsheetTurnEventText(event);
    if (!text) continue;
    const previous = rows[rows.length - 1];
    if (previous?.kind === eventKind.kind && previous.text === text) continue;
    rows.push({
      id: event.id,
      kind: eventKind.kind,
      text,
      tone: eventKind.tone,
    });
  }
  return rows.slice(-(args.limit ?? 8));
}

function eventPathMatchesSpreadsheet(event: TaskEvent, filePath: string): boolean {
  const target = normalizeWorkspacePath(filePath);
  const targetName = getSpreadsheetFileName(target);
  const payload = event.payload || {};
  const candidatePaths = [payload.path, payload.to, payload.from, payload.filePath].filter(
    (value): value is string => typeof value === "string",
  );
  return candidatePaths.some((candidate) => {
    const normalized = normalizeWorkspacePath(candidate);
    return normalized === target || getSpreadsheetFileName(normalized) === targetName;
  });
}

function findSpreadsheetCreationEvent(events: TaskEvent[], filePath: string): TaskEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      (effectiveType === "file_created" ||
        effectiveType === "artifact_created" ||
        event.type === "timeline_artifact_emitted") &&
      eventPathMatchesSpreadsheet(event, filePath)
    ) {
      return event;
    }
  }
  return null;
}

function findLatestUserMessageTimestamp(events: TaskEvent[], taskId?: string): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (taskId && event.taskId !== taskId) continue;
    if (getEffectiveTaskEventType(event) === "user_message") return event.timestamp;
  }
  return null;
}

function buildSpreadsheetTurnContext(args: {
  task: Task | undefined;
  events: TaskEvent[];
  filePath: string;
  isWorking: boolean;
  durationLabel: string;
  turnStartedAt?: number | null;
}): SpreadsheetTurnContext | null {
  const fileName = getSpreadsheetFileName(args.filePath);
  const latestUserMessageAt =
    args.turnStartedAt ?? findLatestUserMessageTimestamp(args.events, args.task?.id);

  if (args.isWorking) {
    let summary = "";
    for (let index = args.events.length - 1; index >= 0; index -= 1) {
      const event = args.events[index];
      if (args.task?.id && event.taskId !== args.task.id) continue;
      if (latestUserMessageAt && event.timestamp < latestUserMessageAt) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (
        effectiveType === "assistant_message" ||
        effectiveType === "progress_update" ||
        event.type === "timeline_step_started" ||
        event.type === "timeline_step_updated"
      ) {
        if (event.payload?.internal === true) continue;
        summary = getEventText(event);
        if (summary) break;
      }
    }
    if (!summary) summary = cleanTurnText(args.task?.title) || `Working on ${fileName}.`;

    const modifiedFiles = new Set<string>();
    let runningCommandCount = 0;
    for (const event of args.events) {
      if (args.task?.id && event.taskId !== args.task.id) continue;
      if (latestUserMessageAt && event.timestamp < latestUserMessageAt) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (effectiveType === "file_modified") {
        const path = typeof event.payload?.path === "string" ? event.payload.path : "";
        if (path) modifiedFiles.add(path);
      }
      if (effectiveType === "tool_call" && event.payload?.tool === "run_command") {
        runningCommandCount += 1;
      }
    }
    const detailParts = [
      modifiedFiles.size > 0 ? `Edited ${modifiedFiles.size} file${modifiedFiles.size === 1 ? "" : "s"}` : "",
      runningCommandCount > 0
        ? `running ${runningCommandCount} command${runningCommandCount === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean);

    return {
      statusLabel: `Working for ${args.durationLabel}`,
      summary,
      secondaryText: detailParts.join(", "),
      artifactPath: args.filePath,
      artifactName: fileName,
      events: buildSpreadsheetTurnEvents({
        events: args.events,
        taskId: args.task?.id,
        sinceTimestamp: latestUserMessageAt,
      }),
    };
  }

  const creationEvent = findSpreadsheetCreationEvent(args.events, args.filePath);
  const settledTurnStartedAt = latestUserMessageAt ?? creationEvent?.timestamp;
  let completionEvent: TaskEvent | null = null;
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const event = args.events[index];
    if (args.task?.id && event.taskId !== args.task.id) continue;
    if (getEffectiveTaskEventType(event) !== "task_completed") continue;
    if (settledTurnStartedAt && event.timestamp < settledTurnStartedAt) continue;
    completionEvent = event;
    break;
  }

  const completionPayload = completionEvent?.payload || {};
  const summary =
    cleanTurnText(completionPayload.resultSummary) ||
    cleanTurnText(completionPayload.semanticSummary) ||
    cleanTurnText(completionPayload.message) ||
    cleanTurnText(args.task?.semanticSummary) ||
    cleanTurnText(args.task?.resultSummary) ||
    `Created ${fileName}.`;

  return {
    statusLabel: "Latest turn",
    summary,
    artifactPath: args.filePath,
    artifactName: fileName,
    events: buildSpreadsheetTurnEvents({
      events: args.events,
      taskId: args.task?.id,
      sinceTimestamp: settledTurnStartedAt,
    }),
  };
}

// Helper to get effective theme based on system preference
function getEffectiveTheme(themeMode: ThemeMode): "light" | "dark" {
  if (themeMode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return themeMode;
}

function LazyViewFallback({ className = "main-content" }: { className?: string }) {
  return (
    <main className={className}>
      <div className="loading">Loading...</div>
    </main>
  );
}

function SnowLeopardLoadingLogo({ decorative = false }: { decorative?: boolean }) {
  return (
    <div
      className="task-view-loading-logo"
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : "Loading main area"}
      aria-hidden={decorative ? true : undefined}
    >
      <img src="./cowork-os-app-logo-light.png" alt="" aria-hidden="true" />
    </div>
  );
}

function TaskViewSkeleton() {
  return (
    <main className="main-content task-view-skeleton" aria-busy="true">
      <SnowLeopardLoadingLogo />
    </main>
  );
}

function RightPanelFallback() {
  return (
    <aside
      className="right-panel"
      style={{
        width: "var(--right-panel-width)",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        paddingTop: "var(--title-bar-height)",
        background: "var(--color-bg-sidebar)",
        borderLeft: "1px solid var(--color-border-subtle)",
      }}
    >
      <div className="loading">Loading...</div>
    </aside>
  );
}

function ArtifactSidebarFallback() {
  return (
    <aside className="spreadsheet-viewer spreadsheet-viewer-sidebar" aria-busy="true">
      <div className="loading">Loading...</div>
    </aside>
  );
}

const EMPTY_RIGHT_PANEL_INPUT = {
  task: undefined,
  workspace: null,
  events: [],
  sharedTaskEventUi: null,
  hasActiveChildren: false,
  childTasks: [],
  childEvents: [],
  runningTasks: [],
  queuedTasks: [],
  queueStatus: null,
  highlightOutputPath: null,
};

function mergeTaskPreservingIdentity(current: Task, updates: Partial<Task>): Task {
  let changed = false;
  const next = { ...current } as Task;

  for (const key of Object.keys(updates) as Array<keyof Task>) {
    const value = updates[key];
    if (Object.is(current[key], value)) continue;
    changed = true;
    (next as Record<keyof Task, Task[keyof Task]>)[key] = value as Task[keyof Task];
  }

  return changed ? next : current;
}

function upsertTaskPreservingIdentity(
  tasks: Task[],
  incoming: Task,
  options?: { prependIfMissing?: boolean },
): Task[] {
  const prependIfMissing = options?.prependIfMissing ?? false;
  let found = false;
  let changed = false;

  const next = tasks.map((task) => {
    if (task.id !== incoming.id) return task;
    found = true;
    const merged = mergeTaskPreservingIdentity(task, incoming);
    if (merged !== task) changed = true;
    return merged;
  });

  if (found) {
    return changed ? next : tasks;
  }

  return prependIfMissing ? [incoming, ...tasks] : [...tasks, incoming];
}

function updateTaskPreservingIdentity(
  tasks: Task[],
  taskId: string,
  updater: (task: Task) => Task,
): Task[] {
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    const updated = updater(task);
    if (updated !== task) changed = true;
    return updated;
  });
  return changed ? next : tasks;
}

type AppView =
  | "home"
  | "automations"
  | "main"
  | "settings"
  | "browser"
  | "devices"
  | "health"
  | "ideas"
  | "inboxAgent"
  | "agents"
  | "everydayAgent"
  | "missionControl";
type RemoteTaskView = {
  deviceId: string;
  deviceName: string;
  task: Task;
  events: TaskEvent[];
};
type SideChatState = {
  parentTaskId: string;
  parentTask: Task | null;
  task: Task | null;
  events: TaskEvent[];
  loading: boolean;
  sending: boolean;
};

type SelectedTaskWorkspaceViewProps = {
  task: Task | undefined;
  selectedTaskId: string | null;
  workspace: Workspace | null;
  replayControls: ReplayControls;
  sharedTaskEventUi: SharedTaskEventUiState | null;
  remoteTaskView: RemoteTaskView | null;
  childTasks: Task[];
  childEvents: TaskEvent[];
  activeInputRequest: InputRequest | null;
  pendingInputRequests: InputRequest[];
  selectedModel: string;
  selectedProvider: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  availableModels: LLMModelInfo[];
  availableProviders: LLMProviderInfo[];
  uiDensity: UiDensity;
  homeResearchVaultEnabled: boolean;
  homeNextActionsEnabled: boolean;
  rendererPerfLoggingEnabled: boolean;
  taskSwitchId: string | null;
  hasMoreTimelineHistory: boolean;
  isLoadingTimelineHistory: boolean;
  timelineHistoryError: string | null;
  onLoadMoreTimelineHistory: () => void | Promise<void>;
  onLoadTaskEventDetail: (eventId: string, taskId: string) => void | Promise<void>;
  effectiveRightCollapsed: boolean;
  terminalTabsOpen: boolean;
  browserWorkbenchRequest: BrowserWorkbenchOpenRequest | null;
  sideChat: SideChatState | null;
  rightPanelInput: {
    task: Task | undefined;
    workspace: Workspace | null;
    events: TaskEvent[];
    sharedTaskEventUi: SharedTaskEventUiState | null;
    hasActiveChildren: boolean;
    childTasks: Task[];
    childEvents: TaskEvent[];
    runningTasks: Task[];
    queuedTasks: Task[];
    queueStatus: QueueStatus | null;
    highlightOutputPath: string | null;
  };
  onSelectChildTask: (taskId: string) => void;
  onSelectTask: (taskId: string | null) => void;
  onSendMessage: (
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      integrationMentions?: IntegrationMentionSelection[];
    },
  ) => Promise<void>;
  onOpenSideChat: (request: {
    taskId: string;
    fromEventId?: string;
    initialMessage?: string;
  }) => Promise<void>;
  onSendSideChatMessage: (message: string) => Promise<void>;
  onCloseSideChat: () => void;
  onOpenSideChatFullThread: (taskId: string) => void | Promise<void>;
  onStartOnboarding: () => void;
  onStartFreshSession?: () => void;
  onCreateTask: (
    title: string,
    prompt: string,
    options?: Any,
    images?: ImageAttachment[],
    workspace?: Workspace,
  ) => Promise<void>;
  onAskInbox: (query: string) => void;
  onChangeWorkspace: () => void;
  onSelectWorkspace: (workspace: Workspace) => void;
  onOpenSettings: (tab?: string) => void;
  onStopTask: () => Promise<void>;
  onEnableShellForPausedTask: () => Promise<void>;
  onContinueWithoutShellForPausedTask: () => Promise<void>;
  onWrapUpTask: () => Promise<void>;
  onSubmitInputRequest: (
    requestId: string,
    answers: Record<string, { optionLabel?: string; otherText?: string }>,
  ) => void;
  onDismissInputRequest: (requestId: string) => void;
  onOpenBrowserView?: (url?: string) => void;
  onRevealRightSidebar?: () => void;
  onViewTaskOutputs: (taskId: string, primaryOutputPath?: string) => void;
  onTasksChanged: () => void | Promise<void>;
  onCancelTaskById: (taskId: string) => Promise<void>;
  onHighlightConsumed: () => void;
  onCloseTerminalTabs: () => void;
  onModelChange: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
};

function getAppTaskSignature(task: Task | undefined): string {
  if (!task) return "none";
  return [
    task.id,
    task.title,
    task.status,
    task.terminalStatus ?? "",
    task.workspaceId,
    task.updatedAt,
    task.completedAt ?? "",
    task.lastRunDurationMs ?? "",
    task.pinned ? "pinned" : "unpinned",
    task.sessionId ?? "",
    task.worktreePath ?? "",
  ].join(":");
}

function getInputRequestSignature(inputRequest: InputRequest | null): string {
  if (!inputRequest) return "none";
  return [inputRequest.id, inputRequest.taskId, inputRequest.status, inputRequest.requestedAt].join(":");
}

function getInputRequestsSignature(inputRequests: InputRequest[]): string {
  if (inputRequests.length === 0) return "none";
  return inputRequests
    .map((request) =>
      [request.id, request.taskId, request.status, request.requestedAt, request.questions.length].join(":"),
    )
    .join("|");
}

const SelectedTaskWorkspaceView = memo(function SelectedTaskWorkspaceView({
  task,
  selectedTaskId,
  workspace,
  replayControls,
  sharedTaskEventUi,
  remoteTaskView,
  childTasks,
  childEvents,
  activeInputRequest,
  pendingInputRequests,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels,
  availableProviders,
  uiDensity,
  homeResearchVaultEnabled,
  homeNextActionsEnabled,
  rendererPerfLoggingEnabled,
  taskSwitchId,
  hasMoreTimelineHistory,
  isLoadingTimelineHistory,
  timelineHistoryError,
  onLoadMoreTimelineHistory,
  onLoadTaskEventDetail,
  effectiveRightCollapsed,
  terminalTabsOpen,
  browserWorkbenchRequest,
  sideChat,
  rightPanelInput,
  onSelectChildTask,
  onSelectTask,
  onSendMessage,
  onOpenSideChat,
  onSendSideChatMessage,
  onCloseSideChat,
  onOpenSideChatFullThread,
  onStartOnboarding,
  onStartFreshSession,
  onCreateTask,
  onAskInbox,
  onChangeWorkspace,
  onSelectWorkspace,
  onOpenSettings,
  onStopTask,
  onEnableShellForPausedTask,
  onContinueWithoutShellForPausedTask,
  onWrapUpTask,
  onSubmitInputRequest,
  onDismissInputRequest,
  onOpenBrowserView,
  onRevealRightSidebar,
  onViewTaskOutputs,
  onTasksChanged,
  onCancelTaskById,
  onHighlightConsumed,
  onCloseTerminalTabs,
  onModelChange,
}: SelectedTaskWorkspaceViewProps) {
  const [spreadsheetArtifact, setSpreadsheetArtifact] = useState<{
    kind: ActiveArtifactKind;
    path: string;
    mode: "sidebar" | "fullscreen";
  } | null>(null);
  const [browserWorkbench, setBrowserWorkbench] = useState<{
    sessionId: string;
    url?: string;
    mode: "sidebar" | "fullscreen";
    requestId?: string;
  } | null>(null);
  const [spawnedAgentSidebar, setSpawnedAgentSidebar] = useState<{
    taskId: string;
  } | null>(null);
  const [lastSettledArtifactRefreshKey, setLastSettledArtifactRefreshKey] = useState<{
    path: string;
    key: string | null;
  } | null>(null);
  const [spreadsheetTurnStartedAt, setSpreadsheetTurnStartedAt] = useState<number | null>(null);
  const [spreadsheetOptimisticWorkingStartedAt, setSpreadsheetOptimisticWorkingStartedAt] =
    useState<number | null>(null);
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const [spreadsheetSidebarWidth, setSpreadsheetSidebarWidth] = useState(
    readPersistedSpreadsheetSidebarWidth,
  );
  const [isSpreadsheetResizing, setIsSpreadsheetResizing] = useState(false);
  useEffect(() => {
    if (!sideChat?.task?.id) return;
    setSpreadsheetArtifact(null);
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
  }, [sideChat?.task?.id]);
  const openSpreadsheetArtifact = useCallback((path: string) => {
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
    onRevealRightSidebar?.();
    setSpreadsheetArtifact({ kind: "spreadsheet", path, mode: "sidebar" });
  }, [onRevealRightSidebar]);
  const openDocumentArtifact = useCallback((path: string) => {
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
    onRevealRightSidebar?.();
    setSpreadsheetArtifact({ kind: "document", path, mode: "sidebar" });
  }, [onRevealRightSidebar]);
  const openPresentationArtifact = useCallback((path: string) => {
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
    onRevealRightSidebar?.();
    setSpreadsheetArtifact({ kind: "presentation", path, mode: "sidebar" });
  }, [onRevealRightSidebar]);
  const openWebArtifact = useCallback((path: string) => {
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
    onRevealRightSidebar?.();
    setSpreadsheetArtifact({ kind: "webpage", path, mode: "sidebar" });
  }, [onRevealRightSidebar]);
  const closeSpreadsheetArtifact = useCallback(() => {
    setSpreadsheetArtifact(null);
  }, []);
  const closeBrowserWorkbench = useCallback(() => {
    setBrowserWorkbench(null);
  }, []);
  const openSpawnedAgentSidebar = useCallback(
    (taskId: string) => {
      setSpreadsheetArtifact(null);
      setBrowserWorkbench(null);
      onRevealRightSidebar?.();
      setSpawnedAgentSidebar({ taskId });
    },
    [onRevealRightSidebar],
  );
  const closeSpawnedAgentSidebar = useCallback(() => {
    setSpawnedAgentSidebar(null);
  }, []);
  const selectSpawnedAgentSidebarTask = useCallback((taskId: string) => {
    setSpawnedAgentSidebar({ taskId });
  }, []);
  const showSpreadsheetFullscreen = useCallback(() => {
    setSpreadsheetArtifact((current) =>
      current ? { ...current, mode: "fullscreen" } : current,
    );
  }, []);
  const showSpreadsheetSidebar = useCallback(() => {
    setSpreadsheetArtifact((current) =>
      current ? { ...current, mode: "sidebar" } : current,
    );
  }, []);
  const showBrowserFullscreen = useCallback(() => {
    setBrowserWorkbench((current) =>
      current ? { ...current, mode: "fullscreen" } : current,
    );
  }, []);
  const showBrowserSidebar = useCallback(() => {
    setBrowserWorkbench((current) =>
      current ? { ...current, mode: "sidebar" } : current,
    );
  }, []);
  const updateBrowserWorkbenchStatus = useCallback((status: { url?: string }) => {
    setBrowserWorkbench((current) =>
      current ? { ...current, url: status.url ?? current.url } : current,
    );
  }, []);
  const openBrowserWorkbenchSidebar = useCallback(
    (request: { sessionId?: string; url?: string; requestId?: string }) => {
      setSpreadsheetArtifact(null);
      setSpawnedAgentSidebar(null);
      onRevealRightSidebar?.();
      const containerWidth =
        splitLayoutRef.current?.getBoundingClientRect().width || window.innerWidth;
      const maxWidth = Math.max(
        SPREADSHEET_SIDEBAR_MIN_WIDTH,
        containerWidth - SPREADSHEET_MAIN_MIN_WIDTH,
      );
      const preferredBrowserWidth = Math.max(
        SPREADSHEET_SIDEBAR_DEFAULT_WIDTH,
        containerWidth - 460,
      );
      setSpreadsheetSidebarWidth(
        Math.min(Math.max(preferredBrowserWidth, SPREADSHEET_SIDEBAR_MIN_WIDTH), maxWidth),
      );
      setBrowserWorkbench({
        sessionId: request.sessionId || "default",
        url: request.url,
        mode: "sidebar",
        requestId: request.requestId,
      });
    },
    [onRevealRightSidebar],
  );
  const openWebLinkInBrowserSidebar = useCallback(
    (url: string) => {
      openBrowserWorkbenchSidebar({
        sessionId: "link-preview",
        url,
        requestId: `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    },
    [openBrowserWorkbenchSidebar],
  );
  const openEmptyBrowserWorkbenchSidebar = useCallback(() => {
    openBrowserWorkbenchSidebar({
      sessionId: "default",
      requestId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }, [openBrowserWorkbenchSidebar]);
  const sendSpreadsheetFullscreenMessage = useCallback(
    async (message: string, images?: ImageAttachment[]) => {
      const startedAt = Date.now();
      setSpreadsheetTurnStartedAt(startedAt);
      setSpreadsheetOptimisticWorkingStartedAt(startedAt);
      await onSendMessage(message, images);
    },
    [onSendMessage],
  );
  useEffect(() => {
    setSpreadsheetArtifact(null);
    setBrowserWorkbench(null);
    setSpawnedAgentSidebar(null);
    setLastSettledArtifactRefreshKey(null);
    setSpreadsheetTurnStartedAt(null);
    setSpreadsheetOptimisticWorkingStartedAt(null);
  }, [selectedTaskId, workspace?.path]);
  useEffect(() => {
    if (!browserWorkbenchRequest || browserWorkbenchRequest.taskId !== selectedTaskId) return;
    openBrowserWorkbenchSidebar({
      sessionId: browserWorkbenchRequest.sessionId || "default",
      url: browserWorkbenchRequest.url,
      requestId: browserWorkbenchRequest.requestId,
    });
  }, [browserWorkbenchRequest, openBrowserWorkbenchSidebar, selectedTaskId]);
  useEffect(() => {
    if (!spawnedAgentSidebar) return;
    if (childTasks.some((childTask) => childTask.id === spawnedAgentSidebar.taskId)) return;
    setSpawnedAgentSidebar(null);
  }, [childTasks, spawnedAgentSidebar]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SPREADSHEET_SIDEBAR_WIDTH_STORAGE_KEY,
        String(Math.round(spreadsheetSidebarWidth)),
      );
    } catch {
      // Ignore storage failures; resizing should still work for the current session.
    }
  }, [spreadsheetSidebarWidth]);
  const clampSpreadsheetSidebarWidth = useCallback((width: number) => {
    const containerWidth =
      splitLayoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    const maxWidth = Math.max(
      SPREADSHEET_SIDEBAR_MIN_WIDTH,
      containerWidth - SPREADSHEET_MAIN_MIN_WIDTH,
    );
    return Math.min(Math.max(width, SPREADSHEET_SIDEBAR_MIN_WIDTH), maxWidth);
  }, []);
  useLayoutEffect(() => {
    if (
      !(
        (spreadsheetArtifact && spreadsheetArtifact.mode === "sidebar") ||
        (browserWorkbench && browserWorkbench.mode === "sidebar") ||
        spawnedAgentSidebar
      )
    ) {
      return;
    }
    setSpreadsheetSidebarWidth((current) => clampSpreadsheetSidebarWidth(current));
  }, [browserWorkbench, clampSpreadsheetSidebarWidth, spawnedAgentSidebar, spreadsheetArtifact]);
  useEffect(() => {
    if (!isSpreadsheetResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isSpreadsheetResizing]);
  const handleSpreadsheetResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = splitLayoutRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const maxWidth = Math.max(
        SPREADSHEET_SIDEBAR_MIN_WIDTH,
        rect.width - SPREADSHEET_MAIN_MIN_WIDTH,
      );
      const clampWidth = (width: number) =>
        Math.min(Math.max(width, SPREADSHEET_SIDEBAR_MIN_WIDTH), maxWidth);
      setIsSpreadsheetResizing(true);
      setSpreadsheetSidebarWidth(clampWidth(rect.right - event.clientX));

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setSpreadsheetSidebarWidth(clampWidth(rect.right - moveEvent.clientX));
      };
      let finished = false;
      const handlePointerUp = () => {
        if (finished) return;
        finished = true;
        setIsSpreadsheetResizing(false);
        resizeHandle.removeEventListener("lostpointercapture", handlePointerUp);
        if (resizeHandle.hasPointerCapture?.(pointerId)) {
          resizeHandle.releasePointerCapture?.(pointerId);
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
      resizeHandle.addEventListener("lostpointercapture", handlePointerUp);
    },
    [],
  );
  const handleSpreadsheetResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setSpreadsheetSidebarWidth((current) =>
        clampSpreadsheetSidebarWidth(current + (event.key === "ArrowLeft" ? 32 : -32)),
      );
    },
    [clampSpreadsheetSidebarWidth],
  );
  const spreadsheetEvents = replayControls.replayEvents;
  const spreadsheetHasActiveChildren = useMemo(
    () =>
      childTasks.some((childTask) =>
        childTask.status === "executing" ||
        childTask.status === "planning" ||
        childTask.status === "interrupted",
      ),
    [childTasks],
  );
  const isSpreadsheetTaskWorking = useMemo(
    () => isTaskActivelyWorking(task, spreadsheetEvents, spreadsheetHasActiveChildren),
    [task, spreadsheetEvents, spreadsheetHasActiveChildren],
  );
  useEffect(() => {
    if (!spreadsheetOptimisticWorkingStartedAt) return;
    const hasCompletionAfterFollowup = spreadsheetEvents.some(
      (event) =>
        event.timestamp >= spreadsheetOptimisticWorkingStartedAt &&
        getEffectiveTaskEventType(event) === "task_completed",
    );
    if (hasCompletionAfterFollowup) {
      setSpreadsheetOptimisticWorkingStartedAt(null);
    }
  }, [spreadsheetEvents, spreadsheetOptimisticWorkingStartedAt]);
  const isSpreadsheetFollowupWorking = spreadsheetOptimisticWorkingStartedAt !== null;
  const effectiveSpreadsheetTaskWorking = isSpreadsheetTaskWorking || isSpreadsheetFollowupWorking;
  const latestSpreadsheetUserMessageTimestamp = useMemo(
    () => findLatestUserMessageTimestamp(spreadsheetEvents, task?.id),
    [spreadsheetEvents, task?.id],
  );
  const activeSpreadsheetTurnStartedAt =
    spreadsheetTurnStartedAt ?? latestSpreadsheetUserMessageTimestamp;
  const spreadsheetWorkStartedAt = task
    ? (spreadsheetOptimisticWorkingStartedAt ?? activeSpreadsheetTurnStartedAt ?? task.createdAt)
    : Date.now();
  const spreadsheetWorkCompletedAt = spreadsheetOptimisticWorkingStartedAt
    ? undefined
    : isTerminalTaskStatus(task?.status)
    ? (task?.completedAt ?? task?.updatedAt)
    : task?.completedAt;
  const spreadsheetWorkDuration = useTaskDuration(
    spreadsheetWorkStartedAt,
    spreadsheetWorkCompletedAt,
    Boolean(task && effectiveSpreadsheetTaskWorking),
  );
  const spreadsheetTurnContext = useMemo(
    () =>
      spreadsheetArtifact
        ? buildSpreadsheetTurnContext({
            task,
            events: spreadsheetEvents,
            filePath: spreadsheetArtifact.path,
            isWorking: effectiveSpreadsheetTaskWorking,
            durationLabel: spreadsheetWorkDuration,
            turnStartedAt: activeSpreadsheetTurnStartedAt,
          })
        : null,
    [
      activeSpreadsheetTurnStartedAt,
      effectiveSpreadsheetTaskWorking,
      spreadsheetArtifact,
      spreadsheetEvents,
      spreadsheetWorkDuration,
      task,
    ],
  );
  const browserTurnContext = useMemo(
    () =>
      browserWorkbench
        ? buildSpreadsheetTurnContext({
            task,
            events: spreadsheetEvents,
            filePath: browserWorkbench.url || "browser workbench",
            isWorking: effectiveSpreadsheetTaskWorking,
            durationLabel: spreadsheetWorkDuration,
            turnStartedAt: activeSpreadsheetTurnStartedAt,
          })
        : null,
    [
      activeSpreadsheetTurnStartedAt,
      browserWorkbench,
      effectiveSpreadsheetTaskWorking,
      spreadsheetEvents,
      spreadsheetWorkDuration,
      task,
    ],
  );
  const computedArtifactRefreshKey = useMemo(() => {
    if (!spreadsheetArtifact) return null;
    let latestTimestamp = 0;
    const hasActiveTurn = activeSpreadsheetTurnStartedAt !== null;
    for (const event of spreadsheetEvents) {
      if (task?.id && event.taskId !== task.id) continue;
      if (hasActiveTurn && activeSpreadsheetTurnStartedAt !== null) {
        if (effectiveSpreadsheetTaskWorking && event.timestamp >= activeSpreadsheetTurnStartedAt) {
          continue;
        }
        if (!effectiveSpreadsheetTaskWorking && event.timestamp < activeSpreadsheetTurnStartedAt) {
          continue;
        }
      }
      const effectiveType = getEffectiveTaskEventType(event);
      const touchesArtifact =
        eventPathMatchesSpreadsheet(event, spreadsheetArtifact.path) ||
        effectiveType === "task_completed";
      if (!touchesArtifact) continue;
      latestTimestamp = Math.max(latestTimestamp, event.timestamp);
    }
    return latestTimestamp > 0 ? `${spreadsheetArtifact.path}:${latestTimestamp}` : null;
  }, [
    activeSpreadsheetTurnStartedAt,
    effectiveSpreadsheetTaskWorking,
    spreadsheetArtifact,
    spreadsheetEvents,
    task?.id,
  ]);
  useEffect(() => {
    if (!spreadsheetArtifact) {
      setLastSettledArtifactRefreshKey(null);
      return;
    }
    if (effectiveSpreadsheetTaskWorking) return;
    setLastSettledArtifactRefreshKey((current) => {
      if (
        current?.path === spreadsheetArtifact.path &&
        current.key === computedArtifactRefreshKey
      ) {
        return current;
      }
      return {
        path: spreadsheetArtifact.path,
        key: computedArtifactRefreshKey,
      };
    });
  }, [computedArtifactRefreshKey, effectiveSpreadsheetTaskWorking, spreadsheetArtifact]);
  const artifactRefreshKey =
    effectiveSpreadsheetTaskWorking
      ? lastSettledArtifactRefreshKey &&
        lastSettledArtifactRefreshKey.path === spreadsheetArtifact?.path
        ? lastSettledArtifactRefreshKey.key
        : null
      : computedArtifactRefreshKey;

  if (browserWorkbench?.mode === "fullscreen" && task) {
    const selectedModelLabel =
      availableModels.find((model) => model.key === selectedModel)?.displayName || selectedModel;
    return (
      <BrowserWorkbenchView
        taskId={task.id}
        sessionId={browserWorkbench.sessionId}
        initialUrl={browserWorkbench.url}
        workspaceId={workspace?.id}
        workspacePath={workspace?.path}
        mode="fullscreen"
        onClose={closeBrowserWorkbench}
        onFullscreen={showBrowserFullscreen}
        onExitFullscreen={showBrowserSidebar}
        onStatusChange={updateBrowserWorkbenchStatus}
        onSendMessage={sendSpreadsheetFullscreenMessage}
        selectedModelLabel={selectedModelLabel}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
        selectedReasoningEffort={selectedReasoningEffort}
        availableModels={availableModels}
        availableProviders={availableProviders}
        onModelChange={onModelChange}
        onOpenSettings={onOpenSettings}
        turnContext={browserTurnContext}
      />
    );
  }

  if (spreadsheetArtifact?.mode === "fullscreen" && workspace?.path) {
    const selectedModelLabel =
      availableModels.find((model) => model.key === selectedModel)?.displayName || selectedModel;
    if (spreadsheetArtifact.kind === "document") {
      return (
        <DocumentArtifactViewer
          filePath={spreadsheetArtifact.path}
          workspacePath={workspace.path}
          mode="fullscreen"
          onClose={closeSpreadsheetArtifact}
          onFullscreen={showSpreadsheetFullscreen}
          onExitFullscreen={showSpreadsheetSidebar}
          onSendMessage={sendSpreadsheetFullscreenMessage}
          selectedModelLabel={selectedModelLabel}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedReasoningEffort={selectedReasoningEffort}
          availableModels={availableModels}
          availableProviders={availableProviders}
          workspaceId={workspace.id}
          onModelChange={onModelChange}
          onOpenSettings={onOpenSettings}
          turnContext={spreadsheetTurnContext}
          refreshKey={artifactRefreshKey}
        />
      );
    }
    if (spreadsheetArtifact.kind === "presentation") {
      return (
        <PresentationArtifactViewer
          filePath={spreadsheetArtifact.path}
          workspacePath={workspace.path}
          mode="fullscreen"
          onClose={closeSpreadsheetArtifact}
          onFullscreen={showSpreadsheetFullscreen}
          onExitFullscreen={showSpreadsheetSidebar}
          onSendMessage={sendSpreadsheetFullscreenMessage}
          selectedModelLabel={selectedModelLabel}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedReasoningEffort={selectedReasoningEffort}
          availableModels={availableModels}
          availableProviders={availableProviders}
          workspaceId={workspace.id}
          onModelChange={onModelChange}
          onOpenSettings={onOpenSettings}
          turnContext={spreadsheetTurnContext}
          refreshKey={artifactRefreshKey}
        />
      );
    }
    if (spreadsheetArtifact.kind === "webpage") {
      return (
        <WebArtifactViewer
          filePath={spreadsheetArtifact.path}
          workspacePath={workspace.path}
          mode="fullscreen"
          onClose={closeSpreadsheetArtifact}
          onFullscreen={showSpreadsheetFullscreen}
          onExitFullscreen={showSpreadsheetSidebar}
          onSendMessage={sendSpreadsheetFullscreenMessage}
          selectedModelLabel={selectedModelLabel}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedReasoningEffort={selectedReasoningEffort}
          availableModels={availableModels}
          availableProviders={availableProviders}
          workspaceId={workspace.id}
          onModelChange={onModelChange}
          onOpenSettings={onOpenSettings}
          turnContext={spreadsheetTurnContext}
          refreshKey={artifactRefreshKey}
        />
      );
    }
    return (
      <SpreadsheetArtifactViewer
        filePath={spreadsheetArtifact.path}
        workspacePath={workspace.path}
        mode="fullscreen"
        onClose={closeSpreadsheetArtifact}
        onFullscreen={showSpreadsheetFullscreen}
        onExitFullscreen={showSpreadsheetSidebar}
        onSendMessage={sendSpreadsheetFullscreenMessage}
        selectedModelLabel={selectedModelLabel}
        selectedModel={selectedModel}
        selectedProvider={selectedProvider}
        selectedReasoningEffort={selectedReasoningEffort}
        availableModels={availableModels}
        availableProviders={availableProviders}
        workspaceId={workspace.id}
        onModelChange={onModelChange}
        onOpenSettings={onOpenSettings}
        turnContext={spreadsheetTurnContext}
      />
    );
  }

  const hasSpreadsheetSidebar =
    Boolean(
      (spreadsheetArtifact || browserWorkbench || spawnedAgentSidebar || sideChat) &&
        workspace?.path &&
        !remoteTaskView,
    );

  return (
    <div
      ref={splitLayoutRef}
      className={`selected-workspace-view ${hasSpreadsheetSidebar ? "has-spreadsheet-sidebar" : ""} ${
        isSpreadsheetResizing ? "is-resizing" : ""
      }`}
    >
      <div className="selected-workspace-main-row">
      <Suspense fallback={<TaskViewSkeleton />}>
        <MainContent
          task={task}
          selectedTaskId={selectedTaskId}
          workspace={workspace}
          events={replayControls.replayEvents}
          sharedTaskEventUi={replayControls.isReplayMode ? null : sharedTaskEventUi}
          replayControls={replayControls}
          childTasks={remoteTaskView ? [] : childTasks}
          childEvents={remoteTaskView ? [] : childEvents}
          onSelectChildTask={onSelectChildTask}
          onSelectTask={onSelectTask}
          onSendMessage={onSendMessage}
          onStartOnboarding={onStartOnboarding}
          onStartFreshSession={onStartFreshSession}
          onCreateTask={onCreateTask}
          onAskInbox={onAskInbox}
          onChangeWorkspace={onChangeWorkspace}
          onSelectWorkspace={onSelectWorkspace}
          onOpenSettings={onOpenSettings as Any}
          onStopTask={onStopTask}
          onEnableShellForPausedTask={onEnableShellForPausedTask}
          onContinueWithoutShellForPausedTask={onContinueWithoutShellForPausedTask}
          onWrapUpTask={onWrapUpTask}
          inputRequest={activeInputRequest}
          pendingInputRequests={pendingInputRequests}
          onSubmitInputRequest={onSubmitInputRequest}
          onDismissInputRequest={onDismissInputRequest}
          onOpenBrowserView={onOpenBrowserView}
          onViewTaskOutputs={onViewTaskOutputs}
          onTasksChanged={onTasksChanged}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedReasoningEffort={selectedReasoningEffort}
          availableModels={availableModels}
          onModelChange={onModelChange}
          availableProviders={availableProviders}
          uiDensity={uiDensity}
          homeResearchVaultEnabled={homeResearchVaultEnabled}
          homeNextActionsEnabled={homeNextActionsEnabled}
          rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
          taskSwitchId={taskSwitchId}
          hasMoreTimelineHistory={hasMoreTimelineHistory}
          isLoadingTimelineHistory={isLoadingTimelineHistory}
          timelineHistoryError={timelineHistoryError}
          onLoadMoreTimelineHistory={onLoadMoreTimelineHistory}
          onLoadTaskEventDetail={onLoadTaskEventDetail}
          remoteSession={
            remoteTaskView
              ? { deviceId: remoteTaskView.deviceId, deviceName: remoteTaskView.deviceName }
              : null
          }
          onOpenSpreadsheetArtifact={openSpreadsheetArtifact}
          onOpenDocumentArtifact={openDocumentArtifact}
          onOpenPresentationArtifact={openPresentationArtifact}
          onOpenWebArtifact={openWebArtifact}
          onOpenBrowserWorkbenchSidebar={
            task && workspace?.path && !remoteTaskView ? openEmptyBrowserWorkbenchSidebar : undefined
          }
          onOpenWebLinkInSidebar={
            task && workspace?.path && !remoteTaskView ? openWebLinkInBrowserSidebar : undefined
          }
          onOpenSideChat={onOpenSideChat}
          onOpenChildAgentSidebar={openSpawnedAgentSidebar}
        />
      </Suspense>
      {sideChat && workspace?.path && !remoteTaskView ? (
        <>
          <ResizableDividerHandle
            className="spreadsheet-sidebar-resize-handle"
            role="separator"
            orientation="vertical"
            aria-label="Resize side conversation"
            aria-valuemin={SPREADSHEET_SIDEBAR_MIN_WIDTH}
            aria-valuenow={Math.round(spreadsheetSidebarWidth)}
            tabIndex={0}
            onPointerDown={handleSpreadsheetResizePointerDown}
            onKeyDown={handleSpreadsheetResizeKeyDown}
          />
          <div
            className="spreadsheet-resizable-sidebar"
            style={{ width: `${spreadsheetSidebarWidth}px` }}
          >
            <Suspense fallback={<RightPanelFallback />}>
              <SideChatPanel
                parentTask={sideChat.parentTask}
                sideTask={sideChat.task}
                events={sideChat.events}
                loading={sideChat.loading}
                sending={sideChat.sending}
                onSendMessage={onSendSideChatMessage}
                onClose={onCloseSideChat}
                onOpenSideTask={onOpenSideChatFullThread}
              />
            </Suspense>
          </div>
        </>
      ) : (spreadsheetArtifact || browserWorkbench || spawnedAgentSidebar) &&
      workspace?.path &&
      !remoteTaskView ? (
        <>
          <ResizableDividerHandle
            className="spreadsheet-sidebar-resize-handle"
            role="separator"
            orientation="vertical"
            aria-label="Resize workbench sidebar"
            aria-valuemin={SPREADSHEET_SIDEBAR_MIN_WIDTH}
            aria-valuenow={Math.round(spreadsheetSidebarWidth)}
            tabIndex={0}
            onPointerDown={handleSpreadsheetResizePointerDown}
            onKeyDown={handleSpreadsheetResizeKeyDown}
          />
          <div
            className="spreadsheet-resizable-sidebar"
            style={{ width: `${spreadsheetSidebarWidth}px` }}
          >
            <Suspense fallback={<ArtifactSidebarFallback />}>
              {spawnedAgentSidebar && task ? (
                <SpawnedAgentSidebar
                  parentTask={task}
                  childTasks={childTasks}
                  childEvents={childEvents}
                  selectedTaskId={spawnedAgentSidebar.taskId}
                  workspace={workspace}
                  selectedModel={selectedModel}
                  selectedProvider={selectedProvider}
                  selectedReasoningEffort={selectedReasoningEffort}
                  availableModels={availableModels}
                  availableProviders={availableProviders}
                  uiDensity={uiDensity}
                  rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
                  inputRequest={activeInputRequest}
                  onSelectTask={selectSpawnedAgentSidebarTask}
                  onClose={closeSpawnedAgentSidebar}
                  onCancelTask={onCancelTaskById}
                  onTasksChanged={onTasksChanged}
                  onOpenSettings={onOpenSettings}
                  onModelChange={onModelChange}
                  onOpenSpreadsheetArtifact={openSpreadsheetArtifact}
                  onOpenDocumentArtifact={openDocumentArtifact}
                  onOpenPresentationArtifact={openPresentationArtifact}
                  onOpenWebArtifact={openWebArtifact}
                />
              ) : browserWorkbench && task ? (
                <BrowserWorkbenchView
                  key={browserWorkbench.requestId || browserWorkbench.sessionId}
                  taskId={task.id}
                  sessionId={browserWorkbench.sessionId}
                  initialUrl={browserWorkbench.url}
                  workspaceId={workspace.id}
                  workspacePath={workspace.path}
                  mode="sidebar"
                  onClose={closeBrowserWorkbench}
                  onFullscreen={showBrowserFullscreen}
                  onExitFullscreen={showBrowserSidebar}
                  onStatusChange={updateBrowserWorkbenchStatus}
                  onSendMessage={sendSpreadsheetFullscreenMessage}
                />
              ) : spreadsheetArtifact?.kind === "document" ? (
                <DocumentArtifactViewer
                  filePath={spreadsheetArtifact.path}
                  workspacePath={workspace.path}
                  mode="sidebar"
                  onClose={closeSpreadsheetArtifact}
                  onFullscreen={showSpreadsheetFullscreen}
                  onExitFullscreen={showSpreadsheetSidebar}
                  refreshKey={artifactRefreshKey}
                />
              ) : spreadsheetArtifact?.kind === "presentation" ? (
                <PresentationArtifactViewer
                  filePath={spreadsheetArtifact.path}
                  workspacePath={workspace.path}
                  mode="sidebar"
                  onClose={closeSpreadsheetArtifact}
                  onFullscreen={showSpreadsheetFullscreen}
                  onExitFullscreen={showSpreadsheetSidebar}
                  refreshKey={artifactRefreshKey}
                />
              ) : spreadsheetArtifact?.kind === "webpage" ? (
                <WebArtifactViewer
                  filePath={spreadsheetArtifact.path}
                  workspacePath={workspace.path}
                  mode="sidebar"
                  onClose={closeSpreadsheetArtifact}
                  onFullscreen={showSpreadsheetFullscreen}
                  onExitFullscreen={showSpreadsheetSidebar}
                  refreshKey={artifactRefreshKey}
                />
              ) : (
                spreadsheetArtifact ? <SpreadsheetArtifactViewer
                  filePath={spreadsheetArtifact.path}
                  workspacePath={workspace.path}
                  mode="sidebar"
                  onClose={closeSpreadsheetArtifact}
                  onFullscreen={showSpreadsheetFullscreen}
                  onExitFullscreen={showSpreadsheetSidebar}
                /> : null
              )}
            </Suspense>
          </div>
        </>
      ) : !effectiveRightCollapsed && !remoteTaskView ? (
        <Suspense fallback={<RightPanelFallback />}>
          <RightPanel
            task={rightPanelInput.task}
            workspace={rightPanelInput.workspace}
            events={rightPanelInput.events}
            sharedTaskEventUi={rightPanelInput.sharedTaskEventUi}
            hasActiveChildren={rightPanelInput.hasActiveChildren}
            childTasks={rightPanelInput.childTasks}
            childEvents={rightPanelInput.childEvents}
            runningTasks={rightPanelInput.runningTasks}
            queuedTasks={rightPanelInput.queuedTasks}
            queueStatus={rightPanelInput.queueStatus}
            onSelectTask={onSelectTask}
            onCancelTask={onCancelTaskById}
            onOpenSpreadsheetArtifact={openSpreadsheetArtifact}
            onOpenDocumentArtifact={openDocumentArtifact}
            onOpenPresentationArtifact={openPresentationArtifact}
            onOpenWebArtifact={openWebArtifact}
            rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
            highlightOutputPath={rightPanelInput.highlightOutputPath}
            onHighlightConsumed={onHighlightConsumed}
          />
        </Suspense>
      ) : null}
      </div>
      {!remoteTaskView && terminalTabsOpen && (
        <Suspense fallback={null}>
          <TerminalTabsDock
            workspace={workspace}
            taskId={task?.id ?? selectedTaskId ?? null}
            onClose={onCloseTerminalTabs}
          />
        </Suspense>
      )}
    </div>
  );
}, (prev, next) =>
  getAppTaskSignature(prev.task) === getAppTaskSignature(next.task) &&
  prev.selectedTaskId === next.selectedTaskId &&
  prev.workspace?.path === next.workspace?.path &&
  prev.replayControls === next.replayControls &&
  prev.sharedTaskEventUi === next.sharedTaskEventUi &&
  prev.remoteTaskView?.deviceId === next.remoteTaskView?.deviceId &&
  prev.remoteTaskView?.task.id === next.remoteTaskView?.task.id &&
  prev.remoteTaskView?.events === next.remoteTaskView?.events &&
  prev.childTasks === next.childTasks &&
  prev.childEvents === next.childEvents &&
  getInputRequestSignature(prev.activeInputRequest) === getInputRequestSignature(next.activeInputRequest) &&
  getInputRequestsSignature(prev.pendingInputRequests) ===
    getInputRequestsSignature(next.pendingInputRequests) &&
  prev.selectedModel === next.selectedModel &&
  prev.selectedProvider === next.selectedProvider &&
  prev.selectedReasoningEffort === next.selectedReasoningEffort &&
  prev.availableModels === next.availableModels &&
  prev.availableProviders === next.availableProviders &&
  prev.uiDensity === next.uiDensity &&
  prev.homeResearchVaultEnabled === next.homeResearchVaultEnabled &&
  prev.homeNextActionsEnabled === next.homeNextActionsEnabled &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
  prev.effectiveRightCollapsed === next.effectiveRightCollapsed &&
  prev.terminalTabsOpen === next.terminalTabsOpen &&
  prev.browserWorkbenchRequest?.requestId === next.browserWorkbenchRequest?.requestId &&
  prev.sideChat === next.sideChat &&
  prev.rightPanelInput === next.rightPanelInput
);

const MAX_RENDERER_CHILD_EVENTS = 300;
const MAX_TIMELINE_HISTORY_EVENTS = 1200;
const MAX_TIMELINE_HISTORY_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_TIMELINE_HISTORY_PAGE_PAYLOAD_BYTES = 512 * 1024;
const MAX_EVENT_DETAIL_CACHE_ENTRIES = 120;
const EVENT_DETAIL_NEGATIVE_CACHE_MS = 30 * 1000;
const APPROVAL_TOAST_PREFIX = "approval-request-";
const RENDERER_DROPPED_EVENT_TYPES = new Set(["log", "task_analysis"]);
const RENDERER_THROTTLED_EVENT_TYPES = new Set(["llm_streaming"]);
const RENDERER_NOISE_THROTTLE_MS = 120;
/** Tool-heavy events batched to avoid UI freeze/re-render storms (OpenClaw-style fix) */
const EVENT_TYPES_BATCHABLE = new Set([
  "tool_call",
  "tool_result",
  "progress_update",
  "timeline_step_updated",
  "timeline_step_finished",
  "executing",
  "llm_streaming",
]);
/** Milestone events flush the batch and append immediately */
const EVENT_TYPES_MILESTONE = new Set([
  "assistant_message",
  "user_message",
  "task_completed",
  "task_cancelled",
  "error",
  "timeline_group_finished",
  "approval_requested",
  "input_request_created",
  "plan_created",
  "step_started",
  "step_completed",
  "step_failed",
]);
const EVENT_BATCH_FLUSH_INTERVAL_MS = 100;
const EVENT_BATCH_BURST_WINDOW_MS = 160;
const EVENT_BATCH_MAX_WAIT_MS = 250;
const EVENT_BATCH_MAX_EVENTS = 32;
const STALE_TASK_RECONCILE_INTERVAL_MS = 15_000;
const STALE_TASK_RECONCILE_IDLE_WINDOW_MS = 12_000;

type PendingToolEventEntry = {
  event: TaskEvent;
  queuedAtMs: number;
};

function isTaskPossiblyRunning(status: Task["status"] | undefined): boolean {
  return status === "planning" || status === "executing" || status === "interrupted";
}

function isTerminalTaskStatus(status: Task["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getLatestEventTimestamp(events: TaskEvent[]): number {
  let latest = 0;
  for (const event of events) {
    if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
      latest = Math.max(latest, event.timestamp);
    }
  }
  return latest;
}

function isImmediateTaskAttentionEvent(event: TaskEvent): boolean {
  return (
    (event.type === "task_paused" &&
      isNotificationWorthyPauseReason(
        typeof event.payload?.reason === "string" ? event.payload.reason : undefined,
      )) ||
    event.type === "approval_requested" ||
    event.type === "input_request_created"
  );
}

function isShellPermissionPauseReason(reasonCode: string | null | undefined): boolean {
  return reasonCode === "shell_permission_required" || reasonCode === "shell_permission_still_disabled";
}

function isNotificationWorthyPauseReason(reasonCode: string | null | undefined): boolean {
  return (
    reasonCode === "shell_permission_required" ||
    reasonCode === "shell_permission_still_disabled" ||
    reasonCode === "skill_parameters" ||
    reasonCode === "missing_required_workspace_artifact" ||
    reasonCode === "user_action_required_failure" ||
    reasonCode === "user_action_required_tool"
  );
}

function mergeUniqueTaskEvents(existing: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  return mergeTaskEventsByIdentity(existing, incoming);
}

function getApprovalToastId(approvalId: string): string {
  return `${APPROVAL_TOAST_PREFIX}${approvalId}`;
}

function describeApprovalPersistence(
  payload: Any,
  approved: boolean,
): { type: "info" | "warning"; message: string } | null {
  const persistence = payload?.persistence as
    | {
        effect?: "allow" | "deny";
        destination?: "session" | "workspace" | "profile";
        dbPersisted?: boolean;
        manifestPersisted?: boolean;
        manifestError?: string;
      }
    | undefined;
  const action = typeof payload?.action === "string" ? (payload.action as ApprovalResponseAction) : "";

  if (!persistence && !action) return null;

  const actionLabel = action
    ? action.replace(/_/g, " ")
    : approved
      ? "allow once"
      : "deny once";
  if (!persistence?.destination) {
    return {
      type: approved ? "info" : "warning",
      message: `Approval handled with ${actionLabel}.`,
    };
  }

  if (persistence.destination === "workspace") {
    if (persistence.manifestPersisted === false && persistence.manifestError) {
      return {
        type: "warning",
        message:
          `Workspace rule saved to the local database, but manifest write failed: ${persistence.manifestError}`,
      };
    }
    if (persistence.dbPersisted && persistence.manifestPersisted) {
      return {
        type: "info",
        message: "Workspace rule saved to both the local database and the workspace manifest.",
      };
    }
    if (persistence.dbPersisted) {
      return {
        type: "warning",
        message: "Workspace rule saved to the local database.",
      };
    }
  }

  if (persistence.destination === "profile") {
    return {
      type: "info",
      message: `Profile rule saved for future approvals via ${actionLabel}.`,
    };
  }

  if (persistence.destination === "session") {
    return {
      type: "info",
      message: `Session-only rule saved via ${actionLabel}.`,
    };
  }

  return {
    type: approved ? "info" : "warning",
    message: `Approval handled with ${actionLabel}.`,
  };
}

function pickFirstPendingGenericApproval(
  pending: Map<string, ApprovalRequest>,
): ApprovalRequest | null {
  for (const [, a] of pending) {
    if (!isComputerUseAppGrantApproval(a)) return a;
  }
  return null;
}

function pickFirstPendingComputerUseApproval(
  pending: Map<string, ApprovalRequest>,
): ApprovalRequest | null {
  for (const [, a] of pending) {
    if (isComputerUseAppGrantApproval(a)) return a;
  }
  return null;
}

function extractApprovalId(event: TaskEvent): string | null {
  const direct = event.payload?.approvalId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = event.payload?.approval?.id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

function extractInputRequestId(event: TaskEvent): string | null {
  const direct = event.payload?.requestId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = event.payload?.request?.id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

export function App() {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hasMoreTasks, setHasMoreTasks] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [remoteTaskView, setRemoteTaskView] = useState<RemoteTaskView | null>(null);
  const [currentView, setCurrentView] = useState<AppView>("main");
  const [inboxAgentAskRequest, setInboxAgentAskRequest] = useState<{
    id: number;
    query: string;
  } | null>(null);
  const [missionControlInitialCompanyId, setMissionControlInitialCompanyId] = useState<string | null>(
    null,
  );
  const [missionControlInitialIssueId, setMissionControlInitialIssueId] = useState<string | null>(null);
  const [missionControlEverydayAgentFocus, setMissionControlEverydayAgentFocus] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string>("");
  const [browserWorkbenchRequest, setBrowserWorkbenchRequest] =
    useState<BrowserWorkbenchOpenRequest | null>(null);
  const [sideChat, setSideChat] = useState<SideChatState | null>(null);
  const [settingsTab, setSettingsTab] = useState<
    | "appearance"
    | "llm"
    | "image"
    | "search"
    | "telegram"
    | "slack"
    | "whatsapp"
    | "teams"
    | "x"
    | "morechannels"
    | "integrations"
    | "updates"
    | "system"
    | "queue"
    | "skills"
    | "scheduled"
    | "voice"
    | "companies"
    | "digitaltwins"
    | "mcp"
    | "triggers"
    | "subconscious"
    | "health"
    | "suggestions"
    | "traces"
    | "everydayAgent"
  >("appearance");
  const [homeAutomationFocusTick, setHomeAutomationFocusTick] = useState(0);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [childEvents, setChildEvents] = useState<TaskEvent[]>([]);

  // Child tasks dispatched from the selected parent task (for DispatchedAgentsPanel)
  const childTasks = useMemo(() => {
    if (!selectedTaskId) return [];
    return tasks.filter((t) => t.parentTaskId === selectedTaskId && t.agentType === "sub");
  }, [tasks, selectedTaskId]);
  const selectedTask = useMemo(
    () => remoteTaskView?.task || (selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined),
    [remoteTaskView, tasks, selectedTaskId],
  );
  const completedTaskIdsSignature = useMemo(
    () =>
      tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.id)
        .join("|"),
    [tasks],
  );

  const childTaskIdsRef = useRef<Set<string>>(new Set());
  // Buffer for child events that arrive before childTaskIdsRef is populated (race condition fix)
  const pendingChildEventsRef = useRef<TaskEvent[]>([]);
  useEffect(() => {
    const newIds = new Set(childTasks.map((t) => t.id));
    childTaskIdsRef.current = newIds;
    // Flush any buffered events that now match known child task IDs
    if (pendingChildEventsRef.current.length > 0 && newIds.size > 0) {
      const matched = pendingChildEventsRef.current.filter((e) => newIds.has(e.taskId));
      pendingChildEventsRef.current = pendingChildEventsRef.current.filter((e) => !newIds.has(e.taskId));
      if (matched.length > 0) {
        setChildEvents((prev) => capTaskEvents(mergeUniqueTaskEvents(prev, matched), MAX_RENDERER_CHILD_EVENTS));
      }
    }
  }, [childTasks]);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<string>("opus-4-5");
  const [selectedProvider, setSelectedProvider] =
    useState<LLMProviderType>("anthropic");
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<LLMReasoningEffort | undefined>(undefined);
  const [sessionModelOverride, setSessionModelOverride] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<LLMModelInfo[]>([]);
  const [availableProviders, setAvailableProviders] = useState<LLMProviderInfo[]>([]);

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  // Theme state (loaded from main process on mount)
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [visualTheme, setVisualTheme] = useState<VisualTheme>("warm");
  const [accentColor, setAccentColor] = useState<AccentColor>("cyan");
  const [transparencyEffectsEnabled, setTransparencyEffectsEnabled] = useState(true);
  const [uiDensity, setUiDensity] = useState<UiDensity>("focused");
  const [devRunLoggingEnabled, setDevRunLoggingEnabled] = useState(false);
  const [selectedTaskSwitchId, setSelectedTaskSwitchId] = useState<string | null>(null);
  const [selectedTaskTimelineHistory, setSelectedTaskTimelineHistory] = useState<{
    cursor: TaskTimelinePageCursor | null;
    hasMoreHistory: boolean;
    isLoadingMore: boolean;
    error: string | null;
  }>({
    cursor: null,
    hasMoreHistory: false,
    isLoadingMore: false,
    error: null,
  });
  const [homeResearchVaultEnabled, setHomeResearchVaultEnabled] = useState(false);
  const [homeNextActionsEnabled, setHomeNextActionsEnabled] = useState(false);

  // Queue state
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [sessionAutoApproveAll, setSessionAutoApproveAll] = useState(false);
  const [pendingInputRequests, setPendingInputRequests] = useState<InputRequest[]>([]);
  const [computerUseAppGrantApproval, setComputerUseAppGrantApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const [genericApproval, setGenericApproval] = useState<ApprovalRequest | null>(null);
  const [approveAllSessionWarningOpen, setApproveAllSessionWarningOpen] = useState(false);
  const [unseenOutputTaskIds, setUnseenOutputTaskIds] = useState<string[]>([]);
  const [unseenCompletedTaskIds, setUnseenCompletedTaskIds] = useState<string[]>([]);
  const [isInitialTaskListLoading, setIsInitialTaskListLoading] = useState(true);
  const [isLoadingMoreTasks, setIsLoadingMoreTasks] = useState(false);
  const [rightPanelHighlight, setRightPanelHighlight] = useState<{
    taskId: string;
    path: string;
  } | null>(null);

  useEffect(() => {
    if (currentView !== "missionControl") {
      setMissionControlInitialIssueId(null);
    }
  }, [currentView]);

  // Sidebar collapse state
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [terminalTabsOpen, setTerminalTabsOpen] = useState(false);
  const handleCloseTerminalTabs = useCallback(() => {
    setTerminalTabsOpen(false);
  }, []);

  // Ref to track current tasks for use in event handlers (avoids stale closure)
  const tasksRef = useRef<Task[]>([]);
  const sessionAutoApproveAllRef = useRef(false);
  /** While true, `handleApprovalResponse` does not advance modal state (bulk auto-approve). */
  const bulkApproveSilentRef = useRef(false);
  const pendingApprovalsRef = useRef<Map<string, ApprovalRequest>>(new Map());
  const pendingInputRequestsRef = useRef<Map<string, InputRequest>>(new Map());
  const eventsRef = useRef<TaskEvent[]>([]);
  const sideChatRef = useRef<SideChatState | null>(null);
  const sideChatRequestSeqRef = useRef(0);
  const selectedTaskIdRef = useRef<string | null>(null);
  const fetchedFullTaskForMentionMetadataRef = useRef<Set<string>>(new Set());
  const currentViewRef = useRef<AppView>("main");
  const rightSidebarCollapsedRef = useRef(false);
  const currentWorkspaceRef = useRef<Workspace | null>(null);
  const noiseEventThrottleRef = useRef<Map<string, number>>(new Map());
  const taskLastEventTimestampRef = useRef<Map<string, number>>(new Map());
  const staleTaskReconcileInFlightRef = useRef(false);
  const pendingToolEventsRef = useRef<PendingToolEventEntry[]>([]);
  const pendingToolEventsFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolEventsForceFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBatchableAppendAtRef = useRef(0);
  const terminalEventRefreshInFlightRef = useRef<Set<string>>(new Set());
  const latestAttentionEventByTaskIdRef = useRef<Map<string, TaskEvent>>(new Map());
  const taskSwitchStartedAtRef = useRef<Map<string, number>>(new Map());
  const taskSwitchIdByTaskIdRef = useRef<Map<string, string>>(new Map());
  const taskSwitchSequenceRef = useRef(0);
  const taskHeaderMarkedRef = useRef<Set<string>>(new Set());
  const sidebarFirstPaintMarkedRef = useRef(false);
  const taskTimelinePageStateRef = useRef<
    Map<string, { cursor: TaskTimelinePageCursor | null; hasMoreHistory: boolean }>
  >(new Map());
  const eventDetailInFlightRef = useRef<Set<string>>(new Set());
  const eventDetailCacheRef = useRef<Map<string, TaskEvent>>(new Map());
  const eventDetailMissingUntilRef = useRef<Map<string, number>>(new Map());
  const timelineHistoryLoadInFlightRef = useRef(false);
  const selectedTaskHydrationInFlightRef = useRef<Set<string>>(new Set());
  const selectedTaskHydrationAttemptedRef = useRef<Set<string>>(new Set());
  /** Tracks output paths we've already shown completion toast for (suppresses repeat toasts on follow-ups) */
  const completionToastNotifiedPathsRef = useRef<Map<string, Set<string>>>(new Map());

  // Purge stale entries from growing Map refs when the task list changes
  useEffect(() => {
    const activeIds = new Set(tasks.map(t => t.id));
    for (const key of latestAttentionEventByTaskIdRef.current.keys()) {
      if (!activeIds.has(key)) latestAttentionEventByTaskIdRef.current.delete(key);
    }
    for (const key of taskLastEventTimestampRef.current.keys()) {
      if (!activeIds.has(key)) taskLastEventTimestampRef.current.delete(key);
    }
    for (const key of completionToastNotifiedPathsRef.current.keys()) {
      if (!activeIds.has(key)) completionToastNotifiedPathsRef.current.delete(key);
    }
    for (const key of taskSwitchStartedAtRef.current.keys()) {
      if (!activeIds.has(key)) taskSwitchStartedAtRef.current.delete(key);
    }
    for (const key of taskSwitchIdByTaskIdRef.current.keys()) {
      if (!activeIds.has(key)) taskSwitchIdByTaskIdRef.current.delete(key);
    }
    for (const key of taskTimelinePageStateRef.current.keys()) {
      if (!activeIds.has(key)) taskTimelinePageStateRef.current.delete(key);
    }
    pruneTaskHydrationAttemptKeys(selectedTaskHydrationAttemptedRef.current, activeIds);
  }, [tasks]);

  // Disclaimer state (null = loading)
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean | null>(null);
  // Onboarding state (null = loading)
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  // Timestamp of when onboarding was completed
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | undefined>(undefined);
  const hasElectronAPI = typeof window !== "undefined" && !!window.electronAPI;
  const [devLogCaptureEnabled, setDevLogCaptureEnabled] = useState(false);
  const rendererPerfLoggingEnabled = devRunLoggingEnabled || devLogCaptureEnabled;
  const startupMarksRef = useRef<Set<string>>(new Set());

  recordRendererRender("App", `view:${currentView}`, rendererPerfLoggingEnabled);

  const markStartupOnce = useCallback(
    (name: string, details?: Record<string, unknown>) => {
      if (startupMarksRef.current.has(name)) return;
      startupMarksRef.current.add(name);
      markRendererStartup(name, rendererPerfLoggingEnabled, details);
    },
    [rendererPerfLoggingEnabled],
  );

  const markTaskSwitchStart = useCallback(
    (taskId: string | null) => {
      if (!taskId) return;
      const startedAt = performance.now();
      const switchId = `${taskId}:${Date.now()}:${taskSwitchSequenceRef.current++}`;
      taskSwitchStartedAtRef.current.set(taskId, startedAt);
      taskSwitchIdByTaskIdRef.current.set(taskId, switchId);
      setSelectedTaskSwitchId(switchId);
      taskHeaderMarkedRef.current.delete(taskId);
      markRendererPerfEvent("task_switch_start", rendererPerfLoggingEnabled, {
        taskId,
        switchId,
      });
    },
    [rendererPerfLoggingEnabled],
  );

  const mergeSelectedTaskTimelineEvents = useCallback(
    (taskId: string, existing: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] => {
      const incomingIdentities = new Set(incoming.map((event) => getTaskEventIdentity(event)));
      const relevantExisting = existing.filter((event) =>
        incomingIdentities.has(getTaskEventIdentity(event)) ||
        shouldIncludeTaskEventInSelectedSession({
          selectedTaskId: taskId,
          event,
          tasks: tasksRef.current,
        }),
      );
      return mergeTaskEventsByIdentity(relevantExisting, incoming);
    },
    [],
  );

  const capTaskEventsPreservingIncoming = useCallback(
    (eventsToCap: TaskEvent[], incomingEvents: TaskEvent[]): TaskEvent[] => {
      const capped = capTaskEvents(
        eventsToCap,
        MAX_TIMELINE_HISTORY_EVENTS,
        MAX_TIMELINE_HISTORY_PAYLOAD_BYTES,
      );
      if (incomingEvents.length === 0) return capped;

      const incomingIds = new Set(incomingEvents.map((event) => getTaskEventIdentity(event)));
      const cappedIds = new Set(capped.map((event) => getTaskEventIdentity(event)));
      const missingIncoming = incomingEvents.filter(
        (event) => !cappedIds.has(getTaskEventIdentity(event)),
      );
      if (missingIncoming.length === 0) return capped;

      const preservedIncoming = capTaskEvents(
        incomingEvents,
        Math.min(incomingEvents.length, MAX_TIMELINE_HISTORY_EVENTS),
        MAX_TIMELINE_HISTORY_PAGE_PAYLOAD_BYTES,
      );
      const preservedIncomingIds = new Set(
        preservedIncoming.map((event) => getTaskEventIdentity(event)),
      );
      const nonIncomingBudget = Math.max(0, MAX_TIMELINE_HISTORY_EVENTS - preservedIncoming.length);
      const nonIncoming =
        nonIncomingBudget > 0
          ? capTaskEvents(
              capped.filter((event) => !incomingIds.has(getTaskEventIdentity(event))),
              nonIncomingBudget,
              Math.max(
                MAX_TIMELINE_HISTORY_PAGE_PAYLOAD_BYTES,
                MAX_TIMELINE_HISTORY_PAYLOAD_BYTES - MAX_TIMELINE_HISTORY_PAGE_PAYLOAD_BYTES,
              ),
            )
              .filter((event) => !preservedIncomingIds.has(getTaskEventIdentity(event)))
              .slice(-nonIncomingBudget)
          : [];

      return mergeTaskEventsByIdentity(preservedIncoming, nonIncoming);
    },
    [],
  );

  useEffect(() => {
    markStartupOnce("app_shell_ready", { view: currentView });
  }, [currentView, markStartupOnce]);

  useEffect(() => {
    if (!leftSidebarCollapsed && !isInitialTaskListLoading) {
      markStartupOnce("sidebar_ready", { taskCount: tasks.length });
    }
  }, [isInitialTaskListLoading, leftSidebarCollapsed, markStartupOnce, tasks.length]);

  useEffect(() => {
    if (
      sidebarFirstPaintMarkedRef.current ||
      leftSidebarCollapsed ||
      isInitialTaskListLoading ||
      tasks.length === 0
    ) {
      return;
    }
    sidebarFirstPaintMarkedRef.current = true;
    markRendererPerfEvent("sidebar_first_paint", rendererPerfLoggingEnabled, {
      taskCount: tasks.length,
    });
  }, [isInitialTaskListLoading, leftSidebarCollapsed, rendererPerfLoggingEnabled, tasks.length]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTask || taskHeaderMarkedRef.current.has(selectedTaskId)) {
      return;
    }
    taskHeaderMarkedRef.current.add(selectedTaskId);
    const startedAt = taskSwitchStartedAtRef.current.get(selectedTaskId);
    if (startedAt != null) {
      recordRendererPerfSample(
        "task-switch.header_ready_ms",
        performance.now() - startedAt,
        rendererPerfLoggingEnabled,
      );
    }
    markRendererPerfEvent("task_header_ready", rendererPerfLoggingEnabled, {
      taskId: selectedTaskId,
      switchId: taskSwitchIdByTaskIdRef.current.get(selectedTaskId),
      taskStatus: selectedTask.status,
    });
  }, [rendererPerfLoggingEnabled, selectedTask, selectedTaskId]);

  useEffect(() => {
    flushRendererStartupMarks(rendererPerfLoggingEnabled);
  }, [rendererPerfLoggingEnabled]);

  useEffect(() => {
    if (!hasElectronAPI) {
      setDevLogCaptureEnabled(false);
      return;
    }

    let cancelled = false;
    void window.electronAPI
      .getAppearanceRuntimeInfo?.()
      .then((runtimeInfo) => {
        if (!cancelled) {
          setDevLogCaptureEnabled(runtimeInfo?.devLogCaptureEnabled === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDevLogCaptureEnabled(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasElectronAPI]);

  const reconcileTaskFromCanonical = useCallback(
    async (taskId: string, options?: { refreshEventsWhenTerminal?: boolean }) => {
      if (!window.electronAPI?.getTask) return null;
      try {
        const canonicalTask = (await window.electronAPI.getTask(taskId)) as Task | null;
        if (!canonicalTask) return null;

        setTasks((prev) => upsertTaskPreservingIdentity(prev, canonicalTask, { prependIfMissing: true }));

        if (
          options?.refreshEventsWhenTerminal &&
          !isTaskPossiblyRunning(canonicalTask.status) &&
          (window.electronAPI?.getTaskTimelinePage || window.electronAPI?.getTaskEvents)
        ) {
          const timelinePage = window.electronAPI.getTaskTimelinePage
            ? await window.electronAPI.getTaskTimelinePage({
                taskId,
                limit: 160,
                byteLimit: 512 * 1024,
                singleEventByteLimit: 64 * 1024,
              })
            : null;
          const refreshedEvents =
            timelinePage?.events ?? (await window.electronAPI.getTaskEvents(taskId));
          if (timelinePage) {
            taskTimelinePageStateRef.current.set(taskId, {
              cursor: timelinePage.nextCursor,
              hasMoreHistory: timelinePage.hasMoreHistory,
            });
            if (taskId === selectedTaskIdRef.current) {
              setSelectedTaskTimelineHistory({
                cursor: timelinePage.nextCursor,
                hasMoreHistory: timelinePage.hasMoreHistory,
                isLoadingMore: false,
                error: null,
              });
            }
          }
          pendingToolEventsRef.current = [];
          if (pendingToolEventsFlushTimerRef.current) {
            clearTimeout(pendingToolEventsFlushTimerRef.current);
            pendingToolEventsFlushTimerRef.current = null;
          }
          setEvents((prev) =>
            capTaskEvents(mergeSelectedTaskTimelineEvents(taskId, prev, refreshedEvents)),
          );
          const latestTimestamp = getLatestEventTimestamp(refreshedEvents);
          taskLastEventTimestampRef.current.set(
            taskId,
            latestTimestamp > 0 ? latestTimestamp : Date.now(),
          );
        }

        return canonicalTask;
      } finally {
        terminalEventRefreshInFlightRef.current.delete(taskId);
      }
    },
    [mergeSelectedTaskTimelineEvents],
  );

  // Platform detection for Windows-specific UI (custom window controls, opaque backgrounds)
  const isWindows = hasElectronAPI && window.electronAPI.getPlatform() === "win32";
  useEffect(() => {
    document.documentElement.classList.toggle("platform-darwin", hasElectronAPI && window.electronAPI.getPlatform() === "darwin");
    if (isWindows) {
      document.documentElement.classList.add("platform-win32");
      return;
    }
    document.documentElement.classList.remove("platform-win32");
  }, [isWindows]);

  useEffect(() => {
    const root = document.documentElement;
    let cancelled = false;

    if (!hasElectronAPI || window.electronAPI.getPlatform() !== "darwin") {
      root.classList.remove("opaque-vibrancy");
      return;
    }

    void window.electronAPI
      .getAppearanceRuntimeInfo?.()
      .then((runtimeInfo) => {
        if (cancelled) return;
        root.classList.toggle(
          "opaque-vibrancy",
          runtimeInfo?.prefersReducedTransparency === true || !transparencyEffectsEnabled,
        );
      })
      .catch(() => {
        if (!cancelled) {
          root.classList.toggle("opaque-vibrancy", !transparencyEffectsEnabled);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasElectronAPI, transparencyEffectsEnabled]);

  const handleDisclaimerAccept = (dontShowAgain: boolean) => {
    // Save to main process for persistence
    window.electronAPI
      ?.saveAppearanceSettings?.({ disclaimerAccepted: dontShowAgain })
      ?.catch((error) => {
        console.error("Failed to save disclaimer setting:", error);
      });
    setDisclaimerAccepted(true);
  };

  const handleOnboardingComplete = (dontShowAgain: boolean) => {
    const timestamp = new Date().toISOString();
    // Save to main process for persistence
    // If dontShowAgain is true, mark as completed with timestamp
    // If false, just save the timestamp but don't mark as completed (user can see it again next time)
    window.electronAPI
      ?.saveAppearanceSettings?.({
        onboardingCompleted: dontShowAgain,
        onboardingCompletedAt: timestamp,
      })
      ?.catch((error) => {
        console.error("Failed to save onboarding state:", error);
      });
    setOnboardingCompleted(true); // Always allow proceeding to main app
    setOnboardingCompletedAt(timestamp);

    // Sync any onboarding-time appearance changes (e.g. light/dark toggle)
    window.electronAPI
      ?.getAppearanceSettings?.()
      .then((settings) => {
        if (!settings) return;
        setThemeMode(settings.themeMode);
        setVisualTheme(settings.visualTheme || "warm");
        setAccentColor(settings.accentColor);
      })
      .catch((error) => {
        console.error("Failed to refresh appearance settings after onboarding:", error);
      });

    // Refresh LLM config after onboarding (user may have configured a provider)
    loadLLMConfig();
  };

  const handleOpenBrowserView = (url?: string) => {
    setBrowserUrl(url || "");
    setCurrentView("browser");
  };
  const handleRevealRightSidebar = useCallback(() => {
    setRightSidebarCollapsed(false);
  }, []);

  const handleShowOnboarding = () => {
    // Reset onboarding state to show the wizard again
    setOnboardingCompleted(false);
    // Close settings view if open
    setCurrentView("main");
  };

  // Load LLM config status
  const loadLLMConfig = async () => {
    if (!window.electronAPI?.getLLMConfigStatus) return;
    try {
      const config = await window.electronAPI.getLLMConfigStatus();
      if (!config) return;
      setSelectedModel(config.currentModel);
      setSelectedProvider(config.currentProvider);
      setSelectedReasoningEffort(config.currentReasoningEffort);
      setSessionModelOverride("");
      setAvailableModels(config.models);
      setAvailableProviders(config.providers);
    } catch (error) {
      console.error("Failed to load LLM config:", error);
    }
  };

  // Load LLM config on mount
  useEffect(() => {
    loadLLMConfig();
  }, []);

  useEffect(() => {
    const handler = () => {
      setSettingsTab("llm");
      setCurrentView("settings");
    };
    window.addEventListener("open-settings", handler as EventListener);
    return () => window.removeEventListener("open-settings", handler as EventListener);
  }, []);

  // Load appearance settings on mount
  useEffect(() => {
    const loadAppearanceSettings = async () => {
      if (!window.electronAPI?.getAppearanceSettings) {
        setDisclaimerAccepted(true);
        setOnboardingCompleted(true);
        setOnboardingCompletedAt(undefined);
        return;
      }
      try {
        const settings = await window.electronAPI.getAppearanceSettings();
        if (!settings) {
          setDisclaimerAccepted(true);
          setOnboardingCompleted(true);
          setOnboardingCompletedAt(undefined);
          return;
        }
        setThemeMode(settings.themeMode);
        setVisualTheme(settings.visualTheme || "warm");
        setAccentColor(settings.accentColor);
        setTransparencyEffectsEnabled(settings.transparencyEffectsEnabled !== false);
        setUiDensity(settings.uiDensity || "focused");
        setDevRunLoggingEnabled(settings.devRunLoggingEnabled === true);
        setHomeResearchVaultEnabled(settings.homeResearchVaultEnabled === true);
        setHomeNextActionsEnabled(settings.homeNextActionsEnabled === true);
        setDisclaimerAccepted(settings.disclaimerAccepted ?? false);
        setOnboardingCompleted(settings.onboardingCompleted ?? false);
        setOnboardingCompletedAt(settings.onboardingCompletedAt);
      } catch (error) {
        console.error("Failed to load appearance settings:", error);
        setDisclaimerAccepted(false);
        setOnboardingCompleted(false);
        setOnboardingCompletedAt(undefined);
      }
    };
    loadAppearanceSettings();
  }, []);

  // Check for migration status and show one-time notification if needed
  // This handles the case where the app was renamed from cowork-oss to cowork-os
  // and encrypted credentials (API keys) need to be re-entered
  const migrationCheckDone = useRef(false);
  useEffect(() => {
    if (!window.electronAPI?.getMigrationStatus) return;

    // Prevent double execution in React StrictMode
    if (migrationCheckDone.current) return;
    migrationCheckDone.current = true;

    const checkMigrationStatus = async () => {
      try {
        const status = await window.electronAPI.getMigrationStatus();

        // If migration happened but notification hasn't been dismissed, show info toast
        if (status.migrated && !status.notificationDismissed) {
          const id = `migration-notice-${Date.now()}`;
          const toast: ToastNotification = {
            id,
            type: "info",
            title: "Welcome to CoWork OS",
            message:
              "Your data was migrated successfully. Due to macOS security, API keys need to be re-entered.",
            action: {
              label: "Open Settings",
              callback: () => {
                setCurrentView("settings");
                setSettingsTab("llm");
              },
            },
          };
          setToasts((prev) => [...prev, toast]);

          // Longer auto-dismiss for this important notification (30 seconds)
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, 30000);

          // Mark notification as dismissed so it only shows once
          await window.electronAPI.dismissMigrationNotification?.();
        }
      } catch (error) {
        console.error("Failed to check migration status:", error);
      }
    };
    checkMigrationStatus();
  }, []);

  // Load queue status and subscribe to updates
  useEffect(() => {
    if (!window.electronAPI?.getQueueStatus || !window.electronAPI?.onQueueUpdate) return;

    const loadQueueStatus = async () => {
      try {
        const status = await window.electronAPI.getQueueStatus();
        setQueueStatus(status);
      } catch (error) {
        console.error("Failed to load queue status:", error);
      }
    };

    loadQueueStatus();

    const unsubscribe = window.electronAPI.onQueueUpdate((status) => {
      setQueueStatus(status);
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  // Check for updates on mount
  useEffect(() => {
    if (!window.electronAPI?.checkForUpdates) return;

    const checkUpdates = async () => {
      try {
        const info = await window.electronAPI.checkForUpdates();
        if (info.available) {
          setUpdateInfo(info);
        }
      } catch (error) {
        // Silently ignore update check failures
        console.log("Update check skipped:", error);
      }
    };
    // Delay check to not block app startup
    const timeoutId = setTimeout(checkUpdates, 3000);
    return () => clearTimeout(timeoutId);
  }, []);

  // Apply theme classes to root element
  useEffect(() => {
    const root = document.documentElement;
    const effectiveTheme = getEffectiveTheme(themeMode);

    // Remove existing theme classes
    root.classList.remove("theme-light", "theme-dark");

    // Apply theme mode class
    if (effectiveTheme === "light") {
      root.classList.add("theme-light");
    }
    // dark is default, no class needed unless specified otherwise by visual styles

    // Remove existing visual theme classes
    root.classList.remove("visual-terminal", "visual-warm", "visual-oblivion");
    const resolvedVisualTheme = visualTheme === "warm" ? "oblivion" : visualTheme;
    root.classList.add(`visual-${resolvedVisualTheme}`);

    // Remove existing accent classes
    root.classList.remove(
      "accent-cyan",
      "accent-blue",
      "accent-purple",
      "accent-pink",
      "accent-rose",
      "accent-orange",
      "accent-green",
      "accent-teal",
      "accent-coral",
    );

    // Apply accent class
    root.classList.add(`accent-${accentColor}`);

    // Apply density class
    root.classList.remove("density-focused", "density-full");
    root.classList.add(`density-${uiDensity}`);

    // Cache density in localStorage for instant restore on next startup
    try {
      localStorage.setItem("uiDensity", uiDensity);
    } catch {
      /* ignore */
    }

    invalidateGlobalMeasurer();
  }, [themeMode, visualTheme, accentColor, uiDensity]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (themeMode !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const root = document.documentElement;
      root.classList.remove("theme-light", "theme-dark");
      if (!mediaQuery.matches) {
        root.classList.add("theme-light");
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [themeMode]);

  useEffect(() => {
    console.log("App mounted");
    console.log("window.electronAPI available:", !!window.electronAPI);
    if (window.electronAPI) {
      console.log("electronAPI methods:", Object.keys(window.electronAPI));
    }
  }, []);

  // Auto-load temp workspace on mount if no workspace is selected
  useEffect(() => {
    if (!window.electronAPI?.getTempWorkspace) return;

    const initWorkspace = async () => {
      if (!currentWorkspace) {
        try {
          const tempWorkspace = await window.electronAPI.getTempWorkspace();
          setCurrentWorkspace(tempWorkspace);
        } catch (error) {
          console.error("Failed to initialize temp workspace:", error);
        }
      }
    };
    initWorkspace();
  }, []);

  // Load tasks when workspace is set
  useEffect(() => {
    if (currentWorkspace) {
      loadTasks();
    }
  }, [currentWorkspace?.id]);

  // Sync current workspace to the selected task's workspace
  useEffect(() => {
    if (!window.electronAPI?.selectWorkspace || !window.electronAPI?.getTempWorkspace) return;
    if (!selectedTaskId) return;
    if (remoteTaskView) return;
    if (!selectedTask) return;
    if (currentWorkspace?.id === selectedTask.workspaceId) return;

    let cancelled = false;

    const loadTaskWorkspace = async () => {
      try {
        let resolved: Workspace | null = await window.electronAPI.selectWorkspace(selectedTask.workspaceId);
        if (!resolved && isTempWorkspaceId(selectedTask.workspaceId)) {
          resolved = await window.electronAPI.getTempWorkspace();
        }
        if (!cancelled && resolved) {
          setCurrentWorkspace((prev) => (prev?.id === resolved.id ? prev : resolved));
        }
      } catch (error) {
        console.error("Failed to load task workspace:", error);
      }
    };

    void loadTaskWorkspace();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, selectedTask, currentWorkspace?.id, remoteTaskView]);

  // Track recency when the active workspace changes
  useEffect(() => {
    if (!window.electronAPI?.touchWorkspace) return;
    if (!currentWorkspace) return;
    window.electronAPI.touchWorkspace(currentWorkspace.id).catch((error: unknown) => {
      console.error("Failed to update workspace recency:", error);
    });
  }, [currentWorkspace?.id]);

  // Keep temp workspace lease alive while it is active in the UI.
  useEffect(() => {
    if (!window.electronAPI?.touchWorkspace) return;
    if (!currentWorkspace || !isTempWorkspaceId(currentWorkspace.id)) return;
    const interval = setInterval(() => {
      window.electronAPI.touchWorkspace(currentWorkspace.id).catch((error: unknown) => {
        console.error("Failed to refresh temp workspace lease:", error);
      });
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, [currentWorkspace?.id]);

  useEffect(() => {
    sessionAutoApproveAllRef.current = sessionAutoApproveAll;
  }, [sessionAutoApproveAll]);

  // Toast helper functions
  const addToast = (toast: Omit<ToastNotification, "id"> & { id?: string }) => {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: ToastNotification = { ...toast, id };
    setToasts((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, newToast]));

    const durationMs = toast.persistent ? null : (toast.durationMs ?? 5000);
    if (durationMs !== null && durationMs > 0) {
      setTimeout(() => dismissToast(id), durationMs);
    }

    return id;
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleApprovalResponse = async (
    approvalId: string,
    approved: boolean,
    action?: ApprovalResponseAction,
  ) => {
    let handled = false;
    try {
      await window.electronAPI.respondToApproval({
        approvalId,
        approved,
        action,
      });
      handled = true;
    } catch (error) {
      console.error("Failed to respond to approval:", error);
      addToast({
        type: "error",
        title: "Approval action failed",
        message: "Could not send your approval decision. Please try again.",
      });
    }

    if (handled) {
      pendingApprovalsRef.current.delete(approvalId);
      dismissToast(getApprovalToastId(approvalId));
      if (!bulkApproveSilentRef.current) {
        setComputerUseAppGrantApproval((prev) =>
          prev?.id === approvalId
            ? pickFirstPendingComputerUseApproval(pendingApprovalsRef.current)
            : prev,
        );
        setGenericApproval((prev) =>
          prev?.id === approvalId
            ? pickFirstPendingGenericApproval(pendingApprovalsRef.current)
            : prev,
        );
      }
    }
  };

  const syncPendingInputRequests = useCallback(() => {
    const pending = Array.from(pendingInputRequestsRef.current.values())
      .filter((request) => request.status === "pending")
      .sort((a, b) => b.requestedAt - a.requestedAt);
    setPendingInputRequests(pending);
  }, []);

  const handleInputRequestResponse = useCallback(async (data: InputRequestResponse) => {
    try {
      const response = await window.electronAPI.respondToInputRequest(data);
      // Keep the prompt visible while the daemon still reports an in-progress mutation.
      if (response?.status !== "in_progress") {
        pendingInputRequestsRef.current.delete(data.requestId);
        syncPendingInputRequests();
      }
    } catch (error) {
      console.error("Failed to respond to input request:", error);
      addToast({
        type: "error",
        title: "Input response failed",
        message: "Could not submit your response. Please try again.",
      });
    }
  }, [addToast, syncPendingInputRequests]);

  const handleSessionApproveAllConfirm = () => {
    setSessionAutoApproveAll(true);

    // Persist to main process so it survives HMR / renderer state resets
    void window.electronAPI.setSessionAutoApprove(true);

    setComputerUseAppGrantApproval(null);
    setGenericApproval(null);

    const pendingNonComputerUse = Array.from(pendingApprovalsRef.current.entries()).filter(
      ([, approval]) => !isComputerUseAppGrantApproval(approval),
    );

    void (async () => {
      bulkApproveSilentRef.current = true;
      try {
        await Promise.all(
          pendingNonComputerUse.map(([approvalId]) => handleApprovalResponse(approvalId, true)),
        );
      } finally {
        bulkApproveSilentRef.current = false;
      }
    })();

    addToast({
      type: "info",
      title: "Session auto-approve enabled",
      message: "Approvals will be accepted automatically for the rest of this app session.",
      durationMs: 7000,
    });
  };

  const reshowPendingApprovalToasts = () => {
    setComputerUseAppGrantApproval(pickFirstPendingComputerUseApproval(pendingApprovalsRef.current));
    setGenericApproval(pickFirstPendingGenericApproval(pendingApprovalsRef.current));
  };

  const showApproveAllWarning = () => {
    const pendingApprovalIds = Array.from(pendingApprovalsRef.current.keys());
    for (const id of pendingApprovalIds) {
      dismissToast(getApprovalToastId(id));
    }

    setComputerUseAppGrantApproval(null);
    setGenericApproval(null);
    setApproveAllSessionWarningOpen(true);
  };

  // Keep tasksRef in sync with tasks state
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    sideChatRef.current = sideChat;
  }, [sideChat]);

  useLayoutEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    noiseEventThrottleRef.current.clear();
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId || remoteTaskView || !window.electronAPI?.getTask) return;
    if (selectedTask && !shouldHydrateTaskSummary(selectedTask)) return;

    if (
      selectedTaskHydrationInFlightRef.current.has(selectedTaskId) ||
      hasTaskHydrationAttempted(
        selectedTaskHydrationAttemptedRef.current,
        selectedTaskId,
        selectedTask,
      )
    ) {
      return;
    }

    selectedTaskHydrationInFlightRef.current.add(selectedTaskId);
    let cancelled = false;

    void window.electronAPI
      .getTask(selectedTaskId)
      .then((task: Task | null) => {
        if (cancelled || !task || task.id !== selectedTaskId) return;
        recordTaskHydrationAttemptSuccess(
          selectedTaskHydrationAttemptedRef.current,
          selectedTaskId,
          selectedTask,
          new Set(tasksRef.current.map((currentTask) => currentTask.id)),
        );
        setTasks((prev) => upsertTaskPreservingIdentity(prev, task, { prependIfMissing: true }));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to hydrate selected task:", error);
        }
      })
      .finally(() => {
        selectedTaskHydrationInFlightRef.current.delete(selectedTaskId);
      });

    return () => {
      cancelled = true;
    };
  }, [remoteTaskView, selectedTask, selectedTaskId]);

  useEffect(() => {
    currentViewRef.current = currentView;
    if (currentView !== "main") {
      setTerminalTabsOpen(false);
    }
  }, [currentView]);

  useEffect(() => {
    rightSidebarCollapsedRef.current = rightSidebarCollapsed;
  }, [rightSidebarCollapsed]);

  useEffect(() => {
    currentWorkspaceRef.current = currentWorkspace;
  }, [currentWorkspace]);

  useEffect(() => {
    if (!window.electronAPI?.onBrowserWorkbenchOpenRequest) return;
    return window.electronAPI.onBrowserWorkbenchOpenRequest((request) => {
      if (!request?.taskId) return;
      setCurrentView("main");
      setSelectedTaskId(request.taskId);
      setRemoteTaskView(null);
      setRightSidebarCollapsed(false);
      setBrowserWorkbenchRequest(request);
    });
  }, []);

  // Restore session auto-approve state from main process (survives HMR and renderer resets)
  useEffect(() => {
    if (!window.electronAPI?.getSessionAutoApprove) return;

    window.electronAPI
      .getSessionAutoApprove()
      .then((enabled: boolean) => {
        if (enabled) {
          setSessionAutoApproveAll(true);
          sessionAutoApproveAllRef.current = true;
        }
      })
      .catch(() => {
        // Ignore — main process may not support this yet
      });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.listInputRequests) return;
    let cancelled = false;
    window.electronAPI
      .listInputRequests({ limit: 200, offset: 0, status: "pending" })
      .then((requests) => {
        if (cancelled) return;
        pendingInputRequestsRef.current.clear();
        for (const request of requests || []) {
          if (request?.id) {
            pendingInputRequestsRef.current.set(request.id, request);
          }
        }
        syncPendingInputRequests();
      })
      .catch((error) => {
        console.error("Failed to load pending input requests:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to live remote task events when viewing a remote task
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent || !remoteTaskView) return;
    const view = remoteTaskView;
    const unsubscribe = window.electronAPI.onTaskEvent((rawEvent: TaskEvent & { deviceId?: string }) => {
      if (rawEvent.deviceId !== view.deviceId || rawEvent.taskId !== view.task.id) return;
      const effectiveType = getEffectiveTaskEventType(rawEvent);
      const event = { ...rawEvent, type: effectiveType } as TaskEvent;
      setEvents((prev) => capTaskEvents([...prev, event]));
      const newStatus =
        isLlmRequestCancelledEvent(event)
          ? undefined
          : event.type === "task_status"
            ? event.payload?.status
            : TASK_EVENT_STATUS_MAP[event.type];
      if (newStatus) {
        setRemoteTaskView((prev) =>
          prev && prev.task.id === view.task.id
            ? {
                ...prev,
                task: {
                  ...prev.task,
                  status:
                    resolveTaskStatusUpdateFromEvent(
                      prev.task,
                      newStatus as Task["status"],
                    ) ?? prev.task.status,
                },
              }
            : prev,
        );
      }
    });
    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [remoteTaskView]);

  // Subscribe to all task events to update task status (local tasks only when not viewing remote)
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;
    if (remoteTaskView) return;

    const unsubscribe = window.electronAPI.onTaskEvent((rawEvent: TaskEvent) => {
      const effectiveType = getEffectiveTaskEventType(rawEvent);
      const event = {
        ...rawEvent,
        type: effectiveType,
      } as TaskEvent;
      noteRendererTaskEventReceived(event, rendererPerfLoggingEnabled);
      const sideChatTaskId = sideChatRef.current?.task?.id;
      const sideChatParentTaskId = sideChatRef.current?.parentTaskId;
      const isSideChatTaskEvent = sideChatTaskId === event.taskId;
      if (sideChatParentTaskId && sideChatParentTaskId === event.taskId) {
        setSideChat((prev) => {
          if (!prev || prev.parentTaskId !== event.taskId || !prev.parentTask) return prev;
          const parentStatus =
            isLlmRequestCancelledEvent(event)
              ? undefined
              : event.type === "task_status"
                ? event.payload?.status
                : TASK_EVENT_STATUS_MAP[event.type];
          const nextParentTask =
            parentStatus && typeof parentStatus === "string"
              ? {
                  ...prev.parentTask,
                  status:
                    resolveTaskStatusUpdateFromEvent(
                      prev.parentTask,
                      parentStatus as Task["status"],
                    ) ?? prev.parentTask.status,
                  updatedAt: event.timestamp || Date.now(),
                }
              : {
                  ...prev.parentTask,
                  updatedAt: event.timestamp || prev.parentTask.updatedAt,
                };
          return { ...prev, parentTask: nextParentTask };
        });
      }
      if (isSideChatTaskEvent) {
        setSideChat((prev) => {
          if (!prev?.task || prev.task.id !== event.taskId) return prev;
          const sideStatus =
            isLlmRequestCancelledEvent(event)
              ? undefined
              : event.type === "task_status"
                ? event.payload?.status
                : TASK_EVENT_STATUS_MAP[event.type];
          const nextTask =
            sideStatus && typeof sideStatus === "string"
              ? {
                  ...prev.task,
                  status:
                    resolveTaskStatusUpdateFromEvent(prev.task, sideStatus as Task["status"]) ??
                    prev.task.status,
                  updatedAt: event.timestamp || Date.now(),
                }
              : {
                  ...prev.task,
                  updatedAt: event.timestamp || prev.task.updatedAt,
                };
          return {
            ...prev,
            task: nextTask,
            events: capTaskEvents(mergeUniqueTaskEvents(prev.events, [event])),
            sending:
              event.type === "assistant_message" || isTerminalTaskStatus(nextTask.status)
                ? false
                : prev.sending,
            loading: false,
          };
        });
        if (!tasksRef.current.some((task) => task.id === event.taskId)) {
          return;
        }
      }
      const eventTimestamp =
        typeof rawEvent?.timestamp === "number" && Number.isFinite(rawEvent.timestamp)
          ? rawEvent.timestamp
          : Date.now();
      taskLastEventTimestampRef.current.set(event.taskId, eventTimestamp);
      if (isImmediateTaskAttentionEvent(event)) {
        latestAttentionEventByTaskIdRef.current.set(event.taskId, event);
      } else if (
        event.type === "task_resumed" ||
        event.type === "approval_granted" ||
        event.type === "approval_denied" ||
        event.type === "input_request_resolved" ||
        event.type === "input_request_dismissed" ||
        event.type === "task_completed" ||
        event.type === "task_cancelled"
      ) {
        latestAttentionEventByTaskIdRef.current.delete(event.taskId);
      }
      // Update task status based on event type
      // Check if this is a new task we don't know about (e.g., sub-agent created)
      const isNewTask = !tasksRef.current.some((t) => t.id === event.taskId);
      if (isNewTask && event.type === "task_created") {
        // Refresh task list to include the new sub-agent task
        loadTasks();
        return;
      }

      const newStatus =
        isLlmRequestCancelledEvent(event)
          ? undefined
          : event.type === "task_status"
            ? event.payload?.status
            : TASK_EVENT_STATUS_MAP[event.type];
      const isAutoApprovalRequested =
        event.type === "approval_requested" && event.payload?.autoApproved === true;
      const isSessionAutoApproval =
        event.type === "approval_requested" && sessionAutoApproveAllRef.current;
      const skipBlockedStateForAutoApproval = isAutoApprovalRequested || isSessionAutoApproval;
      const payloadTerminalStatus =
        typeof event.payload?.terminalStatus === "string" ? event.payload.terminalStatus : undefined;
      const eventTerminalStatus =
        payloadTerminalStatus !== undefined
          ? payloadTerminalStatus
          : event.type === "approval_requested" && !skipBlockedStateForAutoApproval
            ? "awaiting_approval"
            : event.type === "approval_denied" || event.type === "input_request_created"
              ? "needs_user_action"
              : event.type === "task_interrupted"
                ? "resume_available"
                : undefined;
      const shouldClearTerminalStatus =
        event.type === "approval_granted" ||
        event.type === "task_resumed" ||
        event.type === "input_request_resolved";
      const isNewRunStarted =
        event.type === "task_resumed" && event.payload?.newRunStarted === true;
      const payloadFailureClass =
        typeof event.payload?.failureClass === "string" ? event.payload.failureClass : undefined;
      const payloadBestKnownOutcome =
        event.payload?.bestKnownOutcome && typeof event.payload.bestKnownOutcome === "object"
          ? event.payload.bestKnownOutcome
          : undefined;
      const payloadLastRunDurationMs =
        typeof event.payload?.lastRunDurationMs === "number" &&
        Number.isFinite(event.payload.lastRunDurationMs)
          ? Math.max(0, Math.floor(event.payload.lastRunDurationMs))
          : undefined;
      const isInputRequestResolutionEvent =
        event.type === "input_request_resolved" || event.type === "input_request_dismissed";
      const isTerminalInputResolution =
        isInputRequestResolutionEvent &&
        (event.payload?.terminalTask === true ||
          isTerminalTaskStatus(tasksRef.current.find((t) => t.id === event.taskId)?.status));
      const nextStatus = newStatus as Task["status"] | undefined;
      if (newStatus && !skipBlockedStateForAutoApproval) {
        const applyTaskStatusUpdate = () =>
          setTasks((prev) =>
            updateTaskPreservingIdentity(prev, event.taskId, (t) => {
              if (isTerminalInputResolution && isTerminalTaskStatus(t.status)) {
                return t;
              }
              const resolvedStatus =
                isNewRunStarted
                  ? (newStatus as Task["status"])
                  : resolveTaskStatusUpdateFromEvent(t, newStatus as Task["status"]) ?? t.status;
              const updates: Partial<Task> = {
                status: resolvedStatus,
                updatedAt: Math.max(t.updatedAt || 0, eventTimestamp),
              };
              if (isNewRunStarted) {
                updates.completedAt = undefined;
                updates.lastRunDurationMs = undefined;
              }
              if (shouldClearTerminalStatus) {
                updates.terminalStatus = undefined;
                updates.failureClass = undefined;
              } else if (eventTerminalStatus !== undefined) {
                updates.terminalStatus = eventTerminalStatus;
              }
              if (payloadFailureClass !== undefined) {
                updates.failureClass = payloadFailureClass;
              }
              if (payloadBestKnownOutcome) {
                updates.bestKnownOutcome = payloadBestKnownOutcome;
              }
              if (payloadLastRunDurationMs !== undefined) {
                updates.lastRunDurationMs = payloadLastRunDurationMs;
              }
              return mergeTaskPreservingIdentity(t, updates);
            }),
          );

        if (event.taskId === selectedTaskIdRef.current) {
          applyTaskStatusUpdate();
        } else {
          startTransition(() => {
            applyTaskStatusUpdate();
          });
        }
      }

      if (
        shouldRefreshCanonicalEventsForTerminalUpdate({
          selectedTaskId: selectedTaskIdRef.current,
          event,
          nextStatus,
        }) &&
        !terminalEventRefreshInFlightRef.current.has(event.taskId)
      ) {
        terminalEventRefreshInFlightRef.current.add(event.taskId);
        void reconcileTaskFromCanonical(event.taskId, {
          refreshEventsWhenTerminal: true,
        }).catch((error) => {
          terminalEventRefreshInFlightRef.current.delete(event.taskId);
          console.error("Failed to refresh selected task events after terminal update:", error);
        });
      }

      if (event.type === "approval_requested" && !isAutoApprovalRequested) {
        const approval = event.payload?.approval as ApprovalRequest | undefined;
        if (approval?.id) {
          pendingApprovalsRef.current.set(approval.id, approval);

          if (isComputerUseAppGrantApproval(approval)) {
            setComputerUseAppGrantApproval(approval);
          } else if (sessionAutoApproveAllRef.current) {
            void handleApprovalResponse(approval.id, true);
          } else {
            setGenericApproval((prev) => prev ?? approval);
          }
        }
      }

      if (event.type === "approval_granted" || event.type === "approval_denied") {
        const approvalId = extractApprovalId(event);
        if (approvalId) {
          pendingApprovalsRef.current.delete(approvalId);
          dismissToast(getApprovalToastId(approvalId));
          setComputerUseAppGrantApproval((prev) =>
            prev?.id === approvalId
              ? pickFirstPendingComputerUseApproval(pendingApprovalsRef.current)
              : prev,
          );
          setGenericApproval((prev) =>
            prev?.id === approvalId
              ? pickFirstPendingGenericApproval(pendingApprovalsRef.current)
              : prev,
          );

          const approvalFeedback = describeApprovalPersistence(
            event.payload,
            event.type === "approval_granted",
          );
          if (approvalFeedback) {
            void (async () => {
              try {
                const traySettings = await window.electronAPI.getTraySettings();
                if (
                  !traySettings.showNotifications ||
                  !traySettings.showApprovalSavedNotifications
                ) {
                  return;
                }

                await window.electronAPI.addNotification({
                  type: approvalFeedback.type,
                  title:
                    event.type === "approval_granted"
                      ? "Approval saved"
                      : "Approval recorded",
                  message: approvalFeedback.message,
                  taskId: event.taskId,
                  workspaceId: tasksRef.current.find((t) => t.id === event.taskId)?.workspaceId,
                });
              } catch (error) {
                console.error("Failed to add approval persistence notification:", error);
              }
            })();
          }
        }
      }

      if (event.type === "input_request_created") {
        const request = event.payload?.request as InputRequest | undefined;
        if (request?.id) {
          pendingInputRequestsRef.current.set(request.id, request);
          syncPendingInputRequests();
        }
      }

      if (event.type === "input_request_resolved" || event.type === "input_request_dismissed") {
        const requestId = extractInputRequestId(event);
        if (requestId) {
          pendingInputRequestsRef.current.delete(requestId);
          syncPendingInputRequests();
        }
      }

      if (event.type === "workspace_permissions_updated") {
        const payloadWorkspace = event.payload?.workspace as Workspace | undefined;
        const payloadWorkspaceId = event.payload?.workspaceId as string | undefined;
        const payloadPermissions = event.payload?.permissions as
          | Workspace["permissions"]
          | undefined;
        setCurrentWorkspace((prev) => {
          if (!prev) return prev;
          if (payloadWorkspace && payloadWorkspace.id === prev.id) {
            return payloadWorkspace;
          }
          if (payloadWorkspaceId && payloadWorkspaceId === prev.id && payloadPermissions) {
            return {
              ...prev,
              permissions: {
                ...prev.permissions,
                ...payloadPermissions,
              },
            };
          }
          return prev;
        });
      }

      if (event.type === "approval_granted") {
        void window.electronAPI.resumeTask(event.taskId);
      }

      if (
        (event.type === "task_paused" &&
          isNotificationWorthyPauseReason(
            typeof event.payload?.reason === "string" ? event.payload.reason : undefined,
          )) ||
        (event.type === "approval_requested" && !skipBlockedStateForAutoApproval) ||
        event.type === "input_request_created"
      ) {
        const isApproval = event.type === "approval_requested";
        const isInputRequest = event.type === "input_request_created";
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        const baseTitle = isApproval ? "Approval needed" : isInputRequest ? "Input needed" : "Action needed";
        const title = task?.title ? `${baseTitle} · ${task.title}` : baseTitle;
        const requestQuestion =
          isInputRequest && Array.isArray(event.payload?.request?.questions)
            ? event.payload.request.questions[0]?.question
            : undefined;
        const message =
          (isApproval
            ? event.payload?.approval?.description
            : isInputRequest
              ? requestQuestion
              : event.payload?.message) ||
          "Quick pause - ready to continue once you respond.";

        void (async () => {
          try {
            const existing = await window.electronAPI.listNotifications();
            const existingForTask = existing
              .filter((n) => n.type === "input_required" && n.taskId === event.taskId)
              .sort((a, b) => b.createdAt - a.createdAt);
            if (existingForTask.length > 0) {
              const duplicateNotifications = existingForTask.slice(1);
              if (duplicateNotifications.length > 0) {
                const removals = await Promise.allSettled(
                  duplicateNotifications.map((n) => window.electronAPI.deleteNotification(n.id)),
                );
                if (removals.some((result) => result.status === "rejected")) {
                  console.error(
                    "Some duplicate input-required notifications failed to clear before sending update.",
                  );
                }
              }
              return;
            }
            await window.electronAPI.addNotification({
              type: "input_required",
              title,
              message,
              taskId: event.taskId,
              workspaceId: task?.workspaceId,
            });
          } catch (error) {
            console.error("Failed to add input-required notification:", error);
          }
        })();
      }

      if (
        event.type === "task_resumed" ||
        event.type === "approval_granted" ||
        event.type === "approval_denied" ||
        event.type === "input_request_resolved" ||
        event.type === "input_request_dismissed"
      ) {
        void (async () => {
          try {
            const existing = await window.electronAPI.listNotifications();
            const existingForTask = existing.filter(
              (n) => n.type === "input_required" && n.taskId === event.taskId,
            );
            if (existingForTask.length > 0) {
              const removals = await Promise.allSettled(
                existingForTask.map((n) => window.electronAPI.deleteNotification(n.id)),
              );
              if (removals.some((result) => result.status === "rejected")) {
                console.error(
                  "Failed to clear some stale input-required notifications after resume.",
                );
              }
            }
          } catch (error) {
            console.error("Failed to clear input-required notifications after resume:", error);
          }
        })();
      }

      // Show toast notifications for task completion/failure
      if (event.type === "task_completed") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        const isMainView = currentViewRef.current === "main";
        const isSelectedTask = selectedTaskIdRef.current === event.taskId;
        if (shouldTrackUnseenCompletion({ isMainView, isSelectedTask })) {
          setUnseenCompletedTaskIds((prev) => addUniqueTaskId(prev, event.taskId));
        }
        const fallbackEventsForTask =
          event.taskId === selectedTaskIdRef.current
            ? capTaskEvents([...eventsRef.current, event])
            : undefined;
        const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(
          event,
          fallbackEventsForTask,
        );
        const toastDecision = shouldShowCompletionToast(
          event.taskId,
          outputSummary,
          completionToastNotifiedPathsRef.current,
        );
        const terminalStatus =
          typeof event.payload?.terminalStatus === "string"
            ? event.payload.terminalStatus
            : typeof task?.terminalStatus === "string"
              ? task.terminalStatus
            : undefined;
        const shouldShowToast =
          toastDecision.show &&
          shouldNotifyForTaskCompletionTerminalStatus(terminalStatus) &&
          !isAutomatedTaskLike(task);
        if (shouldShowToast) {
          recordCompletionToastShown(
            event.taskId,
            toastDecision.pathsToRecord,
            completionToastNotifiedPathsRef.current,
            hasTaskOutputs(outputSummary),
          );
        }
        const resolveWorkspacePathForTask = async (): Promise<string | undefined> => {
          const taskForEvent = tasksRef.current.find((t) => t.id === event.taskId);
          if (!taskForEvent) return currentWorkspaceRef.current?.path;
          if (currentWorkspaceRef.current?.id === taskForEvent.workspaceId) {
            return currentWorkspaceRef.current.path;
          }
          try {
            const allWorkspaces = await window.electronAPI.listWorkspaces();
            return allWorkspaces.find((w) => w.id === taskForEvent.workspaceId)?.path;
          } catch {
            return currentWorkspaceRef.current?.path;
          }
        };
        const primaryOutputPath = hasTaskOutputs(outputSummary)
          ? outputSummary.primaryOutputPath
          : undefined;
        if (shouldShowToast) {
          addToast(
            buildTaskCompletionToast({
              taskId: event.taskId,
              taskTitle: task?.title,
              outputSummary,
              terminalStatus,
              actionDependencies: hasTaskOutputs(outputSummary)
                ? {
                    resolveWorkspacePath: resolveWorkspacePathForTask,
                    openFile: (path, workspacePath) => window.electronAPI.openFile(path, workspacePath),
                    showInFinder: (path, workspacePath) =>
                      window.electronAPI.showInFinder(path, workspacePath),
                    onViewInFiles: () => {
                      setCurrentView("main");
                      setSelectedTaskId(event.taskId);
                      setRightSidebarCollapsed(false);
                      if (primaryOutputPath) {
                        setRightPanelHighlight({ taskId: event.taskId, path: primaryOutputPath });
                      }
                      setUnseenOutputTaskIds((prev) => removeTaskId(prev, event.taskId));
                      setUnseenCompletedTaskIds((prev) => removeTaskId(prev, event.taskId));
                    },
                    onOpenFileError: (error) => {
                      console.error("Failed to open completion output:", error);
                    },
                    onShowInFinderError: (error) => {
                      console.error("Failed to reveal completion output:", error);
                    },
                  }
                : undefined,
            }),
          );
        }

        if (hasTaskOutputs(outputSummary)) {
          const panelBehavior = decideCompletionPanelBehavior({
            isMainView,
            isSelectedTask,
            panelCollapsed: rightSidebarCollapsedRef.current,
          });
          if (panelBehavior.autoOpenPanel) {
            setRightSidebarCollapsed(false);
            if (primaryOutputPath) {
              setRightPanelHighlight({ taskId: event.taskId, path: primaryOutputPath });
            }
          } else if (panelBehavior.markUnseenOutput) {
            setUnseenOutputTaskIds((prev) => addUniqueTaskId(prev, event.taskId));
          }
        }
      } else if (event.type === "error") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        addToast({
          type: "error",
          title: "Task Failed",
          message: task?.title || "Task encountered an error",
          taskId: event.taskId,
        });
      } else if (event.type === "follow_up_failed") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        const fallbackMessage = task?.title || "A follow-up message failed";
        const reason = String(event.payload?.userMessage || event.payload?.error || "").trim();
        addToast({
          type: "error",
          title: "Follow-up Failed",
          message: reason ? `${fallbackMessage}: ${reason}` : fallbackMessage,
          taskId: event.taskId,
        });
      }

      // Add event to events list if it's for the selected task
      const isSelectedTask = event.taskId === selectedTaskIdRef.current;
      const shouldIncludeInSelectedSession = shouldIncludeTaskEventInSelectedSession({
        selectedTaskId: selectedTaskIdRef.current,
        event,
        tasks: tasksRef.current,
      });

      if (shouldIncludeInSelectedSession) {
        if (RENDERER_DROPPED_EVENT_TYPES.has(event.type)) {
          return;
        }
        if (RENDERER_THROTTLED_EVENT_TYPES.has(event.type)) {
          const throttleKey = `${event.taskId}:${event.type}`;
          const now = Date.now();
          const previous = noiseEventThrottleRef.current.get(throttleKey) ?? 0;
          if (now - previous < RENDERER_NOISE_THROTTLE_MS) {
            return;
          }
          noiseEventThrottleRef.current.set(throttleKey, now);
        }

        const lane = classifyLiveTaskEvent(event);
        const isMilestone = lane === "immediate" || EVENT_TYPES_MILESTONE.has(event.type);
        const isBatchable =
          isSelectedTask &&
          (lane === "batchable" ||
            lane === "coalescible" ||
            EVENT_TYPES_BATCHABLE.has(event.type));

        const appendSelectedTaskEvents = (
          incomingEvents: TaskEvent[],
          options?: { queuedAtByEventId?: Map<string, number>; transition?: boolean },
        ) => {
          if (incomingEvents.length === 0) return;
          const queuedAtByEventId = options?.queuedAtByEventId;
          noteRendererTaskEventsAppendDispatched(incomingEvents, rendererPerfLoggingEnabled);
          const applyAppend = () => {
            setEvents((prev) => {
              noteRendererTaskEventsAppended(
                incomingEvents.map((incomingEvent) => ({
                  event: incomingEvent,
                  queuedAtMs: queuedAtByEventId?.get(incomingEvent.id),
                })),
                rendererPerfLoggingEnabled,
              );
              return appendRendererTaskEvents(prev, incomingEvents);
            });
          };
          if (options?.transition) {
            startTransition(applyAppend);
          } else {
            applyAppend();
          }
        };

        const flushPendingToolEvents = (extraEvents: TaskEvent[] = []) => {
          const queuedEntries = pendingToolEventsRef.current;
          pendingToolEventsRef.current = [];
          if (pendingToolEventsFlushTimerRef.current) {
            clearTimeout(pendingToolEventsFlushTimerRef.current);
            pendingToolEventsFlushTimerRef.current = null;
          }
          if (pendingToolEventsForceFlushTimerRef.current) {
            clearTimeout(pendingToolEventsForceFlushTimerRef.current);
            pendingToolEventsForceFlushTimerRef.current = null;
          }
          const flushedEvents = queuedEntries.map((entry) => entry.event);
          const queuedAtByEventId = new Map(
            queuedEntries.map((entry) => [entry.event.id, entry.queuedAtMs] as const),
          );
          if (flushedEvents.length + extraEvents.length === 0) return;
          lastBatchableAppendAtRef.current = performance.now();
          appendSelectedTaskEvents([...flushedEvents, ...extraEvents], {
            queuedAtByEventId,
            transition: extraEvents.length === 0,
          });
        };

        const schedulePendingToolEventFlush = () => {
          if (!pendingToolEventsFlushTimerRef.current) {
            pendingToolEventsFlushTimerRef.current = setTimeout(() => {
              pendingToolEventsFlushTimerRef.current = null;
              flushPendingToolEvents();
            }, EVENT_BATCH_FLUSH_INTERVAL_MS);
          }
          if (!pendingToolEventsForceFlushTimerRef.current) {
            pendingToolEventsForceFlushTimerRef.current = setTimeout(() => {
              pendingToolEventsForceFlushTimerRef.current = null;
              flushPendingToolEvents();
            }, EVENT_BATCH_MAX_WAIT_MS);
          }
        };

        if (isMilestone) {
          flushPendingToolEvents([event]);
        } else if (isBatchable && isSelectedTask) {
          const nowMs = performance.now();
          const withinBurstWindow =
            pendingToolEventsRef.current.length > 0 ||
            nowMs - lastBatchableAppendAtRef.current <= EVENT_BATCH_BURST_WINDOW_MS;
          if (!withinBurstWindow) {
            lastBatchableAppendAtRef.current = nowMs;
            appendSelectedTaskEvents([event], { transition: true });
          } else {
            pendingToolEventsRef.current.push({ event, queuedAtMs: nowMs });
            noteRendererTaskEventQueued(event, nowMs, rendererPerfLoggingEnabled);
            if (pendingToolEventsRef.current.length >= EVENT_BATCH_MAX_EVENTS) {
              flushPendingToolEvents();
            } else {
              schedulePendingToolEventFlush();
            }
          }
        } else {
          appendSelectedTaskEvents([event]);
        }
      }

      // Capture events from dispatched child tasks for DispatchedAgentsPanel / CliAgentFrame
      if (!isSelectedTask && event.type !== "llm_streaming" && event.type !== "llm_usage") {
        if (childTaskIdsRef.current.has(event.taskId)) {
          setChildEvents((prev) => capTaskEvents(mergeUniqueTaskEvents(prev, [rawEvent]), MAX_RENDERER_CHILD_EVENTS));
        } else if (event.type === "task_created" || event.type === "step_started" || event.type === "tool_call" || event.type === "command_output" || event.type === "progress_update" || event.type === "assistant_message") {
          // Buffer events from unknown task IDs — they may be from a just-spawned child
          // whose task_created event hasn't been processed yet (race condition)
          pendingChildEventsRef.current.push(rawEvent);
          // Cap buffer to prevent unbounded growth from unrelated tasks
          if (pendingChildEventsRef.current.length > 500) {
            pendingChildEventsRef.current = pendingChildEventsRef.current.slice(-200);
          }
        }
      }
    });

    return () => {
      // Flush pending batched events before unsubscribe so we don't lose the last batch
      if (pendingToolEventsRef.current.length > 0) {
        const queuedEntries = pendingToolEventsRef.current;
        pendingToolEventsRef.current = [];
        if (pendingToolEventsFlushTimerRef.current) {
          clearTimeout(pendingToolEventsFlushTimerRef.current);
          pendingToolEventsFlushTimerRef.current = null;
        }
        if (pendingToolEventsForceFlushTimerRef.current) {
          clearTimeout(pendingToolEventsForceFlushTimerRef.current);
          pendingToolEventsForceFlushTimerRef.current = null;
        }
        const queuedAtByEventId = new Map(
          queuedEntries.map((entry) => [entry.event.id, entry.queuedAtMs] as const),
        );
        const queuedEvents = queuedEntries.map((entry) => entry.event);
        noteRendererTaskEventsAppendDispatched(queuedEvents, rendererPerfLoggingEnabled);
        setEvents((prev) => {
          noteRendererTaskEventsAppended(
            queuedEvents.map((queuedEvent) => ({
              event: queuedEvent,
              queuedAtMs: queuedAtByEventId.get(queuedEvent.id),
            })),
            rendererPerfLoggingEnabled,
          );
          return appendRendererTaskEvents(prev, queuedEvents);
        });
      }
      lastBatchableAppendAtRef.current = 0;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [selectedTaskId, remoteTaskView, rendererPerfLoggingEnabled]);

  // Load historical events when task is selected
  useEffect(() => {
    pendingToolEventsRef.current = [];
    lastBatchableAppendAtRef.current = 0;
    if (pendingToolEventsFlushTimerRef.current) {
      clearTimeout(pendingToolEventsFlushTimerRef.current);
      pendingToolEventsFlushTimerRef.current = null;
    }
    if (pendingToolEventsForceFlushTimerRef.current) {
      clearTimeout(pendingToolEventsForceFlushTimerRef.current);
      pendingToolEventsForceFlushTimerRef.current = null;
    }
    if (!selectedTaskId) {
      setEvents([]);
      setSelectedTaskTimelineHistory({
        cursor: null,
        hasMoreHistory: false,
        isLoadingMore: false,
        error: null,
      });
      return;
    }
    if (remoteTaskView) {
      setEvents(capTaskEvents(remoteTaskView.events));
      setSelectedTaskTimelineHistory({
        cursor: null,
        hasMoreHistory: false,
        isLoadingMore: false,
        error: null,
      });
      const latestTimestamp = getLatestEventTimestamp(remoteTaskView.events);
      if (latestTimestamp > 0) {
        taskLastEventTimestampRef.current.set(selectedTaskId, latestTimestamp);
      }
      return;
    }

    // Load the initial projected timeline page from the database. The legacy
    // event history endpoint remains as a fallback for older preload bundles.
    if (!window.electronAPI?.getTaskTimelinePage && !window.electronAPI?.getTaskEvents) {
      setEvents([]);
      return;
    }

    const requestedTaskId = selectedTaskId;
    let cancelled = false;
    const latestAttentionEvent = latestAttentionEventByTaskIdRef.current.get(requestedTaskId);
    setEvents(latestAttentionEvent ? [latestAttentionEvent] : []);

    const loadHistoricalEvents = async () => {
      try {
        const startedAt = performance.now();
        const timelinePage = window.electronAPI.getTaskTimelinePage
          ? await window.electronAPI.getTaskTimelinePage({
              taskId: requestedTaskId,
              limit: 160,
              byteLimit: 512 * 1024,
              singleEventByteLimit: 64 * 1024,
            })
          : null;
        const historicalEvents =
          timelinePage?.events ?? (await window.electronAPI.getTaskEvents(requestedTaskId));
        if (cancelled) return;
        const receiveMs = performance.now() - startedAt;
        taskTimelinePageStateRef.current.set(requestedTaskId, {
          cursor: timelinePage?.nextCursor ?? null,
          hasMoreHistory: timelinePage?.hasMoreHistory === true,
        });
        setSelectedTaskTimelineHistory({
          cursor: timelinePage?.nextCursor ?? null,
          hasMoreHistory: timelinePage?.hasMoreHistory === true,
          isLoadingMore: false,
          error: null,
        });
        recordRendererPerfSample(
          "task-switch.timeline_receive_ms",
          receiveMs,
          rendererPerfLoggingEnabled,
        );
        const switchStartedAt = taskSwitchStartedAtRef.current.get(requestedTaskId);
        if (switchStartedAt != null) {
          recordRendererPerfSample(
            "task-switch.timeline_data_received_ms",
            performance.now() - switchStartedAt,
            rendererPerfLoggingEnabled,
          );
        }
        markRendererPerfEvent("timeline_data_received", rendererPerfLoggingEnabled, {
          taskId: requestedTaskId,
          switchId: taskSwitchIdByTaskIdRef.current.get(requestedTaskId),
          eventCount: historicalEvents.length,
          payloadBytes: timelinePage?.summary.payloadBytes,
          serializedPayloadBytes: timelinePage
            ? undefined
            : new Blob([JSON.stringify(historicalEvents)]).size,
          truncatedEventCount: timelinePage?.summary.truncatedEventCount,
          hasMoreHistory: timelinePage?.hasMoreHistory,
          receiveMs: Number(receiveMs.toFixed(1)),
        });
        startTransition(() => {
          setEvents((prev) =>
            capTaskEvents(
              mergeSelectedTaskTimelineEvents(requestedTaskId, prev, historicalEvents),
            ),
          );
        });
        const latestTimestamp = getLatestEventTimestamp(historicalEvents);
        if (latestTimestamp > 0) {
          taskLastEventTimestampRef.current.set(requestedTaskId, latestTimestamp);
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to load historical events:", error);
        setEvents([]);
      }
    };

    void loadHistoricalEvents();
    return () => {
      cancelled = true;
    };
  }, [mergeSelectedTaskTimelineEvents, rendererPerfLoggingEnabled, selectedTaskId, remoteTaskView]);

  const handleLoadTaskEventDetail = useCallback(async (eventId: string, taskId: string) => {
    const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    const cacheKey = `${normalizedTaskId}:${normalizedEventId}`;
    if (!normalizedTaskId || !normalizedEventId || eventDetailInFlightRef.current.has(cacheKey)) return;
    if (!window.electronAPI?.getTaskEventDetail) return;
    const missingUntil = eventDetailMissingUntilRef.current.get(cacheKey);
    if (missingUntil && missingUntil > Date.now()) return;
    if (missingUntil) eventDetailMissingUntilRef.current.delete(cacheKey);
    const cachedEvent = eventDetailCacheRef.current.get(cacheKey);
    if (cachedEvent) {
      setEvents((prev) =>
        prev.map((event) => {
          if (
            event.id === cachedEvent.id ||
            event.eventId === cachedEvent.eventId ||
            event.id === normalizedEventId ||
            event.eventId === normalizedEventId
          ) {
            return cachedEvent;
          }
          return event;
        }),
      );
      return;
    }
    eventDetailInFlightRef.current.add(cacheKey);
    try {
      const detail = await window.electronAPI.getTaskEventDetail({
        taskId: normalizedTaskId,
        eventId: normalizedEventId,
      });
      const detailedEvent = detail?.event;
      if (!detailedEvent) {
        const missing = eventDetailMissingUntilRef.current;
        missing.set(cacheKey, Date.now() + EVENT_DETAIL_NEGATIVE_CACHE_MS);
        while (missing.size > MAX_EVENT_DETAIL_CACHE_ENTRIES) {
          const oldestKey = missing.keys().next().value;
          if (!oldestKey) break;
          missing.delete(oldestKey);
        }
        return;
      }
      eventDetailMissingUntilRef.current.delete(cacheKey);
      const cache = eventDetailCacheRef.current;
      cache.set(cacheKey, detailedEvent);
      while (cache.size > MAX_EVENT_DETAIL_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (!oldestKey) break;
        cache.delete(oldestKey);
      }
      setEvents((prev) =>
        prev.map((event) => {
          if (
            event.id === detailedEvent.id ||
            event.eventId === detailedEvent.eventId ||
            event.id === normalizedEventId ||
            event.eventId === normalizedEventId
          ) {
            return detailedEvent;
          }
          return event;
        }),
      );
    } catch (error) {
      console.error("Failed to load event detail:", error);
    } finally {
      eventDetailInFlightRef.current.delete(cacheKey);
    }
  }, []);

  const handleLoadMoreTaskTimelineHistory = useCallback(async () => {
    if (timelineHistoryLoadInFlightRef.current) return;
    const taskId = selectedTaskIdRef.current;
    const state = taskId ? taskTimelinePageStateRef.current.get(taskId) : null;
    if (!taskId || !state?.hasMoreHistory || !state.cursor) return;
    if (!window.electronAPI?.getTaskTimelinePage) return;
    timelineHistoryLoadInFlightRef.current = true;
    setSelectedTaskTimelineHistory((current) => ({
      ...current,
      isLoadingMore: true,
      error: null,
    }));
    try {
      const timelinePage = await window.electronAPI.getTaskTimelinePage({
        taskId,
        cursor: state.cursor,
        limit: 160,
        byteLimit: 512 * 1024,
        singleEventByteLimit: 64 * 1024,
      });
      if (selectedTaskIdRef.current !== taskId) return;
      taskTimelinePageStateRef.current.set(taskId, {
        cursor: timelinePage.nextCursor,
        hasMoreHistory: timelinePage.hasMoreHistory,
      });
      setSelectedTaskTimelineHistory({
        cursor: timelinePage.nextCursor,
        hasMoreHistory: timelinePage.hasMoreHistory,
        isLoadingMore: false,
        error: null,
      });
      setEvents((prev) => {
        const merged = mergeSelectedTaskTimelineEvents(taskId, prev, timelinePage.events);
        return capTaskEventsPreservingIncoming(merged, timelinePage.events);
      });
      markRendererPerfEvent("timeline_history_page_received", rendererPerfLoggingEnabled, {
        taskId,
        eventCount: timelinePage.events.length,
        hasMoreHistory: timelinePage.hasMoreHistory,
        payloadBytes: timelinePage.summary.payloadBytes,
        truncatedEventCount: timelinePage.summary.truncatedEventCount,
      });
    } catch (error) {
      console.error("Failed to load older timeline history:", error);
      setSelectedTaskTimelineHistory((current) => ({
        ...current,
        isLoadingMore: false,
        error:
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to load earlier history.",
      }));
    } finally {
      timelineHistoryLoadInFlightRef.current = false;
    }
  }, [capTaskEventsPreservingIncoming, mergeSelectedTaskTimelineEvents, rendererPerfLoggingEnabled]);

  // Reconcile stale executing/interrupted task state if event delivery falls behind.
  useEffect(() => {
    if (!selectedTaskId || !window.electronAPI?.getTask) return;
    if (remoteTaskView) return;

    const currentTask = tasksRef.current.find(t => t.id === selectedTaskId);
    if (!currentTask || isTerminalTaskStatus(currentTask.status)) return;

    let cancelled = false;

    const reconcileStaleSelectedTask = async () => {
      if (staleTaskReconcileInFlightRef.current) return;

      const taskId = selectedTaskIdRef.current;
      if (!taskId) return;

      const currentTask = tasksRef.current.find((t) => t.id === taskId);
      if (!currentTask || !isTaskPossiblyRunning(currentTask.status)) return;

      const lastEventTs = taskLastEventTimestampRef.current.get(taskId) ?? 0;
      if (lastEventTs > 0 && Date.now() - lastEventTs < STALE_TASK_RECONCILE_IDLE_WINDOW_MS) {
        return;
      }

      staleTaskReconcileInFlightRef.current = true;
      try {
        const canonicalTask = await reconcileTaskFromCanonical(taskId, {
          refreshEventsWhenTerminal: true,
        });
        if (cancelled || !canonicalTask || canonicalTask.id !== taskId) return;
      } catch (error) {
        console.error("Failed to reconcile stale task status:", error);
      } finally {
        staleTaskReconcileInFlightRef.current = false;
      }
    };

    void reconcileStaleSelectedTask();
    const timer = window.setInterval(() => {
      void reconcileStaleSelectedTask();
    }, STALE_TASK_RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedTaskId, remoteTaskView, reconcileTaskFromCanonical]);

  // Queue updates are authoritative about whether a task is still running.
  // If the selected task disappears from the running set, reconcile it now
  // so collaborative panels do not keep showing a stale spinner.
  useEffect(() => {
    if (!selectedTaskId || !queueStatus || remoteTaskView) return;

    const currentTask = tasksRef.current.find((t) => t.id === selectedTaskId);
    if (!currentTask || !isTaskPossiblyRunning(currentTask.status)) return;
    if (queueStatus.runningTaskIds.includes(selectedTaskId)) return;
    if (staleTaskReconcileInFlightRef.current) return;

    let cancelled = false;
    staleTaskReconcileInFlightRef.current = true;

    void (async () => {
      try {
        await reconcileTaskFromCanonical(selectedTaskId, {
          refreshEventsWhenTerminal: true,
        });
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to reconcile selected task after queue completion:", error);
        }
      } finally {
        staleTaskReconcileInFlightRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [queueStatus, remoteTaskView, reconcileTaskFromCanonical, selectedTaskId]);

  // Load historical events from dispatched child tasks
  useEffect(() => {
    if (childTasks.length === 0) {
      setChildEvents([]);
      return;
    }
    if (remoteTaskView) {
      setChildEvents([]);
      return;
    }
    if (!window.electronAPI?.getTaskEvents) return;

    const loadChildHistoricalEvents = async () => {
      try {
        const allEvents: TaskEvent[] = [];
        for (const child of childTasks) {
          const evts = await window.electronAPI.getTaskEvents(child.id);
          allEvents.push(...evts);
        }
        allEvents.sort((a, b) => a.timestamp - b.timestamp);
        setChildEvents(capTaskEvents(mergeUniqueTaskEvents([], allEvents), MAX_RENDERER_CHILD_EVENTS));
      } catch (error) {
        console.error("Failed to load child task events:", error);
      }
    };

    loadChildHistoricalEvents();

    // Periodically re-fetch events while any child task is still executing
    // to catch events missed during the initial race window
    const hasExecutingChildren = childTasks.some(
      (t) => t.status === "executing" || t.status === "planning",
    );
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (hasExecutingChildren) {
      pollTimer = setInterval(() => {
        const currentChildren = tasksRef.current.filter(
          (t) => t.parentTaskId === selectedTaskIdRef.current && t.agentType === "sub"
        );
        if (!currentChildren.some(t => t.status === "executing" || t.status === "planning")) {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          return;
        }
        loadChildHistoricalEvents();
      }, 15_000);
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
    // Re-load when child tasks change (new children appear)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childTasks.map((c) => `${c.id}:${c.status}`).join(","), remoteTaskView, selectedTaskId]);

  // Keep startup light: load the first sidebar page, then page in more sessions
  // only when the user scrolls. The sidebar-prioritized DB order keeps pinned
  // and active sessions visible even if they are older than the recent page.
  const INITIAL_TASK_LOAD = 60;
  const TASK_LOAD_MORE = 80;
  const TASK_PAGE_LOOKAHEAD = 1;
  const MAIN_SIDEBAR_EXCLUDED_TASK_SOURCES: Array<NonNullable<Task["source"]>> = [
    "managed_agent_panel",
    "side_chat",
  ];

  // Refs let loadMoreTasks read current state without being in its dep array
  // (avoids re-creating the callback — and re-subscribing the scroll listener
  // — every time hasMoreTasks or offset changes).
  const taskOffsetRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const hasMoreTasksRef = useRef(false);
  const sidebarTaskCursorRef = useRef<{
    id: string;
    pinned?: boolean;
    status?: Task["status"];
    updatedAt?: number;
    createdAt?: number;
  } | null>(null);

  const toSidebarTaskCursor = useCallback((task: Task | undefined) => {
    if (!task?.id) return null;
    return {
      id: task.id,
      pinned: task.pinned,
      status: task.status,
      updatedAt: task.updatedAt,
      createdAt: task.createdAt,
    };
  }, []);

  const loadTasks = useCallback(async () => {
    setIsInitialTaskListLoading(true);
    const listSidebarTasks = window.electronAPI?.listSidebarTasks ?? window.electronAPI?.listTasks;
    if (!listSidebarTasks) {
      setTasks([]);
      setHasMoreTasks(false);
      hasMoreTasksRef.current = false;
      setIsInitialTaskListLoading(false);
      return;
    }
    try {
      taskOffsetRef.current = 0;
      sidebarTaskCursorRef.current = null;
      isLoadingMoreRef.current = false;
      setIsLoadingMoreTasks(false);
      const startedAt = performance.now();
      markRendererPerfEvent("sidebar_request_start", rendererPerfLoggingEnabled, {
        limit: INITIAL_TASK_LOAD + TASK_PAGE_LOOKAHEAD,
        offset: 0,
      });
      const loadedTaskPage = await listSidebarTasks({
        limit: INITIAL_TASK_LOAD + TASK_PAGE_LOOKAHEAD,
        offset: 0,
        prioritizeSidebar: true,
        excludeSources: MAIN_SIDEBAR_EXCLUDED_TASK_SOURCES,
      });
      const receiveMs = performance.now() - startedAt;
      recordRendererPerfSample(
        "sidebar.data_receive_ms",
        receiveMs,
        rendererPerfLoggingEnabled,
      );
      markRendererPerfEvent("sidebar_data_received", rendererPerfLoggingEnabled, {
        rowCount: loadedTaskPage.length,
        receiveMs: Number(receiveMs.toFixed(1)),
      });
      const loadedTasks = loadedTaskPage.slice(0, INITIAL_TASK_LOAD);
      setTasks((prev) =>
        mergeSidebarInitialPageWithSelectedTask(
          prev,
          loadedTasks,
          selectedTaskIdRef.current,
        ),
      );
      const more = loadedTaskPage.length > INITIAL_TASK_LOAD;
      setHasMoreTasks(more);
      hasMoreTasksRef.current = more;
      taskOffsetRef.current = loadedTasks.length;
      sidebarTaskCursorRef.current = toSidebarTaskCursor(loadedTasks.at(-1));
    } catch (error) {
      console.error("Failed to load tasks:", error);
    } finally {
      setIsInitialTaskListLoading(false);
    }
  }, [rendererPerfLoggingEnabled, toSidebarTaskCursor]);

  const loadMoreTasks = useCallback(async () => {
    const listSidebarTasks = window.electronAPI?.listSidebarTasks ?? window.electronAPI?.listTasks;
    if (!listSidebarTasks || isLoadingMoreRef.current || !hasMoreTasksRef.current) {
      return;
    }
    isLoadingMoreRef.current = true;
    setIsLoadingMoreTasks(true);
    try {
      const offset = taskOffsetRef.current;
      const cursor = sidebarTaskCursorRef.current;
      const moreTaskPage = await listSidebarTasks({
        limit: TASK_LOAD_MORE + TASK_PAGE_LOOKAHEAD,
        offset: cursor ? undefined : offset,
        cursor: cursor ?? undefined,
        prioritizeSidebar: true,
        excludeSources: MAIN_SIDEBAR_EXCLUDED_TASK_SOURCES,
      });
      const moreTasks = moreTaskPage.slice(0, TASK_LOAD_MORE);
      if (moreTasks.length > 0) {
        setTasks((prev) => {
          const mergedPage = mergeSidebarTaskSummariesWithExisting(prev, moreTasks);
          const mergedById = new Map(mergedPage.map((task) => [task.id, task]));
          const existingIds = new Set(prev.map((t) => t.id));
          let changed = false;
          const updatedPrev = prev.map((task) => {
            const merged = mergedById.get(task.id);
            if (!merged) return task;
            const updated = mergeTaskPreservingIdentity(task, merged);
            if (updated !== task) changed = true;
            return updated;
          });
          const fresh = mergedPage.filter((task) => !existingIds.has(task.id));
          return changed || fresh.length > 0 ? [...updatedPrev, ...fresh] : prev;
        });
        taskOffsetRef.current = offset + moreTasks.length;
        sidebarTaskCursorRef.current = toSidebarTaskCursor(moreTasks.at(-1));
      }
      const more = moreTaskPage.length > TASK_LOAD_MORE;
      setHasMoreTasks(more);
      hasMoreTasksRef.current = more;
    } catch (error) {
      console.error("Failed to load more tasks:", error);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMoreTasks(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectWorkspace = useCallback(
    async (workspace: Workspace) => {
      if (selectedTaskId && !remoteTaskView && window.electronAPI?.updateTaskWorkspace) {
        try {
          const updatedTask = (await window.electronAPI.updateTaskWorkspace(
            selectedTaskId,
            workspace.id,
          )) as Task | undefined;
          setTasks((prev) =>
            updateTaskPreservingIdentity(prev, selectedTaskId, (task) =>
              mergeTaskPreservingIdentity(task, updatedTask ?? { workspaceId: workspace.id }),
            ),
          );
        } catch (error) {
          console.error("Failed to update task workspace:", error);
          addToast({
            type: "error",
            title: "Workspace Error",
            message: error instanceof Error ? error.message : "Could not apply the workspace to this chat.",
          });
          return;
        }
      }

      setCurrentWorkspace(workspace);
    },
    [addToast, remoteTaskView, selectedTaskId],
  );

  // Handle workspace change - opens folder selection dialog directly
  const handleChangeWorkspace = async () => {
    try {
      const pickerDefaultPath =
        currentWorkspace && !currentWorkspace.isTemp && !isTempWorkspaceId(currentWorkspace.id)
          ? currentWorkspace.path
          : undefined;

      // Open folder selection dialog
      const folderPath = await window.electronAPI.selectFolder(pickerDefaultPath);
      if (!folderPath) return; // User cancelled

      // Get list of existing workspaces for reference
      const existingWorkspaces = await window.electronAPI.listWorkspaces();

      // Check if this folder is already a workspace
      const existingWorkspace = existingWorkspaces.find((w: Workspace) => w.path === folderPath);
      if (existingWorkspace) {
        await handleSelectWorkspace(existingWorkspace);
        return;
      }

      // Create a new workspace for this folder
      const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
      const permissionSettings = await window.electronAPI.getPermissionSettings().catch(() => null);
      const workspace = await window.electronAPI.createWorkspace({
        name: folderName,
        path: folderPath,
        permissions: {
          read: true,
          write: true,
          delete: true,
          network: true,
          shell: permissionSettings?.defaultShellEnabled === true,
        },
      });

      await handleSelectWorkspace(workspace);
    } catch (error) {
      console.error("Failed to change workspace:", error);
    }
  };

  const handleCreateTask = async (
    title: string,
    prompt: string,
    options?: {
      autonomousMode?: boolean;
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      collaborativeMode?: boolean;
      multiLlmMode?: boolean;
      multiLlmConfig?: MultiLlmConfig;
      multitaskMode?: boolean;
      multitaskLaneCount?: number;
      multitaskAssignmentMode?: "auto_split";
      verificationAgent?: boolean;
      executionMode?: ExecutionMode;
      taskDomain?: TaskDomain;
      chronicleMode?: "inherit" | "enabled" | "disabled";
      videoGenerationMode?: boolean;
      llmProfile?: LlmProfile;
      llmProfileForced?: boolean;
      agentConfig?: AgentConfig;
      integrationMentions?: IntegrationMentionSelection[];
    },
    images?: ImageAttachment[],
    workspaceOverride?: Workspace,
  ) => {
    const effectiveWorkspace = workspaceOverride ?? currentWorkspace;
    if (!effectiveWorkspace) return;

    const multitaskCommand = findMultitaskCommand(prompt, title);
    if (multitaskCommand?.isMultitask && !multitaskCommand.valid) {
      addToast({
        type: "error",
        title: "Multitask request needed",
        message: multitaskCommand.error || "Add a request after /multitask.",
      });
      return;
    }
    const isMultitaskCommand = Boolean(multitaskCommand?.valid);
    const effectivePrompt = isMultitaskCommand ? multitaskCommand!.prompt : prompt;
    const titleMultitaskCommand = parseMultitaskCommand(title);
    const effectiveTitle = isMultitaskCommand
      ? (titleMultitaskCommand.valid
          ? titleMultitaskCommand.prompt
          : multitaskCommand!.prompt
        ).slice(0, 500)
      : title;

    // Auto-enable collaborative mode when prompt requests spawning subagents/agents
    // (e.g. "spawn 3 subagents", "spawn agents") — before any other processing
    const spawnIntent = isSpawnSubagentsPrompt(`${effectiveTitle}\n${effectivePrompt}`);
    const requestedCollaborative =
      options?.collaborativeMode === true || spawnIntent || isMultitaskCommand;
    const requestedAutonomous = options?.autonomousMode === true;
    const requestedMultiLlm = options?.multiLlmMode === true;
    const autonomousMode = requestedAutonomous && !requestedCollaborative && !requestedMultiLlm;
    const collaborativeMode = requestedCollaborative && !requestedMultiLlm;
    const multiLlmMode = requestedMultiLlm;

    if (requestedAutonomous && requestedCollaborative) {
      addToast({
        type: "info",
        title: "Collaborative mode selected",
        message: "Autonomous mode is disabled when collaborative mode is enabled.",
      });
    }
    if (spawnIntent && !options?.collaborativeMode) {
      addToast({
        type: "info",
        title: "Collaborative mode enabled",
        message: "Your prompt requests spawning agents — the task will be handled by the collaborative team.",
      });
    }

    if (autonomousMode) {
      const shouldContinue = window.confirm(
        "Autonomous mode allows the agent to proceed without manual confirmation on gated actions. Continue?",
      );
      if (!shouldContinue) return;
    }

    const verificationAgent = options?.verificationAgent === true;
    const executionMode = options?.executionMode;
    const taskDomain = options?.taskDomain;
    const chronicleMode = options?.chronicleMode;
    const videoGenerationMode = options?.videoGenerationMode === true;
    const permissionMode = options?.permissionMode;
    const shellAccess = options?.shellAccess === true;
    const llmProfile = options?.llmProfile;
    const llmProfileForced = options?.llmProfileForced;
    const explicitAgentConfig = options?.agentConfig;
    const integrationMentions =
      options?.integrationMentions && options.integrationMentions.length > 0
        ? options.integrationMentions
        : undefined;
    const trimmedSessionModelOverride = sessionModelOverride.trim();
    const hasSelectedModelInCurrentProvider = availableModels.some((m) => m.key === trimmedSessionModelOverride);
    const effectiveSessionModelOverride = hasSelectedModelInCurrentProvider ? trimmedSessionModelOverride : "";
    const effectiveLlmProfile = effectiveSessionModelOverride ? undefined : llmProfile;
    const effectiveLlmProfileForced = effectiveSessionModelOverride ? false : llmProfileForced;

    const agentConfig =
      effectiveSessionModelOverride ||
      autonomousMode ||
      collaborativeMode ||
      isMultitaskCommand ||
      options?.multitaskMode ||
      multiLlmMode ||
      verificationAgent ||
      executionMode ||
      taskDomain ||
      chronicleMode ||
      videoGenerationMode ||
      permissionMode ||
      shellAccess ||
      integrationMentions ||
      effectiveLlmProfile ||
      explicitAgentConfig
        ? {
            ...explicitAgentConfig,
            ...(effectiveSessionModelOverride ? { modelKey: effectiveSessionModelOverride } : {}),
            ...(autonomousMode
              ? { allowUserInput: false, humanInputPolicy: "none" as const, autonomousMode: true }
              : {}),
            ...(collaborativeMode ? { collaborativeMode: true } : {}),
            ...(isMultitaskCommand || options?.multitaskMode
              ? {
                  multitaskMode: true,
                  multitaskLaneCount:
                    multitaskCommand?.laneCount || options?.multitaskLaneCount || 4,
                  multitaskAssignmentMode:
                    multitaskCommand?.assignmentMode ||
                    options?.multitaskAssignmentMode ||
                    "auto_split",
                }
              : {}),
            ...(multiLlmMode
              ? { multiLlmMode: true, multiLlmConfig: options?.multiLlmConfig }
              : {}),
            ...(verificationAgent ? { verificationAgent: true } : {}),
            ...(executionMode ? { executionMode } : {}),
            ...(taskDomain ? { taskDomain } : {}),
            ...(chronicleMode ? { chronicleMode } : {}),
            ...(videoGenerationMode ? { videoGenerationMode: true } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(shellAccess ? { shellAccess: true } : {}),
            ...(integrationMentions ? { integrationMentions } : {}),
            ...(effectiveLlmProfile ? { llmProfile: effectiveLlmProfile } : {}),
            ...(effectiveLlmProfileForced ? { llmProfileForced: true } : {}),
          }
        : undefined;

    try {
      if (window.electronAPI?.getLLMSettings) {
        const llmSettings = await window.electronAPI.getLLMSettings();
        const readiness = getFirstRunReadiness(llmSettings, { workspace: effectiveWorkspace });
        if (!readiness.modelReady) {
          addToast({
            type: "error",
            title: "Set up AI first",
            message:
              readiness.blockingReason ||
              "Connect ChatGPT, local Ollama, or an API key before running AI tasks.",
            action: {
              label: getFirstRunReadinessActionLabel(readiness),
              callback: () => {
                setSettingsTab("llm");
                setCurrentView("settings");
              },
            },
          });
          return;
        }
      }

      const task = await window.electronAPI.createTask({
        title: effectiveTitle,
        prompt: effectivePrompt,
        workspaceId: effectiveWorkspace.id,
        ...(agentConfig && { agentConfig }),
        ...(images && images.length > 0 && { images }),
      });

      setTasks((prev) => [task, ...prev]);
      setSelectedTaskId(task.id);
      setCurrentView("main");
    } catch (error: unknown) {
      console.error("Failed to create task:", error);
      // Check if it's an API key error and prompt user to configure settings
      const errorMessage = error instanceof Error ? error.message : "Failed to create task";
      if (errorMessage.includes("API key") || errorMessage.includes("credentials")) {
        addToast({
          type: "error",
          title: "Configuration Required",
          message: errorMessage,
          action: {
            label: "Open Settings",
            callback: () => {
              setSettingsTab("llm");
              setCurrentView("settings");
            },
          },
        });
      } else {
        addToast({ type: "error", title: "Task Error", message: errorMessage });
      }
    }
  };

  const handleOpenManagedAgentTask = useCallback(async (taskId: string) => {
    setCurrentView("main");
    setSelectedTaskId(taskId);
    try {
      const task = (await window.electronAPI.getTask(taskId)) as Task | null;
      if (task) {
        setTasks((prev) => upsertTaskPreservingIdentity(prev, task, { prependIfMissing: true }));
      }
    } catch (error) {
      console.error("Failed to open managed agent task:", error);
    }
  }, []);

  const handleAskInboxFromComposer = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setInboxAgentAskRequest({ id: Date.now(), query: trimmed });
    setCurrentView("inboxAgent");
  }, []);

  const handleCloseSideChat = useCallback(() => {
    sideChatRequestSeqRef.current += 1;
    setSideChat(null);
    sideChatRef.current = null;
  }, []);

  const handleSendSideChatMessage = useCallback(async (message: string) => {
    const trimmed = message.trim();
    const sideTaskId = sideChatRef.current?.task?.id;
    if (!trimmed || !sideTaskId) return;
    setSideChat((prev) => (prev?.task?.id === sideTaskId ? { ...prev, sending: true } : prev));
    try {
      await window.electronAPI.sendMessage(sideTaskId, trimmed);
      const [updatedTask, updatedEvents] = await Promise.all([
        window.electronAPI.getTask(sideTaskId).catch(() => null),
        window.electronAPI.getTaskEvents(sideTaskId).catch(() => []),
      ]);
      setSideChat((prev) =>
        prev?.task?.id === sideTaskId
          ? {
              ...prev,
              task: (updatedTask as Task | null) || prev.task,
              events: capTaskEvents(mergeUniqueTaskEvents(prev.events, updatedEvents as TaskEvent[])),
              sending: false,
              loading: false,
            }
          : prev,
      );
    } catch (error) {
      console.error("Failed to send sidechat message:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to send side message";
      addToast({ type: "error", title: "Side Chat Error", message: errorMessage });
      setSideChat((prev) => (prev?.task?.id === sideTaskId ? { ...prev, sending: false } : prev));
      throw error;
    }
  }, []);

  const handleOpenSideChatFullThread = useCallback(async (taskId: string) => {
    sideChatRequestSeqRef.current += 1;
    setSideChat(null);
    sideChatRef.current = null;
    setCurrentView("main");
    setSelectedTaskId(taskId);
    try {
      const task = (await window.electronAPI.getTask(taskId)) as Task | null;
      if (task) {
        setTasks((prev) => upsertTaskPreservingIdentity(prev, task, { prependIfMissing: true }));
      }
    } catch (error) {
      console.error("Failed to open sidechat as full thread:", error);
    }
  }, []);

  const handleOpenSideChat = useCallback(
    async (request: { taskId: string; fromEventId?: string; initialMessage?: string }) => {
      if (!window.electronAPI?.forkTaskSession) return;
      const requestSeq = sideChatRequestSeqRef.current + 1;
      sideChatRequestSeqRef.current = requestSeq;
      const parentTaskId = request.taskId;
      const initialMessage = request.initialMessage?.trim();
      const parentTask =
        tasksRef.current.find((candidate) => candidate.id === parentTaskId) ||
        ((await window.electronAPI.getTask(parentTaskId).catch(() => null)) as Task | null);
      if (sideChatRequestSeqRef.current !== requestSeq) return;
      const existing = sideChatRef.current;
      if (
        existing?.parentTaskId === parentTaskId &&
        existing.task?.id &&
        !request.fromEventId
      ) {
        setRightSidebarCollapsed(false);
        if (parentTask) {
          setSideChat((prev) =>
            prev?.parentTaskId === parentTaskId ? { ...prev, parentTask } : prev,
          );
        }
        if (initialMessage) {
          try {
            await handleSendSideChatMessage(initialMessage);
          } catch {
            // The send handler already reports the failure and restores panel state.
          }
        }
        return;
      }

      setCurrentView("main");
      setRightSidebarCollapsed(false);
      setSideChat({
        parentTaskId,
        parentTask,
        task: null,
        events: [],
        loading: true,
        sending: Boolean(initialMessage),
      });

      try {
        const forkedTask = (await window.electronAPI.forkTaskSession({
          taskId: parentTaskId,
          branchLabel: "side-chat",
          sideChat: true,
          ...(initialMessage ? { initialMessage } : {}),
          ...(request.fromEventId ? { fromEventId: request.fromEventId } : {}),
        })) as Task;
        if (sideChatRequestSeqRef.current !== requestSeq) {
          void window.electronAPI.deleteTask?.(forkedTask.id).catch((deleteError) => {
            console.error("Failed to delete stale sidechat task:", deleteError);
          });
          return;
        }
        const forkedEvents = (await window.electronAPI
          .getTaskEvents(forkedTask.id)
          .catch(() => [])) as TaskEvent[];
        if (sideChatRequestSeqRef.current !== requestSeq) {
          void window.electronAPI.deleteTask?.(forkedTask.id).catch((deleteError) => {
            console.error("Failed to delete stale sidechat task:", deleteError);
          });
          return;
        }
        const cappedForkedEvents = capTaskEvents(forkedEvents);
        const initialMessageStillSending =
          Boolean(initialMessage) &&
          !isTerminalTaskStatus(forkedTask.status) &&
          !cappedForkedEvents.some((event) => getEffectiveTaskEventType(event) === "assistant_message");
        setSideChat({
          parentTaskId,
          parentTask,
          task: forkedTask,
          events: cappedForkedEvents,
          loading: false,
          sending: initialMessageStillSending,
        });
        sideChatRef.current = {
          parentTaskId,
          parentTask,
          task: forkedTask,
          events: cappedForkedEvents,
          loading: false,
          sending: initialMessageStillSending,
        };
      } catch (error) {
        if (sideChatRequestSeqRef.current !== requestSeq) return;
        console.error("Failed to open sidechat:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to open side chat";
        addToast({ type: "error", title: "Side Chat Error", message: errorMessage });
        setSideChat(null);
      }
    },
    [handleSendSideChatMessage],
  );

  const replayControls = useReplayMode(events, selectedTask);
  const deferredEvents = useDeferredValue(events);
  const selectedTaskUsesLiveProjection =
    !replayControls.isReplayMode && isTaskPossiblyRunning(selectedTask?.status);
  const projectedTaskEvents = selectedTaskUsesLiveProjection ? deferredEvents : events;
  const sharedTaskEventUi = useMemo(
    () =>
      measureRendererPerf("App.sharedTaskEventUi", rendererPerfLoggingEnabled, () =>
        deriveSharedTaskEventUiState({
          rawEvents: projectedTaskEvents,
          task: selectedTask,
          workspace: currentWorkspace,
          verboseSteps: false,
          projectionMode: selectedTaskUsesLiveProjection ? "live" : "inspect",
          liveWindowSize: 160,
        }),
      ),
    [
      currentWorkspace?.id,
      currentWorkspace?.path,
      projectedTaskEvents,
      rendererPerfLoggingEnabled,
      selectedTask,
      selectedTaskUsesLiveProjection,
    ],
  );
  const rightPanelReplayTask = useMemo(
    () =>
      replayControls.isReplayMode
        ? deriveReplayTaskSnapshot(selectedTask, replayControls.replayEvents)
        : selectedTask,
    [replayControls.isReplayMode, replayControls.replayEvents, selectedTask],
  );
  const rightPanelEvents = replayControls.isReplayMode
    ? replayControls.replayEvents
    : projectedTaskEvents;
  const rightPanelSharedTaskEventUi = useMemo(
    () => {
      if (!replayControls.isReplayMode) return sharedTaskEventUi;
      return measureRendererPerf("App.rightPanelReplayTaskEventUi", rendererPerfLoggingEnabled, () =>
        deriveSharedTaskEventUiState({
          rawEvents: replayControls.replayEvents,
          task: rightPanelReplayTask,
          workspace: currentWorkspace,
          verboseSteps: false,
        }),
      );
    },
    [
      currentWorkspace?.id,
      currentWorkspace?.path,
      replayControls.isReplayMode,
      replayControls.replayEvents,
      rendererPerfLoggingEnabled,
      rightPanelReplayTask,
      sharedTaskEventUi,
    ],
  );
  const rightPanelChildTasks = remoteTaskView ? [] : childTasks;
  const rightPanelHasActiveChildren = useMemo(
    () =>
      rightPanelChildTasks.some((task) =>
        ["executing", "planning", "queued", "pending"].includes(task.status),
      ),
    [rightPanelChildTasks],
  );
  const rightPanelRunningTasks = useMemo(
    () => (queueStatus ? tasks.filter((task) => queueStatus.runningTaskIds.includes(task.id)) : []),
    [queueStatus, tasks],
  );
  const rightPanelQueuedTasks = useMemo(
    () => (queueStatus ? tasks.filter((task) => queueStatus.queuedTaskIds.includes(task.id)) : []),
    [queueStatus, tasks],
  );
  const rightPanelHighlightPath = useMemo(
    () =>
      selectedTaskId && rightPanelHighlight?.taskId === selectedTaskId
        ? rightPanelHighlight.path
        : null,
    [rightPanelHighlight, selectedTaskId],
  );
  const rightPanelInput = useMemo(
    () => ({
      task: rightPanelReplayTask,
      workspace: currentWorkspace,
      events: rightPanelEvents,
      sharedTaskEventUi: rightPanelSharedTaskEventUi,
      hasActiveChildren: replayControls.isReplayMode ? false : rightPanelHasActiveChildren,
      childTasks: replayControls.isReplayMode ? [] : rightPanelChildTasks,
      childEvents: replayControls.isReplayMode ? [] : childEvents,
      runningTasks: replayControls.isReplayMode ? [] : rightPanelRunningTasks,
      queuedTasks: replayControls.isReplayMode ? [] : rightPanelQueuedTasks,
      queueStatus: replayControls.isReplayMode ? null : queueStatus,
      highlightOutputPath: replayControls.isReplayMode ? null : rightPanelHighlightPath,
    }),
    [
      currentWorkspace,
      queueStatus,
      replayControls.isReplayMode,
      rightPanelHasActiveChildren,
      rightPanelHighlightPath,
      rightPanelEvents,
      rightPanelChildTasks,
      rightPanelQueuedTasks,
      rightPanelReplayTask,
      rightPanelRunningTasks,
      rightPanelSharedTaskEventUi,
      childEvents,
    ],
  );
  const deferredRightPanelInput = useDeferredValue(rightPanelInput);
  const activeInputRequest = useMemo(() => {
    if (remoteTaskView) return null;
    if (!selectedTaskId) return null;
    const candidates = pendingInputRequests.filter(
      (request) => request.taskId === selectedTaskId && request.status === "pending",
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => b.requestedAt - a.requestedAt)[0];
  }, [pendingInputRequests, selectedTaskId, remoteTaskView]);

  const clearRemoteTaskView = useCallback(() => {
    setRemoteTaskView(null);
  }, []);

  const openRemoteTaskView = useCallback(
    async (taskId: string, remote: { deviceId: string; deviceName: string }) => {
      try {
        const [taskResult, eventsResult] = await Promise.all([
          window.electronAPI?.deviceProxyRequest?.({
            deviceId: remote.deviceId,
            method: "task.get",
            params: { taskId },
          }),
          window.electronAPI?.deviceProxyRequest?.({
            deviceId: remote.deviceId,
            method: "task.events",
            params: { taskId, limit: 600 },
          }),
        ]);

        const remoteTask = (taskResult?.payload as { task?: Task | null } | undefined)?.task;
        const remoteEvents =
          ((eventsResult?.payload as { events?: TaskEvent[] } | undefined)?.events || []).sort(
            (a, b) => a.timestamp - b.timestamp,
          );
        if (!remoteTask) return;

        setRemoteTaskView({
          deviceId: remote.deviceId,
          deviceName: remote.deviceName,
          task: remoteTask,
          events: remoteEvents,
        });
        setSelectedTaskId(remoteTask.id);
        setCurrentView("main");
        setRightSidebarCollapsed(true);
      } catch (error) {
        console.error("Failed to open remote task view:", error);
        addToast({
          type: "error",
          title: "Remote task unavailable",
          message: "Could not load the remote task history for this device.",
        });
      }
    },
    [],
  );

  const handleSendMessage = async (
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      integrationMentions?: IntegrationMentionSelection[];
    },
  ) => {
    if (!selectedTaskId) return;

    try {
      const sentAt = Date.now();
      if (remoteTaskView) {
        setRemoteTaskView((prev) =>
          prev && prev.task.id === selectedTaskId
            ? { ...prev, task: { ...prev.task, updatedAt: sentAt } }
            : prev,
        );
      } else {
        setTasks((prev) =>
          updateTaskPreservingIdentity(prev, selectedTaskId, (task) =>
            mergeTaskPreservingIdentity(task, { updatedAt: sentAt }),
          ),
        );
      }

      const selectedTask = tasksRef.current.find((task) => task.id === selectedTaskId);
      const latestAttentionEvent = latestAttentionEventByTaskIdRef.current.get(selectedTaskId);
      const latestAttentionReason =
        typeof latestAttentionEvent?.payload?.reason === "string"
          ? latestAttentionEvent.payload.reason
          : undefined;
      const isShellPermissionPause =
        isShellPermissionPauseReason(selectedTask?.awaitingUserInputReasonCode) ||
        isShellPermissionPauseReason(latestAttentionReason);
      const shellPermissionDecision = isShellPermissionPause
        ? classifyShellPermissionDecision(message)
        : "unknown";
      let nextMessage = message;

      if (
        shellPermissionDecision === "enable_shell" &&
        currentWorkspace &&
        !currentWorkspace.permissions.shell
      ) {
        try {
          const updatedWorkspace = await window.electronAPI.updateWorkspacePermissions(
            currentWorkspace.id,
            { shell: true },
          );
          if (updatedWorkspace) {
            setCurrentWorkspace(updatedWorkspace);
          }
        } catch (permissionError) {
          console.error("Failed to pre-enable shell from user message:", permissionError);
        }
        nextMessage = "Please continue with shell access enabled for this workspace.";
      } else if (shellPermissionDecision === "continue_without_shell") {
        nextMessage = "Please continue without shell access and use the limited best-effort path.";
      }

      if (remoteTaskView) {
        await window.electronAPI?.deviceProxyRequest?.({
          deviceId: remoteTaskView.deviceId,
          method: "task.sendMessage",
          params: {
            taskId: selectedTaskId,
            message: nextMessage,
            images,
            quotedAssistantMessage,
            ...(options || {}),
          },
        });
      } else {
        await window.electronAPI.sendMessage(
          selectedTaskId,
          nextMessage,
          images,
          quotedAssistantMessage,
          options,
        );
      }
    } catch (error: unknown) {
      console.error("Failed to send message:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to send message";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleEnableShellForPausedTask = useCallback(async () => {
    if (remoteTaskView) return;
    await handleSendMessage("enable shell");
  }, [handleSendMessage, remoteTaskView]);

  const handleContinueWithoutShellForPausedTask = useCallback(async () => {
    if (remoteTaskView) return;
    await handleSendMessage("continue without shell");
  }, [handleSendMessage, remoteTaskView]);

  const handleCancelTask = async () => {
    if (!selectedTaskId) return;

    if (remoteTaskView) {
      setRemoteTaskView((prev) =>
        prev && prev.task.id === selectedTaskId
          ? { ...prev, task: { ...prev.task, status: "cancelled" as Task["status"] } }
          : prev,
      );
    } else {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === selectedTaskId ? { ...t, status: "cancelled" as Task["status"] } : t,
        ),
      );
    }

    try {
      if (remoteTaskView) {
        await window.electronAPI?.deviceProxyRequest?.({
          deviceId: remoteTaskView.deviceId,
          method: "task.cancel",
          params: { taskId: selectedTaskId },
        });
      } else {
        await window.electronAPI.cancelTask(selectedTaskId);
      }
    } catch (error: unknown) {
      console.error("Failed to cancel task:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to cancel task";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleWrapUpTask = async () => {
    if (!selectedTaskId) return;
    if (remoteTaskView) {
      addToast({
        type: "info",
        title: "Remote session view",
        message: "Wrap up from the remote device directly is not available yet.",
      });
      return;
    }

    try {
      const collaborativeRun = await window.electronAPI.findTeamRunByRootTask(selectedTaskId);
      if (collaborativeRun?.collaborativeMode && collaborativeRun.status === "running") {
        await window.electronAPI.wrapUpTeamRun(collaborativeRun.id);
      } else {
        await window.electronAPI.wrapUpTask(selectedTaskId);
      }
    } catch (error: unknown) {
      console.error("Failed to wrap up task:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to wrap up task";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleCancelTaskById = async (taskId: string) => {
    try {
      await window.electronAPI.cancelTask(taskId);
    } catch (error: unknown) {
      console.error("Failed to cancel task:", error);
    }
  };

  const handleQuickTask = async (prompt: string) => {
    if (!currentWorkspace) return;

    const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
    setCurrentView("main");
    clearRemoteTaskView();
    await handleCreateTask(title, prompt);
  };

  const handleCreateTaskFromIdea = async (prompt: string) => {
    setCurrentView("main");
    clearRemoteTaskView();
    let workspace = currentWorkspace;
    if (!workspace) {
      try {
        workspace = await window.electronAPI.getTempWorkspace({ createNew: true });
        setCurrentWorkspace(workspace);
      } catch (error) {
        console.error("Failed to get workspace for idea:", error);
        addToast({ type: "error", title: "Error", message: "Could not create session" });
        return;
      }
    }
    const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
    await handleCreateTask(title, prompt, undefined, undefined, workspace || undefined);
  };

  const handleNewSession = async () => {
    setCurrentView("main");
    setSelectedTaskId(null);
    setEvents([]);
    clearRemoteTaskView();
    try {
      const tempWorkspace = await window.electronAPI.getTempWorkspace({ createNew: true });
      setCurrentWorkspace(tempWorkspace);
    } catch (error) {
      console.error("Failed to switch to temp workspace for new session:", error);
    }
  };

  const handleClearTaskView = () => {
    setCurrentView("main");
    setSelectedTaskId(null);
    setEvents([]);
    clearRemoteTaskView();
  };

  const handleModelChange = async (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => {
    const modelKey = selection.modelKey.trim();
    if (!modelKey) return;
    const providerType = selection.providerType || selectedProvider;
    setSelectedModel(modelKey);
    setSelectedProvider(providerType);
    setSelectedReasoningEffort(selection.reasoningEffort);
    setSessionModelOverride("");
    try {
      await window.electronAPI?.setLLMModel?.({
        providerType,
        modelKey,
        ...(selection.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      });
      await loadLLMConfig();
    } catch (error) {
      console.error("Failed to save LLM model selection:", error);
      addToast({
        type: "error",
        title: "Model not saved",
        message:
          error instanceof Error
            ? error.message
            : "Could not update the default model.",
      });
    }
    // When model changes during a task, clear the current task to start fresh
    if (selectedTaskId) {
      setSelectedTaskId(null);
      setEvents([]);
      clearRemoteTaskView();
    }
  };

  const handleThemeChange = (theme: ThemeMode) => {
    setThemeMode(theme);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode: theme,
      visualTheme,
      accentColor,
      transparencyEffectsEnabled,
    });
  };

  const handleVisualThemeChange = (visual: VisualTheme) => {
    setVisualTheme(visual);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme: visual,
      accentColor,
      transparencyEffectsEnabled,
    });
  };

  const handleAccentChange = (accent: AccentColor) => {
    setAccentColor(accent);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme,
      accentColor: accent,
      transparencyEffectsEnabled,
    });
  };

  const handleUiDensityChange = (density: UiDensity) => {
    setUiDensity(density);
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme,
      accentColor,
      transparencyEffectsEnabled,
      uiDensity: density,
    });
  };

  const handleTransparencyEffectsEnabledChange = (enabled: boolean) => {
    setTransparencyEffectsEnabled(enabled);
    void window.electronAPI?.saveAppearanceSettings?.({
      transparencyEffectsEnabled: enabled,
    });
  };

  const handleDevRunLoggingEnabledChange = (enabled: boolean) => {
    setDevRunLoggingEnabled(enabled);
    void window.electronAPI?.saveAppearanceSettings?.({
      devRunLoggingEnabled: enabled,
    });
  };

  const handleHomeResearchVaultEnabledChange = (enabled: boolean) => {
    setHomeResearchVaultEnabled(enabled);
    void window.electronAPI?.saveAppearanceSettings?.({
      homeResearchVaultEnabled: enabled,
    });
  };

  const handleHomeNextActionsEnabledChange = (enabled: boolean) => {
    setHomeNextActionsEnabled(enabled);
    void window.electronAPI?.saveAppearanceSettings?.({
      homeNextActionsEnabled: enabled,
    });
  };

  // Smart right panel visibility: auto-collapse on welcome screen in focused mode
  const effectiveRightCollapsed =
    currentView !== "main"
      ? true
      : uiDensity === "full"
        ? rightSidebarCollapsed
        : !selectedTaskId
          ? true
          : rightSidebarCollapsed;
  const unseenOutputCount = unseenOutputTaskIds.length;
  const showTitleBarTerminalToggle =
    currentView === "main" &&
    !effectiveRightCollapsed &&
    Boolean(currentWorkspace?.path) &&
    !remoteTaskView;
  const titleBarBrowserTaskId = showTitleBarTerminalToggle ? selectedTask?.id : undefined;
  const visibleRightPanelInput = effectiveRightCollapsed
    ? EMPTY_RIGHT_PANEL_INPUT
    : deferredRightPanelInput;

  const handleRightSidebarToggle = useCallback(() => {
    const startedAtMs =
      typeof performance !== "undefined" ? performance.now() : null;
    setRightSidebarCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      if (nextCollapsed) {
        setTerminalTabsOpen(false);
      }
      return nextCollapsed;
    });
    if (startedAtMs === null) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        recordRendererPerfSample(
          "App.right_sidebar_toggle_to_paint",
          performance.now() - startedAtMs,
          rendererPerfLoggingEnabled,
        );
      });
    });
  }, [rendererPerfLoggingEnabled]);

  const handleSelectTaskFromShell = useCallback(
    (taskId: string | null) => {
      clearRemoteTaskView();
      markTaskSwitchStart(taskId);
      setSelectedTaskId(taskId);
      if (taskId) {
        setUnseenCompletedTaskIds((prev) => removeTaskId(prev, taskId));
      }
      setCurrentView("main");
    },
    [clearRemoteTaskView, markTaskSwitchStart],
  );
  const handleOpenSettings = useCallback(() => setCurrentView("settings"), []);
  const handleOpenMissionControl = useCallback(() => {
    setMissionControlInitialCompanyId(null);
    setMissionControlInitialIssueId(null);
    setMissionControlEverydayAgentFocus(false);
    setCurrentView("missionControl");
  }, []);
  const handleSelectChildTaskFromMainContent = useCallback((taskId: string) => {
    const task = tasksRef.current.find((candidate) => candidate.id === taskId);
    if (task && isSynthesisChildTask(task)) return;
    markTaskSwitchStart(taskId);
    setSelectedTaskId(taskId);
  }, [markTaskSwitchStart]);
  const handleSubmitInputRequestFromMainContent = useCallback(
    (requestId: string, answers: Record<string, { optionLabel?: string; otherText?: string }>) => {
      void handleInputRequestResponse({
        requestId,
        status: "submitted",
        answers,
      });
    },
    [handleInputRequestResponse],
  );
  const handleDismissInputRequestFromMainContent = useCallback(
    (requestId: string) => {
      void handleInputRequestResponse({
        requestId,
        status: "dismissed",
      });
    },
    [handleInputRequestResponse],
  );
  const handleViewTaskOutputsFromMainContent = useCallback(
    (taskId: string, primaryOutputPath?: string) => {
      setCurrentView("main");
      clearRemoteTaskView();
      markTaskSwitchStart(taskId);
      setSelectedTaskId(taskId);
      setRightSidebarCollapsed(false);
      if (primaryOutputPath) {
        setRightPanelHighlight({ taskId, path: primaryOutputPath });
      }
      setUnseenOutputTaskIds((prev) => prev.filter((id) => id !== taskId));
      setUnseenCompletedTaskIds((prev) => prev.filter((id) => id !== taskId));
    },
    [clearRemoteTaskView, markTaskSwitchStart],
  );
  const handleRightPanelHighlightConsumed = useCallback(() => {
    setRightPanelHighlight((prev) =>
      prev && prev.taskId === selectedTaskId ? null : prev,
    );
  }, [selectedTaskId]);

  // When opening a session from history, ensure we have the full task (including prompt)
  // in case it wasn't in the initial list or has stale data
  useEffect(() => {
    if (!selectedTaskId || remoteTaskView || !window.electronAPI?.getTask) return;

    const hasPrompt = selectedTask && (selectedTask.rawPrompt || selectedTask.userPrompt || selectedTask.prompt);
    const displayPrompt = [
      selectedTask?.rawPrompt,
      selectedTask?.userPrompt,
      selectedTask?.prompt,
    ].find((value) => typeof value === "string" && value.trim().length > 0);
    const mayNeedMentionMetadata =
      typeof displayPrompt === "string" &&
      displayPrompt.includes("@") &&
      !selectedTask?.agentConfig?.integrationMentions &&
      !fetchedFullTaskForMentionMetadataRef.current.has(selectedTaskId);
    if (hasPrompt && !mayNeedMentionMetadata) return;

    let cancelled = false;
    const fetchTask = async () => {
      try {
        const fullTask = (await window.electronAPI.getTask(selectedTaskId)) as Task | null;
        if (cancelled || !fullTask) return;
        fetchedFullTaskForMentionMetadataRef.current.add(selectedTaskId);
        setTasks((prev) =>
          upsertTaskPreservingIdentity(prev, fullTask, { prependIfMissing: true }),
        );
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch task for session view:", error);
      }
    };
    void fetchTask();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, remoteTaskView, selectedTask]);

  const openTaskById = useCallback(
    async (taskId: string) => {
      setCurrentView("main");
      clearRemoteTaskView();

      const existingTask = tasksRef.current.find((task) => task.id === taskId);
      if (existingTask) {
        markTaskSwitchStart(taskId);
        setSelectedTaskId(taskId);
        return;
      }

      if (!window.electronAPI?.getTask) return;

      try {
        const task = (await window.electronAPI.getTask(taskId)) as Task | null;
        if (!task) return;

        setTasks((prev) => upsertTaskPreservingIdentity(prev, task, { prependIfMissing: true }));
        markTaskSwitchStart(task.id);
        setSelectedTaskId(task.id);
      } catch (error) {
        console.error("Failed to open task from shell navigation:", error);
      }
    },
    [clearRemoteTaskView, markTaskSwitchStart],
  );

  useEffect(() => {
    if (!shouldClearUnseenOutputBadges(currentView === "main", effectiveRightCollapsed)) return;
    if (unseenOutputTaskIds.length > 0) {
      setUnseenOutputTaskIds([]);
    }
  }, [currentView, effectiveRightCollapsed, unseenOutputTaskIds.length]);

  useEffect(() => {
    if (!selectedTaskId || currentView !== "main") return;
    setUnseenCompletedTaskIds((prev) =>
      prev.includes(selectedTaskId) ? prev.filter((id) => id !== selectedTaskId) : prev,
    );
  }, [selectedTaskId, currentView]);

  useEffect(() => {
    setUnseenCompletedTaskIds((prev) => {
      if (prev.length === 0) return prev;
      const completedTaskIds = new Set(
        tasks.filter((task) => task.status === "completed").map((task) => task.id),
      );
      const next = prev.filter((taskId) => completedTaskIds.has(taskId));
      return next.length === prev.length ? prev : next;
    });
  }, [completedTaskIdsSignature]);

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToTask) return;

    const unsubscribe = window.electronAPI.onNavigateToTask((taskId) => {
      void openTaskById(taskId);
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [openTaskById]);

  if (!hasElectronAPI) {
    const isHttpContext =
      typeof window !== "undefined" &&
      (window.location.protocol === "http:" || window.location.protocol === "https:");
    const isViteDevServer =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

    if (isHttpContext && !isViteDevServer) {
      return <WebAccessClient />;
    }

    return (
      <div className="app">
        <div className="title-bar" />
        <div className="empty-state">
          <h2>Desktop bridge unavailable</h2>
          <p>
            CoWork OS is running without Electron preload APIs. Start it with `npm run dev` (not
            only `npm run dev:react`) or relaunch the desktop app.
          </p>
        </div>
      </div>
    );
  }

  // Show loading state while checking disclaimer/onboarding status
  if (disclaimerAccepted === null || onboardingCompleted === null) {
    return (
      <div className="app">
        <div className="title-bar" />
        <TaskViewSkeleton />
      </div>
    );
  }

  // Show onboarding on first launch
  if (!onboardingCompleted) {
    return (
      <div className="app">
        <Onboarding
          onComplete={handleOnboardingComplete}
          workspaceId={currentWorkspace?.id ?? null}
        />
      </div>
    );
  }

  // Show disclaimer after onboarding is completed but before main app
  if (!disclaimerAccepted) {
    return (
      <div className="app">
        <div className="title-bar" />
        <DisclaimerModal onAccept={handleDisclaimerAccept} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="title-bar">
        <div className="title-bar-drag-handle" aria-hidden="true" />
        <div className="title-bar-left">
          <button
            type="button"
            className="title-bar-btn title-bar-sidebar-toggle"
            onClick={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
            title={leftSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-label={leftSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6b7280"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block", flexShrink: 0 }}
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>
        <div className="title-bar-spacer" />
        <div className="title-bar-actions">
          {titleBarBrowserTaskId && (
            <button
              type="button"
              className="title-bar-btn title-bar-browser-toggle"
              onClick={() => {
                setBrowserWorkbenchRequest({
                  taskId: titleBarBrowserTaskId,
                  sessionId: "default",
                  requestId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                });
              }}
              title="Open browser"
              aria-label="Open browser"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3a13.5 13.5 0 0 1 0 18" />
                <path d="M12 3a13.5 13.5 0 0 0 0 18" />
              </svg>
            </button>
          )}
          {showTitleBarTerminalToggle && (
            <button
              type="button"
              className={`title-bar-btn title-bar-terminal-toggle ${terminalTabsOpen ? "active" : ""}`}
              onClick={() => setTerminalTabsOpen((open) => !open)}
              title={terminalTabsOpen ? "Close terminal" : "Open terminal"}
              aria-label={terminalTabsOpen ? "Close terminal" : "Open terminal"}
              aria-pressed={terminalTabsOpen}
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <path d="m7 11 2 2-2 2" />
                <path d="M11 15h4" />
                <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="title-bar-btn title-bar-theme-toggle"
            onClick={() => {
              const effectiveTheme = getEffectiveTheme(themeMode);
              handleThemeChange(effectiveTheme === "dark" ? "light" : "dark");
            }}
            title={`Switch to ${getEffectiveTheme(themeMode) === "dark" ? "light" : "dark"} mode`}
            aria-label={`Switch to ${getEffectiveTheme(themeMode) === "dark" ? "light" : "dark"} mode`}
          >
            {getEffectiveTheme(themeMode) === "dark" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <NotificationPanel
            onNotificationClick={(notification) => {
              // Prioritize taskId to show the completed task result
              if (notification.taskId) {
                void openTaskById(notification.taskId);
                return;
              }
              if (notification.suggestionId) {
                void (async () => {
                  try {
                    if (notification.workspaceId) {
                      const workspaces = await window.electronAPI.listWorkspaces();
                      const targetWorkspace = workspaces.find(
                        (workspace) => workspace.id === notification.workspaceId,
                      );
                      if (targetWorkspace) {
                        setCurrentWorkspace(targetWorkspace);
                      }
                    }
                  } catch {
                    // best-effort
                  } finally {
                    setCurrentView("home");
                    setHomeAutomationFocusTick((tick) => tick + 1);
                  }
                })();
                return;
              }
              // Fall back to scheduled tasks settings if only cronJobId
              if (notification.cronJobId) {
                setSettingsTab("scheduled");
                setCurrentView("settings");
              }
            }}
          />
          <button
            type="button"
            className={`title-bar-btn density-toggle ${uiDensity}`}
            onClick={() => handleUiDensityChange(uiDensity === "focused" ? "full" : "focused")}
            title={uiDensity === "focused" ? "Switch to Full mode" : "Switch to Focused mode"}
            aria-label={uiDensity === "focused" ? "Switch to Full mode" : "Switch to Focused mode"}
          >
            {uiDensity === "focused" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <rect x="4" y="5" width="16" height="14" rx="2" />
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <line x1="4" y1="9" x2="20" y2="9" />
                <line x1="4" y1="14" x2="20" y2="14" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
            )}
          </button>
          {currentView === "main" && (
            <button
              type="button"
              className="title-bar-btn title-bar-panel-toggle"
              onClick={handleRightSidebarToggle}
              title={effectiveRightCollapsed ? "Show panel" : "Hide panel"}
              aria-label={effectiveRightCollapsed ? "Show panel" : "Hide panel"}
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              {effectiveRightCollapsed && unseenOutputCount > 0 && (
                <span className="title-bar-output-badge" aria-label={`${unseenOutputCount} new outputs`}>
                  {unseenOutputCount > 9 ? "9+" : unseenOutputCount}
                </span>
              )}
            </button>
          )}
        </div>
        {/* Windows custom window controls (minimize, maximize, close) */}
        {isWindows && (
          <div className="win-controls">
            <button
              type="button"
              className="win-control-btn"
              onClick={() => window.electronAPI.windowMinimize()}
              aria-label="Minimize"
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <line x1="0" y1="5" x2="10" y2="5" />
              </svg>
            </button>
            <button
              type="button"
              className="win-control-btn"
              onClick={() => window.electronAPI.windowMaximize()}
              aria-label="Maximize"
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            </button>
            <button
              type="button"
              className="win-control-btn win-close"
              onClick={() => window.electronAPI.windowClose()}
              aria-label="Close"
            >
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <line x1="0" y1="0" x2="10" y2="10" />
                <line x1="10" y1="0" x2="0" y2="10" />
              </svg>
            </button>
          </div>
        )}
      </div>
      {(currentView === "main" ||
        currentView === "home" ||
        currentView === "automations" ||
        currentView === "devices" ||
        currentView === "health" ||
        currentView === "ideas" ||
        currentView === "inboxAgent" ||
        currentView === "agents" ||
        currentView === "everydayAgent" ||
        currentView === "missionControl") && (
        <>
          <div
            className={`app-layout ${leftSidebarCollapsed ? "left-collapsed" : ""} ${effectiveRightCollapsed ? "right-collapsed" : ""}`}
          >
            {!leftSidebarCollapsed && (
              <Sidebar
                workspace={currentWorkspace}
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                isAutomationsActive={currentView === "automations"}
                isIdeasActive={currentView === "ideas"}
                isInboxAgentActive={currentView === "inboxAgent"}
                isAgentsActive={currentView === "agents"}
                isEverydayAgentActive={currentView === "everydayAgent"}
                isMissionControlActive={currentView === "missionControl"}
                isHealthActive={currentView === "health"}
                isDevicesActive={currentView === "devices"}
                isLoadingSessions={isInitialTaskListLoading}
                isLoadingMoreTasks={isLoadingMoreTasks}
                completionAttentionTaskIds={unseenCompletedTaskIds}
                onSelectTask={handleSelectTaskFromShell}
                onOpenAutomations={() => setCurrentView("automations")}
                onOpenIdeas={() => setCurrentView("ideas")}
                onOpenInboxAgent={() => setCurrentView("inboxAgent")}
                onOpenAgents={() => setCurrentView("agents")}
                onOpenEverydayAgent={() => setCurrentView("everydayAgent")}
                onOpenHealth={() => setCurrentView("health")}
                onOpenDevices={() => setCurrentView("devices")}
                onNewSession={handleNewSession}
                onOpenSettings={handleOpenSettings}
                onOpenMissionControl={handleOpenMissionControl}
                onTasksChanged={loadTasks}
                onLoadMoreTasks={loadMoreTasks}
                hasMoreTasks={hasMoreTasks}
                uiDensity={uiDensity}
                updateInfo={updateInfo}
                onViewUpdate={() => {
                  setSettingsTab("updates");
                  setCurrentView("settings");
                }}
              />
            )}
            <Suspense
              fallback={
                currentView === "main" ? <TaskViewSkeleton /> : <LazyViewFallback />
              }
            >
              {currentView === "automations" ? (
                <main className="main-content automation-studio-main">
                  <AutomationStudioPanel
                    workspaceId={currentWorkspace?.id}
                    onOpenTask={(taskId) => {
                      setSelectedTaskId(taskId);
                      setCurrentView("main");
                    }}
                  />
                </main>
              ) : currentView === "home" ? (
                <HomeDashboard
                  workspace={currentWorkspace}
                  tasks={tasks}
                  automationInboxFocusTick={homeAutomationFocusTick}
                  onOpenTask={(taskId) => {
                    setSelectedTaskId(taskId);
                    setCurrentView("main");
                  }}
                  onNewSession={handleNewSession}
                  onOpenScheduledTasks={() => {
                    setSettingsTab("scheduled");
                    setCurrentView("settings");
                  }}
                  onOpenMissionControl={() => {
                    setMissionControlInitialCompanyId(null);
                    setMissionControlInitialIssueId(null);
                    setMissionControlEverydayAgentFocus(false);
                    setCurrentView("missionControl");
                  }}
                  onOpenEverydayAgent={() => setCurrentView("everydayAgent")}
                  onOpenEventTriggers={() => {
                    setSettingsTab("triggers");
                    setCurrentView("settings");
                  }}
                  onOpenSelfImprove={() => {
                    setSettingsTab("subconscious");
                    setCurrentView("settings");
                  }}
                  onCreateTask={handleCreateTask}
                />
              ) : currentView === "devices" ? (
                <DevicesPanel
                onOpenTask={(taskId, remote) => {
                  if (remote) {
                    void openRemoteTaskView(taskId, remote);
                    return;
                  }
                  clearRemoteTaskView();
                  setSelectedTaskId(taskId);
                  setCurrentView("main");
                }}
                onCreateTaskHere={async (prompt, options) => {
                  const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
                  clearRemoteTaskView();
                  if (options?.shellAccess && currentWorkspace) {
                    try {
                      const updated = await window.electronAPI?.updateWorkspacePermissions?.(currentWorkspace.id, { shell: true });
                      if (updated) setCurrentWorkspace(updated);
                    } catch (e) {
                      console.warn("[Devices] Failed to enable shell for workspace:", e);
                    }
                  }
                  await handleCreateTask(title, prompt, options ? {
                    autonomousMode: options.autonomousMode,
                    collaborativeMode: options.collaborativeMode,
                    multiLlmMode: options.multiLlmMode,
                    multiLlmConfig: options.multiLlmConfig,
                    executionMode: options.executionMode,
                    taskDomain: options.taskDomain,
                    chronicleMode: options.chronicleMode,
                  } : undefined);
                  loadTasks();
                }}
                onNewTaskForDevice={async (nodeId, prompt, options) => {
                  try {
                    const res = await window.electronAPI?.deviceAssignTask?.({
                      nodeId,
                      prompt,
                      workspaceId: currentWorkspace?.id,
                      agentConfig: options ? {
                        ...(options.autonomousMode && {
                          autonomousMode: true,
                          allowUserInput: false,
                          humanInputPolicy: "none" as const,
                        }),
                        ...(options.collaborativeMode && { collaborativeMode: true }),
                        ...(options.multiLlmMode && { multiLlmMode: true, multiLlmConfig: options.multiLlmConfig }),
                        ...(options.executionMode && { executionMode: options.executionMode }),
                        ...(options.taskDomain && { taskDomain: options.taskDomain }),
                        ...(options.chronicleMode && { chronicleMode: options.chronicleMode }),
                      } : undefined,
                      shellAccess: options?.shellAccess,
                    });
                    
                    if (res?.ok) {
                      addToast({
                        type: "success",
                        title: "Task Started Remotely",
                        message: "The task is now running on the remote device."
                      });
                      // Refresh task list to show the new task in the sidebar/dashboard
                      loadTasks();
                    } else {
                      throw new Error(res?.error || "Unknown error assigning task");
                    }
                  } catch (err: any) {
                    console.error("[Devices] deviceAssignTask record failed:", err);
                    addToast({
                      type: "error",
                      title: "Remote Task Failed",
                      message: err?.message || "Failed to start task on remote device"
                    });
                  }
                }}
                workspace={currentWorkspace}
                onOpenSettings={(tab) => {
                  setSettingsTab(
                    tab === "improvement"
                      ? "subconscious"
                      : ((tab as typeof settingsTab | undefined) || "appearance"),
                  );
                  setCurrentView("settings");
                }}
                availableProviders={availableProviders}
                />
              ) : currentView === "health" ? (
                <HealthPanel
                  onOpenSettings={() => {
                    setSettingsTab("health");
                    setCurrentView("settings");
                  }}
                  onCreateTask={(title, prompt) => {
                    setCurrentView("main");
                    handleCreateTask(title, prompt);
                  }}
                />
              ) : currentView === "ideas" ? (
                <IdeasPanel onCreateTaskFromPrompt={handleCreateTaskFromIdea} />
              ) : currentView === "inboxAgent" ? (
                <InboxAgentPanel
                  externalAskRequest={inboxAgentAskRequest}
                  onOpenMissionControlIssue={(companyId, issueId) => {
                    setMissionControlInitialCompanyId(companyId);
                    setMissionControlInitialIssueId(issueId);
                    setMissionControlEverydayAgentFocus(false);
                    setCurrentView("missionControl");
                  }}
                />
              ) : currentView === "agents" ? (
                <main className="main-content">
                  <AgentsHubPanel
                    onOpenMissionControl={() => {
                      setMissionControlInitialCompanyId(null);
                      setMissionControlInitialIssueId(null);
                      setMissionControlEverydayAgentFocus(false);
                      setCurrentView("missionControl");
                    }}
                    onOpenAgentPersonas={() => {
                      setSettingsTab("digitaltwins");
                      setCurrentView("settings");
                    }}
                    onOpenSlackSettings={() => {
                      setSettingsTab("slack");
                      setCurrentView("settings");
                    }}
                    onOpenSettings={(tab) => {
                      setSettingsTab(tab);
                      setCurrentView("settings");
                    }}
                    onOpenTask={handleOpenManagedAgentTask}
                  />
                </main>
              ) : currentView === "everydayAgent" ? (
                <EverydayAgentPanel
                  workspace={currentWorkspace}
                  onOpenSettings={() => {
                    setSettingsTab("everydayAgent");
                    setCurrentView("settings");
                  }}
                  onOpenMissionControl={() => {
                    setMissionControlInitialCompanyId(null);
                    setMissionControlInitialIssueId(null);
                    setMissionControlEverydayAgentFocus(true);
                    setCurrentView("missionControl");
                  }}
                  onCreateTask={(title, prompt) => {
                    setCurrentView("main");
                    handleCreateTask(title, prompt);
                  }}
                />
              ) : currentView === "missionControl" ? (
                <main className="main-content mission-control-main">
                  <MissionControlPanel
                    onOpenAgents={() => setCurrentView("agents")}
                    initialCompanyId={missionControlInitialCompanyId}
                    initialIssueId={missionControlInitialIssueId}
                    initialEverydayAgentFocus={missionControlEverydayAgentFocus}
                  />
                </main>
              ) : (
                <SelectedTaskWorkspaceView
                task={selectedTask}
                selectedTaskId={selectedTaskId}
                workspace={currentWorkspace}
                replayControls={replayControls}
                sharedTaskEventUi={sharedTaskEventUi}
                remoteTaskView={remoteTaskView}
                childTasks={childTasks}
                childEvents={childEvents}
                activeInputRequest={activeInputRequest}
                pendingInputRequests={pendingInputRequests}
                selectedModel={selectedModel}
                selectedProvider={selectedProvider}
                selectedReasoningEffort={selectedReasoningEffort}
                availableModels={availableModels}
                availableProviders={availableProviders}
                uiDensity={uiDensity}
                homeResearchVaultEnabled={homeResearchVaultEnabled}
                homeNextActionsEnabled={homeNextActionsEnabled}
                rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
                taskSwitchId={selectedTaskSwitchId}
                hasMoreTimelineHistory={selectedTaskTimelineHistory.hasMoreHistory}
                isLoadingTimelineHistory={selectedTaskTimelineHistory.isLoadingMore}
                timelineHistoryError={selectedTaskTimelineHistory.error}
                onLoadMoreTimelineHistory={handleLoadMoreTaskTimelineHistory}
                onLoadTaskEventDetail={handleLoadTaskEventDetail}
                effectiveRightCollapsed={effectiveRightCollapsed}
                terminalTabsOpen={terminalTabsOpen}
                browserWorkbenchRequest={browserWorkbenchRequest}
                sideChat={sideChat}
                rightPanelInput={visibleRightPanelInput}
                onSelectChildTask={handleSelectChildTaskFromMainContent}
                onSelectTask={handleSelectTaskFromShell}
                onSendMessage={handleSendMessage}
                onOpenSideChat={handleOpenSideChat}
                onSendSideChatMessage={handleSendSideChatMessage}
                onCloseSideChat={handleCloseSideChat}
                onOpenSideChatFullThread={handleOpenSideChatFullThread}
                onStartOnboarding={handleShowOnboarding}
                onStartFreshSession={handleClearTaskView}
                onCreateTask={handleCreateTask}
                onAskInbox={handleAskInboxFromComposer}
                onChangeWorkspace={handleChangeWorkspace}
                onSelectWorkspace={handleSelectWorkspace}
                onOpenSettings={(tab) => {
                  setSettingsTab((tab as typeof settingsTab | undefined) || "appearance");
                  setCurrentView("settings");
                }}
                onStopTask={handleCancelTask}
                onEnableShellForPausedTask={handleEnableShellForPausedTask}
                onContinueWithoutShellForPausedTask={handleContinueWithoutShellForPausedTask}
                onWrapUpTask={handleWrapUpTask}
                onSubmitInputRequest={handleSubmitInputRequestFromMainContent}
                onDismissInputRequest={handleDismissInputRequestFromMainContent}
                onOpenBrowserView={handleOpenBrowserView}
                onRevealRightSidebar={handleRevealRightSidebar}
                onViewTaskOutputs={handleViewTaskOutputsFromMainContent}
                onTasksChanged={loadTasks}
                onCancelTaskById={handleCancelTaskById}
                onHighlightConsumed={handleRightPanelHighlightConsumed}
                onCloseTerminalTabs={handleCloseTerminalTabs}
                onModelChange={handleModelChange}
                />
              )}
            </Suspense>
          </div>

          {/* Quick Task FAB */}
          {currentWorkspace && currentView === "main" && <QuickTaskFAB onCreateTask={handleQuickTask} />}

          {approveAllSessionWarningOpen ? (
            <ApproveAllSessionWarningDialog
              onConfirm={() => {
                setApproveAllSessionWarningOpen(false);
                handleSessionApproveAllConfirm();
              }}
              onCancel={() => {
                setApproveAllSessionWarningOpen(false);
                reshowPendingApprovalToasts();
              }}
            />
          ) : computerUseAppGrantApproval ? (
            <ComputerUseApprovalDialog
              approval={computerUseAppGrantApproval}
              onAllowSession={() =>
                void handleApprovalResponse(computerUseAppGrantApproval.id, true)
              }
              onDeny={() => void handleApprovalResponse(computerUseAppGrantApproval.id, false)}
            />
          ) : genericApproval && isBrowserUseDomainApproval(genericApproval) ? (
            <BrowserUseApprovalDialog
              approval={genericApproval}
              onRespond={(action) =>
                void handleApprovalResponse(
                  genericApproval.id,
                  action.startsWith("allow_"),
                  action,
                )
              }
            />
          ) : genericApproval ? (
            <GenericApprovalDialog
              approval={genericApproval}
              onRespond={(action) =>
                void handleApprovalResponse(
                  genericApproval.id,
                  action.startsWith("allow_"),
                  action,
                )
              }
              onApproveAllSession={showApproveAllWarning}
            />
          ) : null}

          {/* Toast Notifications */}
          <ToastContainer
            toasts={toasts}
            onDismiss={dismissToast}
            onTaskClick={(taskId) => {
              setSelectedTaskId(taskId);
              setCurrentView("main");
            }}
          />
        </>
      )}
      {currentView === "settings" && (
        <Suspense fallback={<LazyViewFallback />}>
          <Settings
            onBack={() => setCurrentView("main")}
            onSettingsChanged={loadLLMConfig}
            themeMode={themeMode}
            visualTheme={visualTheme}
            accentColor={accentColor}
            transparencyEffectsEnabled={transparencyEffectsEnabled}
            onThemeChange={handleThemeChange}
            onVisualThemeChange={handleVisualThemeChange}
            onAccentChange={handleAccentChange}
            onTransparencyEffectsEnabledChange={handleTransparencyEffectsEnabledChange}
            uiDensity={uiDensity}
            onUiDensityChange={handleUiDensityChange}
            devRunLoggingEnabled={devRunLoggingEnabled}
            onDevRunLoggingEnabledChange={handleDevRunLoggingEnabledChange}
            homeResearchVaultEnabled={homeResearchVaultEnabled}
            homeNextActionsEnabled={homeNextActionsEnabled}
            onHomeResearchVaultEnabledChange={handleHomeResearchVaultEnabledChange}
            onHomeNextActionsEnabledChange={handleHomeNextActionsEnabledChange}
            initialTab={settingsTab}
            onShowOnboarding={handleShowOnboarding}
            onboardingCompletedAt={onboardingCompletedAt}
            workspaceId={currentWorkspace?.id}
            onCreateTask={(title, prompt) => {
              setCurrentView("main");
              handleCreateTask(title, prompt);
            }}
            onOpenTask={(taskId) => {
              setCurrentView("main");
              setSelectedTaskId(taskId);
              setRightSidebarCollapsed(false);
            }}
            onNavigateToMissionControl={(companyId) => {
              setMissionControlInitialCompanyId(companyId);
              setMissionControlInitialIssueId(null);
              setMissionControlEverydayAgentFocus(false);
              setCurrentView("missionControl");
            }}
            onNavigateToAgents={() => {
              setCurrentView("agents");
            }}
          />
        </Suspense>
      )}
      {currentView === "browser" && (
        <Suspense fallback={<LazyViewFallback />}>
          <BrowserView initialUrl={browserUrl} onBack={() => setCurrentView("main")} />
        </Suspense>
      )}
    </div>
  );
}
