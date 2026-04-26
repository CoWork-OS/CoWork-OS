import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  Fragment,
  Children,
  startTransition,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import hljs from "highlight.js";
import mermaid from "mermaid";
import {
  Task,
  TaskEvent,
  Workspace,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
  CustomSkill,
  EventType,
  DEFAULT_QUIRKS,
  CanvasSession,
  isTempWorkspaceId,
  ImageAttachment,
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
} from "../../shared/types";
import {
  getLlmModelReasoningEfforts,
  LLM_REASONING_EFFORT_OPTIONS,
} from "../../shared/llm-model-selection";
import { parseLeadingSkillSlashCommand } from "../../shared/skill-slash-commands";
import {
  ONBOARDING_COMMAND_OPTIONS,
  parseOnboardingSlashCommand,
} from "../../shared/onboarding";
import {
  LLM_WIKI_AUDIT_GUI_PROMPT,
  LLM_WIKI_BRIEF_GUI_PROMPT,
  LLM_WIKI_EXPLORE_GUI_PROMPT,
  LLM_WIKI_GUI_PROMPT,
  LLM_WIKI_QUERY_GUI_PROMPT,
} from "../../shared/starter-missions";
import { detectModeSuggestions, type ModeSuggestion } from "../../shared/mode-suggestion-detection";
import { CollaborativeAgentLines } from "./CollaborativeAgentLines";
import { CollaborativeSummaryPanel } from "./CollaborativeSummaryPanel";
import { DispatchedAgentsPanel } from "./DispatchedAgentsPanel";
import { CliAgentFrame } from "./CliAgentFrame";
import { isCliAgentChildTask, resolveCliAgentType } from "../../shared/cli-agent-detection";
import { MultiLlmSelectionPanel } from "./MultiLlmSelectionPanel";
import { AssistantMessageContent } from "./AssistantMessageContent";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { hasAssistantMediaDirective } from "../utils/assistant-media-directives";
import type { AgentRoleData, LlmWikiVaultEntry, LlmWikiVaultSummary } from "../../electron/preload";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useVoiceTalkMode } from "../hooks/useVoiceTalkMode";
import { useAgentContext, type AgentContext } from "../hooks/useAgentContext";
import { getMessage } from "../utils/agentMessages";
import {
  hasTaskOutputs,
  resolveTaskOutputSummaryFromCompletionEvent,
} from "../utils/task-outputs";
import { shouldShowPersistentNeedsUserActionBanner } from "../utils/task-completion-ux";
import {
  filterVerboseTimelineNoise,
  shouldShowTaskEventInStepFeed,
  shouldShowTaskEventInSummaryMode,
} from "../utils/task-event-visibility";
import { friendlyToolCallTitle, friendlyToolResultTitle } from "../utils/timeline-tool-labels";
import { normalizeEventsForTimelineUi } from "../utils/timeline-projection";
import { getEffectiveTaskEventType, getTimelineErrorText } from "../utils/task-event-compat";
import {
  incrementRendererPerfCounter,
  markTaskEventRenderable,
  markTaskEventVisible,
  measureRendererPerf,
  recordRendererRender,
} from "../utils/renderer-perf";
import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  MAX_IMAGE_OCR_CHARS,
  buildImageAttachmentViewerOptions,
  extractAttachmentNames,
  stripHtmlForText,
  stripPptxBubbleContent,
  stripStrategyContextBlock,
  truncateTextForTaskPrompt,
} from "./utils/attachment-content";
import { sanitizeToolCallTextFromAssistant } from "../../shared/tool-call-text-sanitizer";
import { formatProviderErrorForDisplay } from "../../shared/provider-error-format";
import { buildApprovalCommandPreview } from "../../shared/approval-command-preview";
import { formatTimelineActivityLabel } from "../../shared/timeline-v2";
import {
  deriveSharedTaskEventUiState,
  type BaseTimelineItem,
  type CommandOutputSession,
  type SharedTaskEventUiState,
} from "../utils/task-event-derived";
import {
  Check as CheckIcon,
  ChevronDown,
  Loader2,
  MessageCircle,
  Play,
  Plus,
  ListTodo,
  Search,
  ShieldAlert,
  ShieldCheck,
  Bug,
  Sparkles,
  Code,
  BookOpen,
  Settings,
  PenLine,
  LayoutGrid,
  Film,
  Clock,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { InlineHtmlPreview } from "./InlineHtmlPreview";
import { InlineVideoPreview } from "./InlineVideoPreview";
import { MarkdownImagePreview } from "./MarkdownImagePreview";
import { ReplayControlsBar } from "./ReplayControls";
import { DebugSessionPanel } from "./DebugSessionPanel";
import { TaskPauseBanner } from "./TaskPauseBanner";
import type { ReplayControls } from "../hooks/useReplayMode";
import { useVirtualList } from "../hooks/useVirtualList";
import { useTaskDuration } from "../hooks/useTaskDuration";

const CODE_PREVIEWS_EXPANDED_KEY = "cowork:codePreviewsExpanded";
const TASK_TITLE_MAX_LENGTH = 50;
const TITLE_ELLIPSIS_REGEX = /(\.\.\.|\u2026)$/u;
const MAX_ATTACHMENTS = 10;
const MAX_QUOTED_ASSISTANT_MESSAGE_CHARS = 4000;
const MAX_QUOTED_ASSISTANT_PREVIEW_CHARS = 280;
const ACTIVE_WORK_SIGNAL_WINDOW_MS = 30_000;
const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const VIDEO_FILE_EXT_RE = /\.(mp4|webm)$/i;
const HTML_FILE_EXT_RE = /\.html?$/i;
const SPREADSHEET_FILE_EXT_RE = /\.xlsx?$/i;
const PRESENTATION_FILE_EXT_RE = /\.pptx$/i;
const DOCUMENT_PREVIEW_EXT_RE = /\.(pdf|docx|md|markdown|tex|txt)$/i;
const ACTIVE_WORK_EVENT_TYPES: EventType[] = [
  "executing",
  "step_started",
  "step_completed",
  "progress_update",
  "tool_call",
  "tool_result",
  "verification_started",
  "retry_started",
  "llm_streaming",
];
const TERMINAL_WORK_EVENT_TYPES = new Set<EventType | "task_paused" | "task_cancelled">([
  "task_paused",
  "approval_requested",
  "task_completed",
  "task_cancelled",
  "follow_up_completed",
]);
const WELCOME_TASK_SUGGESTION_LIMIT = 5;
const WELCOME_SUGGESTION_TEXT_MAX = 96;

type WelcomeTaskSuggestionSource = "heartbeat" | "memory" | "insight";
type WelcomeTaskSuggestionModule =
  | "Memory"
  | "Heartbeat"
  | "Reflection"
  | "Recent work"
  | "Inbox"
  | "Project";

interface WelcomeTaskSuggestion {
  id: string;
  title: string;
  description?: string;
  whyNow: string;
  prompt: string;
  confidence?: number;
  evidence?: string[];
  source: WelcomeTaskSuggestionSource;
  modules: WelcomeTaskSuggestionModule[];
  priority: number;
  createdAt?: number;
  feedback?: {
    kind: "proactive";
    workspaceId: string;
    suggestionId: string;
  };
}

interface ActiveWelcomeSuggestionDraft {
  workspaceId: string;
  suggestionId: string;
  originalPrompt: string;
}

function normalizeSuggestionText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncateSuggestionText(value: string, maxLength = WELCOME_SUGGESTION_TEXT_MAX): string {
  const text = normalizeSuggestionText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = normalizeSuggestionText(record[key]);
    if (value) return value;
  }
  return "";
}

function getRecordNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isConcreteMemorySignal(value: string): boolean {
  const text = normalizeSuggestionText(value);
  if (text.length < 24) return false;
  if (/^[{[]/.test(text)) return false;
  if (/^(none|unknown|not set|n\/a|no context|no memory)$/i.test(text)) return false;
  if (/^(ready to help|i can help|ask me anything)/i.test(text)) return false;
  return true;
}

function formatProfileFactSignal(fact: UserProfile["facts"][number]): string | null {
  const value = normalizeSuggestionText(fact.value);
  if (!isConcreteMemorySignal(value)) return null;
  if (typeof fact.confidence === "number" && fact.confidence < 0.45 && !fact.pinned) {
    return null;
  }
  const label =
    fact.category === "goal"
      ? "Goal"
      : fact.category === "work"
        ? "Work"
        : fact.category === "preference"
          ? "Preference"
          : fact.category === "constraint"
            ? "Constraint"
            : "Memory";
  return `${label}: ${truncateSuggestionText(value, 360)}`;
}

function getRecentMemorySignal(item: unknown): string | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["summary", "content", "snippet", "text", "value"]);
  if (!isConcreteMemorySignal(text)) return null;
  const type = getRecordString(record, ["type"]);
  const prefix = type ? `Recent ${type.replace(/_/g, " ")}` : "Recent work";
  return `${prefix}: ${truncateSuggestionText(text, 360)}`;
}

function buildEvidencePrompt(args: {
  opening: string;
  evidence: string[];
  instruction: string;
}): string {
  const evidenceLines = args.evidence.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `${args.opening}\n\nRemembered context:\n${evidenceLines}\n\n${args.instruction}`;
}

function formatWelcomeModules(modules: WelcomeTaskSuggestionModule[]): WelcomeTaskSuggestionModule[] {
  return Array.from(new Set(modules)).slice(0, 3);
}

function modulesForProactiveSuggestion(suggestion: ProactiveSuggestion): WelcomeTaskSuggestionModule[] {
  const modules: WelcomeTaskSuggestionModule[] = ["Heartbeat"];
  if (suggestion.suggestionClass === "memory" || suggestion.type === "reverse_prompt") {
    modules.push("Memory");
  }
  if (
    suggestion.suggestionClass === "open_loop" ||
    suggestion.suggestionClass === "urgent" ||
    suggestion.sourceSignals?.some((signal) => /mail|inbox|reply/i.test(signal))
  ) {
    modules.push("Inbox");
  }
  if (/^workflow intelligence:|^continuity:|^reflection:|^subconscious:/i.test(suggestion.title)) {
    modules.push("Reflection");
  }
  if (suggestion.sourceTaskId) modules.push("Recent work");
  return formatWelcomeModules(modules);
}

function whyNowForProactiveSuggestion(suggestion: ProactiveSuggestion): string {
  if (suggestion.urgency === "high") return "A current signal looks urgent enough to review now.";
  if (suggestion.suggestionClass === "open_loop") return "Memory found an open loop that may need closure.";
  if (suggestion.suggestionClass === "memory") return "This is based on remembered goals or preferences.";
  if (suggestion.suggestionClass === "urgent") return "Recent activity suggests this should not wait.";
  if (suggestion.sourceSignals?.length) {
    return `Triggered by ${suggestion.sourceSignals.length} recent signal(s).`;
  }
  return truncateSuggestionText(suggestion.description || "Recent context suggests this may be useful.", 120);
}

function buildHeartbeatWelcomeSuggestion(
  suggestion: ProactiveSuggestion,
  index: number,
): WelcomeTaskSuggestion | null {
  const prompt = normalizeSuggestionText(suggestion.actionPrompt || suggestion.description);
  const rawTitle = normalizeSuggestionText(suggestion.title || prompt);
  const title = rawTitle.replace(/^(workflow intelligence|subconscious|reflection|continuity):\s*/i, "");
  if (!title || !prompt) return null;

  const urgencyBoost =
    suggestion.urgency === "high" ? 30 : suggestion.urgency === "medium" ? 15 : 0;
  return {
    id: `heartbeat:${suggestion.id}`,
    title: truncateSuggestionText(title),
    description: truncateSuggestionText(suggestion.description, 120),
    whyNow: whyNowForProactiveSuggestion(suggestion),
    prompt,
    confidence: suggestion.confidence,
    evidence: suggestion.sourceSignals,
    source: "heartbeat",
    modules: modulesForProactiveSuggestion(suggestion),
    priority: 300 + urgencyBoost + Math.round((suggestion.confidence || 0) * 100) - index,
    createdAt: suggestion.createdAt,
    feedback: suggestion.workspaceId
      ? {
          kind: "proactive",
          workspaceId: suggestion.workspaceId,
          suggestionId: suggestion.id,
        }
      : undefined,
  };
}

function buildMemoryCommitmentSuggestion(
  item: unknown,
  index: number,
): WelcomeTaskSuggestion | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["text", "title", "summary", "description"]);
  if (!text) return null;
  const dueAt = getRecordNumber(record, ["dueAt", "due_at", "dueDate"]);
  const dueText = dueAt
    ? ` Due ${new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
    : "";
  return {
    id: `memory:commitment:${getRecordString(record, ["id"]) || index}`,
    title: truncateSuggestionText(text),
    description: dueText.trim() || "Open commitment",
    whyNow: dueText.trim() || "Memory has this as an open commitment.",
    prompt: `Help me make progress on this commitment: ${text}.${dueText} Start by identifying the next concrete action and any message or artifact I should prepare.`,
    source: "memory",
    modules: ["Memory"],
    priority: 260 - index,
    createdAt: getRecordNumber(record, ["createdAt", "updatedAt"]),
  };
}

function buildProfileWelcomeSuggestion(
  profile: UserProfile | null,
  recentMemories: unknown[],
): WelcomeTaskSuggestion | null {
  if (!profile) return null;
  const factSignals = (Array.isArray(profile.facts) ? profile.facts : [])
    .filter((fact) =>
      ["goal", "work", "preference", "constraint"].includes(fact.category) || fact.pinned,
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastUpdatedAt - a.lastUpdatedAt ||
        b.confidence - a.confidence,
    )
    .map(formatProfileFactSignal)
    .filter((value): value is string => Boolean(value));
  const profileSummary = normalizeSuggestionText(profile.summary);
  const summary = isConcreteMemorySignal(profileSummary)
    ? `Profile summary: ${truncateSuggestionText(profileSummary, 360)}`
    : null;
  const recentSignals = recentMemories
    .map(getRecentMemorySignal)
    .filter((value): value is string => Boolean(value));
  const evidence = Array.from(
    new Set([summary, ...factSignals, ...recentSignals].filter((value): value is string => Boolean(value))),
  ).slice(0, 6);
  if (evidence.length < 2) return null;
  return {
    id: "memory:profile-focus",
    title: "Use memory to choose the next priority",
    description: truncateSuggestionText(evidence[0], 120),
    whyNow: `${evidence.length} remembered signals can narrow what to do next.`,
    prompt: buildEvidencePrompt({
      opening: "Use the remembered context below to recommend the best next task for me.",
      evidence,
      instruction:
        "Give me 3 concrete options that directly reference this context, explain the tradeoffs, and recommend one. Do not start the task or ask whether to proceed; end with the recommendation so I can choose in a follow-up. If the context is not enough, ask one focused clarifying question instead of giving generic advice.",
    }),
    evidence,
    source: "memory",
    modules: recentSignals.length ? ["Memory", "Recent work"] : ["Memory"],
    priority: 120,
    createdAt: profile.updatedAt,
  };
}

function buildRecentMemorySuggestion(item: unknown, index: number): WelcomeTaskSuggestion | null {
  const record = asRecord(item);
  if (!record) return null;
  const text = getRecordString(record, ["summary", "content", "snippet", "text", "value"]);
  if (!text) return null;
  const evidence = [`Recent work: ${text}`];
  return {
    id: `memory:recent:${getRecordString(record, ["id"]) || index}`,
    title: "Pick up a recent thread",
    description: truncateSuggestionText(text, 120),
    whyNow: "Recent work left context that may be worth continuing.",
    prompt: buildEvidencePrompt({
      opening: "Pick up from this recent memory and suggest the most useful next step.",
      evidence,
      instruction:
        "Explain why this is the right next step and name any tradeoffs. Do not start the task or ask whether to proceed; end with the recommendation so I can choose in a follow-up.",
    }),
    evidence,
    source: "memory",
    modules: ["Memory", "Recent work"],
    priority: 90 - index,
    createdAt: getRecordNumber(record, ["updatedAt", "createdAt"]),
  };
}

function dedupeWelcomeTaskSuggestions(
  suggestions: WelcomeTaskSuggestion[],
): WelcomeTaskSuggestion[] {
  const seen = new Set<string>();
  const out: WelcomeTaskSuggestion[] = [];
  for (const suggestion of suggestions.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (b.createdAt || 0) - (a.createdAt || 0);
  })) {
    const key = normalizeSuggestionText(`${suggestion.source}:${suggestion.title}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
    if (out.length >= WELCOME_TASK_SUGGESTION_LIMIT) break;
  }
  return out;
}

type GeneratedInlinePreviewKind = "image" | "video" | "html" | "spreadsheet" | "presentation";

export function getInlinePreviewKindForGeneratedFile(args: {
  path?: unknown;
  mimeType?: unknown;
  type?: unknown;
}): GeneratedInlinePreviewKind | null {
  const filePath = typeof args.path === "string" ? args.path : "";
  const mimeType = typeof args.mimeType === "string" ? args.mimeType.toLowerCase() : "";
  const fileType = typeof args.type === "string" ? args.type.toLowerCase() : "";

  if (fileType === "image" || mimeType.startsWith("image/") || IMAGE_FILE_EXT_RE.test(filePath)) {
    return "image";
  }

  if (fileType === "video" || mimeType.startsWith("video/") || VIDEO_FILE_EXT_RE.test(filePath)) {
    return "video";
  }

  if (fileType === "html" || mimeType === "text/html" || HTML_FILE_EXT_RE.test(filePath)) {
    return "html";
  }

  if (fileType === "spreadsheet" || SPREADSHEET_FILE_EXT_RE.test(filePath)) {
    return "spreadsheet";
  }

  if (
    fileType === "presentation" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    PRESENTATION_FILE_EXT_RE.test(filePath)
  ) {
    return "presentation";
  }

  return null;
}

export function getInlinePreviewKindForTaskEvent(event: TaskEvent): GeneratedInlinePreviewKind | null {
  const effectiveType = getEffectiveTaskEventType(event);
  if (
    effectiveType !== "file_created" &&
    effectiveType !== "file_modified" &&
    effectiveType !== "artifact_created"
  ) {
    return null;
  }

  return getInlinePreviewKindForGeneratedFile({
    path: event.payload?.path || event.payload?.from,
    mimeType: event.payload?.mimeType,
    type: event.payload?.type,
  });
}

function isActiveWorkSignal(event: TaskEvent, effectiveType: string): boolean {
  const isActiveProgressSignal =
    effectiveType === "progress_update" &&
    (event.payload?.phase === "tool_execution" ||
      event.payload?.state === "active" ||
      event.payload?.heartbeat === true);
  const isTimelineActiveLifecycle =
    event.type === "timeline_group_started" ||
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_updated";
  return (
    isTimelineActiveLifecycle ||
    ACTIVE_WORK_EVENT_TYPES.includes(effectiveType as EventType) ||
    isActiveProgressSignal
  );
}

export function isTaskActivelyWorking(
  task: Task | null | undefined,
  events: TaskEvent[],
  hasActiveChildren: boolean,
  now = Date.now(),
): boolean {
  if (!task) return false;

  if (task.status === "executing" || task.status === "planning") {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (TERMINAL_WORK_EVENT_TYPES.has(effectiveType as EventType | "task_paused" | "task_cancelled")) {
        return false;
      }
      if (isActiveWorkSignal(event, effectiveType)) {
        return true;
      }
    }
    return true;
  }

  if (task.status === "completed" && hasActiveChildren) {
    return true;
  }
  if (task.status === "interrupted") return true;
  if (
    task.status === "completed" ||
    task.status === "paused" ||
    task.status === "blocked" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    return false;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.taskId !== task.id) continue;
    const effectiveType = getEffectiveTaskEventType(event);

    if (TERMINAL_WORK_EVENT_TYPES.has(effectiveType as EventType | "task_paused" | "task_cancelled")) {
      return false;
    }
    if (isActiveWorkSignal(event, effectiveType)) {
      return now - event.timestamp <= ACTIVE_WORK_SIGNAL_WINDOW_MS;
    }
  }

  return false;
}

// In non-verbose mode, hide verification noise (verification steps are still executed by the agent).
const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message") {
    const message = typeof event.payload?.message === "string" ? event.payload.message : "";
    return event.payload?.internal === true && !hasAssistantMediaDirective(message);
  }

  if (
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_finished" ||
    effectiveType === "step_started" ||
    effectiveType === "step_completed"
  ) {
    return isVerificationStepDescription(event.payload?.step?.description);
  }

  // Verification events are shown on failure; success is kept quiet.
  if (effectiveType === "verification_started" || effectiveType === "verification_passed") {
    return true;
  }

  return false;
};

const getAssistantStepDescription = (event: TaskEvent): string => {
  if (typeof event.payload?.stepDescription === "string") return event.payload.stepDescription;
  const step = event.payload?.step;
  if (step && typeof step === "object" && typeof (step as Record<string, unknown>).description === "string") {
    return (step as Record<string, string>).description;
  }
  return "";
};

const shouldRevealInternalAssistantMessageInVerbose = (event: TaskEvent): boolean => {
  if (getEffectiveTaskEventType(event) !== "assistant_message" || event.payload?.internal !== true) {
    return false;
  }
  const message = typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
  const stepDescription = getAssistantStepDescription(event);
  if (!message) return false;
  if (hasAssistantMediaDirective(message)) return true;
  if (isVerificationStepDescription(stepDescription)) return false;
  if (/^ok[\s.!?]*$/i.test(message) || message.length <= 12) return false;
  return true;
};

const getCompletionSummaryText = (event: TaskEvent): string => {
  if (getEffectiveTaskEventType(event) !== "task_completed") return "";
  const resultSummary =
    typeof event.payload?.resultSummary === "string" ? event.payload.resultSummary.trim() : "";
  const semanticSummary =
    typeof event.payload?.semanticSummary === "string" ? event.payload.semanticSummary.trim() : "";
  const verificationVerdict =
    typeof event.payload?.verificationVerdict === "string"
      ? event.payload.verificationVerdict.trim()
      : "";
  const verificationReport =
    typeof event.payload?.verificationReport === "string"
      ? event.payload.verificationReport.trim()
      : "";
  const summary = [resultSummary, semanticSummary].filter((value) => value.length > 0).join("\n\n");
  if (!verificationVerdict && !verificationReport) {
    return summary;
  }
  const verification = [
    verificationVerdict ? `Verification: ${verificationVerdict}` : "",
    verificationReport || "",
  ]
    .filter((value) => value.length > 0)
    .join("\n");
  return [summary, verification].filter((value) => value.length > 0).join("\n\n");
};

const isLowSignalPauseMessage = (
  message: string | null | undefined,
  reasonCode?: string | null,
): boolean => {
  const trimmed = String(message || "").trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (reasonCode && lower === String(reasonCode).trim().toLowerCase()) return true;
  if (
    /^required_decision/.test(String(reasonCode || "").trim().toLowerCase()) &&
    /\b(best next task|recommend(?:ed|ation)?.{0,80}next task)\b/.test(lower)
  ) {
    return true;
  }
  return (
    lower === "required_decision" ||
    lower === "required_decision_followup" ||
    lower === "input_request" ||
    lower === "skill_parameters" ||
    lower === "user_action_required_failure" ||
    lower === "user_action_required_tool" ||
    lower === "user_action_required_disabled" ||
    lower === "shell_permission_required" ||
    lower === "shell_permission_still_disabled" ||
    lower === "missing_required_workspace_artifact" ||
    lower === "paused - awaiting user input" ||
    lower === "waiting for structured user input."
  );
};

const getPayloadString = (payload: Any, key: string): string => {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
};

const getFailureEventText = (event: TaskEvent): string => {
  const payload = event.payload || {};
  const direct = [
    getPayloadString(payload, "message"),
    getPayloadString(payload, "error"),
    getPayloadString(payload, "reason"),
    getPayloadString(payload, "summary"),
    getPayloadString(payload, "title"),
    getPayloadString(payload, "stepDescription"),
  ].find((value) => value.length > 0);
  if (direct) return direct;

  const result = payload.result && typeof payload.result === "object" ? payload.result : null;
  const resultError = result && typeof (result as Any).error === "string" ? (result as Any).error.trim() : "";
  if (resultError) return resultError;

  const input = payload.input && typeof payload.input === "object" ? payload.input : null;
  const url = input && typeof (input as Any).url === "string" ? (input as Any).url.trim() : "";
  const path = input && typeof (input as Any).path === "string" ? (input as Any).path.trim() : "";
  const tool = getPayloadString(payload, "tool");
  if (tool && (url || path)) return `${tool} failed for ${url || path}`;
  if (url || path) return url || path;

  const step = payload.step && typeof payload.step === "object" ? payload.step : null;
  return step && typeof (step as Any).description === "string"
    ? (step as Any).description.trim()
    : "";
};

