import type { TaskEvent } from "../../shared/types";
import type {
  TaskEventMutation,
  TaskEventMutationPageResult,
  TaskEventScopedMutationPageRequest,
  TaskEventScopedMutationPageResult,
  TaskEventScopedTimelineHistoryPageRequest,
  TaskEventScopedTimelineHistoryPageResult,
  TaskEventScopedTimelineSnapshotRequest,
  TaskEventScopedTimelineSnapshotResult,
} from "../../electron/database/repositories";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

const DEFAULT_SNAPSHOT_LIMIT = 160;
const MAX_SNAPSHOT_LIMIT = 600;
const DEFAULT_HISTORY_PAGE_LIMIT = 160;
const MAX_HISTORY_PAGE_LIMIT = 600;
const MAX_MUTATION_PAGE_LIMIT = 500;
const MAX_MUTATION_PAGE_RESPONSE_BYTES = 512 * 1024;
const MAX_SAFE_EVENT_BYTES = 24 * 1024;
const MAX_EVENT_STRING_CHARS = 8_000;
const MAX_EVENT_ARRAY_ITEMS = 30;
const MAX_EVENT_OBJECT_KEYS = 30;
const MAX_EVENT_DEPTH = 4;
const MAX_EVENT_NODES = 500;

const SECRET_KEY_RE =
  /(token|api[_-]?key|secret|password|authorization|credential|private[_-]?key|cookie)/i;
const PRIVATE_CONTENT_KEY_RE =
  /^(prompt|systemPrompt|input|inputs|questions|answers|request|details|args|parameters|command|output|stdout|stderr|result|response|environment|env|headers|path|filePath|cwd|url)$/i;

export interface BrowserTaskEventSources {
  findScopedTimelineSnapshot: (
    request: TaskEventScopedTimelineSnapshotRequest,
  ) => Promise<TaskEventScopedTimelineSnapshotResult>;
  findScopedTimelineHistoryPage: (
    request: TaskEventScopedTimelineHistoryPageRequest,
  ) => Promise<TaskEventScopedTimelineHistoryPageResult>;
  findScopedMutationPage: (
    request: TaskEventScopedMutationPageRequest,
  ) => Promise<TaskEventScopedMutationPageResult>;
}

interface SnapshotRequest {
  taskId: string;
  workspaceId: string;
  limit: number;
}

interface MutationPageRequest {
  taskId: string;
  workspaceId: string;
  afterCursor: TaskEventScopedMutationPageRequest["afterCursor"];
  limit?: number;
}

interface HistoryPageRequest {
  taskId: string;
  workspaceId: string;
  beforeCursor: TaskEventScopedTimelineHistoryPageRequest["beforeCursor"];
  limit: number;
}

/** Task timeline reads are bound to one profile-backed workspace and one task. */
export function createBrowserTaskEventMethods(
  sources: BrowserTaskEventSources,
): Record<string, WebRpcMethod> {
  return {
    "task.events.snapshot": {
      capability: "tasks.events",
      validateParams: parseSnapshotRequest,
      handler: async (context, params) => {
        const request = params as SnapshotRequest;
        requireSessionScope(context);
        const snapshot = await sources.findScopedTimelineSnapshot(request);
        if (snapshot.outcome !== "available") throw unavailable();
        return {
          taskId: request.taskId,
          workspaceId: request.workspaceId,
          events: snapshot.page.events.map(toBrowserSafeTaskEvent),
          cursor: snapshot.cursor,
          hasMoreHistory: snapshot.page.hasMoreHistory,
          nextHistoryCursor: snapshot.page.nextCursor,
        };
      },
    },
    "task.events.page": {
      capability: "tasks.events",
      validateParams: parseMutationPageRequest,
      handler: async (context, params) => {
        const request = params as MutationPageRequest;
        requireSessionScope(context);
        const result = await sources.findScopedMutationPage({
          ...request,
        });
        if (result.outcome !== "available") throw unavailable();
        const page = result.page;
        if (page.outcome !== "page" && page.outcome !== "page_with_more") return page;
        return toBrowserSafeMutationPage(page);
      },
    },
    "task.events.history": {
      capability: "tasks.events",
      validateParams: parseHistoryPageRequest,
      handler: async (context, params) => {
        const request = params as HistoryPageRequest;
        requireSessionScope(context);
        const result = await sources.findScopedTimelineHistoryPage(request);
        if (result.outcome !== "available") throw unavailable();
        return {
          events: result.page.events.map(toBrowserSafeTaskEvent),
          hasMoreHistory: result.page.hasMoreHistory,
          nextHistoryCursor: result.page.nextCursor,
        };
      },
    },
  };
}

