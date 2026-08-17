import type {
  Task,
  TaskEvent,
  TaskEventDetailRequest,
  TaskEventDetailResult,
  TaskTimelinePageRequest,
  TaskTimelinePageResult,
} from "../../shared/types";

type TaskRepoLike = {
  findById(taskId: string): Task | null | undefined;
  findByParent(taskId: string): Task[];
};

type TaskEventRepoLike = {
  findRecentByTaskId(taskId: string, maxEvents: number): TaskEvent[];
  findByTaskIds(taskIds: string[], types?: string[]): TaskEvent[];
};

type TaskTimelineEventRepoLike = TaskEventRepoLike & {
  findTimelinePage(request: TaskTimelinePageRequest): TaskTimelinePageResult;
  findEventDetailById(
    eventId: string,
    scope?: {
      taskId?: string;
      additionalTaskIds?: string[];
      additionalTaskEventTypes?: string[];
    },
  ): TaskEventDetailResult;
};

const COLLABORATIVE_CHILD_FILE_EVENT_TYPES: Array<TaskEvent["type"]> = [
  "file_created",
  "file_modified",
  "file_deleted",
  "artifact_created",
];
const COLLABORATIVE_CHILD_TIMELINE_EVENT_TYPES = [
  ...COLLABORATIVE_CHILD_FILE_EVENT_TYPES,
  "timeline_artifact_emitted",
] as const;

export function sanitizeTaskTimelinePageRequest(params: unknown): TaskTimelinePageRequest {
  const value = (params ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  if (!taskId) throw new Error("taskId is required");
  const cursorValue =
    value.cursor && typeof value.cursor === "object" && !Array.isArray(value.cursor)
      ? (value.cursor as Record<string, unknown>)
      : null;
  const cursor =
    cursorValue &&
    typeof cursorValue.order === "number" &&
    Number.isFinite(cursorValue.order) &&
    typeof cursorValue.timestamp === "number" &&
    Number.isFinite(cursorValue.timestamp)
      ? {
          order: Math.floor(cursorValue.order),
          timestamp: Math.floor(cursorValue.timestamp),
          ...(typeof cursorValue.id === "string" && cursorValue.id.trim()
            ? { id: cursorValue.id.trim() }
            : {}),
        }
      : null;
  const numeric = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.floor(candidate)
      : undefined;
  };
  return {
    taskId,
    cursor,
    limit: numeric("limit"),
    byteLimit: numeric("byteLimit"),
    singleEventByteLimit: numeric("singleEventByteLimit"),
  };
}

export function sanitizeTaskEventDetailRequest(params: unknown): TaskEventDetailRequest {
  const value = (params ?? {}) as Record<string, unknown>;
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  if (!taskId) throw new Error("taskId is required");
  if (!eventId) throw new Error("eventId is required");
  return { taskId, eventId };
}

export function buildTaskEventHistoryForTransport(params: {
  taskId: string;
  limit: number;
  taskRepo: TaskRepoLike;
  eventRepo: TaskEventRepoLike;
}): TaskEvent[] {
  const { taskId, limit, taskRepo, eventRepo } = params;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (!taskId || safeLimit <= 0) return [];

  const events = eventRepo.findRecentByTaskId(taskId, safeLimit);
  const task = taskRepo.findById(taskId);
  if (task?.agentConfig?.collaborativeMode || task?.agentConfig?.multiLlmMode) {
    const childTasks = taskRepo.findByParent(taskId);
    if (childTasks.length > 0) {
      const childFileEvents = eventRepo.findByTaskIds(
        childTasks.map((childTask) => childTask.id),
        COLLABORATIVE_CHILD_FILE_EVENT_TYPES,
      );
      events.push(...childFileEvents);
      events.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  return events.length > safeLimit ? events.slice(-safeLimit) : events;
}

export function serializeTaskEventForTransport(
  event: TaskEvent,
  sanitizeValue: (value: unknown) => unknown,
): TaskEvent {
  return {
    ...event,
    payload: sanitizeValue(event.payload) as Record<string, unknown>,
  };
}

export function buildTaskTimelinePageForTransport(params: {
  request: TaskTimelinePageRequest;
  taskRepo: TaskRepoLike;
  eventRepo: TaskTimelineEventRepoLike;
  sanitizeValue: (value: unknown) => unknown;
}): TaskTimelinePageResult {
  const { request, taskRepo, eventRepo, sanitizeValue } = params;
  const task = taskRepo.findById(request.taskId);
  const childTaskIds =
    task?.agentConfig?.collaborativeMode || task?.agentConfig?.multiLlmMode
      ? taskRepo.findByParent(request.taskId).map((child) => child.id)
      : [];
  const page = eventRepo.findTimelinePage({
    ...request,
    ...(childTaskIds.length > 0
      ? {
          additionalTaskIds: childTaskIds,
          additionalTaskEventTypes: [...COLLABORATIVE_CHILD_TIMELINE_EVENT_TYPES],
        }
      : {}),
  });
  return {
    ...page,
    events: page.events.map((event) => serializeTaskEventForTransport(event, sanitizeValue)),
  };
}

export function buildTaskEventDetailForTransport(params: {
  request: TaskEventDetailRequest;
  taskRepo: TaskRepoLike;
  eventRepo: TaskTimelineEventRepoLike;
  sanitizeValue: (value: unknown) => unknown;
}): TaskEventDetailResult {
  const { request, taskRepo, eventRepo, sanitizeValue } = params;
  const task = taskRepo.findById(request.taskId);
  const childTaskIds =
    task?.agentConfig?.collaborativeMode || task?.agentConfig?.multiLlmMode
      ? taskRepo.findByParent(request.taskId).map((child) => child.id)
      : [];
  const detail = eventRepo.findEventDetailById(request.eventId, {
    taskId: request.taskId,
    ...(childTaskIds.length > 0
      ? {
          additionalTaskIds: childTaskIds,
          additionalTaskEventTypes: [...COLLABORATIVE_CHILD_TIMELINE_EVENT_TYPES],
        }
      : {}),
  });
  return {
    ...detail,
    event: detail.event ? serializeTaskEventForTransport(detail.event, sanitizeValue) : null,
  };
}