const eventLooksFailed = (event: TaskEvent): boolean => {
  const effectiveType = getEffectiveTaskEventType(event);
  const payload = event.payload || {};
  if (
    /^(failed|error|blocked)$/i.test(String(event.status || "")) ||
    /^(failed|error|blocked)$/i.test(String(payload.status || "")) ||
    payload.success === false
  ) {
    return true;
  }
  if (payload.error || payload.isError === true || payload.is_error === true) return true;
  if (typeof effectiveType === "string" && /(?:failed|error)$/i.test(effectiveType)) return true;
  if (event.type === "timeline_step_finished" && event.status === "failed") return true;
  return false;
};

const cleanFailureTextForPause = (text: string): string => {
  const cleaned = text
    .replace(/^Fetched\s+/i, "")
    .replace(/^Tool\s+["']?([^"']+)["']?\s+failed:\s*/i, "$1 failed: ")
    .trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}...` : cleaned;
};

const buildPauseDecisionFallbackFromRecentEvents = (
  events: TaskEvent[],
  latestPauseEvent?: TaskEvent,
): string => {
  if (events.length === 0) return "";
  const pauseIndex = latestPauseEvent
    ? events.findIndex((event) => event.id === latestPauseEvent.id)
    : events.length;
  const endIndex = pauseIndex >= 0 ? pauseIndex : events.length;

  for (let i = Math.min(endIndex - 1, events.length - 1); i >= Math.max(0, endIndex - 30); i -= 1) {
    const event = events[i];
    if (!eventLooksFailed(event)) continue;
    const failureText = cleanFailureTextForPause(getFailureEventText(event));
    if (!failureText) continue;
    return (
      `I paused because the last step hit a blocker: ${failureText}. ` +
      "Reply with whether I should continue using the information already gathered, try another source/approach, or stop the task."
    );
  }

  return "";
};

const getAssistantOrCompletionText = (event: TaskEvent | null | undefined): string => {
  if (!event) return "";
  if (getEffectiveTaskEventType(event) === "assistant_message") {
    return typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
  }
  return getCompletionSummaryText(event);
};

const buildTaskTitle = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= TASK_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, TASK_TITLE_MAX_LENGTH)}...`;
};

export function deriveTaskHeaderPresentation(task?: {
  title?: string | null;
  prompt?: string | null;
  rawPrompt?: string | null;
  userPrompt?: string | null;
} | null): {
  cleanedDisplayPrompt: string;
  trimmedPrompt: string;
  promptAttachmentNames: string[];
  headerTitle: string;
  headerTooltip: string;
  showHeaderTitle: boolean;
} {
  const displayPromptValue =
    typeof task?.rawPrompt === "string" && task.rawPrompt.trim().length > 0
      ? task.rawPrompt
      : typeof task?.userPrompt === "string" && task.userPrompt.trim().length > 0
        ? task.userPrompt
        : typeof task?.prompt === "string"
          ? task.prompt
          : "";
  const cleanedDisplayPromptValue = displayPromptValue
    ? stripStrategyContextBlock(stripPptxBubbleContent(displayPromptValue))
    : "";
  const trimmedPromptValue = cleanedDisplayPromptValue.trim();
  const promptAttachmentNamesValue = displayPromptValue ? extractAttachmentNames(displayPromptValue) : [];
  const baseTitleValue = task?.title || buildTaskTitle(trimmedPromptValue);
  const normalizedTitle = baseTitleValue.replace(TITLE_ELLIPSIS_REGEX, "").trim();
  const titleMatchesPrompt =
    normalizedTitle.length > 0 &&
    trimmedPromptValue.length > 0 &&
    (trimmedPromptValue === normalizedTitle || trimmedPromptValue.startsWith(normalizedTitle));
  const isTitleTruncated = titleMatchesPrompt && trimmedPromptValue.length > normalizedTitle.length;
  const headerTitleValue =
    isTitleTruncated && !TITLE_ELLIPSIS_REGEX.test(baseTitleValue)
      ? `${baseTitleValue}...`
      : baseTitleValue;
  const showHeaderTitle = headerTitleValue.trim().length > 0 && !titleMatchesPrompt;

  return {
    cleanedDisplayPrompt: cleanedDisplayPromptValue,
    trimmedPrompt: trimmedPromptValue,
    promptAttachmentNames: promptAttachmentNamesValue,
    headerTitle: headerTitleValue,
    headerTooltip: trimmedPromptValue || baseTitleValue,
    showHeaderTitle,
  };
}

export function shouldCreateFreshTaskForSend(params: {
  executionMode: ExecutionMode;
  selectedTaskId: string | null;
  selectedTaskExecutionMode?: ExecutionMode | null;
}): boolean {
  if (!params.selectedTaskId) return true;
  if (params.executionMode === "chat") return false;
  return false;
}

export function isChatExecutionTask(executionMode?: ExecutionMode | null): boolean {
  return executionMode === "chat";
}

type SelectedFileInfo = {
  path?: string;
  name: string;
  size: number;
  mimeType?: string;
};

type PendingAttachment = SelectedFileInfo & {
  id: string;
  dataBase64?: string;
};

type ImportedAttachment = {
  relativePath: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

const formatFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const composeMessageWithAttachments = async (
  workspacePath: string | undefined,
  text: string,
  attachments: ImportedAttachment[],
): Promise<{ message: string; extractionWarnings: string[] }> => {
  const extractedByPath: Record<string, string> = {};
  const extractionWarnings: string[] = [];

  if (workspacePath && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        const options = buildImageAttachmentViewerOptions(text, attachment.fileName);
        const result = await window.electronAPI.readFileForViewer(
          attachment.relativePath,
          workspacePath,
          {
            ...options,
            imageOcrMaxChars: MAX_IMAGE_OCR_CHARS,
          },
        );

        if (!result.success || !result.data) continue;

        const fileType = result.data.fileType;
        if (fileType === "unsupported") continue;
        if (fileType === "image" && !result.data.ocrText?.trim()) continue;

        let content: string | null = null;
        if (fileType === "image") {
          content = result.data.ocrText ?? null;
        } else if (fileType === "pdf" && result.data.pdfReviewSummary) {
          const summary = result.data.pdfReviewSummary;
          const lines = [
            `PDF review summary: pages=${summary.pageCount}, native=${summary.nativeTextPages}, ocr=${summary.ocrPages}, scanned=${summary.scannedPages}`,
          ];
          for (const page of summary.pages) {
            lines.push(`[Page ${page.pageIndex + 1}]${page.usedOcr ? " [OCR]" : ""}`);
            lines.push(page.text);
          }
          content = lines.join("\n");
        } else {
          content = result.data.content;
        }
        if (!content && result.data.htmlContent) {
          content = stripHtmlForText(result.data.htmlContent);
        }
        if ((!content || !content.trim()) && result.data.ocrText?.trim()) {
          content = result.data.ocrText;
        }
        if (!content?.trim()) continue;

        extractedByPath[attachment.relativePath] = truncateTextForTaskPrompt(content);
      } catch {
        extractionWarnings.push(attachment.fileName);
        // Continue to next attachment on extraction errors.
      }
    }
  }

  const base = text.trim() || "Please review the attached files.";
  const attachmentSummaryLines = attachments.map((attachment) => {
    const lines = [`- ${attachment.fileName} (${attachment.relativePath})`];
    const extracted = extractedByPath[attachment.relativePath];
    if (extracted) {
      lines.push("  Extracted content:");
      lines.push(`  ${ATTACHMENT_CONTENT_START_MARKER}`);
      for (const row of extracted.split("\n")) {
        lines.push(`    ${row}`);
      }
      lines.push(`  ${ATTACHMENT_CONTENT_END_MARKER}`);
    }
    return lines.join("\n");
  });

  const summary =
    attachmentSummaryLines.length === 0
      ? ""
      : `Attached files (relative to workspace):\n${attachmentSummaryLines.join("\n\n")}`;
  return {
    message: summary ? `${base}\n\n${summary}` : base,
    extractionWarnings,
  };
};

type MentionOption = {
  type: "agent" | "everyone";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
};

type SkillSlashCommandOption = {
  kind: "skill";
  id: string;
  name: string;
  description: string;
  icon: string;
  hasParams: boolean;
  skill: CustomSkill;
};

type BuiltinSlashCommandOption = {
  kind: "builtin";
  id: string;
  name: string;
  description: string;
  icon: string;
  command: string;
};

type SlashCommandOption = SkillSlashCommandOption | BuiltinSlashCommandOption;

const normalizeMentionSearch = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
import {
  SkillParameterModal,
  expandSkillPrompt,
  type SkillParameterFormValues,
} from "./SkillParameterModal";
import { buildSlashSkillPrompt } from "./skill-parameter-utils";
import { DocumentAwareFileModal } from "./DocumentAwareFileModal";
import { ThemeIcon } from "./ThemeIcon";
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
} from "./LineIcons";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import { replaceEmojisInChildren } from "../utils/emoji-replacer";
import { CitationBadge } from "./CitationPanel";
import { CommandOutput } from "./CommandOutput";
import { CanvasPreview } from "./CanvasPreview";
import { InlineImagePreview } from "./InlineImagePreview";
import { InlineSpreadsheetPreview } from "./InlineSpreadsheetPreview";
import { InlineDocumentPreview } from "./InlineDocumentPreview";
import { InlinePresentationPreview } from "./InlinePresentationPreview";
import { LatexArtifactWorkbench } from "./LatexArtifactWorkbench";
import { StepFeed } from "./timeline/StepFeed";
import { ParallelGroupFeed } from "./timeline/ParallelGroupFeed";
import { ActionBlock, buildActionBlockSummary } from "./timeline/ActionBlock";
import { buildParallelGroupProjection } from "./timeline/parallel-group-projection";
import {
  resolveTimelineIndicator,
  shouldShowTimelineBranchStub,
} from "./timeline/timeline-indicators";
import { getStepCompletionPreviewPath } from "../utils/step-document-preview";
import {
  normalizeInlineLists,
  normalizeInlineHeadings,
  unwrapMarkdownCodeBlocks,
} from "../utils/markdown-inline-lists";
import { resolveDisclosureExpanded } from "../utils/disclosure-state";
import { findLatexPdfPair } from "../utils/latex-artifacts";

// Mermaid diagram component — theme-aware init for reliable text visibility
let mermaidLastTheme: boolean | null = null;

// Reset when theme changes so next diagram render picks up new theme
if (typeof document !== "undefined") {
  const observer = new MutationObserver(() => {
    const isDark = !document.documentElement.classList.contains("theme-light");
    if (mermaidLastTheme !== null && mermaidLastTheme !== isDark) {
      mermaidLastTheme = null;
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function initMermaid() {
  const isDark = !document.documentElement.classList.contains("theme-light");
  if (mermaidLastTheme === isDark) return;
  mermaidLastTheme = isDark;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "base",
    themeVariables: {
      darkMode: isDark,
      fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      primaryTextColor: isDark ? "#e8e8e8" : "#333333",
      primaryColor: isDark ? "#363754" : "#fff4dd",
      primaryBorderColor: isDark ? "#4a4a6a" : "#e8dcc4",
      lineColor: isDark ? "#6b6b8a" : "#333333",
      secondaryColor: isDark ? "#454563" : "#f0e6d4",
      tertiaryColor: isDark ? "#2d2d3a" : "#f5f5f5",
      nodeTextColor: isDark ? "#e8e8e8" : "#333333",
      textColor: isDark ? "#e8e8e8" : "#333333",
      mainBkg: isDark ? "#363754" : "#fff4dd",
      nodeBorder: isDark ? "#4a4a6a" : "#e8dcc4",
      clusterBkg: isDark ? "#2d2d3a" : "#f5f5f5",
      clusterBorder: isDark ? "#4a4a6a" : "#e0e0e0",
      titleColor: isDark ? "#e8e8e8" : "#333333",
      edgeLabelBackground: isDark ? "#363754" : "#fff4dd",
    },
  });
}

function sanitizeMermaidSvg(svgMarkup: string): SVGSVGElement | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    return null;
  }

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "script" || tagName === "foreignobject") {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && /^javascript:/i.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }

  return root as unknown as SVGSVGElement;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);
  const [themeKey, setThemeKey] = useState(() =>
    document.documentElement.classList.contains("theme-light") ? "light" : "dark",
  );

  useLayoutEffect(() => {
    const observer = new MutationObserver(() => {
      const next =
        document.documentElement.classList.contains("theme-light") ? "light" : "dark";
      setThemeKey((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    initMermaid();
    let cancelled = false;
    setError(null);
    setSvg(null);
    mermaid
      .render(idRef.current, chart)
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to render diagram");
      });
    return () => {
      cancelled = true;
    };
  }, [chart, themeKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!svg) return;
    const sanitizedSvg = sanitizeMermaidSvg(svg);
    if (!sanitizedSvg) {
      setError("Failed to render diagram");
      return;
    }
    container.appendChild(document.importNode(sanitizedSvg, true));
  }, [svg]);

  if (error) {
    return (
      <div className="mermaid-error">
        <span>Diagram error: {error}</span>
      </div>
    );
  }

  return (
    svg ? (
      <div className="mermaid-diagram" ref={containerRef} />
    ) : (
      <div className="mermaid-diagram">
        <span className="mermaid-loading">Rendering diagram…</span>
      </div>
    )
  );
}

// Code block component with copy button
interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // Check if this is a code block (has language class) vs inline code
  const isCodeBlock = className?.startsWith("language-");
  const language = className?.replace("language-", "") || "";

  // Get the text content for copying
  const getTextContent = (node: React.ReactNode): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(getTextContent).join("");
    if (node && typeof node === "object" && "props" in node) {
      return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
    }
    return "";
  };

  const handleCopy = async () => {
    const text = getTextContent(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // For inline code, just render normally
  if (!isCodeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  // Render mermaid diagrams inline
  const codeText = getTextContent(children);
  if (language === "mermaid") {
    return <MermaidDiagram chart={codeText} />;
  }

  // Compute highlighted HTML
  const highlightedHtml = useMemo(() => highlightCode(codeText, language), [codeText, language]);

  // For code blocks, wrap with copy button
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && <span className="code-block-language">{language}</span>}
        <button
          className={`code-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      {highlightedHtml ? (
        <code
          className={`hljs ${className || ""}`}
          {...props}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      )}
    </div>
  );
}

// Utility: highlight a code string with hljs (pure function, no hooks)
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHighlightedHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return escapeHtml(html);
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const sourceRoot = parsed.body.firstElementChild;
  if (!sourceRoot) {
    return "";
  }

  const outputDoc = parser.parseFromString("<div></div>", "text/html");
  const outputRoot = outputDoc.body.firstElementChild as HTMLElement;

  const appendSanitized = (node: ChildNode, parent: HTMLElement): void => {
    if (node.nodeType === 3) {
      parent.appendChild(outputDoc.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "span") {
      const span = outputDoc.createElement("span");
      const classes = (element.getAttribute("class") || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter((name) => /^hljs(?:-[a-z0-9_-]+)?$/i.test(name));
      if (classes.length > 0) {
        span.setAttribute("class", classes.join(" "));
      }
      for (const child of Array.from(element.childNodes)) {
        appendSanitized(child, span);
      }
      parent.appendChild(span);
      return;
    }

    if (tag === "br") {
      parent.appendChild(outputDoc.createElement("br"));
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      appendSanitized(child, parent);
    }
  };

  for (const child of Array.from(sourceRoot.childNodes)) {
    appendSanitized(child, outputRoot);
  }

  return outputRoot.innerHTML;
}

function highlightCode(code: string, language?: string): string | null {
  if (!code) return null;
  if (language && hljs.getLanguage(language)) {
    try {
      return sanitizeHighlightedHtml(hljs.highlight(code, { language }).value);
    } catch {
      // fall through
    }
  }
  try {
    return sanitizeHighlightedHtml(hljs.highlightAuto(code).value);
  } catch {
    return null;
  }
}

function summarizeQuotedAssistantMessage(message: string, maxChars = MAX_QUOTED_ASSISTANT_PREVIEW_CHARS): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function createQuotedAssistantMessage(
  message: string,
  eventId?: string,
  taskId?: string,
): QuotedAssistantMessage | null {
  const cleaned = cleanAssistantMessageForDisplay(message).trim();
  if (!cleaned) return null;
  const truncated = cleaned.length > MAX_QUOTED_ASSISTANT_MESSAGE_CHARS;
  return {
    ...(eventId ? { eventId } : {}),
    ...(taskId ? { taskId } : {}),
    message: truncated
      ? `${cleaned.slice(0, MAX_QUOTED_ASSISTANT_MESSAGE_CHARS - 1).trimEnd()}…`
      : cleaned,
    ...(truncated ? { truncated: true } : {}),
  };
}

// Highlighted code preview for file creation/modification events
function HighlightedCodePreview({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  if (html) {
    return (
      <pre className="code-preview-content">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  }
  return (
    <pre className="code-preview-content">
      <code>{code}</code>
    </pre>
  );
}

// Copy button for user messages
const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      className={`message-copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
});

const MessageQuoteButton = memo(function MessageQuoteButton({
  onQuote,
}: {
  onQuote: () => void;
}) {
  return (
    <button type="button" className="message-quote-btn" onClick={onQuote} title="Quote this message">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 8L6 12l4 4" />
        <path d="M6 12h9a5 5 0 0 1 5 5v0" />
      </svg>
      <span>Quote</span>
    </button>
  );
});

// Collapsible user message bubble - limits height and expands on click
function CollapsibleUserBubble({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      setNeedsCollapse(contentRef.current.scrollHeight > 220);
    }
  }, [children]);

  const collapsed = needsCollapse && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        className={`chat-bubble user-bubble markdown-content${!collapsed ? " expanded" : ""}`}
        onClick={() => {
          if (collapsed) setExpanded(true);
        }}
      >
        {children}
        {collapsed && <div className="user-bubble-fade" />}
      </div>
      {needsCollapse && (
        <button className="user-bubble-expand-btn" onClick={() => setExpanded(!expanded)}>
          {collapsed ? "Show more" : "Show less"}
        </button>
      )}
    </>
  );
}

// Global audio state to ensure only one audio plays at a time
let currentAudioContext: AudioContext | null = null;
let currentAudioSource: AudioBufferSourceNode | null = null;
let currentSpeakingCallback: (() => void) | null = null;

function stopCurrentAudio() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch {
      // Already stopped
    }
    currentAudioSource = null;
  }
  if (currentAudioContext) {
    try {
      currentAudioContext.close();
    } catch {
      // Already closed
    }
    currentAudioContext = null;
  }
  if (currentSpeakingCallback) {
    currentSpeakingCallback();
    currentSpeakingCallback = null;
  }
}

// Speak button for assistant messages
const MessageSpeakButton = memo(function MessageSpeakButton({
  text,
  voiceEnabled,
}: {
  text: string;
  voiceEnabled: boolean;
}) {
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!voiceEnabled) return;

    // If already speaking, stop the audio
    if (speaking) {
      stopCurrentAudio();
      setSpeaking(false);
      return;
    }

    try {
      setLoading(true);
      // Strip markdown for cleaner speech
      const cleanText = text
        .replace(/```[\s\S]*?```/g, "") // Remove code blocks
        .replace(/`[^`]+`/g, "") // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Keep link text only
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // Remove images
        .replace(/^#{1,6}\s+/gm, "") // Remove headers
        .replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold
        .replace(/\*([^*]+)\*/g, "$1") // Remove italic
        .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1") // Extract speak tags
        .trim();

      if (cleanText) {
        // Stop any currently playing audio first
        stopCurrentAudio();

        const result = await window.electronAPI.voiceSpeak(cleanText);
        if (result.success && result.audioData) {
          // Convert number array back to ArrayBuffer and play
          const audioBuffer = new Uint8Array(result.audioData).buffer;
          const audioContext = new AudioContext();
          const decodedAudio = await audioContext.decodeAudioData(audioBuffer);
          const source = audioContext.createBufferSource();
          source.buffer = decodedAudio;
          source.connect(audioContext.destination);

          // Store references for stopping
          currentAudioContext = audioContext;
          currentAudioSource = source;
          currentSpeakingCallback = () => setSpeaking(false);

          source.onended = () => {
            setSpeaking(false);
            currentAudioContext = null;
            currentAudioSource = null;
            currentSpeakingCallback = null;
            try {
              audioContext.close();
            } catch {
              // Already closed
            }
          };

          setLoading(false);
          setSpeaking(true);
          source.start(0);
          return;
        } else if (!result.success) {
          console.error("TTS failed:", result.error);
        }
      }
    } catch (err) {
      console.error("Failed to speak:", err);
    } finally {
      setLoading(false);
    }
  };

  if (!voiceEnabled) return null;

  return (
    <button
      className={`message-speak-btn ${speaking ? "speaking" : ""}`}
      onClick={handleClick}
      title={speaking ? "Stop speaking" : loading ? "Loading..." : "Speak message"}
      disabled={loading}
    >
      {speaking ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      ) : loading ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="spin"
        >
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
      <span>{speaking ? "Stop" : loading ? "Loading" : "Speak"}</span>
    </button>
  );
});

const HEADING_EMOJI_REGEX = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F\uFE0E]?)(\s+)?/u;

const normalizeCommitmentText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!value || typeof value !== "object") return null;
  const entry = value as { text?: unknown; title?: unknown; name?: unknown };
  const textValue =
    typeof entry.text === "string"
      ? entry.text
      : typeof entry.title === "string"
        ? entry.title
        : typeof entry.name === "string"
          ? entry.name
          : null;

  if (!textValue) return null;
  const trimmed = textValue.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getHeadingIcon = (emoji: string): React.ReactNode => {
  const Icon = getEmojiIcon(emoji);
  return <Icon size={16} strokeWidth={1.8} />;
};

const renderHeading = (Tag: "h1" | "h2" | "h3") => {
  return ({ children, ...props }: Any) => {
    const nodes = Children.toArray(children);
    if (typeof nodes[0] === "string") {
      const match = (nodes[0] as string).match(HEADING_EMOJI_REGEX);
      if (match) {
        const emoji = match[1];
        const icon = getHeadingIcon(emoji);
        if (icon) {
          nodes[0] = (nodes[0] as string).slice(match[0].length);
          return (
            <Tag {...props}>
              <span className="markdown-heading-icon">{icon}</span>
              {nodes}
            </Tag>
          );
        }
      }
    }
    return <Tag {...props}>{nodes}</Tag>;
  };
};

const isExternalHttpLink = (href: string): boolean =>
  href.startsWith("http://") || href.startsWith("https://");

const FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "less",
  "sass",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "cpp",
  "c",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "toml",
  "ini",
  "env",
  "lock",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "zip",
  "tar",
  "gz",
  "tgz",
  "rar",
  "7z",
]);

const getTextContent = (node: React.ReactNode): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
};

const stripHttpScheme = (value: string): string => value.replace(/^https?:\/\//, "");
const HTML_TAG_REGEX = /<[^>]*>/g;
const URLISH_TEXT_REGEX = /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i;

const stripHtmlTags = (value: string): string =>
  String(value || "")
    .replace(HTML_TAG_REGEX, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractDomainFromUrl = (raw: string): string => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return stripHttpScheme(trimmed).split("/")[0].replace(/^www\./i, "");
  }
};

const isUrlLikeLabel = (value: string): boolean => URLISH_TEXT_REGEX.test(String(value || "").trim());

const looksLikeLocalFilePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("file://")) return true;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return false;
  if (trimmed.includes("://") || trimmed.startsWith("www.")) return false;
  if (trimmed.includes("@")) return false;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/")
  )
    return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  const extMatch = trimmed.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
};

const isFileLink = (href: string): boolean => {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (isExternalHttpLink(href)) return false;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  if (href.startsWith("file://")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
};

const normalizeFileHref = (href: string): string => {
  if (!href) return href;
  if (href.startsWith("file://")) {
    const rawPath = href.replace(/^file:\/\//, "");
    const decoded = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    return decoded.replace(/^\/([a-zA-Z]:\/)/, "$1").split(/[?#]/)[0];
  }
  return href.split(/[?#]/)[0];
};

const resolveFileLinkTarget = (href: string, linkText: string): string | null => {
  const trimmedText = linkText.trim();
  const trimmedHref = href.trim();

  if (looksLikeLocalFilePath(trimmedText)) {
    const strippedHref = stripHttpScheme(trimmedHref).replace(/\/$/, "");
    if (trimmedHref === trimmedText || strippedHref === trimmedText) {
      return normalizeFileHref(trimmedText);
    }
  }

  if (looksLikeLocalFilePath(trimmedHref)) {
    return normalizeFileHref(trimmedHref);
  }

  return null;
};

const CITATION_REF_REGEX = /\[(\d+)\]/g;

/**
 * Matches bare domain URLs (e.g. "example.com/path") that are NOT already
 * inside a markdown link. Only targets strings that look like domain.tld/...
 */
const BARE_URL_REGEX =
  /(?<!\(|\[)(?:^|(?<=\s))((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s)\]]+)/gi;
const GLOB_TOKEN_REGEX = /(?<![`\\])\*\*\/\*[^\s,;()]+/g;
const FENCED_CODE_BLOCK_REGEX = /(```[\s\S]*?```)/g;
const JSON_PATH_PAYLOAD_LINE_REGEX = /^(\s*)\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}(\s*)$/;
const SOURCES_HEADING_REGEX = /(^|\n)(?:#{1,6}\s*)?sources\b[^\n]*(?:\n|$)/i;
const SOURCE_ENTRY_INLINE_SPLIT_REGEX =
  /\s+(\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/))/gi;
