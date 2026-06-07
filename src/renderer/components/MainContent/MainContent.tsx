import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  Fragment,
  startTransition,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Task,
  TaskEvent,
  Workspace,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
  CustomSkill,
  CanvasSession,
  isTempWorkspaceId,
  ImageAttachment,
  AgentConfig,
  AgentTeamRun,
  MultiLlmConfig,
  StepFeedbackAction,
  ExecutionMode,
  TaskDomain,
  InputRequest,
  QuotedAssistantMessage,
  PermissionMode,
  ProactiveSuggestion,
  UserProfile,
  AppNotification,
  IntegrationMentionOption,
  IntegrationMentionSelection,
} from "../../../shared/types";
import { parseLeadingSkillSlashCommand } from "../../../shared/skill-slash-commands";
import {
  parseOnboardingSlashCommand,
} from "../../../shared/onboarding";
import { parseLeadingMessageAppShortcut } from "../../../shared/message-shortcuts";
import {
  buildPersistentGoalAgentConfig,
  buildPersistentGoalPrompt,
  parseLeadingGoalSlashCommand,
} from "../../../shared/goal-slash-command";
import {
  MESSAGE_SHORTCUTS_UPDATED_EVENT,
  applySlashCommandSelection,
  buildMessageSlashOptions,
  resolveSlashSelectedIndex,
  type PluginSlashCommandAlias,
  type SlashCommandOption,
} from "../../utils/message-slash-options";
import { parseLegalWorkflowSlashPrompt } from "../../utils/legal-demand-intake";
import {
  LLM_WIKI_AUDIT_GUI_PROMPT,
  LLM_WIKI_BRIEF_GUI_PROMPT,
  LLM_WIKI_EXPLORE_GUI_PROMPT,
  LLM_WIKI_GUI_PROMPT,
  LLM_WIKI_QUERY_GUI_PROMPT,
} from "../../../shared/starter-missions";
import { detectModeSuggestions, type ModeSuggestion } from "../../../shared/mode-suggestion-detection";
import { CollaborativeAgentLines } from "../CollaborativeAgentLines";
import { CollaborativeSummaryPanel } from "../CollaborativeSummaryPanel";
import { DispatchedAgentsPanel } from "../DispatchedAgentsPanel";
import { CliAgentFrame } from "../CliAgentFrame";
import { isCliAgentChildTask, resolveCliAgentType } from "../../../shared/cli-agent-detection";
import { MultiLlmSelectionPanel } from "../MultiLlmSelectionPanel";
import { AssistantMessageContent } from "../AssistantMessageContent";
import type { AgentRoleData, LlmWikiVaultEntry, LlmWikiVaultSummary } from "../../../electron/preload";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useVoiceTalkMode } from "../../hooks/useVoiceTalkMode";
import { useAgentContext, type AgentContext } from "../../hooks/useAgentContext";
import {
  hasTaskOutputs,
  resolveTaskOutputSummaryFromCompletionEvent,
  resolveTaskOutputSummaryFromTask,
} from "../../utils/task-outputs";
import { isTaskActivelyWorking } from "../../utils/task-working-state";
import { shouldShowPersistentNeedsUserActionBanner } from "../../utils/task-completion-ux";
import {
  filterAdjacentDuplicateTimelineFailures,
  filterVerboseTimelineNoise,
  shouldShowTaskEventInStepFeed,
  shouldShowTaskEventInSummaryMode,
} from "../../utils/task-event-visibility";
import { normalizeEventsForTimelineUi } from "../../utils/timeline-projection";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import {
  incrementRendererPerfCounter,
  markRendererPerfEvent,
  markRendererStartup,
  markTaskEventRenderable,
  markTaskEventVisible,
  measureRendererPerf,
  recordRendererRender,
} from "../../utils/renderer-perf";
import { areIntegrationMentionOptionsEqual } from "../../utils/integration-mention-options";
import { extractAttachmentNames } from "../utils/attachment-content";
import {
  deriveSharedTaskEventUiState,
  type BaseTimelineItem,
  type CommandOutputSession,
  type SharedTaskEventUiState,
} from "../../utils/task-event-derived";
import {
  ArrowUp,
  Archive as ArchiveIcon,
  Check as CheckIcon,
  ChevronDown,
  ClipboardCopy,
  Copy,
  Ellipsis,
  FileText,
  Folder,
  GitFork,
  Globe,
  Link as LinkIcon,
  Loader2,
  MessageCircle,
  Mic,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Square,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Clock,
  X,
} from "lucide-react";
import { SpreadsheetArtifactCard } from "../SpreadsheetArtifactCard";
import { DocumentArtifactCard } from "../DocumentArtifactCard";
import { PresentationArtifactCard } from "../PresentationArtifactCard";
import { WebArtifactCard } from "../WebArtifactCard";
import { ReplayControlsBar } from "../ReplayControls";
import { DebugSessionPanel } from "../DebugSessionPanel";
import { TaskPauseBanner } from "../TaskPauseBanner";
import { buildMarkdownComponents } from "../markdown-components";
import { useVirtualList } from "../../hooks/useVirtualList";
import { formatDuration, useTaskDuration } from "../../hooks/useTaskDuration";
import type { ReplayControls } from "../../hooks/useReplayMode";
import "./main-content.css";

import {
  CODE_PREVIEWS_EXPANDED_KEY,
  MAX_ATTACHMENTS,
  TASK_FEED_MEASUREMENT_LAYOUT_VERSION,
  PermissionAccessMode,
} from "./main-content-constants";
import type { SettingsTab, CreateTaskOptions } from "./main-content-types";
import {
  type WelcomeTaskSuggestion,
  type ActiveWelcomeSuggestionDraft,
  getWorkspaceStatusFolderLabel,
  normalizeSuggestionText,
  dedupeWelcomeTaskSuggestions,
  buildInputRequestWelcomeSuggestion,
  buildHeartbeatWelcomeSuggestion,
  buildMemoryCommitmentSuggestion,
  buildProfileWelcomeSuggestion,
  buildRecentMemorySuggestion,
  buildCompanionNotificationWelcomeSuggestion,
  asRecord,
  getRecordString,
  iconForWelcomeAction,
  labelForWelcomeAction,
  formatWelcomeModules,
} from "./welcome-suggestions";
import {
  type EndOfTaskArtifactStack,
  END_OF_TASK_ARTIFACT_KINDS,
  getVisibleEndOfTaskArtifactCards,
  estimateEndOfTaskArtifactStackHeight,
  getInlinePreviewKindForGeneratedFile,
  getInlinePreviewKindForTaskEvent,
  shouldRenderOpenArtifactCardAtEvent,
  collectEndOfTaskArtifactCardStacks,
  getTaskEventArtifactPaths,
} from "./artifact-logic";
import {
  isVerificationNoiseEvent,
  shouldRevealInternalAssistantMessageInVerbose,
  getCompletionSummaryText,
  getAssistantOrCompletionText,
  getUserEventDisplayMessage,
  isLowSignalPauseMessage,
  buildPauseDecisionFallbackFromRecentEvents,
  buildTaskTitle,
  normalizeInitialPromptText,
  shouldSuppressInitialPromptUserEvent,
  deriveTaskHeaderPresentation,
  shouldCreateFreshTaskForSend,
  isChatExecutionTask,
} from "./task-event-presentation";
import {
  type ImportedAttachment,
  type PendingAttachment,
  formatFileSize,
  composeMessageWithAttachments,
} from "./attachments";
import {
  normalizeTimelineTitleMarkdownForDisplay,
  cleanAssistantMessageForDisplay,
  stripHtmlTags,
  extractDomainFromUrl,
} from "./markdown-normalization";
import {
  DeferredMarkdown,
  CollapsibleUserBubble,
  MessageCopyButton,
  MessageForkButton,
  MessageQuoteButton,
  MessageSpeakButton,
  UserMessageText,
  getIntegrationMentionsSignature,
  normalizeCommitmentText,
  createQuotedAssistantMessage,
  summarizeQuotedAssistantMessage,
} from "./message-ui";
import { ModelDropdown } from "./ModelDropdown";
import { StructuredInputPromptCard } from "./StructuredInputPromptCard";
import { LegalDemandIntakePromptCard, GenericLegalWorkflowPromptCard } from "./legal-prompt-cards";
import {
  EXECUTION_MODE_ORDER,
  EXECUTION_MODE_LABEL,
  EXECUTION_MODE_HINT,
  EXECUTION_MODE_ICON,
  TASK_DOMAIN_ORDER,
  TASK_DOMAIN_LABEL,
  TASK_DOMAIN_HINT,
  TASK_DOMAIN_ICON,
  FOCUSED_CARD_POOL,
  CARDS_TO_SHOW,
  pickFocusedCards,
} from "./focused-cards";
import { TaskAutomationModal, isTurnThisIntoRoutinePrompt, taskCanBecomeRoutineFromFollowUp } from "./TaskAutomationModal";
import {
  type TaskFeedRow,
  type SelectedSkillModalState,
  type TranscriptMode,
  type AgentReasoningPanelState,
  STEP_WINDOW_SIZE,
  VIRTUALIZED_FEED_ROW_THRESHOLD,
  getTaskFeedRowVisiblePerfEventId,
  getDefaultTranscriptMode,
  shouldShowBootstrapProgressRow,
  getBootstrapProgressTitle,
  deriveAgentReasoningPanelState,
  hasAgentReasoningPanelContent,
  selectVisibleTaskFeedRows,
  hasInactiveStringSetEntries,
  pruneStringSetToActiveIds,
  getCommandOutputSessionsRevision,
  collectInlineRunCommandSessionIds,
  isRedundantTimelineEvidenceEvent,
  estimateTaskFeedRowHeight,
  assignTimelineRef,
  getAutoScrollTargetTop,
  shouldScheduleAutoScrollWrite,
} from "./task-feed-logic";
import {
  formatSignedScore,
  describeLoopRisk,
  shouldHideApprovalEventInStepFeed,
  getApprovalPayload,
  isRunCommandApproval,
  getTimelineEventStepId,
  getParallelGroupOwnerStepId,
  canStepEventOwnParallelChildren,
  renderEventTitle,
  renderEventDetails,
} from "./timeline-event-rendering";

type MentionOption = {
  type: "agent" | "everyone" | "integration";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  integration?: IntegrationMentionOption;
};

const normalizeMentionSearch = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
import {
  SkillParameterModal,
  expandSkillPrompt,
  type SkillParameterFormValues,
} from "../SkillParameterModal";
import { buildSlashSkillPrompt } from "../skill-parameter-utils";
import { DocumentAwareFileModal } from "../DocumentAwareFileModal";
import { ThemeIcon } from "../ThemeIcon";
import { IntegrationMentionIcon } from "../IntegrationMentionIcon";
import {
  PromptComposerInput,
  type IntegrationMentionSpan,
  type PromptComposerInputHandle,
} from "../PromptComposerInput";
import {
  BookIcon,
  CalendarIcon,
  ChartIcon,
  ClipboardIcon,
  CodeIcon,
  EditIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  MessageIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  UsersIcon,
  ZapIcon,
} from "../LineIcons";

const INBOX_AGENT_MENTION_ID = "builtin:inbox-agent";

function isInboxAgentMention(mention: IntegrationMentionSelection): boolean {
  return mention.id === INBOX_AGENT_MENTION_ID || mention.providerKey === "inbox-agent";
}

function extractInboxAskQuery(
  value: string,
  mentionSpans: IntegrationMentionSpan[],
): string | null {
  const inboxSpans = mentionSpans
    .filter((span) => isInboxAgentMention(span.mention))
    .sort((a, b) => b.start - a.start);
  const rawStartsWithInbox = /^\s*@inbox(?:\s+agent)?\b/i.test(value);
  if (inboxSpans.length === 0 && !rawStartsWithInbox) return null;

  let query = value;
  for (const span of inboxSpans) {
    query = `${query.slice(0, span.start)}${query.slice(span.end)}`;
  }
  query = query.replace(/^\s*@inbox(?:\s+agent)?\b[\s,:;-]*/i, "");
  return query.replace(/\s+/g, " ").trim();
}

function getIntegrationMentionSearchRank(
  option: IntegrationMentionOption,
  query: string,
): number {
  if (!query) return 0;
  const label = normalizeMentionSearch(option.label);
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  const aliases = option.aliases.map(normalizeMentionSearch);
  if (aliases.some((alias) => alias === query)) return 2;
  if (aliases.some((alias) => alias.startsWith(query))) return 3;
  return 4;
}
import { replaceEmojisInChildren } from "../../utils/emoji-replacer";
import { CommandOutput } from "../CommandOutput";
import { CanvasPreview } from "../CanvasPreview";
import { StepFeed } from "../timeline/StepFeed";
import { ParallelGroupFeed } from "../timeline/ParallelGroupFeed";
import { ActionBlock, buildActionBlockSummary } from "../timeline/ActionBlock";
import { buildParallelGroupProjection } from "../timeline/parallel-group-projection";
import {
  resolveTimelineIndicator,
  shouldShowTimelineBranchStub,
} from "../timeline/timeline-indicators";
import { getStepCompletionPreviewPath } from "../../utils/step-document-preview";
import { resolveDisclosureExpanded } from "../../utils/disclosure-state";

const MAX_COMMAND_OUTPUT_SESSION_CHARS = 50 * 1024;
const MAX_COMMAND_OUTPUT_SESSIONS = 12;

function appendCommandOutputTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_COMMAND_OUTPUT_SESSION_CHARS) return next;
  return "[... earlier output truncated ...]\n\n" + next.slice(-MAX_COMMAND_OUTPUT_SESSION_CHARS);
}

function limitCommandOutputSessions(sessions: CommandOutputSession[]): CommandOutputSession[] {
  if (sessions.length <= MAX_COMMAND_OUTPUT_SESSIONS) return sessions;
  const running = sessions.filter((session) => session.isRunning);
  const runningToKeep = running.slice(-MAX_COMMAND_OUTPUT_SESSIONS);
  const completedBudget = Math.max(0, MAX_COMMAND_OUTPUT_SESSIONS - runningToKeep.length);
  const recentCompleted =
    completedBudget > 0
      ? sessions.filter((session) => !session.isRunning).slice(-completedBudget)
      : [];
  return [...recentCompleted, ...runningToKeep].sort((a, b) => a.startTimestamp - b.startTimestamp);
}

interface MainContentProps {
  task: Task | undefined;
  selectedTaskId: string | null;
  workspace: Workspace | null;
  events: TaskEvent[];
  sharedTaskEventUi?: SharedTaskEventUiState | null;
  childTasks?: Task[];
  childEvents?: TaskEvent[];
  onSelectChildTask?: (taskId: string) => void;
  onOpenChildAgentSidebar?: (taskId: string) => void;
  onSelectTask?: (taskId: string | null) => void;
  onSendMessage: (
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      integrationMentions?: IntegrationMentionSelection[];
    },
  ) => void;
  onOpenSideChat?: (request: {
    taskId: string;
    fromEventId?: string;
    initialMessage?: string;
  }) => void | Promise<void>;
  onStartOnboarding?: () => void;
  onStartFreshSession?: () => void;
  onCreateTask?: (
    title: string,
    prompt: string,
    options?: CreateTaskOptions,
    images?: ImageAttachment[],
  ) => void;
  onAskInbox?: (query: string) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  onEnableShellForPausedTask?: () => void | Promise<void>;
  onContinueWithoutShellForPausedTask?: () => void | Promise<void>;
  onWrapUpTask?: () => void;
  inputRequest?: InputRequest | null;
  pendingInputRequests?: InputRequest[];
  onSubmitInputRequest?: (
    requestId: string,
    answers: Record<string, { optionLabel?: string; otherText?: string }>,
  ) => void;
  onDismissInputRequest?: (requestId: string) => void;
  onOpenBrowserView?: (url?: string) => void;
  onViewTaskOutputs?: (taskId: string, primaryOutputPath?: string) => void;
  onTasksChanged?: () => void | Promise<void>;
  onOpenSpreadsheetArtifact?: (path: string) => void;
  onOpenDocumentArtifact?: (path: string) => void;
  onOpenPresentationArtifact?: (path: string) => void;
  onOpenWebArtifact?: (path: string) => void;
  onOpenBrowserWorkbenchSidebar?: (url?: string) => void;
  onOpenWebLinkInSidebar?: (url: string) => void;
  selectedModel: string;
  selectedProvider: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  availableModels: LLMModelInfo[];
  onModelChange: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  availableProviders?: LLMProviderInfo[];
  uiDensity?: "focused" | "full" | "power";
  homeResearchVaultEnabled?: boolean;
  homeNextActionsEnabled?: boolean;
  rendererPerfLoggingEnabled?: boolean;
  taskSwitchId?: string | null;
  hasMoreTimelineHistory?: boolean;
  isLoadingTimelineHistory?: boolean;
  timelineHistoryError?: string | null;
  onLoadMoreTimelineHistory?: () => void | Promise<void>;
  onLoadTaskEventDetail?: (eventId: string, taskId: string) => void | Promise<void>;
  remoteSession?: { deviceId: string; deviceName: string } | null;
  replayControls?: ReplayControls;
}

function getTruncatedTaskEventDetailId(event: TaskEvent): string | null {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!payload || payload.__coworkPayloadTruncated !== true) return null;
  if (typeof payload.eventDetailId === "string" && payload.eventDetailId.trim().length > 0) {
    return payload.eventDetailId.trim();
  }
  if (typeof payload.eventId === "string" && payload.eventId.trim().length > 0) {
    return payload.eventId.trim();
  }
  return event.eventId || event.id;
}

function getTaskEventPayloadRenderSignature(event: TaskEvent): string {
  const detailId = getTruncatedTaskEventDetailId(event);
  return detailId ? `truncated:${detailId}` : "full";
}

