import type { EventType, TaskEvent, TaskStatus } from "../../shared/types";
import { inferTimelineSubStageLabel } from "../../shared/timeline-v2";
import { getEffectiveTaskEventType, getTimelineErrorText } from "./task-event-compat";
import { hasAssistantMediaDirective } from "./assistant-media-directives";
import {
  deriveApprovalEventState,
  isApprovalRequestResolvedAtEmission,
} from "./approval-event-state";

export const IMPORTANT_EVENT_TYPES: EventType[] = [
  "task_created",
  "task_completed",
  "follow_up_completed",
  "task_cancelled",
  "plan_created",
  "step_started",
  "step_completed",
  "step_failed",
  "assistant_message",
  "user_message",
  "agent_spawn_requested",
  "agent_spawned",
  "agent_message",
  "agent_follow_up_scheduled",
  "agent_follow_up_started",
  "agent_interrupt_requested",
  "agent_interrupt_confirmed",
  "agent_failed",
  "agent_completed",
  "file_created",
  "file_modified",
  "file_deleted",
  "artifact_created",
  "diagram_created",
  "citations_collected",
  "error",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "verification_pending_user_action",
  "retry_started",
  "auto_continuation_started",
  "auto_continuation_blocked",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_summarized",
  "no_progress_circuit_breaker",
  "step_contract_escalated",
  "approval_requested",
  "approval_denied",
  "input_request_created",
  "input_request_resolved",
  "input_request_dismissed",
  "task_list_created",
  "task_list_updated",
  "task_list_verification_nudged",
];

export const ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "input_request_created",
  "input_request_resolved",
  "input_request_dismissed",
  "error",
  "step_failed",
  "verification_failed",
  "verification_pending_user_action",
  "auto_continuation_started",
  "auto_continuation_blocked",
  "context_compaction_started",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_summarized",
  "no_progress_circuit_breaker",
  "step_contract_escalated",
  "task_completed",
  "artifact_created",
  "diagram_created",
  "task_list_created",
  "task_list_updated",
  "task_list_verification_nudged",
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_error",
]);

