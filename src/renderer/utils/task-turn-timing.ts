import type { Task, TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

/** Run endings also fence activity lookups: the next user turn may arrive much later. */
export function isTaskTurnTerminalEvent(event: TaskEvent): boolean {
  const type = getEffectiveTaskEventType(event);
  if (
    type === "task_completed" ||
    type === "task_cancelled" ||
    type === "follow_up_completed" ||
    type === "follow_up_failed"
  ) {
    return true;
  }
  if (
    (type === "error" || type === "timeline_error") &&
    typeof event.payload?.terminal_failure_fingerprint === "string" &&
    event.payload.terminal_failure_fingerprint.length > 0
  )
    return true;
  return (
    type === "task_status" && ["completed", "failed", "cancelled"].includes(event.payload?.status)
  );
}

/** A follow-up waiting for its first event must not restart the previous block's clock. */
export function isActivityBlockInLatestTurn(
  blockEvents: TaskEvent[],
  allEvents: TaskEvent[],
): boolean {
  if (blockEvents.length === 0 || blockEvents.some(isTaskTurnTerminalEvent)) return false;
  const latestUserAt = allEvents.reduce(
    (latest, event) =>
      event.taskId === blockEvents[0].taskId && getEffectiveTaskEventType(event) === "user_message"
        ? Math.max(latest, event.timestamp)
        : latest,
    0,
  );
  return blockEvents.some((event) => event.timestamp >= latestUserAt);
}

function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface InitialTaskTurnTiming {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  isWorking: boolean;
  isFinished: boolean;
}

/** Timing for the header beneath the original prompt, independent of later follow-ups. */
export function resolveInitialTaskTurnTiming({
  task,
  events,
  isTaskWorking,
  hasMoreHistory = false,
}: {
  task?: Pick<
    Task,
    "id" | "createdAt" | "completedAt" | "updatedAt" | "lastRunDurationMs" | "status"
  > | null;
  events: TaskEvent[];
  isTaskWorking: boolean;
  hasMoreHistory?: boolean;
}): InitialTaskTurnTiming {
  const unknown: InitialTaskTurnTiming = {
    startedAt: task?.createdAt ?? 0,
    isWorking: false,
    isFinished: false,
  };
  if (!task) return unknown;
  const taskEvents = events.filter((event) => event.taskId === task.id);
  // A paginated tail cannot establish the original turn's end. Avoid presenting the
  // most recent run's duration next to the original prompt until its history is loaded.
  if (
    hasMoreHistory &&
    !taskEvents.some((event) => getEffectiveTaskEventType(event) === "task_created")
  ) {
    return unknown;
  }
  const terminal = taskEvents.reduce<TaskEvent | undefined>((earliest, event) => {
    if (!isTaskTurnTerminalEvent(event)) return earliest;
    return !earliest || event.timestamp < earliest.timestamp ? event : earliest;
  }, undefined);
  // A retained follow-up ending cannot stand in for a missing original ending.
  if (
    taskEvents.some(
      (event) =>
        getEffectiveTaskEventType(event) === "task_resumed" &&
        event.payload?.newRunStarted === true &&
        (!terminal || event.timestamp <= terminal.timestamp),
    )
  ) {
    return unknown;
  }
  const firstUser = taskEvents.find(
    (event) =>
      getEffectiveTaskEventType(event) === "user_message" &&
      (!terminal || event.timestamp <= terminal.timestamp),
  );
  const startedAt = firstUser?.timestamp ?? task.createdAt;
  if (terminal) {
    return {
      startedAt,
      completedAt: terminal.timestamp,
      durationMs: readDuration(terminal.payload?.lastRunDurationMs),
      isWorking: false,
      isFinished: true,
    };
  }
  const isFinished = ["completed", "failed", "cancelled"].includes(task.status);
  return {
    startedAt,
    completedAt: isFinished ? (task.completedAt ?? task.updatedAt) : undefined,
    durationMs: isFinished ? readDuration(task.lastRunDurationMs) : undefined,
    isWorking: isTaskWorking && !isFinished,
    isFinished,
  };
}