function AgentReasoningPanel(props: {
  currentStep: { description: string } | null;
  state: AgentReasoningPanelState;
}) {
  const { currentStep, state } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [followStream, setFollowStream] = useState(true);
  const stepLabel = currentStep?.description?.trim() || "";
  const hasStreamText = state.activeStreamText.trim().length > 0;
  const streamSignature = hasStreamText
    ? state.activeStreamText
    : state.recentUpdates.join("\n");

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nextFollow = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFollowStream((prev) => (prev === nextFollow ? prev : nextFollow));
  }, []);

  useEffect(() => {
    if (!scrollRef.current || !followStream) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [followStream, streamSignature]);

  useEffect(() => {
    if (state.isStreaming) {
      setFollowStream(true);
    }
  }, [currentStep?.description, state.isStreaming]);

  if (!hasAgentReasoningPanelContent(state)) return null;

  return (
    <div className="agent-reasoning-panel">
      <div className="agent-reasoning-panel-header">
        <div className="agent-reasoning-panel-title">
          <Sparkles size={13} strokeWidth={1.8} />
          <span>{state.isStreaming ? "Reasoning" : "Recent reasoning"}</span>
        </div>
        {stepLabel ? (
          <span className="agent-reasoning-step" title={stepLabel}>
            {stepLabel === "Thinking..." ? "Thinking" : stepLabel}
          </span>
        ) : null}
        {!followStream && (
          <button
            type="button"
            className="agent-reasoning-follow-btn"
            onClick={() => {
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
              setFollowStream(true);
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        className={`agent-reasoning-stream ${state.isStreaming ? "is-streaming" : ""}`}
        onScroll={handleScroll}
      >
        {hasStreamText ? (
          <div className="agent-reasoning-stream-text">{state.activeStreamText}</div>
        ) : (
          state.recentUpdates.map((message, index) => (
            <div key={`${index}:${message.slice(0, 48)}`} className="agent-reasoning-update">
              {message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function VirtualizedTaskFeedRow({
  itemKey,
  offsetTop,
  estimatedHeight,
  onHeightChange,
  visiblePerfEventId,
  visibilityEnabled,
  children,
}: {
  itemKey: string;
  offsetTop: number;
  estimatedHeight: number;
  onHeightChange: (itemKey: string, height: number) => void;
  visiblePerfEventId: string | null;
  visibilityEnabled: boolean;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const visibleNotifiedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (nextHeight > 0) {
          onHeightChange(itemKey, nextHeight);
          if (
            visibilityEnabled &&
            visiblePerfEventId &&
            visibleNotifiedEventIdRef.current !== visiblePerfEventId
          ) {
            visibleNotifiedEventIdRef.current = visiblePerfEventId;
            markTaskEventVisible({ id: visiblePerfEventId }, "measured-row", visibilityEnabled);
          }
        }
      });
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [itemKey, onHeightChange, visibilityEnabled, visiblePerfEventId]);

  return (
    <div
      style={{
        position: "absolute",
        top: offsetTop,
        left: 0,
        right: 0,
        minHeight: estimatedHeight,
      }}
    >
      <div ref={rowRef}>{children}</div>
    </div>
  );
}

function MeasuredTaskFeedRow({
  visiblePerfEventId,
  enabled,
  children,
}: {
  visiblePerfEventId: string | null;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const visibleNotifiedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (
          nextHeight > 0 &&
          enabled &&
          visiblePerfEventId &&
          visibleNotifiedEventIdRef.current !== visiblePerfEventId
        ) {
          visibleNotifiedEventIdRef.current = visiblePerfEventId;
          markTaskEventVisible({ id: visiblePerfEventId }, "measured-row", enabled);
        }
      });
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, visiblePerfEventId]);

  return (
    <div ref={rowRef}>
      {children}
    </div>
  );
}

function getTaskFeedRowsSignature(rows: TaskFeedRow[]): string {
  return rows.map((row) => `${row.key}:${row.revision}`).join("|");
}

export function TaskSessionLineageFooter({
  task,
  onSelectTask,
}: {
  task: Task | null | undefined;
  onSelectTask?: (taskId: string | null) => void;
}) {
  const sourceTaskId = task?.branchFromTaskId?.trim();
  if (!sourceTaskId) return null;

  const content = (
    <>
      <GitFork size={18} strokeWidth={1.8} aria-hidden="true" />
      <span>Forked from conversation</span>
    </>
  );

  return (
    <div className="session-lineage-footer" aria-label="Session lineage">
      <span className="session-lineage-footer-rule" aria-hidden="true" />
      {onSelectTask ? (
        <button
          type="button"
          className="session-lineage-link"
          onClick={() => onSelectTask(sourceTaskId)}
          title="Open source conversation"
        >
          {content}
        </button>
      ) : (
        <span className="session-lineage-link static" title="Source conversation unavailable">
          {content}
        </span>
      )}
      <span className="session-lineage-footer-rule" aria-hidden="true" />
    </div>
  );
}

const TaskConversationRenderedRows = memo(function TaskConversationRenderedRows({
  taskId,
  taskSwitchId,
  hasMoreTimelineHistory,
  isLoadingTimelineHistory,
  timelineHistoryError,
  onLoadMoreTimelineHistory,
  rendererPerfLoggingEnabled,
  visibleFeedRows,
  isChatTask,
  isTaskWorking,
  task,
  formatTime,
  isReplayMode,
  transcriptMode,
  hiddenLiveFeedRowCount,
  canReturnToLiveView,
  onShowFullTimeline,
  onBackToLiveView,
  reasoningPanel,
  reasoningPanelSignature,
  mainBodyRef,
  timelineRef,
  getRenderedFeedRow,
}: {
  taskId: string | undefined;
  taskSwitchId?: string | null;
  hasMoreTimelineHistory?: boolean;
  isLoadingTimelineHistory?: boolean;
  timelineHistoryError?: string | null;
  onLoadMoreTimelineHistory?: () => void | Promise<void>;
  rendererPerfLoggingEnabled: boolean;
  visibleFeedRows: TaskFeedRow[];
  isChatTask: boolean;
  isTaskWorking: boolean;
  task: Task | null | undefined;
  formatTime: (timestamp: number) => string;
  isReplayMode: boolean;
  transcriptMode: TranscriptMode;
  hiddenLiveFeedRowCount: number;
  canReturnToLiveView: boolean;
  onShowFullTimeline: () => void;
  onBackToLiveView: () => void;
  reasoningPanel?: React.ReactNode;
  reasoningPanelSignature: string;
  mainBodyRef: React.RefObject<HTMLDivElement | null>;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  getRenderedFeedRow: (row: TaskFeedRow) => React.ReactNode;
}) {
  recordRendererRender(
    "MainContent.taskConversationFlow",
    taskId ? `task:${taskId}` : "task:none",
    rendererPerfLoggingEnabled,
  );
  void reasoningPanelSignature;
  void hasMoreTimelineHistory;
  void timelineHistoryError;

  const historyPrependAnchorRef = useRef<{
    taskId: string | undefined;
    scrollTop: number;
    scrollHeight: number;
    rowCount: number;
    observedLoading: boolean;
  } | null>(null);
  const [suppressVirtualAutoScroll, setSuppressVirtualAutoScroll] = useState(false);

  const renderableFeedRows = useMemo(
    () => visibleFeedRows,
    [visibleFeedRows],
  );
  const handleLoadMoreTimelineHistory = useCallback(() => {
    const container = mainBodyRef.current;
    if (container) {
      historyPrependAnchorRef.current = {
        taskId,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        rowCount: renderableFeedRows.length,
        observedLoading: false,
      };
    }
    setSuppressVirtualAutoScroll(true);
    void onLoadMoreTimelineHistory?.();
  }, [mainBodyRef, onLoadMoreTimelineHistory, renderableFeedRows.length, taskId]);
  const startupRowsMarkedRef = useRef(false);
  const timelineRowsMarkedTaskIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (startupRowsMarkedRef.current || visibleFeedRows.length === 0) return;
    startupRowsMarkedRef.current = true;
    markRendererStartup("first_task_rows_ready", rendererPerfLoggingEnabled, {
      rows: visibleFeedRows.length,
      taskId: taskId ?? "none",
    });
  }, [rendererPerfLoggingEnabled, taskId, visibleFeedRows.length]);
  useEffect(() => {
    const markKey = `${taskId ?? "none"}:${taskSwitchId ?? "initial"}`;
    if (!taskId || visibleFeedRows.length === 0 || timelineRowsMarkedTaskIdsRef.current.has(markKey)) {
      return;
    }
    timelineRowsMarkedTaskIdsRef.current.add(markKey);
    markRendererPerfEvent("timeline_first_rows_ready", rendererPerfLoggingEnabled, {
      rows: visibleFeedRows.length,
      taskId,
      switchId: taskSwitchId,
    });
  }, [rendererPerfLoggingEnabled, taskId, taskSwitchId, visibleFeedRows.length]);
  const useVirtualizedFeed =
    transcriptMode !== "delivery" &&
    renderableFeedRows.length >= VIRTUALIZED_FEED_ROW_THRESHOLD &&
    !isReplayMode;
  const [feedRowHeights, setFeedRowHeights] = useState<Map<string, number>>(() => new Map());
  const feedRowHeightsRef = useRef<Map<string, number>>(new Map());
  const feedRowHeightSignaturesRef = useRef<Map<string, string>>(new Map());
  const pendingFeedRowHeightsRef = useRef<Map<string, number>>(new Map());
  const feedRowHeightFlushFrameRef = useRef<number | null>(null);
  const [conversationFlowOffsetTop, setConversationFlowOffsetTop] = useState(0);
  const conversationFlowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    feedRowHeightsRef.current = feedRowHeights;
  }, [feedRowHeights]);

  useEffect(() => {
    const activeSignatures = new Map(
      renderableFeedRows.map((row) => [
        row.key,
        `${TASK_FEED_MEASUREMENT_LAYOUT_VERSION}:${row.revision}:${row.estimatedHeight}`,
      ]),
    );
    const previousSignatures = feedRowHeightSignaturesRef.current;
    feedRowHeightSignaturesRef.current = activeSignatures;
    setFeedRowHeights((prev) => {
      let changed = false;
      const next = new Map<string, number>();
      for (const [key, value] of prev.entries()) {
        const activeSignature = activeSignatures.get(key);
        if (!activeSignature || previousSignatures.get(key) !== activeSignature) {
          changed = true;
          continue;
        }
        next.set(key, value);
      }
      if (changed) {
        feedRowHeightsRef.current = next;
      }
      return changed ? next : prev;
    });
  }, [renderableFeedRows]);

  useEffect(() => {
    if (!rendererPerfLoggingEnabled) return;
    for (const row of renderableFeedRows) {
      const visiblePerfEventId = getTaskFeedRowVisiblePerfEventId(row);
      if (!visiblePerfEventId) continue;
      markTaskEventRenderable({ id: visiblePerfEventId }, rendererPerfLoggingEnabled);
    }
  }, [renderableFeedRows, rendererPerfLoggingEnabled]);

  const flushFeedRowHeights = useCallback(() => {
    feedRowHeightFlushFrameRef.current = null;
    setFeedRowHeights((prev) => {
      if (pendingFeedRowHeightsRef.current.size === 0) return prev;

      let changed = false;
      const next = new Map(prev);
      for (const [itemKey, nextHeight] of pendingFeedRowHeightsRef.current.entries()) {
        const currentHeight = next.get(itemKey);
        if (currentHeight !== undefined && Math.abs(currentHeight - nextHeight) < 2) {
          continue;
        }
        next.set(itemKey, nextHeight);
        changed = true;
      }
      pendingFeedRowHeightsRef.current.clear();
      if (changed) {
        feedRowHeightsRef.current = next;
      }
      return changed ? next : prev;
    });
  }, []);

  const handleFeedRowHeightChange = useCallback(
    (itemKey: string, height: number) => {
      const pendingHeight = pendingFeedRowHeightsRef.current.get(itemKey);
      const currentHeight = pendingHeight ?? feedRowHeightsRef.current.get(itemKey);
      if (currentHeight !== undefined && Math.abs(currentHeight - height) < 2) {
        return;
      }
      pendingFeedRowHeightsRef.current.set(itemKey, height);
      if (feedRowHeightFlushFrameRef.current !== null) return;
      feedRowHeightFlushFrameRef.current = window.requestAnimationFrame(flushFeedRowHeights);
    },
    [flushFeedRowHeights],
  );

  useEffect(
    () => () => {
      if (feedRowHeightFlushFrameRef.current !== null) {
        cancelAnimationFrame(feedRowHeightFlushFrameRef.current);
        feedRowHeightFlushFrameRef.current = null;
      }
    },
    [],
  );

  const setConversationFlowNode = useCallback(
    (node: HTMLDivElement | null) => {
      conversationFlowRef.current = node;
      assignTimelineRef(timelineRef, node);
    },
    [timelineRef],
  );

  useEffect(() => {
    if (!useVirtualizedFeed) {
      setConversationFlowOffsetTop(0);
      return;
    }

    const flow = conversationFlowRef.current;
    if (!flow) return;

    let frame = requestAnimationFrame(() => {
      const nextOffset = Math.max(0, flow.offsetTop);
      setConversationFlowOffsetTop((prev) =>
        Math.abs(prev - nextOffset) < 1 ? prev : nextOffset,
      );
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [useVirtualizedFeed, renderableFeedRows.length]);

  const { virtualItems: virtualFeedRows, totalHeight: virtualFeedTotalHeight } = useVirtualList({
    items: renderableFeedRows,
    containerRef: mainBodyRef as React.RefObject<HTMLElement | null>,
    getItemHeight: (row) => feedRowHeights.get(row.key) ?? row.estimatedHeight,
    estimatedItemHeight: 160,
    overscan: 4,
    enabled: useVirtualizedFeed,
    scrollOffsetTop: conversationFlowOffsetTop,
    suppressAutoScrollOnItemsChange: suppressVirtualAutoScroll,
  });
  const renderedFeedRows = useMemo(
    () => (useVirtualizedFeed ? virtualFeedRows.map((row) => row.item) : renderableFeedRows),
    [useVirtualizedFeed, virtualFeedRows, renderableFeedRows],
  );
  const renderedFeedNodeByKey = useMemo(
    () =>
      new Map(
        renderedFeedRows.map((row) => {
          const node =
            row.kind === "history-control" ? (
              <div className="timeline-history-control">
                {row.error ? <span className="timeline-history-error">{row.error}</span> : null}
                {row.hasMoreHistory ? (
                  <button
                    type="button"
                    className="action-block-show-all-btn"
                    disabled={row.isLoading}
                    onClick={handleLoadMoreTimelineHistory}
                  >
                    {row.isLoading ? "Loading earlier history..." : "Load earlier history"}
                  </button>
                ) : null}
              </div>
            ) : (
              getRenderedFeedRow(row)
            );
          return [row.key, node] as const;
        }),
      ),
    [getRenderedFeedRow, handleLoadMoreTimelineHistory, renderedFeedRows],
  );
  useEffect(() => {
    if (isLoadingTimelineHistory && historyPrependAnchorRef.current) {
      historyPrependAnchorRef.current.observedLoading = true;
    }
  }, [isLoadingTimelineHistory]);
  useLayoutEffect(() => {
    if (isLoadingTimelineHistory) return;
    const anchor = historyPrependAnchorRef.current;
    const container = mainBodyRef.current;
    if (!anchor || !container) {
      if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
      return;
    }
    if (!anchor.observedLoading && renderableFeedRows.length === anchor.rowCount) {
      return;
    }
    historyPrependAnchorRef.current = null;
    if (anchor.taskId !== taskId) {
      if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
      return;
    }

    const delta = container.scrollHeight - anchor.scrollHeight;
    if (delta > 0) {
      container.scrollTop = anchor.scrollTop + delta;
    }
    if (suppressVirtualAutoScroll) setSuppressVirtualAutoScroll(false);
  }, [
    isLoadingTimelineHistory,
    mainBodyRef,
    renderableFeedRows.length,
    suppressVirtualAutoScroll,
    taskId,
    useVirtualizedFeed,
    virtualFeedTotalHeight,
  ]);
  const showBootstrapProgress = shouldShowBootstrapProgressRow({
    isTaskWorking,
    visibleRenderableFeedRowsLength: renderableFeedRows.length,
    isChatTask,
  });
  const bootstrapProgressTitle = getBootstrapProgressTitle(task);
  const bootstrapProgressTimeLabel =
    task && typeof task.createdAt === "number" && Number.isFinite(task.createdAt)
      ? formatTime(task.createdAt)
      : "";

  return (
    <div className="conversation-flow" ref={setConversationFlowNode}>
      {transcriptMode === "live" && hiddenLiveFeedRowCount > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
            borderRadius: 10,
            background: "var(--surface-secondary, rgba(255,255,255,0.04))",
            color: "var(--text-secondary, rgba(255,255,255,0.72))",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span>
              Showing the current live work. {hiddenLiveFeedRowCount} earlier
              {hiddenLiveFeedRowCount === 1 ? " item is" : " items are"} hidden while the task is running.
            </span>
            <button type="button" className="action-block-show-all-btn" onClick={onShowFullTimeline}>
              Show full timeline
            </button>
          </div>
        </div>
      )}
      {transcriptMode === "inspect" && canReturnToLiveView && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
            borderRadius: 10,
            background: "var(--surface-secondary, rgba(255,255,255,0.04))",
            color: "var(--text-secondary, rgba(255,255,255,0.72))",
            fontSize: 12,
            lineHeight: 1.45,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>Inspecting the full transcript.</span>
          <button type="button" className="action-block-show-all-btn" onClick={onBackToLiveView}>
            Back to live view
          </button>
        </div>
      )}
      {reasoningPanel}
      {showBootstrapProgress ? (
        <StepFeed
          title={
            <span className="thinking-title" aria-label={bootstrapProgressTitle}>
              {bootstrapProgressTitle}
              <span className="thinking-ellipsis" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </span>
          }
          timeLabel={bootstrapProgressTimeLabel}
          indicator={{ icon: Loader2, tone: "active", spin: true, label: "In progress" }}
          expandable={false}
          expanded={false}
        />
      ) : !useVirtualizedFeed ? (
        renderedFeedRows.map((row) => (
          <MeasuredTaskFeedRow
            key={row.key}
            visiblePerfEventId={getTaskFeedRowVisiblePerfEventId(row)}
            enabled={Boolean(rendererPerfLoggingEnabled)}
          >
            {renderedFeedNodeByKey.get(row.key) ?? null}
          </MeasuredTaskFeedRow>
        ))
      ) : (
        <div style={{ height: virtualFeedTotalHeight, position: "relative" }}>
          {virtualFeedRows.map((virtualRow) => (
            <VirtualizedTaskFeedRow
              key={virtualRow.item.key}
              itemKey={virtualRow.item.key}
              offsetTop={virtualRow.offsetTop}
              estimatedHeight={virtualRow.height}
              onHeightChange={handleFeedRowHeightChange}
              visiblePerfEventId={getTaskFeedRowVisiblePerfEventId(virtualRow.item)}
              visibilityEnabled={Boolean(rendererPerfLoggingEnabled)}
            >
              {renderedFeedNodeByKey.get(virtualRow.item.key) ?? null}
            </VirtualizedTaskFeedRow>
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.taskId === next.taskId &&
  prev.taskSwitchId === next.taskSwitchId &&
  prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
  prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
  prev.timelineHistoryError === next.timelineHistoryError &&
  prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
  prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
  prev.isChatTask === next.isChatTask &&
  prev.isTaskWorking === next.isTaskWorking &&
  prev.task?.status === next.task?.status &&
  prev.task?.createdAt === next.task?.createdAt &&
  prev.formatTime === next.formatTime &&
  prev.isReplayMode === next.isReplayMode &&
  prev.transcriptMode === next.transcriptMode &&
  prev.hiddenLiveFeedRowCount === next.hiddenLiveFeedRowCount &&
  prev.canReturnToLiveView === next.canReturnToLiveView &&
  prev.onShowFullTimeline === next.onShowFullTimeline &&
  prev.onBackToLiveView === next.onBackToLiveView &&
  prev.reasoningPanelSignature === next.reasoningPanelSignature &&
  prev.mainBodyRef === next.mainBodyRef &&
  prev.timelineRef === next.timelineRef &&
  prev.getRenderedFeedRow === next.getRenderedFeedRow &&
  getTaskFeedRowsSignature(prev.visibleFeedRows) ===
    getTaskFeedRowsSignature(next.visibleFeedRows)
);

const TaskConversationFlow = memo(function TaskConversationFlow(props: any) {
  const rendererPerfLoggingEnabled = props.rendererPerfLoggingEnabled as boolean | undefined;
  const taskSwitchId = props.taskSwitchId as string | null | undefined;
  const hasMoreTimelineHistory = props.hasMoreTimelineHistory as boolean | undefined;
  const isLoadingTimelineHistory = props.isLoadingTimelineHistory as boolean | undefined;
  const timelineHistoryError = props.timelineHistoryError as string | null | undefined;
  const onLoadMoreTimelineHistory = props.onLoadMoreTimelineHistory as
    | (() => void | Promise<void>)
    | undefined;
  const agentContext = props.agentContext as AgentContext;
  const childEvents = props.childEvents as TaskEvent[];
  const childTasks = props.childTasks as Task[];
  const collaborativeRun = props.collaborativeRun as AgentTeamRun | null;
  const commandOutputSessionsByInsertIndex = props.commandOutputSessionsByInsertIndex as Map<
    number,
    CommandOutputSession[]
  >;
  const currentStep = props.currentStep as { description: string } | null;
  const eventTitleMarkdownComponents = props.eventTitleMarkdownComponents as any;
  const events = props.events as TaskEvent[];
  const expandedActionBlocks = props.expandedActionBlocks as Set<string>;
  const handleCanvasClose = props.handleCanvasClose as (sessionId: string) => void;
  const handleMessageFeedback = props.handleMessageFeedback as (...args: any[]) => void;
  const handleStepFeedback = props.handleStepFeedback as (...args: any[]) => void;
  const isChatTask = props.isChatTask as boolean;
  const isTaskWorking = props.isTaskWorking as boolean;
  const isReplayMode = props.isReplayMode as boolean;
  const defaultTranscriptMode = props.defaultTranscriptMode as TranscriptMode;
  const transcriptMode = props.transcriptMode as TranscriptMode;
  const lastAssistantMessage = props.lastAssistantMessage as TaskEvent | null;
  const initialPromptEventId = props.initialPromptEventId as string | null;
  const trimmedPrompt = props.trimmedPrompt as string;
  const markdownComponents = props.markdownComponents as any;
  const messageFeedbackMap = props.messageFeedbackMap as Map<string, string>;
  const mainBodyRef = props.mainBodyRef as React.RefObject<HTMLDivElement | null>;
  const onOpenBrowserView = props.onOpenBrowserView as ((url?: string) => void) | undefined;
  const onQuoteAssistantMessage = props.onQuoteAssistantMessage as
    | ((quote: QuotedAssistantMessage) => void)
    | undefined;
  const onForkTaskSessionFromEvent = props.onForkTaskSessionFromEvent as
    | ((event: TaskEvent) => void)
    | undefined;
  const onSelectChildTask = props.onSelectChildTask as ((taskId: string) => void) | undefined;
  const onOpenChildAgentSidebar = props.onOpenChildAgentSidebar as
    | ((taskId: string) => void)
    | undefined;
  const onViewTaskOutputs = props.onViewTaskOutputs as
    | ((taskId: string, primaryOutputPath?: string) => void)
    | undefined;
  const onOpenSpreadsheetArtifact = props.onOpenSpreadsheetArtifact as
    | ((path: string) => void)
    | undefined;
  const onOpenDocumentArtifact = props.onOpenDocumentArtifact as
    | ((path: string) => void)
    | undefined;
  const onOpenPresentationArtifact = props.onOpenPresentationArtifact as
    | ((path: string) => void)
    | undefined;
  const onOpenWebArtifact = props.onOpenWebArtifact as
    | ((path: string) => void)
    | undefined;
  const parallelGroupsByAnchorEventId = props.parallelGroupsByAnchorEventId as Map<string, any>;
  const rejectMenuOpenFor = props.rejectMenuOpenFor as string | null;
  const rejectMenuRef = props.rejectMenuRef as React.RefObject<HTMLDivElement | null>;
  const renderCommandOutputs = props.renderCommandOutputs as (sessions?: CommandOutputSession[]) => React.ReactNode;
  const setRejectMenuOpenFor = props.setRejectMenuOpenFor as React.Dispatch<
    React.SetStateAction<string | null>
  >;
  const setExpandedActionBlocks = props.setExpandedActionBlocks as React.Dispatch<
    React.SetStateAction<Set<string>>
  >;
  const setShowAllActionBlocks = props.setShowAllActionBlocks as React.Dispatch<
    React.SetStateAction<Set<string>>
  >;
  const setStepFeedbackOpen = props.setStepFeedbackOpen as React.Dispatch<
    React.SetStateAction<boolean>
  >;
  const setStepFeedbackText = props.setStepFeedbackText as React.Dispatch<
    React.SetStateAction<string>
  >;
  const setViewerFilePath = props.setViewerFilePath as React.Dispatch<React.SetStateAction<string | null>>;
  const formatTime = props.formatTime as (timestamp: number) => string;
  const shouldRenderTimelineEventInStepFeed = props.shouldRenderTimelineEventInStepFeed as (
    event: TaskEvent,
  ) => boolean;
  const shouldDefaultExpand = props.shouldDefaultExpand as (event: TaskEvent) => boolean;
  const toolCallPairing = props.toolCallPairing as { completions: Map<string, TaskEvent>; claimedResultIds: Set<string> };
  const hasEventDetails = props.hasEventDetails as (event: TaskEvent) => boolean;
  const isEventExpanded = props.isEventExpanded as (event: TaskEvent) => boolean;
  const showAllActionBlocks = props.showAllActionBlocks as Set<string>;
  const stepFeedbackOpen = props.stepFeedbackOpen as boolean;
  const stepFeedbackSending = props.stepFeedbackSending as boolean;
  const stepFeedbackText = props.stepFeedbackText as string;
  const suppressedParallelEventIds = props.suppressedParallelEventIds as Set<string>;
  const task = props.task as Task;
  const timelineItems = props.timelineItems as Array<any>;
  const timelineRef = props.timelineRef as React.RefObject<HTMLDivElement | null>;
  const toggledEvents = props.toggledEvents as Set<string>;
  const toggleEventExpanded = props.toggleEventExpanded as (eventId: string) => void;
  const verboseSteps = props.verboseSteps as boolean;
  const voiceEnabled = props.voiceEnabled as boolean;
  const wrappingUp = props.wrappingUp as boolean;
  const workspace = props.workspace as Workspace | null;
  const showFullTimeline = props.showFullTimeline as () => void;
  const returnToDefaultTranscript = props.returnToDefaultTranscript as () => void;

  recordRendererRender(
    "MainContent.taskConversationShell",
    task?.id ? `task:${task.id}` : "task:none",
    rendererPerfLoggingEnabled,
  );

  const stepFeedTimelineIndexPosition = new Map<number, number>();
  let stepFeedEventCount = 0;
  timelineItems.forEach((timelineItem, timelineIndex) => {
    if (isChatTask && timelineItem.kind === "action_block") {
      return;
    }
    if (timelineItem.kind === "action_block") {
      stepFeedTimelineIndexPosition.set(timelineIndex, stepFeedEventCount);
      stepFeedEventCount += 1;
      return;
    }
    if (timelineItem.kind !== "event") return;
    const event = timelineItem.event;
    const eventId = event.id;
    if (suppressedParallelEventIds.has(eventId) && !parallelGroupsByAnchorEventId.has(eventId)) {
      return;
    }
    if (
      !parallelGroupsByAnchorEventId.has(eventId) &&
      !shouldRenderTimelineEventInStepFeed(event)
    ) {
      return;
    }
    stepFeedTimelineIndexPosition.set(timelineIndex, stepFeedEventCount);
    stepFeedEventCount += 1;
  });

  const leadingCommandOutputSessions = commandOutputSessionsByInsertIndex.get(-1) ?? [];
  const [expandedArtifactStacks, setExpandedArtifactStacks] = useState<Set<string>>(
    () => new Set(),
  );
  const expandArtifactStack = useCallback((rowKey: string) => {
    setExpandedArtifactStacks((current) => {
      if (current.has(rowKey)) return current;
      const next = new Set(current);
      next.add(rowKey);
      return next;
    });
  }, []);
  useEffect(() => {
    setExpandedArtifactStacks(new Set());
  }, [task?.id]);
  const getActionBlockRenderState = useCallback(
    (blockEvents: TaskEvent[], blockEventIndices: number[], blockId: string) => {
      const isBlockShowAll = showAllActionBlocks.has(blockId);
      const renderableRawIndices: number[] = [];
      for (let ri = 0; ri < blockEvents.length; ri += 1) {
        const event = blockEvents[ri] as TaskEvent;
        if (
          suppressedParallelEventIds.has(event.id) &&
          !parallelGroupsByAnchorEventId.has(event.id)
        ) {
          continue;
        }
        if (
          !parallelGroupsByAnchorEventId.has(event.id) &&
          !shouldRenderTimelineEventInStepFeed(event)
        ) {
          continue;
        }
        renderableRawIndices.push(ri);
      }

      const renderableCount = renderableRawIndices.length;
      const visibleRenderableRawIndices =
        !isBlockShowAll && renderableCount > STEP_WINDOW_SIZE
          ? renderableRawIndices.slice(-STEP_WINDOW_SIZE)
          : renderableRawIndices;
      const renderableEvents = renderableRawIndices.map((ri) => blockEvents[ri] as TaskEvent);
      const visibleBlockEvents = visibleRenderableRawIndices.map((ri) => blockEvents[ri] as TaskEvent);
      const visibleBlockEventIndices = visibleRenderableRawIndices.map((ri) => blockEventIndices[ri] as number);
      const commandOutputsForBlock = blockEventIndices.flatMap(
        (eventIndex: number) => commandOutputSessionsByInsertIndex.get(eventIndex) ?? [],
      );

      return {
        renderableCount,
        renderableEvents,
        visibleBlockEvents,
        visibleBlockEventIndices,
        hiddenBlockEventCount: Math.max(0, renderableCount - visibleRenderableRawIndices.length),
        hasBlockCommandOutputs: commandOutputsForBlock.length > 0,
        commandOutputsForBlock,
      };
    },
    [
      commandOutputSessionsByInsertIndex,
      parallelGroupsByAnchorEventId,
      shouldRenderTimelineEventInStepFeed,
      showAllActionBlocks,
      suppressedParallelEventIds,
    ],
  );
  const feedRows = useMemo<TaskFeedRow[]>(() => {
    const rows: TaskFeedRow[] = [];
    const artifactStacks = collectEndOfTaskArtifactCardStacks(events);
    const artifactStacksByAnchorIndex = new Map<number, EndOfTaskArtifactStack[]>();
    for (const stack of artifactStacks) {
      const existing = artifactStacksByAnchorIndex.get(stack.anchorEventIndex) || [];
      existing.push(stack);
      artifactStacksByAnchorIndex.set(stack.anchorEventIndex, existing);
    }
    const pushArtifactStacksForTimelineItem = (item: any) => {
      const eventIndices =
        item.kind === "event"
          ? [item.eventIndex]
          : item.kind === "action_block" && Array.isArray(item.eventIndices)
            ? item.eventIndices
            : [];
      for (const eventIndex of eventIndices) {
        if (typeof eventIndex !== "number") continue;
        const stacks = artifactStacksByAnchorIndex.get(eventIndex);
        if (!stacks) continue;
        for (const stack of stacks) {
          const rowKey = `end-artifact-stack:${stack.anchorEventIndex}`;
          const expanded = expandedArtifactStacks.has(rowKey);
          rows.push({
            kind: "artifact-stack",
            key: rowKey,
            estimatedHeight: estimateEndOfTaskArtifactStackHeight(stack.artifacts, expanded),
            artifacts: stack.artifacts,
            revision: [
              expanded ? "expanded" : "collapsed",
              stack.artifacts
                .map((artifact) => `${artifact.path}:${artifact.kind}:${artifact.eventId ?? "none"}`)
                .join("|"),
            ].join(":"),
            visiblePerfEventId: null,
          });
        }
      }
    };
    let lastActionBlockTimelineIndex = -1;
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      if (timelineItems[i].kind === "action_block") {
        lastActionBlockTimelineIndex = i;
        break;
      }
    }

    if (leadingCommandOutputSessions.length > 0) {
      rows.push({
        kind: "leading-command-outputs",
        key: "command-outputs:-1",
        estimatedHeight: 180,
        sessions: leadingCommandOutputSessions,
        revision: getCommandOutputSessionsRevision(leadingCommandOutputSessions),
        visiblePerfEventId: null,
      });
    }

    if (hasMoreTimelineHistory || timelineHistoryError) {
      rows.unshift({
        kind: "history-control",
        key: "timeline-history-control",
        estimatedHeight: timelineHistoryError ? 64 : 44,
        hasMoreHistory: Boolean(hasMoreTimelineHistory),
        isLoading: Boolean(isLoadingTimelineHistory),
        error: timelineHistoryError ?? null,
        revision: [
          hasMoreTimelineHistory ? "more" : "done",
          isLoadingTimelineHistory ? "loading" : "idle",
          timelineHistoryError ?? "none",
        ].join(":"),
        visiblePerfEventId: null,
      });
    }

    timelineItems.forEach((item, timelineIndex) => {
      let visiblePerfEventId: string | null = null;
      const key =
        item.kind === "canvas"
          ? `canvas:${item.session.id}`
          : item.kind === "cli-agent-frame"
            ? `cli-agent:${item.childTask.id}`
            : item.kind === "dispatched-agents"
              ? "dispatched-agents"
              : item.kind === "action_block"
                ? `action-block:${item.blockId}`
                : `event:${item.event.id}`;
      if (item.kind === "event") {
        visiblePerfEventId = item.event.id;
      } else if (item.kind === "action_block") {
        const actionBlockState = getActionBlockRenderState(
          item.events as TaskEvent[],
          item.eventIndices,
          item.blockId,
        );
        if (actionBlockState.renderableCount === 0 && !actionBlockState.hasBlockCommandOutputs) {
          return;
        }
        const visibleBlockEvents = actionBlockState.visibleBlockEvents;
        visiblePerfEventId = visibleBlockEvents[visibleBlockEvents.length - 1]?.id ?? null;
      }
      const revision =
        item.kind === "canvas"
          ? `${item.session.id}:${item.forceSnapshot ? 1 : 0}`
          : item.kind === "cli-agent-frame"
            ? `${item.childTask.id}:${item.childTask.status}:${item.childTaskEvents.length}:${
                item.childTaskEvents[item.childTaskEvents.length - 1]?.id ?? "none"
              }`
            : item.kind === "dispatched-agents"
              ? `${childTasks
                  .map((childTask) => `${childTask.id}:${childTask.status}`)
                  .join(",")}:${childEvents.length}:${collaborativeRun?.id ?? "none"}`
              : item.kind === "action_block"
                ? `${item.blockId}:${item.events.length}:${
                    item.events[item.events.length - 1]?.id ?? "none"
                  }:${item.eventIndices
                    .map((eventIndex: number) =>
                      getCommandOutputSessionsRevision(
                        commandOutputSessionsByInsertIndex.get(eventIndex),
                      ),
                    )
                    .join("||")}`
                : `${item.event.id}:${getEffectiveTaskEventType(item.event)}:${
                    toolCallPairing.completions.get(item.event.id)?.id ?? "none"
                  }:${getCommandOutputSessionsRevision(
                    commandOutputSessionsByInsertIndex.get(item.eventIndex),
                  )}`;

      rows.push({
        kind: "timeline",
        key,
        estimatedHeight:
          item.kind === "action_block"
            ? (() => {
                const actionBlockState = getActionBlockRenderState(
                  item.events as TaskEvent[],
                  item.eventIndices,
                  item.blockId,
                );
                if (actionBlockState.renderableCount === 0) {
                  return actionBlockState.hasBlockCommandOutputs ? 180 : 0;
                }
                const isLatestActionBlock = timelineIndex === lastActionBlockTimelineIndex;
                const isActive = isLatestActionBlock && (isTaskWorking || isReplayMode);
                const expanded = resolveDisclosureExpanded({
                  forceExpanded: isActive,
                  defaultExpanded: isLatestActionBlock,
                  toggled: expandedActionBlocks.has(item.blockId),
                });
                const visibleEventCount = expanded
                  ? actionBlockState.visibleBlockEvents.length
                  : 0;
                return estimateTaskFeedRowHeight(item, {
                  expanded,
                  visibleEventCount,
                  hasVisibilityToggle:
                    expanded &&
                    (actionBlockState.hiddenBlockEventCount > 0 ||
                      showAllActionBlocks.has(item.blockId)),
                });
              })()
            : estimateTaskFeedRowHeight(item),
        timelineIndex,
        item,
        revision,
        visiblePerfEventId,
      });
      pushArtifactStacksForTimelineItem(item);
    });

    return rows;
  }, [
    childEvents,
    childTasks,
    collaborativeRun?.id,
    commandOutputSessionsByInsertIndex,
    leadingCommandOutputSessions,
    hasMoreTimelineHistory,
    isLoadingTimelineHistory,
    timelineHistoryError,
    timelineItems,
    showAllActionBlocks,
    expandedActionBlocks,
    shouldRenderTimelineEventInStepFeed,
    suppressedParallelEventIds,
    parallelGroupsByAnchorEventId,
    toolCallPairing.completions,
    isTaskWorking,
    isReplayMode,
    getActionBlockRenderState,
    events,
    expandedArtifactStacks,
  ]);
  const displayFeedRows = useMemo(
    () =>
      feedRows.filter((row) => {
        if (row.kind === "history-control") return true;
        if (row.kind === "leading-command-outputs") return row.sessions.length > 0;
        if (row.kind === "artifact-stack") return Boolean(workspace?.path);
        if (row.kind !== "timeline") return true;

        const { item } = row;
        if (item.kind === "canvas" || item.kind === "cli-agent-frame" || item.kind === "dispatched-agents") {
          return true;
        }
        if (item.kind === "action_block") {
          return !isChatTask;
        }
        if (item.kind !== "event") return true;

        const event = item.event as TaskEvent;
        const effectiveType = getEffectiveTaskEventType(event);
        const isUserMessage = effectiveType === "user_message";
        const isAssistantMessage = effectiveType === "assistant_message";
        const isCompletionSummaryMessage = getCompletionSummaryText(event).length > 0;
        const commandOutputsAfterEvent = commandOutputSessionsByInsertIndex.get(item.eventIndex);
        const hasCommandOutputs = Boolean(commandOutputsAfterEvent?.length);

        if (isChatTask && !isUserMessage && !isAssistantMessage && !isCompletionSummaryMessage) {
          return (effectiveType === "llm_streaming" && isTaskWorking) || hasCommandOutputs;
        }

        if (isUserMessage) {
          const suppressedInitialPrompt = shouldSuppressInitialPromptUserEvent({
            event,
            initialPromptEventId,
            trimmedPrompt,
            taskCreatedAt: task?.createdAt,
          });
          return !suppressedInitialPrompt || hasCommandOutputs;
        }

        if (isAssistantMessage || isCompletionSummaryMessage) return true;

        const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
        if (suppressedParallelEventIds.has(event.id) && !parallelGroup) {
          return hasCommandOutputs;
        }
        if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
          return hasCommandOutputs;
        }
        return true;
      }),
    [
      commandOutputSessionsByInsertIndex,
      feedRows,
      initialPromptEventId,
      isChatTask,
      isTaskWorking,
      parallelGroupsByAnchorEventId,
      shouldRenderTimelineEventInStepFeed,
      suppressedParallelEventIds,
      task?.createdAt,
      trimmedPrompt,
      workspace?.path,
    ],
  );
  const { visibleFeedRows, hiddenLiveFeedRowCount } = useMemo(
    () => selectVisibleTaskFeedRows(displayFeedRows, transcriptMode),
    [displayFeedRows, transcriptMode],
  );
  const reasoningPanelState = useMemo(
    () =>
      deriveAgentReasoningPanelState({
        events,
        taskId: task?.id,
        isTaskWorking,
      }),
    [events, isTaskWorking, task?.id],
  );
  const showReasoningPanel =
    transcriptMode === "live" &&
    !isChatTask &&
    isTaskWorking &&
    hasAgentReasoningPanelContent(reasoningPanelState);
  const reasoningPanelSignature = showReasoningPanel
    ? [
        currentStep?.description || "",
        reasoningPanelState.isStreaming ? "1" : "0",
        reasoningPanelState.activeStreamText,
        reasoningPanelState.recentUpdates.join("\n"),
      ].join("::")
    : "";
  const feedRowRenderCacheRef = useRef<Map<string, { signature: string; node: React.ReactNode }>>(
    new Map(),
  );

  useEffect(() => {
    const activeKeys = new Set(visibleFeedRows.map((row) => row.key));
    for (const key of feedRowRenderCacheRef.current.keys()) {
      if (!activeKeys.has(key)) {
        feedRowRenderCacheRef.current.delete(key);
      }
    }
  }, [visibleFeedRows]);
  useEffect(() => {
    const activeActionBlockIds = new Set(
      timelineItems
        .filter((item: Any) => item.kind === "action_block")
        .map((item: Any) => item.blockId as string),
    );
    if (hasInactiveStringSetEntries(expandedActionBlocks, activeActionBlockIds)) {
      setExpandedActionBlocks(pruneStringSetToActiveIds(expandedActionBlocks, activeActionBlockIds));
    }
    if (hasInactiveStringSetEntries(showAllActionBlocks, activeActionBlockIds)) {
      setShowAllActionBlocks(pruneStringSetToActiveIds(showAllActionBlocks, activeActionBlockIds));
    }
  }, [timelineItems, expandedActionBlocks, showAllActionBlocks]);
  const lastActionBlockTimelineIndex = useMemo(() => {
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      if (timelineItems[i].kind === "action_block") return i;
    }
    return -1;
  }, [timelineItems]);

  const conversationFlow = useMemo(
    () => (
      <>
        {/* Conversation Flow - renders all events in order; show when we have events OR collaborative run with child tasks */}
        {(events.length > 0 || (collaborativeRun && childTasks.length > 0) || isTaskWorking) &&
          (() => {
                const getRowRenderSignature = (row: TaskFeedRow): string => {
                  if (row.kind === "history-control") {
                    return row.revision;
                  }
                  if (row.kind === "leading-command-outputs") {
                    return row.revision;
                  }
                  if (row.kind === "artifact-stack") {
                    return row.revision;
                  }

                  const { item, timelineIndex } = row;
                  if (item.kind === "canvas" || item.kind === "cli-agent-frame") {
                    return row.revision;
                  }
                  if (item.kind === "dispatched-agents") {
                    return `${row.revision}:${wrappingUp ? 1 : 0}`;
                  }
                  if (item.kind === "action_block") {
                    const visibleEventState = item.events
                      .map((event: TaskEvent) => {
                        const toggled = toggledEvents.has(event.id) ? 1 : 0;
                        const parallel = parallelGroupsByAnchorEventId.has(event.id) ? 1 : 0;
                        const suppressed = suppressedParallelEventIds.has(event.id) ? 1 : 0;
                        return `${event.id}:${getTaskEventPayloadRenderSignature(event)}:${toggled}:${parallel}:${suppressed}`;
                      })
                      .join("|");
                    return [
                      row.revision,
                      expandedActionBlocks.has(item.blockId) ? 1 : 0,
                      showAllActionBlocks.has(item.blockId) ? 1 : 0,
                      timelineIndex === lastActionBlockTimelineIndex ? 1 : 0,
                      isTaskWorking ? 1 : 0,
                      isReplayMode ? 1 : 0,
                      verboseSteps ? 1 : 0,
                      visibleEventState,
                    ].join(":");
                  }

                  const event = item.event as TaskEvent;
                  const effectiveType = getEffectiveTaskEventType(event);
                  return [
                    row.revision,
                    toggledEvents.has(event.id) ? 1 : 0,
                    rejectMenuOpenFor === event.id ? 1 : 0,
                    messageFeedbackMap.get(event.id) ?? "none",
                    lastAssistantMessage?.id === event.id ? 1 : 0,
                    stepFeedbackOpen ? 1 : 0,
                    stepFeedbackSending ? 1 : 0,
                    stepFeedbackText,
                    currentStep?.description ?? "none",
                    task.status,
                    task.terminalStatus ?? "none",
                    isTaskWorking ? 1 : 0,
                    verboseSteps ? 1 : 0,
                    effectiveType,
                    getTaskEventPayloadRenderSignature(event),
                    parallelGroupsByAnchorEventId.has(event.id) ? 1 : 0,
                    suppressedParallelEventIds.has(event.id) ? 1 : 0,
                  ].join(":");
                };

                const renderFeedRow = (row: TaskFeedRow) => {
                  if (row.kind === "history-control") {
                    return null;
                  }
                  if (row.kind === "leading-command-outputs") {
                    return renderCommandOutputs(row.sessions);
                  }
                  if (row.kind === "artifact-stack") {
                    if (!workspace?.path) return null;
                    const expanded = expandedArtifactStacks.has(row.key);
                    const { visibleArtifacts, hiddenCount } =
                      getVisibleEndOfTaskArtifactCards(row.artifacts, expanded);
                    return (
                      <div className="conversation-artifact-stack assistant-artifact-cards">
                        {visibleArtifacts.map((artifact) => {
                          if (artifact.kind === "spreadsheet") {
                            return (
                              <SpreadsheetArtifactCard
                                key={artifact.path}
                                filePath={artifact.path}
                                workspacePath={workspace.path}
                                onOpenViewer={onOpenSpreadsheetArtifact || setViewerFilePath}
                              />
                            );
                          }
                          if (artifact.kind === "document") {
                            return (
                              <DocumentArtifactCard
                                key={artifact.path}
                                filePath={artifact.path}
                                workspacePath={workspace.path}
                                onOpenViewer={onOpenDocumentArtifact || setViewerFilePath}
                              />
                            );
                          }
                          if (artifact.kind === "presentation") {
                            return (
                              <PresentationArtifactCard
                                key={artifact.path}
                                filePath={artifact.path}
                                workspacePath={workspace.path}
                                onOpenViewer={onOpenPresentationArtifact || setViewerFilePath}
                              />
                            );
                          }
                          if (artifact.kind === "html") {
                            return (
                              <WebArtifactCard
                                key={artifact.path}
                                filePath={artifact.path}
                                workspacePath={workspace.path}
                                onOpenViewer={onOpenWebArtifact || setViewerFilePath}
                              />
                            );
                          }
                          return null;
                        })}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            className="conversation-artifact-stack-show-more"
                            onClick={() => expandArtifactStack(row.key)}
                            aria-label={`Show ${hiddenCount} more generated files`}
                          >
                            <span>Show {hiddenCount} more</span>
                            <ChevronDown size={17} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    );
                  }

                  const { item, timelineIndex } = row;
                if (item.kind === "canvas") {
                  return (
                    <CanvasPreview
                      session={item.session}
                      onClose={() => handleCanvasClose(item.session.id)}
                      forceSnapshot={item.forceSnapshot}
                      onOpenBrowser={onOpenBrowserView}
                    />
                  );
                }

                if (item.kind === "cli-agent-frame") {
                  const agentType = resolveCliAgentType(item.childTask, item.childTaskEvents) || "codex-cli";
                  return (
                    <CliAgentFrame
                      task={item.childTask}
                      events={item.childTaskEvents}
                      agentType={agentType}
                      defaultExpanded={item.childTask.status === "executing"}
                      onOpenAgent={onOpenChildAgentSidebar ?? onSelectChildTask}
                    />
                  );
                }

                if (item.kind === "dispatched-agents") {
                  // Collaborative runs own every child agent in the shared team-run surface.
                  const nonCliChildTasks = childTasks.filter((t) => !isCliAgentChildTask(t));
                  const panelTasks = collaborativeRun
                    ? childTasks
                    : nonCliChildTasks.length > 0
                      ? nonCliChildTasks
                      : childTasks;
                  const panelEvents = childEvents.filter((e) =>
                    panelTasks.some((t) => t.id === e.taskId),
                  );
                  return (
                    <div key="dispatched-agents" className="collaborative-thoughts-main">
                      {collaborativeRun ? (
                        <CollaborativeSummaryPanel
                          collaborativeRun={collaborativeRun}
                          childTasks={panelTasks}
                          childEvents={panelEvents}
                          userPrompt={task?.rawPrompt || task?.userPrompt || task?.prompt}
                          onSelectChildTask={onSelectChildTask}
                          onOpenChildAgentSidebar={onOpenChildAgentSidebar}
                          mainTaskCompleted={
                            !!task &&
                            ["completed", "failed", "cancelled"].includes(task.status)
                          }
                          isWrappingUp={wrappingUp}
                        />
                      ) : (
                        <DispatchedAgentsPanel
                          parentTaskId={task!.id}
                          childTasks={panelTasks}
                          childEvents={panelEvents}
                          onSelectChildTask={onSelectChildTask}
                          onOpenChildAgentSidebar={onOpenChildAgentSidebar}
                        />
                      )}
                    </div>
                  );
                }

                if (item.kind === "action_block") {
                  if (isChatTask) return null;
                  const isBlockOnlyMinimalCompletions =
                    !verboseSteps &&
                    item.events.length > 0 &&
                    item.events.every((ev: TaskEvent) => {
                      const t = getEffectiveTaskEventType(ev);
                      const out = resolveTaskOutputSummaryFromCompletionEvent(ev, events);
                      return t === "task_completed" && !hasTaskOutputs(out);
                    });
                  if (isBlockOnlyMinimalCompletions) {
                    const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                    const showConnectorAbove =
                      typeof indicatorPosition === "number" && indicatorPosition > 0;
                    const showConnectorBelow =
                      typeof indicatorPosition === "number" &&
                      indicatorPosition < stepFeedEventCount - 1;
                    const commandOutputsForBlock = item.eventIndices.flatMap((ei: number) =>
                      commandOutputSessionsByInsertIndex.get(ei) ?? [],
                    );
                    return (
                      <Fragment key={item.blockId}>
                        {item.events.map((event: TaskEvent, idx: number) => {
                          const eventIndex = item.eventIndices[idx];
                          if (!shouldRenderTimelineEventInStepFeed(event)) return null;
                          const isLastChild = idx === item.events.length - 1;
                          const showChildConnectorAbove = idx === 0 ? showConnectorAbove : true;
                          const showChildConnectorBelow = !isLastChild || showConnectorBelow;
                          return (
                            <div
                              key={event.id || `event-${eventIndex}`}
                              className="timeline-event completion-compact"
                            >
                              <div className="event-indicator">
                                {showChildConnectorAbove && (
                                  <span className="event-connector event-connector-above" aria-hidden="true" />
                                )}
                                <span
                                  className="event-indicator-icon tone-success"
                                  aria-hidden="true"
                                  title="Done"
                                >
                                  <CheckIcon size={12} strokeWidth={2} />
                                </span>
                                {showChildConnectorBelow && (
                                  <span className="event-connector event-connector-below" aria-hidden="true" />
                                )}
                              </div>
                              <div className="event-content completion-compact-content">
                                <span className="completion-compact-label">Done</span>
                                <span className="event-time-muted">{formatTime(event.timestamp)}</span>
                              </div>
                            </div>
                          );
                        })}
                        {renderCommandOutputs(commandOutputsForBlock)}
                      </Fragment>
                    );
                  }
                  const isLatestActionBlock = timelineIndex === lastActionBlockTimelineIndex;
                  const isActive =
                    isLatestActionBlock && (isTaskWorking || isReplayMode);
                  const actionBlockState = getActionBlockRenderState(
                    item.events as TaskEvent[],
                    item.eventIndices,
                    item.blockId,
                  );
                  const {
                    renderableCount,
                    renderableEvents,
                    visibleBlockEvents,
                    visibleBlockEventIndices,
                    hiddenBlockEventCount,
                    hasBlockCommandOutputs,
                    commandOutputsForBlock,
                  } = actionBlockState;
                  if (renderableCount === 0) {
                    if (hasBlockCommandOutputs) {
                      return (
                        <Fragment key={item.blockId}>
                          {renderCommandOutputs(commandOutputsForBlock)}
                        </Fragment>
                      );
                    }
                    return null;
                  }
                  const { summary, iconKind, stepCount, toolCallCount, durationMs, outputTokens } = buildActionBlockSummary(
                    renderableEvents,
                    events,
                    { isActive },
                  );
                  const expanded = resolveDisclosureExpanded({
                    forceExpanded: isActive,
                    defaultExpanded: isLatestActionBlock,
                    toggled: expandedActionBlocks.has(item.blockId),
                  });
                  const onToggle = () => {
                    setExpandedActionBlocks((prev) => {
                      const next = new Set(prev);
                      if (next.has(item.blockId)) next.delete(item.blockId);
                      else next.add(item.blockId);
                      return next;
                    });
                  };
                  const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                  const showConnectorAbove =
                    typeof indicatorPosition === "number" && indicatorPosition > 0;
                  const showConnectorBelow =
                    typeof indicatorPosition === "number" &&
                    indicatorPosition < stepFeedEventCount - 1;
                  const isBlockShowAll = showAllActionBlocks.has(item.blockId);
                  // Exclude sessions shown inline inside currently visible expanded run_command frames.
                  // Hidden rows must not suppress their command outputs, or terminals disappear from the windowed feed.
                  const inlineRunCommandSessionIds = collectInlineRunCommandSessionIds({
                    events: visibleBlockEvents,
                    eventIndices: visibleBlockEventIndices,
                    commandOutputSessionsByInsertIndex,
                    isEventExpanded,
                  });
                  const lastVisibleBlockEvent = visibleBlockEvents[visibleBlockEvents.length - 1];
                  const lastVisibleRenderEvent = lastVisibleBlockEvent
                    ? toolCallPairing.completions.get(lastVisibleBlockEvent.id) ?? lastVisibleBlockEvent
                    : undefined;
                  const lastStepLabelRaw = lastVisibleRenderEvent
                    ? renderEventTitle(lastVisibleRenderEvent, workspace?.path, setViewerFilePath, agentContext, { summaryMode: !verboseSteps })
                    : undefined;
                  const lastStepLabel =
                    isActive && typeof lastStepLabelRaw === "string" ? lastStepLabelRaw : undefined;
                  const isFinishedActionBlockTask =
                    task.status === "completed" || task.status === "failed" || task.status === "cancelled";
                  const actionBlockDurationMs =
                    isLatestActionBlock && (isTaskWorking || isFinishedActionBlockTask) ? 0 : durationMs;
                  return (
                    <Fragment key={item.blockId}>
                      <ActionBlock
                        blockId={item.blockId}
                        summary={summary}
                        iconKind={iconKind}
                        stepCount={stepCount}
                        toolCallCount={toolCallCount}
                        durationMs={actionBlockDurationMs}
                        outputTokens={outputTokens}
                        isActive={isActive}
                        expanded={expanded}
                        onToggle={onToggle}
                        showConnectorAbove={showConnectorAbove}
                        showConnectorBelow={showConnectorBelow}
                        lastStepLabel={lastStepLabel}
                      >
                        {hiddenBlockEventCount > 0 && (
                          <button
                            type="button"
                            className="action-block-show-all-btn"
                            onClick={() =>
                              setShowAllActionBlocks((prev) => {
                                const next = new Set(prev);
                                next.add(item.blockId);
                                return next;
                              })
                            }
                          >
                            ↑ Show all ({renderableCount} steps)
                          </button>
                        )}
                        {isBlockShowAll && (
                          <button
                            type="button"
                            className="action-block-show-all-btn action-block-show-less-btn"
                            onClick={() =>
                              setShowAllActionBlocks((prev) => {
                                const next = new Set(prev);
                                next.delete(item.blockId);
                                return next;
                              })
                            }
                          >
                            Show less
                          </button>
                        )}
                        {(() => {
                          const nestedParallelEventIds = new Set<string>();
                          return visibleBlockEvents.map((event: TaskEvent, idx: number) => {
                            if (nestedParallelEventIds.has(event.id)) return null;

                            const eventIndex = visibleBlockEventIndices[idx];
                            const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
                            if (suppressedParallelEventIds.has(event.id) && !parallelGroup) return null;
                            if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
                              return null;
                            }
                            const isLastChild = idx === visibleBlockEvents.length - 1;
                            const showChildConnectorAbove = true;
                            const showChildConnectorBelow = !isLastChild || showConnectorBelow;

                            const perEventCmdSessions = (
                              commandOutputSessionsByInsertIndex.get(eventIndex) ?? []
                            ).filter((s: CommandOutputSession) => !inlineRunCommandSessionIds.has(s.id));

                            if (parallelGroup) {
                              const shouldDefaultExpandGroup =
                                isLatestActionBlock && idx === visibleBlockEvents.length - 1;
                              return (
                                <Fragment key={event.id || `event-${eventIndex}`}>
                                  <ParallelGroupFeed
                                    group={parallelGroup}
                                    timeLabel={formatTime(parallelGroup.startedAt)}
                                    formatTime={formatTime}
                                    showConnectorAbove={showChildConnectorAbove}
                                    showConnectorBelow={showChildConnectorBelow}
                                    defaultExpanded={isActive || shouldDefaultExpandGroup}
                                  />
                                  {renderCommandOutputs(perEventCmdSessions)}
                                </Fragment>
                              );
                            }

                            const nestedParallelChildren: Array<{
                              event: TaskEvent;
                              eventIndex: number;
                              group: Any;
                            }> = [];
                            const parentStepId =
                              canStepEventOwnParallelChildren(event) ? getTimelineEventStepId(event) : null;
                            if (parentStepId) {
                              for (let childIdx = idx + 1; childIdx < visibleBlockEvents.length; childIdx += 1) {
                                const childEvent = visibleBlockEvents[childIdx] as TaskEvent;
                                const childParallelGroup = parallelGroupsByAnchorEventId.get(childEvent.id);
                                if (!childParallelGroup) break;
                                const ownerStepId = getParallelGroupOwnerStepId(childParallelGroup.groupId);
                                if (!ownerStepId || ownerStepId !== parentStepId) break;
                                nestedParallelEventIds.add(childEvent.id);
                                nestedParallelChildren.push({
                                  event: childEvent,
                                  eventIndex: visibleBlockEventIndices[childIdx] as number,
                                  group: childParallelGroup,
                                });
                              }
                            }

                            const effectiveType = getEffectiveTaskEventType(event);
                            const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(
                              event,
                              events,
                            );
                            const completionSummaryText = getCompletionSummaryText(event);
                            const isMinimalCompletion =
                              !verboseSteps &&
                              effectiveType === "task_completed" &&
                              !hasTaskOutputs(outputSummary) &&
                              completionSummaryText.length === 0;
                            if (isMinimalCompletion) {
                              return (
                                <Fragment key={event.id || `event-${eventIndex}`}>
                                  <div className="timeline-event completion-compact">
                                    <div className="event-indicator">
                                      {showChildConnectorAbove && (
                                        <span className="event-connector event-connector-above" aria-hidden="true" />
                                      )}
                                      <span
                                        className="event-indicator-icon tone-success"
                                        aria-hidden="true"
                                        title="Done"
                                      >
                                        <CheckIcon size={12} strokeWidth={2} />
                                      </span>
                                      {showChildConnectorBelow && (
                                        <span className="event-connector event-connector-below" aria-hidden="true" />
                                      )}
                                    </div>
                                    <div className="event-content completion-compact-content">
                                      <span className="completion-compact-label">Done</span>
                                      <span className="event-time-muted">{formatTime(event.timestamp)}</span>
                                    </div>
                                  </div>
                                  {renderCommandOutputs(perEventCmdSessions)}
                                </Fragment>
                              );
                            }

                            const hasNestedChildren = nestedParallelChildren.length > 0;
                            const isExpandable = hasEventDetails(event) || hasNestedChildren;
                            const shouldDefaultExpandChild =
                              isExpandable &&
                              (hasNestedChildren ||
                                shouldDefaultExpand(event) ||
                                (isLatestActionBlock && idx === visibleBlockEvents.length - 1));
                            const isExpanded = resolveDisclosureExpanded({
                              forceExpanded: isExpandable && isActive,
                              defaultExpanded: shouldDefaultExpandChild,
                              toggled: toggledEvents.has(event.id),
                            });
                            const toolCallResultEvent = toolCallPairing.completions.get(event.id);
                            const renderEvent = toolCallResultEvent ?? event;
                            const eventTitle = renderEventTitle(
                              renderEvent,
                              workspace?.path,
                              setViewerFilePath,
                              agentContext,
                              { summaryMode: !verboseSteps },
                            );
                            const eventDetails = hasEventDetails(event)
                              ? renderEventDetails(event, voiceEnabled, markdownComponents, {
                                  workspacePath: workspace?.path,
                                  onOpenViewer: setViewerFilePath,
                                  onOpenSpreadsheetArtifact,
                                  onOpenDocumentArtifact,
                                  onOpenPresentationArtifact,
                                  onOpenWebArtifact,
                                  onQuoteAssistantMessage,
                                  onForkTaskSession: onForkTaskSessionFromEvent,
                                  events,
                                  onViewOutputs: onViewTaskOutputs,
                                  hideVerificationSteps: true,
                                  summaryMode: !verboseSteps,
                                  task,
                                  childTasks,
                                  commandOutputSessions:
                                    commandOutputSessionsByInsertIndex.get(eventIndex) ?? [],
                                  renderCommandOutput: renderCommandOutputs,
                                  deferEndOfTaskArtifactCards: true,
                                })
                              : undefined;

                            return (
                              <Fragment key={event.id || `event-${eventIndex}`}>
                                <StepFeed
                                  title={
                                    typeof eventTitle === "string" ? (
                                      <DeferredMarkdown components={eventTitleMarkdownComponents}>
                                        {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                                      </DeferredMarkdown>
                                    ) : (
                                      eventTitle
                                    )
                                  }
                                  titleTooltip={typeof eventTitle === "string" ? eventTitle : undefined}
                                  timeLabel={formatTime(event.timestamp)}
                                  hideTime
                                  indicator={resolveTimelineIndicator(renderEvent, {
                                    isTaskCompleted: !isTaskWorking,
                                  })}
                                  showConnectorAbove={showChildConnectorAbove}
                                  showConnectorBelow={showChildConnectorBelow}
                                  showBranchStub={shouldShowTimelineBranchStub(event)}
                                  expandable={isExpandable}
                                  expanded={isExpanded}
                                  onToggle={
                                    isExpandable ? () => toggleEventExpanded(event.id) : undefined
                                  }
                                  details={
                                    isExpanded ? (
                                      <>
                                        {hasNestedChildren ? (
                                          <div className="timeline-step-child-groups">
                                            {nestedParallelChildren.map((child) => {
                                              const childCmdSessions = (
                                                commandOutputSessionsByInsertIndex.get(child.eventIndex) ?? []
                                              ).filter(
                                                (s: CommandOutputSession) => !inlineRunCommandSessionIds.has(s.id),
                                              );
                                              return (
                                                <Fragment key={child.event.id || `event-${child.eventIndex}`}>
                                                  <ParallelGroupFeed
                                                    group={child.group}
                                                    timeLabel={formatTime(child.group.startedAt)}
                                                    formatTime={formatTime}
                                                  />
                                                  {renderCommandOutputs(childCmdSessions)}
                                                </Fragment>
                                              );
                                            })}
                                          </div>
                                        ) : null}
                                        {eventDetails}
                                      </>
                                    ) : undefined
                                  }
                                />
                                {renderCommandOutputs(perEventCmdSessions)}
                              </Fragment>
                            );
                          });
                        })()}
                      </ActionBlock>
                    </Fragment>
                  );
                }

                const event = item.event;
                const effectiveType = getEffectiveTaskEventType(event);
                const isUserMessage = effectiveType === "user_message";
                const isAssistantMessage = effectiveType === "assistant_message";
                const completionSummaryText = getCompletionSummaryText(event);
                const isCompletionSummaryMessage = completionSummaryText.length > 0;
                const commandOutputsAfterEvent = commandOutputSessionsByInsertIndex.get(
                  item.eventIndex,
                );

                if (isChatTask && !isUserMessage && !isAssistantMessage && !isCompletionSummaryMessage) {
                  if (effectiveType === "llm_streaming" && isTaskWorking) {
                    const streamingText =
                      typeof event.payload?.text === "string"
                        ? event.payload.text
                        : typeof event.payload?.message === "string"
                          ? event.payload.message
                          : "";
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        <div className="chat-message assistant-message">
                          <div className="chat-bubble assistant-bubble">
                            <div className="chat-bubble-content markdown-content">
                              <AssistantMessageContent
                                message={cleanAssistantMessageForDisplay(streamingText)}
                                markdownComponents={markdownComponents}
                                workspacePath={workspace?.path}
                                onOpenViewer={setViewerFilePath}
                              />
                            </div>
                          </div>
                        </div>
                      </Fragment>
                    );
                  }
                  if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  return null;
                }

                // Render user messages as chat bubbles on the right
                if (isUserMessage) {
                  if (
                    shouldSuppressInitialPromptUserEvent({
                      event,
                      initialPromptEventId,
                      trimmedPrompt,
                      taskCreatedAt: task?.createdAt,
                    })
                  ) {
                    if (!commandOutputsAfterEvent || commandOutputsAfterEvent.length === 0) {
                      return null;
                    }
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  const rawMessage = event.payload?.message || "User message";
                  const messageText =
                    typeof rawMessage === "string"
                      ? normalizeInitialPromptText(rawMessage)
                      : "User message";
                  const messageIntegrationMentions =
                    Array.isArray(event.payload?.integrationMentions)
                      ? (event.payload.integrationMentions as IntegrationMentionSelection[])
                      : task?.agentConfig?.integrationMentions;
                  const quotedAssistantMessage = event.payload?.quotedAssistantMessage as
                    | QuotedAssistantMessage
                    | undefined;
                  const attachmentNames = extractAttachmentNames(rawMessage);
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message user-message">
                        {quotedAssistantMessage?.message ? (
                          <div className="quoted-follow-up-shell">
                            <div className="quoted-follow-up-context">
                              <span className="quoted-follow-up-context-icon">↪</span>
                              <span className="quoted-follow-up-context-text">
                                {summarizeQuotedAssistantMessage(quotedAssistantMessage.message, 520)}
                              </span>
                            </div>
                            <div className="quoted-follow-up-reply markdown-content">
                              <UserMessageText
                                text={messageText}
                                integrationMentions={messageIntegrationMentions}
                                markdownComponents={markdownComponents}
                              />
                            </div>
                            {attachmentNames.length > 0 && (
                              <div className="bubble-attachments quoted-follow-up-attachments">
                                {attachmentNames.map((name, i) => (
                                  <span className="bubble-attachment-chip" key={i}>
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <path d="M14 2v6h6" />
                                    </svg>
                                    <span className="bubble-attachment-name" title={name}>
                                      {name}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : (
                          <CollapsibleUserBubble>
                            <UserMessageText
                              text={messageText}
                              integrationMentions={messageIntegrationMentions}
                              markdownComponents={markdownComponents}
                            />
                            {attachmentNames.length > 0 && (
                              <div className="bubble-attachments">
                                {attachmentNames.map((name, i) => (
                                  <span className="bubble-attachment-chip" key={i}>
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    >
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <path d="M14 2v6h6" />
                                    </svg>
                                    <span className="bubble-attachment-name" title={name}>
                                      {name}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </CollapsibleUserBubble>
                        )}
                        <MessageCopyButton text={messageText} />
                      </div>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                // Render assistant messages as chat bubbles on the left
                if (isAssistantMessage || isCompletionSummaryMessage) {
                  const messageText = isCompletionSummaryMessage ? completionSummaryText : event.payload?.message || "";
                  const cleanedMessageText = cleanAssistantMessageForDisplay(messageText);
                  const quotedAssistantMessage = createQuotedAssistantMessage(
                    cleanedMessageText,
                    event.id,
                    event.taskId,
                  );
                  const isLastAssistant = event === lastAssistantMessage;
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message assistant-message">
                        <div className="chat-bubble assistant-bubble">
                          {isLastAssistant && !isChatTask && (
                            <div className="chat-bubble-header">
                              {task.status === "completed" && (
                                <span className="chat-status">
                                  {task.terminalStatus === "needs_user_action"
                                    ? "Completed - action required"
                                    : task.terminalStatus === "partial_success"
                                      ? "Completed - partial success"
                                      : agentContext.getMessage("taskComplete")}
                                </span>
                              )}
                              {task.status === "paused" && (
                                <span className="chat-status">
                                  {task.awaitingUserInputReasonCode === "skill_parameters"
                                    ? "Waiting for your skill answer"
                                    : "Waiting for your direction"}
                                </span>
                              )}
                              {task.status === "blocked" && (
                                <span className="chat-status">
                                  {task.terminalStatus === "awaiting_approval"
                                    ? agentContext.getMessage("taskBlocked") || "Needs approval"
                                    : "Waiting for your input"}
                                </span>
                              )}
                              {task.status === "interrupted" && task.terminalStatus === "resume_available" && (
                                <span className="chat-status">Interrupted - resume available</span>
                              )}
                            </div>
                          )}
                          <div className="chat-bubble-content markdown-content">
                            <AssistantMessageContent
                              message={cleanedMessageText}
                              markdownComponents={markdownComponents}
                              workspacePath={workspace?.path}
                              onOpenViewer={setViewerFilePath}
                            />
                          </div>
                        </div>
                        <div className="message-actions">
                          <MessageCopyButton text={messageText} />
                          <MessageSpeakButton text={messageText} voiceEnabled={voiceEnabled} />
                          {quotedAssistantMessage && onQuoteAssistantMessage && (
                            <MessageQuoteButton
                              onQuote={() => onQuoteAssistantMessage(quotedAssistantMessage)}
                            />
                          )}
                          {event.id && onForkTaskSessionFromEvent && (
                            <MessageForkButton onFork={() => onForkTaskSessionFromEvent(event)} />
                          )}
                          {event.id && !isTaskWorking && (
                            <>
                              <button
                                className={`message-feedback-btn${messageFeedbackMap.get(event.id) === "accepted" ? " active" : ""}`}
                                title="Helpful"
                                onClick={() =>
                                  void handleMessageFeedback({
                                    messageId: event.id!,
                                    decision: "accepted",
                                  })
                                }
                              >
                                👍
                              </button>
                              <div
                                ref={
                                  rejectMenuOpenFor === event.id
                                    ? rejectMenuRef
                                    : undefined
                                }
                                className="message-feedback-thumbdown-wrap"
                              >
                                <button
                                  className={`message-feedback-btn${messageFeedbackMap.get(event.id) === "rejected" ? " active" : ""}`}
                                  title="Not helpful"
                                  onClick={() =>
                                    setRejectMenuOpenFor((v) =>
                                      v === event.id ? null : (event.id ?? null),
                                    )
                                  }
                                >
                                  👎
                                </button>
                                {rejectMenuOpenFor === event.id && (
                                  <div className="message-feedback-menu">
                                    {(
                                      [
                                        ["incorrect", "Incorrect"],
                                        ["too_verbose", "Too verbose"],
                                        ["ignored_instructions", "Ignored instructions"],
                                        ["wrong_tone", "Wrong tone"],
                                        ["unsafe", "Unsafe / unwanted"],
                                      ] as const
                                    ).map(([reason, label]) => (
                                      <button
                                        key={reason}
                                        className="message-feedback-reason"
                                        onClick={() =>
                                          void handleMessageFeedback({
                                            messageId: event.id!,
                                            decision: "rejected",
                                            reason,
                                          })
                                        }
                                      >
                                        {label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                          {isLastAssistant && isTaskWorking && (
                            <button
                              className="bubble-feedback-toggle"
                              onClick={() => setStepFeedbackOpen((o) => !o)}
                              title="Give feedback"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <circle cx="12" cy="12" r="1" />
                                <circle cx="19" cy="12" r="1" />
                                <circle cx="5" cy="12" r="1" />
                              </svg>
                            </button>
                          )}
                        </div>
                        {isLastAssistant && stepFeedbackOpen && (
                          <div className="bubble-feedback-panel">
                            {currentStep && (
                              <div className="bubble-feedback-step-label">
                                {currentStep.description === "Thinking..." ? (
                                  <span className="thinking-title">
                                    Thinking
                                    <span className="thinking-ellipsis">
                                      <span>.</span>
                                      <span>.</span>
                                      <span>.</span>
                                    </span>
                                  </span>
                                ) : (
                                  currentStep.description
                                )}
                              </div>
                            )}
                            <div className="bubble-feedback-actions">
                              {currentStep && (
                                <>
                                  <button
                                    className="bubble-feedback-btn skip"
                                    disabled={stepFeedbackSending}
                                    onClick={() => handleStepFeedback("skip")}
                                  >
                                    Skip
                                  </button>
                                  <button
                                    className="bubble-feedback-btn retry"
                                    disabled={stepFeedbackSending}
                                    onClick={() => handleStepFeedback("retry")}
                                  >
                                    Retry
                                  </button>
                                </>
                              )}
                              <button
                                className="bubble-feedback-btn stop"
                                disabled={stepFeedbackSending || !currentStep}
                                onClick={() => handleStepFeedback("stop")}
                              >
                                Stop
                              </button>
                            </div>
                            <div className="bubble-feedback-input-row">
                              <input
                                className="bubble-feedback-input"
                                type="text"
                                placeholder="Adjust direction…"
                                value={stepFeedbackText}
                                onChange={(e) => setStepFeedbackText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && stepFeedbackText.trim()) {
                                    handleStepFeedback("drift", stepFeedbackText.trim());
                                  }
                                }}
                                disabled={stepFeedbackSending}
                              />
                              <button
                                className="bubble-feedback-btn drift"
                                disabled={stepFeedbackSending || !stepFeedbackText.trim()}
                                onClick={() => handleStepFeedback("drift", stepFeedbackText.trim())}
                              >
                                Send
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
                if (suppressedParallelEventIds.has(event.id) && !parallelGroup) {
                  if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  return null;
                }

                if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
                  // Even if we're not showing steps, we may still need to render command output.
                  if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  return null;
                }

                const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                const showConnectorAbove =
                  typeof indicatorPosition === "number" && indicatorPosition > 0;
                const showConnectorBelow =
                  typeof indicatorPosition === "number" &&
                  indicatorPosition < stepFeedEventCount - 1;

                if (parallelGroup) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <ParallelGroupFeed
                        group={parallelGroup}
                        timeLabel={formatTime(parallelGroup.startedAt)}
                        formatTime={formatTime}
                        showConnectorAbove={showConnectorAbove}
                        showConnectorBelow={showConnectorBelow}
                      />
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                const isExpandable = hasEventDetails(event);
                const isExpanded = isEventExpanded(event);
                const toolCallResultEvent2 = toolCallPairing.completions.get(event.id);
                const renderEvent2 = toolCallResultEvent2 ?? event;
                const eventTitle = renderEventTitle(
                  renderEvent2,
                  workspace?.path,
                  setViewerFilePath,
                  agentContext,
                  { summaryMode: !verboseSteps },
                );

                return (
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
                    <StepFeed
                      title={
                        typeof eventTitle === "string" ? (
                          <DeferredMarkdown components={eventTitleMarkdownComponents}>
                            {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                          </DeferredMarkdown>
                        ) : (
                          eventTitle
                        )
                      }
                      titleTooltip={typeof eventTitle === "string" ? eventTitle : undefined}
                      timeLabel={formatTime(event.timestamp)}
                      hideTime
                      indicator={resolveTimelineIndicator(renderEvent2, {
                        isTaskCompleted: !isTaskWorking,
                      })}
                      showConnectorAbove={showConnectorAbove}
                      showConnectorBelow={showConnectorBelow}
                      showBranchStub={shouldShowTimelineBranchStub(event)}
                      expandable={isExpandable}
                      expanded={isExpanded}
                      onToggle={isExpandable ? () => toggleEventExpanded(event.id) : undefined}
                      details={
                        isExpanded
                          ? renderEventDetails(event, voiceEnabled, markdownComponents, {
                              workspacePath: workspace?.path,
                              onOpenViewer: setViewerFilePath,
                              onOpenSpreadsheetArtifact,
                              onOpenDocumentArtifact,
                              onOpenPresentationArtifact,
                              onOpenWebArtifact,
                              onQuoteAssistantMessage,
                              events,
                              onViewOutputs: onViewTaskOutputs,
                              hideVerificationSteps: true,
                              summaryMode: !verboseSteps,
                              task,
                              childTasks,
                              commandOutputSessions: commandOutputsAfterEvent ?? [],
                              renderCommandOutput: renderCommandOutputs,
                              deferEndOfTaskArtifactCards: true,
                            })
                          : undefined
                      }
                    />
                    {renderCommandOutputs(
                      isExpanded &&
                        effectiveType === "tool_call" &&
                        event.payload?.tool === "run_command" &&
                        commandOutputsAfterEvent &&
                        commandOutputsAfterEvent.length > 0
                        ? []
                        : commandOutputsAfterEvent ?? [],
                    )}
                  </Fragment>
                );
                };

                const getRenderedFeedRow = (row: TaskFeedRow) => {
                  const signature = getRowRenderSignature(row);
                  const cached = feedRowRenderCacheRef.current.get(row.key);
                  if (cached && cached.signature === signature) {
                    return cached.node;
                  }

                  recordRendererRender(
                    "MainContent.feedRow",
                    row.key,
                    rendererPerfLoggingEnabled,
                  );
                  const node = renderFeedRow(row);
                  feedRowRenderCacheRef.current.set(row.key, { signature, node });
                  return node;
                };

                return (
                  <TaskConversationRenderedRows
                    taskId={task?.id}
                    taskSwitchId={taskSwitchId}
                    hasMoreTimelineHistory={Boolean(hasMoreTimelineHistory)}
                    isLoadingTimelineHistory={Boolean(isLoadingTimelineHistory)}
                    timelineHistoryError={timelineHistoryError}
                    onLoadMoreTimelineHistory={onLoadMoreTimelineHistory}
                    rendererPerfLoggingEnabled={Boolean(rendererPerfLoggingEnabled)}
                    visibleFeedRows={visibleFeedRows}
                    isChatTask={isChatTask}
                    isTaskWorking={isTaskWorking}
                    task={task}
                    formatTime={formatTime}
                    isReplayMode={isReplayMode}
                    transcriptMode={transcriptMode}
                    hiddenLiveFeedRowCount={hiddenLiveFeedRowCount}
                    canReturnToLiveView={defaultTranscriptMode === "live"}
                    onShowFullTimeline={showFullTimeline}
                    onBackToLiveView={returnToDefaultTranscript}
                    reasoningPanel={
                      showReasoningPanel ? (
                        <AgentReasoningPanel currentStep={currentStep} state={reasoningPanelState} />
                      ) : null
                    }
                    reasoningPanelSignature={reasoningPanelSignature}
                    mainBodyRef={mainBodyRef}
                    timelineRef={timelineRef}
                    getRenderedFeedRow={getRenderedFeedRow}
                  />
                );
              })()}
      </>
    ),
    [
      agentContext,
      childEvents,
      childTasks,
      collaborativeRun,
      commandOutputSessionsByInsertIndex,
      currentStep,
      eventTitleMarkdownComponents,
      events,
      expandedArtifactStacks,
      expandedActionBlocks,
      expandArtifactStack,
      handleCanvasClose,
      handleMessageFeedback,
      onQuoteAssistantMessage,
      handleStepFeedback,
      hasMoreTimelineHistory,
      isLoadingTimelineHistory,
      timelineHistoryError,
      isChatTask,
      isTaskWorking,
      isReplayMode,
      markdownComponents,
      mainBodyRef,
      messageFeedbackMap,
      onOpenBrowserView,
      onOpenSpreadsheetArtifact,
      onOpenDocumentArtifact,
      onOpenPresentationArtifact,
      onOpenWebArtifact,
      onQuoteAssistantMessage,
      onSelectChildTask,
      onOpenChildAgentSidebar,
      onViewTaskOutputs,
      onLoadMoreTimelineHistory,
      parallelGroupsByAnchorEventId,
      rejectMenuOpenFor,
      rejectMenuRef,
      renderCommandOutputs,
      setExpandedActionBlocks,
      setShowAllActionBlocks,
      setStepFeedbackOpen,
      setStepFeedbackText,
      setViewerFilePath,
      showAllActionBlocks,
      stepFeedbackOpen,
      stepFeedbackSending,
      stepFeedbackText,
      suppressedParallelEventIds,
      task,
      task?.status,
      task?.terminalStatus,
      feedRows,
      hiddenLiveFeedRowCount,
      transcriptMode,
      defaultTranscriptMode,
      lastActionBlockTimelineIndex,
      returnToDefaultTranscript,
      showFullTimeline,
      timelineItems,
      timelineRef,
      toggledEvents,
      toggleEventExpanded,
      visibleFeedRows,
      verboseSteps,
      voiceEnabled,
      wrappingUp,
      workspace,
      workspace?.path,
    ],
  );

  return conversationFlow;
}, areTaskConversationFlowPropsEqual);

function areTaskConversationFlowPropsEqual(prev: any, next: any): boolean {
  return (
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.taskSwitchId === next.taskSwitchId &&
    prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
    prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
    prev.timelineHistoryError === next.timelineHistoryError &&
    prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
    prev.agentContext === next.agentContext &&
    prev.childEvents === next.childEvents &&
    prev.childTasks === next.childTasks &&
    prev.collaborativeRun === next.collaborativeRun &&
    prev.commandOutputSessionsByInsertIndex === next.commandOutputSessionsByInsertIndex &&
    prev.currentStep?.description === next.currentStep?.description &&
    prev.eventTitleMarkdownComponents === next.eventTitleMarkdownComponents &&
    prev.events === next.events &&
    prev.expandedActionBlocks === next.expandedActionBlocks &&
    prev.isChatTask === next.isChatTask &&
    prev.isTaskWorking === next.isTaskWorking &&
    prev.isReplayMode === next.isReplayMode &&
    prev.defaultTranscriptMode === next.defaultTranscriptMode &&
    prev.transcriptMode === next.transcriptMode &&
    prev.lastAssistantMessage?.id === next.lastAssistantMessage?.id &&
    prev.initialPromptEventId === next.initialPromptEventId &&
    prev.markdownComponents === next.markdownComponents &&
    prev.messageFeedbackMap === next.messageFeedbackMap &&
    prev.mainBodyRef === next.mainBodyRef &&
    prev.parallelGroupsByAnchorEventId === next.parallelGroupsByAnchorEventId &&
    prev.rejectMenuOpenFor === next.rejectMenuOpenFor &&
    prev.rejectMenuRef === next.rejectMenuRef &&
    prev.showAllActionBlocks === next.showAllActionBlocks &&
    prev.stepFeedbackOpen === next.stepFeedbackOpen &&
    prev.stepFeedbackSending === next.stepFeedbackSending &&
    prev.stepFeedbackText === next.stepFeedbackText &&
    prev.suppressedParallelEventIds === next.suppressedParallelEventIds &&
    prev.task?.id === next.task?.id &&
    prev.task?.status === next.task?.status &&
    prev.task?.terminalStatus === next.task?.terminalStatus &&
    prev.task?.prompt === next.task?.prompt &&
    prev.task?.userPrompt === next.task?.userPrompt &&
    prev.task?.rawPrompt === next.task?.rawPrompt &&
    getIntegrationMentionsSignature(prev.task?.agentConfig?.integrationMentions) ===
      getIntegrationMentionsSignature(next.task?.agentConfig?.integrationMentions) &&
    prev.timelineItems === next.timelineItems &&
    prev.timelineRef === next.timelineRef &&
    prev.toggledEvents === next.toggledEvents &&
    prev.verboseSteps === next.verboseSteps &&
    prev.voiceEnabled === next.voiceEnabled &&
    prev.wrappingUp === next.wrappingUp &&
    prev.workspace?.path === next.workspace?.path &&
    prev.toolCallPairing?.completions === next.toolCallPairing?.completions &&
    prev.toolCallPairing?.claimedResultIds === next.toolCallPairing?.claimedResultIds &&
    prev.hasEventDetails === next.hasEventDetails &&
    prev.isEventExpanded === next.isEventExpanded &&
    prev.shouldDefaultExpand === next.shouldDefaultExpand &&
    prev.shouldRenderTimelineEventInStepFeed === next.shouldRenderTimelineEventInStepFeed &&
    prev.formatTime === next.formatTime &&
    prev.renderCommandOutputs === next.renderCommandOutputs &&
    prev.toggleEventExpanded === next.toggleEventExpanded &&
    prev.showFullTimeline === next.showFullTimeline &&
    prev.returnToDefaultTranscript === next.returnToDefaultTranscript &&
    prev.onOpenBrowserView === next.onOpenBrowserView &&
    prev.onOpenSpreadsheetArtifact === next.onOpenSpreadsheetArtifact &&
    prev.onOpenDocumentArtifact === next.onOpenDocumentArtifact &&
    prev.onOpenPresentationArtifact === next.onOpenPresentationArtifact &&
    prev.onOpenWebArtifact === next.onOpenWebArtifact &&
    prev.onQuoteAssistantMessage === next.onQuoteAssistantMessage &&
    prev.onForkTaskSessionFromEvent === next.onForkTaskSessionFromEvent &&
    prev.onSelectChildTask === next.onSelectChildTask &&
    prev.onOpenChildAgentSidebar === next.onOpenChildAgentSidebar &&
    prev.onViewTaskOutputs === next.onViewTaskOutputs
  );
}

const PLACEHOLDER_TYPE_DELAY_MS = 14;
const PLACEHOLDER_DELETE_DELAY_MS = 8;
const PLACEHOLDER_START_DELAY_MS = 80;
const PLACEHOLDER_HOLD_DELAY_MS = 1200;
const PLACEHOLDER_NEXT_DELAY_MS = 120;

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function useTypewriterPlaceholder(phrases: string[], active: boolean): string {
  const prefersReducedMotion = usePrefersReducedMotion();
  const normalizedPhrases = useMemo(() => phrases.filter((phrase) => phrase.trim().length > 0), [
    phrases,
  ]);
  const [displayText, setDisplayText] = useState(normalizedPhrases[0] ?? "");

  useEffect(() => {
    const firstPhrase = normalizedPhrases[0] ?? "";
    if (!active || normalizedPhrases.length === 0 || prefersReducedMotion) {
      setDisplayText(firstPhrase);
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let phraseIndex = 0;
    let characterIndex = 0;
    let phase: "typing" | "holding" | "deleting" = "typing";

    const schedule = (delay: number) => {
      timeoutId = window.setTimeout(step, delay);
    };

    const step = () => {
      if (cancelled) return;

      const phrase = normalizedPhrases[phraseIndex] ?? "";

      if (phase === "typing") {
        characterIndex += 1;
        setDisplayText(phrase.slice(0, characterIndex));

        if (characterIndex < phrase.length) {
          schedule(PLACEHOLDER_TYPE_DELAY_MS);
          return;
        }

        if (normalizedPhrases.length === 1) return;

        phase = "holding";
        schedule(PLACEHOLDER_HOLD_DELAY_MS);
        return;
      }

      if (phase === "holding") {
        phase = "deleting";
        schedule(PLACEHOLDER_DELETE_DELAY_MS);
        return;
      }

      characterIndex -= 1;
      setDisplayText(phrase.slice(0, Math.max(characterIndex, 0)));

      if (characterIndex > 0) {
        schedule(PLACEHOLDER_DELETE_DELAY_MS);
        return;
      }

      phraseIndex = (phraseIndex + 1) % normalizedPhrases.length;
      phase = "typing";
      schedule(PLACEHOLDER_NEXT_DELAY_MS);
    };

    setDisplayText("");
    schedule(PLACEHOLDER_START_DELAY_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [active, normalizedPhrases, prefersReducedMotion]);

  return displayText;
}

const TypewriterPlaceholder = memo(function TypewriterPlaceholder({
  phrases,
}: {
  phrases: string[];
}) {
  const placeholder = useTypewriterPlaceholder(phrases, true);

  return (
    <span className="cli-rotating-placeholder" aria-hidden="true">
      {placeholder}
    </span>
  );
});

function MainContentComponent({
  task,
  selectedTaskId,
  workspace,
  events: rawEvents,
  sharedTaskEventUi = null,
  childTasks = [],
  childEvents: rawChildEvents = [],
  onSelectChildTask,
  onOpenChildAgentSidebar,
  onSelectTask,
  onSendMessage,
  onOpenSideChat,
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
  inputRequest = null,
  pendingInputRequests = [],
  onSubmitInputRequest,
  onDismissInputRequest,
  onOpenBrowserView,
  onViewTaskOutputs,
  onTasksChanged,
  onOpenSpreadsheetArtifact,
  onOpenDocumentArtifact,
  onOpenPresentationArtifact,
  onOpenWebArtifact,
  onOpenBrowserWorkbenchSidebar,
  onOpenWebLinkInSidebar,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels,
  onModelChange,
  availableProviders = [],
  uiDensity = "focused",
  homeResearchVaultEnabled = false,
  homeNextActionsEnabled = false,
  rendererPerfLoggingEnabled = false,
  taskSwitchId = null,
  hasMoreTimelineHistory = false,
  isLoadingTimelineHistory = false,
  timelineHistoryError = null,
  onLoadMoreTimelineHistory,
  onLoadTaskEventDetail,
  remoteSession = null,
  replayControls,
}: MainContentProps) {
  recordRendererRender(
    "MainContent",
    task?.id ? `task:${task.id}` : selectedTaskId ?? "task:none",
    rendererPerfLoggingEnabled,
  );
  const startupMarksRef = useRef<Set<string>>(new Set());
  const markStartupOnce = useCallback(
    (name: string, details?: Record<string, unknown>) => {
      if (startupMarksRef.current.has(name)) return;
      startupMarksRef.current.add(name);
      markRendererStartup(name, rendererPerfLoggingEnabled, details);
    },
    [rendererPerfLoggingEnabled],
  );

  useEffect(() => {
    markStartupOnce("main_view_ready", {
      taskId: task?.id ?? selectedTaskId ?? "none",
      hasTask: Boolean(task),
    });
  }, [markStartupOnce, selectedTaskId, task]);

  useEffect(() => {
    markStartupOnce("composer_ready", {
      taskId: task?.id ?? selectedTaskId ?? "none",
    });
  }, [markStartupOnce, selectedTaskId, task?.id]);

  const [transcriptModeOverride, setTranscriptModeOverride] = useState<TranscriptMode | null>(null);
  useEffect(() => {
    setTranscriptModeOverride(null);
  }, [task?.id]);
  const effectiveSharedTaskEventUi =
    sharedTaskEventUi?.projectionMode === "live" && transcriptModeOverride === "inspect"
      ? null
      : sharedTaskEventUi;
  const events = useMemo(
    () => {
      if (effectiveSharedTaskEventUi) {
        return effectiveSharedTaskEventUi.normalizedEvents;
      }
      return measureRendererPerf("MainContent.normalizeEvents", rendererPerfLoggingEnabled, () =>
        normalizeEventsForTimelineUi(rawEvents),
      );
    },
    [rawEvents, rendererPerfLoggingEnabled, effectiveSharedTaskEventUi],
  );
  const childEvents = useMemo(
    () =>
      measureRendererPerf("MainContent.normalizeChildEvents", rendererPerfLoggingEnabled, () =>
        normalizeEventsForTimelineUi(rawChildEvents),
      ),
    [rawChildEvents, rendererPerfLoggingEnabled],
  );
  const researchWorkflowEnabled = Boolean(task?.agentConfig?.researchWorkflow?.enabled);
  // Agent personality context for personalized messages
  const agentContext = useAgentContext();
  const [inputValue, setInputValue] = useState("");
  const [activeWelcomeSuggestionDraft, setActiveWelcomeSuggestionDraft] =
    useState<ActiveWelcomeSuggestionDraft | null>(null);
  const [quotedAssistantMessage, setQuotedAssistantMessage] = useState<QuotedAssistantMessage | null>(
    null,
  );
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [isPreparingMessage, setIsPreparingMessage] = useState(false);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [integrationMentionOptions, setIntegrationMentionOptions] = useState<
    IntegrationMentionOption[]
  >([]);
  const [integrationMentionSpans, setIntegrationMentionSpans] = useState<
    IntegrationMentionSpan[]
  >([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTarget, setMentionTarget] = useState<{ start: number; end: number } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashTarget, setSlashTarget] = useState<{ start: number; end: number } | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [showTaskHeaderMenu, setShowTaskHeaderMenu] = useState(false);
  const [showTaskAutomationModal, setShowTaskAutomationModal] = useState(false);
  const [routineCreationNotice, setRoutineCreationNotice] = useState<{
    taskId: string;
    routineId: string;
    name: string;
    triggerSummary: string;
  } | null>(null);
  const taskHeaderMenuRef = useRef<HTMLDivElement>(null);
  const taskHeaderMenuButtonRef = useRef<HTMLButtonElement>(null);
  // Focused mode card pool - pick random cards on mount
  const focusedCards = useMemo(() => pickFocusedCards(FOCUSED_CARD_POOL, CARDS_TO_SHOW), []);

  // ── Rotating placeholder prompts (persona-aware engine) ──────────────
  const [rotatingPlaceholders, setRotatingPlaceholders] = useState<string[]>([]);
  const placeholderDebounceRef = useRef<number | null>(null);
  const placeholderPlaylistCacheRef = useRef<Map<string, string[]>>(new Map());
  const placeholderRequestIdRef = useRef(0);

  useEffect(() => {
    setQuotedAssistantMessage(null);
    setShowTaskHeaderMenu(false);
    setShowTaskAutomationModal(false);
    setRoutineCreationNotice(null);
  }, [task?.id]);

  useEffect(() => {
    if (!showTaskHeaderMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (taskHeaderMenuRef.current && !taskHeaderMenuRef.current.contains(target)) {
        setShowTaskHeaderMenu(false);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [showTaskHeaderMenu]);

  // Gather all user signals, run persona detection, and build the playlist
  useEffect(() => {
    let cancelled = false;
    const workspaceId = workspace?.id;
    const cacheKey = workspaceId ?? "global";
    const requestId = ++placeholderRequestIdRef.current;

    const cachedPlaylist = placeholderPlaylistCacheRef.current.get(cacheKey);
    if (cachedPlaylist !== undefined) {
      setRotatingPlaceholders(cachedPlaylist);
      return;
    }

    setRotatingPlaceholders([]);

    if (placeholderDebounceRef.current !== null) {
      clearTimeout(placeholderDebounceRef.current);
    }

    placeholderDebounceRef.current = window.setTimeout(() => {
      (async () => {
        const { detectPersonas, buildPlaceholders, buildDynamicPrompts } =
          await import("../../utils/placeholderEngine");
        type UserSignals = import("../../utils/placeholderEngine").UserSignals;

        const [profileFacts, recentTaskTitles, topSkills, pluginPrompts, openCommitments] =
          await Promise.all([
            // 1. User profile facts
            (async () => {
              try {
                const p = await window.electronAPI.getUserProfile();
                return (p?.facts ?? []).map((f) => ({ category: f.category, value: f.value }));
              } catch {
                return [];
              }
            })(),
            // 2. Recent completed task titles
            (async () => {
              try {
                const wsId = workspaceId;
                if (!wsId || wsId.startsWith("__temp_workspace__")) return [];
                const acts = await window.electronAPI.listActivities({
                  workspaceId: wsId,
                  activityType: "task_completed",
                  limit: 15,
                });
                return Array.isArray(acts)
                  ? acts.map((a) => (typeof a?.title === "string" ? a.title : "")).filter(Boolean)
                  : [];
              } catch {
                return [];
              }
            })(),
            // 3. Top skills from usage insights
            (async () => {
              try {
                const wsId = workspaceId;
                if (!wsId || wsId.startsWith("__temp_workspace__")) return [];
                const insights = await window.electronAPI.getUsageInsights(wsId, 30);
                return Array.isArray(insights?.topSkills)
                  ? insights.topSkills.map((s: { skill: string }) => s.skill)
                  : [];
              } catch {
                return [];
              }
            })(),
            // 4. Plugin pack "try asking" prompts
            (async () => {
              try {
                const packs = await window.electronAPI.listPluginPacks();
                if (!Array.isArray(packs)) return [];
                const out: string[] = [];
                for (const p of packs) {
                  if (p?.enabled && Array.isArray(p.tryAsking) && p.tryAsking.length > 0) {
                    for (const prompt of p.tryAsking) {
                      if (typeof prompt === "string") out.push(prompt);
                    }
                  }
                }
                return out;
              } catch {
                return [];
              }
            })(),
            // 5. Open commitments
            (async () => {
              try {
                const items = await window.electronAPI.getOpenCommitments(5);
                if (!Array.isArray(items)) return [];
                return items.map(normalizeCommitmentText).filter((c): c is string => c !== null);
              } catch {
                return [];
              }
            })(),
          ]);

        if (cancelled || requestId !== placeholderRequestIdRef.current) return;

        const signals: UserSignals = {
          profileFacts,
          recentTaskTitles,
          topSkills,
          pluginPrompts,
          openCommitments,
        };

        const personaResult = detectPersonas(signals);
        const dynamicPrompts = buildDynamicPrompts(signals);
        const playlist = buildPlaceholders(personaResult, dynamicPrompts, pluginPrompts);
        placeholderPlaylistCacheRef.current.set(cacheKey, playlist);
        setRotatingPlaceholders(playlist);
      })();
    }, 150);

    return () => {
      cancelled = true;
      if (placeholderDebounceRef.current !== null) {
        clearTimeout(placeholderDebounceRef.current);
        placeholderDebounceRef.current = null;
      }
    };
  }, [workspace?.id]);

  // Shell permission state - tracks current workspace's shell permission
  const [shellEnabled, setShellEnabled] = useState(workspace?.permissions?.shell ?? false);
  // Track dismissed command outputs by command session ID (persisted in localStorage)
  const [dismissedCommandOutputs, setDismissedCommandOutputs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("dismissedCommandOutputs");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  // Autonomous mode state
  const [autonomousModeEnabled, setAutonomousModeEnabled] = useState(false);
  const [clarifyingCheckinsEnabled, setClarifyingCheckinsEnabled] = useState(false);
  const [collaborativeModeEnabled, setCollaborativeModeEnabled] = useState(false);
  const [multiLlmModeEnabled, setMultiLlmModeEnabled] = useState(false);
  const [chronicleEnabledForTask, setChronicleEnabledForTask] = useState(true);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [defaultPermissionAccessMode, setDefaultPermissionAccessMode] =
    useState<PermissionAccessMode>("default");
  const [permissionAccessMode, setPermissionAccessMode] =
    useState<PermissionAccessMode>("default");
  const [modeSuggestions, setModeSuggestions] = useState<ModeSuggestion[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const modeSuggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [taskDomain, setTaskDomain] = useState<TaskDomain>("auto");
  const [multiLlmConfig, setMultiLlmConfig] = useState<MultiLlmConfig | null>(null);
  const [verificationAgentEnabled, setVerificationAgentEnabled] = useState(false);
  const isChatTask =
    executionMode === "chat" ||
    (isChatExecutionTask(task?.agentConfig?.executionMode) &&
      task?.agentConfig?.executionModeSource === "user");
  const setAutonomousModeSelection = useCallback((enabled: boolean) => {
    setAutonomousModeEnabled(enabled);
    if (enabled) {
      setClarifyingCheckinsEnabled(false);
      setCollaborativeModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setCollaborativeModeSelection = useCallback((enabled: boolean) => {
    setCollaborativeModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setMultiLlmModeSelection = useCallback((enabled: boolean) => {
    setMultiLlmModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setCollaborativeModeEnabled(false);
    }
    if (!enabled) {
      setMultiLlmConfig(null);
    }
  }, []);
  // Collaborative team run detection for current task
  const [collaborativeRun, setCollaborativeRun] = useState<AgentTeamRun | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Track toggled events by ID for stable state across filtering
  const [toggledEvents, setToggledEvents] = useState<Set<string>>(new Set());
  const [expandedActionBlocks, setExpandedActionBlocks] = useState<Set<string>>(new Set());
  const [appVersion, setAppVersion] = useState<string>("");
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [pluginSlashCommands, setPluginSlashCommands] = useState<PluginSlashCommandAlias[]>([]);
  const [showSkillsMenu, setShowSkillsMenu] = useState(false);
  const [skillsSearchQuery, setSkillsSearchQuery] = useState("");
  const [selectedSkillForParams, setSelectedSkillForParams] =
    useState<SelectedSkillModalState | null>(null);
  // Track wrap-up requested state for button feedback
  const [wrappingUp, setWrappingUp] = useState(false);

  // Detect if the current task is a collaborative team run
  useEffect(() => {
    if (!task?.id) {
      setCollaborativeRun(null);
      return;
    }

    const unsubRun = window.electronAPI.onTeamRunEvent((event: Any) => {
      if (event.run?.rootTaskId === task.id && event.run?.collaborativeMode) {
        setCollaborativeRun(event.run as AgentTeamRun);
      }
    });

    window.electronAPI
      .findTeamRunByRootTask(task.id)
      .then((run: AgentTeamRun | null) => {
        if (run?.collaborativeMode) setCollaborativeRun(run);
        else setCollaborativeRun(null);
      })
      .catch(() => setCollaborativeRun(null));

    return () => {
      unsubRun();
    };
  }, [task?.id]);

  // Voice input hook
  const [showVoiceNotConfigured, setShowVoiceNotConfigured] = useState(false);
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      // Append transcribed text to input
      pendingProgrammaticResizeRef.current = true;
      setInputValue((prev) => (prev ? `${prev} ${text}` : text));
    },
    onError: (error) => {
      console.error("Voice input error:", error);
    },
    onNotConfigured: () => {
      setShowVoiceNotConfigured(true);
    },
  });

  // Talk Mode hook - continuous voice conversation
  const talkMode = useVoiceTalkMode({
    onSendMessage: (text) => {
      if (shouldCreateFreshTaskForSend({
        executionMode,
        selectedTaskId,
        selectedTaskExecutionMode: task?.agentConfig?.executionMode,
      }) && onCreateTask) {
        const title = text.length > 60 ? text.slice(0, 57) + "..." : text;
        onCreateTask(
          title,
          text,
          executionMode === "chat" ? { executionMode } : undefined,
        );
      } else {
        onSendMessage(text);
      }
    },
    onError: (error) => {
      console.error("Talk mode error:", error);
      setShowVoiceNotConfigured(true);
    },
  });
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  const openSpreadsheetArtifact = useCallback(
    (path: string) => {
      if (onOpenSpreadsheetArtifact) {
        onOpenSpreadsheetArtifact(path);
        return;
      }
      setViewerFilePath(path);
    },
    [onOpenSpreadsheetArtifact],
  );
  const openDocumentArtifact = useCallback(
    (path: string) => {
      if (onOpenDocumentArtifact) {
        onOpenDocumentArtifact(path);
        return;
      }
      setViewerFilePath(path);
    },
    [onOpenDocumentArtifact],
  );
  const openPresentationArtifact = useCallback(
    (path: string) => {
      if (onOpenPresentationArtifact) {
        onOpenPresentationArtifact(path);
        return;
      }
      setViewerFilePath(path);
    },
    [onOpenPresentationArtifact],
  );
  const openWebArtifact = useCallback(
    (path: string) => {
      if (onOpenWebArtifact) {
        onOpenWebArtifact(path);
        return;
      }
      setViewerFilePath(path);
    },
    [onOpenWebArtifact],
  );
  const [llmWikiVaultSummary, setLlmWikiVaultSummary] = useState<LlmWikiVaultSummary | null>(null);
  const [llmWikiVaultLoading, setLlmWikiVaultLoading] = useState(false);
  const [welcomeTaskSuggestions, setWelcomeTaskSuggestions] = useState<WelcomeTaskSuggestion[]>([]);
  // Extract citations from task events for inline badge rendering
  const citations = useMemo(() => {
    const reversed = [...events].reverse();
    const evidenceEvent =
      reversed.find((event) => getEffectiveTaskEventType(event) === "timeline_evidence_attached") ||
      (researchWorkflowEnabled
        ? reversed.find((event) => getEffectiveTaskEventType(event) === "citations_collected")
        : undefined);
    if (!evidenceEvent) return [];
    const refs = Array.isArray(evidenceEvent.payload?.evidenceRefs)
      ? (evidenceEvent.payload.evidenceRefs as Array<Record<string, unknown>>)
      : [];
    if (refs.length > 0) {
      return refs
        .map((ref, index) => {
          const source = typeof ref?.sourceUrlOrPath === "string" ? ref.sourceUrlOrPath : "";
          if (!source) return null;
          const domain = extractDomainFromUrl(source);
          const snippet = typeof ref?.snippet === "string" ? stripHtmlTags(ref.snippet) : "";
          const sourceTool =
            typeof ref?.sourceTool === "string" && ref.sourceTool.trim().length > 0
              ? stripHtmlTags(ref.sourceTool)
              : "timeline_evidence";
          return {
            index: index + 1,
            url: source,
            snippet,
            title: domain || source,
            domain,
            accessedAt: 0,
            sourceTool,
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            index: number;
            url: string;
            title: string;
            snippet: string;
            domain: string;
            accessedAt: number;
            sourceTool: string;
          } => entry !== null,
        );
    }
    const rawCitations = Array.isArray(evidenceEvent.payload?.citations)
      ? (evidenceEvent.payload.citations as Array<Record<string, unknown>>)
      : [];
    return rawCitations
      .map((citation, index) => {
        const url = typeof citation?.url === "string" ? citation.url : "";
        if (!url) return null;
        const domain =
          typeof citation?.domain === "string" && citation.domain.trim().length > 0
            ? stripHtmlTags(citation.domain)
            : extractDomainFromUrl(url);
        const title =
          typeof citation?.title === "string" && citation.title.trim().length > 0
            ? stripHtmlTags(citation.title)
            : domain || url;
        const snippet =
          typeof citation?.snippet === "string" && citation.snippet.trim().length > 0
            ? stripHtmlTags(citation.snippet)
            : "";
        const sourceTool =
          typeof citation?.sourceTool === "string" && citation.sourceTool.trim().length > 0
            ? stripHtmlTags(citation.sourceTool)
            : typeof citation?.source === "string" && citation.source.trim().length > 0
              ? stripHtmlTags(citation.source)
              : "unknown";
        const accessedAt = typeof citation?.accessedAt === "number" ? citation.accessedAt : 0;
        return {
          index: typeof citation?.index === "number" ? citation.index : index + 1,
          url,
          domain,
          title,
          snippet,
          accessedAt,
          sourceTool,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          url: string;
          title: string;
          snippet: string;
          domain: string;
          accessedAt: number;
          sourceTool: string;
        } => entry !== null,
      );
  }, [events, researchWorkflowEnabled]);

  useEffect(() => {
    if (
      !homeResearchVaultEnabled ||
      !workspace?.path ||
      workspace.isTemp ||
      isTempWorkspaceId(workspace.id)
    ) {
      setLlmWikiVaultSummary(null);
      setLlmWikiVaultLoading(false);
      return;
    }

    let cancelled = false;
    setLlmWikiVaultLoading(true);
    window.electronAPI
      .getLlmWikiVaultSummary({
        workspacePath: workspace.path,
        vaultPath: "research/wiki",
      })
      .then((summary) => {
        if (!cancelled) {
          setLlmWikiVaultSummary(summary);
        }
      })
      .catch((error) => {
        console.error("Failed to load llm-wiki vault summary:", error);
        if (!cancelled) {
          setLlmWikiVaultSummary(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLlmWikiVaultLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [homeResearchVaultEnabled, workspace?.id, workspace?.isTemp, workspace?.path]);

  useEffect(() => {
    if (!homeNextActionsEnabled || task) {
      setWelcomeTaskSuggestions((prev) => (prev.length === 0 ? prev : []));
      setActiveWelcomeSuggestionDraft(null);
      return;
    }

    let cancelled = false;
    const validWorkspaceId =
      workspace?.id && !workspace.isTemp && !isTempWorkspaceId(workspace.id)
        ? workspace.id
        : undefined;

    const loadWelcomeTaskSuggestions = async () => {
      const workspaceIds = validWorkspaceId
        ? [validWorkspaceId]
        : (
            await window.electronAPI
              .listWorkspaces()
              .catch(() => [] as Workspace[])
          )
            .filter((item) => !item.isTemp && !isTempWorkspaceId(item.id))
            .map((item) => item.id)
            .slice(0, 8);
      const loadStoredSuggestions = async (): Promise<ProactiveSuggestion[]> => {
        if (validWorkspaceId) {
          return window.electronAPI.listSuggestions(validWorkspaceId).catch(() => []);
        }
        if (workspaceIds.length === 0) return [];
        const result = await window.electronAPI
          .listSuggestionsForWorkspaces(workspaceIds)
          .catch(() => []);
        return result.flatMap((entry) => entry.suggestions || []) as ProactiveSuggestion[];
      };

      const rawSuggestions = await loadStoredSuggestions();

      const [
        dueSoonCommitments,
        openCommitments,
        profile,
        recentMemories,
        notifications,
      ] = await Promise.all([
        window.electronAPI.getDueSoonCommitments(96).catch(() => ({ items: [] })),
        window.electronAPI.getOpenCommitments(8).catch(() => []),
        window.electronAPI.getUserProfile().catch(() => null as UserProfile | null),
        validWorkspaceId
          ? window.electronAPI
              .getRecentMemories({ workspaceId: validWorkspaceId, limit: 3 })
              .catch(() => [])
          : Promise.resolve([]),
        window.electronAPI.listNotifications().catch(() => [] as AppNotification[]),
      ]);

      const collected: WelcomeTaskSuggestion[] = [];
      pendingInputRequests
        .filter((request) => request.status === "pending")
        .slice()
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, 4)
        .forEach((request, index) => {
          const item = buildInputRequestWelcomeSuggestion(request, index);
          if (item) collected.push(item);
        });

      const proactiveSuggestions = Array.isArray(rawSuggestions)
        ? (rawSuggestions as ProactiveSuggestion[])
        : [];
      const proactiveById = new Map(
        proactiveSuggestions.map((suggestion) => [suggestion.id, suggestion] as const),
      );
      proactiveSuggestions
        .filter((suggestion) => !suggestion.dismissed && !suggestion.actedOn)
        .slice(0, 6)
        .forEach((suggestion, index) => {
          const item = buildHeartbeatWelcomeSuggestion(suggestion, index);
          if (item) collected.push(item);
        });

      const commitmentItems = Array.isArray(dueSoonCommitments?.items)
        ? dueSoonCommitments.items
        : [];
      commitmentItems.slice(0, 3).forEach((item, index) => {
        const suggestion = buildMemoryCommitmentSuggestion(item, index);
        if (suggestion) collected.push(suggestion);
      });
      const dueCommitmentIds = new Set(
        commitmentItems
          .map((item) => asRecord(item))
          .map((record) => record && getRecordString(record, ["id"]))
          .filter((value): value is string => Boolean(value)),
      );
      const openCommitmentItems = Array.isArray(openCommitments) ? openCommitments : [];
      openCommitmentItems
        .filter((item) => {
          const record = asRecord(item);
          const id = record && getRecordString(record, ["id"]);
          return !id || !dueCommitmentIds.has(id);
        })
        .slice(0, 3)
        .forEach((item, index) => {
          const suggestion = buildMemoryCommitmentSuggestion(
            item,
            index + commitmentItems.length,
          );
          if (suggestion) collected.push(suggestion);
        });

      (Array.isArray(notifications) ? notifications : [])
        .filter((notification) => notification.type === "companion_suggestion")
        .filter(
          (notification) =>
            !validWorkspaceId ||
            !notification.workspaceId ||
            notification.workspaceId === validWorkspaceId,
        )
        .sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt)
        .slice(0, 3)
        .forEach((notification) => {
          const suggestion = buildCompanionNotificationWelcomeSuggestion(
            notification,
            notification.suggestionId ? proactiveById.get(notification.suggestionId) : undefined,
          );
          if (suggestion) collected.push(suggestion);
        });

      const normalizedRecentMemories = Array.isArray(recentMemories) ? recentMemories : [];
      const profileSuggestion = buildProfileWelcomeSuggestion(profile, normalizedRecentMemories);
      if (profileSuggestion) collected.push(profileSuggestion);

      normalizedRecentMemories.slice(0, 2).forEach((item, index) => {
        const suggestion = buildRecentMemorySuggestion(item, index);
        if (suggestion) collected.push(suggestion);
      });

      if (!cancelled) {
        setWelcomeTaskSuggestions(dedupeWelcomeTaskSuggestions(collected));
      }
    };

    const timeout = window.setTimeout(() => {
      void loadWelcomeTaskSuggestions().catch((error) => {
        console.error("Failed to load welcome task suggestions:", error);
        if (!cancelled) setWelcomeTaskSuggestions([]);
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [homeNextActionsEnabled, pendingInputRequests, task, workspace?.id, workspace?.isTemp]);

  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        workspacePath: workspace?.path,
        onOpenViewer: setViewerFilePath,
        onOpenWebLinkInSidebar,
        citations,
      }),
    [workspace?.path, setViewerFilePath, onOpenWebLinkInSidebar, citations],
  );
  const eventTitleMarkdownComponents = useMemo(
    () => ({
      ...markdownComponents,
      // Keep timeline titles inline; replace emoji with Lucide icons.
      p: ({ children }: Any) => <>{replaceEmojisInChildren(children, 14)}</>,
    }),
    [markdownComponents],
  );
  // Canvas sessions state - track active canvas sessions for current task
  const [canvasSessions, setCanvasSessions] = useState<CanvasSession[]>([]);
  // Workspace dropdown state
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspacesList, setWorkspacesList] = useState<Workspace[]>([]);
  // Verbose mode - default to summary and persist per user profile.
  const [verboseSteps, setVerboseSteps] = useState(false);
  // Code previews expanded by default (true = open, false = collapsed)
  const [codePreviewsExpanded, setCodePreviewsExpanded] = useState(() => {
    const saved = localStorage.getItem(CODE_PREVIEWS_EXPANDED_KEY);
    return saved !== "false"; // default to true (expanded)
  });
  // Voice state - track if voice is enabled
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceResponseMode, setVoiceResponseMode] = useState<"auto" | "manual" | "smart">("manual");
  const lastSpokenMessageRef = useRef<string | null>(null);
  const skillsMenuRef = useRef<HTMLDivElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);
  const permissionDropdownRef = useRef<HTMLDivElement>(null);
  // Overflow menu state (welcome view only - no task)
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false);
  const [overflowSubmenu, setOverflowSubmenu] = useState<"mode" | "domain" | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowToggleBtnRef = useRef<HTMLButtonElement>(null);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const [showDomainDropdown, setShowDomainDropdown] = useState(false);
  const domainDropdownRef = useRef<HTMLDivElement>(null);
  const [guardrailDefaultMaxAutoContinuations, setGuardrailDefaultMaxAutoContinuations] =
    useState<number | null>(null);
  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    if (!verboseSteps && effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.filteredEvents;
    }
    return measureRendererPerf("MainContent.filteredEvents", rendererPerfLoggingEnabled, () => {
      const baseEvents = verboseSteps
        ? filterVerboseTimelineNoise(events)
        : filterAdjacentDuplicateTimelineFailures(
            events.filter((event) => shouldShowTaskEventInSummaryMode(event, task?.status)),
          );
      // Command output is rendered separately via CommandOutput component
      const visibleEvents = baseEvents.filter(
        (event) => event.type !== "command_output" && event.type !== "timeline_command_output",
      );
      const terminalErrorDedupWindowMs = 10_000;
      const lastErrorByFingerprint = new Map<string, number>();
      const escalationDedupWindowMs = 60_000;
      const lastEscalationByReason = new Map<string, number>();
      const dedupedEvents = visibleEvents.filter((event) => {
        const effectiveType = getEffectiveTaskEventType(event);

        if (effectiveType === "step_contract_escalated") {
          const payload =
            event.payload && typeof event.payload === "object"
              ? (event.payload as Record<string, unknown>)
              : {};
          const reason = typeof payload.reason === "string" ? payload.reason.trim() : "__unknown__";
          const previousTimestamp = lastEscalationByReason.get(reason);
          if (
            typeof previousTimestamp === "number" &&
            event.timestamp - previousTimestamp <= escalationDedupWindowMs
          ) {
            return false;
          }
          lastEscalationByReason.set(reason, event.timestamp);
          return true;
        }

        if (effectiveType !== "error") return true;
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        const fingerprint =
          (typeof payload.terminal_failure_fingerprint === "string"
            ? payload.terminal_failure_fingerprint
            : typeof payload.terminalFailureFingerprint === "string"
              ? payload.terminalFailureFingerprint
              : typeof payload.errorFingerprint === "string"
                ? payload.errorFingerprint
                : typeof payload.message === "string"
                  ? payload.message
                  : typeof payload.error === "string"
                    ? payload.error
                    : "")
            .trim();
        if (!fingerprint) return true;
        const previousTimestamp = lastErrorByFingerprint.get(fingerprint);
        if (
          typeof previousTimestamp === "number" &&
          event.timestamp - previousTimestamp <= terminalErrorDedupWindowMs
        ) {
          return false;
        }
        lastErrorByFingerprint.set(fingerprint, event.timestamp);
        return true;
      });
      return dedupedEvents.filter((event) => {
        if (verboseSteps && shouldRevealInternalAssistantMessageInVerbose(event)) {
          return true;
        }
        return !isVerificationNoiseEvent(event);
      });
    });
  }, [events, effectiveSharedTaskEventUi, verboseSteps, task?.status, rendererPerfLoggingEnabled]);

  // Build projection from raw events so tool_call/tool_result data embedded
  // in timeline_step_updated (which is filtered for display) still populates
  // lane titles with URLs/results.
  const parallelGroupProjection = useMemo(
    () => {
      if (effectiveSharedTaskEventUi) return effectiveSharedTaskEventUi.parallelGroupProjection;
      return measureRendererPerf(
        "MainContent.parallelGroupProjection",
        rendererPerfLoggingEnabled,
        () => buildParallelGroupProjection(events),
      );
    },
    [events, effectiveSharedTaskEventUi, rendererPerfLoggingEnabled],
  );
  const parallelGroupsByAnchorEventId = parallelGroupProjection.groupsByAnchorEventId;
  const suppressedParallelEventIds = parallelGroupProjection.suppressedEventIds;

  // Pair individual tool_call / tool_result events (outside parallel groups) so that
  // the tool_result row is suppressed and the tool_call row reflects the completed state.
  const toolCallPairing = useMemo(() => {
    if (!verboseSteps && effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.toolCallPairing;
    }
    // callId → tool_call event
    const callIdToEvent = new Map<string, TaskEvent>();
    // tool_call event ID → tool_result event
    const completions = new Map<string, TaskEvent>();
    // tool_result event IDs claimed by a matching tool_call
    const claimedResultIds = new Set<string>();

    for (const event of filteredEvents) {
      if (suppressedParallelEventIds.has(event.id)) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (effectiveType === "tool_call") {
        const p = event.payload as Record<string, unknown> | undefined;
        const ids = [
          typeof p?.id === "string" ? p.id : "",
          typeof p?.callId === "string" ? p.callId : "",
          typeof p?.toolUseId === "string" ? p.toolUseId : "",
        ]
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        for (const id of ids) {
          callIdToEvent.set(id, event);
        }
      } else if (effectiveType === "tool_result") {
        const p = event.payload as Record<string, unknown> | undefined;
        const ids = [
          typeof p?.callId === "string" ? p.callId : "",
          typeof p?.toolUseId === "string" ? p.toolUseId : "",
        ]
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        for (const id of ids) {
          const callEvent = callIdToEvent.get(id);
          if (callEvent) {
            completions.set(callEvent.id, event);
            claimedResultIds.add(event.id);
            break;
          }
        }
      }
    }
    return { completions, claimedResultIds };
  }, [filteredEvents, effectiveSharedTaskEventUi, suppressedParallelEventIds, verboseSteps]);

  const latestUserMessageTimestamp = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (getEffectiveTaskEventType(events[i]) === "user_message") {
        return events[i].timestamp;
      }
    }
    return null;
  }, [events]);

  const hasActiveChildren = useMemo(
    () =>
      childTasks.some((childTask) =>
        childTask.status === "executing" ||
        childTask.status === "planning" ||
        childTask.status === "interrupted",
      ),
    [childTasks],
  );

  const isTaskWorking = useMemo(
    () => isTaskActivelyWorking(task, events, hasActiveChildren),
    [task, events, hasActiveChildren],
  );

  // Reset wrappingUp state when task stops working or task changes
  useEffect(() => {
    if (!isTaskWorking) setWrappingUp(false);
  }, [isTaskWorking]);
  useEffect(() => {
    setWrappingUp(false);
  }, [task?.id]);

  // Derive current in-progress step from events (for step feedback)
  const currentStep = useMemo(() => {
    if (!task || !isTaskWorking) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.taskId !== task.id) continue;
      if (e.type === "timeline_step_started" || e.type === "timeline_step_updated") {
        const step = (e.payload?.step || {}) as Record<string, unknown>;
        const id =
          typeof e.stepId === "string" && e.stepId.length > 0
            ? e.stepId
            : typeof step?.id === "string" && step.id.length > 0
              ? step.id
              : "";
        if (!id) continue;
        const description =
          (typeof step?.description === "string" && step.description) ||
          (typeof e.payload?.message === "string" && e.payload.message) ||
          "Working";
        return { id, description };
      }
      const effectiveType = getEffectiveTaskEventType(e);
      if (
        e.type === "timeline_step_finished" ||
        effectiveType === "step_completed" ||
        effectiveType === "step_skipped"
      ) {
        break;
      }
    }
    return null;
  }, [task, events, isTaskWorking]);

  const [showAllActionBlocks, setShowAllActionBlocks] = useState<Set<string>>(new Set());

  // Step feedback UI state
  const [stepFeedbackOpen, setStepFeedbackOpen] = useState(false);
  const [stepFeedbackText, setStepFeedbackText] = useState("");
  const [stepFeedbackSending, setStepFeedbackSending] = useState(false);

  // Message-level thumbs feedback state
  const [messageFeedbackMap, setMessageFeedbackMap] = useState<
    Map<string, "accepted" | "rejected">
  >(new Map());
  const [rejectMenuOpenFor, setRejectMenuOpenFor] = useState<string | null>(null);
  const rejectMenuRef = useRef<HTMLDivElement | null>(null);

  // Close reject menu on outside click only (not when clicking a menu item)
  useEffect(() => {
    if (!rejectMenuOpenFor) return;
    const close = (e: MouseEvent) => {
      if (rejectMenuRef.current?.contains(e.target as Node)) return;
      setRejectMenuOpenFor(null);
    };
    document.addEventListener("click", close, { capture: true });
    return () => document.removeEventListener("click", close, { capture: true });
  }, [rejectMenuOpenFor]);

  const handleMessageFeedback = useCallback(
    async (payload: {
      messageId: string;
      decision: "accepted" | "rejected";
      reason?: string;
    }) => {
      setMessageFeedbackMap((prev) => new Map(prev).set(payload.messageId, payload.decision));
      setRejectMenuOpenFor(null);
      try {
        await window.electronAPI.submitMessageFeedback({
          taskId: task?.id ?? "",
          messageId: payload.messageId,
          decision: payload.decision,
          reason: payload.reason,
        });
      } catch (err) {
        console.error("[Feedback] Failed to submit message feedback:", err);
      }
    },
    [task?.id],
  );

  // Close feedback panel when step changes
  useEffect(() => {
    setStepFeedbackOpen(false);
    setStepFeedbackText("");
    setStepFeedbackSending(false);
  }, [currentStep?.id]);

  const handleStepFeedback = useCallback(
    async (action: StepFeedbackAction, message?: string) => {
      if (!task || !currentStep?.id) return;
      const stepId = currentStep.id;
      setStepFeedbackSending(true);
      try {
        await window.electronAPI.sendStepFeedback(task.id, stepId, action, message);
        setStepFeedbackOpen(false);
        setStepFeedbackText("");
      } catch {
        // Silently handle — executor may have moved on
      } finally {
        setStepFeedbackSending(false);
      }
    },
    [task, currentStep],
  );

  const isTaskFinished =
    task?.status === "completed" || task?.status === "failed" || task?.status === "cancelled";
  const isReplayMode = replayControls?.isReplayMode ?? false;
  const defaultTranscriptMode = getDefaultTranscriptMode({
    isTaskWorking,
    isReplayMode,
    verboseSteps,
    isChatTask,
    taskStatus: task?.status,
  });
  const transcriptMode = transcriptModeOverride ?? defaultTranscriptMode;
  useEffect(() => {
    if (defaultTranscriptMode === "inspect" && transcriptModeOverride !== null) {
      setTranscriptModeOverride(null);
    }
  }, [defaultTranscriptMode, transcriptModeOverride]);
  const showFullTimeline = useCallback(() => {
    setTranscriptModeOverride("inspect");
  }, []);
  const returnToDefaultTranscript = useCallback(() => {
    setTranscriptModeOverride(null);
  }, []);
  const toggleCompletedTranscriptMode = useCallback(() => {
    if (defaultTranscriptMode !== "delivery") return;
    setTranscriptModeOverride((current) => (current === "inspect" ? null : "inspect"));
  }, [defaultTranscriptMode]);
  const canToggleCompletedTranscript = defaultTranscriptMode === "delivery";
  const liveWorkStartedAt = task ? (latestUserMessageTimestamp ?? task.createdAt) : Date.now();
  const liveWorkCompletedAt = isTaskFinished
    ? (task?.completedAt ?? task?.updatedAt)
    : task?.completedAt;
  const liveWorkDuration = useTaskDuration(
    liveWorkStartedAt,
    liveWorkCompletedAt,
    Boolean(task && isTaskWorking),
  );
  const persistedWorkDuration =
    isTaskFinished &&
    typeof task?.lastRunDurationMs === "number" &&
    Number.isFinite(task.lastRunDurationMs)
      ? formatDuration(task.lastRunDurationMs)
      : null;
  const workDuration = persistedWorkDuration ?? liveWorkDuration;
  const workDurationLabel = isTaskWorking
    ? `Working for ${liveWorkDuration}`
    : isTaskFinished
      ? `Worked for ${workDuration}`
      : "Activity";

  const continuationStatusChip = useMemo(() => {
    if (!task || !isTaskWorking) return null;
    const continuationWindow =
      typeof task.continuationWindow === "number" && task.continuationWindow > 0
        ? task.continuationWindow
        : typeof task.continuationCount === "number"
          ? Math.max(1, task.continuationCount + 1)
          : 1;

    let latestDecisionEvent: TaskEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const type = getEffectiveTaskEventType(event);
      if (type === "continuation_decision" || type === "auto_continuation_started") {
        latestDecisionEvent = event;
        break;
      }
    }

    if (continuationWindow <= 1 && !latestDecisionEvent && typeof task.lastProgressScore !== "number") {
      return null;
    }

    const payload =
      latestDecisionEvent?.payload && typeof latestDecisionEvent.payload === "object"
        ? (latestDecisionEvent.payload as Record<string, unknown>)
        : {};
    const deepWorkMode = task.agentConfig?.deepWorkMode === true;
    const configuredMaxContinuations = task.agentConfig?.maxAutoContinuations;
    const eventMaxAutoContinuations =
      typeof payload.maxAutoContinuations === "number"
        ? Math.max(0, Math.floor(payload.maxAutoContinuations))
        : null;
    const maxAutoContinuations =
      typeof configuredMaxContinuations === "number"
        ? Math.max(0, Math.floor(configuredMaxContinuations))
        : typeof eventMaxAutoContinuations === "number"
          ? eventMaxAutoContinuations
          : !deepWorkMode && typeof guardrailDefaultMaxAutoContinuations === "number"
            ? Math.max(0, Math.floor(guardrailDefaultMaxAutoContinuations))
            : deepWorkMode
          ? 7
          : 3;
    const maxWindow = Math.max(1, maxAutoContinuations + 1, continuationWindow);
    const progressScoreRaw =
      typeof payload.progressScore === "number"
        ? payload.progressScore
        : typeof task.lastProgressScore === "number"
          ? task.lastProgressScore
          : null;
    const loopRiskRaw = typeof payload.loopRiskIndex === "number" ? payload.loopRiskIndex : null;

    return {
      window: `Window ${continuationWindow}/${maxWindow}`,
      progress:
        typeof progressScoreRaw === "number"
          ? `Progress ${formatSignedScore(progressScoreRaw)}`
          : undefined,
      loopRisk:
        typeof loopRiskRaw === "number" ? `Loop risk ${describeLoopRisk(loopRiskRaw)}` : undefined,
    };
  }, [events, guardrailDefaultMaxAutoContinuations, isTaskWorking, task]);

  const latestCanvasSessionId = useMemo(() => {
    if (canvasSessions.length === 0) return null;
    const eligibleSessions = latestUserMessageTimestamp
      ? canvasSessions.filter((session) => session.createdAt >= latestUserMessageTimestamp)
      : canvasSessions;
    const pool = eligibleSessions.length > 0 ? eligibleSessions : canvasSessions;
    return pool.reduce((latest, session) => {
      return session.createdAt > latest.createdAt ? session : latest;
    }, pool[0]).id;
  }, [canvasSessions, latestUserMessageTimestamp]);

  const baseTimelineItems = useMemo<BaseTimelineItem[]>(() => {
    if (!verboseSteps && effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.baseTimelineItems;
    }
    return measureRendererPerf("MainContent.baseTimelineItems", rendererPerfLoggingEnabled, () =>
      deriveSharedTaskEventUiState({
        rawEvents,
        task,
        workspace,
        verboseSteps,
      }).baseTimelineItems,
    );
  }, [
    rawEvents,
    rendererPerfLoggingEnabled,
    effectiveSharedTaskEventUi,
    task,
    verboseSteps,
    workspace,
  ]);

  const timelineItems = useMemo(() => {
    return measureRendererPerf("MainContent.timelineItems", rendererPerfLoggingEnabled, () => {
    type CanvasItem = {
      kind: "canvas";
      session: (typeof canvasSessions)[number];
      timestamp: number;
      forceSnapshot: boolean;
    };
    type DispatchedItem = { kind: "dispatched-agents"; timestamp: number };
    type CliAgentFrameItem = {
      kind: "cli-agent-frame";
      timestamp: number;
      childTask: Task;
      childTaskEvents: TaskEvent[];
    };
    type TimelineItem =
      | BaseTimelineItem
      | CanvasItem
      | DispatchedItem
      | CliAgentFrameItem;

    const eventItems = baseTimelineItems;

    const freezeBefore = latestUserMessageTimestamp;
    const canvasItems: CanvasItem[] = canvasSessions
      .map((session) => ({
        kind: "canvas" as const,
        session,
        timestamp: session.createdAt,
        forceSnapshot: Boolean(
          (freezeBefore && session.createdAt < freezeBefore) ||
          (latestCanvasSessionId && session.id !== latestCanvasSessionId),
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    // Build a sorted list of special items (canvas + dispatched agents) to merge in
    const specialItems: TimelineItem[] = [...canvasItems];

    // Insert child task panels at the chronological position of the first child task.
    // Collaborative runs use the shared team-run surface for every child task.
    // Show for both collaborative and non-collaborative runs so main area shows sub-agent steps.
    if (childTasks.length > 0) {
      const childEventsByTaskId = new Map<string, TaskEvent[]>();
      for (const event of childEvents) {
        const existing = childEventsByTaskId.get(event.taskId) || [];
        existing.push(event);
        childEventsByTaskId.set(event.taskId, existing);
      }
      if (collaborativeRun) {
        const firstChildTimestamp = Math.min(...childTasks.map((t) => t.createdAt));
        specialItems.push({ kind: "dispatched-agents" as const, timestamp: firstChildTimestamp });
      } else {
        const cliChildTasks = childTasks.filter((t) =>
          isCliAgentChildTask(t, childEventsByTaskId.get(t.id) || []),
        );
        const nonCliChildTasks = childTasks.filter(
          (t) => !isCliAgentChildTask(t, childEventsByTaskId.get(t.id) || []),
        );

        if (cliChildTasks.length > 0) {
          // Each CLI agent gets its own frame in the timeline
          for (const ct of cliChildTasks) {
            specialItems.push({
              kind: "cli-agent-frame" as const,
              timestamp: ct.createdAt,
              childTask: ct,
              childTaskEvents: childEventsByTaskId.get(ct.id) || [],
            });
          }
        }

        if (nonCliChildTasks.length > 0 || cliChildTasks.length === 0) {
          // Non-CLI child tasks (or if none are CLI) use the existing dispatched agents panel
          const tasksForPanel = nonCliChildTasks.length > 0 ? nonCliChildTasks : childTasks;
          const firstChildTimestamp = Math.min(...tasksForPanel.map((t) => t.createdAt));
          specialItems.push({ kind: "dispatched-agents" as const, timestamp: firstChildTimestamp });
        }
      }
    }

    specialItems.sort((a, b) => a.timestamp - b.timestamp);

    if (specialItems.length === 0) return eventItems;

    const merged: TimelineItem[] = [];
    let specialIndex = 0;

    for (const eventItem of eventItems) {
      while (
        specialIndex < specialItems.length &&
        specialItems[specialIndex].timestamp <= eventItem.timestamp
      ) {
        merged.push(specialItems[specialIndex]);
        specialIndex += 1;
      }
      merged.push(eventItem);
    }

    while (specialIndex < specialItems.length) {
      merged.push(specialItems[specialIndex]);
      specialIndex += 1;
    }

      return merged;
    });
  }, [
    baseTimelineItems,
    canvasSessions,
    latestCanvasSessionId,
    latestUserMessageTimestamp,
    collaborativeRun,
    childTasks,
    childEvents,
    rendererPerfLoggingEnabled,
  ]);

  const latestVisibleTaskEvent = useMemo<TaskEvent | null>(() => {
    if (!verboseSteps && effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.latestVisibleTaskEvent;
    }
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      const item = timelineItems[i];
      if (item.kind === "event") return item.event;
      if (item.kind === "action_block" && item.events.length > 0) {
        return item.events[item.events.length - 1] ?? null;
      }
    }
    return filteredEvents[filteredEvents.length - 1] ?? null;
  }, [filteredEvents, effectiveSharedTaskEventUi, timelineItems, verboseSteps]);

  // Build all command output sessions so previous command windows remain visible.
  const commandOutputSessions = useMemo<CommandOutputSession[]>(() => {
    if (effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.commandOutputSessions;
    }
    return measureRendererPerf("MainContent.commandOutputSessions", rendererPerfLoggingEnabled, () => {
      const commandOutputEvents = events.filter(
        (event) => getEffectiveTaskEventType(event) === "command_output",
      );
      if (commandOutputEvents.length === 0) return [];

      const sessions: CommandOutputSession[] = [];
      let currentSession: CommandOutputSession | null = null;
      let syntheticIdCounter = 0;

      const finalizeCurrentSession = () => {
        if (!currentSession) return;
        sessions.push(currentSession);
        currentSession = null;
      };

      for (const event of commandOutputEvents) {
        const payload =
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const payloadType = typeof payload.type === "string" ? payload.type : "";
        const payloadCommand = typeof payload.command === "string" ? payload.command : "";
        const payloadOutput = typeof payload.output === "string" ? payload.output : "";
        const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;

        if (payloadType === "start") {
          finalizeCurrentSession();
          currentSession = {
            id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
            command: payloadCommand,
            output: payloadOutput,
            isRunning: true,
            exitCode: null,
            startTimestamp: event.timestamp,
            cwd: payloadCwd,
          };
          continue;
        }

        if (!currentSession) {
          currentSession = {
            id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
            command: payloadCommand,
            output: "",
            isRunning: payloadType !== "end",
            exitCode: null,
            startTimestamp: event.timestamp,
            cwd: payloadCwd,
          };
        } else {
          if (payloadCommand) currentSession.command = payloadCommand;
          if (payloadCwd) currentSession.cwd = payloadCwd;
        }

        if (
          payloadType === "stdout" ||
          payloadType === "stderr" ||
          payloadType === "stdin" ||
          payloadType === "error"
        ) {
          currentSession.output = appendCommandOutputTail(currentSession.output, payloadOutput);
          continue;
        }

        if (payloadType === "end") {
          currentSession.isRunning = false;
          currentSession.exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
          finalizeCurrentSession();
        }
      }

      if (currentSession) {
        sessions.push(currentSession);
      }

      return limitCommandOutputSessions(sessions);
    });
  }, [events, effectiveSharedTaskEventUi, rendererPerfLoggingEnabled]);

  const visibleCommandOutputSessions = useMemo(
    () =>
      commandOutputSessions.filter(
        (session) => session.isRunning || !dismissedCommandOutputs.has(session.id),
      ),
    [commandOutputSessions, dismissedCommandOutputs],
  );

  // Group command outputs by insertion point in the timeline.
  const commandOutputSessionsByInsertIndex = useMemo(() => {
    const grouped = new Map<number, CommandOutputSession[]>();
    for (const session of visibleCommandOutputSessions) {
      let insertIndex = -1;
      for (let i = filteredEvents.length - 1; i >= 0; i--) {
        if (filteredEvents[i].timestamp <= session.startTimestamp) {
          insertIndex = i;
          break;
        }
      }
      const existing = grouped.get(insertIndex);
      if (existing) {
        existing.push(session);
      } else {
        grouped.set(insertIndex, [session]);
      }
    }
    return grouped;
  }, [filteredEvents, visibleCommandOutputSessions]);

  // Toggle verbose mode and persist to appearance settings
  const toggleVerboseSteps = () => {
    const nextVerbose = !verboseSteps;
    setVerboseSteps(nextVerbose);
    void window.electronAPI
      .saveAppearanceSettings({
        timelineVerbosity: nextVerbose ? "verbose" : "summary",
      })
      .catch((error) => {
        console.error("Failed to save timeline verbosity:", error);
      });
  };

  const toggleCodePreviews = () => {
    setCodePreviewsExpanded((prev) => {
      const newValue = !prev;
      localStorage.setItem(CODE_PREVIEWS_EXPANDED_KEY, String(newValue));
      return newValue;
    });
  };

  // Load app version
  useEffect(() => {
    window.electronAPI
      .getAppVersion()
      .then((info) => setAppVersion(info.version))
      .catch((err) => console.error("Failed to load version:", err));
  }, []);

  // Load summary/verbose timeline preference from persisted appearance settings.
  useEffect(() => {
    window.electronAPI
      .getAppearanceSettings()
      .then((settings) => {
        setVerboseSteps(settings.timelineVerbosity === "verbose");
      })
      .catch(() => {
        // Keep summary default on load failure
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    window.electronAPI
      .getGuardrailSettings()
      .then((settings) => {
        if (disposed) return;
        setGuardrailDefaultMaxAutoContinuations(settings.defaultMaxAutoContinuations);
      })
      .catch(() => {
        // Keep built-in fallback when settings are unavailable.
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Load voice settings
  useEffect(() => {
    window.electronAPI
      .getVoiceSettings()
      .then((settings) => {
        setVoiceEnabled(settings.enabled);
        setVoiceResponseMode(settings.responseMode);
      })
      .catch((err) => console.error("Failed to load voice settings:", err));

    // Subscribe to voice state changes
    const unsubscribe = window.electronAPI.onVoiceEvent((event) => {
      if (
        event.type === "voice:state-changed" &&
        typeof event.data === "object" &&
        "isActive" in event.data
      ) {
        setVoiceEnabled(event.data.isActive);
      }
    });

    return () => unsubscribe();
  }, []);

  // Auto-speak new assistant messages based on response mode
  useEffect(() => {
    if (!voiceEnabled || voiceResponseMode === "manual") return;

    const assistantMessages = events.filter(
      (e) => getEffectiveTaskEventType(e) === "assistant_message" && e.payload?.internal !== true,
    );
    if (assistantMessages.length === 0) return;

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const messageText = lastMessage.payload?.message || "";

    // Skip if already spoken
    if (lastSpokenMessageRef.current === messageText) return;

    // Check if should speak based on mode
    const hasDirective = /\[\[speak\]\]/i.test(messageText);

    if (voiceResponseMode === "auto" || (voiceResponseMode === "smart" && hasDirective)) {
      // Extract text to speak
      let textToSpeak = messageText;

      // If smart mode, only speak content within [[speak]] tags
      if (voiceResponseMode === "smart" && hasDirective) {
        const matches = messageText.match(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi);
        if (matches) {
          textToSpeak = matches
            .map((m: string) => m.replace(/\[\[speak\]\]/gi, "").replace(/\[\[\/speak\]\]/gi, ""))
            .join(" ")
            .trim();
        }
      } else {
        // Strip markdown for cleaner speech
        textToSpeak = textToSpeak
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`[^`]+`/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .trim();
      }

      if (textToSpeak) {
        lastSpokenMessageRef.current = messageText;
        window.electronAPI.voiceSpeak(textToSpeak).catch((err) => {
          console.error("Failed to auto-speak:", err);
        });
      }
    }
  }, [events, voiceEnabled, voiceResponseMode]);

  const loadMessageShortcuts = useCallback(async () => {
    const [skills, packs] = await Promise.all([
      window.electronAPI.listTaskSkills(),
      window.electronAPI.listPluginPacks().catch(() => []),
    ]);
    const enabledSkills = skills.filter((s) => s.enabled !== false);
    const enabledSkillIds = new Set(enabledSkills.map((skill) => skill.id));
    const aliases: PluginSlashCommandAlias[] = Array.isArray(packs)
      ? packs.flatMap((pack) => {
          if (!pack?.enabled || !Array.isArray(pack.slashCommands)) return [];
          const packEnabledSkills = new Set(
            (pack.skills || [])
              .filter((skill) => skill.enabled !== false)
              .map((skill) => skill.id),
          );
          return pack.slashCommands
            .filter(
              (command) =>
                enabledSkillIds.has(command.skillId) &&
                (packEnabledSkills.size === 0 || packEnabledSkills.has(command.skillId)),
            )
            .map((command) => ({
              name: command.name,
              description: command.description,
              skillId: command.skillId,
            }));
        })
      : [];
    return { enabledSkills, aliases };
  }, []);

  // Load custom skills and plugin-pack slash aliases (task skills only, excludes guidelines)
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      loadMessageShortcuts()
        .then(({ enabledSkills, aliases }) => {
          if (cancelled) return;
          setCustomSkills(enabledSkills);
          setPluginSlashCommands(aliases);
        })
        .catch((err) => {
          if (!cancelled) console.error("Failed to load custom skills:", err);
        });
    };
    refresh();
    window.addEventListener(MESSAGE_SHORTCUTS_UPDATED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(MESSAGE_SHORTCUTS_UPDATED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [loadMessageShortcuts]);

  // Load active agent roles for @mention autocomplete
  useEffect(() => {
    window.electronAPI
      .getAgentRoles()
      .then((roles) => setAgentRoles(roles.filter((role) => role.isActive)))
      .catch((err) => console.error("Failed to load agent roles:", err));
  }, []);

  const loadIntegrationMentionOptions = useCallback(async () => {
    const options = await window.electronAPI.listIntegrationMentionOptions().catch(() => []);
    const nextOptions = Array.isArray(options) ? options : [];
    startTransition(() => {
      setIntegrationMentionOptions((current) =>
        areIntegrationMentionOptionsEqual(current, nextOptions) ? current : nextOptions,
      );
    });
  }, []);

  useEffect(() => {
    void loadIntegrationMentionOptions();
    const interval = window.setInterval(() => {
      void loadIntegrationMentionOptions();
    }, 30000);
    window.addEventListener("focus", loadIntegrationMentionOptions);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", loadIntegrationMentionOptions);
    };
  }, [loadIntegrationMentionOptions]);

  // Pre-normalize agent role search strings once when roles change (avoids per-keystroke string ops)
  const normalizedRoleIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const role of agentRoles) {
      const haystack = normalizeMentionSearch(
        `${role.displayName} ${role.name} ${role.description ?? ""}`,
      );
      index.set(role.id, haystack);
    }
    return index;
  }, [agentRoles]);

  const normalizedIntegrationMentionIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const option of integrationMentionOptions) {
      index.set(
        option.id,
        normalizeMentionSearch(
          [
            option.label,
            option.description,
            option.providerKey,
            ...option.aliases,
            ...option.tools,
          ].join(" "),
        ),
      );
    }
    return index;
  }, [integrationMentionOptions]);

  useEffect(() => {
    setIntegrationMentionSpans((current) => {
      const next = current.filter(
        (span) =>
          span.end <= inputValue.length &&
          inputValue.slice(span.start, span.end) === `@${span.mention.label}`,
      );
      return next.length === current.length ? current : next;
    });
  }, [inputValue]);

  const selectedIntegrationMentions = useMemo<IntegrationMentionSelection[]>(() => {
    const byId = new Map<string, IntegrationMentionSelection>();
    for (const span of integrationMentionSpans) {
      byId.set(span.mention.id, span.mention);
    }
    return Array.from(byId.values());
  }, [integrationMentionSpans]);

  // Load canvas sessions when task changes
  useEffect(() => {
    if (!task?.id) {
      setCanvasSessions([]);
      return;
    }

    // Load existing canvas sessions for this task
    window.electronAPI
      .canvasListSessions(task.id)
      .then((sessions) => {
        // Filter to only active/paused sessions
        setCanvasSessions(sessions.filter((s) => s.status !== "closed"));
      })
      .catch((err) => console.error("Failed to load canvas sessions:", err));
  }, [task?.id]);

  // Subscribe to canvas events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onCanvasEvent((event) => {
      // Only process events for the current task
      if (task?.id && event.taskId === task.id) {
        // Don't show preview on session_created - wait until content is actually pushed
        if (event.type === "content_pushed") {
          // Content has been pushed, now show the preview if not already showing
          // Fetch the session info and add it to the list
          window.electronAPI
            .canvasGetSession(event.sessionId)
            .then((session) => {
              if (session && session.status !== "closed") {
                setCanvasSessions((prev) => {
                  // Only add if not already in the list
                  if (prev.some((s) => s.id === session.id)) {
                    return prev;
                  }
                  return [...prev, session];
                });
              }
            })
            .catch((err) => console.error("Failed to get canvas session:", err));
        } else if (event.type === "session_updated" && event.session) {
          const updatedSession = event.session;
          setCanvasSessions((prev) => {
            const exists = prev.some((s) => s.id === event.sessionId);
            if (!exists && updatedSession.status !== "closed") {
              return [...prev, updatedSession];
            }
            return prev.map((s) => (s.id === event.sessionId ? updatedSession : s));
          });
        } else if (event.type === "session_closed") {
          setCanvasSessions((prev) => prev.filter((s) => s.id !== event.sessionId));
        }
      }
    });

    return unsubscribe;
  }, [task?.id]);

  // Handle removing a canvas session from the UI
  const handleCanvasClose = useCallback((sessionId: string) => {
    setCanvasSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  // Handle dismissing a specific command output window
  const handleDismissCommandOutput = useCallback((commandOutputId: string) => {
    setDismissedCommandOutputs((prev) => {
      const updated = new Set(prev);
      updated.add(commandOutputId);
      // Persist to localStorage
      localStorage.setItem("dismissedCommandOutputs", JSON.stringify([...updated]));
      return updated;
    });
  }, []);

  const renderCommandOutputs = useCallback(
    (sessions: CommandOutputSession[] | undefined) => {
      if (!sessions || sessions.length === 0) return null;
      return sessions.map((session) => (
        <CommandOutput
          key={session.id}
          command={session.command}
          output={session.output}
          isRunning={session.isRunning}
          exitCode={session.exitCode}
          cwd={session.cwd}
          taskId={task?.id}
          onClose={() => handleDismissCommandOutput(session.id)}
        />
      ));
    },
    [handleDismissCommandOutput, task?.id],
  );

  // Filter skills based on search query
  const filteredSkills = useMemo(() => {
    if (!skillsSearchQuery.trim()) return customSkills;
    const query = skillsSearchQuery.toLowerCase();
    return customSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query) ||
        skill.category?.toLowerCase().includes(query),
    );
  }, [customSkills, skillsSearchQuery]);

  // Sync shell permission state when workspace changes
  useEffect(() => {
    setShellEnabled(workspace?.permissions?.shell ?? false);
  }, [workspace?.id, workspace?.permissions?.shell]);

  useEffect(() => {
    let cancelled = false;

    const applyPermissionDefaults = (
      permissionSettings: { defaultPermissionAccess?: "default" | "full" },
      forceSelection = false,
    ) => {
      const nextDefault: PermissionAccessMode =
        permissionSettings.defaultPermissionAccess === "full" ? "full" : "default";
      setDefaultPermissionAccessMode(nextDefault);
      setPermissionAccessMode((current) =>
        forceSelection || current === "default" ? nextDefault : current,
      );
    };

    const loadPermissionDefaults = async () => {
      try {
        const permissionSettings = await window.electronAPI.getPermissionSettings();
        if (cancelled) return;
        applyPermissionDefaults(permissionSettings);
      } catch (error) {
        console.error("Failed to load permission defaults:", error);
      }
    };

    const handlePermissionSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && typeof detail === "object") {
        applyPermissionDefaults(detail, true);
      }
    };

    void loadPermissionDefaults();
    window.addEventListener("cowork:permission-settings-updated", handlePermissionSettingsUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener(
        "cowork:permission-settings-updated",
        handlePermissionSettingsUpdated,
      );
    };
  }, []);

  // Toggle shell permission for current workspace
  const handleShellToggle = async () => {
    if (!workspace) return;
    const newValue = !shellEnabled;
    setShellEnabled(newValue);
    try {
      const updatedWorkspace = await window.electronAPI.updateWorkspacePermissions(workspace.id, {
        shell: newValue,
      });
      if (updatedWorkspace) {
        setShellEnabled(updatedWorkspace?.permissions?.shell ?? newValue);
        onSelectWorkspace?.(updatedWorkspace);
        setWorkspacesList((prev) =>
          prev.map((item) => (item.id === updatedWorkspace.id ? updatedWorkspace : item)),
        );
      }
    } catch (err) {
      console.error("Failed to update shell permission:", err);
      setShellEnabled(!newValue); // Revert on error
    }
  };

  // Close skills menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (skillsMenuRef.current && !skillsMenuRef.current.contains(e.target as Node)) {
        setShowSkillsMenu(false);
        setSkillsSearchQuery("");
      }
    };
    if (showSkillsMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSkillsMenu]);

  // Close workspace dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(e.target as Node)
      ) {
        setShowWorkspaceDropdown(false);
      }
    };
    if (showWorkspaceDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWorkspaceDropdown]);

  // Close permission dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        permissionDropdownRef.current &&
        !permissionDropdownRef.current.contains(e.target as Node)
      ) {
        setShowPermissionDropdown(false);
      }
    };
    if (showPermissionDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPermissionDropdown]);

  // Close mode dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
    };
    if (showModeDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModeDropdown]);

  // Close domain dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (domainDropdownRef.current && !domainDropdownRef.current.contains(e.target as Node)) {
        setShowDomainDropdown(false);
      }
    };
    if (showDomainDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDomainDropdown]);

  // Close overflow menu on click outside (welcome view)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    };
    if (showOverflowMenu && !task) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showOverflowMenu, task]);

  const getOverflowMenuItems = useCallback((): HTMLElement[] => {
    if (!overflowMenuRef.current) return [];
    return Array.from(
      overflowMenuRef.current.querySelectorAll<HTMLElement>(
        "[data-overflow-menu-item]:not([disabled])",
      ),
    );
  }, []);

  useEffect(() => {
    if (!showOverflowMenu || task) return;
    const items = getOverflowMenuItems();
    items[0]?.focus();
  }, [showOverflowMenu, task, getOverflowMenuItems]);

  useEffect(() => {
    if (!showOverflowMenu) {
      setOverflowSubmenu(null);
    }
  }, [showOverflowMenu]);

  const handleOverflowButtonKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setShowOverflowMenu(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setShowOverflowMenu(false);
    }
  }, []);

  const handleOverflowMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const items = getOverflowMenuItems();
      if (items.length === 0) return;
      const activeIndex = items.findIndex((item) => item === document.activeElement);

      if (e.key === "Escape") {
        e.preventDefault();
        setShowOverflowMenu(false);
        overflowToggleBtnRef.current?.focus();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
        items[nextIndex]?.focus();
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex =
          activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
        items[prevIndex]?.focus();
        return;
      }

      if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
        return;
      }

      if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    [getOverflowMenuItems],
  );

  const renderWelcomeExecutionModeRow = () => (
    <div className="overflow-menu-item" role="none">
      <button
        className={`goal-mode-toggle overflow-submenu-trigger menu-tooltip-target ${
          overflowSubmenu === "mode" ? "active" : ""
        }`}
        style={{ margin: 0 }}
        onClick={() => setOverflowSubmenu((current) => (current === "mode" ? null : "mode"))}
        data-tooltip={EXECUTION_MODE_HINT[executionMode]}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={overflowSubmenu === "mode"}
        data-overflow-menu-item
      >
        <span className="overflow-submenu-trigger-content">
          <span className="goal-mode-toggle-text">
            <span className="goal-mode-label">Mode: {EXECUTION_MODE_LABEL[executionMode]}</span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="overflow-submenu-chevron"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );

  const renderWelcomeTaskDomainRow = () => (
    <div className="overflow-menu-item" role="none">
      <button
        className={`goal-mode-toggle overflow-submenu-trigger menu-tooltip-target ${
          overflowSubmenu === "domain" ? "active" : ""
        }`}
        style={{ margin: 0 }}
        onClick={() => setOverflowSubmenu((current) => (current === "domain" ? null : "domain"))}
        data-tooltip={TASK_DOMAIN_HINT[taskDomain]}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={overflowSubmenu === "domain"}
        data-overflow-menu-item
      >
        <span className="overflow-submenu-trigger-content">
          <span className="goal-mode-toggle-text">
            <span className="goal-mode-label">Domain: {TASK_DOMAIN_LABEL[taskDomain]}</span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="overflow-submenu-chevron"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );

  const renderWelcomeOverflowSubmenu = () => {
    if (overflowSubmenu === null) return null;

    const isModeSubmenu = overflowSubmenu === "mode";
    const title = isModeSubmenu ? "Mode" : "Domain";

    return (
      <div className="overflow-submenu-panel" role="menu" aria-label={`${title} options`}>
        <div className="overflow-submenu-header">
          <span className="overflow-submenu-title">{title}</span>
        </div>
        {(isModeSubmenu ? EXECUTION_MODE_ORDER : TASK_DOMAIN_ORDER).map((value) => {
          const label = isModeSubmenu
            ? EXECUTION_MODE_LABEL[value as ExecutionMode]
            : TASK_DOMAIN_LABEL[value as TaskDomain];
          const selected = isModeSubmenu ? executionMode === value : taskDomain === value;

          return (
            <button
              key={value}
              type="button"
              className={`overflow-submenu-option ${selected ? "active" : ""}`}
              onClick={() => {
                if (isModeSubmenu) {
                  setExecutionMode(value as ExecutionMode);
                } else {
                  setTaskDomain(value as TaskDomain);
                }
                setOverflowSubmenu(null);
              }}
              role="menuitemradio"
              aria-checked={selected}
              data-overflow-menu-item
            >
              <span>{label}</span>
              {selected && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="overflow-submenu-check"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  // Handle workspace dropdown toggle - load workspaces when opening
  const handleWorkspaceDropdownToggle = async () => {
    if (!showWorkspaceDropdown) {
      try {
        const workspaces = await window.electronAPI.listWorkspaces();
        // Filter out temp workspace and sort by most recently used
        const filteredWorkspaces = workspaces
          .filter((w: Workspace) => !w.isTemp && !isTempWorkspaceId(w.id))
          .sort(
            (a: Workspace, b: Workspace) =>
              (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
          );
        setWorkspacesList(filteredWorkspaces);
      } catch (error) {
        console.error("Failed to load workspaces:", error);
      }
    }
    setShowWorkspaceDropdown(!showWorkspaceDropdown);
  };

  // Handle selecting an existing workspace from dropdown
  const handleWorkspaceSelect = (selectedWorkspace: Workspace) => {
    setShowWorkspaceDropdown(false);
    onSelectWorkspace?.(selectedWorkspace);
  };

  // Handle selecting a new folder via Finder
  const handleSelectNewFolder = () => {
    setShowWorkspaceDropdown(false);
    onChangeWorkspace?.();
  };

  const handleSkillSelect = (skill: CustomSkill) => {
    setShowSkillsMenu(false);
    setSkillsSearchQuery("");
    // If skill has parameters, show the parameter modal
    if (skill.parameters && skill.parameters.length > 0) {
      setSelectedSkillForParams({ skill, launchMode: "skill_menu" });
    } else {
      // No parameters, just set the prompt directly
      pendingProgrammaticResizeRef.current = true;
      setInputValue(skill.prompt);
    }
  };

  const handleSkillParamSubmit = (values: SkillParameterFormValues) => {
    const modalState = selectedSkillForParams;
    setSelectedSkillForParams(null);
    if (!modalState) return;
    if (onCreateTask) {
      if (modalState.launchMode === "slash") {
        const commandName = modalState.commandName || modalState.skill.id;
        const slashPrompt = buildSlashSkillPrompt(commandName, values);
        const title = buildTaskTitle(`Run /${commandName}`);
        onCreateTask(title, slashPrompt);
        return;
      }
      const expandedPrompt = expandSkillPrompt(modalState.skill, values);
      const title = buildTaskTitle(expandedPrompt);
      onCreateTask(title, expandedPrompt);
    }
  };

  const handleSkillAskInChat = (values: SkillParameterFormValues) => {
    const modalState = selectedSkillForParams;
    setSelectedSkillForParams(null);
    if (!modalState || modalState.launchMode !== "slash" || !onCreateTask) return;
    const commandName = modalState.commandName || modalState.skill.id;
    const slashPrompt = buildSlashSkillPrompt(commandName, values);
    const title = buildTaskTitle(`Run /${commandName}`);
    onCreateTask(title, slashPrompt);
  };

  const handleSkillParamCancel = () => {
    setSelectedSkillForParams(null);
  };

  // Toggle an event's expanded state using its ID
  const toggleEventExpanded = useCallback((eventId: string) => {
    setToggledEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
        const event = events.find((candidate) => candidate.id === eventId);
        const detailId = event ? getTruncatedTaskEventDetailId(event) : null;
        if (detailId && task?.id) {
          void onLoadTaskEventDetail?.(detailId, task.id);
        }
      }
      return next;
    });
  }, [events, onLoadTaskEventDetail]);

  const isImageFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "image";
  }, []);

  const isSpreadsheetFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "spreadsheet";
  }, []);

  const isVideoFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "video";
  }, []);

  const isHtmlFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "html";
  }, []);

  const isDocumentFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "document";
  }, []);

  const isPresentationFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "presentation";
  }, []);

  const shouldExposeEndOfTaskArtifactCard = useCallback((event: TaskEvent): boolean => {
    const previewKind = getInlinePreviewKindForTaskEvent(event);
    if (!previewKind || !END_OF_TASK_ARTIFACT_KINDS.has(previewKind)) return true;
    const artifactPath = getTaskEventArtifactPaths(event, events)
      .find((path) => {
        const kind = getInlinePreviewKindForGeneratedFile({ path });
        return Boolean(kind && END_OF_TASK_ARTIFACT_KINDS.has(kind));
      });
    return Boolean(
      artifactPath &&
        shouldRenderOpenArtifactCardAtEvent({
          path: artifactPath,
          event,
          eventStream: events,
        }),
    );
  }, [events]);

  const shouldRenderTimelineEventInStepFeed = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "user_message" || effectiveType === "assistant_message") {
      return false;
    }
    if (shouldHideApprovalEventInStepFeed(event)) {
      return false;
    }
    if (isRedundantTimelineEvidenceEvent(event, events)) {
      return false;
    }
    // Suppress tool_result events that are paired with their tool_call (shown inline)
    if (effectiveType === "tool_result" && toolCallPairing.claimedResultIds.has(event.id)) {
      return false;
    }
    if (!shouldShowTaskEventInStepFeed(event, { verboseSteps })) {
      return false;
    }
    return true;
  }, [
    toolCallPairing.claimedResultIds,
    events,
    verboseSteps,
  ]);

  // Check if an event has details to show
  const hasEventDetails = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (getTruncatedTaskEventDetailId(event)) return true;
    if (isImageFileEvent(event)) return true;
    if (isHtmlFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isVideoFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isDocumentFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isPresentationFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "follow_up_completed") return true;
    if (effectiveType === "task_completed") {
      return (
        hasTaskOutputs(resolveTaskOutputSummaryFromCompletionEvent(event, events)) ||
        event.payload?.terminalStatus === "needs_user_action" ||
        event.payload?.terminalStatus === "partial_success"
      );
    }
    if (shouldHideApprovalEventInStepFeed(event)) {
      return false;
    }
    if (
      !verboseSteps &&
      (event.type === "timeline_group_started" || event.type === "timeline_group_finished")
    ) {
      return false;
    }
    if (
      event.type === "timeline_group_started" ||
      event.type === "timeline_group_finished" ||
      event.type === "timeline_evidence_attached" ||
      event.type === "timeline_error"
    ) {
      return true;
    }
    if (effectiveType === "diagram_created") return true;
    if (
      (event.type === "timeline_artifact_emitted" || effectiveType === "artifact_created") &&
      typeof event.payload?.path === "string"
    ) {
      const artifactPreviewKind = getInlinePreviewKindForGeneratedFile({
        path: event.payload.path,
        mimeType: event.payload?.mimeType,
        type: event.payload?.type,
      });
      if (
        artifactPreviewKind &&
        END_OF_TASK_ARTIFACT_KINDS.has(artifactPreviewKind) &&
        !shouldRenderOpenArtifactCardAtEvent({
          path: event.payload.path,
          event,
          eventStream: events,
        })
      ) {
        return false;
      }
      return true;
    }
    if (
      effectiveType === "file_created" &&
      (event.payload?.contentPreview || event.payload?.copiedFrom)
    )
      return true;
    if (
      effectiveType === "file_modified" &&
      (event.payload?.oldPreview || event.payload?.action === "rename")
    )
      return true;
    if (effectiveType === "tool_result") {
      const result = event.payload?.result;
      const failed =
        result &&
        typeof result === "object" &&
        ((result as Any).success === false || Boolean((result as Any).error));
      return verboseSteps || Boolean(failed);
    }
    return [
      "plan_created",
      "tool_call",
      "assistant_message",
      "error",
      "step_failed",
      "approval_requested",
    ].includes(effectiveType);
  }, [
    events,
    isHtmlFileEvent,
    isImageFileEvent,
    isDocumentFileEvent,
    isPresentationFileEvent,
    isSpreadsheetFileEvent,
    isVideoFileEvent,
    shouldExposeEndOfTaskArtifactCard,
    verboseSteps,
    workspace?.path,
  ]);

  // Determine if an event should be expanded by default
  // Important events (plan, assistant responses, errors) should be expanded
  // Verbose events (tool calls/results) should be collapsed
  const shouldDefaultExpand = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (isImageFileEvent(event)) return true;
    if (isHtmlFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isVideoFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isDocumentFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (isPresentationFileEvent(event)) return shouldExposeEndOfTaskArtifactCard(event);
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "follow_up_completed") return true;
    if (effectiveType === "task_completed") return hasEventDetails(event);
    if (shouldHideApprovalEventInStepFeed(event)) return false;
    if (effectiveType === "artifact_created") {
      const artifactPath = typeof event.payload?.path === "string" ? event.payload.path : "";
      const artifactPreviewKind = getInlinePreviewKindForGeneratedFile({
        path: artifactPath,
        mimeType: event.payload?.mimeType,
        type: event.payload?.type,
      });
      if (
        artifactPreviewKind &&
        END_OF_TASK_ARTIFACT_KINDS.has(artifactPreviewKind) &&
        !shouldRenderOpenArtifactCardAtEvent({
          path: artifactPath,
          event,
          eventStream: events,
        })
      ) {
        return false;
      }
      return true;
    }
    if (
      effectiveType === "diagram_created" ||
      event.type === "timeline_evidence_attached" ||
      event.type === "timeline_error"
    )
      return true;
    if (effectiveType === "approval_requested") {
      return isRunCommandApproval(getApprovalPayload(event));
    }
    // Code previews: expand by default unless user opted for collapsed
    if (codePreviewsExpanded) {
      if (
        effectiveType === "file_created" &&
        (event.payload?.contentPreview || event.payload?.copiedFrom)
      )
        return true;
      if (
        effectiveType === "file_modified" &&
        (event.payload?.oldPreview || event.payload?.action === "rename")
      )
        return true;
    }
    return ["plan_created", "assistant_message", "error", "step_failed"].includes(effectiveType);
  }, [
    codePreviewsExpanded,
    hasEventDetails,
    isHtmlFileEvent,
    isImageFileEvent,
    isDocumentFileEvent,
    isPresentationFileEvent,
    isSpreadsheetFileEvent,
    isVideoFileEvent,
    shouldExposeEndOfTaskArtifactCard,
    workspace?.path,
  ]);

  // Check if an event is currently expanded using its ID
  // If the event should default expand, clicking toggles it to collapsed (and vice versa)
  const isEventExpanded = useCallback((event: TaskEvent): boolean => {
    return resolveDisclosureExpanded({
      defaultExpanded: shouldDefaultExpand(event),
      toggled: toggledEvents.has(event.id),
    });
  }, [shouldDefaultExpand, toggledEvents]);

  const timelineRef = useRef<HTMLDivElement>(null);
  const mainBodyRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const lastAutoScrollTargetRef = useRef<number | null>(null);
  const activeScrollbarTimeoutRef = useRef<number | null>(null);
  const promptInputRef = useRef<PromptComposerInputHandle>(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const cliInputWrapperRef = useRef<HTMLDivElement>(null);
  const [cursorLeft, setCursorLeft] = useState<number>(0);
  const [isCliInputFocused, setIsCliInputFocused] = useState(false);

  // Auto-resize textarea; prefer direct event-path resizing to avoid an extra
  // effect/layout cycle on every keypress in long sessions.
  const resizeRafRef = useRef<number>(0);
  const pendingProgrammaticResizeRef = useRef(false);
  const autoResizeTextarea = useCallback((_input?: unknown, shrink = false) => {
    if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      promptInputRef.current?.resize(shrink);
    });
  }, []);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
      if (activeScrollbarTimeoutRef.current) window.clearTimeout(activeScrollbarTimeoutRef.current);
    };
  }, []);

  const handleQuoteAssistantMessage = useCallback((quote: QuotedAssistantMessage) => {
    setQuotedAssistantMessage(quote);
    const input = promptInputRef.current;
    input?.focus();
    const cursorPosition = inputValue.length;
    input?.setSelectionRange(cursorPosition, cursorPosition);
  }, [inputValue.length]);

  // Programmatic input updates still need a resize pass.
  useEffect(() => {
    if (!pendingProgrammaticResizeRef.current) return;
    pendingProgrammaticResizeRef.current = false;
    autoResizeTextarea(undefined, true);
  }, [inputValue, autoResizeTextarea]);

  // Active placeholder: rotating prompt when available, personality fallback otherwise
  const personalityPlaceholder = agentContext.getPlaceholder();
  const showCliPlaceholder = !inputValue && !isCliInputFocused;
  const showCliEmptyCursor = !inputValue && isCliInputFocused;
  const placeholderPlaylist = useMemo(
    () => (rotatingPlaceholders.length > 0 ? rotatingPlaceholders : [personalityPlaceholder]),
    [personalityPlaceholder, rotatingPlaceholders],
  );

  // Keep the empty focused cursor attached to the editable area instead of
  // relying on theme-specific padding and prompt-width constants.
  useLayoutEffect(() => {
    if (!showCliEmptyCursor) return;

    const updateEmptyCursor = () => {
      const inputAreaEl = mentionContainerRef.current;
      const wrapperEl = cliInputWrapperRef.current;
      if (!inputAreaEl || !wrapperEl) return;

      const inputAreaRect = inputAreaEl.getBoundingClientRect();
      const wrapperRect = wrapperEl.getBoundingClientRect();
      setCursorLeft(inputAreaRect.left - wrapperRect.left);
    };

    updateEmptyCursor();
    window.addEventListener("resize", updateEmptyCursor);
    return () => window.removeEventListener("resize", updateEmptyCursor);
  }, [showCliEmptyCursor]);

  // Check if user is near the bottom of the scroll container
  const isNearBottom = useCallback((element: HTMLElement, threshold = 100) => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Handle scroll events to detect manual scrolling
  const handleScroll = useCallback(() => {
    const container = mainBodyRef.current;
    if (!container) return;

    container.classList.add("is-scrolling");
    if (activeScrollbarTimeoutRef.current) {
      window.clearTimeout(activeScrollbarTimeoutRef.current);
    }
    activeScrollbarTimeoutRef.current = window.setTimeout(() => {
      container.classList.remove("is-scrolling");
      activeScrollbarTimeoutRef.current = null;
    }, 800);

    // If user scrolls to near bottom, re-enable auto-scroll
    // If user scrolls away from bottom, disable auto-scroll
    const nextAutoScroll = isNearBottom(container);
    setAutoScroll((prev) => (prev === nextAutoScroll ? prev : nextAutoScroll));
  }, [isNearBottom]);

  // Auto-scroll to bottom when visible transcript rows materially change.
  useEffect(() => {
    if (!autoScroll || !mainBodyRef.current) return;
    const container = mainBodyRef.current;
    if (
      !shouldScheduleAutoScrollWrite({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        lastTargetTop: lastAutoScrollTargetRef.current,
      })
    ) {
      incrementRendererPerfCounter("task-scroll.follow_skipped_count", rendererPerfLoggingEnabled);
      return;
    }
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
    }
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const nextTargetTop = getAutoScrollTargetTop(container.scrollHeight, container.clientHeight);
      const stillAtTarget = Math.abs(container.scrollTop - nextTargetTop) < 2;
      lastAutoScrollTargetRef.current = nextTargetTop;
      if (!stillAtTarget) {
        container.scrollTop = nextTargetTop;
        incrementRendererPerfCounter("task-scroll.follow_write_count", rendererPerfLoggingEnabled);
      } else {
        incrementRendererPerfCounter("task-scroll.follow_skipped_count", rendererPerfLoggingEnabled);
      }
    });
    return () => {
      if (autoScrollFrameRef.current) {
        cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    };
  }, [
    autoScroll,
    childEvents.length,
    childTasks.length,
    commandOutputSessions.length,
    latestVisibleTaskEvent?.id,
    rendererPerfLoggingEnabled,
  ]);

  // Reset auto-scroll when task changes
  useEffect(() => {
    setAutoScroll(true);
    lastAutoScrollTargetRef.current = null;
  }, [task?.id]);

  const reportAttachmentError = (message: string) => {
    setAttachmentError(message);
    window.setTimeout(() => setAttachmentError(null), 5000);
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const [, base64] = result.split(",");
        if (!base64) {
          reject(new Error("Failed to read file data."));
          return;
        }
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to read file data."));
      reader.readAsDataURL(file);
    });

  const appendPendingAttachments = (files: PendingAttachment[]) => {
    if (files.length === 0) return;
    setPendingAttachments((prev) => {
      const existingKeys = new Set(
        prev.map((attachment) => attachment.path || `${attachment.name}-${attachment.size}`),
      );
      const next = [...prev];
      for (const file of files) {
        const key = file.path || `${file.name}-${file.size}`;
        if (existingKeys.has(key)) continue;
        if (next.length >= MAX_ATTACHMENTS) {
          reportAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
          break;
        }
        next.push({
          ...file,
          id: file.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        existingKeys.add(key);
      }
      return next;
    });
  };

  const handleAttachFiles = async () => {
    try {
      const pickerDefaultPath =
        workspace && !workspace.isTemp && !isTempWorkspaceId(workspace.id)
          ? workspace.path
          : undefined;
      const files = await window.electronAPI.selectFiles(pickerDefaultPath);
      if (!files || files.length === 0) return;
      appendPendingAttachments(
        files.map((file) => ({
          ...file,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })),
      );
    } catch (error) {
      console.error("Failed to select files:", error);
      reportAttachmentError("Failed to add attachments. Please try again.");
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types || []).includes("Files");

  const handleDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(false);

    const droppedFiles = Array.from(event.dataTransfer.files || []);
    try {
      const pending = await Promise.all(
        droppedFiles.map(async (file) => {
          const filePath = (file as File & { path?: string }).path;
          if (filePath) {
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              path: filePath,
              name: file.name,
              size: file.size,
              mimeType: file.type || undefined,
            } satisfies PendingAttachment;
          }
          const dataBase64 = await readFileAsBase64(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || `drop-${Date.now()}`,
            size: file.size,
            mimeType: file.type || undefined,
            dataBase64,
          } satisfies PendingAttachment;
        }),
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error("Failed to handle dropped files:", error);
      reportAttachmentError("Failed to attach dropped files.");
    }
  };

  const handlePaste = async (event: React.ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    let clipboardFiles = Array.from(clipboardData?.files || []);
    if (clipboardFiles.length === 0 && clipboardData?.items) {
      Array.from(clipboardData.items).forEach((item: DataTransferItem) => {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) clipboardFiles.push(file);
        }
      });
    }
    if (clipboardFiles.length === 0) return;
    event.preventDefault();

    try {
      const pending = await Promise.all(
        clipboardFiles.map(async (file) => {
          const dataBase64 = await readFileAsBase64(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || `paste-${Date.now()}`,
            size: file.size,
            mimeType: file.type || undefined,
            dataBase64,
          } satisfies PendingAttachment;
        }),
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error("Failed to handle pasted files:", error);
      reportAttachmentError("Failed to attach pasted files.");
    }
  };

  const renderAttachmentPanel = () => {
    if (pendingAttachments.length === 0 && !attachmentError) return null;
    return (
      <div className="attachment-panel">
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        {pendingAttachments.length > 0 && (
          <div className="attachment-list">
            {pendingAttachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id}>
                <span className="attachment-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                </span>
                <span className="attachment-name" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="attachment-size">{formatFileSize(attachment.size)}</span>
                <button
                  className="attachment-remove"
                  onClick={() => handleRemoveAttachment(attachment.id)}
                  title="Remove attachment"
                  disabled={isUploadingAttachments}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const importAttachmentsToWorkspace = async (): Promise<ImportedAttachment[]> => {
    if (pendingAttachments.length === 0) return [];
    if (!workspace) {
      throw new Error("Select a workspace before attaching files.");
    }
    const pathAttachments = pendingAttachments.filter(
      (attachment) => attachment.path && !attachment.dataBase64,
    );
    const dataAttachments = pendingAttachments.filter((attachment) => attachment.dataBase64);

    const results: ImportedAttachment[] = [];

    if (pathAttachments.length > 0) {
      const imported = await window.electronAPI.importFilesToWorkspace({
        workspaceId: workspace.id,
        files: pathAttachments.map((attachment) => attachment.path as string),
      });
      results.push(...imported);
    }

    if (dataAttachments.length > 0) {
      const imported = await window.electronAPI.importDataToWorkspace({
        workspaceId: workspace.id,
        files: dataAttachments.map((attachment) => ({
          name: attachment.name,
          data: attachment.dataBase64 as string,
          mimeType: attachment.mimeType,
        })),
      });
      results.push(...imported);
    }

    return results;
  };

  const handleSend = async () => {
    if (isUploadingAttachments || isPreparingMessage) {
      return;
    }

    const trimmedInput = inputValue.trim();
    const hasAttachments = pendingAttachments.length > 0;
    const onboardingSlashCommand = parseOnboardingSlashCommand(trimmedInput);
    const appSlashCommand = parseLeadingMessageAppShortcut(trimmedInput);
    const goalSlashCommand = parseLeadingGoalSlashCommand(trimmedInput);

    if (!trimmedInput && !hasAttachments) return;
    if (
      appSlashCommand.matched &&
      appSlashCommand.shortcut?.action === "clear" &&
      !hasAttachments
    ) {
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setPendingAttachments([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      if (onStartFreshSession) {
        onStartFreshSession();
      } else {
        onSelectTask?.(null);
      }
      return;
    }
    if (onboardingSlashCommand.matched && !hasAttachments && onStartOnboarding) {
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setPendingAttachments([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      onStartOnboarding();
      return;
    }

    const inboxAskQuery = extractInboxAskQuery(inputValue, integrationMentionSpans);
    if (inboxAskQuery !== null && onAskInbox) {
      if (hasAttachments) {
        setAttachmentError("Inbox Agent Ask Inbox only accepts a text question.");
        return;
      }
      if (!inboxAskQuery) {
        setAttachmentError("Add a question after @Inbox.");
        return;
      }
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setPendingAttachments([]);
      setIntegrationMentionSpans([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      setActiveWelcomeSuggestionDraft(null);
      setQuotedAssistantMessage(null);
      setAttachmentError(null);
      onAskInbox(inboxAskQuery);
      return;
    }

    if (appSlashCommand.matched && appSlashCommand.shortcut?.action === "side") {
      if (!task?.id || !onOpenSideChat) {
        setAttachmentError("/side needs an active task to reference.");
        return;
      }
      if (hasAttachments) {
        setAttachmentError("/side currently accepts text questions only.");
        return;
      }
      const sideQuestion = String(appSlashCommand.args || "").trim();
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setPendingAttachments([]);
      setIntegrationMentionSpans([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      setActiveWelcomeSuggestionDraft(null);
      setQuotedAssistantMessage(null);
      setAttachmentError(null);
      void onOpenSideChat({
        taskId: task.id,
        ...(sideQuestion ? { initialMessage: sideQuestion } : {}),
      });
      return;
    }

    if (
      !hasAttachments &&
      taskCanBecomeRoutineFromFollowUp(task) &&
      isTurnThisIntoRoutinePrompt(trimmedInput)
    ) {
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setPendingAttachments([]);
      setIntegrationMentionSpans([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      setActiveWelcomeSuggestionDraft(null);
      setQuotedAssistantMessage(null);
      setAttachmentError(null);
      setShowTaskAutomationModal(true);
      return;
    }

    let importedAttachments: ImportedAttachment[] = [];
    setIsPreparingMessage(true);
    setAttachmentError(null);
    let sendFailed = false;
    if (hasAttachments) {
      setIsUploadingAttachments(true);
    }

    try {
      if (hasAttachments) {
        importedAttachments = await importAttachmentsToWorkspace();
      }

      // Build native ImageAttachment[] from image-type attachments so the LLM
      // can see the actual pixels (vision) instead of relying on OCR text only.
      const IMAGE_MIME_SET = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
      const nativeImageAttachments: ImageAttachment[] = [];
      for (let i = 0; i < pendingAttachments.length; i++) {
        const pa = pendingAttachments[i];
        if (!pa.mimeType || !IMAGE_MIME_SET.has(pa.mimeType)) continue;
        if (pa.dataBase64) {
          nativeImageAttachments.push({
            data: pa.dataBase64,
            mimeType: pa.mimeType as ImageAttachment["mimeType"],
            filename: pa.name,
            sizeBytes: pa.size,
          });
        } else if (pa.path) {
          nativeImageAttachments.push({
            filePath: pa.path,
            mimeType: pa.mimeType as ImageAttachment["mimeType"],
            filename: pa.name,
            sizeBytes: pa.size,
          });
        }
      }
      const imagePayload = nativeImageAttachments.length > 0 ? nativeImageAttachments : undefined;

      // Compose text message (with OCR fallback for non-image files)
      const appSlashMessageText =
        appSlashCommand.matched &&
        appSlashCommand.shortcut?.action !== "insert" &&
        appSlashCommand.shortcut?.action !== "clear"
          ? appSlashCommand.args || ""
          : trimmedInput;
      const composeResult = await composeMessageWithAttachments(
        workspace?.path,
        appSlashMessageText,
        importedAttachments,
      );
      const hasExtractionWarnings = composeResult.extractionWarnings.length > 0;
      if (hasExtractionWarnings) {
        const warningList = composeResult.extractionWarnings.join(", ");
        setAttachmentError(
          `I had trouble reading ${warningList}. They were attached, but I may not have had full content.`,
        );
      }
      const message = composeResult.message;
      const createIntegrationMentionOptions =
        selectedIntegrationMentions.length > 0
          ? { integrationMentions: selectedIntegrationMentions }
          : {};

      if (goalSlashCommand.matched && goalSlashCommand.action === "start" && onCreateTask) {
        const objective = String(goalSlashCommand.objective || "").trim();
        if (!objective) {
          setAttachmentError("Add the goal after /goal.");
          sendFailed = true;
          return;
        }
        const goalBaseAgentConfig: AgentConfig =
          selectedIntegrationMentions.length > 0
            ? { integrationMentions: selectedIntegrationMentions }
            : {};
        const goalAgentConfig = buildPersistentGoalAgentConfig(
          goalSlashCommand,
          Date.now(),
          goalBaseAgentConfig,
        );
        const prompt = buildPersistentGoalPrompt(objective, hasAttachments ? message : undefined);
        const title = buildTaskTitle(`/goal ${objective}`);
        onCreateTask(
          title,
          prompt,
          {
            executionMode: "execute",
            taskDomain,
            agentConfig: goalAgentConfig,
            ...createIntegrationMentionOptions,
          },
          imagePayload,
        );

        pendingProgrammaticResizeRef.current = true;
        setInputValue("");
        setActiveWelcomeSuggestionDraft(null);
        setQuotedAssistantMessage(null);
        setPendingAttachments([]);
        setMentionOpen(false);
        setMentionQuery("");
        setMentionTarget(null);
        setSlashOpen(false);
        setSlashQuery("");
        setSlashTarget(null);
        setModeSuggestions([]);
        setAutonomousModeEnabled(false);
        setClarifyingCheckinsEnabled(false);
        setCollaborativeModeEnabled(false);
        setMultiLlmModeEnabled(false);
        setChronicleEnabledForTask(true);
        setPermissionAccessMode(defaultPermissionAccessMode);
        setMultiLlmConfig(null);
        setVerificationAgentEnabled(false);
        return;
      }

      if (
        appSlashCommand.matched &&
        appSlashCommand.shortcut &&
        appSlashCommand.shortcut.action !== "insert" &&
        appSlashCommand.shortcut.action !== "clear"
      ) {
        if (!onCreateTask) return;
        const shortcut = appSlashCommand.shortcut;
        const promptText = message.trim();
        const hasTaskText = Boolean(appSlashCommand.args?.trim() || hasAttachments);
        if ((shortcut.action === "plan" || shortcut.action === "cost") && !hasTaskText) {
          setAttachmentError(`Add the task after /${shortcut.name}.`);
          sendFailed = true;
          return;
        }
        if (shortcut.action === "review" && (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id))) {
          setAttachmentError("/review requires a regular workspace folder.");
          sendFailed = true;
          return;
        }

        const prompt =
          shortcut.action === "plan"
            ? promptText
            : shortcut.action === "cost"
              ? `Estimate the likely token usage, model cost, runtime, and risk for this task without executing it:\n\n${promptText}`
              : shortcut.action === "review"
                ? `Review the current workspace using the background-agent review workflow. Focus on bugs, regressions, security issues, missing tests, and concrete follow-up actions. Do not modify files unless I explicitly ask.\n\nReview scope:\n${promptText || "Review the current uncommitted changes and any open pull request context you can derive from this workspace."}`
              : shortcut.name === "doctor"
                ? `Run a CoWork OS diagnostic for this workspace. Check available app state, integrations, permissions, skills, commands, and obvious setup issues. Do not make changes unless I explicitly ask.\n\nAdditional context:\n${promptText || "No additional context."}`
                : shortcut.name === "undo"
                  ? `Review the latest task or workspace changes and prepare a safe undo plan. Do not modify files, delete data, or run rollback commands unless I explicitly approve.\n\nContext:\n${promptText || "Use the current workspace and recent task context."}`
                  : `Create a compact continuation brief for this context. Preserve goals, decisions, open questions, constraints, and next actions without executing new work.\n\nContext:\n${promptText || "Use the current conversation and workspace context."}`;

        const title = buildTaskTitle(`/${shortcut.name} ${appSlashCommand.args || ""}`.trim());
        const options: CreateTaskOptions =
          shortcut.action === "plan"
            ? { executionMode: "plan", taskDomain, ...createIntegrationMentionOptions }
            : shortcut.action === "review"
              ? {
                  executionMode: "analyze",
                  taskDomain: "auto",
                  collaborativeMode: true,
                  multitaskMode: true,
                  multitaskLaneCount: 4,
                  multitaskAssignmentMode: "auto_split",
                  ...createIntegrationMentionOptions,
                }
            : shortcut.action === "cost" || shortcut.action === "diagnostic"
              ? { executionMode: "analyze", taskDomain, ...createIntegrationMentionOptions }
              : { executionMode: "plan", taskDomain, ...createIntegrationMentionOptions };
        onCreateTask(title, prompt, options, imagePayload);

        pendingProgrammaticResizeRef.current = true;
        setInputValue("");
        setActiveWelcomeSuggestionDraft(null);
        setQuotedAssistantMessage(null);
        setPendingAttachments([]);
        setMentionOpen(false);
        setMentionQuery("");
        setMentionTarget(null);
        setSlashOpen(false);
        setSlashQuery("");
        setSlashTarget(null);
        setModeSuggestions([]);
        return;
      }

      // Chat mode reuses the current chat task when one exists, but creates a new
      // task for the first message or when the selected task is not a chat session.
      const shouldCreateFreshTask =
        shouldCreateFreshTaskForSend({
          executionMode,
          selectedTaskId,
          selectedTaskExecutionMode: task?.agentConfig?.executionMode,
          forceFreshTask:
            appSlashCommand.shortcut?.name === "schedule" ||
            goalSlashCommand.action === "start",
        });

      if (shouldCreateFreshTask && onCreateTask) {
        // Fresh task - create new task with optional autonomy enabled.
        const titleSource =
          trimmedInput ||
          (pendingAttachments[0]?.name ? `Review ${pendingAttachments[0].name}` : "New task");
        const title = buildTaskTitle(titleSource);
        const modeOptions: CreateTaskOptions = {
          executionMode,
          taskDomain,
          chronicleMode: chronicleEnabledForTask ? "inherit" : "disabled",
          videoGenerationMode: taskDomain === "media" ? true : undefined,
          ...(clarifyingCheckinsEnabled
            ? { agentConfig: { humanInputPolicy: "legacy_interactive" as const } }
            : {}),
          ...createIntegrationMentionOptions,
          ...(permissionAccessMode === "full"
            ? { permissionMode: "bypass_permissions", shellAccess: true }
            : {}),
        };
        const baseOptions: CreateTaskOptions =
          multiLlmModeEnabled && multiLlmConfig
            ? { ...modeOptions, multiLlmMode: true, multiLlmConfig }
            : collaborativeModeEnabled
              ? { ...modeOptions, collaborativeMode: true }
              : autonomousModeEnabled
                ? { ...modeOptions, autonomousMode: true }
                : modeOptions;
        const options: CreateTaskOptions = verificationAgentEnabled
          ? { ...baseOptions, verificationAgent: true }
          : baseOptions;
        onCreateTask(title, message, options, imagePayload);
        // Reset task mode state
        setAutonomousModeEnabled(false);
        setCollaborativeModeEnabled(false);
        setMultiLlmModeEnabled(false);
        setChronicleEnabledForTask(true);
        setPermissionAccessMode(defaultPermissionAccessMode);
        setMultiLlmConfig(null);
        setVerificationAgentEnabled(false);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        onSendMessage(
          message,
          imagePayload,
          quotedAssistantMessage ?? undefined,
          {
            integrationMentions: selectedIntegrationMentions,
            ...(permissionAccessMode === "full"
              ? { permissionMode: "bypass_permissions", shellAccess: true }
              : {}),
          },
        );
      }

      const submittedWelcomeSuggestionDraft = activeWelcomeSuggestionDraft;
      if (submittedWelcomeSuggestionDraft && trimmedInput) {
        const feedback = async () => {
          if (
            normalizeSuggestionText(trimmedInput) !==
            normalizeSuggestionText(submittedWelcomeSuggestionDraft.originalPrompt)
          ) {
            await window.electronAPI
              .editSuggestion(
                submittedWelcomeSuggestionDraft.workspaceId,
                submittedWelcomeSuggestionDraft.suggestionId,
                trimmedInput,
              )
              .catch(() => {
                // Best effort; still record that the suggestion led to a sent task.
              });
          }
          await window.electronAPI.actOnSuggestion(
            submittedWelcomeSuggestionDraft.workspaceId,
            submittedWelcomeSuggestionDraft.suggestionId,
          );
        };
        void feedback().catch(() => {
          // Best effort; the task was already sent.
        });
      }

      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setActiveWelcomeSuggestionDraft(null);
      setQuotedAssistantMessage(null);
      setPendingAttachments([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setModeSuggestions([]);
    } catch (error) {
      console.error("Failed to send message:", error);
      sendFailed = true;
      const baseError = error instanceof Error ? error.message : "Failed to send message.";
      reportAttachmentError(baseError);
    } finally {
      setIsUploadingAttachments(false);
      setIsPreparingMessage(false);
      if (!sendFailed) {
        setAttachmentError(null);
      }
    }
  };

  const findMentionAtCursor = (value: string, cursor: number | null) => {
    if (cursor === null) return null;
    const uptoCursor = value.slice(0, cursor);
    const atIndex = uptoCursor.lastIndexOf("@");
    if (atIndex === -1) return null;
    if (atIndex > 0 && /[a-zA-Z0-9]/.test(uptoCursor[atIndex - 1])) {
      return null;
    }
    const query = uptoCursor.slice(atIndex + 1);
    if (query.startsWith(" ")) return null;
    if (query.includes("\n") || query.includes("\r")) return null;
    return { query, start: atIndex, end: cursor };
  };

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionOpen) return [];
    const query = normalizeMentionSearch(mentionQuery);
    const options: MentionOption[] = [];
    const includeEveryone =
      query.length > 0 && ["everybody", "everyone", "all"].some((alias) => alias.startsWith(query));
    if (includeEveryone) {
      options.push({
        type: "everyone",
        id: "everyone",
        label: "Everybody",
        description: "Auto-pick the best agents for this task",
        icon: "👥",
        color: "#64748b",
      });
    }

    const filteredAgents = agentRoles
      .filter((role) => {
        if (!query) return true;
        // Use pre-normalized index for O(1) lookup instead of per-keystroke normalization
        const haystack = normalizedRoleIndex.get(role.id) ?? "";
        return haystack.includes(query);
      })
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        }
        return a.displayName.localeCompare(b.displayName);
      });

    filteredAgents.forEach((role) => {
      options.push({
        type: "agent",
        id: role.id,
        label: role.displayName,
        description: role.description,
        icon: role.icon,
        color: role.color,
      });
    });

    integrationMentionOptions
      .filter((option) => {
        if (!query) return true;
        return (normalizedIntegrationMentionIndex.get(option.id) ?? "").includes(query);
      })
      .sort((a, b) => {
        const rankDelta =
          getIntegrationMentionSearchRank(a, query) - getIntegrationMentionSearchRank(b, query);
        return rankDelta || a.label.localeCompare(b.label);
      })
      .forEach((integration) => {
        options.push({
          type: "integration",
          id: integration.id,
          label: integration.label,
          description: integration.description,
          integration,
        });
      });

    return options;
  }, [
    mentionOpen,
    mentionQuery,
    agentRoles,
    normalizedRoleIndex,
    integrationMentionOptions,
    normalizedIntegrationMentionIndex,
  ]);

  useEffect(() => {
    if (mentionSelectedIndex >= mentionOptions.length) {
      setMentionSelectedIndex(0);
    }
  }, [mentionOptions, mentionSelectedIndex]);

  useEffect(() => {
    if (!mentionOpen) return;
    const dropdown = mentionDropdownRef.current;
    if (!dropdown) return;
    const selected = dropdown.querySelector<HTMLElement>(
      `[data-mention-option-index="${mentionSelectedIndex}"]`,
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [mentionOpen, mentionSelectedIndex, mentionOptions]);

  useEffect(() => {
    if (!mentionOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [mentionOpen]);

  const mentionOpenRef = useRef(mentionOpen);
  const mentionQueryRef = useRef(mentionQuery);
  const mentionTargetRef = useRef(mentionTarget);

  useEffect(() => {
    mentionOpenRef.current = mentionOpen;
  }, [mentionOpen]);

  useEffect(() => {
    mentionQueryRef.current = mentionQuery;
  }, [mentionQuery]);

  useEffect(() => {
    mentionTargetRef.current = mentionTarget;
  }, [mentionTarget]);

  // Slash command refs (mirrors mention refs pattern)
  const slashOpenRef = useRef(slashOpen);
  const slashQueryRef = useRef(slashQuery);
  const slashTargetRef = useRef(slashTarget);
  const slashDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    slashOpenRef.current = slashOpen;
  }, [slashOpen]);

  useEffect(() => {
    slashQueryRef.current = slashQuery;
  }, [slashQuery]);

  useEffect(() => {
    slashTargetRef.current = slashTarget;
  }, [slashTarget]);

  // Close slash dropdown on outside click
  useEffect(() => {
    if (!slashOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [slashOpen]);

  const findSlashAtCursor = (value: string, cursor: number | null) => {
    if (cursor === null) return null;
    const uptoCursor = value.slice(0, cursor);
    // Find the last `/` before cursor
    const slashIndex = uptoCursor.lastIndexOf("/");
    if (slashIndex === -1) return null;
    // `/` must be at position 0 or preceded by a newline
    if (slashIndex > 0 && uptoCursor[slashIndex - 1] !== "\n") return null;
    const query = uptoCursor.slice(slashIndex + 1);
    // No spaces or newlines allowed in query
    if (query.includes(" ") || query.includes("\n") || query.includes("\r")) return null;
    return { query, start: slashIndex, end: cursor };
  };

  const slashOptions = useMemo<SlashCommandOption[]>(() => {
    if (!slashOpen) return [];
    return buildMessageSlashOptions({
      query: slashQuery,
      customSkills,
      pluginSlashCommands,
      includeOnboarding: Boolean(onStartOnboarding),
    });
  }, [slashOpen, slashQuery, customSkills, pluginSlashCommands, onStartOnboarding]);

  const effectiveSlashSelectedIndex = resolveSlashSelectedIndex(
    slashOptions.length,
    slashSelectedIndex,
  );

  const updateMentionState = useCallback((value: string, cursor: number | null) => {
    const mention = findMentionAtCursor(value, cursor);
    if (!mention) {
      // Only update state if it actually changed — avoids unnecessary re-renders
      if (mentionOpenRef.current) setMentionOpen(false);
      if (mentionQueryRef.current !== "") setMentionQuery("");
      if (mentionTargetRef.current !== null) setMentionTarget(null);
      return;
    }
    // Close slash if mention opens
    if (slashOpenRef.current) setSlashOpen(false);
    if (!mentionOpenRef.current) setMentionOpen(true);
    if (mentionQueryRef.current !== mention.query) setMentionQuery(mention.query);
    const prev = mentionTargetRef.current;
    if (!prev || prev.start !== mention.start || prev.end !== mention.end) {
      setMentionTarget({ start: mention.start, end: mention.end });
    }
    setMentionSelectedIndex(0);
  }, []);

  const updateSlashState = useCallback((value: string, cursor: number | null) => {
    const slash = findSlashAtCursor(value, cursor);
    if (!slash) {
      if (slashOpenRef.current) setSlashOpen(false);
      if (slashQueryRef.current !== "") setSlashQuery("");
      if (slashTargetRef.current !== null) setSlashTarget(null);
      return;
    }
    // Close mention if slash opens
    if (mentionOpenRef.current) setMentionOpen(false);
    if (!slashOpenRef.current) setSlashOpen(true);
    if (slashQueryRef.current !== slash.query) setSlashQuery(slash.query);
    const prev = slashTargetRef.current;
    if (!prev || prev.start !== slash.start || prev.end !== slash.end) {
      setSlashTarget({ start: slash.start, end: slash.end });
    }
    setSlashSelectedIndex(0);
  }, []);

  const handleSlashSelect = (option: SlashCommandOption) => {
    if (!slashTarget) return;
    setSlashOpen(false);
    setSlashQuery("");
    setSlashTarget(null);

    const insertSlashCommand = (commandName: string) => {
      pendingProgrammaticResizeRef.current = true;
      setModeSuggestions([]);
      const { nextValue, cursorPosition } = applySlashCommandSelection({
        value: inputValue,
        target: slashTarget,
        commandName,
      });
      setInputValue(nextValue);
      requestAnimationFrame(() => {
        const input = promptInputRef.current;
        if (input) {
          input.focus();
          input.setSelectionRange(cursorPosition, cursorPosition);
        }
      });
    };

    if (option.kind === "app") {
      pendingProgrammaticResizeRef.current = true;
      setModeSuggestions([]);
      if (option.shortcut.action === "clear") {
        setInputValue("");
        setPendingAttachments([]);
        setMentionOpen(false);
        setMentionQuery("");
        setMentionTarget(null);
        if (onStartFreshSession) {
          onStartFreshSession();
        } else {
          onSelectTask?.(null);
        }
        return;
      }

      insertSlashCommand(option.commandName);
      return;
    }

    if (option.kind === "builtin") {
      pendingProgrammaticResizeRef.current = true;
      setPendingAttachments([]);
      setModeSuggestions([]);
      if (onStartOnboarding) {
        setInputValue("");
        onStartOnboarding();
      }
      return;
    }

    insertSlashCommand(option.commandName);
  };

  const handleInputChange = (
    value: string,
    cursor: number,
    nextIntegrationMentionSpans: IntegrationMentionSpan[],
    shrink: boolean,
  ) => {
    autoResizeTextarea(undefined, shrink || value.length < inputValue.length);
    setInputValue(value);
    setIntegrationMentionSpans(nextIntegrationMentionSpans);
    // Defer mention/slash autocomplete updates so typing stays responsive
    startTransition(() => {
      updateMentionState(value, cursor);
      updateSlashState(value, cursor);
    });

    // Debounced mode suggestion detection
    if (modeSuggestionTimerRef.current) clearTimeout(modeSuggestionTimerRef.current);
    if (!value.trim()) {
      setModeSuggestions([]);
      return;
    }
    modeSuggestionTimerRef.current = setTimeout(() => {
      const excludeModes: string[] = [];
      // Don't suggest the currently active execution mode
      excludeModes.push(executionMode);
      if (collaborativeModeEnabled) excludeModes.push("collaborative");
      const suggestions = detectModeSuggestions(value, { excludeModes, maxResults: 2, threshold: 0.3 });
      setModeSuggestions(suggestions);
      if (suggestions.length > 0) setSuggestionsDismissed(false);
    }, 300);
  };

  const handleInputCursorChange = (cursor: number) => {
    updateMentionState(inputValue, cursor);
    updateSlashState(inputValue, cursor);
  };

  const replaceIntegrationMentionRange = (
    start: number,
    end: number,
    insertText: string,
    newSpan?: IntegrationMentionSpan,
  ): IntegrationMentionSpan[] => {
    const delta = insertText.length - (end - start);
    const shifted = integrationMentionSpans.flatMap((span) => {
      if (span.end <= start) return [span];
      if (span.start >= end) return [{ ...span, start: span.start + delta, end: span.end + delta }];
      return [];
    });
    return newSpan ? [...shifted, newSpan].sort((a, b) => a.start - b.start) : shifted;
  };

  const handleMentionSelect = (option: MentionOption) => {
    if (!mentionTarget) return;
    const insertText = option.type === "everyone" ? "@everybody" : `@${option.label}`;
    const before = inputValue.slice(0, mentionTarget.start);
    const after = inputValue.slice(mentionTarget.end);
    const needsSpace = after.length === 0 ? true : !after.startsWith(" ");
    const nextValue = `${before}${insertText}${needsSpace ? " " : ""}${after}`;
    const nextSpan =
      option.type === "integration" && option.integration
        ? {
            spanId: `${option.integration.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            start: mentionTarget.start,
            end: mentionTarget.start + insertText.length,
            mention: {
              id: option.integration.id,
              label: option.integration.label,
              source: option.integration.source,
              providerKey: option.integration.providerKey,
              iconKey: option.integration.iconKey,
              tools: option.integration.tools,
              promptHint: option.integration.promptHint,
            },
          }
        : undefined;
    setIntegrationMentionSpans(
      replaceIntegrationMentionRange(mentionTarget.start, mentionTarget.end, insertText, nextSpan),
    );
    pendingProgrammaticResizeRef.current = true;
    setInputValue(nextValue);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionTarget(null);

    requestAnimationFrame(() => {
      const input = promptInputRef.current;
      if (input) {
        const cursorPosition = before.length + insertText.length + (needsSpace ? 1 : 0);
        input.focus();
        input.setSelectionRange(cursorPosition, cursorPosition);
      }
    });
  };

  const handleModeSuggestionClick = useCallback(
    (suggestion: ModeSuggestion) => {
      if (suggestion.mode === "collaborative") {
        setCollaborativeModeSelection(true);
      } else {
        setExecutionMode(suggestion.mode as ExecutionMode);
      }
      setModeSuggestions((prev) => prev.filter((s) => s.mode !== suggestion.mode));
    },
    [setCollaborativeModeSelection],
  );

  const renderModeSuggestionBar = () => {
    if (modeSuggestions.length === 0 || suggestionsDismissed) return null;
    return (
      <div className="mode-suggestion-bar">
        {modeSuggestions.map((s) => (
          <button
            key={s.mode}
            className="mode-suggestion-pill"
            onClick={() => handleModeSuggestionClick(s)}
            title={s.description}
          >
            Use {s.label}
          </button>
        ))}
        <button
          className="mode-suggestion-dismiss"
          onClick={() => setSuggestionsDismissed(true)}
          title="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  };

  const renderMentionDropdown = () => {
    if (!mentionOpen || mentionOptions.length === 0) return null;
    const agentOptions = mentionOptions.filter(
      (option) => option.type === "agent" || option.type === "everyone",
    );
    const integrationOptions = mentionOptions.filter((option) => option.type === "integration");
    let optionIndex = 0;
    const renderOption = (option: MentionOption) => {
      const index = optionIndex++;
      const displayLabel = option.type === "everyone" ? "Everybody" : option.label;
      const isIntegration = option.type === "integration" && option.integration;
      return (
        <button
          key={`${option.type}-${option.id}`}
          className={`mention-autocomplete-item ${index === mentionSelectedIndex ? "selected" : ""}`}
          data-mention-option-index={index}
          onMouseDown={(e) => {
            e.preventDefault();
            handleMentionSelect(option);
          }}
          onMouseEnter={() => setMentionSelectedIndex(index)}
        >
          {isIntegration ? (
            <IntegrationMentionIcon
              iconKey={option.integration?.iconKey}
              label={option.label}
              size="sm"
            />
          ) : (
            <span
              className="mention-autocomplete-icon"
              style={{ backgroundColor: option.color || "#64748b" }}
            >
              <ThemeIcon emoji={option.icon || "👥"} icon={<UsersIcon size={16} />} />
            </span>
          )}
          <div className="mention-autocomplete-details">
            <span className="mention-autocomplete-name">{displayLabel}</span>
            {option.description && (
              <span className="mention-autocomplete-desc">{option.description}</span>
            )}
          </div>
        </button>
      );
    };
    return (
      <div className="mention-autocomplete-dropdown" ref={mentionDropdownRef}>
        {agentOptions.length > 0 && (
          <div className="mention-autocomplete-section">
            <div className="mention-autocomplete-section-label">Agents</div>
            <div className="mention-autocomplete-section-list">
              {agentOptions.map(renderOption)}
            </div>
          </div>
        )}
        {integrationOptions.length > 0 && (
          <div className="mention-autocomplete-section">
            <div className="mention-autocomplete-section-label">Integrations</div>
            <div className="mention-autocomplete-section-list">
              {integrationOptions.map(renderOption)}
            </div>
          </div>
        )}
        <div className="mention-autocomplete-section">
          <div className="mention-autocomplete-section-label">Files</div>
        </div>
      </div>
    );
  };

  const renderSlashDropdown = () => {
    if (!slashOpen || slashOptions.length === 0) return null;
    return (
      <div
        className="mention-autocomplete-dropdown slash-autocomplete-dropdown"
        ref={slashDropdownRef}
      >
        {slashOptions.map((option, index) => (
          <button
            key={option.id}
            className={`mention-autocomplete-item ${index === effectiveSlashSelectedIndex ? "selected" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              handleSlashSelect(option);
            }}
            onMouseEnter={() => setSlashSelectedIndex(index)}
          >
              <span className="mention-autocomplete-icon slash-command-icon">{option.icon}</span>
            <div className="mention-autocomplete-details">
              <span className="mention-autocomplete-name">/{option.commandName}</span>
              {option.description && (
                <span className="mention-autocomplete-desc">{option.description}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen && mentionOptions.length > 0) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setMentionSelectedIndex(
            (prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length,
          );
          return;
        case "Enter":
        case "Tab":
          e.preventDefault();
          handleMentionSelect(mentionOptions[mentionSelectedIndex]);
          return;
        case "Escape":
          e.preventDefault();
          setMentionOpen(false);
          return;
      }
    }

    if (slashOpen && slashOptions.length > 0) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSlashSelectedIndex((prev) => (prev + 1) % slashOptions.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setSlashSelectedIndex((prev) => (prev - 1 + slashOptions.length) % slashOptions.length);
          return;
        case "Enter":
        case "Tab":
          if (parseLeadingSkillSlashCommand(inputValue).matched) {
            break;
          }
          e.preventDefault();
          handleSlashSelect(slashOptions[effectiveSlashSelectedIndex]);
          return;
        case "Escape":
          e.preventDefault();
          setSlashOpen(false);
          return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleQuickAction = (action: string) => {
    pendingProgrammaticResizeRef.current = true;
    setInputValue(action);
    setIntegrationMentionSpans([]);
    setActiveWelcomeSuggestionDraft(null);
  };

  const handleWelcomeTaskSuggestion = (suggestion: WelcomeTaskSuggestion) => {
    if (suggestion.action.type === "task") {
      setActiveWelcomeSuggestionDraft(null);
      onSelectTask?.(suggestion.action.taskId);
    } else if (suggestion.action.type === "settings") {
      setActiveWelcomeSuggestionDraft(null);
      onOpenSettings?.(suggestion.action.tab);
    } else if (suggestion.action.type === "url") {
      setActiveWelcomeSuggestionDraft(null);
      if (onOpenWebLinkInSidebar) {
        onOpenWebLinkInSidebar(suggestion.action.url);
      } else {
        onOpenBrowserView?.(suggestion.action.url);
      }
    } else {
      const prompt = suggestion.action.prompt;
      handleQuickAction(prompt);
      setActiveWelcomeSuggestionDraft(
        suggestion.feedback?.kind === "proactive"
          ? {
              workspaceId: suggestion.feedback.workspaceId,
              suggestionId: suggestion.feedback.suggestionId,
              originalPrompt: prompt,
            }
          : null,
      );
      window.setTimeout(() => {
        promptInputRef.current?.focus();
        const position = prompt.length;
        promptInputRef.current?.setSelectionRange(position, position);
      }, 0);
    }
    setWelcomeTaskSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
  };

  const handleDismissWelcomeTaskSuggestion = (
    event: ReactMouseEvent<HTMLButtonElement>,
    suggestion: WelcomeTaskSuggestion,
  ) => {
    event.stopPropagation();
    setWelcomeTaskSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
    if (activeWelcomeSuggestionDraft?.suggestionId === suggestion.feedback?.suggestionId) {
      setActiveWelcomeSuggestionDraft(null);
    }
    if (suggestion.feedback?.kind === "proactive") {
      void window.electronAPI
        .dismissSuggestion(suggestion.feedback.workspaceId, suggestion.feedback.suggestionId)
        .catch(() => {
          // Best effort; local dismissal already keeps the row out of this welcome screen.
        });
    }
  };

  const handleSnoozeWelcomeTaskSuggestion = (
    event: ReactMouseEvent<HTMLButtonElement>,
    suggestion: WelcomeTaskSuggestion,
  ) => {
    event.stopPropagation();
    setWelcomeTaskSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
    if (activeWelcomeSuggestionDraft?.suggestionId === suggestion.feedback?.suggestionId) {
      setActiveWelcomeSuggestionDraft(null);
    }
    if (suggestion.feedback?.kind === "proactive") {
      void window.electronAPI
        .snoozeSuggestion(
          suggestion.feedback.workspaceId,
          suggestion.feedback.suggestionId,
          Date.now() + 24 * 60 * 60 * 1000,
        )
        .catch(() => {
          // Best effort; local snooze already keeps the row out of this welcome screen.
        });
    }
  };

  const renderWelcomeTaskSuggestions = () => {
    if (!homeNextActionsEnabled) return null;
    if (welcomeTaskSuggestions.length === 0) return null;
    return (
      <section className="welcome-next-actions" aria-label="Next actions">
        <div className="welcome-next-actions-header">
          <span className="welcome-next-actions-title">Next actions</span>
        </div>
        <div className="welcome-next-actions-list">
        {welcomeTaskSuggestions.map((suggestion) => {
          const Icon = iconForWelcomeAction(suggestion);
          const actionLabel = labelForWelcomeAction(suggestion.action);
          const title = [suggestion.title, suggestion.whyNow, suggestion.description]
            .concat(suggestion.evidence?.slice(0, 3) || [])
            .filter(Boolean)
            .join("\n");
          const metaChips = [
            actionLabel,
            ...formatWelcomeModules(suggestion.modules),
            typeof suggestion.confidence === "number"
              ? `${Math.round(suggestion.confidence * 100)}%`
              : null,
            suggestion.evidence?.length ? `${suggestion.evidence.length} signals` : null,
          ].filter((value): value is string => Boolean(value));
          return (
            <div
              key={suggestion.id}
              className={`welcome-next-action suggestion-${suggestion.source}`}
            >
              <button
                type="button"
                className="welcome-next-action-main"
                onClick={() => handleWelcomeTaskSuggestion(suggestion)}
                title={title}
              >
                <Icon className="welcome-next-action-icon" size={16} aria-hidden="true" />
                <span className="welcome-next-action-copy">
                  <span className="welcome-next-action-title">{suggestion.title}</span>
                  <span className="welcome-next-action-why">{suggestion.whyNow}</span>
                </span>
                <span className="welcome-next-action-modules" aria-hidden="true">
                  {metaChips.slice(0, 4).map((module) => (
                    <span key={module} className="welcome-next-action-module">
                      {module}
                    </span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                className="welcome-next-action-snooze"
                onClick={(event) => handleSnoozeWelcomeTaskSuggestion(event, suggestion)}
                aria-label={`Snooze ${suggestion.title}`}
                title="Snooze for a day"
              >
                <Clock size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="welcome-next-action-dismiss"
                onClick={(event) => handleDismissWelcomeTaskSuggestion(event, suggestion)}
                aria-label={`Dismiss ${suggestion.title}`}
                title="Dismiss"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        </div>
      </section>
    );
  };

  const formatVaultUpdatedAt = useCallback((updatedAt: string) => {
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }, []);

  const renderVaultEntryGroup = useCallback(
    (
      title: string,
      entries: LlmWikiVaultEntry[],
      emptyLabel: string,
    ) => (
      <div className="vault-browser-group">
        <div className="vault-browser-group-title">{title}</div>
        {entries.length === 0 ? (
          <div className="vault-browser-empty">{emptyLabel}</div>
        ) : (
          <div className="vault-browser-list">
            {entries.map((entry) => (
              <button
                key={`${entry.section}:${entry.path}`}
                type="button"
                className="vault-browser-item"
                onClick={() => setViewerFilePath(entry.path)}
                title={entry.path}
              >
                <span className="vault-browser-item-name">{entry.name}</span>
                <span className="vault-browser-item-meta">
                  <span className="vault-browser-item-path">{entry.path}</span>
                  <span>{formatVaultUpdatedAt(entry.updatedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    ),
    [formatVaultUpdatedAt],
  );

  const renderLlmWikiVaultPanel = () => {
    if (!homeResearchVaultEnabled) {
      return null;
    }
    if (!workspace?.path || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
      return null;
    }

    const summary = llmWikiVaultSummary;
    const rootIndexFile =
      summary?.rootFiles.find((entry) => entry.path.endsWith("/index.md") || entry.path === "research/wiki/index.md") ||
      summary?.rootFiles.find((entry) => entry.path.endsWith("index.md"));

    return (
      <section className="vault-browser-panel" aria-label="Research vault">
        <div className="vault-browser-header">
          <div>
            <div className="vault-browser-kicker">Research vault</div>
            <h2 className="vault-browser-heading">
              {summary?.displayPath || "research/wiki"}
            </h2>
            <p className="vault-browser-copy">
              Durable markdown notes, immutable raw captures, and generated outputs that stay in the workspace.
            </p>
          </div>
          <div className="vault-browser-actions">
            <button type="button" className="vault-browser-action" onClick={() => handleQuickAction(LLM_WIKI_GUI_PROMPT)}>
              Ingest
            </button>
            <button type="button" className="vault-browser-action" onClick={() => handleQuickAction(LLM_WIKI_QUERY_GUI_PROMPT)}>
              Query
            </button>
            <button type="button" className="vault-browser-action" onClick={() => handleQuickAction(LLM_WIKI_AUDIT_GUI_PROMPT)}>
              Audit
            </button>
            <button type="button" className="vault-browser-action" onClick={() => handleQuickAction(LLM_WIKI_EXPLORE_GUI_PROMPT)}>
              Explore
            </button>
            <button type="button" className="vault-browser-action" onClick={() => handleQuickAction(LLM_WIKI_BRIEF_GUI_PROMPT)}>
              Brief
            </button>
            {rootIndexFile && (
              <button
                type="button"
                className="vault-browser-action vault-browser-action-secondary"
                onClick={() => setViewerFilePath(rootIndexFile.path)}
              >
                Open index
              </button>
            )}
          </div>
        </div>

        {llmWikiVaultLoading ? (
          <div className="vault-browser-loading">Loading vault summary...</div>
        ) : summary?.exists ? (
          <>
            <div className="vault-browser-stats" role="list" aria-label="Vault stats">
              <div className="vault-browser-stat" role="listitem">
                <span className="vault-browser-stat-value">{summary.counts.pages}</span>
                <span className="vault-browser-stat-label">pages</span>
              </div>
              <div className="vault-browser-stat" role="listitem">
                <span className="vault-browser-stat-value">{summary.counts.queries}</span>
                <span className="vault-browser-stat-label">queries</span>
              </div>
              <div className="vault-browser-stat" role="listitem">
                <span className="vault-browser-stat-value">{summary.counts.rawSources}</span>
                <span className="vault-browser-stat-label">raw sources</span>
              </div>
              <div className="vault-browser-stat" role="listitem">
                <span className="vault-browser-stat-value">{summary.counts.outputs}</span>
                <span className="vault-browser-stat-label">outputs</span>
              </div>
            </div>

            <div className="vault-browser-groups">
              {renderVaultEntryGroup("Core files", summary.rootFiles, "Initialize the vault to create index, inbox, log, and schema files.")}
              {renderVaultEntryGroup("Recent notes", summary.recentPages, "No durable notes yet.")}
              {renderVaultEntryGroup("Recent queries", summary.recentQueries, "No filed queries yet.")}
              {renderVaultEntryGroup("Recent outputs", summary.recentOutputs, "No slide decks or charts yet.")}
              {renderVaultEntryGroup("Recent raw captures", summary.recentRawSources, "No raw source captures yet.")}
            </div>
          </>
        ) : (
          <div className="vault-browser-empty-state">
            <div className="vault-browser-empty-title">No research vault yet</div>
            <div className="vault-browser-empty-copy">
              Start with a normal prompt. CoWork will create the vault in this workspace and keep it durable.
            </div>
          </div>
        )}
      </section>
    );
  };

  useEffect(() => {
    if (task?.status === "paused" && promptInputRef.current) {
      const inputEl = promptInputRef.current;
      window.requestAnimationFrame(() => {
        inputEl.focus();
      });
    }
  }, [task?.status]);

  const formatTime = useCallback((timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }, []);

  // Get the last assistant message to always show the response
  const lastAssistantMessage = useMemo(() => {
    const assistantMessages = filteredEvents.filter((event) => {
      const effectiveType = getEffectiveTaskEventType(event);
      if (effectiveType === "assistant_message") return true;
      return getCompletionSummaryText(event).length > 0;
    });
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }, [filteredEvents]);

  const {
    cleanedDisplayPrompt,
    trimmedPrompt,
    promptAttachmentNames,
    headerTitle,
    headerTooltip,
    showHeaderTitle,
  } = useMemo(() => deriveTaskHeaderPresentation(task), [task]);

  const taskWorkingDirectory = task?.worktreePath || workspace?.path || "";
  const taskIdCopyValue = task?.id || "";
  const taskDeeplink = task ? `cowork://tasks/${task.id}` : "";
  const taskOutputSummary = useMemo(
    () => resolveTaskOutputSummaryFromTask(task, events),
    [events, task],
  );
  const taskMarkdown = useMemo(() => {
    if (!task) return "";
    const promptText =
      cleanedDisplayPrompt ||
      task.userPrompt ||
      task.rawPrompt ||
      task.prompt ||
      "";
    return [
      `# ${task.title}`,
      "",
      `- Status: ${task.status}`,
      `- Task ID: ${task.id}`,
      task.sessionId ? `- Session ID: ${task.sessionId}` : null,
      taskWorkingDirectory ? `- Working directory: ${taskWorkingDirectory}` : null,
      `- Link: ${taskDeeplink}`,
      task.semanticSummary ? `- Summary: ${task.semanticSummary}` : null,
      "",
      "## Prompt",
      "",
      promptText.trim() || "_No prompt available._",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }, [cleanedDisplayPrompt, task, taskDeeplink, taskWorkingDirectory]);
  const taskAutomationDefaultPrompt = useMemo(() => {
    if (!task) return "";
    return (
      cleanedDisplayPrompt ||
      task.userPrompt ||
      task.rawPrompt ||
      task.prompt ||
      task.title ||
      ""
    ).trim();
  }, [cleanedDisplayPrompt, task]);

  const closeTaskHeaderMenu = useCallback(() => {
    setShowTaskHeaderMenu(false);
  }, []);

  const copyTaskHeaderMenuText = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy task menu value:", error);
    }
  }, []);

  const handleTaskHeaderMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    const menu = taskHeaderMenuRef.current;
    if (!menu) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeTaskHeaderMenu();
      taskHeaderMenuButtonRef.current?.focus();
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    event.preventDefault();
    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("button[data-task-header-menu-option]:not(:disabled)"),
    );
    if (options.length === 0) return;
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex >= 0
      ? (currentIndex + offset + options.length) % options.length
      : event.key === "ArrowDown"
        ? 0
        : options.length - 1;
    options[nextIndex]?.focus();
  }, [closeTaskHeaderMenu]);

  const handleTaskHeaderMenuButtonKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
    event.preventDefault();
    setShowTaskHeaderMenu(true);
    requestAnimationFrame(() => {
      const firstOption = taskHeaderMenuRef.current?.querySelector<HTMLButtonElement>(
        "button[data-task-header-menu-option]:not(:disabled)",
      );
      firstOption?.focus();
    });
  }, []);

  const handleTaskHeaderPin = useCallback(async () => {
    if (!task || remoteSession) return;
    closeTaskHeaderMenu();
    try {
      await window.electronAPI.toggleTaskPin(task.id);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to toggle task pin from header:", error);
    }
  }, [closeTaskHeaderMenu, onTasksChanged, remoteSession, task]);

  const handleTaskHeaderRename = useCallback(async () => {
    if (!task || remoteSession) return;
    closeTaskHeaderMenu();
    const nextTitle = window.prompt("Rename task", task.title)?.trim();
    if (!nextTitle || nextTitle === task.title) return;
    try {
      await window.electronAPI.renameTask(task.id, nextTitle);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to rename task from header:", error);
    }
  }, [closeTaskHeaderMenu, onTasksChanged, remoteSession, task]);

  const handleTaskHeaderArchive = useCallback(async () => {
    if (!task || remoteSession) return;
    closeTaskHeaderMenu();
    try {
      await window.electronAPI.deleteTask(task.id);
      onSelectTask?.(null);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to archive task from header:", error);
    }
  }, [closeTaskHeaderMenu, onSelectTask, onTasksChanged, remoteSession, task]);

  const handleTaskHeaderFork = useCallback(async () => {
    if (!task || remoteSession) return;
    closeTaskHeaderMenu();
    try {
      const forkedTask = await window.electronAPI.forkTaskSession({
        taskId: task.id,
        branchLabel: "fork",
      });
      await onTasksChanged?.();
      if (forkedTask?.id) {
        onSelectTask?.(forkedTask.id);
      }
    } catch (error) {
      console.error("Failed to fork task session from header:", error);
    }
  }, [closeTaskHeaderMenu, onSelectTask, onTasksChanged, remoteSession, task]);

  const handleTaskHeaderSideChat = useCallback(async () => {
    if (!task || remoteSession || !onOpenSideChat) return;
    closeTaskHeaderMenu();
    await onOpenSideChat({ taskId: task.id });
  }, [closeTaskHeaderMenu, onOpenSideChat, remoteSession, task]);

  const handleForkTaskSessionFromEvent = useCallback(
    async (event: TaskEvent) => {
      if (!task || remoteSession || !event.id) return;
      try {
        const forkedTask = await window.electronAPI.forkTaskSession({
          taskId: event.taskId || task.id,
          branchLabel: "fork",
          fromEventId: event.id,
        });
        await onTasksChanged?.();
        if (forkedTask?.id) {
          onSelectTask?.(forkedTask.id);
        }
      } catch (error) {
        void error;
      }
    },
    [onSelectTask, onTasksChanged, remoteSession, task],
  );

  const handleTaskHeaderAddAutomation = useCallback(() => {
    if (!task || remoteSession) return;
    closeTaskHeaderMenu();
    setShowTaskAutomationModal(true);
  }, [closeTaskHeaderMenu, remoteSession, task]);

  const handleTaskHeaderOpenBrowser = useCallback(() => {
    if (!task || remoteSession || !workspace?.path || !onOpenBrowserWorkbenchSidebar) return;
    closeTaskHeaderMenu();
    onOpenBrowserWorkbenchSidebar();
  }, [
    closeTaskHeaderMenu,
    onOpenBrowserWorkbenchSidebar,
    remoteSession,
    task,
    workspace?.path,
  ]);

  const initialPromptEventId = useMemo(() => {
    if (!trimmedPrompt) return null;
    for (const event of events) {
      if (getEffectiveTaskEventType(event) !== "user_message") continue;
      const cleanedEventMessage = getUserEventDisplayMessage(event);
      if (cleanedEventMessage === trimmedPrompt || cleanedEventMessage.startsWith(trimmedPrompt)) {
        return event.id || null;
      }
    }
    return null;
  }, [events, trimmedPrompt]);

  const latestPauseEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (getEffectiveTaskEventType(events[i]) === "task_paused") {
        return events[i];
      }
    }
    return undefined;
  }, [events]);
  const effectivePauseReasonCode =
    task?.awaitingUserInputReasonCode ||
    (typeof latestPauseEvent?.payload?.reason === "string" ? latestPauseEvent.payload.reason : undefined);
  const effectivePauseMessage = useMemo(() => {
    const pauseMessage =
      typeof latestPauseEvent?.payload?.message === "string" ? latestPauseEvent.payload.message.trim() : "";
    if (!isLowSignalPauseMessage(pauseMessage, effectivePauseReasonCode)) {
      return pauseMessage;
    }
    const assistantFallback = getAssistantOrCompletionText(lastAssistantMessage);
    if (assistantFallback && !isLowSignalPauseMessage(assistantFallback, effectivePauseReasonCode)) {
      return assistantFallback;
    }
    const eventFallback = buildPauseDecisionFallbackFromRecentEvents(events, latestPauseEvent);
    if (eventFallback) return eventFallback;
    return isLowSignalPauseMessage(pauseMessage, effectivePauseReasonCode) ? "" : pauseMessage;
  }, [effectivePauseReasonCode, events, lastAssistantMessage, latestPauseEvent]);
  const latestApprovalEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        getEffectiveTaskEventType(event) === "approval_requested" &&
        event.payload?.autoApproved !== true
      ) {
        return event;
      }
    }
    return undefined;
  }, [events]);
  const latestCompletionEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (getEffectiveTaskEventType(event) === "task_completed") {
        return event;
      }
    }
    return undefined;
  }, [events]);
  const showPersistentNeedsUserActionBanner = useMemo(
    () => shouldShowPersistentNeedsUserActionBanner(latestCompletionEvent?.payload),
    [latestCompletionEvent],
  );
  const hasNonConversationEvents = useMemo(() => {
    if (isChatTask) return false;
    return events.some((event) => {
      const effectiveType = getEffectiveTaskEventType(event);
      return effectiveType !== "user_message" && effectiveType !== "assistant_message";
    });
  }, [events, isChatTask]);
  const initialPromptBubble = useMemo(() => {
    if (!trimmedPrompt) return null;
    const initialIntegrationMentions = task?.agentConfig?.integrationMentions;
    return (
      <div className="chat-message user-message">
        <CollapsibleUserBubble>
          <UserMessageText
            text={cleanedDisplayPrompt}
            integrationMentions={initialIntegrationMentions}
            markdownComponents={markdownComponents}
          />
          {promptAttachmentNames.length > 0 && (
            <div className="bubble-attachments">
              {promptAttachmentNames.map((name, i) => (
                <span className="bubble-attachment-chip" key={i}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="bubble-attachment-name" title={name}>
                    {name}
                  </span>
                </span>
              ))}
            </div>
          )}
        </CollapsibleUserBubble>
        <MessageCopyButton text={cleanedDisplayPrompt} />
      </div>
    );
  }, [
    cleanedDisplayPrompt,
    markdownComponents,
    promptAttachmentNames,
    task?.agentConfig?.integrationMentions,
    trimmedPrompt,
  ]);
  const hasActiveStructuredInputRequest = Boolean(
    task &&
      inputRequest &&
      inputRequest.taskId === task.id &&
      onSubmitInputRequest &&
      onDismissInputRequest,
  );
  const [dismissedLegalWorkflowTaskId, setDismissedLegalWorkflowTaskId] =
    useState<string | null>(null);
  const legalWorkflowInvocation = useMemo(
    () => parseLegalWorkflowSlashPrompt(trimmedPrompt),
    [trimmedPrompt],
  );
  const hasUserFollowUpAfterInitialPrompt = useMemo(
    () =>
      events.some((event) => {
        if (getEffectiveTaskEventType(event) !== "user_message") return false;
        if (initialPromptEventId && event.id === initialPromptEventId) return false;
        const message = typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
        return message.length > 0;
      }),
    [events, initialPromptEventId],
  );
  const showLegalWorkflowCard = Boolean(
    task &&
      legalWorkflowInvocation.matched &&
      !hasActiveStructuredInputRequest &&
      !hasUserFollowUpAfterInitialPrompt &&
      dismissedLegalWorkflowTaskId !== task.id &&
      !["failed", "cancelled"].includes(task.status),
  );

  // Welcome/Empty state
  if (!task) {
    return (
      <div className="main-content">
        <div className="main-body welcome-view">
          <div
            className={`welcome-content cli-style${uiDensity === "focused" ? " welcome-content-focused" : ""}`}
          >
            {/* Logo */}
            {uiDensity === "focused" ? (
              <div className="welcome-header-focused modern-only">
                <img
                  src="./cowork-os-sl-dark-logo.png"
                  alt="CoWork OS"
                  className="modern-logo-text logo-for-dark"
                />
                <img
                  src="./cowork-os-sl-color-logo.png"
                  alt="CoWork OS"
                  className="modern-logo-text logo-for-light"
                />
                <h1 className="focused-greeting">{agentContext.getMessage("welcomeSubtitle")}</h1>
              </div>
            ) : (
              <div className="welcome-header-modern modern-only">
                <div className="modern-logo-container">
                  <img
                    src="./cowork-os-sl-dark-logo.png"
                    alt="CoWork OS"
                    className="modern-logo-text logo-for-dark"
                  />
                  <img
                    src="./cowork-os-sl-color-logo.png"
                    alt="CoWork OS"
                    className="modern-logo-text logo-for-light"
                  />
                  <span className="modern-version">{appVersion ? `v${appVersion}` : ""}</span>
                </div>
                <p className="modern-subtitle">{agentContext.getMessage("welcomeSubtitle")}</p>
              </div>
            )}

            <div className="terminal-only">
              <div className="welcome-logo">
                <img
                  src="./cowork-os-sl-dark-logo.png"
                  alt="CoWork OS"
                  className="welcome-logo-img welcome-brand-wordmark logo-for-dark"
                />
                <img
                  src="./cowork-os-sl-color-logo.png"
                  alt="CoWork OS"
                  className="welcome-logo-img welcome-brand-wordmark logo-for-light"
                />
              </div>

              {/* ASCII Terminal Header */}
              <div className="cli-header">
                <pre className="ascii-art">{`
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗      ██████╗ ███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝     ██╔═══██╗██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝      ██║   ██║███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗      ██║   ██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗     ╚██████╔╝███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝`}</pre>
                <div className="cli-version">{appVersion ? `v${appVersion}` : ""}</div>
              </div>

              {/* Terminal Info */}
              <div className="cli-info">
                <div className="cli-line">
                  <span className="cli-prompt">$</span>
                  <span className="cli-text" title={agentContext.getMessage("welcome")}>
                    {agentContext.getMessage("welcome")}
                  </span>
                </div>
                <div className="cli-line cli-line-secondary">
                  <span className="cli-prompt">&gt;</span>
                  <span className="cli-text">{agentContext.getMessage("welcomeSubtitle")}</span>
                </div>
                <div className="cli-line cli-line-disclosure">
                  <span className="cli-prompt">#</span>
                  <span
                    className="cli-text cli-text-muted"
                    title={agentContext.getMessage("disclaimer")}
                  >
                    {agentContext.getMessage("disclaimer")}
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Start */}
            <div className="cli-commands">
              {uiDensity !== "focused" && (
                <div className="cli-commands-header">
                  <span className="cli-prompt">&gt;</span>
                  <span className="terminal-only">QUICK START</span>
                  <span className="modern-only">Quick start</span>
                </div>
              )}
              {uiDensity === "focused" ? (
                <div className="quick-start-grid focused-cards">
                  {focusedCards.map((card) => {
                    const iconMap: Record<string, React.ReactNode> = {
                      edit: <EditIcon size={22} />,
                      search: <SearchIcon size={22} />,
                      chart: <ChartIcon size={22} />,
                      folder: <FolderIcon size={22} />,
                      zap: <ZapIcon size={22} />,
                      message: <MessageIcon size={22} />,
                      clipboard: <ClipboardIcon size={22} />,
                      filetext: <FileTextIcon size={22} />,
                      code: <CodeIcon size={22} />,
                      globe: <GlobeIcon size={22} />,
                      book: <BookIcon size={22} />,
                      calendar: <CalendarIcon size={22} />,
                      sliders: <SlidersIcon size={22} />,
                      shield: <ShieldIcon size={22} />,
                    };
                    const handleClick = () => {
                      if (card.action.type === "prompt") {
                        handleQuickAction(card.action.prompt);
                      } else {
                        onOpenSettings?.(card.action.tab);
                      }
                    };
                    return (
                      <button
                        key={card.id}
                        className={`quick-start-card ${card.category !== "task" ? "card-" + card.category : ""}`}
                        onClick={handleClick}
                        title={card.desc}
                      >
                        <ThemeIcon
                          className="quick-start-icon"
                          emoji={card.emoji}
                          icon={iconMap[card.iconName] || <ZapIcon size={22} />}
                        />
                        <span className="quick-start-title">{card.title}</span>
                        <span className="quick-start-desc">{card.desc}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="quick-start-grid">
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's organize the files in this folder together. Sort them by type and rename them with clear, consistent names.",
                      )
                    }
                    title="Let's sort and tidy up the workspace"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📁"
                      icon={<FolderIcon size={22} />}
                    />
                    <span className="quick-start-title">Organize files</span>
                    <span className="quick-start-desc">Let's sort and tidy up the workspace</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's write a document together. I'll describe what I need and we can create it.",
                      )
                    }
                    title="Co-create reports, summaries, or notes"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📝"
                      icon={<EditIcon size={22} />}
                    />
                    <span className="quick-start-title">Write together</span>
                    <span className="quick-start-desc">Co-create reports, summaries, or notes</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's analyze the data files in this folder together. We'll summarize the key findings and create a report.",
                      )
                    }
                    title="Work through spreadsheets or data files"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📊"
                      icon={<ChartIcon size={22} />}
                    />
                    <span className="quick-start-title">Analyze data</span>
                    <span className="quick-start-desc">
                      Work through spreadsheets or data files
                    </span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's generate documentation for this project together. We can create a README, API docs, or code comments as needed.",
                      )
                    }
                    title="Build documentation for the project"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📖"
                      icon={<BookIcon size={22} />}
                    />
                    <span className="quick-start-title">Generate docs</span>
                    <span className="quick-start-desc">Build documentation for the project</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
                      )
                    }
                    title="Analyze a market and find opportunities"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="🏁"
                      icon={<SearchIcon size={22} />}
                    />
                    <span className="quick-start-title">Research competitors</span>
                    <span className="quick-start-desc">
                      Analyze a market and find opportunities
                    </span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Help me validate a business idea. I'll describe the concept, and you'll assess the market size, competitors, unique angle, and give a go/no-go recommendation.",
                      )
                    }
                    title="Market size, competitors, and a go/no-go call"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="💡"
                      icon={<ZapIcon size={22} />}
                    />
                    <span className="quick-start-title">Validate an idea</span>
                    <span className="quick-start-desc">
                      Market size, competitors, and a go/no-go call
                    </span>
                  </button>
                </div>
              )}
            </div>

            {renderLlmWikiVaultPanel()}

            {/* Input Area */}
            {renderAttachmentPanel()}
            <div
              className={`welcome-input-container cli-input-container ${isDraggingFiles ? "drag-over" : ""}`}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {showVoiceNotConfigured && (
                <div className="voice-not-configured-banner">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  <span>Voice input is not configured.</span>
                  <button
                    className="voice-settings-link"
                    onClick={() => {
                      setShowVoiceNotConfigured(false);
                      onOpenSettings?.("voice");
                    }}
                  >
                    Open Voice Settings
                  </button>
                  <button
                    className="voice-banner-close"
                    onClick={() => setShowVoiceNotConfigured(false)}
                    title="Dismiss"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
              {renderModeSuggestionBar()}
              <div
                className="cli-input-wrapper"
                ref={cliInputWrapperRef}
                onMouseDown={(event) => {
                  if (
                    event.target instanceof HTMLElement &&
                    event.target.closest(
                      ".mention-autocomplete-dropdown, .slash-autocomplete-dropdown",
                    )
                  ) {
                    return;
                  }
                  promptInputRef.current?.focus();
                }}
              >
                <span className="cli-input-prompt">~$</span>
                <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
                  {showCliPlaceholder && (
                    <TypewriterPlaceholder phrases={placeholderPlaylist} />
                  )}
                  <PromptComposerInput
                    ref={promptInputRef}
                    className={`welcome-input cli-input input-textarea${
                      !inputValue ? " input-textarea-empty-placeholder" : ""
                    }`}
                    value={inputValue}
                    mentions={integrationMentionSpans}
                    ariaLabel="Message"
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onFocus={() => setIsCliInputFocused(true)}
                    onBlur={() => setIsCliInputFocused(false)}
                    onCursorChange={handleInputCursorChange}
                  />
                  {renderMentionDropdown()}
                  {renderSlashDropdown()}
                </div>
                {showCliEmptyCursor && (
                  <span className="cli-cursor active" style={{ left: cursorLeft }} />
                )}
              </div>

              <div className="welcome-input-footer">
                <div className="input-left-actions">
                  <button
                    className="attachment-btn attachment-btn-left"
                    onClick={handleAttachFiles}
                    disabled={isUploadingAttachments}
                    title="Add files"
                    aria-label="Add files"
                  >
                    <Plus size={24} aria-hidden="true" />
                  </button>
                  <div className="permission-dropdown-container" ref={permissionDropdownRef}>
                    <button
                      type="button"
                      className={`permission-access-btn ${
                        permissionAccessMode === "full" ? "full" : ""
                      }`}
                      onClick={() => setShowPermissionDropdown((open) => !open)}
                      aria-haspopup="menu"
                      aria-expanded={showPermissionDropdown}
                      aria-label="Permission access mode"
                      title={
                        permissionAccessMode === "full"
                          ? "Full access"
                          : "Default permissions"
                      }
                    >
                      {permissionAccessMode === "full" ? (
                        <ShieldAlert size={18} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={18} aria-hidden="true" />
                      )}
                      <span>
                        {permissionAccessMode === "full" ? "Full access" : "Default permissions"}
                      </span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                    {showPermissionDropdown && (
                      <div
                        className="permission-access-dropdown"
                        role="menu"
                        aria-label="Permission access mode"
                      >
                        <button
                          type="button"
                          className={`permission-access-option ${
                            permissionAccessMode === "default" ? "active" : ""
                          }`}
                          onClick={() => {
                            setPermissionAccessMode("default");
                            setShowPermissionDropdown(false);
                          }}
                          role="menuitemradio"
                          aria-checked={permissionAccessMode === "default"}
                        >
                          <ShieldCheck size={16} aria-hidden="true" />
                          <span>Default permissions</span>
                        </button>
                        <button
                          type="button"
                          className={`permission-access-option danger ${
                            permissionAccessMode === "full" ? "active" : ""
                          }`}
                          onClick={() => {
                            setPermissionAccessMode("full");
                            setShowPermissionDropdown(false);
                          }}
                          role="menuitemradio"
                          aria-checked={permissionAccessMode === "full"}
                        >
                          <ShieldAlert size={16} aria-hidden="true" />
                          <span>Full access</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {uiDensity === "focused" ? null : (
                    <>
                      <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                        <button className="folder-selector" onClick={handleWorkspaceDropdownToggle}>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                          </svg>
                          <span>
                            {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                              ? "Work in a folder"
                              : workspace?.name || "Work in a folder"}
                          </span>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className={showWorkspaceDropdown ? "chevron-up" : ""}
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        {showWorkspaceDropdown && (
                          <div className="workspace-dropdown">
                            {workspacesList.length > 0 && (
                              <>
                                <div className="workspace-dropdown-header">Recent Folders</div>
                                <div className="workspace-dropdown-list">
                                  {workspacesList.slice(0, 10).map((w) => (
                                    <button
                                      key={w.id}
                                      className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                      onClick={() => handleWorkspaceSelect(w)}
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                      >
                                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                      </svg>
                                      <div className="workspace-item-info">
                                        <span className="workspace-item-name">{w.name}</span>
                                        <span className="workspace-item-path">{w.path}</span>
                                      </div>
                                      {workspace?.id === w.id && (
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          className="check-icon"
                                        >
                                          <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                      )}
                                    </button>
                                  ))}
                                </div>
                                <div className="workspace-dropdown-divider" />
                              </>
                            )}
                            <button
                              className="workspace-dropdown-item new-folder"
                              onClick={handleSelectNewFolder}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                              <span>Work in another folder...</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="overflow-menu-container" ref={overflowMenuRef}>
                        <button
                          ref={overflowToggleBtnRef}
                          className={`overflow-menu-btn ${showOverflowMenu ? "active" : ""}`}
                          onClick={() => setShowOverflowMenu(!showOverflowMenu)}
                          onKeyDown={handleOverflowButtonKeyDown}
                          title="More options"
                          aria-label="More options"
                          aria-haspopup="menu"
                          aria-expanded={showOverflowMenu}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                            <circle cx="5" cy="12" r="1" />
                          </svg>
                        </button>
                        {showOverflowMenu && (
                          <div
                            className="overflow-menu-dropdown"
                            role="menu"
                            aria-label="More options"
                            onKeyDown={handleOverflowMenuKeyDown}
                          >
                            <div className="overflow-menu-item" role="none">
                              <button
                                className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  handleShellToggle();
                                  setShowOverflowMenu(false);
                                }}
                                role="menuitemcheckbox"
                                aria-checked={shellEnabled}
                                aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                                data-overflow-menu-item
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M4 17l6-6-6-6M12 19h8" />
                                </svg>
                                <span>Shell</span>
                                <span
                                  className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                                  aria-hidden="true"
                                >
                                  <span className="goal-mode-switch-thumb" />
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setAutonomousModeSelection(!autonomousModeEnabled);
                                }}
                                data-tooltip="Runs without asking for approval"
                                role="menuitemcheckbox"
                                aria-checked={autonomousModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Autonomous</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      autonomousModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setClarifyingCheckinsEnabled(!clarifyingCheckinsEnabled);
                                }}
                                data-tooltip="Allow optional clarification pauses during this task"
                                role="menuitemcheckbox"
                                aria-checked={clarifyingCheckinsEnabled}
                                disabled={autonomousModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Check-ins</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      clarifyingCheckinsEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setCollaborativeModeSelection(!collaborativeModeEnabled);
                                }}
                                data-tooltip="Multiple agents share perspectives"
                                role="menuitemcheckbox"
                                aria-checked={collaborativeModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Collab</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      collaborativeModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            {availableProviders.filter((p) => p.configured).length >= 2 && (
                              <div className="overflow-menu-item" role="none">
                                <button
                                  className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                  style={{ margin: 0 }}
                                  onClick={() => {
                                    setOverflowSubmenu(null);
                                    setMultiLlmModeSelection(!multiLlmModeEnabled);
                                  }}
                                  data-tooltip="Sends task to multiple AI models"
                                  role="menuitemcheckbox"
                                  aria-checked={multiLlmModeEnabled}
                                  data-overflow-menu-item
                                >
                                  <span className="goal-mode-toggle-switch-content">
                                    <span className="goal-mode-toggle-text">
                                      <span className="goal-mode-label">Multi-LLM</span>
                                    </span>
                                    <span
                                      className={`goal-mode-switch-track ${
                                        multiLlmModeEnabled ? "on" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      <span className="goal-mode-switch-thumb" />
                                    </span>
                                  </span>
                                </button>
                              </div>
                            )}
                            {renderWelcomeExecutionModeRow()}
                            {renderWelcomeTaskDomainRow()}
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setVerificationAgentEnabled(!verificationAgentEnabled);
                                }}
                                data-tooltip="Double-checks results before finishing"
                                role="menuitemcheckbox"
                                aria-checked={verificationAgentEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-label">
                                  Verify {verificationAgentEnabled ? "ON" : "OFF"}
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setChronicleEnabledForTask(!chronicleEnabledForTask);
                                }}
                                data-tooltip="Allow Chronicle screen context for this task"
                                role="menuitemcheckbox"
                                aria-checked={chronicleEnabledForTask}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-label">
                                  Chronicle {chronicleEnabledForTask ? "ON" : "OFF"}
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                        {showOverflowMenu && renderWelcomeOverflowSubmenu()}
                      </div>
                      <ModelDropdown
                        models={availableModels}
                        selectedModel={selectedModel}
                        selectedProvider={selectedProvider}
                        selectedReasoningEffort={selectedReasoningEffort}
                        providers={availableProviders}
                        onModelChange={onModelChange}
                        onOpenSettings={onOpenSettings}
                      />
                    </>
                  )}
                </div>
                <div className="input-right-actions">
                  {uiDensity === "focused" ? (
                    <>
                      {(executionMode !== "execute" ||
                        collaborativeModeEnabled ||
                        clarifyingCheckinsEnabled) && (
                        <button
                          className="active-mode-badge"
                          title="Click to reset mode"
                          onClick={() => {
                            setExecutionMode("execute");
                            setCollaborativeModeEnabled(false);
                            setClarifyingCheckinsEnabled(false);
                          }}
                        >
                          {clarifyingCheckinsEnabled
                            ? "Check-ins"
                            : collaborativeModeEnabled
                              ? "Collab"
                              : EXECUTION_MODE_LABEL[executionMode]}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                      <ModelDropdown
                        models={availableModels}
                        selectedModel={selectedModel}
                        selectedProvider={selectedProvider}
                        selectedReasoningEffort={selectedReasoningEffort}
                        providers={availableProviders}
                        onModelChange={onModelChange}
                        onOpenSettings={onOpenSettings}
                        variant="label"
                        align="right"
                      />
                      <button
                        className={`voice-input-btn ${voiceInput.state}`}
                        onClick={voiceInput.toggleRecording}
                        disabled={voiceInput.state === "processing"}
                        title={
                          voiceInput.state === "idle"
                            ? "Start voice input"
                            : voiceInput.state === "recording"
                              ? "Stop recording"
                              : "Processing..."
                        }
                      >
                        {voiceInput.state === "processing" ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="voice-processing-spin"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                        ) : voiceInput.state === "recording" ? (
                          <Square
                            size={12}
                            fill="currentColor"
                            strokeWidth={0}
                            aria-hidden="true"
                          />
                        ) : (
                          <Mic size={16} aria-hidden="true" />
                        )}
                        {voiceInput.state === "recording" && (
                          <span
                            className="voice-recording-indicator"
                            style={{ width: `${voiceInput.audioLevel}%` }}
                          />
                        )}
                      </button>
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Skills Menu Button */}
                      <div className="skills-menu-container" ref={skillsMenuRef}>
                        <button
                          className={`skills-menu-btn ${showSkillsMenu ? "active" : ""}`}
                          onClick={() => setShowSkillsMenu(!showSkillsMenu)}
                          title="Skills"
                        >
                          <span>/</span>
                        </button>
                        {showSkillsMenu && (
                          <div className="skills-dropdown">
                            <div className="skills-dropdown-header">Custom Skills</div>
                            <div className="skills-dropdown-search">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <circle cx="11" cy="11" r="8" />
                                <path d="M21 21l-4.35-4.35" />
                              </svg>
                              <input
                                type="text"
                                placeholder="Search skills..."
                                value={skillsSearchQuery}
                                onChange={(e) => setSkillsSearchQuery(e.target.value)}
                                autoFocus
                              />
                            </div>
                            {customSkills.length > 0 ? (
                              filteredSkills.length > 0 ? (
                                <div className="skills-dropdown-list">
                                  {filteredSkills.map((skill) => (
                                    <div
                                      key={skill.id}
                                      className="skills-dropdown-item"
                                      style={{ cursor: "pointer" }}
                                      onClick={() => handleSkillSelect(skill)}
                                    >
                                      <span className="skills-dropdown-icon">{skill.icon}</span>
                                      <div className="skills-dropdown-info">
                                        <span className="skills-dropdown-name">{skill.name}</span>
                                        <span className="skills-dropdown-desc">
                                          {skill.description}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="skills-dropdown-empty">
                                  No skills match "{skillsSearchQuery}"
                                </div>
                              )
                            ) : (
                              <div className="skills-dropdown-empty">No custom skills yet.</div>
                            )}
                            <div className="skills-dropdown-footer">
                              <button
                                className="skills-dropdown-create"
                                onClick={() => {
                                  setShowSkillsMenu(false);
                                  setSkillsSearchQuery("");
                                  onOpenSettings?.("skills");
                                }}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <line x1="12" y1="5" x2="12" y2="19" />
                                  <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                <span>Create New Skill</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      <button
                        className={`voice-input-btn ${voiceInput.state}`}
                        onClick={voiceInput.toggleRecording}
                        disabled={voiceInput.state === "processing"}
                        title={
                          voiceInput.state === "idle"
                            ? "Start voice input"
                            : voiceInput.state === "recording"
                              ? "Stop recording"
                              : "Processing..."
                        }
                      >
                        {voiceInput.state === "processing" ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="voice-processing-spin"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                        ) : voiceInput.state === "recording" ? (
                          <Square
                            size={12}
                            fill="currentColor"
                            strokeWidth={0}
                            aria-hidden="true"
                          />
                        ) : (
                          <Mic size={16} aria-hidden="true" />
                        )}
                        {voiceInput.state === "recording" && (
                          <span
                            className="voice-recording-indicator"
                            style={{ width: `${voiceInput.audioLevel}%` }}
                          />
                        )}
                      </button>
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {multiLlmModeEnabled && (
                <MultiLlmSelectionPanel
                  availableProviders={availableProviders}
                  onConfigChange={setMultiLlmConfig}
                />
              )}
            </div>
            {uiDensity === "focused" && (
              <div className="input-status-text welcome-input-status">
                <div className="input-status-left">
                  <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                    <button
                      className="input-status-workspace"
                      onClick={handleWorkspaceDropdownToggle}
                      title={getWorkspaceStatusFolderLabel(workspace)}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      <span className="input-status-workspace-path">
                        {getWorkspaceStatusFolderLabel(workspace)}
                      </span>
                    </button>
                    {showWorkspaceDropdown && (
                      <div className="workspace-dropdown">
                        {workspacesList.length > 0 && (
                          <>
                            <div className="workspace-dropdown-header">Recent Folders</div>
                            <div className="workspace-dropdown-list">
                              {workspacesList.slice(0, 10).map((w) => (
                                <button
                                  key={w.id}
                                  className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                  onClick={() => handleWorkspaceSelect(w)}
                                >
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                  </svg>
                                  <div className="workspace-item-info">
                                    <span className="workspace-item-name">{w.name}</span>
                                    <span className="workspace-item-path">{w.path}</span>
                                  </div>
                                  {workspace?.id === w.id && (
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      className="check-icon"
                                    >
                                      <path d="M20 6L9 17l-5-5" />
                                    </svg>
                                  )}
                                </button>
                              ))}
                            </div>
                            <div className="workspace-dropdown-divider" />
                          </>
                        )}
                        <button
                          className="workspace-dropdown-item new-folder"
                          onClick={handleSelectNewFolder}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          <span>Work in another folder...</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    className={`input-status-shell ${shellEnabled ? "enabled" : ""}`}
                    onClick={handleShellToggle}
                    role="switch"
                    aria-checked={shellEnabled}
                    aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                    title={
                      shellEnabled
                        ? "Shell commands enabled - click to disable"
                        : "Shell commands disabled - click to enable"
                    }
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M4 17l6-6-6-6M12 19h8" />
                    </svg>
                    <span>Shell</span>
                    <span
                      className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                      aria-hidden="true"
                    >
                      <span className="goal-mode-switch-thumb" />
                    </span>
                  </button>
                </div>
                <div className="input-status-right">
                  <div className="input-status-mode-wrap" ref={modeDropdownRef}>
                    <button
                      type="button"
                      className="input-status-mode menu-tooltip-target"
                      onClick={() => {
                        setShowDomainDropdown(false);
                        setShowModeDropdown((v) => !v);
                      }}
                      data-tooltip={`Current mode: ${EXECUTION_MODE_LABEL[executionMode]} · ${EXECUTION_MODE_HINT[executionMode]}`}
                      aria-haspopup="listbox"
                      aria-expanded={showModeDropdown}
                    >
                      {(() => {
                        const Icon = EXECUTION_MODE_ICON[executionMode];
                        return <Icon size={12} aria-hidden />;
                      })()}
                      {EXECUTION_MODE_LABEL[executionMode]}
                    </button>
                    {showModeDropdown && (
                      <div
                        className="input-status-mode-dropdown"
                        role="listbox"
                        aria-label="Execution mode"
                      >
                        {EXECUTION_MODE_ORDER.map((value) => {
                          const Icon = EXECUTION_MODE_ICON[value];
                          return (
                            <button
                              key={value}
                              type="button"
                              className={`input-status-mode-option ${executionMode === value ? "active" : ""}`}
                              onClick={() => {
                                setExecutionMode(value);
                                setShowModeDropdown(false);
                              }}
                              role="option"
                              aria-selected={executionMode === value}
                            >
                              <Icon size={14} aria-hidden />
                              {EXECUTION_MODE_LABEL[value]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="input-status-domain-wrap" ref={domainDropdownRef}>
                    <button
                      type="button"
                      className="input-status-domain"
                      onClick={() => {
                        setShowModeDropdown(false);
                        setShowDomainDropdown((v) => !v);
                      }}
                      title={TASK_DOMAIN_HINT[taskDomain]}
                      aria-haspopup="listbox"
                      aria-expanded={showDomainDropdown}
                    >
                      {(() => {
                        const Icon = TASK_DOMAIN_ICON[taskDomain];
                        return <Icon size={12} aria-hidden />;
                      })()}
                      {TASK_DOMAIN_LABEL[taskDomain]}
                    </button>
                    {showDomainDropdown && (
                      <div
                        className="input-status-domain-dropdown"
                        role="listbox"
                        aria-label="Task domain"
                      >
                        {TASK_DOMAIN_ORDER.map((value) => {
                          const Icon = TASK_DOMAIN_ICON[value];
                          return (
                            <button
                              key={value}
                              type="button"
                              className={`input-status-domain-option ${taskDomain === value ? "active" : ""}`}
                              onClick={() => {
                                setTaskDomain(value);
                                setShowDomainDropdown(false);
                              }}
                              role="option"
                              aria-selected={taskDomain === value}
                            >
                              <Icon size={14} aria-hidden />
                              {TASK_DOMAIN_LABEL[value]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="skills-menu-container" ref={skillsMenuRef}>
                    <button
                      className={`input-status-skills ${showSkillsMenu ? "active" : ""}`}
                      onClick={() => setShowSkillsMenu(!showSkillsMenu)}
                      title="Skills"
                    >
                      <span>/</span>
                      <span>Skills</span>
                    </button>
                    {showSkillsMenu && (
                      <div className="skills-dropdown">
                        <div className="skills-dropdown-header">Custom Skills</div>
                        <div className="skills-dropdown-search">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="11" cy="11" r="8" />
                            <path d="M21 21l-4.35-4.35" />
                          </svg>
                          <input
                            type="text"
                            placeholder="Search skills..."
                            value={skillsSearchQuery}
                            onChange={(e) => setSkillsSearchQuery(e.target.value)}
                            autoFocus
                          />
                        </div>
                        {customSkills.length > 0 ? (
                          filteredSkills.length > 0 ? (
                            <div className="skills-dropdown-list">
                              {filteredSkills.map((skill) => (
                                <div
                                  key={skill.id}
                                  className="skills-dropdown-item"
                                  style={{ cursor: "pointer" }}
                                  onClick={() => handleSkillSelect(skill)}
                                >
                                  <span className="skills-dropdown-icon">{skill.icon}</span>
                                  <div className="skills-dropdown-info">
                                    <span className="skills-dropdown-name">{skill.name}</span>
                                    <span className="skills-dropdown-desc">
                                      {skill.description}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="skills-dropdown-empty">
                              No skills match "{skillsSearchQuery}"
                            </div>
                          )
                        ) : (
                          <div className="skills-dropdown-empty">No custom skills yet.</div>
                        )}
                        <div className="skills-dropdown-footer">
                          <button
                            className="skills-dropdown-create"
                            onClick={() => {
                              setShowSkillsMenu(false);
                              setSkillsSearchQuery("");
                              onOpenSettings?.("skills");
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            Create New Skill
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {renderWelcomeTaskSuggestions()}
          </div>
        </div>

        {/* Suggestion hint in focused mode */}
        {uiDensity === "focused" && !task && (
          <p className="welcome-hint">
            Try: &quot;Help me organize my project files&quot; or &quot;Write a summary report
            about...&quot;
          </p>
        )}

        {/* Modal for skills with parameters - Welcome View */}
        {selectedSkillForParams && (
          <SkillParameterModal
            skill={selectedSkillForParams.skill}
            onSubmit={handleSkillParamSubmit}
            onAskInChat={
              selectedSkillForParams.launchMode === "slash" ? handleSkillAskInChat : undefined
            }
            onCancel={handleSkillParamCancel}
          />
        )}

        {/* File Viewer Modal - Welcome View */}
        {viewerFilePath && workspace?.path && (
          <DocumentAwareFileModal
            filePath={viewerFilePath}
            workspacePath={workspace.path}
            onClose={() => setViewerFilePath(null)}
          />
        )}
      </div>
    );
  }

  const conversationFlow = (
    <TaskConversationFlow
      agentContext={agentContext}
      childEvents={childEvents}
      childTasks={childTasks}
      collaborativeRun={collaborativeRun}
      commandOutputSessionsByInsertIndex={commandOutputSessionsByInsertIndex}
      currentStep={currentStep}
      lastAssistantMessage={lastAssistantMessage}
      initialPromptEventId={initialPromptEventId}
      trimmedPrompt={trimmedPrompt}
      eventTitleMarkdownComponents={eventTitleMarkdownComponents}
      events={events}
      expandedActionBlocks={expandedActionBlocks}
      handleCanvasClose={handleCanvasClose}
      handleMessageFeedback={handleMessageFeedback}
      handleStepFeedback={handleStepFeedback}
      isChatTask={isChatTask}
      isTaskWorking={isTaskWorking}
      isReplayMode={isReplayMode}
      defaultTranscriptMode={defaultTranscriptMode}
      transcriptMode={transcriptMode}
      showFullTimeline={showFullTimeline}
      returnToDefaultTranscript={returnToDefaultTranscript}
      markdownComponents={markdownComponents}
      mainBodyRef={mainBodyRef}
      messageFeedbackMap={messageFeedbackMap}
      onOpenBrowserView={onOpenBrowserView}
      onOpenSpreadsheetArtifact={openSpreadsheetArtifact}
      onOpenDocumentArtifact={openDocumentArtifact}
      onOpenPresentationArtifact={openPresentationArtifact}
      onOpenWebArtifact={openWebArtifact}
      onQuoteAssistantMessage={handleQuoteAssistantMessage}
      onForkTaskSessionFromEvent={remoteSession ? undefined : handleForkTaskSessionFromEvent}
      onSelectChildTask={onSelectChildTask}
      onOpenChildAgentSidebar={onOpenChildAgentSidebar}
      onViewTaskOutputs={onViewTaskOutputs}
      parallelGroupsByAnchorEventId={parallelGroupsByAnchorEventId}
      rejectMenuOpenFor={rejectMenuOpenFor}
      rejectMenuRef={rejectMenuRef}
      renderCommandOutputs={renderCommandOutputs}
      setRejectMenuOpenFor={setRejectMenuOpenFor}
      setExpandedActionBlocks={setExpandedActionBlocks}
      setShowAllActionBlocks={setShowAllActionBlocks}
      setStepFeedbackOpen={setStepFeedbackOpen}
      setStepFeedbackText={setStepFeedbackText}
      setViewerFilePath={setViewerFilePath}
      formatTime={formatTime}
      shouldRenderTimelineEventInStepFeed={shouldRenderTimelineEventInStepFeed}
      shouldDefaultExpand={shouldDefaultExpand}
      toolCallPairing={toolCallPairing}
      hasEventDetails={hasEventDetails}
      isEventExpanded={isEventExpanded}
      showAllActionBlocks={showAllActionBlocks}
      stepFeedbackOpen={stepFeedbackOpen}
      stepFeedbackSending={stepFeedbackSending}
      stepFeedbackText={stepFeedbackText}
      suppressedParallelEventIds={suppressedParallelEventIds}
      task={task}
      timelineItems={timelineItems}
      timelineRef={timelineRef}
      toggledEvents={toggledEvents}
      toggleEventExpanded={toggleEventExpanded}
      verboseSteps={verboseSteps}
      voiceEnabled={voiceEnabled}
      rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      taskSwitchId={taskSwitchId}
      hasMoreTimelineHistory={hasMoreTimelineHistory}
      isLoadingTimelineHistory={isLoadingTimelineHistory}
      timelineHistoryError={timelineHistoryError}
      onLoadMoreTimelineHistory={onLoadMoreTimelineHistory}
      wrappingUp={wrappingUp}
      workspace={workspace}
    />
  );


  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        {(task?.parentTaskId || task?.branchFromTaskId) && onSelectTask && (
          <button
            type="button"
            className="main-header-parent-thread-btn"
            onClick={() => onSelectTask(task.parentTaskId || task.branchFromTaskId || null)}
            title="Back to parent thread"
            aria-label="Back to parent thread"
          >
            <MessageCircle size={14} strokeWidth={1.5} />
            <span>Parent thread</span>
          </button>
        )}
        <div className="main-header-title-group">
          {(showHeaderTitle || task) && headerTitle.trim().length > 0 && (
            <div className="main-header-title" title={headerTooltip}>
              {headerTitle}
            </div>
          )}
          {task && (
            <div className="main-header-task-menu-container" ref={taskHeaderMenuRef}>
              <button
                type="button"
                ref={taskHeaderMenuButtonRef}
                className={`main-header-task-menu-btn ${showTaskHeaderMenu ? "active" : ""}`}
                aria-haspopup="menu"
                aria-expanded={showTaskHeaderMenu}
                aria-controls="main-header-task-menu"
                aria-label="Task actions"
                title="Task actions"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowTaskHeaderMenu((open) => !open);
                }}
                onKeyDown={handleTaskHeaderMenuButtonKeyDown}
              >
                <Ellipsis size={18} strokeWidth={2.4} aria-hidden="true" />
              </button>
              {showTaskHeaderMenu && (
                <div
                  id="main-header-task-menu"
                  className="main-header-task-menu"
                  role="menu"
                  aria-label="Task actions"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={handleTaskHeaderMenuKeyDown}
                >
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession)}
                    onClick={handleTaskHeaderPin}
                  >
                    {task.pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}
                    <span>{task.pinned ? "Unpin task" : "Pin task"}</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession)}
                    onClick={handleTaskHeaderRename}
                  >
                    <Pencil size={17} aria-hidden="true" />
                    <span>Rename task</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession)}
                    onClick={handleTaskHeaderArchive}
                  >
                    <ArchiveIcon size={17} aria-hidden="true" />
                    <span>Archive task</span>
                  </button>
                  <div className="main-header-task-menu-divider" role="separator" />
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession) || !workspace?.path || !onOpenBrowserWorkbenchSidebar}
                    onClick={handleTaskHeaderOpenBrowser}
                  >
                    <Globe size={17} aria-hidden="true" />
                    <span>Open browser</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={!taskWorkingDirectory}
                    onClick={() => {
                      closeTaskHeaderMenu();
                      void copyTaskHeaderMenuText(taskWorkingDirectory);
                    }}
                  >
                    <Folder size={17} aria-hidden="true" />
                    <span>Copy working directory</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={!taskIdCopyValue}
                    onClick={() => {
                      closeTaskHeaderMenu();
                      void copyTaskHeaderMenuText(taskIdCopyValue);
                    }}
                  >
                    <Copy size={17} aria-hidden="true" />
                    <span>Copy task ID</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    onClick={() => {
                      closeTaskHeaderMenu();
                      void copyTaskHeaderMenuText(taskDeeplink);
                    }}
                  >
                    <LinkIcon size={17} aria-hidden="true" />
                    <span>Copy deeplink</span>
                  </button>
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    onClick={() => {
                      closeTaskHeaderMenu();
                      void copyTaskHeaderMenuText(taskMarkdown);
                    }}
                  >
                    <ClipboardCopy size={17} aria-hidden="true" />
                    <span>Copy as Markdown</span>
                  </button>
                  <div className="main-header-task-menu-divider" role="separator" />
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession)}
                    onClick={handleTaskHeaderFork}
                  >
                    <GitFork size={17} aria-hidden="true" />
                    <span>Fork session</span>
                  </button>
                  {onOpenSideChat && (
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      disabled={Boolean(remoteSession)}
                      onClick={handleTaskHeaderSideChat}
                    >
                      <MessageCircle size={17} aria-hidden="true" />
                      <span>Open side chat</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="main-header-task-menu-item"
                    role="menuitem"
                    data-task-header-menu-option
                    disabled={Boolean(remoteSession) || !workspace?.id}
                    onClick={handleTaskHeaderAddAutomation}
                  >
                    <Clock size={17} aria-hidden="true" />
                    <span>Create routine...</span>
                  </button>
                  {hasTaskOutputs(taskOutputSummary) && onViewTaskOutputs && (
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      onClick={() => {
                        closeTaskHeaderMenu();
                        onViewTaskOutputs(task.id, taskOutputSummary.primaryOutputPath);
                      }}
                    >
                      <FileText size={17} aria-hidden="true" />
                      <span>View outputs</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* Always anchor the initial user prompt above the timeline. */}
          {initialPromptBubble}
          {showLegalWorkflowCard && (
            legalWorkflowInvocation.kind === "demand-intake" ? (
              <LegalDemandIntakePromptCard
                prompt={trimmedPrompt}
                onSubmit={(message) => {
                  onSendMessage(message);
                  setDismissedLegalWorkflowTaskId(task.id);
                }}
                onDismiss={() => setDismissedLegalWorkflowTaskId(task.id)}
              />
            ) : (
              <GenericLegalWorkflowPromptCard
                invocation={legalWorkflowInvocation}
                onSubmit={(message) => {
                  onSendMessage(message);
                  setDismissedLegalWorkflowTaskId(task.id);
                }}
                onDismiss={() => setDismissedLegalWorkflowTaskId(task.id)}
              />
            )
          )}

          {task?.agentConfig?.executionMode === "debug" && (
            <DebugSessionPanel events={events} />
          )}

          {researchWorkflowEnabled && (
            <div
              className="research-mode-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 8,
                padding: "3px 10px",
                borderRadius: 12,
                fontSize: "0.72rem",
                fontWeight: 500,
                color: "var(--color-text-muted, #6b7280)",
                background: "var(--color-bg-elevated, #f4f3ff)",
                letterSpacing: "0.02em",
              }}
            >
              <span style={{ fontSize: "0.65rem" }}>&#9679;</span>
              Research mode
            </div>
          )}

          {/* Timeline controls - show right after original prompt */}
          {(hasNonConversationEvents || isTaskWorking || isTaskFinished) && (
            <div className="timeline-controls">
              <div className="timeline-controls-status">
                {canToggleCompletedTranscript ? (
                  <button
                    type="button"
                    className="timeline-controls-label timeline-controls-label-button with-duration"
                    onClick={toggleCompletedTranscriptMode}
                    aria-expanded={transcriptMode !== "delivery"}
                    title={
                      transcriptMode === "delivery"
                        ? "Show full timeline"
                        : "Show only final output"
                    }
                  >
                    <span>{workDurationLabel}</span>
                    <span className="timeline-controls-label-chevron" aria-hidden="true">
                      {transcriptMode === "delivery" ? ">" : "v"}
                    </span>
                  </button>
                ) : (
                  <span
                    className={`timeline-controls-label ${
                      isTaskWorking || isTaskFinished ? "with-duration" : ""
                    }`}
                  >
                    {workDurationLabel}
                  </span>
                )}
                {isTaskWorking && continuationStatusChip && (
                  <span className="header-continuation-chip" title="Adaptive continuation status">
                    <span>{continuationStatusChip.window}</span>
                    {continuationStatusChip.progress && (
                      <span className="header-continuation-chip-sep">·</span>
                    )}
                    {continuationStatusChip.progress && <span>{continuationStatusChip.progress}</span>}
                    {continuationStatusChip.loopRisk && (
                      <span className="header-continuation-chip-sep">·</span>
                    )}
                    {continuationStatusChip.loopRisk && <span>{continuationStatusChip.loopRisk}</span>}
                  </span>
                )}
              </div>
              <div className="timeline-controls-actions">
                <button
                  type="button"
                  className="verbose-switch"
                  role="switch"
                  aria-checked={verboseSteps}
                  aria-label={`Verbose mode ${verboseSteps ? "on" : "off"}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleVerboseSteps();
                  }}
                  title={`Verbose mode ${verboseSteps ? "on" : "off"} (click to toggle)`}
                >
                  <span className="goal-mode-toggle-switch-content">
                    <span className="goal-mode-toggle-text">
                      <span className="verbose-switch-label">Verbose</span>
                    </span>
                    <span
                      className={`goal-mode-switch-track ${verboseSteps ? "on" : ""}`}
                      aria-hidden="true"
                    >
                      <span className="goal-mode-switch-thumb" />
                    </span>
                  </span>
                </button>
                <button
                  className={`verbose-toggle-btn ${codePreviewsExpanded ? "active" : ""}`}
                  onClick={toggleCodePreviews}
                  title={
                    codePreviewsExpanded
                      ? "Collapse code previews by default"
                      : "Expand code previews by default"
                  }
                >
                  {codePreviewsExpanded ? "Code: Open" : "Code: Collapsed"}
                </button>
                {replayControls &&
                  !replayControls.isReplayMode &&
                  (task?.status === "completed" ||
                    task?.status === "failed" ||
                    task?.status === "cancelled") && (
                    <button
                      className="replay-entry-btn"
                      onClick={replayControls.startReplay}
                      title="Replay this session step by step"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Replay
                    </button>
                  )}
              </div>
            </div>
          )}

          {/* Replay controls bar — shown when replay mode is active */}
          {replayControls?.isReplayMode && (
            <ReplayControlsBar controls={replayControls} />
          )}

          {conversationFlow}
          <TaskSessionLineageFooter task={task} onSelectTask={onSelectTask} />
        </div>
      </div>

      {/* Footer with Input */}
      <div className="main-footer">
        {/* Scroll to bottom button — only when there is actually content above the fold */}
        {!autoScroll && task && mainBodyRef.current && (mainBodyRef.current.scrollHeight - mainBodyRef.current.scrollTop - mainBodyRef.current.clientHeight > 20) && (
          <button
            className="scroll-to-bottom-btn"
            onClick={() => {
              if (mainBodyRef.current) {
                mainBodyRef.current.scrollTo({
                  top: mainBodyRef.current.scrollHeight,
                  behavior: "smooth",
                });
                setAutoScroll(true);
              }
            }}
            title="Scroll to bottom"
          >
            ↓
          </button>
        )}
        {renderAttachmentPanel()}
        <div
          className={`input-container ${isDraggingFiles ? "drag-over" : ""} ${collaborativeRun && (onOpenChildAgentSidebar || onSelectChildTask) ? "input-container-with-agents" : ""}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Collaborative agent lines — extension of input box, inside same container */}
          {collaborativeRun && (onOpenChildAgentSidebar || onSelectChildTask) && (
            <CollaborativeAgentLines
              collaborativeRun={collaborativeRun}
              childTasks={childTasks}
              childEvents={childEvents}
              onOpenAgent={(taskId) =>
                (onOpenChildAgentSidebar ?? onSelectChildTask)?.(taskId)
              }
              mainTaskCompleted={
                !!task &&
                ["completed", "failed", "cancelled"].includes(task.status)
              }
              onWrapUp={
                onWrapUpTask
                  ? () => {
                      if (!wrappingUp) {
                        setWrappingUp(true);
                        onWrapUpTask();
                      }
                    }
                  : undefined
              }
              isWrappingUp={wrappingUp}
            />
          )}
          {routineCreationNotice?.taskId === task.id && (
            <div className="task-automation-created-response" role="status">
              <div>
                <strong>Routine created</strong>
                <span>
                  {routineCreationNotice.name} is saved with {routineCreationNotice.triggerSummary}.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onOpenSettings?.("scheduled")}
              >
                View
              </button>
            </div>
          )}
          {hasActiveStructuredInputRequest && inputRequest && onSubmitInputRequest && onDismissInputRequest && (
            <StructuredInputPromptCard
              request={inputRequest}
              onSubmit={(answers) => onSubmitInputRequest(inputRequest.id, answers)}
              onDismiss={() => onDismissInputRequest(inputRequest.id)}
            />
          )}
          {showVoiceNotConfigured && (
            <div className="voice-not-configured-banner">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              <span>Voice input is not configured.</span>
              <button
                className="voice-settings-link"
                onClick={() => {
                  setShowVoiceNotConfigured(false);
                  onOpenSettings?.("voice");
                }}
              >
                Open Voice Settings
              </button>
              <button
                className="voice-banner-close"
                onClick={() => setShowVoiceNotConfigured(false)}
                title="Dismiss"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          {remoteSession && (
            <div className="task-status-banner task-status-banner-remote">
              <div className="task-status-banner-content">
                <strong>Remote session view</strong>
                <span className="task-status-banner-detail">
                  You are inspecting the live task history from {remoteSession.deviceName}, not the current device.
                </span>
              </div>
            </div>
          )}
          {task.status === "paused" && !hasActiveStructuredInputRequest && (
            <TaskPauseBanner
              message={effectivePauseMessage}
              reasonCode={effectivePauseReasonCode}
              markdownComponents={markdownComponents}
              onStopTask={onWrapUpTask ?? onStopTask}
              onEnableShell={remoteSession ? undefined : onEnableShellForPausedTask}
              onContinueWithoutShell={remoteSession ? undefined : onContinueWithoutShellForPausedTask}
            />
          )}
          {task.status === "blocked" && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>
                  {task.terminalStatus === "awaiting_approval"
                    ? "Blocked - needs approval"
                    : "Blocked - waiting on you"}
                </strong>
                {latestApprovalEvent?.payload?.approval?.description && task.terminalStatus === "awaiting_approval" && (
                  <span className="task-status-banner-detail">
                    {latestApprovalEvent.payload.approval.description}
                  </span>
                )}
              </div>
            </div>
          )}
          {task.status === "interrupted" && task.terminalStatus === "resume_available" && (
            <div className="task-status-banner task-status-banner-paused">
              <div className="task-status-banner-content">
                <strong>Resume available</strong>
                <span className="task-status-banner-detail">
                  The task stopped before finishing, but its progress and outputs were preserved.
                </span>
              </div>
            </div>
          )}
          {task.status === "completed" &&
            task.terminalStatus === "needs_user_action" &&
            showPersistentNeedsUserActionBanner && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>Completed - action required</strong>
                <span className="task-status-banner-detail">
                  {typeof latestCompletionEvent?.payload?.verificationMessage === "string" &&
                  latestCompletionEvent.payload.verificationMessage.trim().length > 0
                    ? latestCompletionEvent.payload.verificationMessage
                    : "Verification is pending user evidence before this can be fully marked done."}
                </span>
              </div>
            </div>
          )}
          {quotedAssistantMessage && (
            <div className="composer-quoted-assistant">
              <div className="composer-quoted-assistant-copy">
                <span className="composer-quoted-assistant-icon">↪</span>
                <span className="composer-quoted-assistant-text">
                  {summarizeQuotedAssistantMessage(quotedAssistantMessage.message, 420)}
                </span>
              </div>
              <button
                type="button"
                className="composer-quoted-assistant-clear"
                onClick={() => setQuotedAssistantMessage(null)}
                title="Remove quoted message"
                aria-label="Remove quoted message"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className="input-row">
            <button
              className="attachment-btn attachment-btn-left"
              onClick={handleAttachFiles}
              disabled={isUploadingAttachments}
              title="Attach files"
              aria-label="Attach files"
            >
              <Plus size={24} aria-hidden="true" />
            </button>
            {uiDensity === "focused" && (
              <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                  {showWorkspaceDropdown && (
                    <div className="workspace-dropdown">
                      {workspacesList.length > 0 && (
                        <>
                          <div className="workspace-dropdown-header">Recent Folders</div>
                          <div className="workspace-dropdown-list">
                            {workspacesList.slice(0, 10).map((w) => (
                              <button
                                key={w.id}
                                className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                onClick={() => handleWorkspaceSelect(w)}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                </svg>
                                <div className="workspace-item-info">
                                  <span className="workspace-item-name">{w.name}</span>
                                  <span className="workspace-item-path">{w.path}</span>
                                </div>
                                {workspace?.id === w.id && (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="check-icon"
                                  >
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="workspace-dropdown-divider" />
                        </>
                      )}
                      <button className="workspace-dropdown-item new-folder" onClick={handleSelectNewFolder}>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Work in another folder...</span>
                      </button>
                    </div>
                  )}
                </div>
            )}
            <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
              <PromptComposerInput
                ref={promptInputRef}
                className="input-field input-textarea"
                placeholder={agentContext.getMessage("placeholderActive")}
                value={inputValue}
                mentions={integrationMentionSpans}
                ariaLabel="Message"
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onCursorChange={handleInputCursorChange}
              />
              {renderMentionDropdown()}
              {renderSlashDropdown()}
            </div>
            <div className="input-actions">
              {uiDensity === "focused" && (
                <ModelDropdown
                  models={availableModels}
                  selectedModel={selectedModel}
                  selectedProvider={selectedProvider}
                  selectedReasoningEffort={selectedReasoningEffort}
                  providers={availableProviders}
                  onModelChange={onModelChange}
                  onOpenSettings={onOpenSettings}
                  variant="label"
                  align="right"
                />
              )}
              <button
                className={`voice-input-btn ${voiceInput.state}`}
                onClick={voiceInput.toggleRecording}
                disabled={voiceInput.state === "processing" || talkMode.isActive}
                title={
                  talkMode.isActive
                    ? "Talk Mode active"
                    : voiceInput.state === "idle"
                      ? "Start voice input"
                      : voiceInput.state === "recording"
                        ? "Stop recording"
                        : "Processing..."
                }
              >
                {voiceInput.state === "processing" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="voice-processing-spin"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                ) : voiceInput.state === "recording" ? (
                  <Square
                    size={12}
                    fill="currentColor"
                    strokeWidth={0}
                    aria-hidden="true"
                  />
                ) : (
                  <Mic size={16} aria-hidden="true" />
                )}
                {voiceInput.state === "recording" && (
                  <span
                    className="voice-recording-indicator"
                    style={{ width: `${voiceInput.audioLevel}%` }}
                  />
                )}
              </button>
              {isTaskWorking && onStopTask ? (
                <div className="task-control-buttons">
                  <button className="stop-btn-simple" onClick={onStopTask} title="Stop task">
                    <Square size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  className="lets-go-btn lets-go-btn-sm"
                  onClick={handleSend}
                  disabled={
                    (!inputValue.trim() && pendingAttachments.length === 0) ||
                    isUploadingAttachments ||
                    isPreparingMessage
                  }
                  title="Send message"
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <div className="input-below-actions">
            {uiDensity !== "focused" && (
              <>
                <ModelDropdown
                  models={availableModels}
                  selectedModel={selectedModel}
                  selectedProvider={selectedProvider}
                  selectedReasoningEffort={selectedReasoningEffort}
                  providers={availableProviders}
                  onModelChange={onModelChange}
                  onOpenSettings={onOpenSettings}
                />
                <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                  <button
                    className="folder-selector"
                    onClick={handleWorkspaceDropdownToggle}
                    title={workspace?.path || "Select a workspace folder"}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>
                      {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                        ? "Work in a folder"
                        : workspace?.name || "Work in a folder"}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={showWorkspaceDropdown ? "chevron-up" : ""}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {showWorkspaceDropdown && (
                    <div className="workspace-dropdown">
                      {workspacesList.length > 0 && (
                        <>
                          <div className="workspace-dropdown-header">Recent Folders</div>
                          <div className="workspace-dropdown-list">
                            {workspacesList.slice(0, 10).map((w) => (
                              <button
                                key={w.id}
                                className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                onClick={() => handleWorkspaceSelect(w)}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                <div className="workspace-item-info">
                                  <span className="workspace-item-name">{w.name}</span>
                                  <span className="workspace-item-path">{w.path}</span>
                                </div>
                                {workspace?.id === w.id && (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="check-icon"
                                  >
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="workspace-dropdown-divider" />
                        </>
                      )}
                      <button
                        className="workspace-dropdown-item new-folder"
                        onClick={handleSelectNewFolder}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Work in another folder...</span>
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                  onClick={handleShellToggle}
                  role="switch"
                  aria-checked={shellEnabled}
                  aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                  title={
                    shellEnabled
                      ? "Shell commands enabled - click to disable"
                      : "Shell commands disabled - click to enable"
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 17l6-6-6-6M12 19h8" />
                  </svg>
                  <span>Shell</span>
                  <span
                    className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                    aria-hidden="true"
                  >
                    <span className="goal-mode-switch-thumb" />
                  </span>
                </button>
              </>
            )}
            <span className="keyboard-hint">
              {isPreparingMessage ? (
                <span>Preparing your message...</span>
              ) : (
                <span>
                  <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for new line
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="input-status-text">
          <div className="input-status-left">
            <button
              className="input-status-workspace"
              onClick={handleWorkspaceDropdownToggle}
              title={getWorkspaceStatusFolderLabel(workspace)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span className="input-status-workspace-path">
                {getWorkspaceStatusFolderLabel(workspace)}
              </span>
            </button>
            <button
              className={`input-status-shell ${shellEnabled ? "enabled" : ""}`}
              onClick={handleShellToggle}
              role="switch"
              aria-checked={shellEnabled}
              aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
              title={
                shellEnabled
                  ? "Shell commands enabled - click to disable"
                  : "Shell commands disabled - click to enable"
              }
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 17l6-6-6-6M12 19h8" />
              </svg>
              <span>Shell</span>
              <span
                className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                aria-hidden="true"
              >
                <span className="goal-mode-switch-thumb" />
              </span>
            </button>
          </div>
          <div className="input-status-right">
            <div className="input-status-mode-wrap" ref={modeDropdownRef}>
              <button
                type="button"
                className="input-status-mode menu-tooltip-target"
                onClick={() => {
                  setShowDomainDropdown(false);
                  setShowModeDropdown((v) => !v);
                }}
                data-tooltip={`Current mode: ${EXECUTION_MODE_LABEL[executionMode]} · ${EXECUTION_MODE_HINT[executionMode]}`}
                aria-haspopup="listbox"
                aria-expanded={showModeDropdown}
              >
                {(() => {
                  const Icon = EXECUTION_MODE_ICON[executionMode];
                  return <Icon size={12} aria-hidden />;
                })()}
                {EXECUTION_MODE_LABEL[executionMode]}
              </button>
              {showModeDropdown && (
                <div
                  className="input-status-mode-dropdown"
                  role="listbox"
                  aria-label="Execution mode"
                >
                  {EXECUTION_MODE_ORDER.map((value) => {
                    const Icon = EXECUTION_MODE_ICON[value];
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`input-status-mode-option ${executionMode === value ? "active" : ""}`}
                        onClick={() => {
                          setExecutionMode(value);
                          setShowModeDropdown(false);
                        }}
                        role="option"
                        aria-selected={executionMode === value}
                      >
                        <Icon size={14} aria-hidden />
                        {EXECUTION_MODE_LABEL[value]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="input-status-domain-wrap" ref={domainDropdownRef}>
              <button
                type="button"
                className="input-status-domain"
                onClick={() => {
                  setShowModeDropdown(false);
                  setShowDomainDropdown((v) => !v);
                }}
                title={TASK_DOMAIN_HINT[taskDomain]}
                aria-haspopup="listbox"
                aria-expanded={showDomainDropdown}
              >
                {(() => {
                  const Icon = TASK_DOMAIN_ICON[taskDomain];
                  return <Icon size={12} aria-hidden />;
                })()}
                {TASK_DOMAIN_LABEL[taskDomain]}
              </button>
              {showDomainDropdown && (
                <div
                  className="input-status-domain-dropdown"
                  role="listbox"
                  aria-label="Task domain"
                >
                  {TASK_DOMAIN_ORDER.map((value) => {
                    const Icon = TASK_DOMAIN_ICON[value];
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`input-status-domain-option ${taskDomain === value ? "active" : ""}`}
                        onClick={() => {
                          setTaskDomain(value);
                          setShowDomainDropdown(false);
                        }}
                        role="option"
                        aria-selected={taskDomain === value}
                      >
                        <Icon size={14} aria-hidden />
                        {TASK_DOMAIN_LABEL[value]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="footer-disclaimer">{agentContext.getMessage("disclaimer")}</div>
      </div>

      {showTaskAutomationModal && task && (
        <TaskAutomationModal
          task={task}
          workspace={workspace}
          defaultName={headerTitle.trim() || task.title}
          defaultPrompt={taskAutomationDefaultPrompt}
          deeplink={taskDeeplink}
          onClose={() => setShowTaskAutomationModal(false)}
          onCreated={async (routine) => {
            await onTasksChanged?.();
            const triggers = Array.isArray(routine?.triggers) ? routine.triggers : [];
            const triggerSummary =
              triggers.some((trigger: Any) => trigger?.type === "schedule")
                ? "scheduled and manual triggers"
                : "manual trigger";
            if (task) {
              setRoutineCreationNotice({
                taskId: task.id,
                routineId: String(routine.id || ""),
                name: String(routine.name || "Routine"),
                triggerSummary,
              });
            }
          }}
        />
      )}

      {selectedSkillForParams && (
        <SkillParameterModal
          skill={selectedSkillForParams.skill}
          onSubmit={handleSkillParamSubmit}
          onAskInChat={
            selectedSkillForParams.launchMode === "slash" ? handleSkillAskInChat : undefined
          }
          onCancel={handleSkillParamCancel}
        />
      )}

      {/* File Viewer Modal - Task View */}
      {viewerFilePath && workspace?.path && (
        <DocumentAwareFileModal
          filePath={viewerFilePath}
          workspacePath={workspace.path}
          onClose={() => setViewerFilePath(null)}
        />
      )}
    </div>
  );
}

function getMainContentTaskSignature(task: Task | undefined): string {
  if (!task) return "none";
  return [
    task.id,
    task.title,
    task.status,
    task.terminalStatus ?? "",
    task.updatedAt,
    task.completedAt ?? "",
    task.pinned ? "pinned" : "unpinned",
    task.sessionId ?? "",
    task.branchFromTaskId ?? "",
    task.branchFromEventId ?? "",
    task.branchLabel ?? "",
    task.worktreePath ?? "",
    task.prompt,
    task.userPrompt ?? "",
    task.rawPrompt ?? "",
  ].join(":");
}

function getMainContentInputRequestSignature(inputRequest: InputRequest | null | undefined): string {
  if (!inputRequest) return "none";
  return [
    inputRequest.id,
    inputRequest.taskId,
    inputRequest.status,
    inputRequest.requestedAt,
    inputRequest.questions.length,
  ].join(":");
}

function getMainContentInputRequestsSignature(inputRequests: InputRequest[] | undefined): string {
  if (!inputRequests?.length) return "none";
  return inputRequests
    .map((request) =>
      [
        request.id,
        request.taskId,
        request.status,
        request.requestedAt,
        request.questions.length,
      ].join(":"),
    )
    .join("|");
}

function getRemoteSessionSignature(
  remoteSession: { deviceId: string; deviceName: string } | null | undefined,
): string {
  if (!remoteSession) return "none";
  return `${remoteSession.deviceId}:${remoteSession.deviceName}`;
}

function areMainContentPropsEqual(prev: MainContentProps, next: MainContentProps): boolean {
  return (
    getMainContentTaskSignature(prev.task) === getMainContentTaskSignature(next.task) &&
    prev.selectedTaskId === next.selectedTaskId &&
    prev.workspace?.path === next.workspace?.path &&
    prev.events === next.events &&
    prev.sharedTaskEventUi === next.sharedTaskEventUi &&
    prev.childTasks === next.childTasks &&
    prev.childEvents === next.childEvents &&
    getMainContentInputRequestSignature(prev.inputRequest) ===
      getMainContentInputRequestSignature(next.inputRequest) &&
    getMainContentInputRequestsSignature(prev.pendingInputRequests) ===
      getMainContentInputRequestsSignature(next.pendingInputRequests) &&
    prev.selectedModel === next.selectedModel &&
    prev.selectedProvider === next.selectedProvider &&
    prev.selectedReasoningEffort === next.selectedReasoningEffort &&
    prev.availableModels === next.availableModels &&
    prev.availableProviders === next.availableProviders &&
    prev.uiDensity === next.uiDensity &&
    prev.homeResearchVaultEnabled === next.homeResearchVaultEnabled &&
    prev.homeNextActionsEnabled === next.homeNextActionsEnabled &&
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.taskSwitchId === next.taskSwitchId &&
    prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
    prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
    prev.timelineHistoryError === next.timelineHistoryError &&
    prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
    prev.onLoadTaskEventDetail === next.onLoadTaskEventDetail &&
    getRemoteSessionSignature(prev.remoteSession) === getRemoteSessionSignature(next.remoteSession) &&
    prev.replayControls === next.replayControls &&
    prev.onOpenSpreadsheetArtifact === next.onOpenSpreadsheetArtifact &&
    prev.onOpenDocumentArtifact === next.onOpenDocumentArtifact &&
    prev.onOpenPresentationArtifact === next.onOpenPresentationArtifact &&
    prev.onOpenWebArtifact === next.onOpenWebArtifact &&
    prev.onOpenBrowserWorkbenchSidebar === next.onOpenBrowserWorkbenchSidebar &&
    prev.onOpenWebLinkInSidebar === next.onOpenWebLinkInSidebar &&
    prev.onOpenSideChat === next.onOpenSideChat &&
    prev.onOpenChildAgentSidebar === next.onOpenChildAgentSidebar
  );
}

export const MainContent = memo(MainContentComponent, areMainContentPropsEqual);
