import type { EventType, TaskEvent, TaskStatus } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

export const IMPORTANT_EVENT_TYPES: EventType[] = [
  "task_created",
  "task_completed",
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
  }

  return true;
}