const SUMMARY_HIDDEN_STAGE_NAMES = new Set(["DISCOVER", "BUILD", "VERIFY", "FIX", "DELIVER"]);
const SUMMARY_HIDDEN_STAGE_GROUP_IDS = new Set([
  "stage:discover",
  "stage:build",
  "stage:verify",
  "stage:fix",
  "stage:deliver",
]);
const SUMMARY_HIDDEN_GROUP_ID_PREFIXES = ["tools:"];
const SUMMARY_HIDDEN_GROUP_LABEL_PATTERN = /\b(?:follow-up\s+)?tool\s+batch\b/i;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getCompactionPayloadText(event: TaskEvent, keys: string[]): string {
  const payload = asObject(event.payload);
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * `context_summarized` is an older persistence event emitted alongside the
 * visible compaction lifecycle. Keep it for legacy sessions, but hide it when
 * a matching completed lifecycle event is present so the feed has one row.
 */
export function isDuplicateContextSummaryEvent(
  event: TaskEvent,
  events: readonly TaskEvent[],
): boolean {
  if (getEffectiveTaskEventType(event) !== "context_summarized") return false;

  const compactionId = getCompactionPayloadText(event, ["compactionId", "compaction_id"]);
  const summary = getCompactionPayloadText(event, ["summary", "summaryText", "summaryPreview"]);
  return events.some((candidate) => {
    if (candidate === event || candidate.taskId !== event.taskId) return false;
    const candidateType = getEffectiveTaskEventType(candidate);
    if (
      candidateType !== "context_compaction_completed" &&
      candidateType !== "context_compaction_failed"
    ) {
      return false;
    }

    const candidateCompactionId = getCompactionPayloadText(candidate, [
      "compactionId",
      "compaction_id",
    ]);
    if (compactionId && candidateCompactionId) return compactionId === candidateCompactionId;

    const candidateSummary = getCompactionPayloadText(candidate, [
      "summary",
      "summaryText",
      "summaryPreview",
    ]);
    return Boolean(
      summary &&
      candidateSummary &&
      summary === candidateSummary &&
      Math.abs(candidate.timestamp - event.timestamp) <= 10_000,
    );
  });
}

const CONTEXT_COMPACTION_RESOLUTION_TYPES = new Set<string>([
  "context_compaction_completed",
  "context_compaction_failed",
  "context_summarized",
]);

/**
 * "Context automatically compacting" is a live progress marker with a spinner. Once its
 * lifecycle resolves, the completed (or failed) row states the outcome, so keeping the start
 * row leaves the feed showing both tenses at once and still animating a finished step.
 */
export function isResolvedContextCompactionStartEvent(
  event: TaskEvent,
  events: readonly TaskEvent[],
): boolean {
  if (getEffectiveTaskEventType(event) !== "context_compaction_started") return false;

  const compactionId = getCompactionPayloadText(event, ["compactionId", "compaction_id"]);
  return events.some((candidate) => {
    if (candidate === event || candidate.taskId !== event.taskId) return false;
    if (!CONTEXT_COMPACTION_RESOLUTION_TYPES.has(getEffectiveTaskEventType(candidate))) {
      return false;
    }
    if (candidate.timestamp < event.timestamp) return false;
    const candidateCompactionId = getCompactionPayloadText(candidate, [
      "compactionId",
      "compaction_id",
    ]);
    // Sessions predating the lifecycle id carry no correlation key; a later resolution in the
    // same task is the only signal available, and compaction runs are never interleaved.
    if (!compactionId || !candidateCompactionId) return true;
    return compactionId === candidateCompactionId;
  });
}

/** Stage transitions are emitted from inside the source event's own log call. */
const STAGE_TRANSITION_SOURCE_WINDOW_MS = 2_000;

/**
 * A stage transition borrows its label from the event that triggered it (the daemon passes
 * `inferTimelineSubStageLabel(sourceType)` as the group label), so the group row and that
 * event's own row print the same sentence back to back. The event row is the richer of the
 * two — it carries lifecycle status, spinner state and expandable details — so drop the group.
 */
export function isRedundantStageTransitionGroupEvent(
  event: TaskEvent,
  events: readonly TaskEvent[],
): boolean {
  if (event.type !== "timeline_group_started") return false;
  if (!isSubStageTimelineGroupEvent(event)) return false;

  const groupLabel = getTimelineGroupLabel(event);
  if (!groupLabel) return false;

  return events.some((candidate) => {
    if (candidate === event || candidate.taskId !== event.taskId) return false;
    // The source event is persisted with the timestamp it captured before the re-entrant
    // transition, so it can land on either side of the group event.
    if (Math.abs(candidate.timestamp - event.timestamp) > STAGE_TRANSITION_SOURCE_WINDOW_MS) {
      return false;
    }
    const candidateType = getEffectiveTaskEventType(candidate) as EventType;
    return inferTimelineSubStageLabel(candidateType) === groupLabel;
  });
}

function getPayloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Compact mode should display permission outcomes, not approval bookkeeping.
 * Keep genuinely pending requests visible, remove requests with a terminal
 * grant or denial, and retain the denial itself as the user-facing outcome.
 */
export function filterResolvedApprovalNarration(
  events: TaskEvent[],
  resolutionEvents: TaskEvent[] = events,
): TaskEvent[] {
  const { resolvedRequestEventIds } = deriveApprovalEventState(resolutionEvents);
  return events.filter((event) => {
    if (getEffectiveTaskEventType(event) !== "approval_requested") return true;
    return !isApprovalRequestResolvedAtEmission(event) && !resolvedRequestEventIds.has(event.id);
  });
}

export function isLlmRequestCancelledEvent(event: TaskEvent): boolean {
  const payload = asObject(event.payload);
  const message = [
    event.type === "timeline_error" ? getTimelineErrorText(event) : "",
    getPayloadText(payload, "message"),
    getPayloadText(payload, "error"),
    getPayloadText(payload, "reason"),
    getPayloadText(payload, "details"),
  ]
    .filter(Boolean)
    .join(" ");
  if (!/\brequest\s+cancell?ed\b/i.test(message)) return false;

  const effectiveType = getEffectiveTaskEventType(event);
  const legacyType =
    typeof event.legacyType === "string"
      ? event.legacyType
      : typeof payload.legacyType === "string"
        ? payload.legacyType
        : "";

  return (
    effectiveType === "llm_error" ||
    legacyType === "llm_error" ||
    /\bllm\s+api\s+error\b/i.test(message)
  );
}

function getTimelineGroupPayload(event: TaskEvent): Record<string, unknown> {
  return asObject(event.payload);
}

function getTimelineGroupId(event: TaskEvent): string {
  const payload = getTimelineGroupPayload(event);
  const fromEvent = typeof event.groupId === "string" ? event.groupId.trim() : "";
  if (fromEvent.length > 0) return fromEvent;
  return typeof payload.groupId === "string" ? payload.groupId.trim() : "";
}

function getTimelineGroupLabel(event: TaskEvent): string {
  const payload = getTimelineGroupPayload(event);
  return typeof payload.groupLabel === "string" ? payload.groupLabel.trim() : "";
}

function isSubStageTimelineGroupEvent(event: TaskEvent): boolean {
  const payload = getTimelineGroupPayload(event);
  const stage = typeof payload.stage === "string" ? payload.stage.trim().toUpperCase() : "";
  const groupLabel = getTimelineGroupLabel(event);
  return Boolean(stage && groupLabel && groupLabel.toUpperCase() !== stage);
}

function isStageBoundaryTimelineGroupEvent(event: TaskEvent): boolean {
  if (event.type !== "timeline_group_started" && event.type !== "timeline_group_finished") {
    return false;
  }

  const payload = getTimelineGroupPayload(event);

  const stage = typeof payload.stage === "string" ? payload.stage.trim().toUpperCase() : "";
  if (stage && SUMMARY_HIDDEN_STAGE_NAMES.has(stage)) {
    return true;
  }

  const groupIdRaw = getTimelineGroupId(event);
  const normalizedGroupId = typeof groupIdRaw === "string" ? groupIdRaw.trim().toLowerCase() : "";
  return normalizedGroupId.length > 0 && SUMMARY_HIDDEN_STAGE_GROUP_IDS.has(normalizedGroupId);
}

function isToolBatchTimelineGroupEvent(event: TaskEvent): boolean {
  if (event.type !== "timeline_group_started" && event.type !== "timeline_group_finished") {
    return false;
  }

  const groupId = getTimelineGroupId(event).toLowerCase();
  if (groupId.length > 0) {
    for (const prefix of SUMMARY_HIDDEN_GROUP_ID_PREFIXES) {
      if (groupId.startsWith(prefix)) return true;
    }
  }

  const groupLabel = getTimelineGroupLabel(event);
  return SUMMARY_HIDDEN_GROUP_LABEL_PATTERN.test(groupLabel);
}

function isToolBatchLaneEvent(event: TaskEvent): boolean {
  const groupId = getTimelineGroupId(event).toLowerCase();
  if (!groupId || !groupId.startsWith("tools:")) return false;

  const effectiveType = getEffectiveTaskEventType(event);
  if (
    effectiveType === "tool_call" ||
    effectiveType === "tool_result" ||
    effectiveType === "tool_error"
  ) {
    return true;
  }

  return (
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_updated" ||
    event.type === "timeline_step_finished"
  );
}

function isImplementationOnlyBrowserActionEvent(event: TaskEvent): boolean {
  return String(event.type) === "browser_action";
}

// In non-verbose mode, hide most tool traffic but keep user-facing schedule confirmations visible.
export function isImportantTaskEvent(event: TaskEvent): boolean {
  if (isImplementationOnlyBrowserActionEvent(event)) return false;
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "approval_requested" && isApprovalRequestResolvedAtEmission(event)) {
    return false;
  }
  if (IMPORTANT_EVENT_TYPES.includes(effectiveType as EventType)) return true;
  if (effectiveType !== "tool_result") return false;
  return String((event as Any)?.payload?.tool || "") === "schedule_task";
}

