import type { Task, TaskEvent, Workspace } from "../../shared/types";
import { isTerminalTaskStatus } from "../../shared/task-status";
import {
  TaskEventRepository,
  TaskRepository,
  TaskSessionMetadataRepository,
  type TaskSessionMetadata,
  WorkspaceRepository,
} from "../database/repositories";

type Any = Record<string, any>;

export interface TaskSessionSummary {
  id: string;
  title: string;
  count: number;
  latestStatus: Task["status"];
  createdAt: number;
  updatedAt: number;
  terminal: boolean;
  pinned: boolean;
  archivedAt?: number;
  sources: string[];
  workspaces: string[];
  cwdValues: string[];
  providers: string[];
  models: string[];
  endReasons: string[];
  toolCallCount: number;
  totalTokens: number;
  totalCost: number;
}

export interface SessionRetentionFilters {
  limit?: number;
  includeArchived?: boolean;
  all?: boolean;
  olderThanMs?: number;
  newerThanMs?: number;
  afterMs?: number;
  beforeMs?: number;
  title?: string;
  source?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  endReason?: string;
  minTokens?: number;
  maxTokens?: number;
  minCost?: number;
  maxCost?: number;
}

export interface SessionPruneResult {
  dryRun: boolean;
  deleted: boolean;
  sessions: TaskSessionSummary[];
  sessionCount: number;
  taskCount: number;
  skippedActive: number;
  skippedPinned: number;
  deletedTaskIds: string[];
}

export class SessionRetentionService {
  constructor(
    private readonly taskRepo: TaskRepository,
    private readonly eventRepo: TaskEventRepository,
    private readonly metadataRepo: TaskSessionMetadataRepository,
    private readonly workspaceRepo?: WorkspaceRepository,
  ) {}

  listSessions(filters: SessionRetentionFilters = {}): TaskSessionSummary[] {
    const limit = normalizeLimit(filters.limit, 1000);
    const tasks = this.taskRepo.findAll(Math.max(limit * 4, limit), 0, {
      includeArchivedSessions: true,
    });
    const summaries = this.buildSessionSummaries(tasks);
    return this.applyFilters(summaries, filters).slice(0, limit);
  }

  tasksForSession(sessionId: string, limit = 10000): Task[] {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return [];
    const lineage = this.taskRepo.findBySessionId(normalizedSessionId, limit);
    if (lineage.length > 0) return lineage;
    const single = this.taskRepo.findById(normalizedSessionId);
    return single ? [single] : [];
  }

