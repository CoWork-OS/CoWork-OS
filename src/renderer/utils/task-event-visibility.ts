import type { EventType, TaskEvent, TaskStatus } from "../../shared/types";
import { getEffectiveTaskEventType, getTimelineErrorText } from "./task-event-compat";
import { hasAssistantMediaDirective } from "./assistant-media-directives";

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
  "no_progress_circuit_breaker",
  "step_contract_escalated",
  "approval_requested",
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

  const stage =
    typeof payload.stage === "string" ? payload.stage.trim().toUpperCase() : "";
  if (stage && SUMMARY_HIDDEN_STAGE_NAMES.has(stage)) {
    return true;
  }

  const groupIdRaw = getTimelineGroupId(event);
  const normalizedGroupId =
    typeof groupIdRaw === "string" ? groupIdRaw.trim().toLowerCase() : "";
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

// In non-verbose mode, hide most tool traffic but keep user-facing schedule confirmations visible.
export function isImportantTaskEvent(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
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
    typeof payload.id === "string" && payload.id.trim().length > 0
      ? payload.id.trim()
      : "";
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
    if (isStageBoundaryTimelineGroupEvent(event)) {
      return true;
    }
  }

  // timeline_step_finished events echo tool/step completion that is already
  // visible from tool_result or timeline_group_finished events.
  // Only keep task-level cancellation/failure notices.
  if (event.type === "timeline_step_finished") {
    const payload = asObject(event.payload);
    const legacyType =
      typeof payload.legacyType === "string" ? payload.legacyType : "";
    if (legacyType === "task_cancelled" || event.status === "failed") {
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
    return (
      /^\[planning\]/i.test(message) ||
      /^\[skill-routing\]/i.test(message)
    );
  }

  return false;
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
  for (const event of events) {
    if (isLowValueVerboseLifecycleEvent(event)) continue;
    if (getEffectiveTaskEventType(event) === "progress_update") continue;
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
  }
  return out;
}

export function shouldShowTaskEventInSummaryMode(
  event: TaskEvent,
  taskStatus?: TaskStatus,
): boolean {
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

export function shouldShowTaskEventInStepFeed(event: TaskEvent): boolean {
  if (isToolBatchTimelineGroupEvent(event)) return false;
  if (isToolBatchLaneEvent(event)) return false;

  if (isStageBoundaryTimelineGroupEvent(event)) {
    return isSubStageTimelineGroupEvent(event);
  }

  return true;
}