function getEventMessage(event: TaskEvent): string {
  if (event.type === "timeline_error") {
    return getTimelineErrorText(event);
  }
  const raw = typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
  return raw;
}

const VERBOSE_DUPLICATE_WINDOW_MS = 15_000;

function normalizeFailureTextForDedupe(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function getComparableFailureText(event: TaskEvent): string {
  if (event.type === "timeline_error") {
    return normalizeFailureTextForDedupe(getTimelineErrorText(event));
  }

  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType !== "step_failed") return "";

  const payload = asObject(event.payload);
  const step = asObject(payload.step);
  const raw =
    getPayloadText(payload, "reason") ||
    getPayloadText(step, "error") ||
    getPayloadText(payload, "error") ||
    getPayloadText(payload, "message") ||
    getPayloadText(step, "description");
  return normalizeFailureTextForDedupe(raw);
}

function isTimelineErrorStepFailureDuplicate(current: TaskEvent, previous: TaskEvent): boolean {
  const currentIsTimelineError = current.type === "timeline_error";
  const previousIsTimelineError = previous.type === "timeline_error";
  if (currentIsTimelineError === previousIsTimelineError) return false;
  if (current.taskId !== previous.taskId) return false;

  const currentEffectiveType = getEffectiveTaskEventType(current);
  const previousEffectiveType = getEffectiveTaskEventType(previous);
  const hasFailedStep =
    currentEffectiveType === "step_failed" || previousEffectiveType === "step_failed";
  if (!hasFailedStep) return false;

  if (
    Math.abs((current.timestamp ?? 0) - (previous.timestamp ?? 0)) > VERBOSE_DUPLICATE_WINDOW_MS
  ) {
    return false;
  }

  const currentFailureText = getComparableFailureText(current);
  const previousFailureText = getComparableFailureText(previous);
  return Boolean(currentFailureText && currentFailureText === previousFailureText);
}

