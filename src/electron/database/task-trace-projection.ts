import { trimmedText } from "./fts-query";
import type {
  ListTaskTraceRunsRequest,
  Task,
  TaskEvent,
  TaskTraceMetrics,
  TaskTraceRunSibling,
  TaskTraceRunSummary,
} from "../../shared/types";

type Any = any;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeText(value: unknown): string {
  return trimmedText(value).toLowerCase();
}

function getEffectiveEventType(event: TaskEvent): string {
  return typeof event.legacyType === "string" && event.legacyType.trim().length > 0
    ? event.legacyType
    : event.type;
}

export function getTaskTraceSessionId(task: Pick<Task, "id" | "sessionId">): string {
  return typeof task.sessionId === "string" && task.sessionId.trim().length > 0
    ? task.sessionId.trim()
    : task.id;
}

export function sortTaskTraceSiblingRuns(runs: TaskTraceRunSibling[]): TaskTraceRunSibling[] {
  return [...runs].sort((a, b) => {
    const aWindow =
      typeof a.continuationWindow === "number" && Number.isFinite(a.continuationWindow)
        ? a.continuationWindow
        : Number.MAX_SAFE_INTEGER;
    const bWindow =
      typeof b.continuationWindow === "number" && Number.isFinite(b.continuationWindow)
        ? b.continuationWindow
        : Number.MAX_SAFE_INTEGER;
    if (aWindow !== bWindow) return aWindow - bWindow;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.taskId.localeCompare(b.taskId);
  });
}

export function buildTaskTraceSiblingRuns(tasks: Task[]): TaskTraceRunSibling[] {
  return sortTaskTraceSiblingRuns(
    tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(typeof task.completedAt === "number" ? { completedAt: task.completedAt } : {}),
      ...(typeof task.continuationWindow === "number"
        ? { continuationWindow: task.continuationWindow }
        : {}),
      ...(typeof task.branchLabel === "string" && task.branchLabel.trim().length > 0
        ? { branchLabel: task.branchLabel.trim() }
        : {}),
    })),
  );
}

function matchesTaskTraceFilters(task: Task, filters: ListTaskTraceRunsRequest): boolean {
  const statusFilter =
    typeof filters.status === "string" && filters.status !== "all" ? filters.status : "";
  if (statusFilter && task.status !== statusFilter) {
    return false;
  }

  const query = normalizeText(filters.query);
  if (!query) return true;

  const searchHaystack = [
    task.id,
    getTaskTraceSessionId(task),
    task.title,
    task.prompt,
    task.branchLabel,
  ]
    .map(normalizeText)
    .join(" ");

  return searchHaystack.includes(query);
}

export function buildTaskTraceRunSummaries(
  tasks: Task[],
  filters: ListTaskTraceRunsRequest = {},
): TaskTraceRunSummary[] {
  const limit =
    typeof filters.limit === "number" && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(200, Math.floor(filters.limit)))
      : 50;

  const sessions = new Map<string, Task[]>();
  for (const task of tasks) {
    const sessionId = getTaskTraceSessionId(task);
    const group = sessions.get(sessionId) || [];
    group.push(task);
    sessions.set(sessionId, group);
  }

  const summaries: TaskTraceRunSummary[] = [];
  for (const [sessionId, sessionTasks] of sessions.entries()) {
    if (!sessionTasks.some((task) => matchesTaskTraceFilters(task, filters))) {
      continue;
    }

    const siblingRuns = buildTaskTraceSiblingRuns(sessionTasks);
    const latestTask = [...sessionTasks].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return b.id.localeCompare(a.id);
    })[0];
    if (!latestTask) continue;

    summaries.push({
      sessionId,
      taskId: latestTask.id,
      title: latestTask.title,
      workspaceId: latestTask.workspaceId,
      status: latestTask.status,
      createdAt: latestTask.createdAt,
      updatedAt: latestTask.updatedAt,
      ...(typeof latestTask.completedAt === "number"
        ? { completedAt: latestTask.completedAt }
        : {}),
      runCount: siblingRuns.length,
      ...(typeof latestTask.continuationWindow === "number"
        ? { continuationWindow: latestTask.continuationWindow }
        : {}),
      ...(typeof latestTask.branchLabel === "string" && latestTask.branchLabel.trim().length > 0
        ? { branchLabel: latestTask.branchLabel.trim() }
        : {}),
      siblingRuns,
    });
  }

  return summaries
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return a.sessionId.localeCompare(b.sessionId);
    })
    .slice(0, limit);
}

export function buildTaskTraceMetrics(
  task: Task,
  events: TaskEvent[],
  now = Date.now(),
): TaskTraceMetrics {
  let usageTotals: Record<string, unknown> | null = null;
  let toolCallCount = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const effectiveType = getEffectiveEventType(event);
    if (!usageTotals && effectiveType === "llm_usage") {
      const payload = asObject(event.payload);
      const totals = asObject(payload.totals);
      if (Object.keys(totals).length > 0) {
        usageTotals = totals;
      }
    }
    if (effectiveType === "tool_call") {
      toolCallCount += 1;
    }
  }

  const finishedAt =
    typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
      ? task.completedAt
      : now;

  return {
    startedAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(typeof task.completedAt === "number" ? { completedAt: task.completedAt } : {}),
    runtimeMs: Math.max(0, finishedAt - task.createdAt),
    inputTokens: toFiniteNumber((usageTotals as Any)?.inputTokens),
    outputTokens: toFiniteNumber((usageTotals as Any)?.outputTokens),
    cachedTokens: toFiniteNumber((usageTotals as Any)?.cachedTokens),
    toolCallCount,
    eventCount: events.length,
  };
}