const SOURCE_ENTRY_DETECT_REGEX =
  /\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/\S+)/i;
/** Split pipe-separated sources onto separate lines. */
const SOURCE_PIPE_SEPARATOR_REGEX = /\s*\|\s*/g;
/** Split inline sources: "[1] ... [2] ..." -> one per line (whitespace before [N]). */
const SOURCE_INLINE_BEFORE_NUMBER_REGEX = /\s+(?=\[\d+\])/g;

/**
 * Pre-process assistant message text to convert bare domain URLs into markdown links.
 * e.g. "spectrum.ieee.org/quantum" → "[spectrum.ieee.org/quantum](https://spectrum.ieee.org/quantum)"
 */
export function autolinkBareUrls(text: string): string {
  return text.replace(BARE_URL_REGEX, (_match, url) => {
    return `[${url}](https://${url})`;
  });
}

/**
 * Convert bare domains (domain.tld without path) into markdown links.
 * e.g. "learn.microsoft.com" → "[learn.microsoft.com](https://learn.microsoft.com)"
 * Only matches when not already inside a link or brackets.
 */
const BARE_DOMAIN_REGEX =
  /(?<!\(|\[|\/)(?:^|(?<=\s))((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?=[\s\]\)\|,;:]|$)/gi;
const COMMON_BARE_DOMAIN_EXCLUSIONS = new Set(["e.g", "i.e"]);

function shouldAutolinkBareDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  if (COMMON_BARE_DOMAIN_EXCLUSIONS.has(normalized)) return false;

  const labels = normalized.split(".").filter(Boolean);
  if (labels.length < 2) return false;

  const firstLabel = labels[0] || "";
  const tld = labels[labels.length - 1] || "";

  if (/^v?\d+$/.test(firstLabel)) return false;
  if (labels.length === 2 && firstLabel.length < 3 && tld.length < 3) return false;

  return true;
}

export function autolinkBareDomains(text: string): string {
  return text.replace(BARE_DOMAIN_REGEX, (_match, domain) => {
    if (!shouldAutolinkBareDomain(domain)) return _match;
    return `[${domain}](https://${domain})`;
  });
}

/**
 * Convert URLs inside square brackets to clickable markdown links.
 * Handles formats like [learn.microsoft.com], [https://example.com/path], [domain.com/path].
 * Skips citation numbers [1], [2] and existing markdown links [text](url).
 */
