import type { EventType, TaskEvent } from "../../shared/types";

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
  "error",
  "verification_started",
  "verification_passed",
  "verification_failed",
  "retry_started",
  "approval_requested",
];

export const ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "error",
  "step_failed",
  "verification_failed",
  "task_completed",
  "artifact_created",
]);

// In non-verbose mode, hide most tool traffic but keep user-facing schedule confirmations visible.
export function isImportantTaskEvent(event: TaskEvent): boolean {
  if (IMPORTANT_EVENT_TYPES.includes(event.type)) return true;
  if (event.type !== "tool_result") return false;
  return String((event as Any)?.payload?.tool || "") === "schedule_task";
}
