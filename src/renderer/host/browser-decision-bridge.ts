import type { ElectronAPI } from "../../electron/preload";
import type {
  ApprovalRequest,
  InputRequest,
  InputRequestResponse,
  Task,
  TaskEvent,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import type { BrowserHostTransport } from "../../renderer-web/transport";

const PAGE_SIZE = 100;
const MAX_ROWS = 1_000;
const MAX_PAGES = 100;

type Rpc = <T = unknown>(
  method: string,
  params: unknown,
  options?: Parameters<BrowserHostTransport["request"]>[2],
) => Promise<T>;

export interface BrowserDecisionMutationScope {
  workspaceId: string;
  taskId: string;
  id: string;
  expectedVersion: number;
}

type Mutate = <T = unknown>(
  method: string,
  params: unknown,
  scope: BrowserDecisionMutationScope,
) => Promise<T>;

export interface BrowserDecisionBridgeOptions {
  rpc: Rpc;
  listWorkspaces: () => Promise<Workspace[]>;
  getTask: (taskId: string) => Promise<Task | null>;
  mutate: Mutate;
}

interface DecisionScope {
  workspaceId: string;
  taskId?: string;
}

interface PendingApproval extends ApprovalRequest {
  workspaceId: string;
  taskTitle: string;
  taskStatus: string;
  expectedVersion: number;
}

interface PendingInputRequest extends InputRequest {
  workspaceId: string;
  taskTitle: string;
  taskStatus: string;
  expectedVersion: number;
}

interface ListResponse<T> {
  hasMore: boolean;
  rows: T[];
}

interface InputRequestListOptions {
  limit?: number;
  offset?: number;
  taskId?: string;
  status?: InputRequest["status"];
}

type BrowserDecisionMethods = Pick<
  ElectronAPI,
  "respondToApproval" | "listInputRequests" | "respondToInputRequest"
>;

export interface BrowserDecisionBridge {
  methods: BrowserDecisionMethods;
  hydrateTaskEvent(event: TaskEvent): Promise<TaskEvent>;
  dispose(): void;
}

/** Bridges the shared desktop decision UI to the scoped browser host API. */
export function createBrowserDecisionBridge(
  options: BrowserDecisionBridgeOptions,
): BrowserDecisionBridge {
  const approvals = new Map<string, PendingApproval>();
  const inputRequests = new Map<string, PendingInputRequest>();
  const activeLists = new Map<string, Promise<Array<PendingApproval | PendingInputRequest>>>();
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw new Error("The browser decision bridge is no longer active.");
  };

  const listPending = async <T extends PendingApproval | PendingInputRequest>(
    kind: "approval" | "input_request",
    scope: DecisionScope,
  ): Promise<T[]> => {
    assertActive();
    const workspaces = await options.listWorkspaces();
    const workspace = workspaces.find(
      (item) => item.id === scope.workspaceId && !item.isTemp && !isTempWorkspaceId(item.id),
    );
    if (!workspace) return [];

    const cache = kind === "approval" ? approvals : inputRequests;
    const priorForScope = [...cache.values()].filter(
      (row) =>
        row.workspaceId === scope.workspaceId && (!scope.taskId || row.taskId === scope.taskId),
    );
    const collected: T[] = [];
    let offset = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore && pages < MAX_PAGES && collected.length < MAX_ROWS) {
      const limit = Math.min(PAGE_SIZE, MAX_ROWS - collected.length);
      const params = {
        workspaceId: workspace.id,
        ...(scope.taskId ? { taskId: scope.taskId } : {}),
        limit,
        offset,
      };
      const response = await options.rpc<Record<string, unknown>>(
        kind === "approval" ? "approval.list" : "input_request.list",
        params,
      );
      const parsed = parseListResponse<T>(
        response,
        kind === "approval" ? "approvals" : "inputRequests",
      );
      const rows = parsed.rows.filter(
        (row) => row.workspaceId === workspace.id && (!scope.taskId || row.taskId === scope.taskId),
      );
      collected.push(...rows.slice(0, MAX_ROWS - collected.length));
      hasMore = parsed.hasMore;
      offset += limit;
      pages += 1;
    }

    assertActive();
    for (const row of priorForScope) cache.delete(row.id);
    for (const row of collected) cache.set(row.id, row as never);
    return collected;
  };

  const listAcrossReadableWorkspaces = async <T extends PendingApproval | PendingInputRequest>(
    kind: "approval" | "input_request",
    taskId?: string,
  ): Promise<T[]> => {
    assertActive();
    const workspaces = (await options.listWorkspaces()).filter(
      (workspace) => Boolean(workspace.id) && !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    let task: Task | null = null;
    if (taskId) {
      task = await options.getTask(taskId);
      if (!task) return [];
      if (!workspaces.some((workspace) => workspace.id === task!.workspaceId)) return [];
      const scoped = await listPending<T>(kind, {
        workspaceId: task.workspaceId,
        taskId: task.id,
      });
      return scoped;
    }

    const cache = kind === "approval" ? approvals : inputRequests;
    const collected: T[] = [];
    let pages = 0;
    for (const workspace of workspaces) {
      let offset = 0;
      let hasMore = true;
      while (hasMore && pages < MAX_PAGES && collected.length < MAX_ROWS) {
        const limit = Math.min(PAGE_SIZE, MAX_ROWS - collected.length);
        const response = await options.rpc<Record<string, unknown>>(
          kind === "approval" ? "approval.list" : "input_request.list",
          { workspaceId: workspace.id, limit, offset },
        );
        const parsed = parseListResponse<T>(
          response,
          kind === "approval" ? "approvals" : "inputRequests",
        );
        const rows = parsed.rows.filter((row) => row.workspaceId === workspace.id);
        collected.push(...rows.slice(0, MAX_ROWS - collected.length));
        hasMore = parsed.hasMore;
        offset += limit;
        pages += 1;
      }
      if (pages >= MAX_PAGES || collected.length >= MAX_ROWS) break;
    }

    assertActive();
    cache.clear();
    for (const row of collected) cache.set(row.id, row as never);
    return collected;
  };

  const refreshKnownScope = async <T extends PendingApproval | PendingInputRequest>(
    kind: "approval" | "input_request",
    id: string,
  ): Promise<T | undefined> => {
    const cache = kind === "approval" ? approvals : inputRequests;
    const prior = cache.get(id);
    if (prior) {
      const rows = await listPending<T>(kind, {
        workspaceId: prior.workspaceId,
        taskId: prior.taskId,
      });
      return rows.find((row) => row.id === id);
    }
    const rows = await listAcrossReadableWorkspaces<T>(kind);
    return rows.find((row) => row.id === id);
  };

  const hydrateTaskEvent = async (event: TaskEvent): Promise<TaskEvent> => {
    assertActive();
    if (event.type !== "approval_requested" && event.type !== "input_request_created") {
      return event;
    }
    const kind = event.type === "approval_requested" ? "approval" : "input_request";
    const key = `${kind}:${event.taskId}`;
    let pending: Promise<Array<PendingApproval | PendingInputRequest>>;
    const inFlight = activeLists.get(key);
    if (inFlight) {
      pending = inFlight;
    } else {
      pending = (async () => {
        const task = await options.getTask(event.taskId);
        if (!task) return [];
        const workspaces = await options.listWorkspaces();
        if (
          !workspaces.some(
            (workspace) =>
              workspace.id === task.workspaceId &&
              !workspace.isTemp &&
              !isTempWorkspaceId(workspace.id),
          )
        ) {
          return [];
        }
        return listPending(kind, { workspaceId: task.workspaceId, taskId: task.id });
      })();
      activeLists.set(key, pending);
    }

    let rows: PendingApproval[] | PendingInputRequest[];
    try {
      rows = (await pending) as PendingApproval[] | PendingInputRequest[];
    } catch {
      // A failed refresh cannot establish that a decision is still pending.
      rows = [];
    } finally {
      if (activeLists.get(key) === pending) activeLists.delete(key);
    }

    const payload = isRecord(event.payload) ? event.payload : {};
    if (kind === "approval") {
      const historical = isRecord(payload.approval) ? payload.approval : undefined;
      const id = firstString(payload.approvalId, historical?.id);
      const actual = rows.find((row) => row.id === id) as PendingApproval | undefined;
      if (actual) {
        return { ...event, payload: { ...payload, approval: actual } };
      }
      return {
        ...event,
        payload: withoutStalePendingPayload(payload, "approval", historical, id),
      };
    }

    const historical = isRecord(payload.request) ? payload.request : undefined;
    const id = firstString(payload.requestId, payload.inputRequestId, historical?.id);
    const actual = rows.find((row) => row.id === id) as PendingInputRequest | undefined;
    if (actual) {
      return { ...event, payload: { ...payload, request: actual } };
    }
    return {
      ...event,
      payload: withoutStalePendingPayload(payload, "request", historical, id),
    };
  };

  const respondToApproval: ElectronAPI["respondToApproval"] = async (response) => {
    assertActive();
    if (!response || typeof response.approvalId !== "string" || !response.approvalId.trim()) {
      throw new Error("A valid approval ID is required.");
    }
    const action = response.action;
    if (action !== undefined && action !== "allow_once" && action !== "deny_once") {
      throw new UnsupportedBrowserDecisionActionError(action);
    }
    const approved =
      response.approved ??
      (action === "allow_once" ? true : action === "deny_once" ? false : undefined);
    if (typeof approved !== "boolean") {
      throw new Error("Choose approve or deny for this request.");
    }
    if ((action === "allow_once" && !approved) || (action === "deny_once" && approved)) {
      throw new Error("The approval action does not match the selected decision.");
    }

    const approval = await refreshKnownScope<PendingApproval>("approval", response.approvalId);
    if (!approval) throw new StaleBrowserDecisionError("approval");
    const params = {
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      taskId: approval.taskId,
      expectedVersion: approval.expectedVersion,
      approved,
    };
    const result = await options.mutate<{ status?: string }>("approval.respond", params, {
      workspaceId: approval.workspaceId,
      taskId: approval.taskId,
      id: approval.id,
      expectedVersion: approval.expectedVersion,
    });
    if (result?.status !== "handled" && result?.status !== "duplicate") {
      throw new Error("The host did not confirm the approval decision.");
    }
    approvals.delete(approval.id);
  };

  const listInputRequests: ElectronAPI["listInputRequests"] = async (
    rawOptions?: InputRequestListOptions,
  ) => {
    assertActive();
    const query = rawOptions ?? {};
    if (query.status && query.status !== "pending") {
      throw new UnsupportedBrowserDecisionActionError(
        `listing ${query.status} input requests`,
        "pending input requests",
      );
    }
    const limit = normalizeInteger(query.limit, 200, 1, MAX_ROWS);
    const offset = normalizeInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = await listAcrossReadableWorkspaces<PendingInputRequest>(
      "input_request",
      query.taskId,
    );
    return rows
      .slice()
      .sort(comparePendingRows)
      .slice(offset, offset + limit)
      .map(toInputRequest);
  };

  const respondToInputRequest: ElectronAPI["respondToInputRequest"] = async (
    response: InputRequestResponse,
  ) => {
    assertActive();
    if (!response || typeof response.requestId !== "string" || !response.requestId.trim()) {
      throw new Error("A valid input request ID is required.");
    }
    if (response.status !== "submitted" && response.status !== "dismissed") {
      throw new Error("Choose submit or dismiss for this input request.");
    }
    const request = await refreshKnownScope<PendingInputRequest>(
      "input_request",
      response.requestId,
    );
    if (!request) throw new StaleBrowserDecisionError("input request");
    const params = {
      requestId: request.id,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      expectedVersion: request.expectedVersion,
      status: response.status,
      ...(response.status === "submitted" && response.answers ? { answers: response.answers } : {}),
    };
    const result = await options.mutate<{ status?: string; requestId?: string }>(
      "input_request.respond",
      params,
      {
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        id: request.id,
        expectedVersion: request.expectedVersion,
      },
    );
    if (result?.status === "in_progress") {
      return { status: "in_progress", requestId: request.id };
    }
    if (result?.status !== "handled" && result?.status !== "duplicate") {
      if (result?.status === "not_found") {
        inputRequests.delete(request.id);
        return { status: "not_found", requestId: request.id };
      }
      throw new Error("The host did not confirm the input response.");
    }
    inputRequests.delete(request.id);
    return { status: result.status, requestId: request.id };
  };

  return {
    methods: { respondToApproval, listInputRequests, respondToInputRequest },
    hydrateTaskEvent,
    dispose() {
      disposed = true;
      approvals.clear();
      inputRequests.clear();
      activeLists.clear();
    },
  };
}