interface ArtifactPathIdentity {
  normalized: string;
  basename: string;
  absolute: boolean;
}

function normalizeArtifactPath(value: unknown): ArtifactPathIdentity | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized) return undefined;
  const withoutDot = normalized.replace(/^\.\//, "");
  const basename = withoutDot.slice(withoutDot.lastIndexOf("/") + 1);
  if (!basename) return undefined;
  return {
    normalized: withoutDot,
    basename,
    absolute: /^(?:\/|[A-Za-z]:\/)/.test(withoutDot),
  };
}

function getArtifactPathIdentity(event: TaskEvent): ArtifactPathIdentity | undefined {
  const effectiveType = getEffectiveTaskEventType(event);
  if (
    effectiveType !== "artifact_created" &&
    effectiveType !== "file_created" &&
    effectiveType !== "diagram_created" &&
    event.type !== "timeline_artifact_emitted"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  if (effectiveType === "file_created" && payload.type === "directory") return undefined;
  const artifact = asObject(payload.artifact);
  for (const candidate of [
    payload.path,
    payload.outputPath,
    payload.filePath,
    payload.file_path,
    payload.artifactPath,
    artifact.path,
    artifact.outputPath,
    artifact.filePath,
  ]) {
    const identity = normalizeArtifactPath(candidate);
    if (identity) return identity;
  }
  return undefined;
}

function artifactPathsRepresentSameOutput(
  current: ArtifactPathIdentity,
  previous: ArtifactPathIdentity,
): boolean {
  if (current.normalized === previous.normalized) return true;
  // A renderer may receive one event from the artifact service with an
  // absolute path and another compatibility event with a workspace-relative
  // path.  A relative path with directory components must be a suffix of the
  // absolute path before it is considered the same file.  Basename-only
  // relative emissions remain the one intentionally ambiguous compatibility
  // case; two distinct absolute directories are always retained.
  if (current.absolute === previous.absolute || current.basename !== previous.basename) {
    return false;
  }
  const absolute = current.absolute ? current.normalized : previous.normalized;
  const relative = current.absolute ? previous.normalized : current.normalized;
  if (!relative.includes("/")) return true;
  return absolute.endsWith(`/${relative}`);
}

/** Collapse duplicate artifact emissions across the canonical and timeline
 * event formats while retaining distinct files and late retries. */
function filterDuplicateTimelineArtifacts(events: TaskEvent[]): TaskEvent[] {
  const out: TaskEvent[] = [];
  const seenByTask = new Map<
    string,
    Array<{ identity: ArtifactPathIdentity; timestamp: number; outputIndex: number }>
  >();
  for (const event of events) {
    const identity = getArtifactPathIdentity(event);
    // Without a task boundary an artifact path is not safe to compare: two
    // independent streams can legitimately emit the same relative filename.
    if (!identity || !event.taskId) {
      out.push(event);
      continue;
    }
    const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : 0;
    const previous = seenByTask.get(event.taskId) || [];
    const active = previous.filter(
      (candidate) => Math.abs(timestamp - candidate.timestamp) <= VERBOSE_DUPLICATE_WINDOW_MS,
    );
    const duplicate = active.find((candidate) =>
      artifactPathsRepresentSameOutput(identity, candidate.identity),
    );
    if (duplicate) {
      out[duplicate.outputIndex] = event;
      duplicate.identity = identity;
      duplicate.timestamp = timestamp;
      seenByTask.set(event.taskId, active);
      continue;
    }
    const outputIndex = out.length;
    out.push(event);
    active.push({ identity, timestamp, outputIndex });
    seenByTask.set(event.taskId, active);
  }
  return out;
}

export function filterAdjacentDuplicateTimelineFailures(events: TaskEvent[]): TaskEvent[] {
  const out: TaskEvent[] = [];
  for (const event of events) {
    const previousVisibleEvent = out[out.length - 1];
    if (previousVisibleEvent && isTimelineErrorStepFailureDuplicate(event, previousVisibleEvent)) {
      if (event.type === "timeline_error") {
        continue;
      }
      out[out.length - 1] = event;
      continue;
    }
    out.push(event);
  }
  return filterDuplicateTimelineArtifacts(out);
}

const BOT_CONVERSATION_INTERNAL_EVENT_TYPES = new Set([
  "agent_message",
  "agent_spawn_requested",
  "agent_spawned",
  "agent_completed",
  "agent_failed",
  "agent_follow_up_scheduled",
  "agent_follow_up_started",
]);
const BOT_CONVERSATION_MESSAGE_DEDUPE_WINDOW_MS = 30_000;

/**
 * Recovery attempts used to be persisted as ordinary user-message events.
 * They are useful in the durable activity log, but showing the same long
 * orchestration brief in the primary bot conversation makes a retry look like
 * a new user instruction and buries the actual teammate exchange.
 */
const BOT_CONVERSATION_INTERNAL_PROMPT_PATTERNS = [
  /^\s*\[RETRY CONTEXT\]:/i,
  /^\s*Recovery run(?:\s+for\b|\b)/i,
  /\bread-only\s+opportunity-discovery\b[\s\S]*\b(?:send_agent_message|do not merely describe or simulate)\b/i,
];

function isBotConversationInternalPrompt(event: TaskEvent): boolean {
  if (getEffectiveTaskEventType(event) !== "user_message") return false;

  const payload = asObject(event.payload);
  // Inbound teammate work is a real conversation message, even when its text
  // happens to mention recovery.
  if (payload.messageSource === "agent") return false;

  const message = getEventMessage(event);
  return BOT_CONVERSATION_INTERNAL_PROMPT_PATTERNS.some((pattern) => pattern.test(message));
}

function normalizeConversationMessage(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function getBotTranscriptMessageScope(payload: Record<string, unknown>): string {
  if (payload.messageSource !== "agent") return "";
  return [
    payload.senderTaskId,
    payload.sender_task_id,
    payload.senderLabel,
    payload.sender,
    payload.targetTaskId,
    payload.target_task_id,
    payload.recipientLabel,
    payload.recipient,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLocaleLowerCase())
    .join("|");
}

/**
 * A streamed assistant turn can be appended twice when the live event and
 * its durable replay arrive in the same render batch. Collapse only an exact
 * repeated payload; ordinary repeated prose remains untouched.
 */
function collapseRepeatedAssistantMessage(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return value;

  if (normalized.length % 2 === 0) {
    const halfLength = normalized.length / 2;
    if (normalized.slice(0, halfLength) === normalized.slice(halfLength)) {
      return normalized.slice(0, halfLength).trimEnd();
    }
  }

  for (const separator of ["\n\n", "\n"]) {
    const parts = normalized.split(separator);
    if (parts.length < 2 || parts.length % 2 !== 0) continue;
    const midpoint = parts.length / 2;
    const firstHalf = parts.slice(0, midpoint).join(separator);
    const secondHalf = parts.slice(midpoint).join(separator);
    if (firstHalf === secondHalf) return firstHalf.trimEnd();
  }

  return value;
}

/**
 * Keep bot conversations message-first. Handoff delivery and retry lifecycle
 * events are represented by BotCollaborationHeader, while the transcript gets
 * one visible card per logical message even when a renderer retry persisted a
 * second event with a different event id.
 */
export function filterBotConversationTranscriptEvents(events: TaskEvent[]): TaskEvent[] {
  const out: TaskEvent[] = [];
  const byStableMessageId = new Map<string, number>();
  const byMessageText = new Map<string, { index: number; timestamp: number }>();

  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (BOT_CONVERSATION_INTERNAL_EVENT_TYPES.has(effectiveType)) continue;
    if (isBotConversationInternalPrompt(event)) continue;

    const payload = asObject(event.payload);
    const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : event.ts || 0;

    // Completion summaries are persisted independently from assistant-message events. When a
    // coordinator turn completes, the summary can therefore replay the same waiting text (or
    // the final receipt) that is already present as a conversation message. Keep one message
    // card, while still retaining a distinct completion outcome when it has unique content.
    if (effectiveType === "task_completed") {
      const rawSummary =
        typeof payload.resultSummary === "string" ? payload.resultSummary.trim() : "";
      const collapsedSummary = collapseRepeatedAssistantMessage(rawSummary);
      const summary = normalizeConversationMessage(collapsedSummary);
      if (summary) {
        const previousAssistant = byMessageText.get(`${event.taskId}|assistant_message|${summary}`);
        if (
          previousAssistant &&
          Math.abs(timestamp - previousAssistant.timestamp) <=
            BOT_CONVERSATION_MESSAGE_DEDUPE_WINDOW_MS
        ) {
          continue;
        }
      }
      out.push(
        collapsedSummary !== rawSummary && typeof payload.resultSummary === "string"
          ? { ...event, payload: { ...payload, resultSummary: collapsedSummary } }
          : event,
      );
      continue;
    }

    if (effectiveType !== "user_message" && effectiveType !== "assistant_message") {
      out.push(event);
      continue;
    }

    const rawMessage = getEventMessage(event);
    const collapsedMessage =
      effectiveType === "assistant_message"
        ? collapseRepeatedAssistantMessage(rawMessage)
        : rawMessage;
    const renderEvent =
      collapsedMessage !== rawMessage && typeof payload.message === "string"
        ? { ...event, payload: { ...payload, message: collapsedMessage } }
        : event;
    const messageId =
      typeof payload.messageId === "string" && payload.messageId.trim()
        ? payload.messageId.trim()
        : typeof payload.message_id === "string" && payload.message_id.trim()
          ? payload.message_id.trim()
          : "";
    const message = normalizeConversationMessage(collapsedMessage);
    const messageScope = getBotTranscriptMessageScope(payload);
    const stableKey = messageId
      ? `${event.taskId}|${effectiveType}|${messageId}`
      : message
        ? `${event.taskId}|${effectiveType}|${messageScope ? `scope:${messageScope}|` : ""}text:${message}`
        : "";
    if (stableKey && byStableMessageId.has(stableKey)) {
      // Delivery status can be updated by a later receipt event. Keep the
      // latest copy for agent messages so the compact card is not left queued.
      if (payload.messageSource === "agent") {
        out[byStableMessageId.get(stableKey)!] = renderEvent;
      }
      continue;
    }
    if (message) {
      const textKey = messageScope
        ? `${event.taskId}|${effectiveType}|${messageScope}|${message}`
        : `${event.taskId}|${effectiveType}|${message}`;
      const previous = byMessageText.get(textKey);
      if (
        previous &&
        Math.abs(timestamp - previous.timestamp) <= BOT_CONVERSATION_MESSAGE_DEDUPE_WINDOW_MS
      ) {
        if (payload.messageSource === "agent") out[previous.index] = renderEvent;
        continue;
      }
      byMessageText.set(textKey, { index: out.length, timestamp });
    }
    if (stableKey) byStableMessageId.set(stableKey, out.length);
    out.push(renderEvent);
  }

  return out;
}

function getToolCorrelationId(payload: Record<string, unknown>): string {
  const toolUseId =
    typeof payload.toolUseId === "string" && payload.toolUseId.trim().length > 0
      ? payload.toolUseId.trim()
      : "";
  if (toolUseId) return toolUseId;
  const callId =
    typeof payload.callId === "string" && payload.callId.trim().length > 0
      ? payload.callId.trim()
      : "";
  if (callId) return callId;
  const id =
    typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id.trim() : "";
  return id;
}

function getStepId(event: TaskEvent, payload: Record<string, unknown>): string {
  if (typeof event.stepId === "string" && event.stepId.trim().length > 0) {
    return event.stepId.trim();
  }
  if (typeof payload.stepId === "string" && payload.stepId.trim().length > 0) {
    return payload.stepId.trim();
  }
  const step = asObject(payload.step);
  return typeof step.id === "string" && step.id.trim().length > 0 ? step.id.trim() : "";
}

function getStepDescription(payload: Record<string, unknown>): string {
  const step = asObject(payload.step);
  return typeof step.description === "string" && step.description.trim().length > 0
    ? step.description.trim()
    : "";
}

function buildVerboseDuplicateKey(event: TaskEvent): string | null {
  const payload = asObject(event.payload);
  const effectiveType = getEffectiveTaskEventType(event);
  const message = getEventMessage(event);
  const groupId = getTimelineGroupId(event);
  const stepId = getStepId(event, payload);

  if (event.type === "timeline_group_started" || event.type === "timeline_group_finished") {
    const stage = typeof payload.stage === "string" ? payload.stage.trim().toUpperCase() : "";
    const groupLabel = getTimelineGroupLabel(event);
    const basis = groupId || stage || groupLabel || message;
    return basis ? `${event.type}|${basis}|${event.status || ""}` : null;
  }

  if (
    effectiveType === "tool_call" ||
    effectiveType === "tool_result" ||
    effectiveType === "tool_error"
  ) {
    const input = asObject(payload.input);
    const result = asObject(payload.result);
    const tool = typeof payload.tool === "string" ? payload.tool.trim() : "";
    const correlationId = getToolCorrelationId(payload);
    const url =
      (typeof result.url === "string" && result.url.trim()) ||
      (typeof input.url === "string" && input.url.trim()) ||
      "";
    const path =
      (typeof result.path === "string" && result.path.trim()) ||
      (typeof input.path === "string" && input.path.trim()) ||
      (typeof input.file_path === "string" && input.file_path.trim()) ||
      "";
    const query =
      (typeof result.query === "string" && result.query.trim()) ||
      (typeof input.query === "string" && input.query.trim()) ||
      (typeof input.pattern === "string" && input.pattern.trim()) ||
      "";
    const basis = correlationId || url || path || query || message;
    return basis ? `${effectiveType}|${tool}|${basis}|${groupId}` : null;
  }

  if (
    effectiveType === "step_started" ||
    effectiveType === "step_completed" ||
    effectiveType === "step_failed"
  ) {
    const description = getStepDescription(payload);
    const basis = stepId || description || message;
    return basis ? `${effectiveType}|${basis}|${groupId}|${event.status || ""}` : null;
  }

  if (effectiveType === "artifact_created") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    const basis = path || label || message;
    return basis ? `${effectiveType}|${basis}` : null;
  }

  if (effectiveType === "error" || event.type === "timeline_error") {
    return message ? `error|${message}` : null;
  }

  if (event.type === "log") {
    return message ? `log|${message}` : null;
  }

  return null;
}