  archiveSession(sessionId: string): { metadata: TaskSessionMetadata; taskCount: number } {
    const rows = this.tasksForSession(sessionId, 10000);
    if (rows.length === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return {
      metadata: this.metadataRepo.archive(sessionId),
      taskCount: rows.length,
    };
  }

  renameSession(sessionId: string, name: string): TaskSessionMetadata {
    const rows = this.tasksForSession(sessionId, 1);
    if (rows.length === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.metadataRepo.rename(sessionId, name);
  }

  async pruneSessions(
    filters: SessionRetentionFilters,
    options: {
      dryRun?: boolean;
      deleteTask?: (task: Task) => Promise<void> | void;
    } = {},
  ): Promise<SessionPruneResult> {
    const summaries = this.listSessions({
      ...filters,
      limit: filters.limit ?? 10000,
      includeArchived: filters.includeArchived,
    });
    const candidates = summaries.filter((session) => this.isPruneCandidate(session, filters));
    const taskCount = candidates.reduce((sum, session) => sum + session.count, 0);
    const result: SessionPruneResult = {
      dryRun: options.dryRun === true,
      deleted: false,
      sessions: candidates,
      sessionCount: candidates.length,
      taskCount,
      skippedActive: summaries.filter((session) => !session.terminal).length,
      skippedPinned: summaries.filter((session) => session.pinned).length,
      deletedTaskIds: [],
    };

    if (options.dryRun === true || candidates.length === 0) {
      return result;
    }

    for (const session of candidates) {
      const tasks = this.tasksForSession(session.id, 10000);
      for (const task of tasks) {
        await options.deleteTask?.(task);
        this.taskRepo.delete(task.id);
        result.deletedTaskIds.push(task.id);
      }
      this.metadataRepo.delete(session.id);
    }

    result.deleted = true;
    return result;
  }

  private buildSessionSummaries(tasks: Task[]): TaskSessionSummary[] {
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      const sessionId = getTaskSessionId(task);
      const existing = groups.get(sessionId) || [];
      existing.push(task);
      groups.set(sessionId, existing);
    }

    const metadata = this.metadataRepo.findBySessionIds([...groups.keys()]);
    const workspaces = this.workspaceRepo ? this.workspaceRepo.findAll() : [];
    const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const eventsByTaskId = groupEventsByTaskId(
      this.eventRepo.findByTaskIds(
        tasks.map((task) => task.id),
        ["llm_usage", "tool_call"],
      ),
    );

    return [...groups.entries()]
      .map(([id, rows]) => this.buildSessionSummary({
        id,
        rows,
        metadata: metadata.get(id),
        workspacesById,
        eventsByTaskId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private buildSessionSummary(params: {
    id: string;
    rows: Task[];
    metadata?: TaskSessionMetadata;
    workspacesById: Map<string, Workspace>;
    eventsByTaskId: Map<string, TaskEvent[]>;
  }): TaskSessionSummary {
    const sorted = [...params.rows].sort(
      (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
    );
    const latest = sorted[0];
    const stats = summarizeEvents(params.rows, params.eventsByTaskId);
    const sources = uniqueSorted(params.rows.map((task) => task.source || "manual"));
    const workspaces = uniqueSorted(params.rows.map((task) => task.workspaceId).filter(Boolean));
    const cwdValues = uniqueSorted(
      params.rows.flatMap((task) => {
        const values: string[] = [];
        const cliCwd = task.agentConfig?.cli?.cwd;
        if (typeof cliCwd === "string" && cliCwd.trim()) values.push(cliCwd.trim());
        if (task.worktreePath) values.push(task.worktreePath);
        const workspacePath = params.workspacesById.get(task.workspaceId)?.path;
        if (workspacePath) values.push(workspacePath);
        return values;
      }),
    );
    const endReasons = uniqueSorted(
      params.rows.flatMap((task) =>
        [
          task.status,
          task.terminalStatus,
          task.failureClass,
          task.verificationVerdict,
        ].flatMap((value) => (typeof value === "string" && value.length > 0 ? [value] : [])),
      ),
    );

    return {
      id: params.id,
      title: params.metadata?.name || latest?.title || "Untitled",
      count: params.rows.length,
      latestStatus: latest?.status || "pending",
      createdAt: Math.min(...params.rows.map((task) => task.createdAt || 0)),
      updatedAt: latest?.updatedAt || latest?.createdAt || 0,
      terminal: params.rows.every((task) => isTerminalTaskStatus(task.status)),
      pinned: params.rows.some((task) => task.pinned === true),
      archivedAt: params.metadata?.archivedAt,
      sources,
      workspaces,
      cwdValues,
      providers: stats.providers,
      models: stats.models,
      endReasons,
      toolCallCount: stats.toolCallCount,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
    };
  }

  private applyFilters(
    summaries: TaskSessionSummary[],
    filters: SessionRetentionFilters,
  ): TaskSessionSummary[] {
    return summaries.filter((session) => {
      if (filters.includeArchived !== true && session.archivedAt) return false;
      if (!matchesStringFilter(session.title, filters.title)) return false;
      if (!matchesSetFilter(session.sources, filters.source)) return false;
      if (!matchesSetFilter(session.cwdValues, filters.cwd)) return false;
      if (!matchesSetFilter(session.providers, filters.provider)) return false;
      if (!matchesSetFilter(session.models, filters.model)) return false;
      if (!matchesSetFilter(session.endReasons, filters.endReason)) return false;
      if (!matchesNumberMinMax(session.totalTokens, filters.minTokens, filters.maxTokens)) return false;
      if (!matchesNumberMinMax(session.totalCost, filters.minCost, filters.maxCost)) return false;
      if (!matchesTimeWindow(session.updatedAt, filters)) return false;
      return true;
    });
  }

  private isPruneCandidate(session: TaskSessionSummary, filters: SessionRetentionFilters): boolean {
    if (!session.terminal) return false;
    if (session.pinned) return false;
    if (filters.includeArchived !== true && session.archivedAt) return false;
    if (filters.all === true) return true;
    if (typeof filters.olderThanMs === "number" && Number.isFinite(filters.olderThanMs)) {
      return session.updatedAt < Date.now() - filters.olderThanMs;
    }
    return hasExplicitSelectionFilter(filters);
  }
}

export function getTaskSessionId(task: Pick<Task, "id" | "sessionId">): string {
  return task.sessionId || task.id;
}

function summarizeEvents(
  tasks: Task[],
  eventsByTaskId: Map<string, TaskEvent[]>,
): {
  providers: string[];
  models: string[];
  toolCallCount: number;
  totalTokens: number;
  totalCost: number;
} {
  const providers = new Set<string>();
  const models = new Set<string>();
  let toolCallCount = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const task of tasks) {
    for (const event of eventsByTaskId.get(task.id) || []) {
      const effectiveType = event.legacyType || event.type;
      if (effectiveType === "tool_call") {
        toolCallCount += 1;
        continue;
      }
      if (effectiveType !== "llm_usage") continue;
      const payload = normalizePayload(event.payload);
      const provider = stringValue(payload.providerType ?? payload.provider ?? payload.provider_type);
      if (provider) providers.add(provider);
      const model = stringValue(payload.modelKey ?? payload.modelId ?? payload.model ?? payload.model_key ?? payload.model_id);
      if (model) models.add(model);
      const usage = normalizePayload(payload.totalUsage ?? payload.usage ?? payload.totals ?? payload);
      const inputTokens = numberValue(usage.inputTokens ?? usage.input_tokens);
      const outputTokens = numberValue(usage.outputTokens ?? usage.output_tokens);
      const explicitTotal = numberValue(usage.totalTokens ?? usage.total_tokens);
      totalTokens += explicitTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0);
      totalCost += numberValue(payload.cost ?? payload.costUsd ?? payload.cost_usd ?? payload.totalCost ?? payload.total_cost) ?? 0;
    }
  }

  return {
    providers: [...providers].sort(),
    models: [...models].sort(),
    toolCallCount,
    totalTokens,
    totalCost,
  };
}

function groupEventsByTaskId(events: TaskEvent[]): Map<string, TaskEvent[]> {
  const out = new Map<string, TaskEvent[]>();
  for (const event of events) {
    const existing = out.get(event.taskId) || [];
    existing.push(event);
    out.set(event.taskId, existing);
  }
  return out;
}

function normalizePayload(payload: unknown): Any {
  if (!payload) return {};
  if (typeof payload === "object") return payload as Any;
  if (typeof payload !== "string") return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Any) : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function uniqueSorted(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)),
  ).sort();
}

function normalizeLimit(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(10000, Math.floor(number)));
}

