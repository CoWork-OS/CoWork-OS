import { TaskComputerPanel } from "../TaskComputerPanel";
import {
  Archive as ArchiveIcon,
  ArrowUp,
  Check as CheckIcon,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Clock,
  Code,
  Copy,
  Ellipsis,
  FileText,
  Folder,
  GitFork,
  Globe,
  History,
  Link as LinkIcon,
  ListTree,
  MessageCircle,
  Mic,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentRoleData,
  LlmWikiVaultEntry,
  LlmWikiVaultSummary,
} from "../../../electron/preload";
import {
  BUILTIN_ACCESS_PROFILES,
  BUILTIN_ACCESS_PROFILE_IDS,
  getAccessProfileLabel,
  getLegacyPermissionModeForAccessProfile,
  hasAccessProfileScope,
  isFullAccessProfile,
  resolveAccessProfileDefinition,
  type AccessProfileDefinition,
  type AccessProfileId,
} from "../../../shared/access-profiles";
import { resolveBotMascot } from "../../../shared/bot-mascots";
import { isCliAgentChildTask } from "../../../shared/cli-agent-detection";
import type { ComposerDraft, DraftAttachmentRef } from "../../../shared/composer-drafts";
import { createComposerSubmissionAcceptance } from "../../utils/composer-submission-acceptance";
import { predictionRevision } from "../../../shared/composer-predictions";
import {
  buildPersistentGoalAgentConfig,
  buildPersistentGoalPrompt,
  parseLeadingGoalSlashCommand,
} from "../../../shared/goal-slash-command";
import {
  getInteractionModeSelection,
  isChatActionShortcut,
  type InteractionModeSelection,
} from "../../../shared/interaction-mode";
import { parseLeadingMessageAppShortcut } from "../../../shared/message-shortcuts";
import {
  detectModeSuggestions,
  type ModeSuggestion,
} from "../../../shared/mode-suggestion-detection";
import { parseOnboardingSlashCommand } from "../../../shared/onboarding";
import { parseLeadingSkillSlashCommand } from "../../../shared/skill-slash-commands";
import {
  LLM_WIKI_AUDIT_GUI_PROMPT,
  LLM_WIKI_BRIEF_GUI_PROMPT,
  LLM_WIKI_EXPLORE_GUI_PROMPT,
  LLM_WIKI_GUI_PROMPT,
  LLM_WIKI_QUERY_GUI_PROMPT,
} from "../../../shared/starter-missions";
import { buildCodeBlockRunMessage } from "../../../shared/terminal-output-text";
import { terminalTabLabel } from "../../../shared/terminal-tab-links";
import {
  AgentConfig,
  AgentTeamRun,
  AppNotification,
  CanvasSession,
  CustomSkill,
  ExecutionMode,
  ImageAttachment,
  InputRequest,
  IntegrationMentionOption,
  IntegrationMentionSelection,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
  PermissionMode,
  ProactiveSuggestion,
  QuotedAssistantMessage,
  StepFeedbackAction,
  Task,
  TaskDomain,
  TaskEvent,
  UserProfile,
  Workspace,
  isTempWorkspaceId,
  type MessageSurfaceOrigin,
  type TerminalBlockRunResult,
} from "../../../shared/types";
import { parseUserMessageAttachmentMetadata } from "../../../shared/user-message-attachments";
import { useAgentContext } from "../../hooks/useAgentContext";
import { useComposerPrediction } from "../../hooks/useComposerPredictions";
import { useIsCalmTheme } from "../../hooks/useIsCalmTheme";
import { usePositionUpdates } from "../../hooks/usePositionUpdates";
import type { ReplayControls } from "../../hooks/useReplayMode";
import { formatDuration, useTaskDuration } from "../../hooks/useTaskDuration";
import { resolveInitialTaskTurnTiming } from "../../utils/task-turn-timing";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useVoiceTalkMode } from "../../hooks/useVoiceTalkMode";
import {
  getHostCapabilityReason,
  hasHostMethod,
  hasHostMethods,
} from "../../host/browser-capabilities";
import {
  buildAgentLifecycleRows,
  withoutCoveredAgentLifecycleEvents,
} from "../../utils/agent-lifecycle-rows";
import { formatAgentMessageProtocolForDisplay } from "../../utils/agent-message-receipt";
import {
  BOT_CONVERSATION_HISTORY_OPEN_EVENT,
  getConversationActionLabels,
  shouldShowCancelledTaskBanner,
} from "../../utils/bot-conversations";
import {
  OPEN_TERMINAL_TAB_EVENT,
  type CodeBlockRunTarget,
  type OpenTerminalTabRequest,
} from "../../utils/code-block-runs";
import {
  clearAcceptedComposerDraft,
  clearAcceptedComposerDraftFence,
  isSameAcceptedComposerDraftFence,
  isSameComposerDraftSubmission,
  isTaskCreationAccepted,
} from "../../utils/composer-draft-fencing";
import { areIntegrationMentionOptionsEqual } from "../../utils/integration-mention-options";
import { parseLegalWorkflowSlashPrompt } from "../../utils/legal-demand-intake";
import { deriveLivePlan } from "../../utils/live-plan";
import {
  MESSAGE_SHORTCUTS_UPDATED_EVENT,
  applySlashCommandSelection,
  buildMessageSlashOptions,
  resolveSlashSelectedIndex,
  type PluginSlashCommandAlias,
  type SlashCommandOption,
} from "../../utils/message-slash-options";
import {
  incrementRendererPerfCounter,
  markRendererStartup,
  measureRendererPerf,
  recordRendererRender,
} from "../../utils/renderer-perf";
import { shouldShowPersistentNeedsUserActionBanner } from "../../utils/task-completion-ux";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import {
  deriveSharedTaskEventUiState,
  reconcileBotConversationSharedTaskEventUi,
  type BaseTimelineItem,
  type CommandOutputSession,
  type SharedTaskEventUiState,
} from "../../utils/task-event-derived";
import {
  filterAdjacentDuplicateTimelineFailures,
  filterBotConversationTranscriptEvents,
  filterResolvedApprovalNarration,
  filterVerboseTimelineNoise,
  isDuplicateContextSummaryEvent,
  isRedundantStageTransitionGroupEvent,
  isResolvedContextCompactionStartEvent,
  shouldShowTaskEventInStepFeed,
  shouldShowTaskEventInSummaryMode,
} from "../../utils/task-event-visibility";
import { hasTaskOutputs, resolveTaskOutputSummaryFromTask } from "../../utils/task-outputs";
import { isTaskActivelyWorking } from "../../utils/task-working-state";
import { normalizeEventsForTimelineUi } from "../../utils/timeline-projection";
import { useTitleBarContextSlot } from "../../utils/title-bar-slot";
import { AssistantMessageContent } from "../AssistantMessageContent";
import { BotGlyph } from "../BotGlyph";
import {
  BOT_PROFILE_DELETED_EVENT,
  BOT_PROFILE_UPDATED_EVENT,
  BotProfileDialog,
} from "../BotProfileDialog";

import { useFullAccessConfirmation } from "../FullAccessConfirmationDialog";

import { TaskPauseBanner } from "../TaskPauseBanner";
import { QueuedMessagesPanel } from "../QueuedMessagesPanel";
import { SessionProgressCard } from "../SessionProgressCard";

import { Suspense } from "react";
import type { SurfaceActionOrigin } from "../../../shared/answer-surfaces/actions";
import type { BotConversationProjection } from "../../../shared/bot-lifecycle";
import { BotGreetingTracker, toBotMessage } from "../../../shared/bot-messages";
import { isPactAuthorizationInputRequest } from "../../../shared/pact";
import { useHomeTodaySignals } from "../../hooks/useHomeTodaySignals";
import { useTaskDisclosureIntents } from "../../hooks/useTaskDisclosureIntents";
import type { TaskSurfaceKey } from "../../state/task-view-cache";
import {
  COMMAND_OUTPUT_STYLE_CHANGED_EVENT,
  isCommandOutputStyle,
  readCommandOutputStyle,
} from "../../utils/command-output-style";
import { resolveDisclosureExpanded } from "../../utils/disclosure-state";
import { replaceEmojisInChildren } from "../../utils/emoji-replacer";
import { EMPTY_HOME_SESSIONS, type HomeSessions } from "../../utils/home-sessions";
import {
  EMPTY_HOME_TODAY,
  buildHomeToday,
  formatHomeDate,
  homeGreeting,
  homeStatusLine,
} from "../../utils/home-today";
import {
  forgetRememberedAccessProfileId,
  getAccessProfileIdForPermissionMode,
  readRememberedAccessProfileId,
  rememberAccessProfileId,
  resolveNewTaskAccessProfileId,
} from "../../utils/new-task-access-profile";
import {
  getSidePanelViewerKind,
  openPreviewableFileInSidebar,
} from "../../utils/open-file-in-panel";
import { preloadableLazy } from "../../utils/preloadable-lazy";
import { getStepCompletionPreviewPath } from "../../utils/step-document-preview";
import { SurfaceActionProvider } from "../AnswerSurface/SurfaceActions";
import { ModelGalleryHost } from "../Model3D/ModelGalleryHost";
import { AttachmentTile } from "../AttachmentTile";
import { BotCollaborationHeader } from "../BotCollaborationHeader";
import { BotConversationHistory } from "../BotConversationHistory";
import { CommandOutput } from "../CommandOutput";
import { DocumentAwareFileModal } from "../DocumentAwareFileModal";
import { IntegrationMentionIcon } from "../IntegrationMentionIcon";
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
  type IconProps,
} from "../LineIcons";
import {
  PromptComposerInput,
  type IntegrationMentionSpan,
  type PromptComposerInputHandle,
} from "../PromptComposerInput";
import { SubAgentsStripButton, TaskStatusStrip } from "../TaskStatusStrip";
import { ThemeIcon } from "../ThemeIcon";
import { BotMascot } from "../bot-mascot/BotMascot";
import { mascotExpressionForBotConversation } from "../bot-mascot/mascot-expressions";

import {
  BuildChangesButton,
  BuildPreviewButton,
  BuildStripBadge,
  pickBuildPreviewPath,
} from "../calm/BuildTaskBar";
import { CalmHomeToday } from "../calm/CalmHomeToday";
import { CalmModeToggle } from "../calm/CalmModeToggle";
import { CalmAccessMenu, type CalmAccessMenuProps } from "../calm/CalmTopBar";
import { deriveBuildChanges, normalizeBuildPath } from "../calm/build-changes";
import { isBuildTask } from "../calm/build-task";
import { buildMarkdownComponents } from "../markdown-components";
import {
  buildSlashSkillPrompt,
  expandSkillPrompt,
  type SkillParameterFormValues,
} from "../skill-parameter-utils";
import { isFileEventCoveredByToolCall } from "../timeline/file-change-row";
import {
  buildParallelGroupProjection,
  getEventGroupId,
  isToolsParallelGroupId,
} from "../timeline/parallel-group-projection";
import { OPEN_USE_CASES_EVENT } from "../use-cases-events";
import { BotEarlierConversations } from "./BotEarlierConversations";
import { fitComposerMenuWidth } from "./composer-menu-fit";
import { BrowserProfileNotice } from "./BrowserProfileNotice";
import { InteractionModePicker } from "./InteractionModePicker";
import { ModelDropdown } from "./ModelDropdown";

import { SelectionReplyPopover } from "./SelectionReplyPopover";

import { WorkspaceDropdownMenu } from "./WorkspaceDropdownMenu";
import { getAccessProfilePresentation } from "./access-profile-presentation";
import { getInlinePreviewKindForTaskEvent } from "./artifact-logic";
import {
  composeMessageWithAttachments,
  createPendingAttachmentOwnerFence,
  guessVisualAttachmentMimeType,
  isVideoVisualAttachmentMimeType,
  joinWorkspaceRelativePath,
  reconcileResolvedDraftAttachments,
  type ImportedAttachment,
  type PendingAttachment,
} from "./attachments";
import { buildBotMascotLookup } from "./bot-earlier-conversations";
import {
  CARDS_TO_SHOW,
  FOCUSED_CARD_POOL,
  TASK_DOMAIN_HINT,
  TASK_DOMAIN_ICON,
  TASK_DOMAIN_LABEL,
  TASK_DOMAIN_ORDER,
  pickFocusedCards,
} from "./focused-cards";

import {
  CODE_PREVIEWS_EXPANDED_KEY,
  MAX_ATTACHMENTS,
  PermissionAccessMode,
} from "./main-content-constants";
import type { CreateTaskOptions, FocusedCard, SettingsTab } from "./main-content-types";
import "./main-content.css";
import { extractDomainFromUrl, stripHtmlTags } from "./markdown-normalization";
import {
  CollapsibleUserBubble,
  MessageCopyButton,
  UserMessageImageGallery,
  UserMessageText,
  normalizeCommitmentText,
  summarizeQuotedAssistantMessage,
} from "./message-ui";
import {
  buildPauseDecisionFallbackFromRecentEvents,
  buildTaskTitle,
  deriveTaskHeaderPresentation,
  getAssistantOrCompletionText,
  getBotTranscriptSpeaker,
  getCompletionSummaryText,
  getUserEventDisplayMessage,
  isChatExecutionTask,
  isLowSignalPauseMessage,
  isVerificationNoiseEvent,
  shouldCreateFreshTaskForSend,
  shouldRevealInternalAssistantMessageInVerbose,
} from "./task-event-presentation";
import {
  getAttachmentNamesWithoutImagePreviews,
  getTruncatedTaskEventDetailId,
} from "./task-event-render-detail";
import {
  getAutoScrollTargetTop,
  getDefaultTranscriptMode,
  isCompletionSummaryCoveredByAssistantEvent,
  isRedundantTimelineEvidenceEvent,
  shouldScheduleAutoScrollWrite,
  shouldUseTurnDisclosures,
  type CanvasTimelineItem,
  type SelectedSkillModalState,
  type TaskTimelineItem,
  type TranscriptMode,
} from "./task-feed-logic";
import {
  isTurnThisIntoRoutinePrompt,
  taskCanBecomeRoutineFromFollowUp,
} from "./task-routine-intent";
import {
  describeLoopRisk,
  formatSignedScore,
  shouldHideApprovalEventInStepFeed,
} from "./timeline-event-classification";
import {
  buildWrittenFileResolver,
  collectWrittenFilePaths,
  getFinishedTurnAutoOpen,
  isArtifactEventCoveredByFileWrite,
  stepTurnAutoOpenWatch,
} from "./turn-outputs";
import {
  asRecord,
  buildCompanionNotificationWelcomeSuggestion,
  buildHeartbeatWelcomeSuggestion,
  buildInputRequestWelcomeSuggestion,
  buildMemoryCommitmentSuggestion,
  buildProfileWelcomeSuggestion,
  buildRecentMemorySuggestion,
  dedupeWelcomeTaskSuggestions,
  formatWelcomeModules,
  getRecordString,
  getWorkspaceStatusFolderLabel,
  iconForWelcomeAction,
  labelForWelcomeAction,
  normalizeSuggestionText,
  type ActiveWelcomeSuggestionDraft,
  type WelcomeTaskSuggestion,
} from "./welcome-suggestions";
export { AgentReasoningPanel } from "./AgentReasoningPanel";
export { getAgentLifecycleRowRevision } from "./agent-lifecycle-row-revision";

// A conversation is loaded only when a selected task needs its timeline. The composer
// and its draft stay mounted while the history renderer is fetched.
const StructuredInputPromptCard = preloadableLazy(() =>
  import("./StructuredInputPromptCard").then((module) => module.StructuredInputPromptCard),
);
const PactAuthorizationCard = preloadableLazy(() =>
  import("./PactAuthorizationCard").then((module) => module.PactAuthorizationCard),
);
const GenericLegalWorkflowPromptCard = preloadableLazy(() =>
  import("./legal-prompt-cards").then((module) => module.GenericLegalWorkflowPromptCard),
);
const LegalDemandIntakePromptCard = preloadableLazy(() =>
  import("./legal-prompt-cards").then((module) => module.LegalDemandIntakePromptCard),
);
const BuildChangesPanel = preloadableLazy(() =>
  import("../calm/BuildChangesPanel").then((module) => module.BuildChangesPanel),
);

const UseCasesGallery = preloadableLazy(() =>
  import("../UseCasesGallery").then((module) => module.UseCasesGallery),
);
const DebugSessionPanel = preloadableLazy(() =>
  import("../DebugSessionPanel").then((module) => module.DebugSessionPanel),
);
const ReplayControlsBar = preloadableLazy(() =>
  import("../ReplayControls").then((module) => module.ReplayControlsBar),
);
const TaskAutomationModal = preloadableLazy(() =>
  import("./TaskAutomationModal").then((module) => module.TaskAutomationModal),
);
const SkillParameterModal = preloadableLazy(() =>
  import("../SkillParameterModal").then((module) => module.SkillParameterModal),
);

const TaskConversationFlow = preloadableLazy(() =>
  import("./TaskConversationFlow").then((module) => module.TaskConversationFlow),
);

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

function getIntegrationMentionSearchRank(option: IntegrationMentionOption, query: string): number {
  if (!query) return 0;
  const label = normalizeMentionSearch(option.label);
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  const aliases = option.aliases.map(normalizeMentionSearch);
  if (aliases.some((alias) => alias === query)) return 2;
  if (aliases.some((alias) => alias.startsWith(query))) return 3;
  return 4;
}

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
  /** `title-bar` renders the session header in the app title bar instead of above the body. */
  headerPlacement?: "inline" | "title-bar";
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
  /** Sessions the Calm home lists under the composer (empty while a task is open). */
  homeSessions?: HomeSessions;
  botConversations?: Task[];
  isLoadingBotConversations?: boolean;
  conversationProjection?: BotConversationProjection | null;
  onSelectBotConversation?: (conversationId: string) => void | Promise<void>;
  onNewBotConversation?: (botRoleId: string) => void | Promise<void>;
  draftValue?: string;
  draftRevision?: number;
  onDraftValueChange?: (value: string) => ComposerDraft | void;
  onDraftAccepted?: (
    revision: number,
    submittedDraft?: ComposerDraft | null,
  ) => void | boolean | Promise<void | boolean>;
  draftSnapshot?: ComposerDraft | null;
  onDraftPatch?: (
    patch: Partial<
      Pick<ComposerDraft, "interactionMode" | "mentions" | "quotedAssistantMessage" | "attachments">
    >,
  ) => ComposerDraft | void;
  onStageDraftAttachment?: (attachment: {
    name: string;
    size: number;
    mimeType?: string;
    path?: string;
    dataBase64?: string;
  }) => Promise<DraftAttachmentRef | null>;
  onResolveDraftAttachment?: (
    refId: string,
  ) => Promise<{ ref: DraftAttachmentRef; path: string } | null>;
  onReleaseDraftAttachment?: (refId: string) => Promise<void>;
  onSendMessage: (
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      interactionMode?: InteractionModeSelection;
      deliveryMode?: "message" | "follow_up";
      messageId?: string;
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      accessProfileId?: AccessProfileId;
      integrationMentions?: IntegrationMentionSelection[];
      returnOnAccepted?: boolean;
      verbatim?: boolean;
      surfaceOrigin?: MessageSurfaceOrigin;
    },
  ) => void | boolean | Promise<void | boolean>;
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
  ) => void | boolean | Promise<void | boolean>;
  onAskInbox?: (query: string) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onViewRoutine?: (routineId: string) => void;
  /** Shows an approval's review dialog in place; false when the app doesn't hold it. */
  onReviewApproval?: (approvalId: string) => boolean;
  onStopTask?: () => void;
  onContinueWithoutCommandsForPausedTask?: () => void | Promise<void>;
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
  /** Opens the right panel scrolled to its Subagents section. */
  onViewSubAgents?: () => void;
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
  /** Open a finished turn's single new document, sheet, deck or page in the right panel. */
  autoOpenTurnOutput?: boolean;
  rendererPerfLoggingEnabled?: boolean;
  taskSwitchId?: string | null;
  hasMoreTimelineHistory?: boolean;
  isLoadingTimelineHistory?: boolean;
  timelineHistoryError?: string | null;
  onLoadMoreTimelineHistory?: (options?: { loadAll?: boolean }) => void | Promise<void>;
  onLoadTaskEventDetail?: (eventId: string, taskId: string) => void | Promise<void>;
  onReleaseTaskEventDetail?: (eventId: string, taskId: string) => void;
  remoteSession?: { deviceId: string; deviceName: string } | null;
  replayControls?: ReplayControls;
  /** The right panel already lists changed files and outputs; the status drawer skips them. */
  rightPanelOpen?: boolean;
}