export class UnsupportedBrowserDecisionActionError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY" as const;
  readonly retryable = false;

  constructor(action: string, supported = "one-time approve or deny decisions") {
    super(`The browser host supports ${supported}, but not ${action}.`);
    this.name = "UnsupportedBrowserDecisionActionError";
  }
}

class StaleBrowserDecisionError extends Error {
  readonly code = "STALE_STATE" as const;
  readonly retryable = false;

  constructor(kind: string) {
    super(`This ${kind} is no longer pending. Refresh the task to see its current state.`);
    this.name = "StaleBrowserDecisionError";
  }
}

function parseListResponse<T extends PendingApproval | PendingInputRequest>(
  value: unknown,
  key: "approvals" | "inputRequests",
): ListResponse<T> {
  if (!isRecord(value) || !Array.isArray(value[key]) || typeof value.hasMore !== "boolean") {
    throw new Error(`The browser host returned an invalid ${key} response.`);
  }
  const rows = value[key]
    .map((row) => (key === "approvals" ? parseApproval(row) : parseInputRequest(row)))
    .filter((row): row is T => row !== null);
  return { rows, hasMore: value.hasMore };
}

function parseApproval(value: unknown): PendingApproval | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    value.status !== "pending"
  ) {
    return null;
  }
  return {
    id: value.id,
    taskId: value.taskId,
    workspaceId: value.workspaceId,
    taskTitle: typeof value.taskTitle === "string" ? value.taskTitle : "",
    taskStatus: typeof value.taskStatus === "string" ? value.taskStatus : "",
    type:
      typeof value.type === "string"
        ? (value.type as ApprovalRequest["type"])
        : ("" as ApprovalRequest["type"]),
    description: typeof value.description === "string" ? value.description : "",
    details: value.details,
    status: "pending",
    requestedAt: typeof value.requestedAt === "number" ? value.requestedAt : value.expectedVersion,
    expectedVersion: value.expectedVersion,
  };
}

