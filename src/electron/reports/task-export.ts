import type {
  Task,
  TaskEvent,
  TaskExportItem,
  TaskExportJson,
  TaskExportQuery,
  TaskFileChanges,
  TaskUsageTotals,
  Workspace,
} from "../../shared/types";

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getFileEventPath(payload: Any): string | undefined {
  return (
    asTrimmedString(payload?.path) ||
    asTrimmedString(payload?.workspaceRelativePath) ||
    asTrimmedString(payload?.relativePath) ||
    asTrimmedString(payload?.filePath)
  );
}

export function extractFileChanges(events: TaskEvent[]): TaskFileChanges | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined;

  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();

  for (const event of events) {
    const path = getFileEventPath(event?.payload);
    if (!path) continue;

    if (event.type === "file_created") created.add(path);
    else if (event.type === "file_modified") modified.add(path);
    else if (event.type === "file_deleted") deleted.add(path);
  }

  if (created.size === 0 && modified.size === 0 && deleted.size === 0) return undefined;

  return {
    created: Array.from(created).sort(),
    modified: Array.from(modified).sort(),
    deleted: Array.from(deleted).sort(),
  };
}

export function extractLatestUsage(events: TaskEvent[]): TaskUsageTotals | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined;

  let latest: TaskUsageTotals | undefined;
  for (const event of events) {
    if (event.type !== "llm_usage") continue;

    const payload = event.payload ?? {};
    const totalsSource = payload?.totals ?? payload ?? {};

    const inputTokens = asNumber(totalsSource.inputTokens ?? totalsSource.input_tokens) ?? 0;
    const outputTokens = asNumber(totalsSource.outputTokens ?? totalsSource.output_tokens) ?? 0;
    const cost = asNumber(totalsSource.cost ?? totalsSource.totalCost ?? payload?.totalCost) ?? 0;

    const modelId = asTrimmedString(payload?.modelId);
    const modelKey = asTrimmedString(payload?.modelKey);
    const updatedAt = asNumber(payload?.updatedAt ?? event.timestamp);

    latest = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost,
      ...(modelId ? { modelId } : {}),
      ...(modelKey ? { modelKey } : {}),
      ...(typeof updatedAt === "number" ? { updatedAt } : {}),
    };
  }

  return latest;
}

export function indexEventsByTaskId(events: TaskEvent[]): Map<string, TaskEvent[]> {
  const map = new Map<string, TaskEvent[]>();
  for (const event of events) {
    if (!event?.taskId) continue;
    const existing = map.get(event.taskId);
    if (existing) {
      existing.push(event);
    } else {
      map.set(event.taskId, [event]);
    }
  }
  return map;
}

export function buildTaskExportItem(params: {
  task: Task;
  workspaceName?: string;
  events?: TaskEvent[];
  exportedAt: number;
}): TaskExportItem {
  const { task, workspaceName, exportedAt } = params;
  const events = params.events || [];

  const usage = extractLatestUsage(events);
  const files = extractFileChanges(events);
  const completedAt = task.completedAt;
  const durationMs =
    typeof completedAt === "number" ? completedAt - task.createdAt : exportedAt - task.createdAt;

  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    ...(task.pinned ? { pinned: task.pinned } : {}),
    workspaceId: task.workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.agentType ? { agentType: task.agentType } : {}),
    ...(typeof task.depth === "number" ? { depth: task.depth } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(typeof task.completedAt === "number" ? { completedAt: task.completedAt } : {}),
    durationMs,
    ...(usage ? { usage } : {}),
    ...(files ? { files } : {}),
    ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

export function buildTaskExportJson(params: {
  query: TaskExportQuery;
  tasks: Task[];
  workspaces: Workspace[];
  events: TaskEvent[];
  exportedAt?: number;
}): TaskExportJson {
  const exportedAt = typeof params.exportedAt === "number" ? params.exportedAt : Date.now();
  const workspacesById = new Map(params.workspaces.map((ws) => [ws.id, ws]));
  const eventsByTaskId = indexEventsByTaskId(params.events);

  const items = params.tasks.map((task) => {
    const workspaceName = workspacesById.get(task.workspaceId)?.name;
    const events = eventsByTaskId.get(task.id) || [];
    return buildTaskExportItem({ task, workspaceName, events, exportedAt });
  });

  return {
    schemaVersion: 1,
    exportedAt,
    query: params.query,
    tasks: items,
  };
}
