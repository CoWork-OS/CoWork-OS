import { createHash } from "node:crypto";
import type { Task, TaskStatus, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { isTerminalTaskStatus } from "../../shared/task-status";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "queued",
  "planning",
  "executing",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface BrowserTaskCancellationResult {
  taskId: string;
  workspaceId: string;
  operationKey: string;
  /** Terminal status is an observed task state, not proof this request caused it. */
  outcome: "observed_terminal" | "pending";
  status: TaskStatus;
  updatedAt: number;
}

export type BrowserTaskCancellationReceiptResult = BrowserTaskCancellationResult;

export interface BrowserTaskCancellationReceipt {
  fingerprint: string;
  taskId: string;
  workspaceId: string;
  expectedStatus: TaskStatus;
  expectedUpdatedAt: number;
  state: "pending" | "completed";
  result?: BrowserTaskCancellationReceiptResult;
}

/** Durable idempotency storage supplied by the host; `reserve` must use a unique key. */
export interface BrowserTaskCancellationReceipts {
  reserve(
    scopedKey: string,
    fingerprint: string,
    taskId: string,
    workspaceId: string,
    expectedStatus: TaskStatus,
    expectedUpdatedAt: number,
  ): Promise<{ created: boolean; receipt: BrowserTaskCancellationReceipt }>;
  complete(scopedKey: string, result: BrowserTaskCancellationReceiptResult): Promise<void>;
  get(scopedKey: string): Promise<BrowserTaskCancellationReceipt | null>;
}

export interface BrowserTaskCancellationSources {
  /** Must resolve the current task row, not a cached browser projection. */
  getTask(taskId: string): Promise<Task | null>;
  /** Must return the workspace after applying the active profile's access rules. */
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  /** Existing host command; this adapter must not broaden its behavior. */
  cancelTask(taskId: string): Promise<void>;
  receipts: BrowserTaskCancellationReceipts;
}

interface CancelTaskRequest {
  taskId: string;
  workspaceId: string;
  expectedStatus: TaskStatus;
  expectedUpdatedAt: number;
}

interface TaskSnapshot {
  task: Task;
  workspace: Workspace;
}

/**
 * Browser task cancellation is deliberately narrow: the caller must present
 * the task version it saw, and host authority is checked again before dispatch.
 */
export function createBrowserTaskCancellationMethods(
  sources: BrowserTaskCancellationSources,
): Record<string, WebRpcMethod> {
  const taskTails = new Map<string, Promise<unknown>>();
  const operations = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  return {
    "task.cancel": {
      capability: "tasks.cancel",
      mutation: true,
      validateParams: parseCancelTaskRequest,
      handler: async (context, rawParams) => {
        const request = rawParams as CancelTaskRequest;
        const operationKey = requireOperationKey(context.operationKey);
        requireBrowserSessionScope(context);
        const scopedKey = getScopedOperationKey(context, operationKey);
        const fingerprint = hashPayload({ method: "task.cancel", params: request });
        const taskLockKey = JSON.stringify([context.identity.profileId, request.taskId]);
        const existing = operations.get(scopedKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw operationConflict();
          return existing.promise;
        }
        const promise = serializeByTask(taskLockKey, taskTails, () =>
          cancelScopedTask(sources, request, operationKey, scopedKey, fingerprint),
        );
        operations.set(scopedKey, { fingerprint, promise });
        try {
          return await promise;
        } finally {
          if (operations.get(scopedKey)?.promise === promise) operations.delete(scopedKey);
        }
      },
    },
  };
}

async function cancelScopedTask(
  sources: BrowserTaskCancellationSources,
  request: CancelTaskRequest,
  operationKey: string,
  scopedKey: string,
  fingerprint: string,
): Promise<BrowserTaskCancellationResult> {
  let snapshot = await requireTaskScope(sources, request);
  const prior = await sources.receipts.get(scopedKey);

  if (prior) {
    assertReceiptMatches(prior, request, fingerprint);
    if (prior.state === "completed") {
      return observedResult(operationKey, snapshot.task);
    }

    if (isTerminalTaskStatus(snapshot.task.status)) {
      const result = observedResult(operationKey, snapshot.task);
      await sources.receipts.complete(scopedKey, toReceiptResult(result));
      return result;
    }

    assertExpectedTaskState(snapshot.task, request);
    return dispatchCancellation(sources, request, operationKey, scopedKey);
  }

  assertExpectedTaskState(snapshot.task, request);
  const reservation = await sources.receipts.reserve(
    scopedKey,
    fingerprint,
    request.taskId,
    request.workspaceId,
    request.expectedStatus,
    request.expectedUpdatedAt,
  );
  assertReceiptMatches(reservation.receipt, request, fingerprint);
  if (reservation.receipt.state === "completed") {
    snapshot = await requireTaskScope(sources, request);
    return observedResult(operationKey, snapshot.task);
  }

  // The row may have changed between the first read and durable reservation.
  snapshot = await requireTaskScope(sources, request);
  if (isTerminalTaskStatus(snapshot.task.status)) {
    const result = observedResult(operationKey, snapshot.task);
    await sources.receipts.complete(scopedKey, toReceiptResult(result));
    return result;
  }
  assertExpectedTaskState(snapshot.task, request);
  return dispatchCancellation(sources, request, operationKey, scopedKey);
}

async function dispatchCancellation(
  sources: BrowserTaskCancellationSources,
  request: CancelTaskRequest,
  operationKey: string,
  scopedKey: string,
): Promise<BrowserTaskCancellationResult> {
  let commandError: unknown;
  try {
    await sources.cancelTask(request.taskId);
  } catch (error) {
    commandError = error;
  }

  const snapshot = await requireTaskScope(sources, request);
  const result = observedResult(operationKey, snapshot.task);
  if (result.outcome === "observed_terminal") {
    await sources.receipts.complete(scopedKey, toReceiptResult(result));
    return result;
  }
  if (commandError !== undefined) {
    throw new WebApplicationError(
      "OUTCOME_UNKNOWN",
      "Cancellation is not confirmed. Retry with the same operation key to reconcile the task state.",
      503,
      true,
    );
  }
  return result;
}

async function requireTaskScope(
  sources: BrowserTaskCancellationSources,
  request: Pick<CancelTaskRequest, "taskId" | "workspaceId">,
): Promise<TaskSnapshot> {
  const [task, workspace] = await Promise.all([
    sources.getTask(request.taskId),
    sources.getWorkspace(request.workspaceId),
  ]);
  if (
    !task ||
    task.id !== request.taskId ||
    !workspace ||
    workspace.id !== request.workspaceId ||
    workspace.isTemp ||
    isTempWorkspaceId(workspace.id) ||
    task.workspaceId !== workspace.id
  ) {
    throw invalidRequest();
  }
  return { task, workspace };
}

function assertExpectedTaskState(task: Task, request: CancelTaskRequest): void {
  if (task.status !== request.expectedStatus || task.updatedAt !== request.expectedUpdatedAt) {
    throw new WebApplicationError(
      "STALE_STATE",
      "This task changed. Refresh its current state before cancelling it.",
      409,
    );
  }
}

function assertReceiptMatches(
  receipt: BrowserTaskCancellationReceipt,
  request: CancelTaskRequest,
  fingerprint: string,
): void {
  if (
    receipt.fingerprint !== fingerprint ||
    receipt.taskId !== request.taskId ||
    receipt.workspaceId !== request.workspaceId ||
    receipt.expectedStatus !== request.expectedStatus ||
    receipt.expectedUpdatedAt !== request.expectedUpdatedAt
  ) {
    throw new WebApplicationError(
      "CONFLICT",
      "This operation key was already used for a different cancellation request.",
      409,
    );
  }
}

function observedResult(operationKey: string, task: Task): BrowserTaskCancellationResult {
  return {
    taskId: task.id,
    workspaceId: task.workspaceId,
    operationKey,
    outcome: isTerminalTaskStatus(task.status) ? "observed_terminal" : "pending",
    status: task.status,
    updatedAt: task.updatedAt,
  };
}

function toReceiptResult(
  result: BrowserTaskCancellationResult,
): BrowserTaskCancellationReceiptResult {
  return result;
}

function parseCancelTaskRequest(value: unknown): CancelTaskRequest {
  if (!isRecord(value)) throw invalidRequest();
  if (
    Object.keys(value).some(
      (key) => !["taskId", "workspaceId", "expectedStatus", "expectedUpdatedAt"].includes(key),
    )
  ) {
    throw invalidRequest();
  }
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  if (
    typeof value.expectedStatus !== "string" ||
    !TASK_STATUSES.has(value.expectedStatus as TaskStatus) ||
    !Number.isSafeInteger(value.expectedUpdatedAt) ||
    Number(value.expectedUpdatedAt) < 0
  ) {
    throw invalidRequest();
  }
  return {
    taskId,
    workspaceId,
    expectedStatus: value.expectedStatus as TaskStatus,
    expectedUpdatedAt: Number(value.expectedUpdatedAt),
  };
}

function parseId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 128) throw invalidRequest();
  return id;
}

function requireOperationKey(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_KEY_RE.test(value)) throw invalidRequest();
  return value;
}

function requireBrowserSessionScope(context: WebRequestContext): void {
  if (!context.audience.trim() || !context.sessionId.trim() || !context.identity.profileId.trim()) {
    throw invalidRequest();
  }
}

function getScopedOperationKey(context: WebRequestContext, operationKey: string): string {
  // Session cookies rotate across host generations; durable retries must still
  // reconcile after re-pairing, while the profile and listener remain stable.
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.identity.installationId,
        context.identity.profileId,
        context.audience,
        operationKey,
      ]),
    )
    .digest("hex");
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function serializeByTask<T>(
  key: string,
  tails: Map<string, Promise<unknown>>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  tails.set(key, current);
  try {
    return await current;
  } finally {
    if (tails.get(key) === current) tails.delete(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError(
    "INVALID_REQUEST",
    "Invalid browser task cancellation request.",
    400,
  );
}

function operationConflict(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    "This operation key was already used for a different cancellation request.",
    409,
  );
}