function parseInputRequest(value: unknown): PendingInputRequest | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.taskId !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    value.status !== "pending" ||
    !Array.isArray(value.questions)
  ) {
    return null;
  }
  const questions = value.questions.filter(isRecord).map((question) => ({
    header: typeof question.header === "string" ? question.header : "",
    id: typeof question.id === "string" ? question.id : "",
    question: typeof question.question === "string" ? question.question : "",
    options: Array.isArray(question.options)
      ? question.options.filter(isRecord).map((option) => ({
          label: typeof option.label === "string" ? option.label : "",
          description: typeof option.description === "string" ? option.description : "",
        }))
      : [],
  }));
  return {
    id: value.id,
    taskId: value.taskId,
    workspaceId: value.workspaceId,
    taskTitle: typeof value.taskTitle === "string" ? value.taskTitle : "",
    taskStatus: typeof value.taskStatus === "string" ? value.taskStatus : "",
    questions,
    status: "pending",
    requestedAt: typeof value.requestedAt === "number" ? value.requestedAt : value.expectedVersion,
    expectedVersion: value.expectedVersion,
  };
}

function toInputRequest(request: PendingInputRequest): InputRequest {
  return {
    id: request.id,
    taskId: request.taskId,
    questions: request.questions,
    status: "pending",
    requestedAt: request.requestedAt,
  };
}

function comparePendingRows(
  a: { requestedAt: number; id: string },
  b: { requestedAt: number; id: string },
): number {
  return a.requestedAt - b.requestedAt || a.id.localeCompare(b.id);
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) return fallback;
  return Math.min(maximum, value);
}

function withoutStalePendingPayload(
  payload: Record<string, unknown>,
  property: "approval" | "request",
  historical: Record<string, unknown> | undefined,
  id: string | undefined,
): Record<string, unknown> {
  const next = { ...payload };
  if (historical) {
    const { id: _id, ...preserved } = historical;
    next[property] = preserved;
  } else {
    delete next[property];
  }
  if (property === "approval" && id) next.approvalId = firstString(payload.approvalId, id);
  if (property === "request" && id) next.requestId = firstString(payload.requestId, id);
  return next;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