function matchesStringFilter(value: string, filter: string | undefined): boolean {
  if (!filter) return true;
  return value.toLowerCase().includes(filter.toLowerCase());
}

function matchesSetFilter(values: string[], filter: string | undefined): boolean {
  if (!filter) return true;
  const normalized = filter.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(normalized));
}

function matchesNumberMinMax(value: number, min?: number, max?: number): boolean {
  if (typeof min === "number" && Number.isFinite(min) && value < min) return false;
  if (typeof max === "number" && Number.isFinite(max) && value > max) return false;
  return true;
}

function matchesTimeWindow(value: number, filters: SessionRetentionFilters): boolean {
  if (typeof filters.newerThanMs === "number" && Number.isFinite(filters.newerThanMs)) {
    if (value < Date.now() - filters.newerThanMs) return false;
  }
  if (typeof filters.afterMs === "number" && Number.isFinite(filters.afterMs)) {
    if (value < filters.afterMs) return false;
  }
  if (typeof filters.beforeMs === "number" && Number.isFinite(filters.beforeMs)) {
    if (value >= filters.beforeMs) return false;
  }
  return true;
}

function hasExplicitSelectionFilter(filters: SessionRetentionFilters): boolean {
  return Boolean(
    filters.newerThanMs ||
      filters.afterMs ||
      filters.beforeMs ||
      filters.title ||
      filters.source ||
      filters.cwd ||
      filters.provider ||
      filters.model ||
      filters.endReason ||
      typeof filters.minTokens === "number" ||
      typeof filters.maxTokens === "number" ||
      typeof filters.minCost === "number" ||
      typeof filters.maxCost === "number",
  );
}
