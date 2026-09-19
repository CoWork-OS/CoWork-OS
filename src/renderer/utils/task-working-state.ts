import type { EventType, Task, TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

const ACTIVE_WORK_SIGNAL_WINDOW_MS = 30_000;

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
  "follow_up_failed",
]);

function isBotChatConversation(task: Task): boolean {
  return task.agentConfig?.botConversation === true;
}

/**
 * Bot conversations intentionally return their persistent task row to
 * `pending` after each turn so the next message can reuse it. A live event
 * stream can still miss the synthetic `follow_up_completed` marker during a
 * renderer refresh, while the assistant reply is already visible. Treat the
 * reply as the end of that chat turn when it follows the latest user message;
 * a newer user message or active signal keeps the composer working.
 */
function hasCompletedBotChatTurn(task: Task, events: TaskEvent[]): boolean {
  if (!isBotChatConversation(task)) return false;

  let latestUserTimestamp = -Infinity;
  let latestAssistantTimestamp = -Infinity;
  let latestActiveTimestamp = -Infinity;

  for (const event of events) {
    if (event.taskId !== task.id) continue;
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "user_message") {
      latestUserTimestamp = Math.max(latestUserTimestamp, event.timestamp);
    } else if (
      effectiveType === "assistant_message" &&
      event.payload?.internal !== true &&
      (typeof event.payload?.message === "string" || typeof event.payload?.content === "string")
    ) {
      latestAssistantTimestamp = Math.max(latestAssistantTimestamp, event.timestamp);
    } else if (isBotChatActiveWorkSignal(event, effectiveType)) {
      latestActiveTimestamp = Math.max(latestActiveTimestamp, event.timestamp);
    }
  }

  return (
    latestAssistantTimestamp > -Infinity &&
    latestAssistantTimestamp >= latestUserTimestamp &&
    latestAssistantTimestamp >= latestActiveTimestamp
  );
}

/**
 * Timeline wrappers are also used for bookkeeping events such as
 * `task_status`, `conversation_snapshot`, and `llm_usage`. Those events are
 * not evidence that a newer bot turn is running, even though the generic
 * working-state policy treats a timeline update as potentially active.
 */
function isBotChatActiveWorkSignal(event: TaskEvent, effectiveType: string): boolean {
  if (
    effectiveType === "user_message" ||
    effectiveType === "assistant_message" ||
    effectiveType === "conversation_snapshot" ||
    effectiveType === "task_status" ||
    effectiveType === "llm_usage" ||
    effectiveType === "log" ||
    TERMINAL_WORK_EVENT_TYPES.has(effectiveType as EventType | "task_paused" | "task_cancelled")
  ) {
    return false;
  }
  return isActiveWorkSignal(event, effectiveType);
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

  if (task.status === "pending" && task.branchFromTaskId) {
    return false;
  }

  if (
    (task.status === "pending" || task.status === "queued") &&
    hasCompletedBotChatTurn(task, events)
  ) {
    return false;
  }

  if (task.status === "executing" || task.status === "planning") {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const effectiveType = getEffectiveTaskEventType(event);
      if (
        TERMINAL_WORK_EVENT_TYPES.has(effectiveType as EventType | "task_paused" | "task_cancelled")
      ) {
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

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.taskId !== task.id) continue;
    const effectiveType = getEffectiveTaskEventType(event);

    if (
      TERMINAL_WORK_EVENT_TYPES.has(effectiveType as EventType | "task_paused" | "task_cancelled")
    ) {
      return false;
    }
    if (isActiveWorkSignal(event, effectiveType)) {
      return now - event.timestamp <= ACTIVE_WORK_SIGNAL_WINDOW_MS;
    }
  }

  return false;
}