function isLowValueVerboseLifecycleEvent(event: TaskEvent): boolean {
  const message = getEventMessage(event);
  const effectiveType = getEffectiveTaskEventType(event);

  // timeline_step_updated events are internal executor status beacons.
  // Preserve user-visible chat messages, which are persisted as
  // timeline_step_updated + legacyType=user_message/assistant_message in timeline v2.
  if (event.type === "timeline_step_updated") {
    if (effectiveType === "user_message") {
      return false;
    }
    if (effectiveType === "assistant_message") {
      const payload = asObject(event.payload);
      const message = typeof payload.message === "string" ? payload.message : "";
      return payload.internal === true && !hasAssistantMediaDirective(message);
    }
    return true;
  }

  if (event.type === "timeline_group_started") {
    return false;
  }

  // timeline_step_finished events echo tool/step completion that is already
  // visible from tool_result or timeline_group_finished events.
  // Keep terminal task outcomes as well: task_completed carries the final
  // resultSummary that Verbose mode must render as the assistant response.
  if (event.type === "timeline_step_finished") {
    const payload = asObject(event.payload);
    const legacyType = typeof payload.legacyType === "string" ? payload.legacyType : "";
    if (
      effectiveType === "task_completed" ||
      legacyType === "task_cancelled" ||
      event.status === "failed"
    ) {
      return false;
    }
    return true;
  }

  if (
    event.type === "timeline_group_finished" &&
    isStageBoundaryTimelineGroupEvent(event) &&
    event.status !== "failed"
  ) {
    return true;
  }

  if (event.type === "log") {
    return /^\[planning\]/i.test(message) || /^\[skill-routing\]/i.test(message);
  }

  return false;
}