export function TaskSessionLineageFooter({
  task,
  onSelectTask,
  isBotConversation = false,
}: {
  task: Task | null | undefined;
  onSelectTask?: (taskId: string | null) => void;
  isBotConversation?: boolean;
}) {
  const sourceTaskId = task?.branchFromTaskId?.trim();
  if (!sourceTaskId) return null;

  const lineageLabel = isBotConversation ? "Previous bot conversation" : "Forked from conversation";
  const sourceTitle = isBotConversation
    ? "Open previous bot conversation"
    : "Open source conversation";
  const content = (
    <>
      <GitFork size={18} strokeWidth={1.8} aria-hidden="true" />
      <span>{lineageLabel}</span>
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
          title={sourceTitle}
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
  // Keyed by content, not array identity: a parent re-render that rebuilds an equal list
  // must not restart the animation from an empty placeholder.
  const phrasesKey = phrases.filter((phrase) => phrase.trim().length > 0).join("\u0000");
  const normalizedPhrases = useMemo(
    () => (phrasesKey ? phrasesKey.split("\u0000") : []),
    [phrasesKey],
  );
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

let calmSuggestionCardsCache: FocusedCard[] | null = null;
function getCalmSuggestionCards(): FocusedCard[] {
  calmSuggestionCardsCache ??= pickFocusedCards(
    // Task starters only: their titles are verbs ("Draft an email"), which reads as one
    // set; the "I can …" discover cards stay in the quick-start grid.
    FOCUSED_CARD_POOL.filter((card) => card.action.type === "prompt" && card.category === "task"),
    8,
  );
  return calmSuggestionCardsCache;
}

const FOCUSED_CARD_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  edit: EditIcon,
  search: SearchIcon,
  chart: ChartIcon,
  folder: FolderIcon,
  zap: ZapIcon,
  message: MessageIcon,
  clipboard: ClipboardIcon,
  filetext: FileTextIcon,
  code: CodeIcon,
  globe: GlobeIcon,
  book: BookIcon,
  calendar: CalendarIcon,
  sliders: SlidersIcon,
  shield: ShieldIcon,
};

function renderFocusedCardIcon(iconName: string, size: number): React.ReactElement {
  const Icon = FOCUSED_CARD_ICONS[iconName] ?? ZapIcon;
  return <Icon size={size} />;
}

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
  homeSessions = EMPTY_HOME_SESSIONS,
  botConversations = [],
  isLoadingBotConversations = false,
  conversationProjection = null,
  onSelectBotConversation,
  onNewBotConversation,
  draftValue,
  draftRevision = 0,
  onDraftValueChange,
  onDraftAccepted,
  draftSnapshot = null,
  onDraftPatch,
  onStageDraftAttachment,
  onResolveDraftAttachment,
  onReleaseDraftAttachment,
  onSendMessage,
  onOpenSideChat,
  onStartOnboarding,
  onStartFreshSession,
  onCreateTask,
  onAskInbox,
  onChangeWorkspace,
  onSelectWorkspace,
  onOpenSettings,
  onViewRoutine,
  onReviewApproval,
  onStopTask,
  onContinueWithoutCommandsForPausedTask,
  onWrapUpTask,
  inputRequest = null,
  pendingInputRequests = [],
  onSubmitInputRequest,
  onDismissInputRequest,
  onOpenBrowserView,
  onViewTaskOutputs,
  onViewSubAgents,
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
  autoOpenTurnOutput = false,
  rendererPerfLoggingEnabled = false,
  taskSwitchId = null,
  hasMoreTimelineHistory = false,
  isLoadingTimelineHistory = false,
  timelineHistoryError = null,
  onLoadMoreTimelineHistory,
  onLoadTaskEventDetail,
  onReleaseTaskEventDetail,
  remoteSession = null,
  replayControls,
  headerPlacement = "inline",
  rightPanelOpen = false,
}: MainContentProps) {
  const titleBarSlot = useTitleBarContextSlot(headerPlacement === "title-bar");
  recordRendererRender(
    "MainContent",
    task?.id ? `task:${task.id}` : (selectedTaskId ?? "task:none"),
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
  const isReplayMode = replayControls?.isReplayMode ?? false;
  const baseSharedTaskEventUi =
    sharedTaskEventUi?.projectionMode === "live" && transcriptModeOverride === "inspect"
      ? null
      : sharedTaskEventUi;
  const effectiveSharedTaskEventUi = useMemo(
    () =>
      reconcileBotConversationSharedTaskEventUi(baseSharedTaskEventUi, {
        task,
        workspace,
        isReplayMode,
      }),
    [baseSharedTaskEventUi, isReplayMode, task, workspace],
  );
  const statusTaskEventUi = useMemo(
    () =>
      sharedTaskEventUi ??
      deriveSharedTaskEventUiState({
        rawEvents,
        task,
        workspace,
        verboseSteps: false,
        projectionMode: "inspect",
        isReplayMode,
      }),
    [isReplayMode, rawEvents, sharedTaskEventUi, task, workspace],
  );
  const [newActivityCount, setNewActivityCount] = useState(0);
  useEffect(() => {
    setNewActivityCount(0);
  }, [task?.id]);
  const taskStatusStripEnabled = useMemo(
    () => localStorage.getItem("task-status-strip-enabled") !== "false",
    [],
  );
  const statusActivityGroupsById = useMemo(
    () => new Map(statusTaskEventUi.activityGroups.map((group) => [group.id, group])),
    [statusTaskEventUi.activityGroups],
  );
  const events = useMemo(() => {
    if (effectiveSharedTaskEventUi) {
      return effectiveSharedTaskEventUi.normalizedEvents;
    }
    return measureRendererPerf("MainContent.normalizeEvents", rendererPerfLoggingEnabled, () => {
      return normalizeEventsForTimelineUi(rawEvents);
    });
  }, [rawEvents, rendererPerfLoggingEnabled, effectiveSharedTaskEventUi, task]);
  const taskStatusStripModel = useMemo(
    () => ({
      ...statusTaskEventUi.taskStatusStrip,
      newActivityCount,
      hasUnreadActivity: newActivityCount > 0,
      latestActivityId: events.at(-1)?.id,
    }),
    [events, newActivityCount, statusTaskEventUi.taskStatusStrip],
  );
  const livePlan = useMemo(
    () =>
      deriveLivePlan({
        state: statusTaskEventUi.taskStatusStrip.state,
        planSteps: statusTaskEventUi.planSteps,
        checklistState: statusTaskEventUi.checklistState,
        events: statusTaskEventUi.normalizedEvents,
      }),
    [
      statusTaskEventUi.checklistState,
      statusTaskEventUi.normalizedEvents,
      statusTaskEventUi.planSteps,
      statusTaskEventUi.taskStatusStrip.state,
    ],
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
  const inputValueRef = useRef("");
  const [activeWelcomeSuggestionDraft, setActiveWelcomeSuggestionDraft] =
    useState<ActiveWelcomeSuggestionDraft | null>(null);
  const [quotedAssistantMessage, setQuotedAssistantMessage] =
    useState<QuotedAssistantMessage | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [isPreparingMessage, setIsPreparingMessage] = useState(false);
  const attachmentOwnerFenceRef = useRef(createPendingAttachmentOwnerFence());
  attachmentOwnerFenceRef.current.setOwner(
    JSON.stringify([
      workspace?.id ?? null,
      selectedTaskId ?? task?.id ?? null,
      remoteSession?.deviceId ?? null,
    ]),
  );
  useEffect(() => {
    const ownerFence = attachmentOwnerFenceRef.current;
    return () => ownerFence.invalidate();
  }, []);
  const pendingFollowUpSubmissionRef = useRef<{
    taskId: string;
    fingerprint: string;
    messageId: string;
    acceptance: ReturnType<typeof createComposerSubmissionAcceptance>;
  } | null>(null);
  useEffect(() => {
    pendingFollowUpSubmissionRef.current?.acceptance.observe(rawEvents);
  }, [rawEvents]);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [integrationMentionOptions, setIntegrationMentionOptions] = useState<
    IntegrationMentionOption[]
  >([]);
  const [integrationMentionSpans, setIntegrationMentionSpans] = useState<IntegrationMentionSpan[]>(
    [],
  );
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTarget, setMentionTarget] = useState<{ start: number; end: number } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashTarget, setSlashTarget] = useState<{ start: number; end: number } | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [showTaskHeaderMenu, setShowTaskHeaderMenu] = useState(false);
  const [showBotAdvanced, setShowBotAdvanced] = useState(false);
  const [showBotHistory, setShowBotHistory] = useState(false);
  const [showBotProfile, setShowBotProfile] = useState(false);
  const [botRole, setBotRole] = useState<AgentRoleData | null>(null);
  const [headerActionError, setHeaderActionError] = useState<string | null>(null);
  const [showTaskAutomationModal, setShowTaskAutomationModal] = useState(false);
  const [routineCreationNotice, setRoutineCreationNotice] = useState<{
    taskId: string;
    routineId: string;
    name: string;
    triggerSummary: string;
  } | null>(null);
  const taskHeaderMenuRef = useRef<HTMLDivElement>(null);
  const taskHeaderMenuButtonRef = useRef<HTMLButtonElement>(null);
  const stagingAttachmentIdsRef = useRef<Set<string>>(new Set());
  const pendingAttachmentIdsRef = useRef<Set<string>>(new Set());
  const pendingAttachmentsRef = useRef<PendingAttachment[]>(pendingAttachments);
  const lastDraftAttachmentSyncRef = useRef("");
  const previousTaskIdRef = useRef<string | undefined>(undefined);
  const previousDraftKeyRef = useRef<string | undefined>(undefined);
  const draftRevisionRef = useRef(draftRevision);
  const draftKeyRef = useRef<string | undefined>(draftSnapshot?.draftKey);
  const draftSnapshotRef = useRef<ComposerDraft | null>(draftSnapshot);
  const acceptedDraftClearRef = useRef<{
    draftKey?: string;
    taskId?: string;
    revision: number;
    text: string;
  } | null>(null);
  const renderedDraftKey = draftSnapshot?.draftKey;
  if (draftKeyRef.current !== renderedDraftKey) {
    // A key change is an owner transition, so reset the revision fence for
    // the newly rendered task/draft. Within one key, revisions are monotonic;
    // keep a synchronous input mutation from being overwritten by a stale
    // parent render.
    draftKeyRef.current = renderedDraftKey;
    draftRevisionRef.current = draftRevision;
    draftSnapshotRef.current = draftSnapshot;
  } else {
    draftRevisionRef.current = Math.max(draftRevisionRef.current, draftRevision);
    if (draftSnapshot && draftSnapshot.revision >= (draftSnapshotRef.current?.revision ?? -1)) {
      draftSnapshotRef.current = draftSnapshot;
    }
  }

  const recordDraftMutation = useCallback((draft: ComposerDraft | void): void => {
    if (!draft) return;
    // Draft-store updates are synchronous, while the parent props update on
    // the next React render. Keep submission fencing aligned with the exact
    // revision produced by the keystroke that may immediately precede Enter.
    draftRevisionRef.current = draft.revision;
    draftKeyRef.current = draft.draftKey;
    draftSnapshotRef.current = draft;
  }, []);

  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);
  pendingAttachmentIdsRef.current = new Set(pendingAttachments.map((attachment) => attachment.id));
  pendingAttachmentsRef.current = pendingAttachments;

  // A composer draft belongs to the task it was written for. When the user
  // presses New (or opens another history row), MainContent is retained and
  // only its task prop changes; without clearing this state the previous
  // prompt remains visible in the fresh composer.
  useEffect(() => {
    const draftKey = draftSnapshot?.draftKey;
    const acceptedDraftClear = acceptedDraftClearRef.current;
    const acceptedDraftStillVisible =
      acceptedDraftClear &&
      isSameAcceptedComposerDraftFence({
        fenceDraftKey: acceptedDraftClear.draftKey,
        currentDraftKey: draftKey,
        fenceTaskId: acceptedDraftClear.taskId,
        currentTaskId: task?.id,
        fenceRevision: acceptedDraftClear.revision,
        currentRevision: draftSnapshot?.revision ?? draftRevision,
      }) &&
      draftValue === acceptedDraftClear.text &&
      inputValueRef.current === "";
    if (acceptedDraftStillVisible) {
      // The durable clear is still in flight. Do not hydrate the accepted
      // prompt back into the editor after the optimistic local clear.
      previousTaskIdRef.current = task?.id;
      previousDraftKeyRef.current = draftKey;
      return;
    }
    if (
      acceptedDraftClear &&
      (!draftSnapshot ||
        draftKey !== acceptedDraftClear.draftKey ||
        (draftSnapshot.revision ?? draftRevision) > acceptedDraftClear.revision)
    ) {
      acceptedDraftClearRef.current = null;
    }
    const taskChanged = previousTaskIdRef.current !== task?.id;
    const draftChanged = previousDraftKeyRef.current !== draftKey;
    const restoredAttachments = (draftSnapshot?.attachments ?? []).map((attachment) => ({
      id: attachment.refId,
      draftRefId: attachment.refId,
      draftSha256: attachment.sha256,
      name: attachment.name,
      size: attachment.size,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      status: "unavailable" as const,
    }));

    if (taskChanged || draftChanged) {
      // Creating the first draft during file staging must not erase the local file
      // before the staging reply can attach its durable reference.
      const preserveStaging =
        !taskChanged &&
        draftChanged &&
        !previousDraftKeyRef.current &&
        stagingAttachmentIdsRef.current.size > 0;
      if (!preserveStaging) setInputValue(draftValue ?? "");
      // A lookup can resolve before React renders the queued attachment state.
      pendingAttachmentsRef.current = preserveStaging
        ? [
            ...restoredAttachments,
            ...pendingAttachmentsRef.current.filter(
              (item) => !restoredAttachments.some((restored) => restored.id === item.id),
            ),
          ]
        : restoredAttachments;
      setPendingAttachments((current) =>
        preserveStaging
          ? [
              ...restoredAttachments,
              ...current.filter(
                (item) => !restoredAttachments.some((restored) => restored.id === item.id),
              ),
            ]
          : restoredAttachments,
      );
      setIntegrationMentionSpans((draftSnapshot?.mentions ?? []) as IntegrationMentionSpan[]);
      setQuotedAssistantMessage(draftSnapshot?.quotedAssistantMessage ?? null);
      setAttachmentError(null);
      setShowBotHistory(false);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
      if (restoredAttachments.length > 0 && onResolveDraftAttachment && draftSnapshot?.draftKey) {
        const draftKeyAtRestore = draftSnapshot.draftKey;
        void Promise.all(
          restoredAttachments.map(async (attachment) => ({
            attachment,
            resolved: await onResolveDraftAttachment(attachment.draftRefId as string),
          })),
        ).then((resolvedAttachments) => {
          const currentDraft = draftSnapshotRef.current;
          const restored = reconcileResolvedDraftAttachments({
            draftKeyAtRestore,
            currentDraftKey: draftKeyRef.current,
            currentDraft,
            pendingAttachments: pendingAttachmentsRef.current,
            resolvedAttachments,
          });
          if (!restored) return;
          setPendingAttachments(
            (current) =>
              // React may apply this updater after another owner or attachment
              // edit, so reconcile against the live state again at application.
              reconcileResolvedDraftAttachments({
                draftKeyAtRestore,
                currentDraftKey: draftKeyRef.current,
                currentDraft: draftSnapshotRef.current,
                pendingAttachments: current,
                resolvedAttachments,
              })?.pendingAttachments ?? current,
          );
          if (restored.draftAttachments !== currentDraft?.attachments) {
            recordDraftMutation(onDraftPatch?.({ attachments: restored.draftAttachments }));
          }
        });
      } else if (restoredAttachments.length > 0) {
        onDraftPatch?.({
          attachments: (draftSnapshot?.attachments ?? []).map((attachment) => ({
            ...attachment,
            status: "unavailable" as const,
          })),
        });
      }
    } else if (draftValue !== undefined && draftValue !== inputValueRef.current) {
      // Draft hydration is asynchronous. Restore it only when the composer
      // has not diverged locally, so a late response cannot overwrite typing.
      setInputValue(draftValue);
    }
    previousTaskIdRef.current = task?.id;
    previousDraftKeyRef.current = draftKey;
  }, [
    draftRevision,
    draftSnapshot,
    draftValue,
    onDraftPatch,
    onResolveDraftAttachment,
    recordDraftMutation,
    task?.id,
  ]);

  // Focused mode card pool - pick random cards on mount
  const focusedCards = useMemo(
    () =>
      pickFocusedCards(
        window.coworkBrowserHost
          ? FOCUSED_CARD_POOL.filter(
              (card) => card.action.type === "prompt" && card.id !== "discover-images",
            )
          : FOCUSED_CARD_POOL,
        CARDS_TO_SHOW,
      ),
    [],
  );
  const isBrowserHost = window.coworkBrowserHost === true;
  const isCalm = useIsCalmTheme();
  // Picked once per app session so the chips don't reshuffle on every visit.
  const calmSuggestionCards = useMemo(getCalmSuggestionCards, []);
  // The Calm home's Today stack: the shared "needs you" queue (approvals, questions, waiting
  // sessions, flow steps, due commitments, suggestions), each as one prepared decision, then
  // what was handled without the user.
  const homeTodaySignals = useHomeTodaySignals(isCalm && !task);
  const homeToday = useMemo(
    () =>
      buildHomeToday({
        attention: homeTodaySignals.attention,
        sessions: homeSessions,
        now: Date.now(),
        resolved: homeTodaySignals.resolved,
        actedRows: homeTodaySignals.actedRows,
      }),
    [
      homeSessions,
      homeTodaySignals.attention,
      homeTodaySignals.resolved,
      homeTodaySignals.actedRows,
    ],
  );

  // ── Rotating placeholder prompts (persona-aware engine) ──────────────
  const [rotatingPlaceholders, setRotatingPlaceholders] = useState<string[]>([]);
  const placeholderDebounceRef = useRef<number | null>(null);
  const placeholderPlaylistCacheRef = useRef<Map<string, string[]>>(new Map());
  const placeholderRequestIdRef = useRef(0);

  useEffect(() => {
    setShowTaskHeaderMenu(false);
    setShowTaskAutomationModal(false);
    setShowBotProfile(false);
    setShowBotAdvanced(false);
    setHeaderActionError(null);
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
  const [chronicleEnabledForTask, setChronicleEnabledForTask] = useState(true);
  const [modeDrafts, setModeDrafts] = useState<Record<string, InteractionModeSelection>>({});
  const modeDraftKey =
    draftSnapshot?.draftKey ?? `${workspace?.id ?? "unscoped"}:${selectedTaskId ?? "new"}`;
  const activeModeDraftKeyRef = useRef(modeDraftKey);
  const modeSubmissionRevisionRef = useRef(0);
  activeModeDraftKeyRef.current = modeDraftKey;
  const selectedInteractionMode =
    draftSnapshot?.interactionMode ??
    modeDrafts[modeDraftKey] ??
    getInteractionModeSelection(task?.agentConfig) ??
    (selectedTaskId ? undefined : ({ mode: "smart" } as const));
  const displayedInteractionMode: InteractionModeSelection =
    selectedInteractionMode ??
    (task?.agentConfig?.executionMode === "chat"
      ? { mode: "chat" }
      : task?.agentConfig?.executionMode === "plan"
        ? { mode: "smart", executionOverride: "plan" }
        : { mode: "smart" });
  const executionMode: ExecutionMode =
    displayedInteractionMode.mode === "chat"
      ? "chat"
      : (displayedInteractionMode.executionOverride ?? "execute");
  const setInteractionMode = (selection: InteractionModeSelection) => {
    setModeDrafts((previous) => ({ ...previous, [modeDraftKey]: selection }));
    recordDraftMutation(onDraftPatch?.({ interactionMode: selection }));
  };
  useEffect(() => {
    const accepted = getInteractionModeSelection(task?.agentConfig);
    setModeDrafts((previous) => {
      if (
        !previous[modeDraftKey] ||
        JSON.stringify(previous[modeDraftKey]) !== JSON.stringify(accepted)
      )
        return previous;
      const next = { ...previous };
      delete next[modeDraftKey];
      return next;
    });
  }, [modeDraftKey, task?.agentConfig]);
  const [defaultPermissionAccessMode, setDefaultPermissionAccessMode] =
    useState<PermissionAccessMode>(BUILTIN_ACCESS_PROFILE_IDS.askForApproval);
  const [permissionAccessMode, setPermissionAccessMode] = useState<PermissionAccessMode>(
    BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  );
  // The Settings default last applied, to tell a changed default from other settings updates.
  const loadedDefaultAccessProfileIdRef = useRef<PermissionAccessMode | null>(null);
  const [selectedTaskAccessProfileOverride, setSelectedTaskAccessProfileOverride] = useState<
    AccessProfileId | null | undefined
  >(undefined);
  const [permissionSettingsLoaded, setPermissionSettingsLoaded] = useState(false);
  const [adminRuntimePolicy, setAdminRuntimePolicy] = useState<{
    allowedPermissionModes?: PermissionMode[];
    allowedSandboxTypes?: Array<"macos" | "docker" | "space" | "none">;
    requireSandboxForShell?: boolean;
    allowUnsandboxedShell?: boolean;
    network?: {
      defaultAction?: "allow" | "deny";
      allowedDomains?: string[];
      blockedDomains?: string[];
      allowShellNetwork?: boolean;
    };
  } | null>(null);
  const [approvalPromptsEnabled, setApprovalPromptsEnabled] = useState<boolean | null>(null);
  // New tasks always run under one of the named profiles.
  const newTaskAccessProfileId = permissionAccessMode;
  const taskAccessProfileId = task?.id
    ? (selectedTaskAccessProfileOverride ?? undefined)
    : permissionAccessMode;
  // A task saved before access profiles shows the profile its permission mode runs as.
  const selectedProfileId = task?.id
    ? (selectedTaskAccessProfileOverride ??
      getAccessProfileIdForPermissionMode(task.agentConfig?.permissionMode))
    : permissionAccessMode;
  const [accessProfiles, setAccessProfiles] = useState<AccessProfileDefinition[]>([]);
  const selectedAccessProfile = useMemo(() => {
    const found = [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].find(
      (profile) => profile.id === selectedProfileId,
    );
    if (found) return found;
    if (selectedProfileId) {
      return {
        id: selectedProfileId,
        label: "Unavailable access profile",
        description: "This profile is no longer available.",
        sandbox: "read-only" as const,
        approval: "on-request" as const,
        reviewer: "user" as const,
        network: "disabled" as const,
        shellAccess: false,
      } satisfies AccessProfileDefinition;
    }
    return BUILTIN_ACCESS_PROFILES[0];
  }, [accessProfiles, selectedProfileId]);
  const selectedAccessProfilePresentation = getAccessProfilePresentation(
    selectedAccessProfile,
    approvalPromptsEnabled,
  );
  const selectedAccessProfileLabel = selectedAccessProfile.label;
  const profileConstraintNotice = useMemo(() => {
    const notices: string[] = [];
    if (selectedProfileId && selectedAccessProfile.label === "Unavailable access profile") {
      return "This access profile is unavailable; execution will remain paused until you choose a valid profile.";
    }

    if (selectedAccessProfilePresentation.notice) {
      notices.push(selectedAccessProfilePresentation.notice);
    }

    if (
      selectedProfileId &&
      isFullAccessProfile(selectedAccessProfile) &&
      hasAccessProfileScope(selectedAccessProfile)
    ) {
      notices.push("Scoped rules force this profile to use a sandboxed execution boundary.");
    }

    const adminRuntime = adminRuntimePolicy;
    const selectedLegacyMode = getLegacyPermissionModeForAccessProfile(selectedAccessProfile);
    if (
      selectedProfileId &&
      Array.isArray(adminRuntime?.allowedPermissionModes) &&
      adminRuntime.allowedPermissionModes.length > 0 &&
      !adminRuntime.allowedPermissionModes.includes(selectedLegacyMode)
    ) {
      notices.push(
        "Administrator policy will constrain this profile to an allowed permission mode.",
      );
    }
    if (
      selectedProfileId &&
      adminRuntime?.requireSandboxForShell === true &&
      isFullAccessProfile(selectedAccessProfile) &&
      selectedAccessProfile.shellAccess !== false
    ) {
      notices.push("Administrator policy requires sandboxing for shell commands.");
    }
    if (
      selectedProfileId &&
      selectedAccessProfile.network !== "disabled" &&
      adminRuntime?.network?.defaultAction === "deny"
    ) {
      notices.push(
        "Administrator policy denies network access unless a domain is explicitly allowed.",
      );
    }
    return notices.length > 0 ? notices.join(" ") : null;
  }, [
    adminRuntimePolicy,
    selectedAccessProfile,
    selectedAccessProfilePresentation.notice,
    selectedProfileId,
  ]);
  const [modeSuggestions, setModeSuggestions] = useState<ModeSuggestion[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [useCasesOpen, setUseCasesOpen] = useState(false);

  useEffect(() => {
    // The gallery only renders on the welcome screen; with a task open, let the sidebar fall back.
    if (task) return;
    const onOpen = (event: Event) => {
      event.preventDefault();
      setUseCasesOpen(true);
    };
    window.addEventListener(OPEN_USE_CASES_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_USE_CASES_EVENT, onOpen);
  }, [task]);
  const modeSuggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [taskDomain, setTaskDomain] = useState<TaskDomain>("auto");
  const [verificationAgentEnabled, setVerificationAgentEnabled] = useState(false);
  const isChatTask =
    executionMode === "chat" ||
    (isChatExecutionTask(task?.agentConfig?.executionMode) &&
      task?.agentConfig?.executionModeSource === "user");
  const isBotConversation = task?.agentConfig?.botConversation === true;
  const isBotHandoffWaiting = isBotConversation && conversationProjection?.state === "waiting";
  const botName = botRole && botRole.id === task?.assignedAgentRoleId ? botRole.displayName : "Bot";
  const botIcon = botRole && botRole.id === task?.assignedAgentRoleId ? botRole.icon : undefined;
  const botMascot = resolveBotMascot(botIcon);
  const botMascotExpression = mascotExpressionForBotConversation(
    conversationProjection?.state,
    taskStatusStripModel.state,
  );
  const actionLabels = getConversationActionLabels(isBotConversation);
  const menuLabel = isBotConversation ? "Bot options" : actionLabels.menu;
  useEffect(() => {
    const openHistory = () => {
      if (isBotConversation) setShowBotHistory(true);
    };
    window.addEventListener(BOT_CONVERSATION_HISTORY_OPEN_EVENT, openHistory);
    return () => window.removeEventListener(BOT_CONVERSATION_HISTORY_OPEN_EVENT, openHistory);
  }, [isBotConversation]);
  useEffect(() => {
    const roleId = task?.assignedAgentRoleId;
    setBotRole(null);
    if (!isBotConversation || !roleId || remoteSession) return;
    let cancelled = false;
    const refresh = () => {
      void window.electronAPI
        .getAgentRole(roleId)
        .then((role) => {
          if (!cancelled) setBotRole(role || null);
        })
        .catch((error) => console.error("Failed to load conversation bot:", error));
    };
    refresh();
    window.addEventListener(BOT_PROFILE_UPDATED_EVENT, refresh);
    window.addEventListener(BOT_PROFILE_DELETED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BOT_PROFILE_UPDATED_EVENT, refresh);
      window.removeEventListener(BOT_PROFILE_DELETED_EVENT, refresh);
    };
  }, [isBotConversation, task?.assignedAgentRoleId, remoteSession]);

  const setAutonomousModeSelection = useCallback((enabled: boolean) => {
    setAutonomousModeEnabled(enabled);
    if (enabled) {
      setClarifyingCheckinsEnabled(false);
      setCollaborativeModeEnabled(false);
    }
  }, []);
  const setCollaborativeModeSelection = useCallback((enabled: boolean) => {
    setCollaborativeModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
    }
  }, []);
  // Collaborative team run detection for current task
  const [collaborativeRun, setCollaborativeRun] = useState<AgentTeamRun | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const disclosureSurfaceKey = useMemo<TaskSurfaceKey>(
    () => ({
      scope: remoteSession ? "remote" : "local",
      workspaceId: task?.workspaceId || workspace?.id || "unscoped-workspace",
      taskId: task?.id || "new",
      ...(remoteSession?.deviceId ? { deviceId: remoteSession.deviceId } : {}),
      surface: "main",
    }),
    [remoteSession?.deviceId, task?.id, task?.workspaceId, workspace?.id],
  );
  const {
    state: disclosureIntents,
    intentFor: disclosureIntentFor,
    toggle: toggleDisclosureIntent,
  } = useTaskDisclosureIntents(task?.id, disclosureSurfaceKey);
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
    if (!task?.id || !hasHostMethods("onTeamRunEvent", "findTeamRunByRootTask")) {
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
      const nextValue = inputValue ? `${inputValue} ${text}` : text;
      setInputValue(nextValue);
      recordDraftMutation(onDraftValueChange?.(nextValue));
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
      if (
        shouldCreateFreshTaskForSend({
          executionMode,
          selectedTaskId,
          selectedTaskExecutionMode: task?.agentConfig?.executionMode,
        }) &&
        onCreateTask
      ) {
        const title = text.length > 60 ? text.slice(0, 57) + "..." : text;
        onCreateTask(title, text, {
          generateTitle: true,
          ...(executionMode === "chat" ? { executionMode } : {}),
          agentConfig: { interactionMode: selectedInteractionMode },
          ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
        });
      } else {
        onSendMessage(text, undefined, undefined, {
          interactionMode: selectedInteractionMode,
          ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
        });
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
  // File references in the transcript open in CoWork: documents, sheets, decks and pages in
  // the right-panel viewer, anything else in the preview modal.
  const openFileInPanel = useCallback(
    (path: string) =>
      openPreviewableFileInSidebar(
        path,
        {
          html: openWebArtifact,
          spreadsheet: openSpreadsheetArtifact,
          document: openDocumentArtifact,
          presentation: openPresentationArtifact,
        },
        setViewerFilePath,
      ),
    [openDocumentArtifact, openPresentationArtifact, openSpreadsheetArtifact, openWebArtifact],
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
        : (await window.electronAPI.listWorkspaces().catch(() => [] as Workspace[]))
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

      const [dueSoonCommitments, openCommitments, profile, recentMemories, notifications] =
        await Promise.all([
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
          const suggestion = buildMemoryCommitmentSuggestion(item, index + commitmentItems.length);
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

  // Keyed by the written paths, not the event list, so streaming events do not rebuild
  // (and remount) every rendered markdown component.
  const writtenFilePathsKey = useMemo(() => collectWrittenFilePaths(events).join("\n"), [events]);
  const resolveInlineCodeFilePath = useMemo(
    () => buildWrittenFileResolver(writtenFilePathsKey ? writtenFilePathsKey.split("\n") : []),
    [writtenFilePathsKey],
  );
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        workspacePath: workspace?.path,
        onOpenViewer: openFileInPanel,
        onOpenWebLinkInSidebar,
        citations,
        resolveInlineCodeFilePath,
      }),
    [
      workspace?.path,
      openFileInPanel,
      onOpenWebLinkInSidebar,
      citations,
      resolveInlineCodeFilePath,
    ],
  );
  const eventTitleMarkdownComponents = useMemo(
    () => ({
      ...markdownComponents,
      // Timeline titles stay one line: image links render as plain links, no thumbnail.
      a: buildMarkdownComponents({
        workspacePath: workspace?.path,
        onOpenViewer: openFileInPanel,
        onOpenWebLinkInSidebar,
        citations,
        inlineImageLinks: false,
      }).a,
      // Keep timeline titles inline; replace emoji with Lucide icons.
      p: ({ children }: Any) => <>{replaceEmojisInChildren(children, 14)}</>,
    }),
    [markdownComponents, workspace?.path, openFileInPanel, onOpenWebLinkInSidebar, citations],
  );
  // Canvas sessions state - track active canvas sessions for current task
  const [canvasSessions, setCanvasSessions] = useState<CanvasSession[]>([]);
  // Workspace dropdown state
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspacesList, setWorkspacesList] = useState<Workspace[]>([]);
  // Verbose mode - default to summary and persist per user profile.
  const [verboseSteps, setVerboseSteps] = useState(false);
  // The feed shows a "Worked for" header per turn, so the task-wide duration label is not needed.
  const turnHeadersShown = shouldUseTurnDisclosures({
    verboseSteps,
    isReplayMode,
    isConversationOnlySurface: isChatTask || isBotConversation,
  });
  const [commandOutputStyle, setCommandOutputStyle] = useState(readCommandOutputStyle);
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
  const calmAccessMenuRef = useRef<HTMLDivElement>(null);
  // Overflow menu state (welcome view only - no task)
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false);
  const [overflowSubmenu, setOverflowSubmenu] = useState<"domain" | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowToggleBtnRef = useRef<HTMLButtonElement>(null);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const [showDomainDropdown, setShowDomainDropdown] = useState(false);
  const domainDropdownRef = useRef<HTMLDivElement>(null);
  const [guardrailDefaultMaxAutoContinuations, setGuardrailDefaultMaxAutoContinuations] = useState<
    number | null
  >(null);
  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    // Bot conversations must take the hydrated Bot-specific filtering path;
    // the app-level projection may have been built from a lightweight task row.
    if (
      !verboseSteps &&
      effectiveSharedTaskEventUi &&
      task?.agentConfig?.botConversation !== true
    ) {
      return effectiveSharedTaskEventUi.filteredEvents;
    }
    return measureRendererPerf("MainContent.filteredEvents", rendererPerfLoggingEnabled, () => {
      const transcriptEvents =
        task?.agentConfig?.botConversation === true
          ? filterBotConversationTranscriptEvents(events)
          : events;
      const baseEvents = verboseSteps
        ? filterVerboseTimelineNoise(transcriptEvents)
        : filterAdjacentDuplicateTimelineFailures(
            filterResolvedApprovalNarration(transcriptEvents).filter((event) =>
              shouldShowTaskEventInSummaryMode(event, task?.status),
            ),
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
        const fingerprint = (
          typeof payload.terminal_failure_fingerprint === "string"
            ? payload.terminal_failure_fingerprint
            : typeof payload.terminalFailureFingerprint === "string"
              ? payload.terminalFailureFingerprint
              : typeof payload.errorFingerprint === "string"
                ? payload.errorFingerprint
                : typeof payload.message === "string"
                  ? payload.message
                  : typeof payload.error === "string"
                    ? payload.error
                    : ""
        ).trim();
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
  const parallelGroupProjection = useMemo(() => {
    if (effectiveSharedTaskEventUi) return effectiveSharedTaskEventUi.parallelGroupProjection;
    return measureRendererPerf(
      "MainContent.parallelGroupProjection",
      rendererPerfLoggingEnabled,
      () => buildParallelGroupProjection(events),
    );
  }, [events, effectiveSharedTaskEventUi, rendererPerfLoggingEnabled]);
  // Compact mode lists each call in a tool batch as its own step ("Read Sidebar.tsx",
  // "Searched for X") instead of folding the batch into one parallel-group row.
  const { parallelGroupsByAnchorEventId, suppressedParallelEventIds } = useMemo(() => {
    const groups = parallelGroupProjection.groupsByAnchorEventId;
    const suppressed = parallelGroupProjection.suppressedEventIds;
    if (verboseSteps) {
      return { parallelGroupsByAnchorEventId: groups, suppressedParallelEventIds: suppressed };
    }
    const compactGroups = new Map(
      [...groups].filter(([, group]) => !isToolsParallelGroupId(group.groupId)),
    );
    const compactSuppressed = new Set(suppressed);
    for (const event of events) {
      if (
        compactSuppressed.has(event.id) &&
        getEffectiveTaskEventType(event) === "tool_call" &&
        isToolsParallelGroupId(getEventGroupId(event))
      ) {
        compactSuppressed.delete(event.id);
      }
    }
    return {
      parallelGroupsByAnchorEventId: compactGroups,
      suppressedParallelEventIds: compactSuppressed,
    };
  }, [events, parallelGroupProjection, verboseSteps]);

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
      childTasks.some(
        (childTask) =>
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

  const composerPredictionRevision = useMemo(() => predictionRevision(rawEvents), [rawEvents]);
  const composerPrediction = useComposerPrediction(
    task?.id,
    composerPredictionRevision,
    task?.status === "completed" &&
      !isTaskWorking &&
      !isReplayMode &&
      !inputValue &&
      pendingAttachments.length === 0 &&
      !quotedAssistantMessage &&
      !isPreparingMessage &&
      !isUploadingAttachments &&
      voiceInput.state === "idle" &&
      !talkMode.isActive,
  );

  // Opt-in: when a turn the user watched finishes with exactly one new file that has a
  // side-panel viewer, open it there. Turns already finished on load or loaded with older
  // history never open, so reopening a task does not pop files. A turn paused for an
  // approval or an answer has not finished: it opens when the task settles.
  const autoOpenEventsRef = useRef(events);
  autoOpenEventsRef.current = events;
  // The task whose turn the user watched working, until that turn ends.
  const sawTurnWorkingRef = useRef<string | null>(null);
  const autoOpenedTurnKeysRef = useRef(new Set<string>());
  const autoOpenTaskId = task?.id ?? null;
  const autoOpenTaskStatus = task?.status;
  useEffect(() => {
    const step = stepTurnAutoOpenWatch(sawTurnWorkingRef.current, {
      id: autoOpenTaskId,
      working: isTaskWorking,
      status: autoOpenTaskStatus,
    });
    sawTurnWorkingRef.current = step.watching;
    if (!step.turnEnded) return;
    if (!autoOpenTurnOutput || isReplayMode || !workspace?.path) return;
    const target = getFinishedTurnAutoOpen(
      autoOpenEventsRef.current,
      autoOpenedTurnKeysRef.current,
    );
    if (!target) return;
    autoOpenedTurnKeysRef.current.add(target.turnKey);
    openFileInPanel(target.path);
  }, [
    autoOpenTaskId,
    autoOpenTaskStatus,
    autoOpenTurnOutput,
    isReplayMode,
    isTaskWorking,
    openFileInPanel,
    workspace?.path,
  ]);

  // Reset wrappingUp state when task stops working or task changes
  useEffect(() => {
    if (!isTaskWorking) setWrappingUp(false);
  }, [isTaskWorking]);
  useEffect(() => {
    setWrappingUp(false);
  }, [task?.id]);
  const handleWrapUp = useCallback(() => {
    if (wrappingUp || !onWrapUpTask) return;
    setWrappingUp(true);
    onWrapUpTask();
  }, [onWrapUpTask, wrappingUp]);

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
    async (payload: { messageId: string; decision: "accepted" | "rejected"; reason?: string }) => {
      setRejectMenuOpenFor(null);
      try {
        await window.electronAPI.submitMessageFeedback({
          taskId: task?.id ?? "",
          messageId: payload.messageId,
          decision: payload.decision,
          reason: payload.reason,
        });
        setMessageFeedbackMap((prev) => new Map(prev).set(payload.messageId, payload.decision));
      } catch (err) {
        console.error("[Feedback] Failed to submit message feedback:", err);
        setHeaderActionError("Could not save your feedback. Please try again.");
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
        setHeaderActionError("Could not send feedback for this step. The task may have moved on.");
      } finally {
        setStepFeedbackSending(false);
      }
    },
    [task, currentStep],
  );

  const isTaskFinished =
    task?.status === "completed" || task?.status === "failed" || task?.status === "cancelled";
  // Sub agents live in the right panel, so offer a jump there while it is closed.
  const showSubAgentsStripButton = Boolean(
    onViewSubAgents && !rightPanelOpen && childTasks.length > 0,
  );
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
  const returnToDefaultTranscript = useCallback(() => {
    setTranscriptModeOverride(null);
  }, []);
  const toggleCompletedTranscriptMode = useCallback(() => {
    if (defaultTranscriptMode !== "delivery") return;
    setTranscriptModeOverride((current) => (current === "inspect" ? null : "inspect"));
  }, [defaultTranscriptMode]);
  const canToggleCompletedTranscript = defaultTranscriptMode === "delivery";
  const initialTurnTiming = useMemo(
    () =>
      resolveInitialTaskTurnTiming({
        task,
        events: rawEvents,
        isTaskWorking,
        hasMoreHistory: hasMoreTimelineHistory,
      }),
    [task, rawEvents, isTaskWorking, hasMoreTimelineHistory],
  );
  const liveWorkDuration = useTaskDuration(
    initialTurnTiming.startedAt,
    initialTurnTiming.completedAt,
    initialTurnTiming.isWorking,
  );
  const persistedWorkDuration =
    initialTurnTiming.durationMs !== undefined
      ? formatDuration(initialTurnTiming.durationMs)
      : null;
  const workDuration = persistedWorkDuration ?? liveWorkDuration;
  const workDurationLabel = initialTurnTiming.isWorking
    ? `Working for ${liveWorkDuration}`
    : initialTurnTiming.isFinished
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

    if (
      continuationWindow <= 1 &&
      !latestDecisionEvent &&
      typeof task.lastProgressScore !== "number"
    ) {
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

  // One glyph per sub-agent, shared by the composer agent lines and transcript rows.

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
    if (
      !verboseSteps &&
      effectiveSharedTaskEventUi &&
      task?.agentConfig?.botConversation !== true
    ) {
      return effectiveSharedTaskEventUi.baseTimelineItems;
    }
    return measureRendererPerf(
      "MainContent.baseTimelineItems",
      rendererPerfLoggingEnabled,
      () =>
        deriveSharedTaskEventUiState({
          rawEvents,
          task,
          workspace,
          verboseSteps,
          isReplayMode,
        }).baseTimelineItems,
    );
  }, [
    rawEvents,
    rendererPerfLoggingEnabled,
    effectiveSharedTaskEventUi,
    task,
    isReplayMode,
    verboseSteps,
    workspace,
  ]);

  const timelineItems = useMemo(() => {
    return measureRendererPerf("MainContent.timelineItems", rendererPerfLoggingEnabled, () => {
      let eventItems: BaseTimelineItem[] = baseTimelineItems;

      const freezeBefore = latestUserMessageTimestamp;
      const canvasItems: CanvasTimelineItem[] = canvasSessions
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
      const specialItems: TaskTimelineItem[] = [...canvasItems];

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

          if (nonCliChildTasks.length > 0) {
            // Other sub-agents read as lifecycle rows at the moments they started and
            // ended ("Anansi and 2 more started working" … "Anansi finished"), so the
            // parent's own narration interleaves between them. Those rows replace the
            // parent's per-agent "Created an agent" / "Agent finished" events.
            for (const row of buildAgentLifecycleRows(nonCliChildTasks)) {
              specialItems.push({
                kind: "agent-lifecycle" as const,
                timestamp: row.timestamp,
                row,
              });
            }
            eventItems = withoutCoveredAgentLifecycleEvents(
              eventItems,
              new Set(nonCliChildTasks.map((t) => t.id)),
            );
          }
        }
      }

      specialItems.sort((a, b) => a.timestamp - b.timestamp);

      if (specialItems.length === 0) return eventItems;

      const merged: TaskTimelineItem[] = [];
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
    return measureRendererPerf(
      "MainContent.commandOutputSessions",
      rendererPerfLoggingEnabled,
      () => {
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
            currentSession.exitCode =
              typeof payload.exitCode === "number" ? payload.exitCode : null;
            finalizeCurrentSession();
          }
        }

        if (currentSession) {
          sessions.push(currentSession);
        }

        return limitCommandOutputSessions(sessions);
      },
    );
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
        if (isCommandOutputStyle(settings.commandOutputStyle)) {
          setCommandOutputStyle(settings.commandOutputStyle);
        }
      })
      .catch(() => {
        // Keep summary default on load failure
      });
  }, []);

  // Apply command output style changes made in Settings without a reload.
  useEffect(() => {
    const handleStyleChange = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail;
      if (isCommandOutputStyle(next)) {
        setCommandOutputStyle(next);
      }
    };
    window.addEventListener(COMMAND_OUTPUT_STYLE_CHANGED_EVENT, handleStyleChange);
    return () => {
      window.removeEventListener(COMMAND_OUTPUT_STYLE_CHANGED_EVENT, handleStyleChange);
    };
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
    if (!hasHostMethod("getVoiceSettings")) return;
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
            (pack.skills || []).filter((skill) => skill.enabled !== false).map((skill) => skill.id),
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
      if (next.length === current.length) return current;
      recordDraftMutation(onDraftPatch?.({ mentions: next }));
      return next;
    });
  }, [inputValue, onDraftPatch]);

  const selectedIntegrationMentions = useMemo<IntegrationMentionSelection[]>(() => {
    const byId = new Map<string, IntegrationMentionSelection>();
    for (const span of integrationMentionSpans) {
      byId.set(span.mention.id, span.mention);
    }
    return Array.from(byId.values());
  }, [integrationMentionSpans]);

  // Load canvas sessions when task changes
  useEffect(() => {
    if (!task?.id || !hasHostMethod("canvasListSessions")) {
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
    if (!hasHostMethods("onCanvasEvent", "canvasGetSession")) return;
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
          variant={commandOutputStyle}
          onClose={() => handleDismissCommandOutput(session.id)}
        />
      ));
    },
    [commandOutputStyle, handleDismissCommandOutput, task?.id],
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

  useEffect(() => {
    let cancelled = false;

    const applyPermissionDefaults = (
      permissionSettings: {
        defaultPermissionAccess?: "default" | "full";
        defaultAccessProfileId?: AccessProfileId;
        accessProfiles?: AccessProfileDefinition[];
      },
      forceSelection = false,
    ) => {
      const nextDefault: PermissionAccessMode =
        permissionSettings.defaultAccessProfileId ||
        (permissionSettings.defaultPermissionAccess === "full"
          ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
          : BUILTIN_ACCESS_PROFILE_IDS.askForApproval);
      const nextProfiles = Array.isArray(permissionSettings.accessProfiles)
        ? permissionSettings.accessProfiles
        : [];
      // Changing the default in Settings is a manual choice too: it replaces the last pick.
      const previousDefault = loadedDefaultAccessProfileIdRef.current;
      loadedDefaultAccessProfileIdRef.current = nextDefault;
      if (forceSelection && previousDefault !== null && previousDefault !== nextDefault) {
        forgetRememberedAccessProfileId();
      }
      setDefaultPermissionAccessMode(nextDefault);
      setAccessProfiles(nextProfiles);
      const availableProfileIds = [...BUILTIN_ACCESS_PROFILES, ...nextProfiles].map(
        (profile) => profile.id,
      );
      const preferredProfileId = resolveNewTaskAccessProfileId({
        remembered: readRememberedAccessProfileId(),
        defaultProfileId: nextDefault,
        availableProfileIds,
      });
      setPermissionAccessMode((current) =>
        forceSelection ||
        current === BUILTIN_ACCESS_PROFILE_IDS.askForApproval ||
        !availableProfileIds.includes(current)
          ? preferredProfileId
          : current,
      );
    };

    const loadPermissionDefaults = async () => {
      try {
        const permissionSettings = await window.electronAPI.getPermissionSettings();
        if (cancelled) return;
        applyPermissionDefaults(permissionSettings);
      } catch (error) {
        console.error("Failed to load permission defaults:", error);
      } finally {
        if (!cancelled) setPermissionSettingsLoaded(true);
      }
    };

    const loadAdminRuntimePolicy = async () => {
      const getAdminPolicies = window.electronAPI?.getAdminPolicies;
      if (typeof getAdminPolicies !== "function") return;
      try {
        const policies = await getAdminPolicies();
        if (!cancelled) setAdminRuntimePolicy(policies?.runtime ?? null);
      } catch (error) {
        // Admin policy access is optional for regular local workspaces. Keep
        // the profile picker usable when the policy service is unavailable.
        console.debug("Failed to load admin runtime policy:", error);
      }
    };

    const loadPermissionRuntimeInfo = async () => {
      try {
        const runtime = await window.electronAPI.getPermissionRuntimeInfo();
        if (!cancelled) setApprovalPromptsEnabled(runtime.approvalPromptsEnabled);
      } catch (error) {
        console.debug("Failed to load permission runtime info:", error);
      }
    };

    const handlePermissionSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && typeof detail === "object") {
        applyPermissionDefaults(detail, true);
      }
    };

    void loadPermissionDefaults();
    void loadAdminRuntimePolicy();
    void loadPermissionRuntimeInfo();
    window.addEventListener("cowork:permission-settings-updated", handlePermissionSettingsUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener(
        "cowork:permission-settings-updated",
        handlePermissionSettingsUpdated,
      );
    };
  }, []);

  // Capture the task's profile once when selection changes. Subsequent global
  // settings updates must not rewrite a selected task's access contract.
  useEffect(() => {
    const taskProfileId = task?.agentConfig?.accessProfileId;
    if (!task?.id) {
      setSelectedTaskAccessProfileOverride(undefined);
      return;
    }
    const normalized = typeof taskProfileId === "string" ? taskProfileId.trim() : "";
    setSelectedTaskAccessProfileOverride(normalized ? (normalized as AccessProfileId) : null);
  }, [task?.id]);

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
      // The folder menu renders in a portal on <body>, outside the container.
      const target = e.target as Node;
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(target) &&
        !(target instanceof Element && target.closest(".workspace-dropdown"))
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

    return (
      <div className="overflow-submenu-panel" role="menu" aria-label="Domain options">
        <div className="overflow-submenu-header">
          <span className="overflow-submenu-title">Domain</span>
        </div>
        {TASK_DOMAIN_ORDER.map((value) => {
          const label = TASK_DOMAIN_LABEL[value];
          const selected = taskDomain === value;

          return (
            <button
              key={value}
              type="button"
              className={`overflow-submenu-option ${selected ? "active" : ""}`}
              onClick={() => {
                setTaskDomain(value);
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
  const loadRecentWorkspaces = async () => {
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
  };

  // A started task is bound to its workspace, so the picker only opens before one exists.
  const isWorkspaceLocked = Boolean(task);
  const handleWorkspaceDropdownToggle = async () => {
    if (isWorkspaceLocked) return;
    if (!showWorkspaceDropdown) {
      await loadRecentWorkspaces();
    }
    setShowWorkspaceDropdown(!showWorkspaceDropdown);
  };

  // Handle selecting an existing workspace from dropdown
  const handleWorkspaceSelect = (selectedWorkspace: Workspace) => {
    setShowWorkspaceDropdown(false);
    onSelectWorkspace?.(selectedWorkspace);
  };

  // Remove a folder from CoWork (its sessions and memory; files stay), then refresh.
  const handleWorkspaceRemove = async (removed: Workspace) => {
    const result = await window.electronAPI.removeWorkspace(removed.id);
    await loadRecentWorkspaces();
    window.dispatchEvent(new CustomEvent("cowork:tasks-removed"));
    if (result.memoryErrors.length > 0) {
      console.warn("Some memory stores could not be cleared:", result.memoryErrors);
    }
  };

  // Handle selecting a new folder via Finder
  const handleSelectNewFolder = () => {
    setShowWorkspaceDropdown(false);
    onChangeWorkspace?.();
  };

  // A new session otherwise keeps the last real folder, and the dropdown had
  // no way back to scratch work. Offered only before a task exists so an
  // existing chat is never moved into a throwaway folder.
  const canSwitchToTempWorkspace =
    !task && !!workspace && !workspace.isTemp && !isTempWorkspaceId(workspace.id);
  const handleUseTempWorkspace = async () => {
    setShowWorkspaceDropdown(false);
    try {
      const tempWorkspace = await window.electronAPI?.getTempWorkspace?.({ createNew: true });
      if (tempWorkspace) onSelectWorkspace?.(tempWorkspace);
    } catch (error) {
      console.error("Failed to switch to a temporary workspace:", error);
    }
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
      recordDraftMutation(onDraftValueChange?.(skill.prompt));
    }
  };

  const handleSkillParamSubmit = (values: SkillParameterFormValues) => {
    if (displayedInteractionMode.mode === "chat") {
      setAttachmentError("Switch to Smart before running a skill. Your parameters have been kept.");
      return;
    }
    const modalState = selectedSkillForParams;
    setSelectedSkillForParams(null);
    if (!modalState) return;
    if (onCreateTask) {
      if (modalState.launchMode === "slash") {
        const commandName = modalState.commandName || modalState.skill.id;
        const slashPrompt = buildSlashSkillPrompt(commandName, values);
        const title = buildTaskTitle(`Run /${commandName}`);
        onCreateTask(
          title,
          slashPrompt,
          newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {},
        );
        return;
      }
      const expandedPrompt = expandSkillPrompt(modalState.skill, values);
      const title = buildTaskTitle(expandedPrompt);
      onCreateTask(title, expandedPrompt, {
        generateTitle: true,
        ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
      });
    }
  };

  const handleSkillAskInChat = (values: SkillParameterFormValues) => {
    if (displayedInteractionMode.mode === "chat") {
      setAttachmentError("Switch to Smart before running a skill. Your parameters have been kept.");
      return;
    }
    const modalState = selectedSkillForParams;
    setSelectedSkillForParams(null);
    if (!modalState || modalState.launchMode !== "slash" || !onCreateTask) return;
    const commandName = modalState.commandName || modalState.skill.id;
    const slashPrompt = buildSlashSkillPrompt(commandName, values);
    const title = buildTaskTitle(`Run /${commandName}`);
    onCreateTask(
      title,
      slashPrompt,
      newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {},
    );
  };

  const handleSkillParamCancel = () => {
    setSelectedSkillForParams(null);
  };

  // Toggle an event's expanded state using its ID
  const toggleEventExpanded = useCallback(
    (eventId: string) => {
      const event = events.find((candidate) => candidate.id === eventId);
      const detailId = event
        ? getTruncatedTaskEventDetailId(event) || event.eventId || event.id
        : null;
      const wasExpanded = resolveDisclosureExpanded({
        intent: disclosureIntentFor("activity", eventId),
        isCurrent: false,
      });
      toggleDisclosureIntent("activity", eventId, false);
      if (!detailId || !task?.id) return;
      if (wasExpanded) onReleaseTaskEventDetail?.(detailId, task.id);
      else if (getTruncatedTaskEventDetailId(event!)) {
        void onLoadTaskEventDetail?.(detailId, task.id);
      }
    },
    [
      disclosureIntentFor,
      events,
      onLoadTaskEventDetail,
      onReleaseTaskEventDetail,
      task?.id,
      toggleDisclosureIntent,
    ],
  );

  const isImageFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "image";
  }, []);

  const isVideoFileEvent = useCallback((event: TaskEvent): boolean => {
    return getInlinePreviewKindForTaskEvent(event) === "video";
  }, []);

  const shouldRenderTimelineEventInStepFeed = useCallback(
    (event: TaskEvent): boolean => {
      const effectiveType = getEffectiveTaskEventType(event);
      if (isDuplicateContextSummaryEvent(event, events)) {
        return false;
      }
      // A finished compaction should read as "compacted", not keep a spinner on "compacting".
      if (isResolvedContextCompactionStartEvent(event, events)) {
        return false;
      }
      if (isRedundantStageTransitionGroupEvent(event, events)) {
        return false;
      }
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
      // Compact rows list each file change once, on its write/edit/delete call. The separate
      // "Created:"/"Updated:" event stays when it carries an inline image or video preview.
      const filePreviewKind = getInlinePreviewKindForTaskEvent(event);
      if (
        !verboseSteps &&
        filePreviewKind !== "image" &&
        filePreviewKind !== "video" &&
        isFileEventCoveredByToolCall(event, events, workspace?.path)
      ) {
        return false;
      }
      if (isArtifactEventCoveredByFileWrite(event, events)) {
        return false;
      }
      return true;
    },
    [toolCallPairing.claimedResultIds, events, verboseSteps, workspace?.path],
  );

  // Verbose mode keeps the detailed action header (including its duration metadata) as the
  // status affordance. Summary mode uses a quiet activity row, so keep the turn-level timer
  // visible above the conversation like the reference transcript.
  const liveActivityHeaderVisible = useMemo(() => {
    if (!isTaskWorking || !verboseSteps) return false;
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      const item = timelineItems[i];
      if (item.kind !== "action_block") continue;
      return item.events.some(
        (event: TaskEvent) =>
          parallelGroupsByAnchorEventId.has(event.id) ||
          (!suppressedParallelEventIds.has(event.id) && shouldRenderTimelineEventInStepFeed(event)),
      );
    }
    return false;
  }, [
    isTaskWorking,
    parallelGroupsByAnchorEventId,
    shouldRenderTimelineEventInStepFeed,
    suppressedParallelEventIds,
    timelineItems,
    verboseSteps,
  ]);

  // Check if an event has details to show
  const hasEventDetails = useCallback(
    (event: TaskEvent): boolean => {
      const effectiveType = getEffectiveTaskEventType(event);
      if (getTruncatedTaskEventDetailId(event)) return true;
      if (isImageFileEvent(event)) return true;
      if (isVideoFileEvent(event)) return true;
      if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
      if (effectiveType === "follow_up_completed") return true;
      if (
        effectiveType === "context_compaction_started" ||
        effectiveType === "context_compaction_completed" ||
        effectiveType === "context_compaction_failed" ||
        effectiveType === "context_summarized"
      ) {
        return true;
      }
      // Outputs are listed by the turn's file line; the completion row only expands to
      // the checklist when the user still has to act.
      if (effectiveType === "task_completed") {
        return event.payload?.terminalStatus === "needs_user_action";
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
      // A document, sheet, deck or page artifact opens in the side panel from its title and
      // is listed on the turn's file line, so only other artifacts (images, PDFs, logs) expand.
      if (effectiveType === "artifact_created") {
        const artifactPath = typeof event.payload?.path === "string" ? event.payload.path : "";
        return Boolean(artifactPath) && !getSidePanelViewerKind(artifactPath);
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
        "agent_spawn_requested",
        "agent_spawned",
        "agent_message",
        "agent_completed",
        "agent_failed",
        "agent_follow_up_scheduled",
        "agent_follow_up_started",
        "agent_interrupt_requested",
        "agent_interrupt_confirmed",
      ].includes(effectiveType);
    },
    [events, isImageFileEvent, isVideoFileEvent, verboseSteps, workspace?.path],
  );

  // Check if an event is currently expanded using its ID
  // If the event should default expand, clicking toggles it to collapsed (and vice versa)
  const isEventExpanded = useCallback(
    (event: TaskEvent): boolean => {
      return resolveDisclosureExpanded({
        intent: disclosureIntentFor("activity", event.id),
        isCurrent: false,
      });
    },
    [disclosureIntentFor],
  );

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
  const [hasCliInputDomContent, setHasCliInputDomContent] = useState(false);

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

  // Select text in an assistant message to reply to it (SelectionReplyPopover). The reply goes
  // out as a follow-up carrying the quote, through the same options the composer sends with.
  const handleReplyToSelection = useCallback(
    async (reply: string, quote: QuotedAssistantMessage): Promise<boolean> => {
      if (!task?.id || !permissionSettingsLoaded) return false;
      const messageId =
        globalThis.crypto?.randomUUID?.() ||
        `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await onSendMessage(reply, undefined, quote, {
        interactionMode: selectedInteractionMode,
        returnOnAccepted: true,
        messageId,
        ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
      });
      return result !== false;
    },
    [
      onSendMessage,
      permissionSettingsLoaded,
      selectedInteractionMode,
      task?.id,
      taskAccessProfileId,
    ],
  );

  // An answer surface's approved action (SurfaceActions): sent like a message the user typed.
  const handleSurfaceActionPrompt = useCallback(
    async (text: string, origin: SurfaceActionOrigin) => {
      if (!task?.id || !permissionSettingsLoaded) throw new Error("No conversation to send to");
      const messageId =
        globalThis.crypto?.randomUUID?.() ||
        `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await onSendMessage(text, undefined, undefined, {
        interactionMode: selectedInteractionMode,
        returnOnAccepted: true,
        messageId,
        verbatim: true,
        surfaceOrigin: origin,
        ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
      });
      if (result === false) throw new Error("The message was not sent");
    },
    [
      onSendMessage,
      permissionSettingsLoaded,
      selectedInteractionMode,
      task?.id,
      taskAccessProfileId,
    ],
  );
  const handleSurfaceActionOpen = useCallback(
    (url: string) => window.electronAPI.openExternal(url),
    [],
  );
  // A shell code block the user ran from an answer: its output goes back as the next message.
  const handleCodeBlockRunOutput = useCallback(
    async (command: string, result: TerminalBlockRunResult) => {
      if (!permissionSettingsLoaded) return;
      const messageId =
        globalThis.crypto?.randomUUID?.() ||
        `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await onSendMessage(
        buildCodeBlockRunMessage({
          command,
          output: result.output,
          exitCode: result.exitCode,
          outputTruncated: result.truncated,
          tab: { id: result.tabId, label: terminalTabLabel(result.cwd, workspace?.name) },
        }),
        undefined,
        undefined,
        {
          interactionMode: selectedInteractionMode,
          returnOnAccepted: true,
          messageId,
          verbatim: true,
          surfaceOrigin: "code_block",
          ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
        },
      );
    },
    [
      onSendMessage,
      permissionSettingsLoaded,
      selectedInteractionMode,
      taskAccessProfileId,
      workspace?.name,
    ],
  );
  const codeBlockRunTarget = useMemo<CodeBlockRunTarget | undefined>(() => {
    if (!task?.id || !workspace?.id) return undefined;
    return {
      taskId: task.id,
      workspaceId: workspace.id,
      sendOutput: handleCodeBlockRunOutput,
      openTerminalTab: (tabId: string) => {
        window.dispatchEvent(
          new CustomEvent<OpenTerminalTabRequest>(OPEN_TERMINAL_TAB_EVENT, { detail: { tabId } }),
        );
      },
    };
  }, [handleCodeBlockRunOutput, task?.id, workspace?.id]);

  // Programmatic input updates still need a resize pass.
  useEffect(() => {
    if (!pendingProgrammaticResizeRef.current) return;
    pendingProgrammaticResizeRef.current = false;
    autoResizeTextarea(undefined, true);
  }, [inputValue, autoResizeTextarea]);

  // Active placeholder: rotating prompt when available, personality fallback otherwise.
  // getPlaceholder picks at random, so pick once per personality instead of every render.
  const getPersonalityPlaceholder = agentContext.getPlaceholder;
  const personalityPlaceholder = useMemo(
    () => getPersonalityPlaceholder(),
    [getPersonalityPlaceholder],
  );
  // Whitespace alone (a restored draft that is just a line break) reads as empty, so the
  // placeholder is not hidden behind an invisible newline. The DOM flag still covers typing
  // that has not reached inputValue yet.
  const hasCliInputContent =
    inputValue.trim().length > 0 || (hasCliInputDomContent && inputValue.length === 0);
  // Calm keeps the rotating placeholder while the empty composer has focus and uses the
  // native caret; other themes swap the placeholder for their own cursor.
  const showCliPlaceholder = !hasCliInputContent && (isCalm || !isCliInputFocused);
  const showCliEmptyCursor = !hasCliInputContent && isCliInputFocused && !isCalm;
  const placeholderPlaylist = useMemo(
    () => (rotatingPlaceholders.length > 0 ? rotatingPlaceholders : [personalityPlaceholder]),
    [personalityPlaceholder, rotatingPlaceholders],
  );

  // Keep the empty focused cursor attached to the editable area instead of
  // relying on theme-specific padding and prompt-width constants.
  usePositionUpdates(
    showCliEmptyCursor,
    () => {
      const inputAreaEl = mentionContainerRef.current;
      const wrapperEl = cliInputWrapperRef.current;
      if (!inputAreaEl || !wrapperEl) return;

      const inputAreaRect = inputAreaEl.getBoundingClientRect();
      const wrapperRect = wrapperEl.getBoundingClientRect();
      setCursorLeft(inputAreaRect.left - wrapperRect.left);
    },
    mentionContainerRef,
    cliInputWrapperRef,
  );

  // Check if user is near the bottom of the scroll container
  const isNearBottom = useCallback((element: HTMLElement, threshold = 100) => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Whether the reader follows the latest message. Opening a task starts it. Only the
  // reader's own input changes it: scrolling up (wheel, keys, touch, scrollbar) releases it at
  // once, and scrolling back down onto the latest message restores it. Scrolls the app makes
  // itself (landing on an opened task, keeping a row in place, rows being measured) never
  // release it, so a task still loading its rows keeps landing on its newest messages. The
  // feed reads the same state from the container (data-following-latest).
  const pinnedToLatestRef = useRef(true);
  const lastReaderScrollTopRef = useRef(0);
  const readerScrolledUpAtRef = useRef(0);
  const readerInputAtRef = useRef(0);
  const readerPointerDownRef = useRef(false);
  const setPinnedToLatest = useCallback((pinned: boolean) => {
    pinnedToLatestRef.current = pinned;
    const container = mainBodyRef.current;
    if (!container) return;
    if (pinned) container.dataset.followingLatest = "true";
    else delete container.dataset.followingLatest;
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

    // A scroll caused by the feed keeping the reader's row in place is not the reader's own
    // move.
    const anchorAdjusted = container.dataset.readingAnchorAdjusted === "true";
    delete container.dataset.readingAnchorAdjusted;
    const scrollTop = container.scrollTop;
    const movedDown = scrollTop > lastReaderScrollTopRef.current;
    lastReaderScrollTopRef.current = scrollTop;
    const now = performance.now();
    const readerScrolling =
      !anchorAdjusted && (readerPointerDownRef.current || now - readerInputAtRef.current < 400);
    if (readerScrolling) {
      if (!isNearBottom(container, 4)) {
        setPinnedToLatest(false);
      } else if (movedDown && now - readerScrolledUpAtRef.current >= 250) {
        setPinnedToLatest(true);
      }
    }

    const nextAutoScroll = pinnedToLatestRef.current;
    setAutoScroll((prev) => (prev === nextAutoScroll ? prev : nextAutoScroll));
  }, [isNearBottom, setPinnedToLatest]);

  // The reader's own scroll input. A scroll-up gesture releases the latest-message pin before
  // its scroll event arrives.
  useEffect(() => {
    const container = mainBodyRef.current;
    if (!container) return;
    const markInput = () => {
      readerInputAtRef.current = performance.now();
    };
    const releasePin = () => {
      markInput();
      readerScrolledUpAtRef.current = performance.now();
      setPinnedToLatest(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) releasePin();
      else markInput();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") releasePin();
      else if (
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End" ||
        event.key === " "
      ) {
        markInput();
      }
    };
    // Dragging the scrollbar, or selecting text past the edge, scrolls while a pointer is down.
    const onPointerDown = () => {
      readerPointerDownRef.current = true;
      markInput();
    };
    const onPointerUp = () => {
      if (!readerPointerDownRef.current) return;
      readerPointerDownRef.current = false;
      markInput();
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("touchmove", markInput, { passive: true });
    container.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("touchmove", markInput);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [setPinnedToLatest, task?.id]);

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
        incrementRendererPerfCounter(
          "task-scroll.follow_skipped_count",
          rendererPerfLoggingEnabled,
        );
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
    setPinnedToLatest(true);
    lastReaderScrollTopRef.current = 0;
    lastAutoScrollTargetRef.current = null;
  }, [task?.id]);

  // Opening a bot chat: the transcript renders hidden, lands on its newest message and only
  // then appears, so the reader never sees it scroll. Earlier messages load only after the
  // reader scrolls up themselves.
  const taskContentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const [botEventsLoadedTaskId, setBotEventsLoadedTaskId] = useState<string | null>(null);
  const [botHistoryReadyTaskId, setBotHistoryReadyTaskId] = useState<string | null>(null);
  const [botRevealedTaskId, setBotRevealedTaskId] = useState<string | null>(null);
  const [botHistoryUnlockedTaskId, setBotHistoryUnlockedTaskId] = useState<string | null>(null);
  const botEventsLoaded = Boolean(task?.id) && botEventsLoadedTaskId === task?.id;
  const botRevealed = !isBotConversation || botRevealedTaskId === task?.id;
  const botHistoryUnlocked = Boolean(task?.id) && botHistoryUnlockedTaskId === task?.id;
  useEffect(() => {
    if (!isBotConversation || !task?.id || botEventsLoadedTaskId === task.id) return;
    const taskId = task.id;
    if (events.length > 0) {
      setBotEventsLoadedTaskId(taskId);
      return;
    }
    // Usually still loading; a conversation with no stored events counts as loaded soon.
    const timer = window.setTimeout(() => setBotEventsLoadedTaskId(taskId), 1500);
    return () => window.clearTimeout(timer);
  }, [botEventsLoadedTaskId, events.length, isBotConversation, task?.id]);
  // A long conversation fills the window itself; earlier ones wait until the reader scrolls up.
  useEffect(() => {
    if (botEventsLoaded && (hasMoreTimelineHistory || remoteSession) && task?.id) {
      setBotHistoryReadyTaskId(task.id);
    }
  }, [botEventsLoaded, hasMoreTimelineHistory, remoteSession, task?.id]);
  const markBotHistoryReady = useCallback(() => {
    if (task?.id) setBotHistoryReadyTaskId(task.id);
  }, [task?.id]);
  const botReadyToReveal = botEventsLoaded && botHistoryReadyTaskId === task?.id;
  useLayoutEffect(() => {
    const container = mainBodyRef.current;
    if (!isBotConversation || !task?.id || botRevealed || !container) return;
    const taskId = task.id;
    const reveal = () => {
      container.scrollTop = container.scrollHeight;
      setBotRevealedTaskId(taskId);
    };
    if (botReadyToReveal) {
      container.scrollTop = container.scrollHeight;
      // One more frame lets late layout settle before the transcript appears.
      const frame = window.requestAnimationFrame(reveal);
      return () => window.cancelAnimationFrame(frame);
    }
    // Never leave the chat hidden if something above stalls.
    const timer = window.setTimeout(reveal, 3000);
    return () => window.clearTimeout(timer);
  }, [botReadyToReveal, botRevealed, isBotConversation, task?.id]);
  // Only the reader's own scroll-up gesture opens the older history.
  useEffect(() => {
    const container = mainBodyRef.current;
    if (!isBotConversation || !task?.id || !botRevealed || botHistoryUnlocked || !container) {
      return;
    }
    const taskId = task.id;
    const unlock = () => setBotHistoryUnlockedTaskId(taskId);
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) unlock();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") unlock();
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", unlock, { passive: true });
    // Dragging the scrollbar: a press to the right of the content area.
    const onPointerDown = (event: PointerEvent) => {
      if (event.clientX - container.getBoundingClientRect().left >= container.clientWidth) unlock();
    };
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", unlock);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [botHistoryUnlocked, botRevealed, isBotConversation, task?.id]);

  // Replies keep growing after they appear (markdown renders and feed rows are measured in a
  // later pass). While the reader is on the latest message, keep it pinned there, so an opened
  // session lands on its newest messages instead of stopping partway.
  useEffect(() => {
    const content = taskContentRef.current;
    const container = mainBodyRef.current;
    if (!content || !container) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedToLatestRef.current) return;
      const target = getAutoScrollTargetTop(container.scrollHeight, container.clientHeight);
      if (Math.abs(container.scrollTop - target) >= 2) container.scrollTop = target;
    });
    observer.observe(content);
    // The viewport shrinks too, e.g. when the composer grows a line.
    observer.observe(container);
    return () => observer.disconnect();
  }, [task?.id]);

  const reportAttachmentError = (message: string) => {
    const isCurrentOwner = attachmentOwnerFenceRef.current.capture();
    setAttachmentError(message);
    window.setTimeout(() => {
      if (isCurrentOwner()) setAttachmentError(null);
    }, 5000);
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

  const appendPendingAttachments = (files: PendingAttachment[], isCurrentOwner: () => boolean) => {
    if (files.length === 0 || !isCurrentOwner()) return;
    setPendingAttachments((prev) => {
      // React may defer this updater until after another workspace is rendered.
      if (!isCurrentOwner()) return prev;
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
    const isCurrentOwner = attachmentOwnerFenceRef.current.capture();
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
        isCurrentOwner,
      );
    } catch (error) {
      if (!isCurrentOwner()) return;
      console.error("Failed to select files:", error);
      reportAttachmentError("Failed to add attachments. Please try again.");
    }
  };

  const handleRemoveAttachment = (id: string) => {
    const removed = pendingAttachments.find((attachment) => attachment.id === id);
    if (removed?.draftRefId) {
      void onReleaseDraftAttachment?.(removed.draftRefId);
    }
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  useEffect(() => {
    if (!onStageDraftAttachment) return;
    const isCurrentOwner = attachmentOwnerFenceRef.current.capture();
    for (const attachment of pendingAttachments) {
      if (
        attachment.draftRefId ||
        stagingAttachmentIdsRef.current.has(attachment.id) ||
        (!attachment.path && !attachment.dataBase64)
      ) {
        continue;
      }
      stagingAttachmentIdsRef.current.add(attachment.id);
      void onStageDraftAttachment(attachment).then((ref) => {
        stagingAttachmentIdsRef.current.delete(attachment.id);
        if (!isCurrentOwner() || !pendingAttachmentIdsRef.current.has(attachment.id)) {
          if (ref?.refId) void onReleaseDraftAttachment?.(ref.refId);
          return;
        }
        setPendingAttachments((current) =>
          current.map((candidate) =>
            candidate.id === attachment.id
              ? {
                  ...candidate,
                  ...(ref?.refId ? { draftRefId: ref.refId } : {}),
                  ...(ref?.sha256 ? { draftSha256: ref.sha256 } : {}),
                  status: ref ? "available" : "unavailable",
                }
              : candidate,
          ),
        );
        if (!ref) reportAttachmentError(`Could not save ${attachment.name} for later.`);
      });
    }
  }, [
    draftSnapshot?.draftKey,
    onReleaseDraftAttachment,
    onStageDraftAttachment,
    pendingAttachments,
  ]);

  useEffect(() => {
    if (!onDraftPatch || !draftSnapshot?.draftKey) return;
    const activeRefIds = new Set(
      pendingAttachments
        .map((attachment) => attachment.draftRefId)
        .filter((refId): refId is string => Boolean(refId)),
    );
    const nextRefs = [
      ...(draftSnapshot.attachments ?? []).filter((attachment) =>
        activeRefIds.has(attachment.refId),
      ),
      ...pendingAttachments
        .filter(
          (attachment) =>
            attachment.draftRefId &&
            !draftSnapshot.attachments.some((ref) => ref.refId === attachment.draftRefId),
        )
        .map((attachment): DraftAttachmentRef => ({
          refId: attachment.draftRefId as string,
          name: attachment.name,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          size: attachment.size,
          sha256: attachment.draftSha256 ?? "",
          status: attachment.status ?? "available",
        })),
    ];
    const deduped = [
      ...new Map(nextRefs.map((attachment) => [attachment.refId, attachment])).values(),
    ];
    const signature = JSON.stringify(deduped);
    if (signature === lastDraftAttachmentSyncRef.current) return;
    lastDraftAttachmentSyncRef.current = signature;
    if (JSON.stringify(draftSnapshot.attachments ?? []) !== signature) {
      onDraftPatch({ attachments: deduped });
    }
  }, [draftSnapshot, onDraftPatch, pendingAttachments]);

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
    const isCurrentOwner = attachmentOwnerFenceRef.current.capture();

    const droppedFiles = Array.from(event.dataTransfer.files || []);
    try {
      const pending = await Promise.all(
        droppedFiles.map(async (file) => {
          const filePath = (file as File & { path?: string }).path;
          const dataBase64 = await readFileAsBase64(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || `drop-${Date.now()}`,
            size: file.size,
            mimeType: file.type || undefined,
            dataBase64,
            // Keep the native path only as a de-duplication hint. Bytes from
            // drag-and-drop are sent through the renderer-owned data channel;
            // arbitrary renderer paths must never become attachment authority.
            ...(filePath ? { path: undefined } : {}),
          } satisfies PendingAttachment;
        }),
      );

      appendPendingAttachments(pending, isCurrentOwner);
    } catch (error) {
      if (!isCurrentOwner()) return;
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
    const isCurrentOwner = attachmentOwnerFenceRef.current.capture();

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

      appendPendingAttachments(pending, isCurrentOwner);
    } catch (error) {
      if (!isCurrentOwner()) return;
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
              <AttachmentTile
                key={attachment.id}
                attachment={attachment}
                onRemove={() => handleRemoveAttachment(attachment.id)}
                disabled={isUploadingAttachments}
              />
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
    if (!permissionSettingsLoaded) {
      setAttachmentError("Loading access profiles. Try again in a moment.");
      return;
    }
    if (isUploadingAttachments || isPreparingMessage) {
      return;
    }

    const trimmedInput = inputValue.trim();
    const hasAttachments = pendingAttachments.length > 0;
    const pendingFollowUpSubmission = pendingFollowUpSubmissionRef.current;
    if (
      pendingFollowUpSubmission &&
      task?.id === pendingFollowUpSubmission.taskId &&
      pendingFollowUpSubmission.fingerprint === trimmedInput.replace(/\s+/g, " ").toLowerCase() &&
      !hasAttachments
    ) {
      return;
    }
    const unavailableAttachments = pendingAttachments.filter(
      (attachment) =>
        attachment.status === "unavailable" ||
        (Boolean(attachment.draftRefId) && !attachment.path && !attachment.dataBase64),
    );
    const onboardingSlashCommand = parseOnboardingSlashCommand(trimmedInput);
    const appSlashCommand = parseLeadingMessageAppShortcut(trimmedInput);
    const goalSlashCommand = parseLeadingGoalSlashCommand(trimmedInput);

    if (
      isChatActionShortcut(displayedInteractionMode, trimmedInput) &&
      appSlashCommand.shortcut?.action !== "clear"
    ) {
      setAttachmentError(
        "Switch to Smart before using action or skill shortcuts. Your message has been kept.",
      );
      return;
    }

    if (!trimmedInput && !hasAttachments) return;
    if (unavailableAttachments.length > 0) {
      setAttachmentError(
        `Reattach ${unavailableAttachments[0]?.name || "the missing file"} before sending.`,
      );
      return;
    }
    if (
      appSlashCommand.matched &&
      appSlashCommand.shortcut?.action === "clear" &&
      !hasAttachments
    ) {
      if (isBotConversation) {
        setAttachmentError(
          "Use New conversation to start a separate bot conversation; /clear is unavailable here.",
        );
        return;
      }
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      void onDraftAccepted?.(draftRevision);
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
      void onDraftAccepted?.(draftRevision);
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
      void onDraftAccepted?.(draftRevision);
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
      void onDraftAccepted?.(draftRevision);
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
      void onDraftAccepted?.(draftRevision);
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
    const submittedInputValue = inputValue;
    const submittedDraftKey = draftKeyRef.current;
    const submittedDraftRevision = draftRevisionRef.current;
    const submittedDraft = draftSnapshotRef.current;
    const submittedTaskId = task?.id;
    const submittedPendingAttachments = pendingAttachments;
    const submittedIntegrationMentionSpans = integrationMentionSpans;
    const submittedQuotedAssistantMessage = quotedAssistantMessage;
    const submittedWelcomeSuggestionDraft = activeWelcomeSuggestionDraft;
    const isSubmittedDraftCurrent = () =>
      isSameComposerDraftSubmission({
        submittedDraftKey,
        currentDraftKey: draftKeyRef.current,
        submittedRevision: submittedDraftRevision,
        currentRevision: draftRevisionRef.current,
        submittedText: submittedInputValue,
        currentText: inputValueRef.current,
      });
    const clearComposer = (verifySubmission = true) => {
      if (verifySubmission && !isSubmittedDraftCurrent()) return;
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setActiveWelcomeSuggestionDraft(null);
      setQuotedAssistantMessage(null);
      setPendingAttachments([]);
      setIntegrationMentionSpans([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
      setSlashOpen(false);
      setSlashQuery("");
      setSlashTarget(null);
      setModeSuggestions([]);
    };
    const restoreAcceptedComposer = (): boolean => {
      const acceptedDraftClear = acceptedDraftClearRef.current;
      const stillOwnsSubmission = isSameAcceptedComposerDraftFence({
        fenceDraftKey: submittedDraftKey,
        currentDraftKey: draftKeyRef.current,
        fenceTaskId: submittedTaskId,
        currentTaskId: task?.id,
        fenceRevision: submittedDraftRevision,
        currentRevision: draftRevisionRef.current,
      });
      if (
        acceptedDraftClear &&
        isSameAcceptedComposerDraftFence({
          fenceDraftKey: acceptedDraftClear.draftKey,
          currentDraftKey: submittedDraftKey,
          fenceTaskId: acceptedDraftClear.taskId,
          currentTaskId: submittedTaskId,
          fenceRevision: acceptedDraftClear.revision,
          currentRevision: submittedDraftRevision,
        }) &&
        stillOwnsSubmission
      ) {
        pendingProgrammaticResizeRef.current = true;
        setInputValue(submittedInputValue);
        setActiveWelcomeSuggestionDraft(submittedWelcomeSuggestionDraft);
        setQuotedAssistantMessage(submittedQuotedAssistantMessage);
        setPendingAttachments(submittedPendingAttachments);
        setIntegrationMentionSpans(submittedIntegrationMentionSpans);
        acceptedDraftClearRef.current = null;
        return true;
      }
      if (
        acceptedDraftClear &&
        isSameAcceptedComposerDraftFence({
          fenceDraftKey: acceptedDraftClear.draftKey,
          currentDraftKey: submittedDraftKey,
          fenceTaskId: acceptedDraftClear.taskId,
          currentTaskId: submittedTaskId,
          fenceRevision: acceptedDraftClear.revision,
          currentRevision: submittedDraftRevision,
        })
      ) {
        acceptedDraftClearRef.current = null;
      }
      return false;
    };
    const clearAcceptedComposer = async (): Promise<boolean> => {
      const accepted = await clearAcceptedComposerDraft({
        isCurrentSubmission: isSubmittedDraftCurrent,
        clearVisible: () => {
          acceptedDraftClearRef.current = {
            draftKey: submittedDraftKey,
            taskId: submittedTaskId,
            revision: submittedDraftRevision,
            text: submittedInputValue,
          };
          // Hide the accepted text while the durable clear is in flight. The
          // hydration fence prevents an old snapshot from restoring it.
          clearComposer(false);
        },
        // Creating a task selects it before returning. Always retire the
        // original Home draft even if a different editor is now visible.
        clearPersisted: () => onDraftAccepted?.(submittedDraftRevision, submittedDraft),
        restoreVisible: restoreAcceptedComposer,
      });
      if (accepted) {
        acceptedDraftClearRef.current = clearAcceptedComposerDraftFence(
          acceptedDraftClearRef.current,
          {
            draftKey: submittedDraftKey,
            taskId: submittedTaskId,
            revision: submittedDraftRevision,
          },
        );
      }
      return accepted;
    };
    let shouldDeferComposerClear = false;
    let submissionResult: void | boolean | Promise<void | boolean> = undefined;
    let submittedFollowUpMessageId: string | null = null;
    if (hasAttachments) {
      setIsUploadingAttachments(true);
    }

    try {
      if (hasAttachments) {
        importedAttachments = await importAttachmentsToWorkspace();
      }

      // Build native visual attachments from imported workspace files so the
      // executor can read stable paths and process images/video frames.
      const nativeVisualAttachments: ImageAttachment[] =
        workspace?.path && importedAttachments.length > 0
          ? importedAttachments.flatMap((attachment): ImageAttachment[] => {
              const mimeType = guessVisualAttachmentMimeType(
                attachment.fileName,
                attachment.mimeType,
              );
              if (!mimeType) return [];
              return [
                {
                  filePath: joinWorkspaceRelativePath(workspace.path, attachment.relativePath),
                  mimeType: mimeType as ImageAttachment["mimeType"],
                  filename: attachment.fileName,
                  sizeBytes: attachment.size,
                },
              ];
            })
          : [];
      const imagePayload = nativeVisualAttachments.length > 0 ? nativeVisualAttachments : undefined;
      const textPromptAttachments = importedAttachments.filter((attachment) => {
        const mimeType = guessVisualAttachmentMimeType(attachment.fileName, attachment.mimeType);
        return !isVideoVisualAttachmentMimeType(mimeType);
      });

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
        textPromptAttachments,
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
        const created = await onCreateTask(
          title,
          prompt,
          {
            executionMode: "execute",
            taskDomain,
            agentConfig: goalAgentConfig,
            ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
            ...createIntegrationMentionOptions,
          },
          imagePayload,
        );
        if (!isTaskCreationAccepted(created)) {
          sendFailed = true;
          return;
        }

        await clearAcceptedComposer();
        setActiveWelcomeSuggestionDraft(null);
        setAutonomousModeEnabled(false);
        setClarifyingCheckinsEnabled(false);
        setCollaborativeModeEnabled(false);
        setChronicleEnabledForTask(true);
        setPermissionAccessMode(
          resolveNewTaskAccessProfileId({
            remembered: readRememberedAccessProfileId(),
            defaultProfileId: defaultPermissionAccessMode,
            availableProfileIds: [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].map(
              (profile) => profile.id,
            ),
          }),
        );
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
        if (
          shortcut.action === "review" &&
          (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id))
        ) {
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
            ? {
                executionMode: "plan",
                taskDomain,
                ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
                ...createIntegrationMentionOptions,
              }
            : shortcut.action === "review"
              ? {
                  executionMode: "analyze",
                  taskDomain: "auto",
                  collaborativeMode: true,
                  multitaskMode: true,
                  multitaskLaneCount: 4,
                  multitaskAssignmentMode: "auto_split",
                  ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
                  ...createIntegrationMentionOptions,
                }
              : shortcut.action === "cost" || shortcut.action === "diagnostic"
                ? {
                    executionMode: "analyze",
                    taskDomain,
                    ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
                    ...createIntegrationMentionOptions,
                  }
                : {
                    executionMode: "plan",
                    taskDomain,
                    ...(newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {}),
                    ...createIntegrationMentionOptions,
                  };
        const created = await onCreateTask(title, prompt, options, imagePayload);
        if (!isTaskCreationAccepted(created)) {
          sendFailed = true;
          return;
        }

        await clearAcceptedComposer();
        setActiveWelcomeSuggestionDraft(null);
        return;
      }

      // Chat mode reuses the current chat task when one exists, but creates a new
      // task for the first message or when the selected task is not a chat session.
      const shouldCreateFreshTask = shouldCreateFreshTaskForSend({
        executionMode,
        selectedTaskId,
        selectedTaskExecutionMode: task?.agentConfig?.executionMode,
        forceFreshTask:
          appSlashCommand.shortcut?.name === "schedule" || goalSlashCommand.action === "start",
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
          agentConfig: {
            interactionMode: selectedInteractionMode,
            ...(clarifyingCheckinsEnabled
              ? { humanInputPolicy: "legacy_interactive" as const }
              : {}),
          },
          ...createIntegrationMentionOptions,
          ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
        };
        const baseOptions: CreateTaskOptions = collaborativeModeEnabled
          ? { ...modeOptions, collaborativeMode: true }
          : autonomousModeEnabled
            ? { ...modeOptions, autonomousMode: true }
            : modeOptions;
        const options: CreateTaskOptions = {
          ...baseOptions,
          generateTitle: true,
          ...(verificationAgentEnabled ? { verificationAgent: true } : {}),
        };
        const created = await onCreateTask(title, message, options, imagePayload);
        if (!isTaskCreationAccepted(created)) {
          sendFailed = true;
          return;
        }
        setModeDrafts((previous) => {
          const next = { ...previous };
          delete next[modeDraftKey];
          return next;
        });
        // Reset task mode state
        setAutonomousModeEnabled(false);
        setCollaborativeModeEnabled(false);
        setChronicleEnabledForTask(true);
        setPermissionAccessMode(
          resolveNewTaskAccessProfileId({
            remembered: readRememberedAccessProfileId(),
            defaultProfileId: defaultPermissionAccessMode,
            availableProfileIds: [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].map(
              (profile) => profile.id,
            ),
          }),
        );
        setVerificationAgentEnabled(false);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        const submissionRevision = ++modeSubmissionRevisionRef.current;
        const messageId =
          globalThis.crypto?.randomUUID?.() ||
          `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        submittedFollowUpMessageId = messageId;
        const acceptance = createComposerSubmissionAcceptance(
          submittedTaskId || task?.id || "",
          messageId,
        );
        pendingFollowUpSubmissionRef.current = {
          taskId: submittedTaskId || task?.id || "",
          fingerprint: message.trim().replace(/\s+/g, " ").toLowerCase(),
          messageId,
          acceptance,
        };
        // @Browser opens the visible in-app browser for this task right away.
        if (
          selectedIntegrationMentions.some((mention) => mention.id === "builtin:browser-use") &&
          task &&
          !remoteSession &&
          workspace?.path
        ) {
          onOpenBrowserWorkbenchSidebar?.();
        }
        const submission = onSendMessage(
          message,
          imagePayload,
          quotedAssistantMessage ?? undefined,
          {
            interactionMode: selectedInteractionMode,
            integrationMentions: selectedIntegrationMentions,
            returnOnAccepted: true,
            deliveryMode: "follow_up",
            messageId,
            ...(taskAccessProfileId ? { accessProfileId: taskAccessProfileId } : {}),
          },
        );
        // The journal may acknowledge the message before IPC returns. Clear at
        // either durable acknowledgement, without waiting for the provider turn.
        acceptance.observe(rawEvents);
        submissionResult = acceptance.waitFor(submission);
        shouldDeferComposerClear = true;
        // IPC can remain pending for the full turn. Keep the composer available
        // for steering, but restore a failed draft if the user has not moved on.
        void Promise.resolve(submission)
          .then(async (sent) => {
            if (
              sent === false &&
              !acceptance.hasReceipt() &&
              activeModeDraftKeyRef.current === modeDraftKey &&
              modeSubmissionRevisionRef.current === submissionRevision
            ) {
              setInputValue((current) => current || trimmedInput);
              setPendingAttachments((current) => (current.length ? current : pendingAttachments));
            }
            if (pendingFollowUpSubmissionRef.current?.messageId === messageId) {
              if (sent === false && !acceptance.hasReceipt())
                pendingFollowUpSubmissionRef.current = null;
            }
          })
          .catch((error) => {
            if (acceptance.hasReceipt()) return;
            if (
              activeModeDraftKeyRef.current === modeDraftKey &&
              modeSubmissionRevisionRef.current === submissionRevision
            ) {
              setInputValue((current) => current || trimmedInput);
              reportAttachmentError(
                error instanceof Error ? error.message : "Failed to send message.",
              );
            }
            if (pendingFollowUpSubmissionRef.current?.messageId === messageId) {
              pendingFollowUpSubmissionRef.current = null;
            }
          });
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

      if (shouldDeferComposerClear) {
        void Promise.resolve(submissionResult)
          .then(async (sent) => {
            if (!isTaskCreationAccepted(sent)) {
              if (
                submittedFollowUpMessageId &&
                pendingFollowUpSubmissionRef.current?.messageId === submittedFollowUpMessageId
              ) {
                pendingFollowUpSubmissionRef.current = null;
              }
              return;
            }
            // Acceptance clears the submitted owner even if the user has
            // moved to another task while its send was pending.
            await clearAcceptedComposer();
            if (
              submittedFollowUpMessageId &&
              pendingFollowUpSubmissionRef.current?.messageId === submittedFollowUpMessageId
            ) {
              pendingFollowUpSubmissionRef.current = null;
            }
          })
          .catch(() => {
            // The primary submission handler restores the draft and reports the error.
          });
      } else {
        await clearAcceptedComposer();
      }
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

  const mentionMenuShown = mentionOpen && mentionOptions.length > 0;
  const slashMenuShown = slashOpen && slashOptions.length > 0;
  useLayoutEffect(() => {
    if (!mentionMenuShown && !slashMenuShown) return;
    const fit = () => {
      fitComposerMenuWidth(mentionDropdownRef.current);
      fitComposerMenuWidth(slashDropdownRef.current);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [mentionMenuShown, slashMenuShown]);

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
      recordDraftMutation(onDraftValueChange?.(nextValue));
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
        if (isBotConversation) {
          setAttachmentError(
            "Use New conversation to start a separate bot conversation; /clear is unavailable here.",
          );
          return;
        }
        setInputValue("");
        void onDraftAccepted?.(draftRevision);
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
        void onDraftAccepted?.(draftRevision);
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
    recordDraftMutation(onDraftValueChange?.(value));
    recordDraftMutation(onDraftPatch?.({ mentions: nextIntegrationMentionSpans }));
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
      const suggestions = detectModeSuggestions(value, {
        excludeModes,
        maxResults: 2,
        threshold: 0.3,
      });
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
    const nextMentionSpans = replaceIntegrationMentionRange(
      mentionTarget.start,
      mentionTarget.end,
      insertText,
      nextSpan,
    );
    setIntegrationMentionSpans(nextMentionSpans);
    recordDraftMutation(onDraftPatch?.({ mentions: nextMentionSpans }));
    pendingProgrammaticResizeRef.current = true;
    setInputValue(nextValue);
    recordDraftMutation(onDraftValueChange?.(nextValue));
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
        setInteractionMode({ mode: "smart", executionOverride: "plan" });
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
      const optionMascot = option.type === "agent" ? resolveBotMascot(option.icon) : null;
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
          ) : optionMascot ? (
            <BotMascot mascot={optionMascot} size={22} animated={false} />
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
    recordDraftMutation(onDraftValueChange?.(action));
    setIntegrationMentionSpans([]);
    recordDraftMutation(onDraftPatch?.({ mentions: [] }));
    setActiveWelcomeSuggestionDraft(null);
  };

  const handleWelcomeTaskSuggestion = (suggestion: WelcomeTaskSuggestion) => {
    if (suggestion.action.type === "url" && !onOpenWebLinkInSidebar && !onOpenBrowserView) {
      return;
    }
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
    const visibleSuggestions = welcomeTaskSuggestions.filter(
      (suggestion) =>
        suggestion.action.type !== "url" || Boolean(onOpenWebLinkInSidebar || onOpenBrowserView),
    );
    if (visibleSuggestions.length === 0) return null;
    return (
      <section className="welcome-next-actions" aria-label="Next actions">
        <div className="welcome-next-actions-header">
          <span className="welcome-next-actions-title">Next actions</span>
        </div>
        <div className="welcome-next-actions-list">
          {visibleSuggestions.map((suggestion) => {
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
    (title: string, entries: LlmWikiVaultEntry[], emptyLabel: string) => (
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
      summary?.rootFiles.find(
        (entry) => entry.path.endsWith("/index.md") || entry.path === "research/wiki/index.md",
      ) || summary?.rootFiles.find((entry) => entry.path.endsWith("index.md"));

    return (
      <section className="vault-browser-panel" aria-label="Research vault">
        <div className="vault-browser-header">
          <div>
            <div className="vault-browser-kicker">Research vault</div>
            <h2 className="vault-browser-heading">{summary?.displayPath || "research/wiki"}</h2>
            <p className="vault-browser-copy">
              Durable markdown notes, immutable raw captures, and generated outputs that stay in the
              workspace.
            </p>
          </div>
          <div className="vault-browser-actions">
            <button
              type="button"
              className="vault-browser-action"
              onClick={() => handleQuickAction(LLM_WIKI_GUI_PROMPT)}
            >
              Ingest
            </button>
            <button
              type="button"
              className="vault-browser-action"
              onClick={() => handleQuickAction(LLM_WIKI_QUERY_GUI_PROMPT)}
            >
              Query
            </button>
            <button
              type="button"
              className="vault-browser-action"
              onClick={() => handleQuickAction(LLM_WIKI_AUDIT_GUI_PROMPT)}
            >
              Audit
            </button>
            <button
              type="button"
              className="vault-browser-action"
              onClick={() => handleQuickAction(LLM_WIKI_EXPLORE_GUI_PROMPT)}
            >
              Explore
            </button>
            <button
              type="button"
              className="vault-browser-action"
              onClick={() => handleQuickAction(LLM_WIKI_BRIEF_GUI_PROMPT)}
            >
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
              {renderVaultEntryGroup(
                "Core files",
                summary.rootFiles,
                "Initialize the vault to create index, inbox, log, and schema files.",
              )}
              {renderVaultEntryGroup("Recent notes", summary.recentPages, "No durable notes yet.")}
              {renderVaultEntryGroup(
                "Recent queries",
                summary.recentQueries,
                "No filed queries yet.",
              )}
              {renderVaultEntryGroup(
                "Recent outputs",
                summary.recentOutputs,
                "No slide decks or charts yet.",
              )}
              {renderVaultEntryGroup(
                "Recent raw captures",
                summary.recentRawSources,
                "No raw source captures yet.",
              )}
            </div>
          </>
        ) : (
          <div className="vault-browser-empty-state">
            <div className="vault-browser-empty-title">No research vault yet</div>
            <div className="vault-browser-empty-copy">
              Start with a normal prompt. CoWork will create the vault in this workspace and keep it
              durable.
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
    const latest =
      assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
    if (!latest || getEffectiveTaskEventType(latest) !== "task_completed") return latest;

    const completionIndex = filteredEvents.lastIndexOf(latest);
    for (let index = completionIndex - 1; index >= 0; index -= 1) {
      const candidate = filteredEvents[index];
      if (
        getEffectiveTaskEventType(candidate) !== "assistant_message" ||
        candidate.payload?.internal === true
      ) {
        continue;
      }
      if (isCompletionSummaryCoveredByAssistantEvent(latest, candidate)) return candidate;
      break;
    }
    return latest;
  }, [filteredEvents]);

  const {
    cleanedDisplayPrompt,
    trimmedPrompt,
    promptAttachmentNames,
    headerTitle,
    headerTooltip,
    showHeaderTitle,
  } = useMemo(() => deriveTaskHeaderPresentation(task), [task]);

  const isBuildTaskView = Boolean(task) && !isBotConversation && isBuildTask(task);
  const buildPreviewPath = useMemo(
    () =>
      isBuildTaskView
        ? pickBuildPreviewPath(
            statusTaskEventUi.files,
            task?.agentConfig?.executionEnvironment ||
              task?.agentConfig?.executionEnvironmentBinding
              ? (task.agentConfig.executionEnvironmentBinding?.exported ?? []).map(
                  (file) => file.path,
                )
              : undefined,
          )
        : null,
    [
      isBuildTaskView,
      statusTaskEventUi.files,
      task?.agentConfig?.executionEnvironment,
      task?.agentConfig?.executionEnvironmentBinding,
    ],
  );
  const [buildChangesOpen, setBuildChangesOpen] = useState(false);
  useEffect(() => setBuildChangesOpen(false), [task?.id]);
  const buildWorkspacePath = task?.worktreePath || workspace?.path;
  const buildChangedPaths = useMemo(() => {
    const paths = new Map<string, "created" | "modified" | "deleted">();
    if (!isBuildTaskView) return paths;
    for (const file of statusTaskEventUi.files) {
      paths.set(normalizeBuildPath(file.path, buildWorkspacePath), file.action);
    }
    return paths;
  }, [buildWorkspacePath, isBuildTaskView, statusTaskEventUi.files]);
  const buildChanges = useMemo(
    () =>
      buildChangesOpen
        ? deriveBuildChanges(rawEvents, {
            workspacePath: buildWorkspacePath,
            changedPaths: buildChangedPaths,
          })
        : [],
    [buildChangedPaths, buildChangesOpen, buildWorkspacePath, rawEvents],
  );

  // Open the preview by itself the first time a running build writes its page,
  // like a dev server opening the app; it then reloads as the build edits files.
  // Revisiting a finished build never pops it open.
  const autoOpenedBuildPreviewRef = useRef<Set<string>>(new Set());
  const buildIsRunning =
    task?.status === "executing" || task?.status === "planning" || task?.status === "queued";
  useEffect(() => {
    if (!task?.id || !buildPreviewPath || !buildIsRunning) return;
    if (autoOpenedBuildPreviewRef.current.has(task.id)) return;
    autoOpenedBuildPreviewRef.current.add(task.id);
    openWebArtifact(buildPreviewPath);
  }, [buildIsRunning, buildPreviewPath, openWebArtifact, task?.id]);
  const taskWorkingDirectory = task?.worktreePath || workspace?.path || "";
  const taskIdCopyValue = task?.id || "";
  const taskDeeplink = task ? `cowork://tasks/${task.id}` : "";
  const botDeeplink =
    task && isBotConversation && task.assignedAgentRoleId
      ? `cowork://bots/${task.assignedAgentRoleId}/conversations/${task.id}`
      : taskDeeplink;
  const taskOutputSummary = useMemo(
    () => resolveTaskOutputSummaryFromTask(task, events),
    [events, task],
  );
  const taskMarkdown = useMemo(() => {
    if (!task) return "";
    const promptText =
      cleanedDisplayPrompt || task.userPrompt || task.rawPrompt || task.prompt || "";
    return [
      `# ${task.title}`,
      "",
      `- Status: ${task.status}`,
      `- Task ID: ${task.id}`,
      task.sessionId ? `- Session ID: ${task.sessionId}` : null,
      taskWorkingDirectory ? `- Working directory: ${taskWorkingDirectory}` : null,
      `- Link: ${botDeeplink}`,
      task.semanticSummary ? `- Summary: ${task.semanticSummary}` : null,
      "",
      "## Prompt",
      "",
      promptText.trim() || "_No prompt available._",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }, [botDeeplink, cleanedDisplayPrompt, task, taskWorkingDirectory]);
  const botMascotForSender = useMemo(() => buildBotMascotLookup(agentRoles), [agentRoles]);
  const botConversationFirstMessageAt = useMemo(() => {
    if (!isBotConversation) return null;
    const greetings = new BotGreetingTracker();
    for (const event of events) {
      const message = toBotMessage(event);
      if (message && greetings.isShown(event, message)) return message.timestamp;
      if (!message) greetings.isShown(event, null);
    }
    return null;
  }, [events, isBotConversation]);
  const renderBotHistoryMarkdown = useCallback(
    (text: string) => (
      <AssistantMessageContent
        message={text}
        markdownComponents={markdownComponents}
        workspacePath={workspace?.path}
        onOpenViewer={setViewerFilePath}
      />
    ),
    [markdownComponents, workspace?.path],
  );
  const botTranscriptMarkdown = useMemo(() => {
    if (!task || !isBotConversation) return taskMarkdown;
    const transcriptRows = filterBotConversationTranscriptEvents(events)
      .map((event) => {
        const type = getEffectiveTaskEventType(event);
        if (type === "user_message") {
          const message = getUserEventDisplayMessage(event);
          const speaker = getBotTranscriptSpeaker(event);
          return message ? `### ${speaker}\n\n${message}` : "";
        }
        if (type === "assistant_message" || type === "task_completed") {
          const message = getAssistantOrCompletionText(event);
          const displayMessage = formatAgentMessageProtocolForDisplay(message);
          return displayMessage ? `### ${botName || "Bot"}\n\n${displayMessage}` : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
    return [
      `# ${botName || task.title}`,
      "",
      `- Status: ${task.status}`,
      `- Conversation ID: ${task.id}`,
      `- Conversation link: ${botDeeplink}`,
      "",
      "## Transcript",
      "",
      transcriptRows || "_No messages yet._",
    ].join("\n");
  }, [botDeeplink, botName, events, isBotConversation, task, taskMarkdown]);
  const taskAutomationDefaultPrompt = useMemo(() => {
    if (!task) return "";
    if (isBotConversation) {
      // A routine needs a concrete instruction, not the dormant chat seed.
      const latestMessage = [...events]
        .reverse()
        .find(
          (event) =>
            getEffectiveTaskEventType(event) === "user_message" &&
            typeof event.payload?.message === "string" &&
            event.payload.message.trim() &&
            event.payload.message.trim() !== task.prompt?.trim(),
        );
      return latestMessage?.payload?.message?.trim() || "";
    }
    return (
      cleanedDisplayPrompt ||
      task.userPrompt ||
      task.rawPrompt ||
      task.prompt ||
      task.title ||
      ""
    ).trim();
  }, [cleanedDisplayPrompt, events, isBotConversation, task]);

  const closeTaskHeaderMenu = useCallback(() => {
    setShowTaskHeaderMenu(false);
    setShowBotAdvanced(false);
  }, []);

  const copyTaskHeaderMenuText = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy task menu value:", error);
    }
  }, []);

  const handleTaskHeaderMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
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
        menu.querySelectorAll<HTMLButtonElement>(
          "button[data-task-header-menu-option]:not(:disabled)",
        ),
      );
      if (options.length === 0) return;
      const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex >= 0
          ? (currentIndex + offset + options.length) % options.length
          : event.key === "ArrowDown"
            ? 0
            : options.length - 1;
      options[nextIndex]?.focus();
    },
    [closeTaskHeaderMenu],
  );

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
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("toggleTaskPin") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
    )
      return;
    closeTaskHeaderMenu();
    try {
      await window.electronAPI.toggleTaskPin(task.id);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to toggle task pin from header:", error);
    }
  }, [closeTaskHeaderMenu, onTasksChanged, remoteSession, task, workspace?.permissions.write]);

  const handleTaskHeaderRename = useCallback(async () => {
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("renameTask") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
    )
      return;
    closeTaskHeaderMenu();
    const nextTitle = window.prompt(actionLabels.rename, task.title)?.trim();
    if (!nextTitle || nextTitle === task.title) return;
    try {
      await window.electronAPI.renameTask(task.id, nextTitle);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to rename task from header:", error);
      setHeaderActionError("Could not rename. Please try again.");
    }
  }, [
    actionLabels.rename,
    closeTaskHeaderMenu,
    onTasksChanged,
    remoteSession,
    task,
    workspace?.permissions.write,
  ]);

  const handleTaskHeaderArchive = useCallback(async () => {
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("archiveTask") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
    )
      return;
    closeTaskHeaderMenu();
    try {
      await window.electronAPI.archiveTask(task.id);
      onSelectTask?.(null);
      await onTasksChanged?.();
    } catch (error) {
      console.error("Failed to archive task from header:", error);
      setHeaderActionError("Could not archive. Please try again.");
    }
  }, [
    closeTaskHeaderMenu,
    onSelectTask,
    onTasksChanged,
    remoteSession,
    task,
    workspace?.permissions.write,
  ]);

  const handleTaskHeaderFork = useCallback(async () => {
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("forkTaskSession") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
    )
      return;
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
      setHeaderActionError("Could not fork this task. Please try again.");
    }
  }, [
    closeTaskHeaderMenu,
    onSelectTask,
    onTasksChanged,
    remoteSession,
    task,
    workspace?.permissions.write,
  ]);

  const handleTaskHeaderSideChat = useCallback(async () => {
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("forkTaskSession") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true) ||
      !onOpenSideChat
    )
      return;
    closeTaskHeaderMenu();
    await onOpenSideChat({ taskId: task.id });
  }, [closeTaskHeaderMenu, onOpenSideChat, remoteSession, task, workspace?.permissions.write]);

  const handleForkTaskSessionFromEvent = useCallback(
    async (event: TaskEvent) => {
      if (
        !task ||
        remoteSession ||
        !event.id ||
        !hasHostMethod("forkTaskSession") ||
        (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
      )
        return;
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
    [onSelectTask, onTasksChanged, remoteSession, task, workspace?.permissions.write],
  );

  const handleTaskHeaderAddAutomation = useCallback(() => {
    if (
      !task ||
      remoteSession ||
      !hasHostMethod("createRoutine") ||
      (window.coworkBrowserHost === true && workspace?.permissions.write !== true)
    )
      return;
    closeTaskHeaderMenu();
    setShowTaskAutomationModal(true);
  }, [closeTaskHeaderMenu, remoteSession, task, workspace?.permissions.write]);

  const handleTaskHeaderOpenBrowser = useCallback(() => {
    if (!task || remoteSession || !workspace?.path || !onOpenBrowserWorkbenchSidebar) return;
    closeTaskHeaderMenu();
    onOpenBrowserWorkbenchSidebar();
  }, [closeTaskHeaderMenu, onOpenBrowserWorkbenchSidebar, remoteSession, task, workspace?.path]);
  const taskHeaderOpenBrowserUnavailableReason = remoteSession
    ? "The browser workbench is unavailable for remote tasks."
    : !workspace?.path
      ? "Select a workspace before opening the browser."
      : !onOpenBrowserWorkbenchSidebar
        ? (getHostCapabilityReason("browser.interactive") ??
          "The browser workbench is unavailable for this task.")
        : undefined;
  const taskHeaderTaskMutationUnavailableReason =
    window.coworkBrowserHost === true && workspace?.permissions.write !== true
      ? "This workspace is read-only."
      : undefined;
  const taskHeaderForkUnavailableReason = remoteSession
    ? "Forking is unavailable for remote tasks."
    : (taskHeaderTaskMutationUnavailableReason ??
      (!hasHostMethod("forkTaskSession")
        ? (getHostCapabilityReason("tasks.create") ??
          "Forking is not available on this browser host.")
        : undefined));
  const taskHeaderRoutineUnavailableReason = remoteSession
    ? "Routines are unavailable for remote tasks."
    : !workspace?.id
      ? "Select a workspace before creating a routine."
      : (taskHeaderTaskMutationUnavailableReason ??
        (!hasHostMethod("createRoutine")
          ? (getHostCapabilityReason("automation.manage") ??
            "Routine creation is not available on this browser host.")
          : undefined));

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

  const initialPromptAttachmentMetadata = useMemo(() => {
    if (!initialPromptEventId) return [];
    const initialPromptEvent = events.find((event) => event.id === initialPromptEventId);
    return parseUserMessageAttachmentMetadata(initialPromptEvent?.payload?.images);
  }, [events, initialPromptEventId]);

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
    (typeof latestPauseEvent?.payload?.reason === "string"
      ? latestPauseEvent.payload.reason
      : undefined);
  const effectivePauseMessage = useMemo(() => {
    const pauseMessage =
      typeof latestPauseEvent?.payload?.message === "string"
        ? latestPauseEvent.payload.message.trim()
        : "";
    if (!isLowSignalPauseMessage(pauseMessage, effectivePauseReasonCode)) {
      return pauseMessage;
    }
    const assistantFallback = getAssistantOrCompletionText(lastAssistantMessage);
    if (
      assistantFallback &&
      !isLowSignalPauseMessage(assistantFallback, effectivePauseReasonCode)
    ) {
      return assistantFallback;
    }
    const eventFallback = buildPauseDecisionFallbackFromRecentEvents(events, latestPauseEvent);
    if (eventFallback) return eventFallback;
    return isLowSignalPauseMessage(pauseMessage, effectivePauseReasonCode) ? "" : pauseMessage;
  }, [effectivePauseReasonCode, events, lastAssistantMessage, latestPauseEvent]);
  const fullAccessConfirmation = useFullAccessConfirmation();
  const applyPermissionProfileSelect = useCallback(
    (profileId: AccessProfileId) => {
      const profile = [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].find(
        (candidate) => candidate.id === profileId,
      );
      if (!profile) return;

      // A pick sticks: new tasks start with it until the user picks another, including a pick
      // made inside an existing task.
      rememberAccessProfileId(profileId);
      setPermissionAccessMode(profileId as PermissionAccessMode);
      if (task?.id) {
        setSelectedTaskAccessProfileOverride(profileId);
      }
      setShowPermissionDropdown(false);

      // Selecting a profile from the shell-recovery banner is an explicit
      // approval to resume the paused task. Keep ordinary composer changes
      // non-invasive: they only affect the next send.
      const waitingForCommandTools =
        task?.status === "paused" &&
        (effectivePauseReasonCode === "shell_permission_required" ||
          effectivePauseReasonCode === "shell_permission_still_disabled");
      const resolvedProfile = resolveAccessProfileDefinition(profile.id, accessProfiles);
      if (waitingForCommandTools && resolvedProfile.shellAccess !== false) {
        void onSendMessage(
          `Please continue using the ${resolvedProfile.label} access profile.`,
          undefined,
          undefined,
          { accessProfileId: resolvedProfile.id },
        );
      }
    },
    [accessProfiles, effectivePauseReasonCode, onSendMessage, task?.id, task?.status],
  );
  const handlePermissionProfileSelect = useCallback(
    (profileId: AccessProfileId) => {
      const profile = resolveAccessProfileDefinition(profileId, accessProfiles);
      fullAccessConfirmation.request(
        profile.sandbox === "danger-full-access" && profile.approval === "never",
        () => applyPermissionProfileSelect(profileId),
      );
      setShowPermissionDropdown(false);
    },
    [accessProfiles, applyPermissionProfileSelect, fullAccessConfirmation.request],
  );
  const handleOpenAccessProfilePicker = useCallback(() => {
    setShowPermissionDropdown(true);
    window.requestAnimationFrame(() => {
      permissionDropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }, []);
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
    if (!trimmedPrompt || isBotConversation) return null;
    const initialIntegrationMentions = task?.agentConfig?.integrationMentions;
    const nonImageAttachmentNames = getAttachmentNamesWithoutImagePreviews(
      promptAttachmentNames,
      initialPromptAttachmentMetadata,
    );
    return (
      <div className="chat-message user-message">
        <UserMessageImageGallery
          attachments={initialPromptAttachmentMetadata}
          workspacePath={workspace?.path}
          onOpenViewer={setViewerFilePath}
        />
        <CollapsibleUserBubble>
          <UserMessageText
            text={cleanedDisplayPrompt}
            integrationMentions={initialIntegrationMentions}
            markdownComponents={markdownComponents}
          />
          {nonImageAttachmentNames.length > 0 && (
            <div className="bubble-attachments">
              {nonImageAttachmentNames.map((name, i) => (
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
    isBotConversation,
    cleanedDisplayPrompt,
    initialPromptAttachmentMetadata,
    markdownComponents,
    promptAttachmentNames,
    setViewerFilePath,
    task?.agentConfig?.integrationMentions,
    trimmedPrompt,
    workspace?.path,
  ]);
  const hasActiveStructuredInputRequest = Boolean(
    task &&
    inputRequest &&
    (inputRequest.taskId === task.id ||
      childTasks.some(
        (child) =>
          child.id === inputRequest.taskId &&
          child.parentTaskId === task.id &&
          child.agentConfig?.teamWorkItemLane === true,
      )) &&
    onSubmitInputRequest &&
    onDismissInputRequest,
  );
  const [dismissedLegalWorkflowTaskId, setDismissedLegalWorkflowTaskId] = useState<string | null>(
    null,
  );
  const legalWorkflowInvocation = useMemo(
    () => parseLegalWorkflowSlashPrompt(trimmedPrompt),
    [trimmedPrompt],
  );
  const hasUserFollowUpAfterInitialPrompt = useMemo(
    () =>
      events.some((event) => {
        if (getEffectiveTaskEventType(event) !== "user_message") return false;
        if (initialPromptEventId && event.id === initialPromptEventId) return false;
        const message =
          typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
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
    !isBotConversation &&
    !["failed", "cancelled"].includes(task.status),
  );

  // Welcome/Empty state
  const calmAccess: CalmAccessMenuProps = {
    label: selectedAccessProfileLabel,
    notice: profileConstraintNotice,
    selectedId: selectedProfileId,
    isFullAccess: selectedProfileId === BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
    options: [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].map((profile) => ({
      id: profile.id,
      label: profile.label || getAccessProfileLabel(profile.id),
      description: getAccessProfilePresentation(profile, approvalPromptsEnabled).description,
      danger: profile.id === BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
    })),
    onSelect: (id) => handlePermissionProfileSelect(id as AccessProfileId),
    onConfigure: () => onOpenSettings?.("system"),
  };

  const calmHomeNow = new Date();
  const calmGreeting = homeGreeting(calmHomeNow, agentContext.userName);
  const calmStatusLine = homeStatusLine(homeToday);

  // The welcome composer's "More options" menu. Calm places it right after the access
  // shield; other themes keep it later in the left action group.
  const renderWelcomeOverflowMenu = () => (
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
                  className={`goal-mode-switch-track ${autonomousModeEnabled ? "on" : ""}`}
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
                  className={`goal-mode-switch-track ${clarifyingCheckinsEnabled ? "on" : ""}`}
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
                  className={`goal-mode-switch-track ${collaborativeModeEnabled ? "on" : ""}`}
                  aria-hidden="true"
                >
                  <span className="goal-mode-switch-thumb" />
                </span>
              </span>
            </button>
          </div>
          {renderWelcomeTaskDomainRow()}
          <div className="overflow-menu-item" role="none">
            <button
              className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
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
              <span className="goal-mode-toggle-switch-content">
                <span className="goal-mode-toggle-text">
                  <span className="goal-mode-label">Verify</span>
                </span>
                <span
                  className={`goal-mode-switch-track ${verificationAgentEnabled ? "on" : ""}`}
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
                setChronicleEnabledForTask(!chronicleEnabledForTask);
              }}
              data-tooltip="Allow Chronicle screen context for this task"
              role="menuitemcheckbox"
              aria-checked={chronicleEnabledForTask}
              data-overflow-menu-item
            >
              <span className="goal-mode-toggle-switch-content">
                <span className="goal-mode-toggle-text">
                  <span className="goal-mode-label">Chronicle</span>
                </span>
                <span
                  className={`goal-mode-switch-track ${chronicleEnabledForTask ? "on" : ""}`}
                  aria-hidden="true"
                >
                  <span className="goal-mode-switch-thumb" />
                </span>
              </span>
            </button>
          </div>
        </div>
      )}
      {showOverflowMenu && renderWelcomeOverflowSubmenu()}
    </div>
  );

  // Three starters and one way into the full gallery; the gallery replaces the old
  // inline "…" expansion and the separate "See how people use" link.
  const renderCalmSuggestionChips = () => (
    <div className="calm-chips" aria-label="Suggestions">
      {calmSuggestionCards.slice(0, 3).map((card) => (
        <button
          key={card.id}
          type="button"
          className="calm-chip"
          title={card.desc}
          onClick={() => {
            if (card.action.type === "prompt") handleQuickAction(card.action.prompt);
            else onOpenSettings?.(card.action.tab);
            promptInputRef.current?.focus();
          }}
        >
          <span className="calm-chip-icon">{renderFocusedCardIcon(card.iconName, 15)}</span>
          {card.title}
        </button>
      ))}
      <button
        type="button"
        className="calm-chip calm-chip-more"
        onClick={() => setUseCasesOpen(true)}
        title="See how people use CoWork OS"
      >
        More ideas
      </button>
    </div>
  );

  if (!task) {
    return (
      <div className={`main-content${isCalm ? " calm-main calm-welcome" : ""}`}>
        {useCasesOpen && (
          <Suspense fallback={null}>
            <UseCasesGallery
              open={useCasesOpen}
              contained
              onClose={() => setUseCasesOpen(false)}
              onSelect={(prompt) => {
                pendingProgrammaticResizeRef.current = true;
                setInputValue(prompt);
                recordDraftMutation(onDraftValueChange?.(prompt));
              }}
            />
          </Suspense>
        )}
        {fullAccessConfirmation.dialog}
        <div className="main-body welcome-view">
          <div
            className={`welcome-content cli-style${uiDensity === "focused" ? " welcome-content-focused" : ""}`}
          >
            {isCalm && (
              <div className="calm-hero">
                {calmStatusLine ? (
                  <>
                    <p className="calm-hero-eyebrow">{formatHomeDate(calmHomeNow)}</p>
                    <h1 className="calm-greeting">{calmGreeting}</h1>
                    <p className="calm-hero-status">{calmStatusLine}</p>
                  </>
                ) : (
                  <>
                    <p className="calm-hero-eyebrow">{calmGreeting}</p>
                    <h1 className="calm-greeting">How can I help today?</h1>
                  </>
                )}
              </div>
            )}
            {/* Logo */}
            {isCalm ? null : uiDensity === "focused" ? (
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

            {!isCalm && (
              <p className="welcome-positioning modern-only">
                Rent the model. Own everything else.
              </p>
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
            <div className="cli-commands" hidden={isCalm}>
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
                          icon={renderFocusedCardIcon(card.iconName, 22)}
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
                  {showCliPlaceholder && <TypewriterPlaceholder phrases={placeholderPlaylist} />}
                  <PromptComposerInput
                    ref={promptInputRef}
                    className={`welcome-input cli-input input-textarea${
                      !hasCliInputContent ? " input-textarea-empty-placeholder" : ""
                    }${
                      inputValue.length > 0 && !hasCliInputContent ? " input-whitespace-only" : ""
                    }`}
                    value={inputValue}
                    mentions={integrationMentionSpans}
                    ariaLabel="Message"
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onContentPresenceChange={setHasCliInputDomContent}
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

              <BrowserProfileNotice
                notice={profileConstraintNotice}
                onReview={() => {
                  if (isCalm) {
                    const trigger =
                      calmAccessMenuRef.current?.querySelector<HTMLButtonElement>(
                        ".calm-access-button",
                      );
                    trigger?.click();
                    trigger?.focus();
                    return;
                  }
                  setShowPermissionDropdown(true);
                  permissionDropdownRef.current
                    ?.querySelector<HTMLButtonElement>(".permission-access-btn")
                    ?.focus();
                }}
              />

              <div className="welcome-input-footer">
                <div className="input-left-actions">
                  <button
                    className="attachment-btn attachment-btn-left"
                    onClick={handleAttachFiles}
                    disabled={isUploadingAttachments || !hasHostMethod("selectFiles")}
                    title={
                      !hasHostMethod("selectFiles")
                        ? "File uploads are unavailable on this host"
                        : "Add files"
                    }
                    aria-label="Add files"
                  >
                    <Plus size={24} aria-hidden="true" />
                  </button>
                  {/* Calm keeps the task controls (mode, access, options) together on the
                      left; the right side holds only model, voice and send. */}
                  {isCalm && (
                    <>
                      <CalmModeToggle
                        selection={displayedInteractionMode}
                        onChange={setInteractionMode}
                      />
                      {isBrowserHost ? (
                        <div ref={calmAccessMenuRef}>
                          <CalmAccessMenu access={calmAccess} placement="up" />
                        </div>
                      ) : (
                        <CalmAccessMenu access={calmAccess} placement="up" />
                      )}
                      {renderWelcomeOverflowMenu()}
                    </>
                  )}
                  <div className="permission-dropdown-container" ref={permissionDropdownRef}>
                    <button
                      type="button"
                      className={`permission-access-btn ${
                        selectedProfileId === BUILTIN_ACCESS_PROFILE_IDS.fullAccess ? "full" : ""
                      }`}
                      onClick={() => setShowPermissionDropdown((open) => !open)}
                      aria-haspopup="menu"
                      aria-expanded={showPermissionDropdown}
                      aria-label={`Permission access mode: ${selectedAccessProfileLabel}`}
                      title={
                        profileConstraintNotice
                          ? `${selectedAccessProfileLabel} — ${profileConstraintNotice}`
                          : selectedAccessProfileLabel
                      }
                    >
                      {selectedProfileId === BUILTIN_ACCESS_PROFILE_IDS.fullAccess ? (
                        <ShieldAlert size={18} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={18} aria-hidden="true" />
                      )}
                      <span>{selectedAccessProfileLabel}</span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                    {showPermissionDropdown && (
                      <div
                        className="permission-access-dropdown"
                        role="menu"
                        aria-label="Permission access profiles"
                      >
                        {BUILTIN_ACCESS_PROFILES.map((profile) => {
                          const presentation = getAccessProfilePresentation(
                            profile,
                            approvalPromptsEnabled,
                          );
                          return (
                            <button
                              key={profile.id}
                              type="button"
                              className={`permission-access-option ${
                                profile.id === BUILTIN_ACCESS_PROFILE_IDS.fullAccess ? "danger" : ""
                              } ${selectedProfileId === profile.id ? "active" : ""}`}
                              onClick={() => {
                                handlePermissionProfileSelect(profile.id);
                              }}
                              role="menuitemradio"
                              aria-checked={selectedProfileId === profile.id}
                              title={presentation.description}
                            >
                              {profile.id === BUILTIN_ACCESS_PROFILE_IDS.fullAccess ? (
                                <ShieldAlert size={16} aria-hidden="true" />
                              ) : (
                                <ShieldCheck size={16} aria-hidden="true" />
                              )}
                              <span className="permission-access-option-copy">
                                <span className="permission-access-option-title">
                                  {profile.label}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        {accessProfiles.length > 0 && (
                          <div className="permission-access-custom-label">Custom profiles</div>
                        )}
                        {accessProfiles.map((profile) => {
                          const presentation = getAccessProfilePresentation(
                            profile,
                            approvalPromptsEnabled,
                          );
                          return (
                            <button
                              key={profile.id}
                              type="button"
                              className={`permission-access-option ${
                                selectedProfileId === profile.id ? "active" : ""
                              }`}
                              onClick={() => {
                                handlePermissionProfileSelect(profile.id);
                              }}
                              role="menuitemradio"
                              aria-checked={selectedProfileId === profile.id}
                              title={presentation.description}
                            >
                              <SlidersHorizontal size={16} aria-hidden="true" />
                              <span className="permission-access-option-copy">
                                <span className="permission-access-option-title">
                                  {profile.label || getAccessProfileLabel(profile.id)}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className="permission-access-option"
                          onClick={() => {
                            setShowPermissionDropdown(false);
                            onOpenSettings?.("system");
                          }}
                          role="menuitem"
                        >
                          <SlidersHorizontal size={16} aria-hidden="true" />
                          <span className="permission-access-option-copy">
                            <span className="permission-access-option-title">
                              Configure custom profiles
                            </span>
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                  {uiDensity === "focused" && !isCalm ? null : (
                    <>
                      {!isCalm && (
                        <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                          <button
                            className="folder-selector"
                            onClick={handleWorkspaceDropdownToggle}
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
                            <WorkspaceDropdownMenu
                              workspaces={workspacesList}
                              currentWorkspaceId={workspace?.id}
                              onSelect={handleWorkspaceSelect}
                              onSelectNewFolder={handleSelectNewFolder}
                              onUseTempWorkspace={
                                canSwitchToTempWorkspace
                                  ? () => void handleUseTempWorkspace()
                                  : undefined
                              }
                              onRemove={handleWorkspaceRemove}
                              onClose={() => setShowWorkspaceDropdown(false)}
                            />
                          )}
                        </div>
                      )}
                      {!isCalm && renderWelcomeOverflowMenu()}
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
                      {(collaborativeModeEnabled || clarifyingCheckinsEnabled) && (
                        <button
                          className="active-mode-badge"
                          title="Click to reset mode"
                          onClick={() => {
                            setCollaborativeModeEnabled(false);
                            setClarifyingCheckinsEnabled(false);
                          }}
                        >
                          {clarifyingCheckinsEnabled ? "Check-ins" : "Collab"}
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
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
                        disabled={isBrowserHost || voiceInput.state === "processing"}
                        title={
                          isBrowserHost
                            ? "Voice input is available in the desktop app"
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
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                        aria-label="Send message"
                        title="Send message"
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
                        disabled={isBrowserHost || voiceInput.state === "processing"}
                        title={
                          isBrowserHost
                            ? "Voice input is available in the desktop app"
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
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                        aria-label="Send message"
                        title="Send message"
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* Calm keeps the folder picker under the composer, where it sat before the
                Calm home redesign. */}
            {isCalm && (
              <div className="calm-below-composer">
                <div
                  className="workspace-dropdown-container calm-below-folder"
                  ref={workspaceDropdownRef}
                >
                  <button
                    type="button"
                    className="calm-folder-button"
                    onClick={handleWorkspaceDropdownToggle}
                    aria-haspopup="menu"
                    aria-expanded={showWorkspaceDropdown}
                    title={
                      isBrowserHost
                        ? workspace?.name || "Select project"
                        : getWorkspaceStatusFolderLabel(workspace)
                    }
                  >
                    <FolderIcon size={15} />
                    <span className="calm-folder-label">
                      {isBrowserHost
                        ? workspace?.name || "Select project"
                        : getWorkspaceStatusFolderLabel(workspace)}
                    </span>
                    <ChevronDown size={12} aria-hidden="true" />
                  </button>
                  {showWorkspaceDropdown && (
                    <WorkspaceDropdownMenu
                      workspaces={workspacesList}
                      currentWorkspaceId={workspace?.id}
                      onSelect={handleWorkspaceSelect}
                      onSelectNewFolder={handleSelectNewFolder}
                      onUseTempWorkspace={
                        canSwitchToTempWorkspace ? () => void handleUseTempWorkspace() : undefined
                      }
                      onRemove={handleWorkspaceRemove}
                      onClose={() => setShowWorkspaceDropdown(false)}
                    />
                  )}
                </div>
              </div>
            )}
            {uiDensity === "focused" && !isCalm && (
              <div className="input-status-text welcome-input-status">
                <div className="input-status-left">
                  <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                    <button
                      className="input-status-workspace"
                      onClick={handleWorkspaceDropdownToggle}
                      title={
                        isBrowserHost
                          ? workspace?.name || "Select project"
                          : getWorkspaceStatusFolderLabel(workspace)
                      }
                    >
                      <FolderIcon size={14} aria-hidden="true" />
                      <span className="input-status-workspace-path">
                        {isBrowserHost
                          ? workspace?.name || "Select project"
                          : getWorkspaceStatusFolderLabel(workspace)}
                      </span>
                    </button>
                    {showWorkspaceDropdown && (
                      <WorkspaceDropdownMenu
                        workspaces={workspacesList}
                        currentWorkspaceId={workspace?.id}
                        onSelect={handleWorkspaceSelect}
                        onSelectNewFolder={handleSelectNewFolder}
                        onUseTempWorkspace={
                          canSwitchToTempWorkspace ? () => void handleUseTempWorkspace() : undefined
                        }
                        onRemove={handleWorkspaceRemove}
                        onClose={() => setShowWorkspaceDropdown(false)}
                      />
                    )}
                  </div>
                </div>
                <div className="input-status-right">
                  <div className="input-status-mode-wrap" ref={modeDropdownRef}>
                    <InteractionModePicker
                      selection={displayedInteractionMode}
                      open={showModeDropdown}
                      onToggle={() => {
                        setShowDomainDropdown(false);
                        setShowModeDropdown((value) => !value);
                      }}
                      onChange={(selection) => {
                        setInteractionMode(selection);
                        setShowModeDropdown(false);
                      }}
                    />
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
                        return <Icon size={14} aria-hidden />;
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
            {isCalm &&
              (homeToday !== EMPTY_HOME_TODAY ? (
                <CalmHomeToday
                  today={homeToday}
                  signals={homeTodaySignals}
                  onOpenSession={(taskId) => onSelectTask?.(taskId)}
                  onReviewApproval={onReviewApproval}
                  onOpenRoutine={onViewRoutine}
                  onStartTask={async (title, prompt) =>
                    onCreateTask
                      ? (await onCreateTask(
                          title,
                          prompt,
                          newTaskAccessProfileId ? { accessProfileId: newTaskAccessProfileId } : {},
                        )) !== false
                      : false
                  }
                  onDraftPrompt={(prompt) => {
                    handleQuickAction(prompt);
                    promptInputRef.current?.focus();
                  }}
                  onEditSuggestion={(prompt, workspaceId, suggestionId) => {
                    // Same tracking as a welcome suggestion: sending records it as acted on,
                    // and as edited when the prompt changed.
                    handleQuickAction(prompt);
                    setActiveWelcomeSuggestionDraft({
                      workspaceId,
                      suggestionId,
                      originalPrompt: prompt,
                    });
                    promptInputRef.current?.focus();
                  }}
                  onOpenLink={(url) => void window.electronAPI.openExternal(url).catch(() => {})}
                />
              ) : (
                renderCalmSuggestionChips()
              ))}
            {renderWelcomeTaskSuggestions()}
            {!isCalm && (
              <button
                type="button"
                className="use-cases-link use-cases-welcome-link"
                onClick={() => setUseCasesOpen(true)}
              >
                See how people use CoWork OS
              </button>
            )}
          </div>
        </div>

        {/* Suggestion hint in focused mode */}
        {uiDensity === "focused" && !task && !isCalm && (
          <p className="welcome-hint">
            Try: &quot;Help me organize my project files&quot; or &quot;Write a summary report
            about...&quot;
          </p>
        )}

        {/* Modal for skills with parameters - Welcome View */}
        {selectedSkillForParams && (
          <Suspense fallback={null}>
            <SkillParameterModal
              skill={selectedSkillForParams.skill}
              onSubmit={handleSkillParamSubmit}
              onAskInChat={
                selectedSkillForParams.launchMode === "slash" ? handleSkillAskInChat : undefined
              }
              onCancel={handleSkillParamCancel}
            />
          </Suspense>
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
      codeBlockRunTarget={codeBlockRunTarget}
      onOpenSettings={onOpenSettings}
      activityGroupsById={statusActivityGroupsById}
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
      disclosureIntents={disclosureIntents}
      toggleDisclosureIntent={toggleDisclosureIntent}
      handleCanvasClose={handleCanvasClose}
      handleMessageFeedback={handleMessageFeedback}
      handleStepFeedback={handleStepFeedback}
      isChatTask={isChatTask}
      isTaskWorking={isTaskWorking}
      newActivityCount={newActivityCount}
      onNewActivityCountChange={setNewActivityCount}
      isReplayMode={isReplayMode}
      defaultTranscriptMode={defaultTranscriptMode}
      transcriptMode={transcriptMode}
      returnToDefaultTranscript={returnToDefaultTranscript}
      markdownComponents={markdownComponents}
      mainBodyRef={mainBodyRef}
      messageFeedbackMap={messageFeedbackMap}
      onOpenBrowserView={onOpenBrowserView}
      onOpenSpreadsheetArtifact={openSpreadsheetArtifact}
      onOpenDocumentArtifact={openDocumentArtifact}
      onOpenPresentationArtifact={openPresentationArtifact}
      onOpenWebArtifact={openWebArtifact}
      openFileInPanel={openFileInPanel}
      botName={botName}
      botIcon={botIcon}
      botMascotForSender={botMascotForSender}
      onForkTaskSessionFromEvent={
        remoteSession ||
        !hasHostMethod("forkTaskSession") ||
        (isBrowserHost && workspace?.permissions.write !== true)
          ? undefined
          : handleForkTaskSessionFromEvent
      }
      onSelectChildTask={onSelectChildTask}
      onOpenChildAgentSidebar={onOpenChildAgentSidebar}
      onViewTaskOutputs={onViewTaskOutputs}
      parallelGroupsByAnchorEventId={parallelGroupsByAnchorEventId}
      rejectMenuOpenFor={rejectMenuOpenFor}
      rejectMenuRef={rejectMenuRef}
      renderCommandOutputs={renderCommandOutputs}
      setRejectMenuOpenFor={setRejectMenuOpenFor}
      setStepFeedbackOpen={setStepFeedbackOpen}
      setStepFeedbackText={setStepFeedbackText}
      setViewerFilePath={setViewerFilePath}
      formatTime={formatTime}
      shouldRenderTimelineEventInStepFeed={shouldRenderTimelineEventInStepFeed}
      toolCallPairing={toolCallPairing}
      hasEventDetails={hasEventDetails}
      isEventExpanded={isEventExpanded}
      stepFeedbackOpen={stepFeedbackOpen}
      stepFeedbackSending={stepFeedbackSending}
      stepFeedbackText={stepFeedbackText}
      suppressedParallelEventIds={suppressedParallelEventIds}
      task={task}
      timelineItems={timelineItems}
      timelineRef={timelineRef}
      toggleEventExpanded={toggleEventExpanded}
      verboseSteps={verboseSteps}
      voiceEnabled={voiceEnabled}
      rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
      taskSwitchId={taskSwitchId}
      hasMoreTimelineHistory={
        isBotConversation && !botHistoryUnlocked ? false : hasMoreTimelineHistory
      }
      isLoadingTimelineHistory={isLoadingTimelineHistory}
      timelineHistoryError={timelineHistoryError}
      onLoadMoreTimelineHistory={onLoadMoreTimelineHistory}
      wrappingUp={wrappingUp}
      onWrapUp={collaborativeRun && onWrapUpTask ? handleWrapUp : undefined}
      workspace={workspace}
    />
  );

  const renderMainHeader = (header: React.ReactNode) =>
    titleBarSlot
      ? createPortal(
          <div
            className={`title-bar-context-header${isBotConversation ? " bot-conversation" : ""}${
              isCalm ? " calm-task" : ""
            }`}
          >
            {header}
          </div>,
          titleBarSlot,
        )
      : header;

  // Task view
  return (
    <div
      className={`main-content${isBotConversation ? " bot-conversation" : ""}${
        isCalm ? " calm-main calm-task" : ""
      }`}
    >
      {fullAccessConfirmation.dialog}
      {/* Header: in the app title bar when the shell provides a slot for it */}
      {renderMainHeader(
        <div className="main-header">
          {!isBotConversation && (task?.parentTaskId || task?.branchFromTaskId) && onSelectTask && (
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
            {isBotConversation && (
              <button
                type="button"
                className="bot-conversation-identity"
                disabled={Boolean(remoteSession) || !task?.assignedAgentRoleId}
                onClick={() => setShowBotProfile(true)}
                title="Edit bot"
                aria-label={`Edit bot ${botName}`}
              >
                <span
                  className={`bot-conversation-identity-avatar${botMascot ? " bot-conversation-identity-avatar-mascot" : ""}`}
                  aria-hidden="true"
                >
                  {botMascot ? (
                    <BotMascot mascot={botMascot} size={30} expression={botMascotExpression} />
                  ) : (
                    <BotGlyph size={17} />
                  )}
                </span>
                <span className="bot-conversation-identity-copy">
                  <strong>{botName}</strong>
                  <small>Bot</small>
                </span>
              </button>
            )}
            {headerPlacement === "title-bar" &&
              !isBotConversation &&
              workspace?.name &&
              !workspace.isTemp &&
              !isTempWorkspaceId(workspace.id) && (
                <span className="main-header-crumb" title={workspace.path}>
                  {workspace.name}
                  <span className="main-header-crumb-sep" aria-hidden="true">
                    /
                  </span>
                </span>
              )}
            {!isBotConversation && (showHeaderTitle || task) && headerTitle.trim().length > 0 && (
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
                  aria-label={menuLabel}
                  title={menuLabel}
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
                    aria-label={menuLabel}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={handleTaskHeaderMenuKeyDown}
                  >
                    {isBotConversation ? (
                      <>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={Boolean(remoteSession) || !task.assignedAgentRoleId}
                          onClick={() => {
                            closeTaskHeaderMenu();
                            setShowBotProfile(true);
                          }}
                        >
                          <BotGlyph size={17} weight="regular" />
                          <span>Edit bot</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={Boolean(remoteSession) || !task.assignedAgentRoleId}
                          onClick={() => {
                            closeTaskHeaderMenu();
                            void onNewBotConversation?.(task.assignedAgentRoleId!);
                          }}
                        >
                          <Plus size={17} aria-hidden="true" />
                          <span>New conversation</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          onClick={() => {
                            closeTaskHeaderMenu();
                            setShowBotHistory((open) => !open);
                          }}
                          aria-expanded={showBotHistory}
                        >
                          <History size={17} aria-hidden="true" />
                          <span>Conversation history</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("toggleTaskPin")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("toggleTaskPin")
                              ? "Pinning is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderPin}
                        >
                          {task.pinned ? (
                            <PinOff size={17} aria-hidden="true" />
                          ) : (
                            <Pin size={17} aria-hidden="true" />
                          )}
                          <span>{task.pinned ? actionLabels.unpin : actionLabels.pin}</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("renameTask")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("renameTask")
                              ? "Renaming is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderRename}
                        >
                          <Pencil size={17} aria-hidden="true" />
                          <span>{actionLabels.rename}</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("archiveTask")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("archiveTask")
                              ? "Archiving is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderArchive}
                        >
                          <ArchiveIcon size={17} aria-hidden="true" />
                          <span>{actionLabels.archive}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("toggleTaskPin")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("toggleTaskPin")
                              ? "Pinning is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderPin}
                        >
                          {task.pinned ? (
                            <PinOff size={17} aria-hidden="true" />
                          ) : (
                            <Pin size={17} aria-hidden="true" />
                          )}
                          <span>{task.pinned ? actionLabels.unpin : actionLabels.pin}</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("renameTask")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("renameTask")
                              ? "Renaming is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderRename}
                        >
                          <Pencil size={17} aria-hidden="true" />
                          <span>{actionLabels.rename}</span>
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={
                            Boolean(remoteSession) ||
                            Boolean(taskHeaderTaskMutationUnavailableReason) ||
                            !hasHostMethod("archiveTask")
                          }
                          title={
                            taskHeaderTaskMutationUnavailableReason ??
                            (!hasHostMethod("archiveTask")
                              ? "Archiving is not available on this browser host."
                              : undefined)
                          }
                          onClick={handleTaskHeaderArchive}
                        >
                          <ArchiveIcon size={17} aria-hidden="true" />
                          <span>{actionLabels.archive}</span>
                        </button>
                        <div className="main-header-task-menu-divider" role="separator" />
                      </>
                    )}
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      disabled={
                        Boolean(remoteSession) || !workspace?.path || !onOpenBrowserWorkbenchSidebar
                      }
                      title={taskHeaderOpenBrowserUnavailableReason}
                      aria-label={
                        taskHeaderOpenBrowserUnavailableReason
                          ? `Open browser unavailable. ${taskHeaderOpenBrowserUnavailableReason}`
                          : "Open browser"
                      }
                      onClick={handleTaskHeaderOpenBrowser}
                    >
                      <Globe size={17} aria-hidden="true" />
                      <span>Open browser</span>
                    </button>
                    {!remoteSession && workspace?.path && !onOpenBrowserWorkbenchSidebar && (
                      <div className="main-header-task-menu-note" role="note">
                        {taskHeaderOpenBrowserUnavailableReason}
                      </div>
                    )}
                    {!isBotConversation && (
                      <>
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
                          <span>{actionLabels.copyId}</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      onClick={() => {
                        closeTaskHeaderMenu();
                        void copyTaskHeaderMenuText(botDeeplink);
                      }}
                    >
                      <LinkIcon size={17} aria-hidden="true" />
                      <span>{actionLabels.copyLink}</span>
                    </button>
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      onClick={() => {
                        closeTaskHeaderMenu();
                        void copyTaskHeaderMenuText(
                          isBotConversation ? botTranscriptMarkdown : taskMarkdown,
                        );
                      }}
                    >
                      <ClipboardCopy size={17} aria-hidden="true" />
                      <span>Copy as Markdown</span>
                    </button>
                    {isBotConversation ? (
                      <>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={Boolean(taskHeaderForkUnavailableReason)}
                          title={taskHeaderForkUnavailableReason}
                          aria-label={
                            taskHeaderForkUnavailableReason
                              ? `${actionLabels.fork} unavailable. ${taskHeaderForkUnavailableReason}`
                              : actionLabels.fork
                          }
                          onClick={handleTaskHeaderFork}
                        >
                          <GitFork size={17} aria-hidden="true" />
                          <span>{actionLabels.fork}</span>
                        </button>
                        {onOpenSideChat && (
                          <button
                            type="button"
                            className="main-header-task-menu-item"
                            role="menuitem"
                            data-task-header-menu-option
                            disabled={Boolean(taskHeaderForkUnavailableReason)}
                            title={taskHeaderForkUnavailableReason}
                            aria-label={
                              taskHeaderForkUnavailableReason
                                ? `Open side chat unavailable. ${taskHeaderForkUnavailableReason}`
                                : "Open side chat"
                            }
                            onClick={handleTaskHeaderSideChat}
                          >
                            <MessageCircle size={17} aria-hidden="true" />
                            <span>Open side chat</span>
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="main-header-task-menu-divider" role="separator" />
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitem"
                          data-task-header-menu-option
                          disabled={Boolean(taskHeaderForkUnavailableReason)}
                          title={taskHeaderForkUnavailableReason}
                          aria-label={
                            taskHeaderForkUnavailableReason
                              ? `${actionLabels.fork} unavailable. ${taskHeaderForkUnavailableReason}`
                              : actionLabels.fork
                          }
                          onClick={handleTaskHeaderFork}
                        >
                          <GitFork size={17} aria-hidden="true" />
                          <span>{actionLabels.fork}</span>
                        </button>
                        {onOpenSideChat && (
                          <button
                            type="button"
                            className="main-header-task-menu-item"
                            role="menuitem"
                            data-task-header-menu-option
                            disabled={Boolean(taskHeaderForkUnavailableReason)}
                            title={taskHeaderForkUnavailableReason}
                            aria-label={
                              taskHeaderForkUnavailableReason
                                ? `Open side chat unavailable. ${taskHeaderForkUnavailableReason}`
                                : "Open side chat"
                            }
                            onClick={handleTaskHeaderSideChat}
                          >
                            <MessageCircle size={17} aria-hidden="true" />
                            <span>Open side chat</span>
                          </button>
                        )}
                      </>
                    )}
                    {taskHeaderForkUnavailableReason && (
                      <div className="main-header-task-menu-note" role="note">
                        {taskHeaderForkUnavailableReason}
                      </div>
                    )}
                    <button
                      type="button"
                      className="main-header-task-menu-item"
                      role="menuitem"
                      data-task-header-menu-option
                      disabled={Boolean(taskHeaderRoutineUnavailableReason)}
                      title={taskHeaderRoutineUnavailableReason}
                      aria-label={
                        taskHeaderRoutineUnavailableReason
                          ? `Create routine unavailable. ${taskHeaderRoutineUnavailableReason}`
                          : "Create routine"
                      }
                      onClick={handleTaskHeaderAddAutomation}
                    >
                      <Clock size={17} aria-hidden="true" />
                      <span>Create routine...</span>
                    </button>
                    {taskHeaderRoutineUnavailableReason && (
                      <div className="main-header-task-menu-note" role="note">
                        {taskHeaderRoutineUnavailableReason}
                      </div>
                    )}
                    {!isBotConversation && (
                      <>
                        <div className="main-header-task-menu-divider" role="separator" />
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitemcheckbox"
                          aria-checked={verboseSteps}
                          data-task-header-menu-option
                          onClick={() => {
                            closeTaskHeaderMenu();
                            toggleVerboseSteps();
                          }}
                        >
                          <ListTree size={17} aria-hidden="true" />
                          <span>Verbose timeline</span>
                          {verboseSteps && (
                            <CheckIcon
                              className="main-header-task-menu-check"
                              size={14}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        <button
                          type="button"
                          className="main-header-task-menu-item"
                          role="menuitemcheckbox"
                          aria-checked={codePreviewsExpanded}
                          data-task-header-menu-option
                          onClick={() => {
                            closeTaskHeaderMenu();
                            toggleCodePreviews();
                          }}
                        >
                          <Code size={17} aria-hidden="true" />
                          <span>Expand code previews</span>
                          {codePreviewsExpanded && (
                            <CheckIcon
                              className="main-header-task-menu-check"
                              size={14}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        {replayControls &&
                          !replayControls.isReplayMode &&
                          (task.status === "completed" ||
                            task.status === "failed" ||
                            task.status === "cancelled") && (
                            <button
                              type="button"
                              className="main-header-task-menu-item"
                              role="menuitem"
                              data-task-header-menu-option
                              onClick={() => {
                                closeTaskHeaderMenu();
                                replayControls.startReplay();
                              }}
                            >
                              <Play size={17} aria-hidden="true" />
                              <span>Replay session</span>
                            </button>
                          )}
                        {replayControls?.isReplayMode && !replayControls.areControlsVisible && (
                          <button
                            type="button"
                            className="main-header-task-menu-item"
                            role="menuitem"
                            data-task-header-menu-option
                            onClick={() => {
                              closeTaskHeaderMenu();
                              replayControls.showControls();
                            }}
                          >
                            <SlidersHorizontal size={17} aria-hidden="true" />
                            <span>Show replay controls</span>
                          </button>
                        )}
                      </>
                    )}
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
                    {isBotConversation && (
                      <button
                        type="button"
                        className="main-header-task-menu-item"
                        role="menuitem"
                        data-task-header-menu-option
                        aria-expanded={showBotAdvanced}
                        aria-controls="bot-advanced-actions"
                        onClick={() => setShowBotAdvanced((open) => !open)}
                      >
                        <SlidersHorizontal size={17} aria-hidden="true" />
                        <span>Advanced</span>
                      </button>
                    )}
                    {isBotConversation && showBotAdvanced && (
                      <div id="bot-advanced-actions" role="group" aria-label="Advanced actions">
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
                          <span>{actionLabels.copyId}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>,
      )}
      {isBotConversation && showBotHistory && (
        <BotConversationHistory
          botName={botName || "Bot"}
          botRoleId={task?.assignedAgentRoleId}
          selectedConversationId={task?.id}
          conversations={botConversations}
          loading={isLoadingBotConversations}
          selectedConversationProjection={conversationProjection}
          onSelectConversation={onSelectBotConversation || onSelectTask || undefined}
          onNewConversation={onNewBotConversation}
        />
      )}
      {/* Body */}
      <SurfaceActionProvider
        scopeKey={task?.id}
        onSendPrompt={handleSurfaceActionPrompt}
        onOpenLink={handleSurfaceActionOpen}
      >
        <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
          {!isBotConversation && (
            <SelectionReplyPopover
              containerRef={mainBodyRef}
              agentName={agentContext.agentName || "CoWork"}
              onReply={handleReplyToSelection}
            />
          )}
          <div
            className={`task-content${botRevealed ? "" : " bot-transcript-pending"}`}
            ref={taskContentRef}
          >
            {isBotConversation && task && !remoteSession && (
              <BotEarlierConversations
                key={task.id}
                currentTask={task}
                botName={botName || "Bot"}
                botMascot={botMascot}
                scrollContainerRef={mainBodyRef}
                loadInitialPage={botEventsLoaded && !hasMoreTimelineHistory}
                onInitialPageDone={markBotHistoryReady}
                canLoadMore={
                  botHistoryUnlocked && !hasMoreTimelineHistory && !isLoadingTimelineHistory
                }
                currentFirstMessageAt={botConversationFirstMessageAt}
                renderMarkdown={renderBotHistoryMarkdown}
                mascotForSender={botMascotForSender}
              />
            )}
            {/* Always anchor the initial user prompt above the timeline. */}
            {initialPromptBubble}
            {isBotConversation && task && (
              <BotCollaborationHeader
                task={task}
                botName={botName || "Bot"}
                botIcon={botIcon}
                events={events}
                childEvents={childEvents}
                childTasks={childTasks}
                botConversations={botConversations}
                onOpenBotConversation={onSelectBotConversation}
                conversationProjection={conversationProjection}
              />
            )}
            {showLegalWorkflowCard &&
              (legalWorkflowInvocation.kind === "demand-intake" ? (
                <Suspense
                  fallback={
                    <div className="input-request-card" role="status">
                      Loading questions…
                    </div>
                  }
                >
                  <LegalDemandIntakePromptCard
                    prompt={trimmedPrompt}
                    onSubmit={(message) => {
                      onSendMessage(message);
                      setDismissedLegalWorkflowTaskId(task.id);
                    }}
                    onDismiss={() => setDismissedLegalWorkflowTaskId(task.id)}
                  />
                </Suspense>
              ) : (
                <Suspense
                  fallback={
                    <div className="input-request-card" role="status">
                      Loading questions…
                    </div>
                  }
                >
                  <GenericLegalWorkflowPromptCard
                    invocation={legalWorkflowInvocation}
                    onSubmit={(message) => {
                      onSendMessage(message);
                      setDismissedLegalWorkflowTaskId(task.id);
                    }}
                    onDismiss={() => setDismissedLegalWorkflowTaskId(task.id)}
                  />
                </Suspense>
              ))}

            {task?.agentConfig?.executionMode === "debug" && (
              <Suspense fallback={null}>
                <DebugSessionPanel events={events} />
              </Suspense>
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
            {!isBotConversation &&
              (hasNonConversationEvents || isTaskWorking || isTaskFinished) &&
              (!turnHeadersShown || Boolean(isTaskWorking && continuationStatusChip)) && (
                <div className={`timeline-controls ${turnHeadersShown ? "with-turn-headers" : ""}`}>
                  <div className="timeline-controls-status">
                    {turnHeadersShown ? null : canToggleCompletedTranscript ? (
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
                          <ChevronRight size={14} strokeWidth={2} />
                        </span>
                      </button>
                    ) : liveActivityHeaderVisible ? null : (
                      <span
                        className={`timeline-controls-label ${
                          isTaskWorking || isTaskFinished ? "with-duration" : ""
                        }`}
                      >
                        {workDurationLabel}
                      </span>
                    )}
                    {isTaskWorking && continuationStatusChip && (
                      <span
                        className="header-continuation-chip"
                        title="Adaptive continuation status"
                      >
                        <span>{continuationStatusChip.window}</span>
                        {continuationStatusChip.progress && (
                          <span className="header-continuation-chip-sep">·</span>
                        )}
                        {continuationStatusChip.progress && (
                          <span>{continuationStatusChip.progress}</span>
                        )}
                        {continuationStatusChip.loopRisk && (
                          <span className="header-continuation-chip-sep">·</span>
                        )}
                        {continuationStatusChip.loopRisk && (
                          <span>{continuationStatusChip.loopRisk}</span>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              )}

            {/* Replay controls bar — shown when replay mode is active */}
            {replayControls?.isReplayMode && replayControls.areControlsVisible && (
              <Suspense fallback={null}>
                <ReplayControlsBar controls={replayControls} />
              </Suspense>
            )}

            {task &&
            (task.agentConfig?.executionEnvironment ||
              task.agentConfig?.executionEnvironmentBinding) ? (
              <TaskComputerPanel task={task} />
            ) : null}
            <Suspense
              fallback={
                <div className="task-conversation-loading" role="status">
                  Loading conversation…
                </div>
              }
            >
              {conversationFlow}
            </Suspense>
            {/* A bot's earlier conversations scroll in above instead. */}
            {!isBotConversation && (
              <TaskSessionLineageFooter task={task} onSelectTask={onSelectTask} />
            )}
          </div>
        </div>
        <ModelGalleryHost />
      </SurfaceActionProvider>

      {headerActionError && (
        <div className="task-header-action-error" role="alert">
          {headerActionError}
        </div>
      )}
      {showBotProfile && task?.assignedAgentRoleId && !remoteSession && (
        <BotProfileDialog
          botId={task.assignedAgentRoleId}
          onClose={() => setShowBotProfile(false)}
          onDeleted={() => onSelectTask?.(null)}
        />
      )}
      {/* Footer with Input */}
      <div className="main-footer">
        {/* Scroll to bottom button — only when there is actually content above the fold */}
        {!autoScroll &&
          task &&
          mainBodyRef.current &&
          mainBodyRef.current.scrollHeight -
            mainBodyRef.current.scrollTop -
            mainBodyRef.current.clientHeight >
            20 && (
            <button
              className="scroll-to-bottom-btn"
              onClick={() => {
                if (mainBodyRef.current) {
                  mainBodyRef.current.scrollTo({
                    top: mainBodyRef.current.scrollHeight,
                    // A bot chat keeps growing as replies render; a smooth scroll chases a
                    // moving target and its midway positions switch following off.
                    behavior: isBotConversation ? "auto" : "smooth",
                  });
                  setAutoScroll(true);
                  setPinnedToLatest(true);
                }
              }}
              title="Scroll to bottom"
              aria-label="Scroll to bottom"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 3v9" />
                <path d="M4 8.5 8 12.5l4-4" />
              </svg>
            </button>
          )}
        {renderAttachmentPanel()}
        {buildChangesOpen && isBuildTaskView && (
          <Suspense fallback={null}>
            <BuildChangesPanel
              changes={buildChanges}
              onClose={() => setBuildChangesOpen(false)}
              onOpenFile={(path) => {
                setBuildChangesOpen(false);
                const absolute =
                  buildWorkspacePath && !path.startsWith("/")
                    ? `${buildWorkspacePath.replace(/\/+$/, "")}/${path}`
                    : path;
                if (onViewTaskOutputs) onViewTaskOutputs(task.id, absolute);
                else setViewerFilePath(absolute);
              }}
            />
          </Suspense>
        )}
        {/* The run's status sits above the composer as its own bar. The wrapper tucks
            under the composer with a negative margin, so render it only when the strip
            shows; an empty wrapper lifts the composer under the footer fade. */}
        {taskStatusStripEnabled && !isBotConversation && taskStatusStripModel.visible && (
          <div className="composer-status-strip">
            <TaskStatusStrip
              model={taskStatusStripModel}
              activityGroups={statusTaskEventUi.activityGroups}
              outcomeMetrics={statusTaskEventUi.outcomeMetrics}
              markdownComponents={markdownComponents}
              leading={isBuildTaskView ? <BuildStripBadge /> : undefined}
              actions={
                (isBuildTaskView && (buildChangedPaths.size > 0 || buildPreviewPath)) ||
                showSubAgentsStripButton ? (
                  <>
                    {showSubAgentsStripButton && onViewSubAgents && (
                      <SubAgentsStripButton count={childTasks.length} onOpen={onViewSubAgents} />
                    )}
                    {isBuildTaskView && buildChangedPaths.size > 0 && (
                      <BuildChangesButton
                        count={buildChangedPaths.size}
                        onOpen={() => setBuildChangesOpen(true)}
                      />
                    )}
                    {isBuildTaskView && buildPreviewPath && (
                      <BuildPreviewButton path={buildPreviewPath} onOpen={openWebArtifact} />
                    )}
                  </>
                ) : undefined
              }
              replay={isReplayMode}
              livePlan={livePlan}
              livePlanScopeKey={task.id}
              telemetryEnabled={rendererPerfLoggingEnabled}
              // RightPanel only renders its Files section when it has file rows, and it
              // never shows Impact, so only defer Outputs when those rows exist.
              hideOutputs={rightPanelOpen && statusTaskEventUi.files.length > 0}
              onOpenOutput={(outputPath) => {
                if (onViewTaskOutputs) {
                  onViewTaskOutputs(task.id, outputPath);
                } else if (outputPath) {
                  setViewerFilePath(outputPath);
                }
              }}
            />
          </div>
        )}
        <div
          className={`input-container ${isDraggingFiles ? "drag-over" : ""}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {routineCreationNotice?.taskId === task.id && (
            <div className="task-automation-created-response" role="status">
              <div>
                <strong>Automation created</strong>
                <span>
                  {routineCreationNotice.name} is saved with {routineCreationNotice.triggerSummary}.
                </span>
              </div>
              <button
                type="button"
                disabled={!onViewRoutine || !routineCreationNotice.routineId}
                title={!onViewRoutine ? "Automation Library navigation is unavailable." : undefined}
                onClick={() => {
                  if (routineCreationNotice.routineId)
                    onViewRoutine?.(routineCreationNotice.routineId);
                }}
              >
                View
              </button>
            </div>
          )}
          {hasActiveStructuredInputRequest &&
            inputRequest &&
            onSubmitInputRequest &&
            onDismissInputRequest &&
            (isPactAuthorizationInputRequest(inputRequest) ? (
              // A business sign-in is answered on the business's own page; the card can only
              // open that page or cancel.
              <Suspense
                fallback={
                  <div className="input-request-card" role="status">
                    Loading questions…
                  </div>
                }
              >
                <PactAuthorizationCard
                  request={inputRequest}
                  onCancel={() => onDismissInputRequest(inputRequest.id)}
                />
              </Suspense>
            ) : (
              <Suspense
                fallback={
                  <div className="input-request-card" role="status">
                    Loading questions…
                  </div>
                }
              >
                <StructuredInputPromptCard
                  request={inputRequest}
                  onSubmit={(answers) => onSubmitInputRequest(inputRequest.id, answers)}
                  onDismiss={() => onDismissInputRequest(inputRequest.id)}
                />
              </Suspense>
            ))}
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
                  You are inspecting the live task history from {remoteSession.deviceName}, not the
                  current device.
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
              onResumeTask={
                remoteSession ? undefined : () => window.electronAPI.resumeTask(task.id)
              }
              onOpenAccessProfilePicker={remoteSession ? undefined : handleOpenAccessProfilePicker}
              onContinueWithoutCommands={
                remoteSession ? undefined : onContinueWithoutCommandsForPausedTask
              }
            />
          )}
          {task.status === "blocked" && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>
                  {isBotHandoffWaiting
                    ? "Waiting on a teammate"
                    : task.terminalStatus === "awaiting_approval"
                      ? "Blocked - needs approval"
                      : task.terminalStatus === "awaiting_verification"
                        ? "Verifying before completion"
                        : "Blocked - waiting on you"}
                </strong>
                {isBotHandoffWaiting ? (
                  <span className="task-status-banner-detail">
                    The conversation will continue when the teammate replies.
                  </span>
                ) : (
                  latestApprovalEvent?.payload?.approval?.description &&
                  task.terminalStatus === "awaiting_approval" && (
                    <span className="task-status-banner-detail">
                      {latestApprovalEvent.payload.approval.description}
                    </span>
                  )
                )}
              </div>
            </div>
          )}
          {shouldShowCancelledTaskBanner({
            taskStatus: task.status,
            isBotConversation,
          }) && (
            <div className="task-status-banner task-status-banner-cancelled">
              <div className="task-status-banner-content">
                <strong>Cancelled</strong>
                <span className="task-status-banner-detail">
                  The task was stopped by you. No further work is running.
                </span>
              </div>
            </div>
          )}
          {!remoteSession && task.status === "interrupted" ? (
            <SessionProgressCard
              key={`session-recovery:${task.id}`}
              task={task}
              onSelectTask={onSelectTask}
              refreshKey={events.length}
            />
          ) : (
            task.status === "interrupted" &&
            task.terminalStatus === "resume_available" && (
              <div className="task-status-banner task-status-banner-paused">
                <div className="task-status-banner-content">
                  <strong>Resume available</strong>
                  <span className="task-status-banner-detail">
                    The task stopped before finishing, but its progress and outputs were preserved.
                  </span>
                </div>
              </div>
            )
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
          {!remoteSession && (
            <QueuedMessagesPanel
              // Sibling keys must differ: the recovery card above is keyed by this task too.
              key={`queued-messages:${task.id}`}
              taskId={task.id}
              onChanged={onTasksChanged}
            />
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
                onClick={() => {
                  setQuotedAssistantMessage(null);
                  recordDraftMutation(onDraftPatch?.({ quotedAssistantMessage: undefined }));
                }}
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
              disabled={isUploadingAttachments || !hasHostMethod("selectFiles")}
              title={
                !hasHostMethod("selectFiles")
                  ? "File uploads are unavailable on this host"
                  : "Attach files"
              }
              aria-label="Attach files"
            >
              <Plus size={24} aria-hidden="true" />
            </button>
            {isCalm && <CalmAccessMenu access={calmAccess} placement="up" />}
            {uiDensity === "focused" && (
              <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                {showWorkspaceDropdown && (
                  <WorkspaceDropdownMenu
                    workspaces={workspacesList}
                    currentWorkspaceId={workspace?.id}
                    onSelect={handleWorkspaceSelect}
                    onSelectNewFolder={handleSelectNewFolder}
                    onUseTempWorkspace={
                      canSwitchToTempWorkspace ? () => void handleUseTempWorkspace() : undefined
                    }
                    onRemove={handleWorkspaceRemove}
                    onClose={() => setShowWorkspaceDropdown(false)}
                  />
                )}
              </div>
            )}
            <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
              <PromptComposerInput
                ref={promptInputRef}
                className="input-field input-textarea"
                placeholder={
                  isBotConversation
                    ? `Message ${botName}`
                    : agentContext.getMessage("placeholderActive")
                }
                value={inputValue}
                mentions={integrationMentionSpans}
                ariaLabel="Message"
                prediction={composerPrediction.prediction}
                onDismissPrediction={composerPrediction.dismiss}
                onChange={(...args) => {
                  composerPrediction.dismiss();
                  handleInputChange(...args);
                }}
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
                disabled={isBrowserHost || voiceInput.state === "processing" || talkMode.isActive}
                title={
                  isBrowserHost
                    ? "Voice input is available in the desktop app"
                    : talkMode.isActive
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
                  <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
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
              {(isTaskWorking || hasActiveStructuredInputRequest) && onStopTask ? (
                <div className="task-control-buttons">
                  <button
                    className="stop-btn-simple"
                    onClick={onStopTask}
                    aria-label="Stop task"
                    title="Stop task"
                  >
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
                  aria-label="Send message"
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
                    disabled={isWorkspaceLocked}
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
                    <WorkspaceDropdownMenu
                      workspaces={workspacesList}
                      currentWorkspaceId={workspace?.id}
                      onSelect={handleWorkspaceSelect}
                      onSelectNewFolder={handleSelectNewFolder}
                      onUseTempWorkspace={
                        canSwitchToTempWorkspace ? () => void handleUseTempWorkspace() : undefined
                      }
                      onRemove={handleWorkspaceRemove}
                      onClose={() => setShowWorkspaceDropdown(false)}
                    />
                  )}
                </div>
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
              disabled={isWorkspaceLocked}
              title={
                isBrowserHost
                  ? workspace?.name || "Select project"
                  : getWorkspaceStatusFolderLabel(workspace)
              }
            >
              <FolderIcon size={14} aria-hidden="true" />
              <span className="input-status-workspace-path">
                {isBrowserHost
                  ? workspace?.name || "Select project"
                  : getWorkspaceStatusFolderLabel(workspace)}
              </span>
            </button>
          </div>
          <div className="input-status-right">
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
                  return <Icon size={14} aria-hidden />;
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
        <Suspense fallback={null}>
          <TaskAutomationModal
            task={task}
            workspace={workspace}
            defaultName={headerTitle.trim() || task.title}
            defaultPrompt={taskAutomationDefaultPrompt}
            deeplink={isBotConversation ? botDeeplink : taskDeeplink}
            onClose={() => setShowTaskAutomationModal(false)}
            onCreated={async (routine) => {
              await onTasksChanged?.();
              const triggers = Array.isArray(routine?.triggers) ? routine.triggers : [];
              const triggerSummary = triggers.some((trigger: Any) => trigger?.type === "schedule")
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
        </Suspense>
      )}

      {selectedSkillForParams && (
        <Suspense fallback={null}>
          <SkillParameterModal
            skill={selectedSkillForParams.skill}
            onSubmit={handleSkillParamSubmit}
            onAskInChat={
              selectedSkillForParams.launchMode === "slash" ? handleSkillAskInChat : undefined
            }
            onCancel={handleSkillParamCancel}
          />
        </Suspense>
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
    task.agentConfig?.botConversation ? "bot" : "",
    task.assignedAgentRoleId ?? "",
  ].join(":");
}

function getMainContentInputRequestSignature(
  inputRequest: InputRequest | null | undefined,
): string {
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
    prev.headerPlacement === next.headerPlacement &&
    prev.rightPanelOpen === next.rightPanelOpen &&
    getMainContentTaskSignature(prev.task) === getMainContentTaskSignature(next.task) &&
    prev.selectedTaskId === next.selectedTaskId &&
    prev.workspace?.path === next.workspace?.path &&
    prev.events === next.events &&
    prev.sharedTaskEventUi === next.sharedTaskEventUi &&
    prev.botConversations === next.botConversations &&
    prev.isLoadingBotConversations === next.isLoadingBotConversations &&
    prev.conversationProjection === next.conversationProjection &&
    prev.onSelectBotConversation === next.onSelectBotConversation &&
    prev.onNewBotConversation === next.onNewBotConversation &&
    prev.childTasks === next.childTasks &&
    prev.childEvents === next.childEvents &&
    getMainContentInputRequestSignature(prev.inputRequest) ===
      getMainContentInputRequestSignature(next.inputRequest) &&
    getMainContentInputRequestsSignature(prev.pendingInputRequests) ===
      getMainContentInputRequestsSignature(next.pendingInputRequests) &&
    prev.draftValue === next.draftValue &&
    prev.draftRevision === next.draftRevision &&
    prev.draftSnapshot === next.draftSnapshot &&
    prev.onDraftValueChange === next.onDraftValueChange &&
    prev.onDraftAccepted === next.onDraftAccepted &&
    prev.onDraftPatch === next.onDraftPatch &&
    prev.onStageDraftAttachment === next.onStageDraftAttachment &&
    prev.onResolveDraftAttachment === next.onResolveDraftAttachment &&
    prev.onReleaseDraftAttachment === next.onReleaseDraftAttachment &&
    prev.selectedModel === next.selectedModel &&
    prev.selectedProvider === next.selectedProvider &&
    prev.selectedReasoningEffort === next.selectedReasoningEffort &&
    prev.availableModels === next.availableModels &&
    prev.availableProviders === next.availableProviders &&
    prev.uiDensity === next.uiDensity &&
    prev.homeResearchVaultEnabled === next.homeResearchVaultEnabled &&
    prev.homeNextActionsEnabled === next.homeNextActionsEnabled &&
    prev.autoOpenTurnOutput === next.autoOpenTurnOutput &&
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    prev.taskSwitchId === next.taskSwitchId &&
    prev.hasMoreTimelineHistory === next.hasMoreTimelineHistory &&
    prev.isLoadingTimelineHistory === next.isLoadingTimelineHistory &&
    prev.timelineHistoryError === next.timelineHistoryError &&
    prev.onLoadMoreTimelineHistory === next.onLoadMoreTimelineHistory &&
    prev.onLoadTaskEventDetail === next.onLoadTaskEventDetail &&
    prev.onReleaseTaskEventDetail === next.onReleaseTaskEventDetail &&
    getRemoteSessionSignature(prev.remoteSession) ===
      getRemoteSessionSignature(next.remoteSession) &&
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