function parseSnapshotRequest(value: unknown): SnapshotRequest {
  if (!isRecord(value)) throw invalidRequest();
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const limit = value.limit === undefined ? DEFAULT_SNAPSHOT_LIMIT : value.limit;
  if (!isBoundedInteger(limit, 1, MAX_SNAPSHOT_LIMIT)) throw invalidRequest();
  return { taskId, workspaceId, limit };
}

function parseMutationPageRequest(value: unknown): MutationPageRequest {
  if (!isRecord(value)) throw invalidRequest();
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const cursor = isRecord(value.afterCursor) ? value.afterCursor : null;
  const cursorTaskId = cursor ? parseId(cursor.taskId) : "";
  if (
    !cursor ||
    cursorTaskId !== taskId ||
    !isBoundedInteger(cursor.position, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw invalidRequest();
  }
  const limit = value.limit;
  if (limit !== undefined && !isBoundedInteger(limit, 1, MAX_MUTATION_PAGE_LIMIT)) {
    throw invalidRequest();
  }
  return {
    taskId,
    workspaceId,
    afterCursor: { taskId, position: cursor.position },
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

function parseHistoryPageRequest(value: unknown): HistoryPageRequest {
  if (!isRecord(value)) throw invalidRequest();
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const cursor = isRecord(value.beforeCursor) ? value.beforeCursor : null;
  const id = cursor && typeof cursor.id === "string" ? cursor.id.trim() : "";
  const limit = value.limit === undefined ? DEFAULT_HISTORY_PAGE_LIMIT : value.limit;
  if (
    !cursor ||
    !isBoundedInteger(cursor.order, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(cursor.timestamp, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
    !id ||
    id.length > 1024 ||
    !isBoundedInteger(limit, 1, MAX_HISTORY_PAGE_LIMIT)
  ) {
    throw invalidRequest();
  }
  return {
    taskId,
    workspaceId,
    beforeCursor: { order: cursor.order, timestamp: cursor.timestamp, id },
    limit,
  };
}

function parseId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 128) throw invalidRequest();
  return id;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function requireSessionScope(context: WebRequestContext): void {
  if (!context.sessionId || !context.identity.profileId.trim()) throw unavailable();
}

function toBrowserSafeTaskEvent(event: TaskEvent): TaskEvent {
  const safeEvent: TaskEvent = {
    id: truncateString(event.id, 256),
    taskId: truncateString(event.taskId, 128),
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : 0,
    type: truncateString(event.type, 256) as TaskEvent["type"],
    schemaVersion: event.schemaVersion,
    payload: sanitizeEventPayload(event),
  };
  if (event.eventId !== undefined) safeEvent.eventId = truncateString(event.eventId, 256);
  if (event.seq !== undefined) safeEvent.seq = event.seq;
  if (event.ts !== undefined) safeEvent.ts = event.ts;
  if (event.status !== undefined)
    safeEvent.status = truncateString(event.status, 64) as TaskEvent["status"];
  if (event.stepId !== undefined) safeEvent.stepId = truncateString(event.stepId, 256);
  if (event.groupId !== undefined) safeEvent.groupId = truncateString(event.groupId, 256);
  if (event.actor !== undefined) safeEvent.actor = event.actor;
  if (event.legacyType !== undefined)
    safeEvent.legacyType = truncateString(event.legacyType, 256) as TaskEvent["legacyType"];
  // Inline media frames can contain binary image data; timeline replay does not need them.
  if (Buffer.byteLength(JSON.stringify(safeEvent), "utf8") > MAX_SAFE_EVENT_BYTES) {
    safeEvent.payload = { truncated: true };
  }
  return safeEvent;
}

function sanitizeEventPayload(event: TaskEvent): unknown {
  // This removes known sensitive fields; ordinary transcript text is not content-scanned.
  const payload = event.payload;
  if (/(credential|password|secret|api[_-]?key|private[_-]?key)/i.test(event.type)) return {};
  if (
    event.type === "approval_requested" ||
    event.type === "approval_granted" ||
    event.type === "approval_denied"
  ) {
    if (!isRecord(payload)) return {};
    const approval = isRecord(payload.approval) ? payload.approval : null;
    return {
      ...(approval
        ? { approval: pickScalarFields(approval, ["id", "status", "type", "requestedAt"]) }
        : {}),
      ...(typeof payload.approvalId === "string" ? { approvalId: payload.approvalId } : {}),
      ...(typeof payload.autoApproved === "boolean" ? { autoApproved: payload.autoApproved } : {}),
      ...(typeof payload.autoResolved === "boolean" ? { autoResolved: payload.autoResolved } : {}),
      ...(typeof payload.autoResolving === "boolean"
        ? { autoResolving: payload.autoResolving }
        : {}),
    };
  }

  if (
    event.type === "input_request_created" ||
    event.type === "input_request_resolved" ||
    event.type === "input_request_dismissed"
  ) {
    if (!isRecord(payload)) return {};
    const request = isRecord(payload.request) ? payload.request : null;
    return {
      ...(request ? { request: pickScalarFields(request, ["id", "status", "requestedAt"]) } : {}),
      ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
      ...(typeof payload.terminalTask === "boolean" ? { terminalTask: payload.terminalTask } : {}),
    };
  }

  const sanitized = sanitizeValue(payload, undefined, 0, { nodes: MAX_EVENT_NODES });
  return isRecord(sanitized) ? sanitized : {};
}

function toBrowserSafeMutationPage(
  page: Extract<TaskEventMutationPageResult, { outcome: "page" | "page_with_more" }>,
): TaskEventMutationPageResult {
  const changes: typeof page.changes = [];
  let truncated = false;
  for (const change of page.changes) {
    const safeChange =
      change.operation === "upsert"
        ? { ...change, event: toBrowserSafeTaskEvent(change.event) }
        : { ...change, eventId: truncateString(change.eventId, 256) };
    changes.push(safeChange);
    const candidate = { ...page, changes };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_MUTATION_PAGE_RESPONSE_BYTES) {
      changes.pop();
      if (changes.length === 0) changes.push(minimizeMutationChange(safeChange));
      truncated = true;
      break;
    }
  }

  if (!truncated) return { ...page, changes };
  const lastChange = changes[changes.length - 1]!;
  return {
    outcome: "page_with_more",
    taskId: page.taskId,
    changes,
    nextCursor: { taskId: page.taskId, position: lastChange.cursor },
    hasMore: true,
  };
}

function minimizeMutationChange(change: TaskEventMutation): TaskEventMutation {
  return change.operation === "upsert"
    ? { ...change, event: { ...change.event, payload: { truncated: true } } }
    : change;
}

function pickScalarFields(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, value]];
      }
      return [];
    }),
  );
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (
    key === "queuedAttachmentRefs" ||
    key === "browserInitialAttachmentMessageId" ||
    key === "initialAttachmentMessageId" ||
    key === "initialTaskMediaConsumed" ||
    key === "requestFingerprint" ||
    key === "providerDispatchStatus" ||
    key === "providerDispatchStartedAt" ||
    key === "providerDispatchCompletedAt"
  )
    return undefined;
  if (key && (SECRET_KEY_RE.test(key) || PRIVATE_CONTENT_KEY_RE.test(key))) return "[REDACTED]";
  budget.nodes -= 1;
  if (budget.nodes < 0) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return truncateString(value, MAX_EVENT_STRING_CHARS);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return `${value}n`;
  if (depth >= MAX_EVENT_DEPTH || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EVENT_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, undefined, depth + 1, budget));
  }

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_EVENT_OBJECT_KEYS)) {
    output[truncateString(entryKey, 128)] = sanitizeValue(entryValue, entryKey, depth + 1, budget);
  }
  return output;
}

function truncateString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid task event request.", 400);
}

function unavailable(): WebApplicationError {
  return new WebApplicationError("FORBIDDEN", "Task is unavailable in this workspace.", 404);
}