const BRACKETED_URL_REGEX =
  /\[(https?:\/\/[^\]\s]+)\](?!\s*\()|\[((?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\]\s]*)?)\](?!\s*\()/gi;
export function autolinkUrlsInBrackets(text: string): string {
  return text.replace(BRACKETED_URL_REGEX, (_match, fullUrl: string | undefined, bareDomain: string | undefined) => {
    const url = fullUrl ?? bareDomain;
    if (!url) return _match;
    const href = url.startsWith("http") ? url : `https://${url}`;
    return `[${url}](${href})`;
  });
}

/** Keep glob-style path patterns literal when rendering markdown. */
function protectGlobTokens(text: string): string {
  return text.replace(GLOB_TOKEN_REGEX, (token) => `\`${token}\``);
}

function transformOutsideFencedCodeBlocks(text: string, transform: (segment: string) => string): string {
  return text
    .split(FENCED_CODE_BLOCK_REGEX)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join("");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownHref(href: string): string {
  return encodeURI(href).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function autolinkJsonPathPayloadLines(text: string): string {
  return transformOutsideFencedCodeBlocks(text, (segment) =>
    segment
      .split("\n")
      .map((line) => {
        const match = line.match(JSON_PATH_PAYLOAD_LINE_REGEX);
        if (!match) return line;

        const [, leadingWhitespace, encodedPath, trailingWhitespace] = match;
        let pathValue: string;
        try {
          pathValue = JSON.parse(`"${encodedPath}"`);
        } catch {
          return line;
        }
        const normalizedPath = pathValue.trim();
        if (!normalizedPath || !looksLikeLocalFilePath(normalizedPath)) return line;

        return `${leadingWhitespace}[${escapeMarkdownLinkText(normalizedPath)}](${escapeMarkdownHref(normalizedPath)})${trailingWhitespace}`;
      })
      .join("\n"),
  );
}

/**
 * In a "Sources" section, force each numbered source entry onto its own line.
 * Handles pipe-separated sources ("[1] ... | [2] ...") and inline sources ("[1] ... [2] ...").
 * Works whether content is on the same line as "Sources:" or on following lines.
 */
export function normalizeSourcesSection(text: string): string {
  const heading = SOURCES_HEADING_REGEX.exec(text);
  if (!heading) return text;

  const headingStart = heading.index + (heading[1] ? heading[1].length : 0);
  const headingMatch = heading[0];
  const headingLineEnd = text.indexOf("\n", headingStart);

  let sectionStart: number;
  let sectionEnd: number;

  if (headingLineEnd === -1) {
    // Content on same line as "Sources:" (e.g. "Sources: [1] ... | [2] ...")
    const sourcesLabelEnd = headingMatch.match(/sources\b[:\s]*/i)?.[0]?.length ?? 0;
    sectionStart = heading.index + sourcesLabelEnd;
    sectionEnd = text.length;
  } else {
    sectionStart = headingLineEnd + 1;
    const remainder = text.slice(sectionStart);
    const nextHeading = /\n#{1,6}\s+\S/.exec(remainder);
    sectionEnd = nextHeading ? sectionStart + nextHeading.index + 1 : text.length;
  }

  const sectionBody = text.slice(sectionStart, sectionEnd);
  const normalizedForDetection = sectionBody
    .replace(SOURCE_PIPE_SEPARATOR_REGEX, "\n")
    .replace(SOURCE_INLINE_BEFORE_NUMBER_REGEX, "\n")
    .trimStart();

  if (
    !SOURCE_ENTRY_DETECT_REGEX.test(normalizedForDetection) &&
    !/\[\d+\]/.test(normalizedForDetection)
  ) {
    return text;
  }

  const normalizedSectionBody = normalizedForDetection
    .replace(SOURCE_ENTRY_INLINE_SPLIT_REGEX, "  \n$1")
    .trimStart();

  return `${text.slice(0, sectionStart)}${normalizedSectionBody}${text.slice(sectionEnd)}`;
}

export function normalizeMarkdownForDisplay(text: string): string {
  const sanitized = sanitizeToolCallTextFromAssistant(text).text;
  const protected_ = protectGlobTokens(sanitized);
  const withJsonPaths = autolinkJsonPathPayloadLines(protected_);
  const withBareUrls = transformOutsideFencedCodeBlocks(withJsonPaths, (seg) =>
    autolinkUrlsInBrackets(autolinkBareDomains(autolinkBareUrls(seg))),
  );
  return normalizeSourcesSection(withBareUrls);
}

export function normalizeTimelineTitleMarkdownForDisplay(text: string): string {
  // Normalize inline headings (### mid-line -> line-start) and lists
  const normalized = normalizeInlineLists(
    normalizeInlineHeadings(normalizeMarkdownForDisplay(text)),
  );
  // Escape only single # so shell comments like "# route check" are not rendered
  // as <h1>. Allow ##, ###, etc. to render as headings.
  return normalized.replace(
    /^( {0,3})(#)(?=\s)/gm,
    (_match: string, indent: string, hash: string) =>
      `${indent}${hash.replace(/#/g, "\\#")}`,
  );
}

export function cleanAssistantMessageForDisplay(message: string): string {
  const sanitized = String(message || "")
    .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "")
    .trim();
  return normalizeMarkdownForDisplay(
    normalizeInlineLists(unwrapMarkdownCodeBlocks(sanitized)),
  );
}

const buildMarkdownComponents = (options: {
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
  citations?: Array<{ index: number; url: string; title: string; snippet: string; domain: string; accessedAt: number; sourceTool: string }>;
}) => {
  const { workspacePath, onOpenViewer, citations } = options;

  /** Map citation index → citation for O(1) lookup */
  const citationMap = new Map(
    (citations || []).map((c) => [c.index, c]),
  );

  /** Map normalised citation URL → citation for enriched link rendering */
  const citationUrlMap = new Map(
    (citations || []).map((c) => [c.url.replace(/\/+$/, "").toLowerCase(), c]),
  );

  const MarkdownLink = ({ href, children, ...props }: Any) => {
    if (!href) {
      return <a {...props}>{children}</a>;
    }

    const linkText = getTextContent(children);
    const fileTarget = resolveFileLinkTarget(href, linkText);

    if (fileTarget || isFileLink(href)) {
      const filePath = fileTarget ?? normalizeFileHref(href);
      const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (onOpenViewer && workspacePath) {
          onOpenViewer(filePath);
          return;
        }

        if (!workspacePath) return;

        try {
          const error = await window.electronAPI.openFile(filePath, workspacePath);
          if (error) {
            console.error("Failed to open file:", error);
          }
        } catch (err) {
          console.error("Error opening file:", err);
        }
      };

      const handleContextMenu = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!workspacePath) return;
        try {
          await window.electronAPI.showInFinder(filePath, workspacePath);
        } catch (err) {
          console.error("Error showing in Finder:", err);
        }
      };

      return (
        <a
          {...props}
          href={href}
          className={`clickable-file-path ${props.className || ""}`.trim()}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title={`${filePath}\n\nClick to preview • Right-click to show in Finder`}
        >
          {children}
        </a>
      );
    }

    if (isExternalHttpLink(href)) {
      const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.electronAPI.openExternal(href);
        } catch (err) {
          console.error("Error opening link:", err);
        }
      };

      // Check if this link matches a citation — render an enriched card
      const normHref = href.replace(/\/+$/, "").toLowerCase();
      const matchedCitation = citationUrlMap.get(normHref);
      const matchedCitationUrl =
        matchedCitation && typeof matchedCitation.url === "string" ? matchedCitation.url : href;
      const matchedCitationTitle =
        matchedCitation && typeof matchedCitation.title === "string"
          ? stripHtmlTags(matchedCitation.title)
          : "";
      const matchedCitationDomain =
        matchedCitation && typeof matchedCitation.domain === "string"
          ? stripHtmlTags(matchedCitation.domain)
          : "";
      const shouldRenderCitationCard =
        !!matchedCitation &&
        matchedCitationTitle.length > 0 &&
        matchedCitationTitle !== matchedCitationUrl &&
        !isUrlLikeLabel(linkText);

      if (shouldRenderCitationCard) {
        const citationDomain = matchedCitationDomain || extractDomainFromUrl(matchedCitationUrl);
        return (
          <a
            {...props}
            href={href}
            onClick={handleClick}
            className="citation-source-link"
            title={matchedCitationUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 6,
              background: "var(--surface-secondary, #1a1a1a)",
              border: "1px solid var(--border-color, #333)",
              textDecoration: "none",
              color: "inherit",
              transition: "background 0.15s, border-color 0.15s",
              maxWidth: "100%",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background =
                "var(--surface-hover, rgba(255,255,255,0.08))";
              (e.currentTarget as HTMLAnchorElement).style.borderColor =
                "var(--accent-color, #60a5fa)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background =
                "var(--surface-secondary, #1a1a1a)";
              (e.currentTarget as HTMLAnchorElement).style.borderColor =
                "var(--border-color, #333)";
            }}
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${citationDomain}&sz=16`}
              alt=""
              width={14}
              height={14}
              style={{ borderRadius: 2, flexShrink: 0 }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--text-primary, #e5e5e5)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {matchedCitationTitle}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 10,
                  color: "var(--text-tertiary, #666)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {citationDomain}
              </span>
            </span>
          </a>
        );
      }

      return (
        <a {...props} href={href} onClick={handleClick}>
          {children}
        </a>
      );
    }

    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  };

  /**
   * Replace citation references like [1], [2] in text children with
   * interactive CitationBadge components.
   */
  const replaceCitationsInChildren = (children: React.ReactNode): React.ReactNode => {
    if (citationMap.size === 0) return replaceEmojisInChildren(children);

    return Children.map(children, (child) => {
      if (typeof child === "string") {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;

        CITATION_REF_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CITATION_REF_REGEX.exec(child)) !== null) {
          const idx = parseInt(match[1], 10);
          const citation = citationMap.get(idx);
          if (!citation) continue;

          if (match.index > lastIndex) {
            parts.push(child.slice(lastIndex, match.index));
          }
          parts.push(
            <CitationBadge key={`cite-${idx}-${match.index}`} index={idx} citation={citation} />,
          );
          lastIndex = match.index + match[0].length;
        }

        if (parts.length === 0) return replaceEmojisInChildren(child);

        if (lastIndex < child.length) {
          parts.push(child.slice(lastIndex));
        }
        return <>{parts.map((p) => (typeof p === "string" ? replaceEmojisInChildren(p) : p))}</>;
      }
      return child;
    });
  };

  // Custom components for ReactMarkdown
  return {
    code: CodeBlock,
    h1: renderHeading("h1"),
    h2: renderHeading("h2"),
    h3: renderHeading("h3"),
    table: ({ children, ...props }: Any) => (
      <div className="markdown-table-wrapper">
        <table {...props}>{children}</table>
      </div>
    ),
    a: MarkdownLink,
    img: ({ src, alt, title }: Any) => (
      <MarkdownImagePreview
        src={typeof src === "string" ? src : ""}
        alt={typeof alt === "string" ? alt : ""}
        title={typeof title === "string" ? title : undefined}
        workspacePath={workspacePath}
      />
    ),
    p: ({ children, ...props }: Any) => <p {...props}>{replaceCitationsInChildren(children)}</p>,
    li: ({ children, ...props }: Any) => <li {...props}>{replaceCitationsInChildren(children)}</li>,
  };
};

const userMarkdownPlugins = [remarkGfm, remarkBreaks];

// Searchable Model Dropdown Component
interface ModelDropdownProps {
  models: LLMModelInfo[];
  selectedModel: string;
  selectedProvider: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  providers?: LLMProviderInfo[];
  onModelChange: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
}

function ModelDropdown({
  models,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  providers = [],
  onModelChange,
  onOpenSettings,
}: ModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeProviderMenu, setActiveProviderMenu] =
    useState<LLMProviderType | null>(null);
  const [providerModelCache, setProviderModelCache] = useState<
    Record<string, LLMModelInfo[]>
  >({});
  const [loadingProviderModels, setLoadingProviderModels] = useState<
    string | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProviderModelCache((prev) => ({
      ...prev,
      [selectedProvider]: models,
    }));
  }, [models, selectedProvider]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
        setActiveProviderMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const configuredProviders = useMemo(() => {
    const seen = new Set<string>();
    const list = providers.filter((provider) => provider.configured);
    const currentProvider = providers.find((provider) => provider.type === selectedProvider);
    if (currentProvider && !list.some((provider) => provider.type === currentProvider.type)) {
      list.unshift(currentProvider);
    }
    return list.filter((provider) => {
      if (seen.has(provider.type)) return false;
      seen.add(provider.type);
      return true;
    });
  }, [providers, selectedProvider]);

  const currentProviderModels = providerModelCache[selectedProvider] || models;
  const selectedModelInfo =
    currentProviderModels.find((model) => model.key === selectedModel) ||
    models.find((model) => model.key === selectedModel);
  const selectedModelLabel = selectedModelInfo?.displayName || selectedModel || "Select Model";
  const currentProviderLabel =
    configuredProviders.find((provider) => provider.type === selectedProvider)?.name ||
    selectedProvider;

  const selectedReasoningEfforts =
    selectedModelInfo?.reasoningEfforts ||
    getLlmModelReasoningEfforts(selectedProvider, selectedModel);
  const effectiveReasoningEffort =
    selectedReasoningEffort &&
    selectedReasoningEfforts.includes(selectedReasoningEffort)
      ? selectedReasoningEffort
      : undefined;

  const normalizedSearch = search.trim().toLowerCase();
  const filteredModels = currentProviderModels.filter((model) => {
    if (!normalizedSearch) return true;
    return (
      model.displayName.toLowerCase().includes(normalizedSearch) ||
      model.key.toLowerCase().includes(normalizedSearch) ||
      model.description.toLowerCase().includes(normalizedSearch)
    );
  });

  const otherProviders = configuredProviders.filter(
    (provider) => provider.type !== selectedProvider,
  );

  const loadProviderModels = useCallback(async (providerType: LLMProviderType) => {
    if (providerModelCache[providerType]) return;
    try {
      setLoadingProviderModels(providerType);
      const providerModels = await window.electronAPI.getProviderModels(providerType);
      setProviderModelCache((prev) => ({
        ...prev,
        [providerType]: providerModels || [],
      }));
    } catch (error) {
      console.error("Failed to load provider models:", error);
      setProviderModelCache((prev) => ({
        ...prev,
        [providerType]: [],
      }));
    } finally {
      setLoadingProviderModels((current) =>
        current === providerType ? null : current,
      );
    }
  }, [providerModelCache]);

  const selectModel = (
    providerType: LLMProviderType,
    modelKey: string,
    modelInfo?: LLMModelInfo,
  ) => {
    const reasoningEfforts =
      modelInfo?.reasoningEfforts ||
      getLlmModelReasoningEfforts(providerType, modelKey);
    const reasoningEffort =
      selectedReasoningEffort && reasoningEfforts.includes(selectedReasoningEffort)
        ? selectedReasoningEffort
        : reasoningEfforts.includes("medium")
          ? "medium"
          : reasoningEfforts[0];

    onModelChange({
      providerType,
      modelKey,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    setIsOpen(false);
    setSearch("");
    setActiveProviderMenu(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (filteredModels[0]) {
          selectModel(selectedProvider, filteredModels[0].key, filteredModels[0]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearch("");
        setActiveProviderMenu(null);
        break;
    }
  };

  const handleOpenProviders = () => {
    setIsOpen(false);
    setSearch("");
    setActiveProviderMenu(null);
    onOpenSettings?.("llm");
  };

  return (
    <div className="model-dropdown-container" ref={containerRef}>
      <button
        className={`model-selector ${isOpen ? "open" : ""}`}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          } else {
            setActiveProviderMenu(null);
          }
        }}
        onKeyDown={handleKeyDown}
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
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
          <path d="M18 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
        </svg>
        <span>{selectedModelLabel}</span>
        {effectiveReasoningEffort && (
          <span className="model-selector-effort">
            {
              LLM_REASONING_EFFORT_OPTIONS.find(
                (option) => option.value === effectiveReasoningEffort,
              )?.label
            }
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={isOpen ? "chevron-up" : ""}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {isOpen && (
        <div className="model-dropdown">
          {selectedReasoningEfforts.length > 0 && (
            <div className="model-dropdown-section">
              <div className="model-dropdown-section-label">Intelligence</div>
              {LLM_REASONING_EFFORT_OPTIONS.filter((option) =>
                selectedReasoningEfforts.includes(option.value),
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`model-dropdown-item compact ${option.value === effectiveReasoningEffort ? "selected" : ""}`}
                  onClick={() =>
                    onModelChange({
                      providerType: selectedProvider,
                      modelKey: selectedModel,
                      reasoningEffort: option.value,
                    })
                  }
                >
                  <span className="model-dropdown-item-name">{option.label}</span>
                  {option.value === effectiveReasoningEffort && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="model-dropdown-search">
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
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Search ${currentProviderLabel} models...`}
              autoFocus
            />
          </div>
          <div className="model-dropdown-section-label model-dropdown-provider-label">
            {currentProviderLabel}
          </div>
          <div className="model-dropdown-list">
            {filteredModels.length === 0 ? (
              <div className="model-dropdown-no-results">No models found</div>
            ) : (
              filteredModels.map((model) => (
                <button
                  key={model.key}
                  className={`model-dropdown-item ${model.key === selectedModel ? "selected" : ""}`}
                  onClick={() => selectModel(selectedProvider, model.key, model)}
                >
                  <div className="model-dropdown-item-content">
                    <span className="model-dropdown-item-name">{model.displayName}</span>
                    <span className="model-dropdown-item-desc">{model.description}</span>
                  </div>
                  {model.key === selectedModel && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
          {otherProviders.length > 0 && (
            <div className="model-dropdown-section model-dropdown-other-providers">
              <div className="model-dropdown-section-label">Other providers</div>
              {otherProviders.map((provider) => {
                const providerModels = providerModelCache[provider.type] || [];
                const isActive = activeProviderMenu === provider.type;
                return (
                  <div
                    key={provider.type}
                    className="model-dropdown-provider-row"
                    onMouseEnter={() => {
                      setActiveProviderMenu(provider.type);
                      void loadProviderModels(provider.type);
                    }}
                  >
                    <button
                      type="button"
                      className={`model-dropdown-item compact ${isActive ? "highlighted" : ""}`}
                      onClick={() => {
                        setActiveProviderMenu(isActive ? null : provider.type);
                        void loadProviderModels(provider.type);
                      }}
                    >
                      <span className="model-dropdown-item-name">{provider.name}</span>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                    {isActive && (
                      <div className="model-dropdown-submenu">
                        {loadingProviderModels === provider.type ? (
                          <div className="model-dropdown-no-results">Loading models...</div>
                        ) : providerModels.length === 0 ? (
                          <div className="model-dropdown-no-results">No models found</div>
                        ) : (
                          providerModels.map((model) => (
                            <button
                              key={model.key}
                              type="button"
                              className="model-dropdown-item"
                              onClick={() => selectModel(provider.type, model.key, model)}
                            >
                              <div className="model-dropdown-item-content">
                                <span className="model-dropdown-item-name">
                                  {model.displayName}
                                </span>
                                <span className="model-dropdown-item-desc">
                                  {model.description}
                                </span>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="model-dropdown-footer">
            <button
              type="button"
              className="model-dropdown-provider-btn"
              onClick={handleOpenProviders}
            >
              Model settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Clickable file path component - opens file viewer on click, shows in Finder on right-click
function ClickableFilePath({
  path,
  workspacePath,
  className = "",
  onOpenViewer,
}: {
  path: string;
  workspacePath?: string;
  className?: string;
  onOpenViewer?: (path: string) => void;
}) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // If viewer callback is provided and we have a workspace, use the in-app viewer
    if (onOpenViewer && workspacePath) {
      onOpenViewer(path);
      return;
    }

    // Fallback to external app
    try {
      const error = await window.electronAPI.openFile(path, workspacePath);
      if (error) {
        console.error("Failed to open file:", error);
      }
    } catch (err) {
      console.error("Error opening file:", err);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await window.electronAPI.showInFinder(path, workspacePath);
    } catch (err) {
      console.error("Error showing in Finder:", err);
    }
  };

  // Extract filename for display
  const fileName = path.split("/").pop() || path;

  return (
    <span
      className={`clickable-file-path ${className}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={`${path}\n\nClick to preview • Right-click to show in Finder`}
    >
      {fileName}
    </span>
  );
}

type InputRequestAnswers = Record<string, { optionLabel?: string; otherText?: string }>;

interface StructuredInputPromptCardProps {
  request: InputRequest;
  onSubmit: (answers: InputRequestAnswers) => void;
  onDismiss: () => void;
}

function StructuredInputPromptCard({ request, onSubmit, onDismiss }: StructuredInputPromptCardProps) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [selectedOptionByQuestion, setSelectedOptionByQuestion] = useState<Record<string, number>>({});
  const [otherTextByQuestion, setOtherTextByQuestion] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  useEffect(() => {
    const nextSelected: Record<string, number> = {};
    for (const question of questions) {
      if (typeof question?.id === "string" && question.id.trim()) {
        nextSelected[question.id] = 0;
      }
    }
    setSelectedOptionByQuestion(nextSelected);
    setOtherTextByQuestion({});
    setActiveQuestionIndex(0);
  }, [request.id, questions]);

  const updateSelection = useCallback(
    (questionId: string, nextIndex: number) => {
      setSelectedOptionByQuestion((prev) => ({
        ...prev,
        [questionId]: Math.max(0, nextIndex),
      }));
    },
    [],
  );

  const isQuestionAnswered = useCallback(
    (question: InputRequest["questions"][number]) => {
      if (!question || typeof question?.id !== "string") return false;
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") return false;
      const options = Array.isArray(question.options) ? question.options : [];
      const isOther = selected === options.length;
      if (!isOther) return true;
      return (otherTextByQuestion[question.id] || "").trim().length > 0;
    },
    [otherTextByQuestion, selectedOptionByQuestion],
  );

  const activeQuestion = useMemo(() => {
    if (!questions.length) return null;
    const safeIndex = Math.max(0, Math.min(questions.length - 1, activeQuestionIndex));
    return questions[safeIndex] ?? null;
  }, [activeQuestionIndex, questions]);

  const activeOptions = useMemo(
    () => (activeQuestion && Array.isArray(activeQuestion.options) ? activeQuestion.options : []),
    [activeQuestion],
  );
  const activeSelected =
    activeQuestion && typeof selectedOptionByQuestion[activeQuestion.id] === "number"
      ? selectedOptionByQuestion[activeQuestion.id]
      : 0;
  const activeOtherSelected = activeSelected === activeOptions.length;

  const getActiveOptionCount = useCallback(() => activeOptions.length + 1, [activeOptions.length]);

  const goToNextQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.min(questions.length - 1, prev + 1));
  }, [questions.length]);

  const goToPreviousQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const currentQuestionAnswered = useMemo(
    () => (activeQuestion ? isQuestionAnswered(activeQuestion) : false),
    [activeQuestion, isQuestionAnswered],
  );

  const canSubmit = useMemo(
    () => questions.length > 0 && questions.every((question) => isQuestionAnswered(question)),
    [isQuestionAnswered, questions],
  );

  const buildAnswers = useCallback((): InputRequestAnswers => {
    const answers: InputRequestAnswers = {};
    for (const question of questions) {
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") continue;
      if (selected < question.options.length) {
        answers[question.id] = {
          optionLabel: question.options[selected]?.label,
        };
      } else {
        answers[question.id] = {
          otherText: (otherTextByQuestion[question.id] || "").trim(),
        };
      }
    }
    return answers;
  }, [otherTextByQuestion, questions, selectedOptionByQuestion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!questions.length || !activeQuestion) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const activeTag = activeElement?.tagName?.toLowerCase();
      const typingInInput = activeTag === "textarea" || activeTag === "input";
      const selected = selectedOptionByQuestion[activeQuestion.id] ?? 0;
      const optionCount = getActiveOptionCount();

      if (/^[1-4]$/.test(event.key) && !typingInInput) {
        const nextIndex = Number(event.key) - 1;
        if (nextIndex < optionCount) {
          event.preventDefault();
          updateSelection(activeQuestion.id, nextIndex);
        }
        return;
      }

      if (event.key === "ArrowUp" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.max(0, selected - 1));
        return;
      }
      if (event.key === "ArrowDown" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.min(optionCount - 1, selected + 1));
        return;
      }

      if (event.key === "ArrowLeft" && !typingInInput) {
        event.preventDefault();
        goToPreviousQuestion();
        return;
      }
      if (event.key === "ArrowRight" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1 && currentQuestionAnswered) {
          goToNextQuestion();
        }
        return;
      }

      if (event.key === "Enter" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1) {
          if (currentQuestionAnswered) {
            goToNextQuestion();
          }
          return;
        }
        if (canSubmit) {
          onSubmit(buildAnswers());
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeQuestion,
    activeQuestionIndex,
    buildAnswers,
    canSubmit,
    currentQuestionAnswered,
    getActiveOptionCount,
    goToNextQuestion,
    goToPreviousQuestion,
    onDismiss,
    onSubmit,
    questions,
    selectedOptionByQuestion,
    updateSelection,
  ]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="input-request-composer-shell" role="dialog" aria-modal="true" aria-label="Structured input required">
      <div className="input-request-card input-request-card-inline">
        <div className="input-request-progress">
          <span className="input-request-header">{activeQuestion.header || "Question"}</span>
          <span className="input-request-progress-index">
            {Math.min(activeQuestionIndex + 1, questions.length)} / {questions.length}
          </span>
        </div>
        <div className="input-request-title">{activeQuestion.question}</div>
        <div className="input-request-options">
          {activeOptions.map((option, optionIndex) => (
            <button
              key={`${activeQuestion.id}-option-${optionIndex}`}
              className={`input-request-option ${activeSelected === optionIndex ? "selected" : ""}`}
              onClick={() => {
                updateSelection(activeQuestion.id, optionIndex);
              }}
            >
              <span className="input-request-option-index">{optionIndex + 1}.</span>
              <span className="input-request-option-copy">
                <span className="input-request-option-label">{option.label}</span>
                <span className="input-request-option-description">{option.description}</span>
              </span>
            </button>
          ))}
          <button
            className={`input-request-option ${activeOtherSelected ? "selected" : ""}`}
            onClick={() => {
              updateSelection(activeQuestion.id, activeOptions.length);
            }}
          >
            <span className="input-request-option-index">{activeOptions.length + 1}.</span>
            <span className="input-request-option-copy">
              <span className="input-request-option-label">Other</span>
              <span className="input-request-option-description">Type a custom response</span>
            </span>
          </button>
        </div>
        {activeOtherSelected && (
          <textarea
            className="input-request-other"
            placeholder="Tell Codex what to do differently..."
            value={otherTextByQuestion[activeQuestion.id] || ""}
            onChange={(event) =>
              setOtherTextByQuestion((prev) => ({
                ...prev,
                [activeQuestion.id]: event.target.value,
              }))
            }
          />
        )}
        <div className="input-request-hint">Use 1-4 to choose, Enter to continue, Esc to dismiss.</div>
        <div className="input-request-actions">
          <button className="input-request-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
          <button
            className="input-request-dismiss"
            onClick={goToPreviousQuestion}
            disabled={activeQuestionIndex === 0}
          >
            Back
          </button>
          {activeQuestionIndex < questions.length - 1 ? (
            <button
              className="input-request-submit"
              onClick={goToNextQuestion}
              disabled={!currentQuestionAnswered}
            >
              Next
            </button>
          ) : (
            <button
              className="input-request-submit"
              onClick={() => onSubmit(buildAnswers())}
              disabled={!canSubmit}
            >
              Submit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface CreateTaskOptions {
  autonomousMode?: boolean;
  permissionMode?: PermissionMode;
  shellAccess?: boolean;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
  multiLlmConfig?: import("../../shared/types").MultiLlmConfig;
  verificationAgent?: boolean;
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
  chronicleMode?: import("../../shared/types").ChronicleTaskMode;
  videoGenerationMode?: boolean;
}

const EXECUTION_MODE_ORDER: ExecutionMode[] = ["chat", "execute", "plan", "analyze", "debug", "verified"];
const TASK_DOMAIN_ORDER: TaskDomain[] = [
  "auto",
  "code",
  "research",
  "operations",
  "writing",
  "general",
  "media",
];
const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  chat: "Chat",
  execute: "Execute",
  plan: "Plan",
  analyze: "Analyze",
  debug: "Debug",
  verified: "Verified",
};
const EXECUTION_MODE_HINT: Record<ExecutionMode, string> = {
  chat: "Direct chat, no tools",
  execute: "Full task execution with tools",
  plan: "Planning mode, no mutating tools",
  analyze: "Read-only analysis mode",
  debug: "Evidence-first debugging: instrument, reproduce, fix, clean up",
  verified: "Execute with verification after each step",
};
const TASK_DOMAIN_LABEL: Record<TaskDomain, string> = {
  auto: "Auto",
  code: "Code",
  research: "Research",
  operations: "Operations",
  writing: "Writing",
  general: "General",
  media: "Video",
};
const TASK_DOMAIN_HINT: Record<TaskDomain, string> = {
  auto: "Adapts orchestration automatically",
  code: "Optimized for coding and refactors",
  research: "Optimized for research and synthesis",
  operations: "Optimized for infra and operational workflows",
  writing: "Optimized for writing and editing output",
  general: "Balanced behavior for mixed tasks",
  media: "Video generation mode — uses video tools strongly",
};
const EXECUTION_MODE_ICON: Record<ExecutionMode, LucideIcon> = {
  chat: MessageCircle,
  execute: Play,
  plan: ListTodo,
  analyze: Search,
  debug: Bug,
  verified: ShieldCheck,
};
const TASK_DOMAIN_ICON: Record<TaskDomain, LucideIcon> = {
  auto: Sparkles,
  code: Code,
  research: BookOpen,
  operations: Settings,
  writing: PenLine,
  general: LayoutGrid,
  media: Film,
};
type SettingsTab =
  | "appearance"
  | "llm"
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
  | "voice"
  | "scheduled"
  | "mcp";

// ---- Focused mode card pool ----
interface FocusedCard {
  id: string;
  emoji: string;
  iconName: string;
  title: string;
  desc: string;
  action: { type: "prompt"; prompt: string } | { type: "settings"; tab: SettingsTab };
  category: "task" | "setup" | "discover";
}

const FOCUSED_CARD_POOL: FocusedCard[] = [
  // --- Task starters ---
  {
    id: "write",
    emoji: "✏️",
    iconName: "edit",
    title: "Write something",
    desc: "Emails, reports, documents, or creative content",
    action: {
      type: "prompt",
      prompt:
        "I have a writing task for you. Let me describe what I need and let's create it together.",
    },
    category: "task",
  },
  {
    id: "research",
    emoji: "🔍",
    iconName: "search",
    title: "Research a topic",
    desc: "Deep-dive into any subject and get a summary",
    action: {
      type: "prompt",
      prompt: "I need help researching a topic. Let me tell you what I'm looking into.",
    },
    category: "task",
  },
  {
    id: "analyze",
    emoji: "📊",
    iconName: "chart",
    title: "Analyze data",
    desc: "Crunch numbers, find patterns, build reports",
    action: {
      type: "prompt",
      prompt:
        "I have some data I'd like to analyze. Let me share the files and tell you what I'm looking for.",
    },
    category: "task",
  },
  {
    id: "files",
    emoji: "📁",
    iconName: "folder",
    title: "Work with files",
    desc: "Sort, rename, convert, or organize anything",
    action: {
      type: "prompt",
      prompt:
        "I need help working with some files. Let me point you to the folder and explain what I need.",
    },
    category: "task",
  },
  {
    id: "build",
    emoji: "⚡",
    iconName: "zap",
    title: "Build something",
    desc: "Code, automate, or create from scratch",
    action: {
      type: "prompt",
      prompt: "I need help building or coding something. Let me describe the project.",
    },
    category: "task",
  },
  {
    id: "chat",
    emoji: "💬",
    iconName: "message",
    title: "Just chat",
    desc: "Think out loud, brainstorm, or ask me anything",
    action: {
      type: "prompt",
      prompt: "Let's just chat. I have something on my mind I'd like to talk through.",
    },
    category: "task",
  },
  {
    id: "meeting",
    emoji: "📋",
    iconName: "clipboard",
    title: "Prep for a meeting",
    desc: "Create agendas, talking points, and notes",
    action: {
      type: "prompt",
      prompt: "Help me prepare for a meeting. I need an agenda and talking points.",
    },
    category: "task",
  },
  {
    id: "document",
    emoji: "📄",
    iconName: "filetext",
    title: "Create a document",
    desc: "Word docs, PDFs, presentations, or spreadsheets",
    action: {
      type: "prompt",
      prompt: "I need to create a document. Let me describe the format and content I need.",
    },
    category: "task",
  },
  {
    id: "email",
    emoji: "✉️",
    iconName: "edit",
    title: "Draft an email",
    desc: "Professional, clear, and on-point every time",
    action: {
      type: "prompt",
      prompt: "Help me draft an email. Here's the context and who it's for.",
    },
    category: "task",
  },
  {
    id: "summarize",
    emoji: "📝",
    iconName: "filetext",
    title: "Summarize something",
    desc: "Condense long texts, articles, or meeting notes",
    action: {
      type: "prompt",
      prompt: "I have something I need summarized. Let me share it with you.",
    },
    category: "task",
  },
  {
    id: "code",
    emoji: "💻",
    iconName: "code",
    title: "Debug or review code",
    desc: "Find bugs, explain code, or suggest improvements",
    action: {
      type: "prompt",
      prompt: "I have some code I need help with. Let me share it and explain the issue.",
    },
    category: "task",
  },
  {
    id: "translate",
    emoji: "🌐",
    iconName: "globe",
    title: "Translate content",
    desc: "Translate text between any languages",
    action: {
      type: "prompt",
      prompt: "I need something translated. Let me share the text and the target language.",
    },
    category: "task",
  },
  {
    id: "morning-brief",
    emoji: "☀️",
    iconName: "calendar",
    title: "Create a daily brief",
    desc: "Inbox, calendar, tasks, and top priorities",
    action: {
      type: "prompt",
      prompt:
        "Create a daily brief for me. Use my calendar, inbox, tasks, and workspace context if they are connected. Include today's schedule, urgent messages, open commitments, and the top 3 actions to take next.",
    },
    category: "task",
  },
  {
    id: "inbox-triage",
    emoji: "📬",
    iconName: "message",
    title: "Triage my inbox",
    desc: "Find urgent mail, drafts, and follow-ups",
    action: {
      type: "prompt",
      prompt:
        "Triage my inbox. If Gmail or another mailbox is connected, identify messages that need a reply, urgent decisions, follow-ups, waiting items, and safe archive candidates. Ask before taking any action.",
    },
    category: "task",
  },
  {
    id: "slide-deck",
    emoji: "🖥️",
    iconName: "filetext",
    title: "Make a slide deck",
    desc: "Turn notes into a polished presentation",
    action: {
      type: "prompt",
      prompt:
        "Create a slide deck from material I provide. Ask for the audience and goal first, then build a clear outline, slide copy, speaker notes, and a polished deck artifact.",
    },
    category: "task",
  },
  {
    id: "spreadsheet-model",
    emoji: "📈",
    iconName: "chart",
    title: "Build a spreadsheet",
    desc: "Create models, trackers, and summaries",
    action: {
      type: "prompt",
      prompt:
        "Build a spreadsheet for a workflow I describe. Ask for the inputs and decisions it needs to support, then create a structured workbook with formulas, summaries, and clear tabs.",
    },
    category: "task",
  },
  {
    id: "transcribe-audio",
    emoji: "🎧",
    iconName: "filetext",
    title: "Transcribe audio",
    desc: "Extract notes, decisions, and action items",
    action: {
      type: "prompt",
      prompt:
        "Transcribe an audio or video file for me. After I share it, produce a clean transcript, key points, decisions, and action items.",
    },
    category: "task",
  },
  {
    id: "build-automation",
    emoji: "🔁",
    iconName: "zap",
    title: "Automate a workflow",
    desc: "Turn repeated work into a routine",
    action: {
      type: "prompt",
      prompt:
        "Help me automate a repeated workflow. Ask what triggers it, what information it needs, what actions it should take, and where approval is required before anything sensitive happens.",
    },
    category: "task",
  },
  {
    id: "decision-memo",
    emoji: "⚖️",
    iconName: "clipboard",
    title: "Compare options",
    desc: "Tradeoffs, risks, and a recommendation",
    action: {
      type: "prompt",
      prompt:
        "Help me compare options. I'll describe the decision, constraints, and candidates. Build a decision memo with tradeoffs, risks, unknowns, and a recommendation.",
    },
    category: "task",
  },

  // --- Setup & integration suggestions ---
  {
    id: "setup-whatsapp",
    emoji: "📱",
    iconName: "message",
    title: "Connect WhatsApp",
    desc: "Chat with your AI from WhatsApp",
    action: { type: "settings", tab: "whatsapp" },
    category: "setup",
  },
  {
    id: "setup-telegram",
    emoji: "✈️",
    iconName: "message",
    title: "Connect Telegram",
    desc: "Send tasks from Telegram anytime",
    action: { type: "settings", tab: "telegram" },
    category: "setup",
  },
  {
    id: "setup-slack",
    emoji: "💼",
    iconName: "message",
    title: "Connect Slack",
    desc: "Bring your AI into your team workspace",
    action: { type: "settings", tab: "slack" },
    category: "setup",
  },
  {
    id: "setup-google-workspace",
    emoji: "📎",
    iconName: "folder",
    title: "Connect Google Workspace",
    desc: "Use Gmail, Calendar, Drive, and Docs",
    action: { type: "settings", tab: "integrations" },
    category: "setup",
  },
  {
    id: "setup-web-search",
    emoji: "🌐",
    iconName: "globe",
    title: "Enable web search",
    desc: "Let tasks fetch live information",
    action: { type: "settings", tab: "search" },
    category: "setup",
  },
  {
    id: "setup-more-channels",
    emoji: "💬",
    iconName: "message",
    title: "Connect more channels",
    desc: "Add Teams, email, Signal, or Google Chat",
    action: { type: "settings", tab: "morechannels" },
    category: "setup",
  },
  {
    id: "setup-connectors",
    emoji: "🧰",
    iconName: "sliders",
    title: "Add app connectors",
    desc: "Connect GitHub, Figma, Vercel, and more",
    action: { type: "settings", tab: "integrations" },
    category: "setup",
  },
  {
    id: "setup-voice",
    emoji: "🎙️",
    iconName: "sliders",
    title: "Set up voice",
    desc: "Talk to your AI using your microphone",
    action: { type: "settings", tab: "voice" },
    category: "setup",
  },
  {
    id: "setup-skills",
    emoji: "🧩",
    iconName: "zap",
    title: "Explore skills",
    desc: "Add custom skills to extend capabilities",
    action: { type: "settings", tab: "skills" },
    category: "setup",
  },
  {
    id: "setup-schedule",
    emoji: "⏰",
    iconName: "calendar",
    title: "Schedule a task",
    desc: "Set up recurring tasks that run automatically",
    action: { type: "settings", tab: "scheduled" },
    category: "setup",
  },
  {
    id: "setup-mcp",
    emoji: "🔌",
    iconName: "sliders",
    title: "Connect tools",
    desc: "Add external tools and services",
    action: { type: "settings", tab: "mcp" },
    category: "setup",
  },
  {
    id: "setup-guardrails",
    emoji: "🛡️",
    iconName: "shield",
    title: "Set safety limits",
    desc: "Control what your AI can and cannot do",
    action: { type: "settings", tab: "system" },
    category: "setup",
  },

  {
    id: "competitors",
    emoji: "🏁",
    iconName: "search",
    title: "Research competitors",
    desc: "Analyze a market and find opportunities",
    action: {
      type: "prompt",
      prompt:
        "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
    },
    category: "task",
  },
  {
    id: "research-vault",
    emoji: "🧠",
    iconName: "book",
    title: "Build a research vault",
    desc: "Create a persistent Obsidian-friendly knowledge base",
    action: {
      type: "prompt",
      prompt: LLM_WIKI_GUI_PROMPT,
    },
    category: "task",
  },
  {
    id: "validate-idea",
    emoji: "💡",
    iconName: "zap",
    title: "Validate an idea",
    desc: "Market size, competitors, and a go/no-go call",
    action: {
      type: "prompt",
      prompt:
        "Help me validate a business idea. I'll describe the concept, and you'll assess the market size, competitors, unique angle, and give a go/no-go recommendation.",
    },
    category: "task",
  },
  {
    id: "weekly-plan",
    emoji: "📅",
    iconName: "calendar",
    title: "Plan my week",
    desc: "Build a day-by-day schedule with priorities",
    action: {
      type: "prompt",
      prompt:
        "Help me create a weekly plan. Ask about my goals, deadlines, and priorities, then build a day-by-day schedule with clear deliverables.",
    },
    category: "task",
  },

  // --- Feature discovery ---
  {
    id: "discover-memory",
    emoji: "🧠",
    iconName: "book",
    title: "I remember things",
    desc: "I learn your preferences over time",
    action: { type: "prompt", prompt: "What do you remember about me and my preferences?" },
    category: "discover",
  },
  {
    id: "discover-browse",
    emoji: "🌍",
    iconName: "globe",
    title: "I can browse the web",
    desc: "Search, read pages, and fetch live data",
    action: {
      type: "prompt",
      prompt: "Search the web for the latest news on a topic I'll describe.",
    },
    category: "discover",
  },
  {
    id: "discover-files",
    emoji: "📂",
    iconName: "folder",
    title: "I can read your files",
    desc: "Drop files here or point me to a folder",
    action: { type: "prompt", prompt: "Show me what files are in my current workspace." },
    category: "discover",
  },
  {
    id: "discover-agents",
    emoji: "🤖",
    iconName: "zap",
    title: "I work autonomously",
    desc: "Give me a goal and I'll figure out the steps",
    action: {
      type: "prompt",
      prompt:
        "I have a complex task that needs multiple steps. Let me describe the goal and you plan it out.",
    },
    category: "discover",
  },
  {
    id: "discover-documents",
    emoji: "📑",
    iconName: "filetext",
    title: "I can make files",
    desc: "Docs, PDFs, slides, and spreadsheets",
    action: {
      type: "prompt",
      prompt:
        "Show me what kinds of documents, PDFs, slide decks, and spreadsheets you can create in this workspace.",
    },
    category: "discover",
  },
  {
    id: "discover-images",
    emoji: "🖼️",
    iconName: "search",
    title: "I can inspect images",
    desc: "Upload screenshots, mockups, or photos",
    action: {
      type: "prompt",
      prompt:
        "I want to analyze an image or screenshot. Tell me what you can inspect and what details are useful to include when I upload it.",
    },
    category: "discover",
  },
  {
    id: "discover-tests",
    emoji: "✅",
    iconName: "code",
    title: "I can run checks",
    desc: "Build, lint, test, and explain failures",
    action: {
      type: "prompt",
      prompt:
        "Check this project for quality issues. Inspect the available scripts, recommend the right build, lint, or test commands, and run the safest targeted checks.",
    },
    category: "discover",
  },
  {
    id: "discover-automations",
    emoji: "⏳",
    iconName: "calendar",
    title: "I can follow up",
    desc: "Create scheduled and recurring work",
    action: { type: "settings", tab: "scheduled" },
    category: "discover",
  },
  {
    id: "discover-vault",
    emoji: "🗂️",
    iconName: "book",
    title: "I can grow a vault",
    desc: "Save research, sources, and durable notes",
    action: {
      type: "prompt",
      prompt: LLM_WIKI_EXPLORE_GUI_PROMPT,
    },
    category: "discover",
  },
  {
    id: "discover-multimodel",
    emoji: "🔄",
    iconName: "sliders",
    title: "Switch AI models",
    desc: "Use Claude, GPT, Gemini, or local models",
    action: { type: "settings", tab: "llm" },
    category: "discover",
  },
];

const CARDS_TO_SHOW = 3;

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function pickFocusedCards(pool: FocusedCard[], count: number): FocusedCard[] {
  // Ensure a good mix while respecting the requested card count.
  const tasks = shuffleArray(pool.filter((c) => c.category === "task"));
  const setup = shuffleArray(pool.filter((c) => c.category === "setup"));
  const discover = shuffleArray(pool.filter((c) => c.category === "discover"));
  const categoryPicks = [tasks[0], setup[0], discover[0]].filter(Boolean) as FocusedCard[];
  const picked = categoryPicks.slice(0, count);
  // Fill remaining from the rest
  const usedIds = new Set(picked.map((c) => c.id));
  const remaining = shuffleArray(pool.filter((c) => !usedIds.has(c.id)));
  picked.push(...remaining.slice(0, count - picked.length));
  // Shuffle final order so categories aren't grouped
  return shuffleArray(picked);
}

interface MainContentProps {
  task: Task | undefined;
  selectedTaskId: string | null; // Added to distinguish "no task" from "task not in list"
  workspace: Workspace | null;
  events: TaskEvent[];
  sharedTaskEventUi?: SharedTaskEventUiState | null;
  childTasks?: Task[];
  childEvents?: TaskEvent[];
  onSelectChildTask?: (taskId: string) => void;
  onSelectTask?: (taskId: string) => void;
  onSendMessage: (
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
  ) => void;
  onStartOnboarding?: () => void;
  onCreateTask?: (
    title: string,
    prompt: string,
    options?: CreateTaskOptions,
    images?: ImageAttachment[],
  ) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  onEnableShellForPausedTask?: () => void | Promise<void>;
  onContinueWithoutShellForPausedTask?: () => void | Promise<void>;
  onWrapUpTask?: () => void;
  inputRequest?: InputRequest | null;
  onSubmitInputRequest?: (
    requestId: string,
    answers: Record<string, { optionLabel?: string; otherText?: string }>,
  ) => void;
  onDismissInputRequest?: (requestId: string) => void;
  onOpenBrowserView?: (url?: string) => void;
  onViewTaskOutputs?: (taskId: string, primaryOutputPath?: string) => void;
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
  rendererPerfLoggingEnabled?: boolean;
  remoteSession?: { deviceId: string; deviceName: string } | null;
  replayControls?: ReplayControls;
}

const STEP_WINDOW_SIZE = 7;
const VIRTUALIZED_FEED_ROW_THRESHOLD = 18;

type TaskFeedRow =
  | {
      kind: "leading-command-outputs";
      key: string;
      estimatedHeight: number;
      sessions: CommandOutputSession[];
      revision: string;
      visiblePerfEventId: null;
    }
  | {
      kind: "timeline";
      key: string;
      estimatedHeight: number;
      timelineIndex: number;
      item: any;
      revision: string;
      visiblePerfEventId: string | null;
    };

type SkillModalLaunchMode = "skill_menu" | "slash";

type SelectedSkillModalState = {
  skill: CustomSkill;
  launchMode: SkillModalLaunchMode;
};

export type TranscriptMode = "live" | "inspect";

function getTaskFeedRowEventType(row: TaskFeedRow): string | null {
  if (row.kind !== "timeline" || row.item.kind !== "event") return null;
  return getEffectiveTaskEventType(row.item.event as TaskEvent);
}

function getTaskFeedRowEvent(row: TaskFeedRow): TaskEvent | null {
  if (row.kind !== "timeline" || row.item.kind !== "event") return null;
  return row.item.event as TaskEvent;
}

function getTaskFeedRowVisiblePerfEventId(row: TaskFeedRow): string | null {
  return row.visiblePerfEventId ?? null;
}

const LIVE_TRANSCRIPT_TRANSIENT_RAW_EVENT_TYPES = new Set([
  "llm_output_budget",
  "llm_output_budget_escalation",
  "llm_streaming",
]);
const MAX_AGENT_REASONING_UPDATE_COUNT = 6;

const LIVE_TRANSCRIPT_URGENT_EFFECTIVE_EVENT_TYPES = new Set([
  "approval_requested",
  "error",
  "input_request_created",
  "step_failed",
  "task_cancelled",
  "task_completed",
  "verification_failed",
  "verification_pending_user_action",
]);

export function getDefaultTranscriptMode(args: {
  isTaskWorking: boolean;
  isReplayMode: boolean;
  verboseSteps: boolean;
  isChatTask: boolean;
}): TranscriptMode {
  return args.isTaskWorking && !args.isReplayMode && !args.verboseSteps && !args.isChatTask
    ? "live"
    : "inspect";
}

export function shouldShowBootstrapProgressRow(args: {
  isTaskWorking: boolean;
  visibleRenderableFeedRowsLength: number;
  isChatTask: boolean;
}): boolean {
  return args.isTaskWorking && args.visibleRenderableFeedRowsLength === 0 && !args.isChatTask;
}

export function getBootstrapProgressTitle(task: Task | null | undefined): string {
  switch (task?.status) {
    case "planning":
      return "Planning the approach";
    case "executing":
      return "Thinking";
    case "interrupted":
      return "Resuming work";
    default:
      return "Thinking";
  }
}

function isUserFacingProgressMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (/^thinking(?:\.\.\.)?$/i.test(trimmed)) return false;
  if (/^executing$/i.test(trimmed)) return false;
  if (/^progress_update$/i.test(trimmed)) return false;
  return true;
}

export interface AgentReasoningPanelState {
  activeStreamText: string;
  isStreaming: boolean;
  recentUpdates: string[];
}

function cleanAgentReasoningText(text: string): string {
  const sanitized = sanitizeToolCallTextFromAssistant(
    String(text || "")
      .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, ""),
  ).text;
  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

function isAgentReasoningStreamingEvent(event: TaskEvent): boolean {
  if (event.type === "llm_streaming") return true;
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  return event.type === "timeline_step_updated" && payload?.legacyType === "llm_streaming";
}

export function deriveAgentReasoningPanelState(args: {
  events: TaskEvent[];
  taskId?: string | null;
  isTaskWorking: boolean;
}): AgentReasoningPanelState {
  if (!args.taskId || !args.isTaskWorking) {
    return { activeStreamText: "", isStreaming: false, recentUpdates: [] };
  }

  const recentUpdates: string[] = [];
  let lastVisibleUpdate = "";

  for (const event of args.events) {
    if (event.taskId !== args.taskId || isAgentReasoningStreamingEvent(event)) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType !== "progress_update" && effectiveType !== "assistant_message") continue;
    if (effectiveType === "assistant_message" && event.payload?.internal === true) continue;
    const rawMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
    if (!isUserFacingProgressMessage(rawMessage)) continue;
    const message = cleanAgentReasoningText(
      effectiveType === "progress_update" ? humanizeTimelineMessage(rawMessage) : rawMessage,
    );
    if (!message || message === lastVisibleUpdate) continue;
    lastVisibleUpdate = message;
    recentUpdates.push(message);
    if (recentUpdates.length > MAX_AGENT_REASONING_UPDATE_COUNT) {
      recentUpdates.shift();
    }
  }

  let activeStreamText = "";
  let isStreaming = false;
  for (let index = args.events.length - 1; index >= 0; index -= 1) {
    const event = args.events[index];
    if (event.taskId !== args.taskId) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "log" || effectiveType === "llm_usage" || effectiveType === "command_output") {
      continue;
    }
    if (isAgentReasoningStreamingEvent(event)) {
      const rawText =
        typeof event.payload?.text === "string"
          ? event.payload.text
          : typeof event.payload?.message === "string"
            ? event.payload.message
            : "";
      const cleaned = cleanAgentReasoningText(rawText);
      if (cleaned && !/^thinking(?:\.\.\.)?$/i.test(cleaned)) {
        activeStreamText = cleaned;
        isStreaming = event.payload?.streaming === true;
      }
    }
    break;
  }

  return { activeStreamText, isStreaming, recentUpdates };
}

function hasAgentReasoningPanelContent(state: AgentReasoningPanelState): boolean {
  return state.activeStreamText.trim().length > 0 || state.recentUpdates.length > 0;
}

function isTransientLiveTranscriptRow(row: TaskFeedRow): boolean {
  const event = getTaskFeedRowEvent(row);
  if (!event) return false;
  if (LIVE_TRANSCRIPT_TRANSIENT_RAW_EVENT_TYPES.has(event.type)) return true;

  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "executing" || effectiveType === "llm_streaming") {
    return true;
  }
  if (effectiveType !== "progress_update") return false;

  const payloadMessage =
    typeof event.payload?.message === "string" ? event.payload.message : "";
  return !isUserFacingProgressMessage(payloadMessage);
}

function isUrgentLiveTranscriptRow(row: TaskFeedRow): boolean {
  const effectiveType = getTaskFeedRowEventType(row);
  return effectiveType ? LIVE_TRANSCRIPT_URGENT_EFFECTIVE_EVENT_TYPES.has(effectiveType) : false;
}

function isMeaningfulLiveTranscriptRow(row: TaskFeedRow): boolean {
  if (row.kind === "leading-command-outputs") return false;
  if (row.kind !== "timeline") return true;
  if (row.item.kind !== "event") return true;
  return !isTransientLiveTranscriptRow(row);
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

function isUserFacingLiveStatusRow(row: TaskFeedRow): boolean {
  const event = getTaskFeedRowEvent(row);
  if (!event || isTransientLiveTranscriptRow(row)) return false;

  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "step_started") return true;
  if (effectiveType !== "progress_update") return false;

  const payloadMessage =
    typeof event.payload?.message === "string" ? event.payload.message : "";
  return isUserFacingProgressMessage(payloadMessage);
}

export function selectVisibleTaskFeedRows(
  feedRows: TaskFeedRow[],
  transcriptMode: TranscriptMode,
): { visibleFeedRows: TaskFeedRow[]; hiddenLiveFeedRowCount: number } {
  if (transcriptMode !== "live" || feedRows.length <= 8) {
    return { visibleFeedRows: feedRows, hiddenLiveFeedRowCount: 0 };
  }

  const keepIndexes = new Set<number>();
  const keepLastMatch = (predicate: (row: TaskFeedRow) => boolean) => {
    for (let index = feedRows.length - 1; index >= 0; index -= 1) {
      if (predicate(feedRows[index])) {
        keepIndexes.add(index);
        return;
      }
    }
  };

  let meaningfulRowsKept = 0;
  for (let index = feedRows.length - 1; index >= 0 && meaningfulRowsKept < 4; index -= 1) {
    const row = feedRows[index];
    if (!isMeaningfulLiveTranscriptRow(row)) continue;
    keepIndexes.add(index);
    meaningfulRowsKept += 1;
  }

  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "action_block");
  keepLastMatch((row) => getTaskFeedRowEventType(row) === "assistant_message");
  keepLastMatch((row) => getTaskFeedRowEventType(row) === "user_message");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "dispatched-agents");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "cli-agent-frame");
  keepLastMatch((row) => row.kind === "timeline" && row.item.kind === "canvas");
  keepLastMatch((row) => isUserFacingLiveStatusRow(row));
  keepLastMatch((row) => isUrgentLiveTranscriptRow(row));

  const visibleFeedRows = feedRows.filter((_, index) => keepIndexes.has(index));
  return {
    visibleFeedRows,
    hiddenLiveFeedRowCount: Math.max(0, feedRows.length - visibleFeedRows.length),
  };
}

export function hasInactiveStringSetEntries(
  selectedIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
): boolean {
  for (const id of selectedIds) {
    if (!activeIds.has(id)) return true;
  }
  return false;
}

export function pruneStringSetToActiveIds(
  selectedIds: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const id of selectedIds) {
    if (activeIds.has(id)) next.add(id);
  }
  return next;
}

function getCommandOutputSessionsRevision(sessions: CommandOutputSession[] | undefined): string {
  if (!sessions || sessions.length === 0) return "none";
  return sessions
    .map(
      (session) =>
        `${session.id}:${session.isRunning ? 1 : 0}:${session.exitCode ?? "null"}:${session.output.length}`,
    )
    .join("|");
}

export function collectInlineRunCommandSessionIds(args: {
  events: TaskEvent[];
  eventIndices: number[];
  commandOutputSessionsByInsertIndex: Map<number, CommandOutputSession[]>;
  isEventExpanded: (event: TaskEvent) => boolean;
}): Set<string> {
  const inlineRunCommandSessionIds = new Set<string>();
  for (let idx = 0; idx < args.events.length; idx++) {
    const event = args.events[idx];
    const eventIndex = args.eventIndices[idx];
    if (
      getEffectiveTaskEventType(event) === "tool_call" &&
      event.payload?.tool === "run_command" &&
      args.isEventExpanded(event)
    ) {
      for (const session of args.commandOutputSessionsByInsertIndex.get(eventIndex) ?? []) {
        inlineRunCommandSessionIds.add(session.id);
      }
    }
  }
  return inlineRunCommandSessionIds;
}

export function estimateTaskFeedRowHeight(
  item: any,
  options?: {
    expanded?: boolean;
    visibleEventCount?: number;
    hasVisibilityToggle?: boolean;
  },
): number {
  if (item.kind === "canvas") return 320;
  if (item.kind === "cli-agent-frame") return 240;
  if (item.kind === "dispatched-agents") return 220;
  if (item.kind === "action_block") {
    const expanded = options?.expanded === true;
    const visibleEventCount = Math.max(0, options?.visibleEventCount ?? 0);
    const hasVisibilityToggle = options?.hasVisibilityToggle === true;

    // Virtualized history views should estimate against the collapsed/windowed
    // action block that is actually rendered, not the raw hidden event count.
    if (!expanded) return 56;

    const headerHeight = 44;
    const controlsHeight = hasVisibilityToggle ? 32 : 0;
    const eventsHeight = visibleEventCount * 56;
    const paddingHeight = visibleEventCount > 0 ? 20 : 8;
    return Math.min(520, headerHeight + controlsHeight + eventsHeight + paddingHeight);
  }

  const event = item.event as TaskEvent;
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message" || effectiveType === "user_message") {
    const messageLength =
      typeof event.payload?.message === "string" ? event.payload.message.length : 0;
    return Math.min(420, 120 + Math.ceil(messageLength / 180) * 44);
  }

  return 120;
}

function assignTimelineRef(
  ref: React.RefObject<HTMLDivElement | null> | undefined,
  node: HTMLDivElement | null,
) {
  if (!ref) return;
  (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
}

export function getAutoScrollTargetTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function shouldScheduleAutoScrollWrite(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastTargetTop: number | null;
}): boolean {
  const targetTop = getAutoScrollTargetTop(args.scrollHeight, args.clientHeight);
  const alreadyAtTarget = Math.abs(args.scrollTop - targetTop) < 2;
  return !(alreadyAtTarget && args.lastTargetTop !== null && Math.abs(args.lastTargetTop - targetTop) < 2);
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

const TaskConversationRenderedRows = memo(function TaskConversationRenderedRows({
  taskId,
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

  const renderedFeedEntries = useMemo(
    () =>
      visibleFeedRows.reduce<Array<{ row: TaskFeedRow; node: React.ReactNode }>>((acc, row) => {
        const node = getRenderedFeedRow(row);
        if (node === null || node === undefined || node === false) {
          return acc;
        }
        acc.push({ row, node });
        return acc;
      }, []),
    [getRenderedFeedRow, visibleFeedRows],
  );
  const renderableFeedRows = useMemo(
    () => renderedFeedEntries.map((entry) => entry.row),
    [renderedFeedEntries],
  );
  const renderedFeedNodeByKey = useMemo(
    () => new Map(renderedFeedEntries.map((entry) => [entry.row.key, entry.node])),
    [renderedFeedEntries],
  );
  const useVirtualizedFeed =
    transcriptMode === "live" &&
    renderableFeedRows.length >= VIRTUALIZED_FEED_ROW_THRESHOLD &&
    !isReplayMode;
  const [feedRowHeights, setFeedRowHeights] = useState<Map<string, number>>(() => new Map());
  const feedRowHeightsRef = useRef<Map<string, number>>(new Map());
  const pendingFeedRowHeightsRef = useRef<Map<string, number>>(new Map());
  const feedRowHeightFlushFrameRef = useRef<number | null>(null);
  const [conversationFlowOffsetTop, setConversationFlowOffsetTop] = useState(0);
  const conversationFlowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    feedRowHeightsRef.current = feedRowHeights;
  }, [feedRowHeights]);

  useEffect(() => {
    const activeKeys = new Set(renderableFeedRows.map((row) => row.key));
    setFeedRowHeights((prev) => {
      let changed = false;
      const next = new Map<string, number>();
      for (const [key, value] of prev.entries()) {
        if (activeKeys.has(key)) {
          next.set(key, value);
        } else {
          changed = true;
        }
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
  });
  const renderedFeedRows = useMemo(
    () => (useVirtualizedFeed ? virtualFeedRows.map((row) => row.item) : renderableFeedRows),
    [useVirtualizedFeed, virtualFeedRows, renderableFeedRows],
  );
  const showBootstrapProgress = shouldShowBootstrapProgressRow({
    isTaskWorking,
    visibleRenderableFeedRowsLength: renderedFeedEntries.length,
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
  const lastAssistantMessage = props.lastAssistantMessage as TaskEvent | null;
  const initialPromptEventId = props.initialPromptEventId as string | null;
  const markdownComponents = props.markdownComponents as any;
  const messageFeedbackMap = props.messageFeedbackMap as Map<string, string>;
  const mainBodyRef = props.mainBodyRef as React.RefObject<HTMLDivElement | null>;
  const onOpenBrowserView = props.onOpenBrowserView as ((url?: string) => void) | undefined;
  const onQuoteAssistantMessage = props.onQuoteAssistantMessage as
    | ((quote: QuotedAssistantMessage) => void)
    | undefined;
  const onSelectChildTask = props.onSelectChildTask as ((taskId: string) => void) | undefined;
  const onViewTaskOutputs = props.onViewTaskOutputs as
    | ((taskId: string, primaryOutputPath?: string) => void)
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
    });

    return rows;
  }, [
    childEvents,
    childTasks,
    collaborativeRun?.id,
    commandOutputSessionsByInsertIndex,
    leadingCommandOutputSessions,
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
  ]);
  const defaultTranscriptMode = getDefaultTranscriptMode({
    isTaskWorking,
    isReplayMode,
    verboseSteps,
    isChatTask,
  });
  const [transcriptModeOverride, setTranscriptModeOverride] = useState<TranscriptMode | null>(null);
  const transcriptMode = transcriptModeOverride ?? defaultTranscriptMode;
  useEffect(() => {
    setTranscriptModeOverride(null);
  }, [task?.id]);
  useEffect(() => {
    if (defaultTranscriptMode === "inspect" && transcriptModeOverride === "live") {
      setTranscriptModeOverride(null);
    }
  }, [defaultTranscriptMode, transcriptModeOverride]);
  const showFullTimeline = useCallback(() => {
    setTranscriptModeOverride("inspect");
  }, []);
  const returnToLiveTranscript = useCallback(() => {
    setTranscriptModeOverride("live");
  }, []);
  const { visibleFeedRows, hiddenLiveFeedRowCount } = useMemo(
    () => selectVisibleTaskFeedRows(feedRows, transcriptMode),
    [feedRows, transcriptMode],
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
                  if (row.kind === "leading-command-outputs") {
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
                        return `${event.id}:${toggled}:${parallel}:${suppressed}`;
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
                    parallelGroupsByAnchorEventId.has(event.id) ? 1 : 0,
                    suppressedParallelEventIds.has(event.id) ? 1 : 0,
                  ].join(":");
                };

                const renderFeedRow = (row: TaskFeedRow) => {
                  if (row.kind === "leading-command-outputs") {
                    return renderCommandOutputs(row.sessions);
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
                    />
                  );
                }

                if (item.kind === "dispatched-agents") {
                  // Filter out CLI agent tasks — they render in their own frames above
                  const nonCliChildTasks = childTasks.filter((t) => !isCliAgentChildTask(t));
                  const panelTasks = nonCliChildTasks.length > 0 ? nonCliChildTasks : childTasks;
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
                  const { summary, stepCount, toolCallCount, durationMs, outputTokens } = buildActionBlockSummary(
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
                                  onQuoteAssistantMessage,
                                  events,
                                  onViewOutputs: onViewTaskOutputs,
                                  hideVerificationSteps: true,
                                  summaryMode: !verboseSteps,
                                  task,
                                  childTasks,
                                  commandOutputSessions:
                                    commandOutputSessionsByInsertIndex.get(eventIndex) ?? [],
                                  renderCommandOutput: renderCommandOutputs,
                                })
                              : undefined;

                            return (
                              <Fragment key={event.id || `event-${eventIndex}`}>
                                <StepFeed
                                  title={
                                    typeof eventTitle === "string" ? (
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={eventTitleMarkdownComponents}
                                      >
                                        {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                                      </ReactMarkdown>
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
                  if (event.id === initialPromptEventId) {
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
                  const messageText = stripStrategyContextBlock(stripPptxBubbleContent(rawMessage));
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
                              <ReactMarkdown
                                remarkPlugins={userMarkdownPlugins}
                                components={markdownComponents}
                              >
                                {messageText}
                              </ReactMarkdown>
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
                            <ReactMarkdown
                              remarkPlugins={userMarkdownPlugins}
                              components={markdownComponents}
                            >
                              {messageText}
                            </ReactMarkdown>
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
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={eventTitleMarkdownComponents}
                          >
                            {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                          </ReactMarkdown>
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
                              onQuoteAssistantMessage,
                              events,
                              onViewOutputs: onViewTaskOutputs,
                              hideVerificationSteps: true,
                              summaryMode: !verboseSteps,
                              task,
                              childTasks,
                              commandOutputSessions: commandOutputsAfterEvent ?? [],
                              renderCommandOutput: renderCommandOutputs,
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
                    onBackToLiveView={returnToLiveTranscript}
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
      expandedActionBlocks,
      handleCanvasClose,
      handleMessageFeedback,
      onQuoteAssistantMessage,
      handleStepFeedback,
      isChatTask,
      isTaskWorking,
      isReplayMode,
      markdownComponents,
      mainBodyRef,
      messageFeedbackMap,
      onOpenBrowserView,
      onQuoteAssistantMessage,
      onSelectChildTask,
      onViewTaskOutputs,
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
      returnToLiveTranscript,
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
    prev.onOpenBrowserView === next.onOpenBrowserView &&
    prev.onQuoteAssistantMessage === next.onQuoteAssistantMessage &&
    prev.onSelectChildTask === next.onSelectChildTask &&
    prev.onViewTaskOutputs === next.onViewTaskOutputs
  );
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
  onSelectTask,
  onSendMessage,
  onStartOnboarding,
  onCreateTask,
  onChangeWorkspace,
  onSelectWorkspace,
  onOpenSettings,
  onStopTask,
  onEnableShellForPausedTask,
  onContinueWithoutShellForPausedTask,
  onWrapUpTask,
  inputRequest = null,
  onSubmitInputRequest,
  onDismissInputRequest,
  onOpenBrowserView,
  onViewTaskOutputs,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels,
  onModelChange,
  availableProviders = [],
  uiDensity = "focused",
  rendererPerfLoggingEnabled = false,
  remoteSession = null,
  replayControls,
}: MainContentProps) {
  recordRendererRender(
    "MainContent",
    task?.id ? `task:${task.id}` : selectedTaskId ?? "task:none",
    rendererPerfLoggingEnabled,
  );
  const events = useMemo(
    () => {
      if (sharedTaskEventUi) {
        return sharedTaskEventUi.normalizedEvents;
      }
      return measureRendererPerf("MainContent.normalizeEvents", rendererPerfLoggingEnabled, () =>
        normalizeEventsForTimelineUi(rawEvents),
      );
    },
    [rawEvents, rendererPerfLoggingEnabled, sharedTaskEventUi],
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
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTarget, setMentionTarget] = useState<{ start: number; end: number } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashTarget, setSlashTarget] = useState<{ start: number; end: number } | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  // Focused mode card pool - pick random cards on mount
  const focusedCards = useMemo(() => pickFocusedCards(FOCUSED_CARD_POOL, CARDS_TO_SHOW), []);

  // ── Rotating placeholder prompts (persona-aware engine) ──────────────
  const [rotatingPlaceholders, setRotatingPlaceholders] = useState<string[]>([]);
  const [rotatingIndex, setRotatingIndex] = useState(0);
  const [placeholderFading, setPlaceholderFading] = useState(false);
  const placeholderTimeoutRef = useRef<number | null>(null);
  const placeholderDebounceRef = useRef<number | null>(null);
  const placeholderPlaylistCacheRef = useRef<Map<string, string[]>>(new Map());
  const placeholderRequestIdRef = useRef(0);

  useEffect(() => {
    setQuotedAssistantMessage(null);
  }, [task?.id]);

  // Gather all user signals, run persona detection, and build the playlist
  useEffect(() => {
    let cancelled = false;
    const workspaceId = workspace?.id;
    const cacheKey = workspaceId ?? "global";
    const requestId = ++placeholderRequestIdRef.current;

    const cachedPlaylist = placeholderPlaylistCacheRef.current.get(cacheKey);
    if (cachedPlaylist !== undefined) {
      setRotatingIndex(0);
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
          await import("../utils/placeholderEngine");
        type UserSignals = import("../utils/placeholderEngine").UserSignals;

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
        setRotatingIndex(0);
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

  // Cycle placeholder every 4s with fade transition (only when input is empty)
  useEffect(() => {
    if (rotatingPlaceholders.length <= 1 || inputValue) return;
    const interval = setInterval(() => {
      if (placeholderTimeoutRef.current !== null) {
        clearTimeout(placeholderTimeoutRef.current);
      }
      setPlaceholderFading((prev) => (prev ? prev : true));
      placeholderTimeoutRef.current = window.setTimeout(() => {
        setRotatingIndex((prev) => (prev + 1) % rotatingPlaceholders.length);
        setPlaceholderFading((prev) => (prev ? false : prev));
        placeholderTimeoutRef.current = null;
      }, 300);
    }, 4000);
    return () => {
      clearInterval(interval);
      if (placeholderTimeoutRef.current !== null) {
        clearTimeout(placeholderTimeoutRef.current);
        placeholderTimeoutRef.current = null;
      }
    };
  }, [rotatingPlaceholders.length, inputValue]);

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
  const [collaborativeModeEnabled, setCollaborativeModeEnabled] = useState(false);
  const [multiLlmModeEnabled, setMultiLlmModeEnabled] = useState(false);
  const [chronicleEnabledForTask, setChronicleEnabledForTask] = useState(true);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [permissionAccessMode, setPermissionAccessMode] = useState<"default" | "full">("default");
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
    if (!workspace?.path || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
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
  }, [workspace?.id, workspace?.isTemp, workspace?.path]);

  useEffect(() => {
    if (task) {
      setWelcomeTaskSuggestions([]);
      setActiveWelcomeSuggestionDraft(null);
      return;
    }

    let cancelled = false;
    const validWorkspaceId =
      workspace?.id && !workspace.isTemp && !isTempWorkspaceId(workspace.id)
        ? workspace.id
        : undefined;

    const loadWelcomeTaskSuggestions = async () => {
      const [
        rawSuggestions,
        dueSoonCommitments,
        profile,
        recentMemories,
      ] = await Promise.all([
        (async () => {
          if (validWorkspaceId) {
            return window.electronAPI.listSuggestions(validWorkspaceId).catch(() => []);
          }
          const workspaces = await window.electronAPI
            .listWorkspaces()
            .catch(() => [] as Workspace[]);
          const workspaceIds = workspaces
            .filter((item) => !item.isTemp && !isTempWorkspaceId(item.id))
            .map((item) => item.id)
            .slice(0, 8);
          if (workspaceIds.length === 0) return [];
          const result = await window.electronAPI
            .listSuggestionsForWorkspaces(workspaceIds)
            .catch(() => []);
          return result.flatMap((entry) => entry.suggestions || []);
        })(),
        window.electronAPI.getDueSoonCommitments(96).catch(() => ({ items: [] })),
        window.electronAPI.getUserProfile().catch(() => null as UserProfile | null),
        validWorkspaceId
          ? window.electronAPI
              .getRecentMemories({ workspaceId: validWorkspaceId, limit: 3 })
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      const collected: WelcomeTaskSuggestion[] = [];
      const proactiveSuggestions = Array.isArray(rawSuggestions)
        ? (rawSuggestions as ProactiveSuggestion[])
        : [];
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

    void loadWelcomeTaskSuggestions().catch((error) => {
      console.error("Failed to load welcome task suggestions:", error);
      if (!cancelled) setWelcomeTaskSuggestions([]);
    });

    return () => {
      cancelled = true;
    };
  }, [task, workspace?.id, workspace?.isTemp]);

  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({ workspacePath: workspace?.path, onOpenViewer: setViewerFilePath, citations }),
    [workspace?.path, setViewerFilePath, citations],
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
  const [showModelDropdownFromLabel, setShowModelDropdownFromLabel] = useState(false);
  const modelLabelRef = useRef<HTMLDivElement>(null);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const [showDomainDropdown, setShowDomainDropdown] = useState(false);
  const domainDropdownRef = useRef<HTMLDivElement>(null);
  const [guardrailDefaultMaxAutoContinuations, setGuardrailDefaultMaxAutoContinuations] =
    useState<number | null>(null);
  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    if (!verboseSteps && sharedTaskEventUi) {
      return sharedTaskEventUi.filteredEvents;
    }
    return measureRendererPerf("MainContent.filteredEvents", rendererPerfLoggingEnabled, () => {
      const baseEvents = verboseSteps
        ? filterVerboseTimelineNoise(events)
        : events.filter((event) => shouldShowTaskEventInSummaryMode(event, task?.status));
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
  }, [events, sharedTaskEventUi, verboseSteps, task?.status, rendererPerfLoggingEnabled]);

  // Build projection from raw events so tool_call/tool_result data embedded
  // in timeline_step_updated (which is filtered for display) still populates
  // lane titles with URLs/results.
  const parallelGroupProjection = useMemo(
    () => {
      if (sharedTaskEventUi) return sharedTaskEventUi.parallelGroupProjection;
      return measureRendererPerf(
        "MainContent.parallelGroupProjection",
        rendererPerfLoggingEnabled,
        () => buildParallelGroupProjection(events),
      );
    },
    [events, sharedTaskEventUi, rendererPerfLoggingEnabled],
  );
  const parallelGroupsByAnchorEventId = parallelGroupProjection.groupsByAnchorEventId;
  const suppressedParallelEventIds = parallelGroupProjection.suppressedEventIds;

  // Pair individual tool_call / tool_result events (outside parallel groups) so that
  // the tool_result row is suppressed and the tool_call row reflects the completed state.
  const toolCallPairing = useMemo(() => {
    if (!verboseSteps && sharedTaskEventUi) {
      return sharedTaskEventUi.toolCallPairing;
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
  }, [filteredEvents, sharedTaskEventUi, suppressedParallelEventIds, verboseSteps]);

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
  const liveWorkStartedAt = task ? (latestUserMessageTimestamp ?? task.createdAt) : Date.now();
  const liveWorkCompletedAt = isTaskFinished
    ? (task?.completedAt ?? task?.updatedAt)
    : task?.completedAt;
  const liveWorkDuration = useTaskDuration(
    liveWorkStartedAt,
    liveWorkCompletedAt,
    Boolean(task && isTaskWorking),
  );
  const workDurationLabel = isTaskWorking
    ? `Working for ${liveWorkDuration}`
    : isTaskFinished
      ? `Worked for ${liveWorkDuration}`
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
    if (!verboseSteps && sharedTaskEventUi) {
      return sharedTaskEventUi.baseTimelineItems;
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
    sharedTaskEventUi,
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
    // CLI agent child tasks get their own per-agent CliAgentFrame; others use DispatchedAgentsPanel.
    // Show for both collaborative and non-collaborative runs so main area shows sub-agent steps.
    if (childTasks.length > 0) {
      const childEventsByTaskId = new Map<string, TaskEvent[]>();
      for (const event of childEvents) {
        const existing = childEventsByTaskId.get(event.taskId) || [];
        existing.push(event);
        childEventsByTaskId.set(event.taskId, existing);
      }
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
    if (!verboseSteps && sharedTaskEventUi) {
      return sharedTaskEventUi.latestVisibleTaskEvent;
    }
    for (let i = timelineItems.length - 1; i >= 0; i -= 1) {
      const item = timelineItems[i];
      if (item.kind === "event") return item.event;
      if (item.kind === "action_block" && item.events.length > 0) {
        return item.events[item.events.length - 1] ?? null;
      }
    }
    return filteredEvents[filteredEvents.length - 1] ?? null;
  }, [filteredEvents, sharedTaskEventUi, timelineItems, verboseSteps]);

  // Build all command output sessions so previous command windows remain visible.
  const commandOutputSessions = useMemo<CommandOutputSession[]>(() => {
    if (sharedTaskEventUi) {
      return sharedTaskEventUi.commandOutputSessions;
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
          currentSession.output += payloadOutput;
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

      const maxUiOutputChars = 50 * 1024;
      return sessions.map((session) => {
        if (session.output.length <= maxUiOutputChars) return session;
        return {
          ...session,
          output: "[... earlier output truncated ...]\n\n" + session.output.slice(-maxUiOutputChars),
        };
      });
    });
  }, [events, sharedTaskEventUi, rendererPerfLoggingEnabled]);

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

  // Load custom skills (task skills only, excludes guidelines)
  useEffect(() => {
    window.electronAPI
      .listTaskSkills()
      .then((skills) => setCustomSkills(skills.filter((s) => s.enabled !== false)))
      .catch((err) => console.error("Failed to load custom skills:", err));
  }, []);

  // Load active agent roles for @mention autocomplete
  useEffect(() => {
    window.electronAPI
      .getAgentRoles()
      .then((roles) => setAgentRoles(roles.filter((role) => role.isActive)))
      .catch((err) => console.error("Failed to load agent roles:", err));
  }, []);

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

  // Close model dropdown from label on click outside (focused mode)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelLabelRef.current && !modelLabelRef.current.contains(e.target as Node)) {
        setShowModelDropdownFromLabel(false);
      }
    };
    if (showModelDropdownFromLabel) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelDropdownFromLabel]);

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
        const slashPrompt = buildSlashSkillPrompt(modalState.skill.id, values);
        const title = buildTaskTitle(`Run /${modalState.skill.id}`);
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
    const slashPrompt = buildSlashSkillPrompt(modalState.skill.id, values);
    const title = buildTaskTitle(`Run /${modalState.skill.id}`);
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
      }
      return next;
    });
  }, []);

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

  const shouldRenderTimelineEventInStepFeed = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "user_message" || effectiveType === "assistant_message") {
      return false;
    }
    if (shouldHideApprovalEventInStepFeed(event)) {
      return false;
    }
    // Suppress tool_result events that are paired with their tool_call (shown inline)
    if (effectiveType === "tool_result" && toolCallPairing.claimedResultIds.has(event.id)) {
      return false;
    }
    if (!shouldShowTaskEventInStepFeed(event)) {
      return false;
    }
    return true;
  }, [
    toolCallPairing.claimedResultIds,
  ]);

  // Check if an event has details to show
  const hasEventDetails = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (isImageFileEvent(event)) return true;
    if (isHtmlFileEvent(event)) return true;
    if (isVideoFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return true;
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "follow_up_completed") return true;
    if (effectiveType === "task_completed") {
      return hasTaskOutputs(resolveTaskOutputSummaryFromCompletionEvent(event, events));
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
    )
      return true;
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
    return [
      "plan_created",
      "tool_call",
      "tool_result",
      "assistant_message",
      "error",
      "step_failed",
      "approval_requested",
    ].includes(effectiveType);
  }, [
    events,
    isHtmlFileEvent,
    isImageFileEvent,
    isSpreadsheetFileEvent,
    isVideoFileEvent,
    verboseSteps,
    workspace?.path,
  ]);

  // Determine if an event should be expanded by default
  // Important events (plan, assistant responses, errors) should be expanded
  // Verbose events (tool calls/results) should be collapsed
  const shouldDefaultExpand = useCallback((event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (isImageFileEvent(event)) return true;
    if (isHtmlFileEvent(event)) return true;
    if (isVideoFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return true;
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "follow_up_completed") return true;
    if (effectiveType === "task_completed") return hasEventDetails(event);
    if (shouldHideApprovalEventInStepFeed(event)) return false;
    if (
      effectiveType === "artifact_created" ||
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
    isSpreadsheetFileEvent,
    isVideoFileEvent,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const placeholderTextRef = useRef<HTMLSpanElement>(null);
  const cliInputWrapperRef = useRef<HTMLDivElement>(null);
  const [cursorLeft, setCursorLeft] = useState<number>(0);

  // Auto-resize textarea; prefer direct event-path resizing to avoid an extra
  // effect/layout cycle on every keypress in long sessions.
  const resizeRafRef = useRef<number>(0);
  const pendingProgrammaticResizeRef = useRef(false);
  const autoResizeTextarea = useCallback((textarea?: HTMLTextAreaElement | null, shrink = false) => {
    if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      const target = textarea ?? textareaRef.current;
      if (!target) return;
      if (shrink) {
        target.style.height = "auto";
      }
      const nextHeight = Math.min(target.scrollHeight, 200);
      const nextHeightPx = `${nextHeight}px`;
      if (target.style.height !== nextHeightPx) {
        target.style.height = nextHeightPx;
      }
    });
  }, []);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
    };
  }, []);

  const handleQuoteAssistantMessage = useCallback((quote: QuotedAssistantMessage) => {
    setQuotedAssistantMessage(quote);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      const cursorPosition = textarea.value.length;
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    }
  }, []);

  // Programmatic input updates still need a resize pass.
  useEffect(() => {
    if (!pendingProgrammaticResizeRef.current) return;
    pendingProgrammaticResizeRef.current = false;
    autoResizeTextarea(undefined, true);
  }, [inputValue, autoResizeTextarea]);

  // Active placeholder: rotating prompt when available, personality fallback otherwise
  const personalityPlaceholder = agentContext.getPlaceholder();
  const placeholder =
    rotatingPlaceholders.length > 0
      ? rotatingPlaceholders[rotatingIndex % rotatingPlaceholders.length]
      : personalityPlaceholder;

  // Keep the empty-state cursor attached to the rendered placeholder instead of
  // relying on theme-specific padding and prompt-width constants.
  useLayoutEffect(() => {
    if (inputValue) return;

    const updatePlaceholderCursor = () => {
      const placeholderEl = placeholderTextRef.current;
      const wrapperEl = cliInputWrapperRef.current;
      if (!placeholderEl || !wrapperEl) return;

      const placeholderRect = placeholderEl.getBoundingClientRect();
      const wrapperRect = wrapperEl.getBoundingClientRect();
      setCursorLeft(placeholderRect.left - wrapperRect.left + placeholderRect.width + 1);
    };

    updatePlaceholderCursor();
    window.addEventListener("resize", updatePlaceholderCursor);
    return () => window.removeEventListener("resize", updatePlaceholderCursor);
  }, [inputValue, placeholder]);

  // Check if user is near the bottom of the scroll container
  const isNearBottom = useCallback((element: HTMLElement, threshold = 100) => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Handle scroll events to detect manual scrolling
  const handleScroll = useCallback(() => {
    const container = mainBodyRef.current;
    if (!container) return;

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

    if (!trimmedInput && !hasAttachments) return;
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
      const composeResult = await composeMessageWithAttachments(
        workspace?.path,
        trimmedInput,
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

      // Chat mode reuses the current chat task when one exists, but creates a new
      // task for the first message or when the selected task is not a chat session.
      const shouldCreateFreshTask = shouldCreateFreshTaskForSend({
        executionMode,
        selectedTaskId,
        selectedTaskExecutionMode: task?.agentConfig?.executionMode,
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
        setPermissionAccessMode("default");
        setMultiLlmConfig(null);
        setVerificationAgentEnabled(false);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        onSendMessage(message, imagePayload, quotedAssistantMessage ?? undefined);
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

    return options;
  }, [mentionOpen, mentionQuery, agentRoles, normalizedRoleIndex]);

  useEffect(() => {
    if (mentionSelectedIndex >= mentionOptions.length) {
      setMentionSelectedIndex(0);
    }
  }, [mentionOptions, mentionSelectedIndex]);

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
    const query = slashQuery.toLowerCase();
    const builtinOptions: SlashCommandOption[] = onStartOnboarding
      ? ONBOARDING_COMMAND_OPTIONS.filter((option) => {
          if (!query) return true;
          return (
            option.name.toLowerCase().includes(query) ||
            option.description.toLowerCase().includes(query)
          );
        }).map((option) => ({
          kind: "builtin",
          id: option.id,
          name: option.name,
          description: option.description,
          icon: option.icon,
          command: `/${option.name}`,
        }))
      : [];

    const skillOptions: SlashCommandOption[] = customSkills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.id.toLowerCase().includes(query) ||
          (skill.description || "").toLowerCase().includes(query)
        );
      })
      .slice(0, 10)
      .map((skill) => ({
        kind: "skill",
        id: skill.id,
        name: skill.name,
        description: skill.description,
        icon: skill.icon,
        hasParams: !!(skill.parameters && skill.parameters.length > 0),
        skill,
      }));

    return [...builtinOptions, ...skillOptions].slice(0, 10);
  }, [slashOpen, slashQuery, customSkills, onStartOnboarding]);

  const effectiveSlashSelectedIndex =
    slashOptions.length > 0 ? Math.min(slashSelectedIndex, slashOptions.length - 1) : 0;

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

    if (option.hasParams) {
      // Show parameter modal
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      setSelectedSkillForParams({ skill: option.skill, launchMode: "slash" });
    } else {
      // No parameters — create task directly from slash invocation
      pendingProgrammaticResizeRef.current = true;
      setInputValue("");
      if (onCreateTask) {
        const slashPrompt = buildSlashSkillPrompt(option.skill.id);
        const title = buildTaskTitle(`Run /${option.skill.id}`);
        onCreateTask(title, slashPrompt);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursor = e.target.selectionStart;
    autoResizeTextarea(e.target, value.length < inputValue.length);
    setInputValue(value);
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

  const handleInputClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    updateMentionState(inputValue, e.currentTarget.selectionStart);
    updateSlashState(inputValue, e.currentTarget.selectionStart);
  };

  const handleInputKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      const cursor = (e.currentTarget as HTMLTextAreaElement).selectionStart;
      updateMentionState(inputValue, cursor);
      updateSlashState(inputValue, cursor);
    }
  };

  const handleMentionSelect = (option: MentionOption) => {
    if (!mentionTarget) return;
    const insertText = option.type === "everyone" ? "@everybody" : `@${option.label}`;
    const before = inputValue.slice(0, mentionTarget.start);
    const after = inputValue.slice(mentionTarget.end);
    const needsSpace = after.length === 0 ? true : !after.startsWith(" ");
    const nextValue = `${before}${insertText}${needsSpace ? " " : ""}${after}`;
    pendingProgrammaticResizeRef.current = true;
    setInputValue(nextValue);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionTarget(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const cursorPosition = before.length + insertText.length + (needsSpace ? 1 : 0);
        textarea.focus();
        textarea.setSelectionRange(cursorPosition, cursorPosition);
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
    return (
      <div className="mention-autocomplete-dropdown" ref={mentionDropdownRef}>
        {mentionOptions.map((option, index) => {
          const displayLabel = option.type === "everyone" ? "@everybody" : `@${option.label}`;
          return (
            <button
              key={`${option.type}-${option.id}`}
              className={`mention-autocomplete-item ${index === mentionSelectedIndex ? "selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleMentionSelect(option);
              }}
              onMouseEnter={() => setMentionSelectedIndex(index)}
            >
              <span
                className="mention-autocomplete-icon"
                style={{ backgroundColor: option.color || "#64748b" }}
              >
                <ThemeIcon emoji={option.icon || "👥"} icon={<UsersIcon size={16} />} />
              </span>
              <div className="mention-autocomplete-details">
                <span className="mention-autocomplete-name">{displayLabel}</span>
                {option.description && (
                  <span className="mention-autocomplete-desc">{option.description}</span>
                )}
              </div>
            </button>
          );
        })}
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
              <span className="mention-autocomplete-name">/{option.name}</span>
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
    setActiveWelcomeSuggestionDraft(null);
  };

  const handleWelcomeTaskSuggestion = (suggestion: WelcomeTaskSuggestion) => {
    handleQuickAction(suggestion.prompt);
    setActiveWelcomeSuggestionDraft(
      suggestion.feedback?.kind === "proactive"
        ? {
            workspaceId: suggestion.feedback.workspaceId,
            suggestionId: suggestion.feedback.suggestionId,
            originalPrompt: suggestion.prompt,
          }
        : null,
    );
    setWelcomeTaskSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
    window.setTimeout(() => {
      textareaRef.current?.focus();
      const position = suggestion.prompt.length;
      textareaRef.current?.setSelectionRange(position, position);
    }, 0);
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
    if (welcomeTaskSuggestions.length === 0) return null;
    return (
      <section className="welcome-next-actions" aria-label="Next actions">
        <div className="welcome-next-actions-header">
          <span className="welcome-next-actions-title">Next actions</span>
        </div>
        <div className="welcome-next-actions-list">
        {welcomeTaskSuggestions.map((suggestion) => {
          const Icon =
            suggestion.source === "memory"
              ? ListTodo
              : suggestion.source === "insight"
                ? Sparkles
                : MessageCircle;
          const title = [suggestion.title, suggestion.whyNow, suggestion.description]
            .concat(suggestion.evidence?.slice(0, 3) || [])
            .filter(Boolean)
            .join("\n");
          const metaChips = [
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
    if (task?.status === "paused" && textareaRef.current) {
      const inputEl = textareaRef.current;
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

  const initialPromptEventId = useMemo(() => {
    if (!trimmedPrompt) return null;
    for (const event of events) {
      if (getEffectiveTaskEventType(event) !== "user_message") continue;
      const rawMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
      const cleanedEventMessage = stripStrategyContextBlock(stripPptxBubbleContent(rawMessage));
      if (cleanedEventMessage === trimmedPrompt || cleanedEventMessage.startsWith(trimmedPrompt)) {
        return event.id;
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
    return (
      <div className="chat-message user-message">
        <CollapsibleUserBubble>
          <ReactMarkdown remarkPlugins={userMarkdownPlugins} components={markdownComponents}>
            {cleanedDisplayPrompt}
          </ReactMarkdown>
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
  }, [cleanedDisplayPrompt, markdownComponents, promptAttachmentNames, trimmedPrompt]);
  const hasActiveStructuredInputRequest = Boolean(
    task &&
      inputRequest &&
      inputRequest.taskId === task.id &&
      onSubmitInputRequest &&
      onDismissInputRequest,
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
              <div className="cli-input-wrapper" ref={cliInputWrapperRef}>
                <span className="cli-input-prompt">~$</span>
                <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
                  {!inputValue && (
                    <span
                      ref={placeholderTextRef}
                      className={`cli-rotating-placeholder${placeholderFading ? " fading" : ""}`}
                      aria-hidden="true"
                    >
                      {placeholder}
                    </span>
                  )}
                  <textarea
                    ref={textareaRef}
                    className={`welcome-input cli-input input-textarea${
                      !inputValue ? " input-textarea-empty-placeholder" : ""
                    }`}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onClick={handleInputClick}
                    onKeyUp={handleInputKeyUp}
                    rows={1}
                  />
                  {renderMentionDropdown()}
                  {renderSlashDropdown()}
                </div>
                {!inputValue && <span className="cli-cursor" style={{ left: cursorLeft }} />}
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
                      {(executionMode !== "execute" || collaborativeModeEnabled) && (
                        <button
                          className="active-mode-badge"
                          title="Click to reset mode"
                          onClick={() => {
                            setExecutionMode("execute");
                            setCollaborativeModeEnabled(false);
                          }}
                        >
                          {collaborativeModeEnabled ? "Collab" : EXECUTION_MODE_LABEL[executionMode]}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                      <div className="model-label-container" ref={modelLabelRef}>
                        <button
                          className="model-label-subtle"
                          onClick={() => setShowModelDropdownFromLabel(!showModelDropdownFromLabel)}
                          title="Change model"
                        >
                          {availableModels.find((m) => m.key === selectedModel)?.displayName ||
                            selectedModel}
                        </button>
                        {showModelDropdownFromLabel && (
                          <div className="model-label-dropdown">
                            {availableModels.map((m) => (
                              <button
                                key={m.key}
                                className={`model-label-dropdown-item ${m.key === selectedModel ? "active" : ""}`}
                                onClick={() => {
                                  onModelChange({
                                    providerType: selectedProvider,
                                    modelKey: m.key,
                                  });
                                  setShowModelDropdownFromLabel(false);
                                }}
                              >
                                {m.displayName}
                              </button>
                            ))}
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
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                        ) : (
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
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
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
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                        ) : (
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
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
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
                      title={workspace?.path || "Select a workspace folder"}
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
                        {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                          ? "Work in a folder"
                          : workspace?.path
                            ? (() => {
                                const parts = workspace.path.split(/[/\\]/).filter(Boolean);
                                return parts.length > 2
                                  ? `~/.../${parts.slice(-2).join("/")}`
                                  : workspace.path;
                              })()
                            : "No folder selected"}
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
      eventTitleMarkdownComponents={eventTitleMarkdownComponents}
      events={events}
      expandedActionBlocks={expandedActionBlocks}
      handleCanvasClose={handleCanvasClose}
      handleMessageFeedback={handleMessageFeedback}
      handleStepFeedback={handleStepFeedback}
      isChatTask={isChatTask}
      isTaskWorking={isTaskWorking}
      isReplayMode={replayControls?.isReplayMode ?? false}
      markdownComponents={markdownComponents}
      mainBodyRef={mainBodyRef}
      messageFeedbackMap={messageFeedbackMap}
      onOpenBrowserView={onOpenBrowserView}
      onQuoteAssistantMessage={handleQuoteAssistantMessage}
      onSelectChildTask={onSelectChildTask}
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
      wrappingUp={wrappingUp}
      workspace={workspace}
    />
  );


  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        {task?.parentTaskId && onSelectTask && (
          <button
            type="button"
            className="main-header-parent-thread-btn"
            onClick={() => onSelectTask(task.parentTaskId!)}
            title="Back to parent thread"
            aria-label="Back to parent thread"
          >
            <MessageCircle size={14} strokeWidth={1.5} />
            <span>Parent thread</span>
          </button>
        )}
        {showHeaderTitle && (
          <div className="main-header-title" title={headerTooltip}>
            {headerTitle}
          </div>
        )}
      </div>
      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* Always anchor the initial user prompt above the timeline. */}
          {initialPromptBubble}

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
                <span
                  className={`timeline-controls-label ${
                    isTaskWorking || isTaskFinished ? "with-duration" : ""
                  }`}
                >
                  {workDurationLabel}
                </span>
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
          className={`input-container ${isDraggingFiles ? "drag-over" : ""} ${collaborativeRun && onSelectChildTask ? "input-container-with-agents" : ""}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Collaborative agent lines — extension of input box, inside same container */}
          {collaborativeRun && onSelectChildTask && (
            <CollaborativeAgentLines
              collaborativeRun={collaborativeRun}
              childTasks={childTasks}
              childEvents={childEvents}
              onOpenAgent={(taskId) => onSelectChildTask(taskId)}
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
              onStopTask={onStopTask}
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
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
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
              <textarea
                ref={textareaRef}
                className="input-field input-textarea"
                placeholder={agentContext.getMessage("placeholderActive")}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onClick={handleInputClick}
                onKeyUp={handleInputKeyUp}
                rows={1}
              />
              {renderMentionDropdown()}
              {renderSlashDropdown()}
            </div>
            <div className="input-actions">
              {uiDensity === "focused" && (
                <div className="model-label-container" ref={modelLabelRef}>
                  <button
                    className="model-label-subtle"
                    onClick={() => setShowModelDropdownFromLabel(!showModelDropdownFromLabel)}
                    title="Change model"
                  >
                    {availableModels.find((m) => m.key === selectedModel)?.displayName ||
                      selectedModel}
                  </button>
                  {showModelDropdownFromLabel && (
                    <div className="model-label-dropdown">
                      {availableModels.map((m) => (
                        <button
                          key={m.key}
                          className={`model-label-dropdown-item ${m.key === selectedModel ? "active" : ""}`}
                          onClick={() => {
                            onModelChange({
                              providerType: selectedProvider,
                              modelKey: m.key,
                            });
                            setShowModelDropdownFromLabel(false);
                          }}
                        >
                          {m.displayName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
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
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                    </svg>
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
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
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
              title={workspace?.path || "Select a workspace folder"}
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
                {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                  ? "Work in a folder"
                  : workspace?.path
                    ? (() => {
                        const parts = workspace.path.split(/[/\\]/).filter(Boolean);
                        return parts.length > 2
                          ? `~/.../${parts.slice(-2).join("/")}`
                          : workspace.path;
                      })()
                    : "No folder selected"}
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
    task.status,
    task.terminalStatus ?? "",
    task.updatedAt,
    task.completedAt ?? "",
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
    prev.selectedModel === next.selectedModel &&
    prev.selectedProvider === next.selectedProvider &&
    prev.selectedReasoningEffort === next.selectedReasoningEffort &&
    prev.availableModels === next.availableModels &&
    prev.availableProviders === next.availableProviders &&
    prev.uiDensity === next.uiDensity &&
    prev.rendererPerfLoggingEnabled === next.rendererPerfLoggingEnabled &&
    getRemoteSessionSignature(prev.remoteSession) === getRemoteSessionSignature(next.remoteSession) &&
    prev.replayControls === next.replayControls
  );
}

export const MainContent = memo(MainContentComponent, areMainContentPropsEqual);

function formatSignedScore(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const normalized = Math.max(-1, Math.min(1, value));
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(2)}`;
}

function describeLoopRisk(loopRisk: number): "low" | "medium" | "high" {
  if (!Number.isFinite(loopRisk)) return "low";
  if (loopRisk >= 0.7) return "high";
  if (loopRisk >= 0.4) return "medium";
  return "low";
}

/**
 * Truncate long text for display, with expand option handled via CSS
 */
function truncateForDisplay(text: string, maxLength: number = 2000): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n... [content truncated for display]";
}

/**
 * Condense a verbose step description (often a direct echo of the user's prompt)
 * into a short, action-oriented fragment suitable for a timeline row header.
 */
function condenseStepText(raw: string, maxLength: number = 72): string {
  if (!raw) return raw;
  let text = raw.trim();
  // Strip leading/trailing surrounding quotes that signal a prompt echo.
  text = text.replace(/^["“”'`]+/, "").replace(/["“”'`]+$/, "");
  // If the text looks like a quoted phrase + meta commentary ("X" means Y…), keep only the quoted phrase.
  const quotedLead = text.match(/^["“”'`]([^"“”'`]{3,})["“”'`]/);
  if (quotedLead?.[1]) {
    text = quotedLead[1].trim();
  }
  // Cut at the first sentence boundary or separator.
  const sentenceCut = text.split(/(?<=[.!?])\s+|\s+[—–-]\s+/)[0] || text;
  text = sentenceCut.trim();
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return text;
}

function formatStepContractEscalatedMessage(reason: string): string {
  const r = reason.trim().toLowerCase();
  switch (r) {
    case "end_turn_before_required_mutation":
      return "Still working on this step — waiting for the first file write";
    case "loop_warning_threshold_reached":
      return "Trying a different approach";
    case "mutation_starvation_guard":
      return "Waiting for file activity to begin";
    case "first_write_checkpoint_no_attempt":
      return "Nudging agent to begin writing";
    case "first_write_checkpoint_failed":
      return "Retrying the file write";
    default:
      return "Adjusting approach";
  }
}

/** Maps technical timeline/log messages to user-friendly text for verbose mode */
function humanizeTimelineMessage(message: string): string {
  if (!message || typeof message !== "string") return message;
  const m = message.trim();

  if (m === "Analyzing task requirements...") return "Understanding the request";
  if (/^\[planning\]/i.test(m)) return "Choosing the best planning approach";
  if (/^\[skill-routing\]/i.test(m)) return "Selecting relevant skills";
  if (/^Creating execution plan \(model:[^)]+\)\.\.\.$/i.test(m)) return "Creating execution plan";
  if (/^Starting execution of \d+ steps$/i.test(m)) return "Starting the work";
  const executingStepMatch = /^Executing step \d+\/\d+:\s*(.+)$/i.exec(m);
  if (executingStepMatch?.[1]) {
    return formatTimelineActivityLabel(executingStepMatch[1]);
  }
  const completedStepMatch = /^Completed step [^:]+:\s*(.+)$/i.exec(m);
  if (completedStepMatch?.[1]) {
    return `Finished: ${condenseStepText(completedStepMatch[1])}`;
  }
  if (m === "All steps completed") return "Completed all planned steps";
  if (m === "timeline_step_finished") return "Step finished";

  // Raw JSON progress payloads (web search / fetch metadata)
  if (m.startsWith("{") && m.endsWith("}")) {
    try {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      if (typeof parsed.query === "string" && parsed.query.trim()) {
        const q = parsed.query.trim();
        const prov = typeof parsed.provider === "string" ? ` (${parsed.provider})` : "";
        return `Web search: ${q.length > 90 ? `${q.slice(0, 89)}…` : q}${prov}`;
      }
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        const head = title || parsed.url;
        return `Fetched page: ${head.length > 90 ? `${head.slice(0, 89)}…` : head}`;
      }
    } catch {
      /* keep message */
    }
  }

  // Prompt budget / context optimization
  if (/prompt budget applied$/i.test(m)) return "Optimized context to fit limits";

  // Auto-waive completion gate messages
  if (m.includes("Auto-waived verification-only failed steps") && m.includes("partial_success")) {
    return "Completed with some verification steps skipped (results were good enough)";
  }
  if (m.includes("Auto-waived budget-constrained failed steps") && m.includes("partial_success")) {
    return "Completed with some steps skipped (reached context limit)";
  }
  if (
    m.includes("Auto-waived failed steps because the task already produced substantive outputs") &&
    m.includes("partial_success")
  ) {
    return "Completed with some steps skipped (task already had useful results)";
  }

  // Raw event type names that may appear as messages
  if (m === "timeline_step_updated" || m === "progress_update") return "Progress update";
  if (m === "executing") return "Working";

  // Execution outcome messages
  if (m === "Execution completed with partial results.") return "Completed with partial results";
  if (m.startsWith("Execution failed:") && m.includes("step(s) failed")) {
    const n = m.match(/(\d+)\s+step\(s\)\s+failed/)?.[1];
    return n ? `Failed: ${n} step(s) didn't complete` : "Execution failed";
  }
  if (m.includes("Completed with warnings:") && m.includes("optional step(s) failed")) {
    return "Completed with some steps skipped (main work done)";
  }
  if (m.includes("Completed with warnings:") && m.includes("final deliverable was produced")) {
    return "Completed with some steps skipped (output was produced)";
  }
  if (m.includes("Completed with warnings:") && m.includes("majority of work succeeded")) {
    return "Completed with some steps skipped (most work done)";
  }
  if (m.includes("mutation-required steps failed unrecovered")) {
    return "Failed: required file changes didn't complete";
  }
  if (m.includes("high-risk verification gate did not pass")) {
    return "Failed: verification did not pass";
  }

  // Completion guard / contract messages
  if (m.includes("Completion guard blocked finalization") && m.includes("artifact contract")) {
    return "Paused: output didn't match requirements";
  }
  if (m.includes("Completion blocked:") && m.includes("unresolved")) {
    return m.replace(/^Completion blocked:\s*unresolved\s+/, "Blocked: ");
  }

  // Other technical patterns
  if (m.startsWith("execution_run_summary")) return "Execution summary";
  if (/^\[verified-mode\]/i.test(m)) return m.replace(/^\[verified-mode\]\s*/i, "").trim() || "Verification";
  if (m.includes("Suppressed raw tool-call markup")) return "Cleaned up model output";
  if (m.includes("Security:") && m.includes("Suspicious output")) return "Security check applied";
  if (m.includes("Security:") && m.includes("Potential injection")) return "Security check applied";
  if (m.includes("Pre-compaction memory flush saved")) return "Freed up context space";
  if (m.includes("LLM route selected:")) return "Selected model";
  if (m.includes("Creating execution plan")) return m; // Already friendly
  if (m.includes("Step timeout detected")) return "Step took too long; finishing with best effort";
  if (m.includes("Wrap-up requested")) return "Finishing up";
  if (m.includes("Answer-first short-circuit")) return "Answered directly (simple prompt)";
  if (m.includes("Answer-first non-execute short-circuit")) return "Answered directly (no execution needed)";
  if (m.includes("Pre-flight framing failed")) return "Continuing with execution";
  if (m.includes("Answer-first pre-response failed")) return "Continuing with full execution";
  if (m.includes("Applied /batch external=none policy")) return "Running in batch mode (no external tools)";
  if (m.includes("User granted explicit external side-effect approval")) return "Approved to use external tools";
  if (m.includes("External side-effect approval request failed")) return "Could not get approval for external tools";
  if (m.includes("Normalized /") && m.includes("to deterministic skill")) return "Running skill";
  if (m.includes("Detected inline /") && m.includes("chain")) return "Running skill chain";
  if (m.includes("Step soft deadline reached")) return "Step time limit approached";
  if (m.includes("Key factual claims are missing evidence links")) {
    return "Some claims need evidence links";
  }

  return message;
}

function getSummaryStageLabel(stage: string): string | null {
  switch (stage.trim().toUpperCase()) {
    case "DISCOVER":
      return "Planning the approach";
    case "BUILD":
      return "Working on your request";
    case "VERIFY":
      return "Checking results";
    case "FIX":
      return "Applying fixes";
    case "DELIVER":
      return "Preparing final response";
    default:
      return null;
  }
}

function getApprovalPayload(event: TaskEvent): Any | null {
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const approval = (event.payload as Any).approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return null;
  }
  return approval as Any;
}

function getApprovalDescription(approval: Any | null): string {
  const description = approval?.description;
  return typeof description === "string" ? description.trim() : "";
}

function extractApprovalCommand(approval: Any | null): string | null {
  const commandFromDetails = approval?.details?.command;
  if (typeof commandFromDetails === "string") {
    const trimmed = commandFromDetails.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const description = getApprovalDescription(approval);
  if (!description) return null;

  const commandMatch = description.match(/^Run(?:ning)? command(?:\s*\([^)]+\))?:\s*([\s\S]+)$/i);
  if (!commandMatch || typeof commandMatch[1] !== "string") return null;
  const command = commandMatch[1].trim();
  return command.length > 0 ? command : null;
}

function isRunCommandApproval(approval: Any | null): boolean {
  if (approval?.type === "run_command") return true;
  return Boolean(extractApprovalCommand(approval));
}

function shouldHideApprovalEventInStepFeed(event: TaskEvent): boolean {
  if (getEffectiveTaskEventType(event) !== "approval_requested") return false;
  if (event.payload?.autoApproved === true) return true;
  return isRunCommandApproval(getApprovalPayload(event));
}

function getTimelineEventStepId(event: TaskEvent): string | null {
  if (typeof event.stepId === "string" && event.stepId.trim().length > 0) {
    return event.stepId.trim();
  }
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  if (typeof payload.stepId === "string" && payload.stepId.trim().length > 0) {
    return payload.stepId.trim();
  }
  const step =
    payload.step && typeof payload.step === "object"
      ? (payload.step as Record<string, unknown>)
      : {};
  if (typeof step.id === "string" && step.id.trim().length > 0) {
    return step.id.trim();
  }
  return null;
}

function getParallelGroupOwnerStepId(groupId: string | null | undefined): string | null {
  if (typeof groupId !== "string") return null;
  const parts = groupId.split(":");
  if (parts.length < 5 || parts[0] !== "tools") return null;
  if (parts[1] !== "step" && parts[1] !== "follow_up") return null;
  const stepId = parts.slice(2, -2).join(":").trim();
  return stepId.length > 0 ? stepId : null;
}

function canStepEventOwnParallelChildren(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  return (
    effectiveType === "step_started" ||
    (event.type === "timeline_step_updated" && effectiveType === "progress_update")
  );
}

function renderEventTitle(
  event: TaskEvent,
  workspacePath?: string,
  onOpenViewer?: (path: string) => void,
  agentCtx?: AgentContext,
  options?: {
    summaryMode?: boolean;
  },
): React.ReactNode {
  const summaryMode = options?.summaryMode === true;
  // Build message context for personalized messages
  const msgCtx = agentCtx
    ? {
        agentName: agentCtx.agentName,
        userName: agentCtx.userName,
        personality: agentCtx.personality,
        persona: agentCtx.persona,
        emojiUsage: agentCtx.emojiUsage,
        quirks: agentCtx.quirks,
      }
    : {
        agentName: "CoWork",
        userName: undefined,
        personality: "professional" as const,
        persona: undefined,
        emojiUsage: "minimal" as const,
        quirks: DEFAULT_QUIRKS,
      };
  const effectiveType = getEffectiveTaskEventType(event);

  const getStepStartedDetail = (): string => {
    const rawStepDescription =
      typeof event.payload?.step?.description === "string" ? event.payload.step.description : "";
    if (rawStepDescription.trim().length > 0) {
      return rawStepDescription;
    }

    const rawGroupLabel =
      typeof event.payload?.groupLabel === "string" ? event.payload.groupLabel : "";
    if (rawGroupLabel.trim().length > 0) {
      return rawGroupLabel;
    }

    const rawMessage = typeof event.payload?.message === "string" ? event.payload.message : "";
    const normalizedMessage = rawMessage.replace(/^Starting\s+/i, "").trim();
    if (normalizedMessage.length > 0) {
      return normalizedMessage;
    }

    const rawStage = typeof event.payload?.stage === "string" ? event.payload.stage : "";
    if (rawStage.trim().length > 0) {
      return rawStage.trim();
    }

    return "Getting started...";
  };

  if (event.type === "timeline_group_started" || event.type === "timeline_group_finished") {
    const stage =
      typeof event.payload?.stage === "string" ? event.payload.stage.trim().toUpperCase() : "";
    const groupLabel =
      (typeof event.payload?.groupLabel === "string" && event.payload.groupLabel.trim()) || "";
    const label = groupLabel || stage || "Group";
    const summaryStageLabel = stage ? getSummaryStageLabel(stage) : null;
    const isSubStage = Boolean(groupLabel && groupLabel.toUpperCase() !== stage);
    if (summaryMode) {
      // Prefer sub-stage label (e.g. "Preparing workspace") over generic stage label (e.g. "Applying fixes")
      if (isSubStage) return groupLabel;
      if (summaryStageLabel) return summaryStageLabel;
    }

    if (isSubStage) {
      return event.type === "timeline_group_finished" ? `${groupLabel} complete` : groupLabel;
    }
    if (summaryStageLabel) {
      return event.type === "timeline_group_finished" ? `${summaryStageLabel} complete` : summaryStageLabel;
    }

    const maxParallel =
      typeof event.payload?.maxParallel === "number" && Number.isFinite(event.payload.maxParallel)
        ? Math.max(1, Math.floor(event.payload.maxParallel))
        : null;
    const base = event.type === "timeline_group_started" ? `Starting ${label}` : `Completed ${label}`;
    return !summaryMode && maxParallel && event.type === "timeline_group_started"
      ? `${base} (${maxParallel} parallel)`
      : base;
  }

  if (event.type === "timeline_evidence_attached") {
    const refs = Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [];
    const count = refs.length;
    return count > 0 ? `Attached ${count} evidence link${count === 1 ? "" : "s"}` : "Attached evidence";
  }

  if (event.type === "timeline_artifact_emitted") {
    const path = typeof event.payload?.path === "string" ? event.payload.path : "";
    const label =
      typeof event.payload?.label === "string" && event.payload.label.trim().length > 0
        ? event.payload.label
        : path;
    return path ? (
      <span>
        Output ready:{" "}
        <ClickableFilePath path={path} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
        {label && label !== path && <span className="event-title-meta"> ({label})</span>}
      </span>
    ) : "Output ready";
  }

  if (event.type === "timeline_error") {
    const message = getTimelineErrorText(event);
    return message || getMessage("error", msgCtx);
  }

  if (event.type === "timeline_step_updated" && effectiveType === "progress_update") {
    const rawMsg =
      typeof event.payload?.message === "string" ? event.payload.message : "Progress update";
    if (rawMsg === "Thinking...") {
      return (
        <span className="thinking-title">
          Thinking
          <span className="thinking-ellipsis">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </span>
      );
    }
    return humanizeTimelineMessage(rawMsg);
  }

  switch (effectiveType) {
    case "task_created":
      return getMessage("taskStart", msgCtx);
    case "task_completed":
      return event.payload?.terminalStatus === "needs_user_action"
        ? "Completed - action required"
        : event.payload?.terminalStatus === "partial_success"
          ? "Completed - partial success"
          : getMessage("taskComplete", msgCtx);
    case "follow_up_completed": {
      const followUpMessage =
        typeof event.payload?.followUpMessage === "string"
          ? event.payload.followUpMessage.trim()
          : "";
      return followUpMessage ? `Follow-up: ${followUpMessage}` : "Follow-up received";
    }
    case "plan_created":
      return getMessage("planCreated", msgCtx);
    case "step_started":
      return (
        formatTimelineActivityLabel(
          sanitizeToolCallTextFromAssistant(getStepStartedDetail()).text || "Getting started...",
        ) || "Getting started"
      );
    case "step_completed":
      return getMessage(
        "stepCompleted",
        msgCtx,
        sanitizeToolCallTextFromAssistant(event.payload.step?.description || event.payload.message || "").text,
      );
    case "step_failed":
      return `Step failed: ${condenseStepText(event.payload.step?.description || "Unknown step")}`;
    case "continuation_decision":
      return "Deciding next steps";
    case "auto_continuation_started":
      return "Continuing";
    case "auto_continuation_blocked":
      return "Paused before continuing";
    case "context_compaction_started":
      return "Making room to continue";
    case "context_compaction_completed":
      return "Ready to continue";
    case "context_compaction_failed":
      return "Continuing with available context";
    case "step_contract_escalated":
      return typeof event.payload?.reason === "string"
        ? formatStepContractEscalatedMessage(event.payload.reason)
        : "Adjusting approach";
    case "no_progress_circuit_breaker":
      return "Paused to avoid getting stuck";
    case "tool_call": {
      const tcTool = event.payload.tool;
      const tcInput = event.payload.input;
      return friendlyToolCallTitle(
        typeof tcTool === "string" ? tcTool : undefined,
        tcInput && typeof tcInput === "object" ? (tcInput as Record<string, unknown>) : undefined,
      );
    }
    case "tool_result": {
      const result = event.payload.result;
      const success = result?.success !== false && !result?.error;

      // schedule_task is user-facing; surface a compact summary in the title.
      if (event.payload.tool === "schedule_task") {
        const status = success ? "done" : "issue";
        const describeEvery = (ms: number): string => {
          if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
          const day = 24 * 60 * 60 * 1000;
          const hour = 60 * 60 * 1000;
          const minute = 60 * 1000;
          const second = 1000;

          if (ms >= day && ms % day === 0) {
            const days = ms / day;
            return `Every ${days} day${days === 1 ? "" : "s"}`;
          }
          if (ms >= hour && ms % hour === 0) {
            const hours = ms / hour;
            return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
          }
          if (ms >= minute && ms % minute === 0) {
            const minutes = ms / minute;
            return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
          }
          if (ms >= second && ms % second === 0) {
            const seconds = ms / second;
            return `Every ${seconds} second${seconds === 1 ? "" : "s"}`;
          }
          return `Every ${Math.round(ms / 1000)}s`;
        };

        const describeScheduleShort = (schedule: Any): string | null => {
          if (!schedule || typeof schedule !== "object") return null;
          if (schedule.kind === "every" && typeof schedule.everyMs === "number") {
            return describeEvery(schedule.everyMs);
          }
          if (schedule.kind === "cron" && typeof schedule.expr === "string") {
            return `Cron: ${schedule.expr}`;
          }
          if (schedule.kind === "at" && typeof schedule.atMs === "number") {
            return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
          }
          return null;
        };

        // Error-first title for schedule failures.
        if (!success && result?.error) {
          const errorMsg = typeof result.error === "string" ? result.error : "Unknown error";
          const clipped = errorMsg.slice(0, 80) + (errorMsg.length > 80 ? "..." : "");
          return `schedule_task issue: ${clipped}`;
        }

        // "create"/"update" responses include { success, job }.
        const job = result?.job;
        if (job && typeof job === "object") {
          const jobName = String((job as Any).name || "").trim() || "Scheduled task";
          const scheduleDesc = describeScheduleShort((job as Any).schedule);
          const nextRunAtMs = (job as Any).state?.nextRunAtMs;
          const next =
            typeof nextRunAtMs === "number" ? new Date(nextRunAtMs).toLocaleString() : null;
          const parts = [scheduleDesc, next ? `Next: ${next}` : null].filter(Boolean) as string[];
          return parts.length > 0 ? `${jobName} → ${parts.join(" • ")}` : jobName;
        }

        // "list" returns an array of jobs.
        if (Array.isArray(result)) {
          const n = result.length;
          return `schedule_task ${status} → ${n} task${n === 1 ? "" : "s"}`;
        }
      }

      return friendlyToolResultTitle(
        typeof event.payload.tool === "string" ? event.payload.tool : undefined,
        result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
        success,
      );
    }
    case "assistant_message":
      return msgCtx.agentName;
    case "file_created": {
      const fcp = event.payload;
      let fcSuffix = "";
      if (fcp.type === "directory") {
        fcSuffix = " (directory)";
      } else if (fcp.type === "screenshot") {
        fcSuffix = " (screenshot)";
      } else if (fcp.copiedFrom) {
        fcSuffix = " (copy)";
      } else if (fcp.lineCount && fcp.size) {
        fcSuffix = ` (${fcp.lineCount} lines, ${formatFileSize(fcp.size)})`;
      } else if (fcp.size) {
        fcSuffix = ` (${formatFileSize(fcp.size)})`;
      }
      return (
        <span>
          Created:{" "}
          <ClickableFilePath
            path={fcp.path}
            workspacePath={workspacePath}
            onOpenViewer={onOpenViewer}
          />
          {fcSuffix && <span className="event-title-meta">{fcSuffix}</span>}
        </span>
      );
    }
    case "file_modified": {
      const fmp = event.payload;
      const fmPath = fmp.path || fmp.from;
      let fmSuffix = "";
      if (fmp.action === "rename" && fmp.to) {
        const toName = fmp.to.split("/").pop();
        fmSuffix = ` → ${toName}`;
      } else if (fmp.type === "edit" && fmp.replacements) {
        const netStr =
          fmp.netLines != null
            ? fmp.netLines > 0
              ? `, +${fmp.netLines} lines`
              : fmp.netLines < 0
                ? `, ${fmp.netLines} lines`
                : ""
            : "";
        fmSuffix = ` (${fmp.replacements} edit${fmp.replacements > 1 ? "s" : ""}${netStr})`;
      }
      return (
        <span>
          Updated:{" "}
          <ClickableFilePath
            path={fmPath}
            workspacePath={workspacePath}
            onOpenViewer={onOpenViewer}
          />
          {fmSuffix && <span className="event-title-meta">{fmSuffix}</span>}
        </span>
      );
    }
    case "file_deleted":
      return `Removed: ${event.payload.path}`;
    case "artifact_created": {
      const acp = event.payload || {};
      const acPath = typeof acp.path === "string" ? acp.path : "";
      const acType = typeof acp.type === "string" ? acp.type : "artifact";
      return acPath ? (
        <span>
          Output ready:{" "}
          <ClickableFilePath path={acPath} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          <span className="event-title-meta"> ({acType})</span>
        </span>
      ) : `Output ready (${acType})`;
    }
    case "diagram_created": {
      const title = typeof event.payload?.title === "string" ? event.payload.title : "Diagram";
      return (
        <span>
          Diagram:{" "}
          <span className="event-title-meta">{title}</span>
        </span>
      );
    }
    case "error":
      return getMessage("error", msgCtx);
    case "approval_requested": {
      const approval = getApprovalPayload(event);
      if (isRunCommandApproval(approval)) {
        return "Running command:";
      }
      const description = getApprovalDescription(approval);
      return description ? `${getMessage("approval", msgCtx)} ${description}` : getMessage("approval", msgCtx);
    }
    case "input_request_created":
      return "Structured input requested";
    case "input_request_resolved":
      return "Structured input submitted";
    case "input_request_dismissed":
      return "Structured input dismissed";
    case "log": {
      const logMsg = event.payload?.message;
      return typeof logMsg === "string" ? humanizeTimelineMessage(logMsg) : "Log";
    }
    case "verification_started":
      return getMessage("verifying", msgCtx);
    case "verification_passed":
      return `${getMessage("verifyPassed", msgCtx)} (attempt ${event.payload.attempt})`;
    case "verification_failed": {
      const attempt = event.payload?.attempt;
      const maxAttempts = event.payload?.maxAttempts;
      if (typeof attempt === "number" && typeof maxAttempts === "number") {
        return `${getMessage("verifyFailed", msgCtx)} (attempt ${attempt}/${maxAttempts})`;
      }
      return getMessage("verifyFailed", msgCtx);
    }
    case "verification_pending_user_action":
      return "Verification requires user action";
    case "retry_started":
      return getMessage("retrying", msgCtx, String(event.payload.attempt));
    default: {
      const friendly = humanizeTimelineMessage(event.type);
      return friendly !== event.type ? friendly : event.type;
    }
  }
}

function renderEventDetails(
  event: TaskEvent,
  voiceEnabled: boolean,
  markdownComponents: Any,
  options?: {
    workspacePath?: string;
    onOpenViewer?: (path: string) => void;
    onQuoteAssistantMessage?: (quote: QuotedAssistantMessage) => void;
    events?: TaskEvent[];
    onViewOutputs?: (taskId: string, primaryOutputPath?: string) => void;
    hideVerificationSteps?: boolean;
    summaryMode?: boolean;
    task?: Task | null;
    childTasks?: Task[];
    commandOutputSessions?: CommandOutputSession[];
    renderCommandOutput?: (sessions: CommandOutputSession[]) => React.ReactNode;
  },
) {
  const workspacePath = options?.workspacePath;
  const onOpenViewer = options?.onOpenViewer;
  const onQuoteAssistantMessage = options?.onQuoteAssistantMessage;
  const eventStream = options?.events || [];
  const onViewOutputs = options?.onViewOutputs;
  const summaryMode = options?.summaryMode === true;
  const taskForEvent =
    options?.task?.id === event.taskId
      ? options.task
      : options?.childTasks?.find((t) => t.id === event.taskId) ?? options?.task;
  const effectiveType = getEffectiveTaskEventType(event);
  const stepCompletionPreviewPath = getStepCompletionPreviewPath(event);

  if (event.type === "timeline_group_started" || event.type === "timeline_group_finished") {
    if (summaryMode) return null;
    const stage =
      typeof event.payload?.stage === "string" && event.payload.stage.trim().length > 0
        ? event.payload.stage.trim()
        : "";
    const groupLabel =
      (typeof event.payload?.groupLabel === "string" && event.payload.groupLabel.trim()) || "";
    const maxParallel =
      typeof event.payload?.maxParallel === "number" && Number.isFinite(event.payload.maxParallel)
        ? Math.max(1, Math.floor(event.payload.maxParallel))
        : undefined;
    const phaseLabel = stage ? getSummaryStageLabel(stage) || stage : null;
    const isSubStage = groupLabel && groupLabel.toUpperCase() !== stage;
    return (
      <div className="event-details">
        {phaseLabel ? <div>Phase: {phaseLabel}</div> : null}
        {isSubStage ? <div>Step: {groupLabel}</div> : null}
        {typeof maxParallel === "number" && maxParallel > 1 ? (
          <div>{maxParallel} tasks in parallel</div>
        ) : null}
      </div>
    );
  }

  if (event.type === "timeline_evidence_attached") {
    const refs = Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [];
    if (!refs.length) return null;
    return (
      <div className="event-details evidence-event-details">
        <div className="evidence-event-details-title">Evidence</div>
        <div className="evidence-event-details-scroll">
          <ul className="evidence-event-details-list">
            {refs.map((entry: Any, index: number) => {
              const source =
                typeof entry?.sourceUrlOrPath === "string" ? entry.sourceUrlOrPath.trim() : "";
              if (!source) return null;
              const snippet =
                typeof entry?.snippet === "string" ? stripHtmlTags(entry.snippet) : "";
              const label = snippet || source;
              const isWeb = /^https?:\/\//i.test(source);
              return (
                <li key={`${source}-${index}`} className="evidence-event-details-item">
                  {isWeb ? (
                    <a href={source} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    <span>{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }

  if (event.type === "timeline_error") {
    const message = getTimelineErrorText(event);
    return (
      <div
        className="event-details"
        style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
      >
        {message || "Timeline error"}
      </div>
    );
  }

  if (effectiveType === "diagram_created") {
    const diagram = typeof event.payload?.diagram === "string" ? event.payload.diagram : "";
    if (!diagram.trim()) return null;
    return (
      <div className="diagram-event-details">
        <MermaidDiagram chart={diagram} />
      </div>
    );
  }

  switch (effectiveType) {
    case "task_completed": {
      const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(event, eventStream);
      const isNeedsUserAction = event.payload?.terminalStatus === "needs_user_action";
      if (!hasTaskOutputs(outputSummary) && !isNeedsUserAction) return null;

      const primaryOutputPath = outputSummary?.primaryOutputPath;
      const primaryOutputName = primaryOutputPath
        ? primaryOutputPath.split("/").pop() || primaryOutputPath
        : "";
      const primaryOutputIsVideo =
        typeof primaryOutputPath === "string" && VIDEO_FILE_EXT_RE.test(primaryOutputPath);
      const primaryOutputIsHtml =
        typeof primaryOutputPath === "string" && HTML_FILE_EXT_RE.test(primaryOutputPath);
      const primaryOutputIsPresentation =
        typeof primaryOutputPath === "string" && PRESENTATION_FILE_EXT_RE.test(primaryOutputPath);
      const latexPair = findLatexPdfPair(eventStream, outputSummary);
      const outputCount = outputSummary?.outputCount ?? 0;
      const outputLabel =
        outputCount === 1
          ? `1 output ready`
          : `${outputCount} outputs ready`;

      const pendingChecklist: string[] = Array.isArray(event.payload?.pendingChecklist)
        ? event.payload.pendingChecklist.filter((item: unknown): item is string => typeof item === "string")
        : [];
      return (
        <div className="event-details completion-output-card">
          <div className="completion-output-header">
            {isNeedsUserAction ? "Action required" : "Output ready"}
          </div>
          {isNeedsUserAction && (
            <div className="completion-output-subtitle">
              Complete the pending verification items to fully close this task.
            </div>
          )}
          {hasTaskOutputs(outputSummary) && (
            <>
              {latexPair && workspacePath && (
                <div className="completion-output-preview">
                  <LatexArtifactWorkbench
                    sourcePath={latexPair.sourcePath}
                    pdfPath={latexPair.pdfPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                </div>
              )}
              {!latexPair && primaryOutputIsVideo && primaryOutputPath && workspacePath && (
                <div className="completion-output-preview">
                  <InlineVideoPreview
                    filePath={primaryOutputPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                </div>
              )}
              {!latexPair && primaryOutputIsHtml && primaryOutputPath && workspacePath && (
                <div className="completion-output-preview">
                  <InlineHtmlPreview
                    filePath={primaryOutputPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                </div>
              )}
              {!latexPair && primaryOutputIsPresentation && primaryOutputPath && workspacePath && (
                <div className="completion-output-preview">
                  <InlinePresentationPreview
                    filePath={primaryOutputPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                </div>
              )}
              <div className="completion-output-subtitle">{outputLabel}</div>
              {primaryOutputPath && (
                <div className="completion-output-primary">
                  Primary file:{" "}
                  <ClickableFilePath
                    path={primaryOutputPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                  {primaryOutputName && <span className="event-title-meta"> ({primaryOutputName})</span>}
                </div>
              )}
              <div className="completion-output-actions">
                <button
                  className="completion-output-btn"
                  disabled={!primaryOutputPath}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!primaryOutputPath) return;
                    void window.electronAPI.openFile(primaryOutputPath, workspacePath);
                  }}
                >
                  Open file
                </button>
                <button
                  className="completion-output-btn secondary"
                  disabled={!primaryOutputPath}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!primaryOutputPath) return;
                    void window.electronAPI.showInFinder(primaryOutputPath, workspacePath);
                  }}
                >
                  Show in Finder
                </button>
                <button
                  className="completion-output-btn secondary"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onViewOutputs?.(event.taskId, primaryOutputPath);
                  }}
                >
                  View in Files
                </button>
              </div>
            </>
          )}
          {pendingChecklist.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {pendingChecklist.map((item, idx) => (
                <li key={`${idx}-${item}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "follow_up_completed": {
      const followUpMessage =
        typeof event.payload?.followUpMessage === "string"
          ? event.payload.followUpMessage.trim()
          : "";
      return (
        <div className="event-details follow-up-completed-details">
          <div className="follow-up-completed-title">Follow-up received</div>
          {followUpMessage && (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={userMarkdownPlugins} components={markdownComponents}>
                {normalizeMarkdownForDisplay(followUpMessage)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      );
    }
    case "plan_created": {
      const inlinePlanMarkdownComponents = {
        ...markdownComponents,
        // Keep each list item inline; avoid wrapping with extra <p> inside <li>.
        p: ({ children }: Any) => <>{children}</>,
      };
      const planSteps = Array.isArray(event.payload.plan?.steps) ? event.payload.plan.steps : [];
      const visiblePlanSteps = options?.hideVerificationSteps
        ? planSteps.filter((step: Any) => !isVerificationStepDescription(step?.description))
        : planSteps;
      return (
        <div className="event-details markdown-content">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {normalizeMarkdownForDisplay(String(event.payload.plan?.description || ""))}
            </ReactMarkdown>
          </div>
          {visiblePlanSteps.length > 0 && (
            <div className="plan-checklist">
              {visiblePlanSteps.map((step: Any, i: number) => (
                <div key={i} className="plan-checklist-item">
                  <span className="plan-checklist-circle" />
                  <span className="plan-checklist-text">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={inlinePlanMarkdownComponents}
                    >
                      {normalizeMarkdownForDisplay(String(step?.description || ""))}
                    </ReactMarkdown>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "tool_call": {
      const tcToolName = event.payload.tool;
      const tcInput = event.payload.input;

      // run_command: embed CLI output inside tool call frame when available
      if (tcToolName === "run_command" && tcInput?.command) {
        const cmdSessions = options?.commandOutputSessions ?? [];
        const renderCmd = options?.renderCommandOutput;
        if (cmdSessions.length > 0 && renderCmd) {
          return (
            <div className="event-details event-details-run-command event-details-scrollable">
              {renderCmd(cmdSessions)}
            </div>
          );
        }
        return (
          <div className="event-details event-details-scrollable">
            <pre>{truncateForDisplay(JSON.stringify(tcInput, null, 2))}</pre>
          </div>
        );
      }

      // write_file: show path + code preview
      if (tcToolName === "write_file" && tcInput?.path && tcInput?.content) {
        const tcLines = tcInput.content.split("\n");
        const tcPreview = tcLines.slice(0, 20).join("\n");
        const tcExt = (tcInput.path.split(".").pop() || "text").toLowerCase();
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.path}</span>
              <span className="code-preview-language">{tcExt}</span>
            </div>
            <pre className="code-preview-content">
              <code>{truncateForDisplay(tcPreview, 1500)}</code>
            </pre>
            {tcLines.length > 20 && (
              <div className="code-preview-truncated">... {tcLines.length - 20} more lines</div>
            )}
          </div>
        );
      }

      // edit_file: show diff-like view
      if (tcToolName === "edit_file" && tcInput?.file_path) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.file_path}</span>
            </div>
            <div className="edit-diff-preview">
              {tcInput.old_string && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre>
                    <code>{truncateForDisplay(tcInput.old_string, 500)}</code>
                  </pre>
                </div>
              )}
              {tcInput.new_string && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre>
                    <code>{truncateForDisplay(tcInput.new_string, 500)}</code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        );
      }

      // Default: formatted JSON
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(tcInput, null, 2))}</pre>
        </div>
      );
    }
    case "tool_result":
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(event.payload.result, null, 2))}</pre>
        </div>
      );
    case "assistant_message": {
      const linkedMessage = cleanAssistantMessageForDisplay(event.payload.message);
      const quote = createQuotedAssistantMessage(linkedMessage, event.id, event.taskId);
      return (
        <div className="event-details assistant-message event-details-scrollable">
          <div className="markdown-content">
            <AssistantMessageContent
              message={linkedMessage}
              markdownComponents={markdownComponents}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
          <div className="message-actions">
            <MessageCopyButton text={event.payload.message} />
            <MessageSpeakButton text={event.payload.message} voiceEnabled={voiceEnabled} />
            {quote && onQuoteAssistantMessage && (
              <MessageQuoteButton onQuote={() => onQuoteAssistantMessage(quote)} />
            )}
          </div>
        </div>
      );
    }
    case "step_completed": {
      if (stepCompletionPreviewPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={stepCompletionPreviewPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }
      return null;
    }
    case "step_failed": {
      const rawReason =
        event.payload?.reason || event.payload?.step?.error || event.payload?.error || "Step failed.";
      return (
        <div
          className="event-details"
          style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
        >
          {formatProviderErrorForDisplay(String(rawReason), { task: taskForEvent })}
        </div>
      );
    }
    case "verification_pending_user_action": {
      const checklist: string[] = Array.isArray(event.payload?.pendingChecklist)
        ? event.payload.pendingChecklist.filter((item: unknown): item is string => typeof item === "string")
        : [];
      return (
        <div className="event-details">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Verification pending user action</div>
          {typeof event.payload?.message === "string" && event.payload.message.trim().length > 0 && (
            <div style={{ marginBottom: checklist.length > 0 ? 6 : 0 }}>{event.payload.message}</div>
          )}
          {checklist.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {checklist.map((item, idx) => (
                <li key={`${idx}-${item}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "approval_requested": {
      const approval = getApprovalPayload(event);
      if (!approval) return null;

      const description = getApprovalDescription(approval);
      const command = extractApprovalCommand(approval);
      const cwd = typeof approval?.details?.cwd === "string" ? approval.details.cwd : "";
      const timeoutMs =
        typeof approval?.details?.timeout === "number" && Number.isFinite(approval.details.timeout)
          ? approval.details.timeout
          : null;
      const timeoutLabel =
        typeof timeoutMs === "number" ? `${Math.max(1, Math.round(timeoutMs / 1000))}s` : null;

      if (command) {
        const commandPreview = buildApprovalCommandPreview(command);
        return (
          <div className="event-details">
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Running command:</div>
            <div className="session-approval-code-scroll" role="region" aria-label="Command">
              <code className="session-approval-code session-approval-code--multiline">{commandPreview.text}</code>
            </div>
            {commandPreview.truncated ? (
              <div className="session-approval-preview-note">
                Preview condensed for readability. Approval still applies to the full command.
              </div>
            ) : null}
            {(cwd || timeoutLabel) && (
              <div style={{ marginTop: 8 }}>
                {cwd && <div>CWD: {cwd}</div>}
                {timeoutLabel && <div>Timeout: {timeoutLabel}</div>}
              </div>
            )}
          </div>
        );
      }

      return (
        <div className="event-details event-details-scrollable">
          {description ? <div style={{ marginBottom: approval.details ? 8 : 0 }}>{description}</div> : null}
          {approval.details && <pre>{truncateForDisplay(JSON.stringify(approval.details, null, 2), 4000)}</pre>}
        </div>
      );
    }
    case "input_request_created": {
      const request = event.payload?.request;
      const questions: Array<{ question?: string; options?: Array<{ label?: string }> }> = Array.isArray(
        request?.questions,
      )
        ? request.questions
        : [];
      if (questions.length === 0) return null;
      return (
        <div className="event-details event-details-scrollable">
          <div style={{ marginBottom: 8, fontWeight: 600 }}>Pending structured prompt</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {questions.map((question, idx) => (
              <li key={`${idx}-${question?.question || "q"}`}>
                <div>{question?.question || "Question"}</div>
                {Array.isArray(question?.options) && question.options.length > 0 && (
                  <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                    {question.options
                      .map((option) => (typeof option?.label === "string" ? option.label : ""))
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      );
    }
    case "file_created": {
      const fcPayload = event.payload;
      const fcPath = fcPayload?.path;
      const fcIsScreenshot = fcPayload?.type === "screenshot";
      const fcPreviewKind = getInlinePreviewKindForGeneratedFile({
        path: fcPath,
        mimeType: fcPayload?.mimeType,
        type: fcPayload?.type,
      });

      if (fcPreviewKind === "image" && fcPath && workspacePath) {
        if (summaryMode && fcIsScreenshot) {
          return (
            <div className="event-details">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Screenshot output</div>
              <ClickableFilePath
                path={fcPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fcPreviewKind === "video" && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineVideoPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fcPreviewKind === "html" && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineHtmlPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fcPreviewKind === "spreadsheet" && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineSpreadsheetPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fcPreviewKind === "presentation" && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlinePresentationPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      const fcMimeType =
        typeof fcPayload?.mimeType === "string" ? fcPayload.mimeType.toLowerCase() : "";
      const fcIsMarkdown =
        fcPayload?.type === "markdown" ||
        fcMimeType === "text/markdown" ||
        /\.md(?:own)?$/i.test(String(fcPath || "")) ||
        String(fcPayload?.language || "").toLowerCase() === "md" ||
        String(fcPayload?.language || "").toLowerCase() === "markdown";
      const fcIsDocument =
        fcPayload?.type === "pdf" ||
        fcPayload?.type === "docx" ||
        fcPayload?.type === "markdown" ||
        fcPayload?.type === "text" ||
        fcPayload?.type === "code" ||
        fcMimeType === "application/pdf" ||
        fcMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        fcMimeType === "text/markdown" ||
        DOCUMENT_PREVIEW_EXT_RE.test(String(fcPath || ""));

      // For markdown outputs, prefer rendered markdown over raw contentPreview syntax.
      if (fcIsMarkdown && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Content preview for text file writes
      if (fcPayload?.contentPreview) {
        const previewLineCount = fcPayload.contentPreview.split("\n").length;
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-language">{fcPayload.language || "text"}</span>
              {fcPayload.previewTruncated && (
                <span className="code-preview-truncated">
                  showing first {previewLineCount} of {fcPayload.lineCount} lines
                </span>
              )}
            </div>
            <HighlightedCodePreview code={fcPayload.contentPreview} language={fcPayload.language} />
          </div>
        );
      }

      if (fcIsDocument && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Copy source info
      if (fcPayload?.copiedFrom) {
        return (
          <div className="event-details">
            Copied from:{" "}
            <ClickableFilePath
              path={fcPayload.copiedFrom}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      return null;
    }
    case "file_modified": {
      const fmPayload = event.payload;
      const fmPath = fmPayload?.path || fmPayload?.from;
      const fmIsScreenshot = fmPayload?.type === "screenshot";
      const fmPreviewKind = getInlinePreviewKindForGeneratedFile({
        path: fmPath,
        mimeType: fmPayload?.mimeType,
        type: fmPayload?.type,
      });

      if (fmPreviewKind === "image" && fmPath && workspacePath) {
        if (summaryMode && fmIsScreenshot) {
          return (
            <div className="event-details">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Screenshot output</div>
              <ClickableFilePath
                path={fmPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview
              filePath={fmPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fmPreviewKind === "video" && fmPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineVideoPreview
              filePath={fmPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fmPreviewKind === "html" && fmPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineHtmlPreview
              filePath={fmPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      if (fmPreviewKind === "presentation" && fmPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlinePresentationPreview
              filePath={fmPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Edit diff preview
      if (fmPayload?.type === "edit" && (fmPayload?.oldPreview || fmPayload?.newPreview)) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="edit-diff-preview">
              {fmPayload.oldPreview && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre>
                    <code>{fmPayload.oldPreview}</code>
                  </pre>
                </div>
              )}
              {fmPayload.newPreview && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre>
                    <code>{fmPayload.newPreview}</code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        );
      }

      // Rename info
      if (fmPayload?.action === "rename" && fmPayload?.from && fmPayload?.to) {
        return (
          <div className="event-details">
            <ClickableFilePath
              path={fmPayload.from}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
            {" → "}
            <ClickableFilePath
              path={fmPayload.to}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      return null;
    }
    case "artifact_created": {
      const artifactPath = event.payload?.path;
      if (typeof artifactPath === "string" && artifactPath.trim().length > 0) {
        const latexPair = findLatexPdfPair([event]);
        const artifactPreviewKind = getInlinePreviewKindForGeneratedFile({
          path: artifactPath,
          mimeType: event.payload?.mimeType,
          type: event.payload?.type,
        });
        const artifactMimeType =
          typeof event.payload?.mimeType === "string" ? event.payload.mimeType.toLowerCase() : "";
        const artifactIsDocument =
          artifactMimeType === "application/pdf" ||
          artifactMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          artifactMimeType === "text/markdown" ||
          artifactMimeType.startsWith("text/") ||
          DOCUMENT_PREVIEW_EXT_RE.test(String(artifactPath || ""));

        if (latexPair && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <LatexArtifactWorkbench
                sourcePath={latexPair.sourcePath}
                pdfPath={latexPair.pdfPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactPreviewKind === "image" && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineImagePreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactPreviewKind === "video" && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineVideoPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactPreviewKind === "html" && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineHtmlPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactPreviewKind === "spreadsheet" && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineSpreadsheetPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactPreviewKind === "presentation" && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlinePresentationPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactIsDocument && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineDocumentPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        return (
          <div className="event-details">
            Saved artifact:{" "}
            <ClickableFilePath
              path={artifactPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }
      return null;
    }
    case "error":
      return (
        <div
          className="event-details"
          style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
        >
          {formatProviderErrorForDisplay(
            String(event.payload.error || event.payload.message || ""),
            { task: taskForEvent },
          )}
        </div>
      );
    default:
      return null;
  }
}
