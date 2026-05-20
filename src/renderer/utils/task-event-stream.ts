import type { Task, TaskEvent } from "../../shared/types";

function getNumericOrderValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getTaskEventIdentity(event: Partial<TaskEvent>): string {
  if (typeof event.eventId === "string" && event.eventId.trim().length > 0) {
    return `event:${event.eventId.trim()}`;
  }
  if (typeof event.id === "string" && event.id.trim().length > 0) {
    return `id:${event.id.trim()}`;
  }

  const taskId = typeof event.taskId === "string" ? event.taskId : "unknown-task";
  const type = typeof event.type === "string" ? event.type : "unknown-type";
  const seq = getNumericOrderValue(event.seq) ?? -1;
  const timestamp = getNumericOrderValue(event.timestamp) ?? -1;
  const stepId = typeof event.stepId === "string" ? event.stepId : "";
  const groupId = typeof event.groupId === "string" ? event.groupId : "";
  return `fallback:${taskId}:${type}:${seq}:${timestamp}:${stepId}:${groupId}`;
}

export function compareTaskEventOrder(left: Partial<TaskEvent>, right: Partial<TaskEvent>): number {
  const leftSeq = getNumericOrderValue(left.seq);
  const rightSeq = getNumericOrderValue(right.seq);
  if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  const leftTimestamp = getNumericOrderValue(left.timestamp) ?? 0;
  const rightTimestamp = getNumericOrderValue(right.timestamp) ?? 0;
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return getTaskEventIdentity(left).localeCompare(getTaskEventIdentity(right));
}

export function mergeTaskEventsByIdentity(
  existing: TaskEvent[],
  incoming: TaskEvent[],
): TaskEvent[] {
  if (incoming.length === 0) return [...existing].sort(compareTaskEventOrder);
  if (existing.length === 0) return [...incoming].sort(compareTaskEventOrder);

  // Fast path: single-event insert (common for streaming updates)
  if (incoming.length === 1) {
    const incomingEvent = incoming[0];
    const incomingIdentity = getTaskEventIdentity(incomingEvent);
    const existingIndex = existing.findIndex(
      (event) => getTaskEventIdentity(event) === incomingIdentity,
    );

    if (existingIndex >= 0) {
      const next = [...existing];
      next[existingIndex] = incomingEvent;
      return next.sort(compareTaskEventOrder);
    }

    const lastEvent = existing[existing.length - 1];
    if (!lastEvent || compareTaskEventOrder(lastEvent, incomingEvent) <= 0) {
      return [...existing, incomingEvent];
    }
  }

  const merged = new Map<string, TaskEvent>();
  for (const event of existing) {
    merged.set(getTaskEventIdentity(event), event);
  }
  for (const event of incoming) {
    merged.set(getTaskEventIdentity(event), event);
  }

  return Array.from(merged.values()).sort(compareTaskEventOrder);
}

export function hydrateSelectedTaskEvents(
  selectedTaskId: string,
  existing: TaskEvent[],
  historical: TaskEvent[],
): TaskEvent[] {
  const currentTaskEvents = existing.filter((event) => event.taskId === selectedTaskId);
  return mergeTaskEventsByIdentity(currentTaskEvents, historical);
}

const CHILD_OUTPUT_EVENT_TYPES = new Set([
  "file_created",
  "file_modified",
  "file_deleted",
  "artifact_created",
]);

export function shouldIncludeTaskEventInSelectedSession(params: {
  selectedTaskId: string | null;
  event: TaskEvent;
  tasks: Task[];
}): boolean {
  const { selectedTaskId, event, tasks } = params;
  if (!selectedTaskId) return false;
  if (event.taskId === selectedTaskId) return true;
  if (!CHILD_OUTPUT_EVENT_TYPES.has(event.type)) return false;

  const childTask = tasks.find((task) => task.id === event.taskId);
  if (!childTask?.parentTaskId || childTask.parentTaskId !== selectedTaskId) return false;

  const parentTask = tasks.find((task) => task.id === selectedTaskId);
  return Boolean(
    parentTask?.agentConfig?.collaborativeMode || parentTask?.agentConfig?.multiLlmMode,
  );
}

export function shouldRefreshCanonicalEventsForTerminalUpdate(params: {
  selectedTaskId: string | null;
  event: TaskEvent;
  nextStatus?: Task["status"];
}): boolean {
  if (!params.selectedTaskId || params.event.taskId !== params.selectedTaskId) {
    return false;
  }

  return (
    params.nextStatus === "completed" ||
    params.nextStatus === "failed" ||
    params.nextStatus === "cancelled"
  );
}