function isVerbosePostFailureCutoffEvent(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  return (
    event.type === "timeline_error" ||
    effectiveType === "error" ||
    effectiveType === "step_failed" ||
    effectiveType === "verification_failed" ||
    effectiveType === "verification_pending_user_action"
  );
}

/**
 * In verbose mode, hide internal lifecycle chatter so the feed stays readable.
 * Progress updates are intentionally hidden entirely; they are executor status beacons,
 * not user-facing steps.
 */
export function filterVerboseTimelineNoise(events: TaskEvent[]): TaskEvent[] {
  const out: TaskEvent[] = [];
  const seenExactIds = new Set<string>();
  const lastSeenByKey = new Map<string, number>();
  const cancelledTaskIds = new Set(
    events
      .filter((event) => getEffectiveTaskEventType(event) === "task_cancelled")
      .map((event) => event.taskId),
  );
  const taskIdsAfterBlockingFailure = new Set<string>();
  const completedTaskIds = new Set<string>();
  for (const event of events) {
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "task_started" || effectiveType === "user_message") {
      completedTaskIds.delete(event.taskId);
      taskIdsAfterBlockingFailure.delete(event.taskId);
    }
    if (cancelledTaskIds.has(event.taskId) && isLlmRequestCancelledEvent(event)) continue;
    if (completedTaskIds.has(event.taskId) && isStageBoundaryTimelineGroupEvent(event)) {
      continue;
    }
    if (
      taskIdsAfterBlockingFailure.has(event.taskId) &&
      event.type === "timeline_group_started" &&
      isStageBoundaryTimelineGroupEvent(event)
    ) {
      continue;
    }
    if (isLowValueVerboseLifecycleEvent(event)) continue;
    if (effectiveType === "progress_update") continue;
    const exactId =
      typeof event.eventId === "string" && event.eventId.trim().length > 0
        ? event.eventId.trim()
        : typeof event.id === "string" && event.id.trim().length > 0
          ? event.id.trim()
          : "";
    if (exactId) {
      if (seenExactIds.has(exactId)) continue;
      seenExactIds.add(exactId);
    }
    const duplicateKey = buildVerboseDuplicateKey(event);
    if (duplicateKey) {
      const previousTs = lastSeenByKey.get(duplicateKey);
      if (
        typeof previousTs === "number" &&
        Math.abs((event.timestamp ?? 0) - previousTs) <= VERBOSE_DUPLICATE_WINDOW_MS
      ) {
        continue;
      }
      lastSeenByKey.set(duplicateKey, event.timestamp ?? 0);
    }
    out.push(event);
    if (effectiveType === "task_completed") {
      completedTaskIds.add(event.taskId);
    }
    if (isVerbosePostFailureCutoffEvent(event)) {
      taskIdsAfterBlockingFailure.add(event.taskId);
    }
  }
  return filterAdjacentDuplicateTimelineFailures(out);
}

export function shouldShowTaskEventInSummaryMode(
  event: TaskEvent,
  taskStatus?: TaskStatus,
): boolean {
  if (taskStatus === "cancelled" && isLlmRequestCancelledEvent(event)) return false;
  if (!isImportantTaskEvent(event)) return false;
  if (isToolBatchTimelineGroupEvent(event)) return false;
  if (isToolBatchLaneEvent(event)) return false;

  if (isStageBoundaryTimelineGroupEvent(event)) {
    if (event.type === "timeline_group_finished") return false;
    if (taskStatus === "completed") return false;
    return isSubStageTimelineGroupEvent(event);
  }

  return true;
}

export function shouldShowTaskEventInStepFeed(
  event: TaskEvent,
  options?: { verboseSteps?: boolean },
): boolean {
  if (isImplementationOnlyBrowserActionEvent(event)) return false;
  if (isToolBatchTimelineGroupEvent(event)) return false;
  if (isToolBatchLaneEvent(event)) return false;

  if (isStageBoundaryTimelineGroupEvent(event)) {
    if (options?.verboseSteps) return true;
    return isSubStageTimelineGroupEvent(event);
  }

  return true;
}
