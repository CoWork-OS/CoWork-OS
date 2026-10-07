import { createHash } from "crypto";
import type {
  ApprovalResponseAction,
  ApprovalResponseStatus,
  ApprovalRequest,
  InputRequest,
  InputRequestAnswer,
  InputRequestResponse,
  SessionActionAttribution,
  Task,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import {
  RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  type InlineApprovalDraftReview,
  type ResponsibilityActionReview,
} from "../../shared/approval-draft-presentation";
import {
  approvalRequestRevisionHash,
  approvalRevisionMatches,
} from "../../electron/agent/approval-revision";
import type { WebRequestContext, WebRpcMethod } from "../web/WebApplication";
import { WebApplicationError } from "../web/WebApplication";

const MAX_LIST_LIMIT = 100;
const MAX_OFFSET = 100_000;
const MAX_OPERATION_RECEIPTS = 10_000;
const OPERATION_RECEIPT_TTL_MS = 10 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_ID_RE = /^[a-z][a-z0-9_]*$/;
const SECRET_KEY_RE =
  /(token|api[_-]?key|secret|password|authorization|credential|cookie|private[_-]?key)/i;
const PROMPT_KEY_RE = /^(prompt|systemPrompt)$/i;

export interface BrowserApprovalCommands {
  respondToApproval(
    approvalId: string,
    approved: boolean,
    action: ApprovalResponseAction | undefined,
    attribution: SessionActionAttribution | undefined,
    expectedRevisionHash: string,
  ): Promise<ApprovalResponseStatus>;
  respondToInputRequest(
    response: InputRequestResponse,
  ): Promise<{ status: string; requestId: string }>;
}

export interface BrowserApprovalSources {
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  getTask(taskId: string): Promise<Task | null>;
  listPendingApprovals(): Promise<ApprovalRequest[]>;
  getApproval(approvalId: string): Promise<ApprovalRequest | null>;
  listPendingInputRequests(): Promise<InputRequest[]>;
  getInputRequest(requestId: string): Promise<InputRequest | null>;
  getInputRequestDraftReview?(
    requestId: string,
    taskId: string,
  ): Promise<InlineApprovalDraftReview | undefined>;
  commands: BrowserApprovalCommands;
}

type PublicApproval = {
  id: string;
  taskId: string;
  workspaceId: string;
  taskTitle: string;
  taskStatus: string;
  type: string;
  description: string;
  details: unknown;
  status: "pending";
  requestedAt: number;
  expectedVersion: number;
  revisionHash: string;
};

type PublicInputRequest = {
  id: string;
  taskId: string;
  workspaceId: string;
  taskTitle: string;
  taskStatus: string;
  questions: InputRequest["questions"];
  responsibilityActionReview?:
    | { required: true; state: "invalid" }
    | { required: true; state: "valid"; review: ResponsibilityActionReview };
  draftReview?: Pick<InlineApprovalDraftReview, "draft" | "previews">;
  status: "pending";
  requestedAt: number;
  expectedVersion: number;
};

interface ListScope {
  workspaceId: string;
  taskId?: string;
  limit: number;
  offset: number;
}

interface ApprovalResponseParams {
  approvalId: string;
  workspaceId: string;
  taskId: string;
  expectedVersion: number;
  expectedRevisionHash: string;
  approved: boolean;
}

interface InputResponseParams {
  requestId: string;
  workspaceId: string;
  taskId: string;
  expectedVersion: number;
  status: "submitted" | "dismissed";
  answers?: Record<string, InputRequestAnswer>;
}

interface OperationReceipt {
  fingerprint: string;
  expiresAt: number;
  promise?: Promise<unknown>;
  result?: unknown;
}

/** Browser access to pending human decisions, scoped to the host profile and workspace. */
export function createBrowserApprovalMethods(
  sources: BrowserApprovalSources,
): Record<string, WebRpcMethod> {
  const operationReceipts = new Map<string, OperationReceipt>();
  const resolutionTails = new Map<string, Promise<unknown>>();

  return {
    "approval.list": {
      capability: "tasks.approvals",
      validateParams: parseListScope,
      handler: async (_context, rawParams) => {
        const params = rawParams as ListScope;
        const pending = await sources.listPendingApprovals();
        const { taskById } = await resolveTaskScope(
          sources,
          params,
          pending.map((approval) => approval.taskId),
        );
        const scopedTaskIds = new Set(taskById.keys());
        const rows = pending
          .filter((approval) => approval.status === "pending" && scopedTaskIds.has(approval.taskId))
          .sort(comparePendingRows)
          .map((approval) => toPublicApproval(approval, taskById.get(approval.taskId)!));
        return pageRows(rows, params);
      },
    },
    "input_request.list": {
      capability: "tasks.inputRequests",
      validateParams: parseListScope,
      handler: async (_context, rawParams) => {
        const params = rawParams as ListScope;
        const pending = await sources.listPendingInputRequests();
        const { taskById } = await resolveTaskScope(
          sources,
          params,
          pending.map((request) => request.taskId),
        );
        const scopedTaskIds = new Set(taskById.keys());
        const rows = pending
          .filter((request) => request.status === "pending" && scopedTaskIds.has(request.taskId))
          .sort(comparePendingRows);
        const publicRows = await Promise.all(
          rows.map((request) =>
            toPublicInputRequest(request, taskById.get(request.taskId)!, sources),
          ),
        );
        return pageRows(publicRows, params, "inputRequests");
      },
    },
    "approval.get": {
      capability: "tasks.approvals",
      validateParams: parseApprovalLookup,
      handler: async (_context, rawParams) => {
        const params = rawParams as {
          approvalId: string;
          workspaceId: string;
          taskId: string;
          expectedVersion: number;
          expectedRevisionHash: string;
        };
        await assertTaskScope(sources, params.workspaceId, params.taskId);
        const approval = await sources.getApproval(params.approvalId);
        assertApprovalScope(
          approval,
          params.taskId,
          params.expectedVersion,
          params.expectedRevisionHash,
        );
        return { approval: publicApprovalOutcome(approval!) };
      },
    },
    "input_request.get": {
      capability: "tasks.inputRequests",
      validateParams: parseInputLookup,
      handler: async (_context, rawParams) => {
        const params = rawParams as {
          requestId: string;
          workspaceId: string;
          taskId: string;
          expectedVersion: number;
        };
        await assertTaskScope(sources, params.workspaceId, params.taskId);
        const request = await sources.getInputRequest(params.requestId);
        assertInputRequestScope(request, params.taskId, params.expectedVersion);
        return {
          inputRequest: {
            ...publicInputOutcome(request!),
            ...(await publicInputReviewFields(sources, request!)),
          },
        };
      },
    },
    "approval.respond": {
      capability: "tasks.approvals",
      mutation: true,
      validateParams: parseApprovalResponse,
      handler: async (context, rawParams) => {
        const params = rawParams as ApprovalResponseParams;
        // A receipt key must never turn a stale displayed review into a success.
        await assertTaskScope(sources, params.workspaceId, params.taskId);
        const current = await sources.getApproval(params.approvalId);
        assertApprovalScope(
          current,
          params.taskId,
          params.expectedVersion,
          params.expectedRevisionHash,
        );
        const desired = params.approved ? "approved" : "denied";
        if (current.status !== "pending" && current.status !== desired) throw staleDecision();
        const fingerprint = hashPayload({ method: "approval.respond", params });
        return executeOperation(context, fingerprint, operationReceipts, () =>
          serializeResolution(`approval:${params.approvalId}`, resolutionTails, () =>
            resolveApproval(sources, params),
          ),
        );
      },
    },
    "input_request.respond": {
      capability: "tasks.inputRequests",
      mutation: true,
      validateParams: parseInputResponse,
      handler: async (context, rawParams) => {
        const params = rawParams as InputResponseParams;
        const fingerprint = hashPayload({ method: "input_request.respond", params });
        return executeOperation(context, fingerprint, operationReceipts, () =>
          serializeResolution(`input:${params.requestId}`, resolutionTails, () =>
            resolveInputRequest(sources, params),
          ),
        );
      },
    },
  };
}

async function resolveApproval(
  sources: BrowserApprovalSources,
  params: ApprovalResponseParams,
): Promise<{
  status: "handled" | "duplicate";
  approvalId: string;
  decision: "approved" | "denied";
}> {
  await assertTaskScope(sources, params.workspaceId, params.taskId);
  const before = await sources.getApproval(params.approvalId);
  assertApprovalScope(before, params.taskId, params.expectedVersion, params.expectedRevisionHash);
  const desired = params.approved ? "approved" : "denied";
  if (before!.status !== "pending") {
    if (before!.status === desired)
      return { status: "duplicate", approvalId: params.approvalId, decision: desired };
    throw staleDecision();
  }

  let commandStatus = "unknown";
  try {
    commandStatus = await sources.commands.respondToApproval(
      params.approvalId,
      params.approved,
      undefined,
      undefined,
      params.expectedRevisionHash,
    );
  } catch {
    // Re-read the durable row below. An IPC/worker reply can be lost after commit.
  }
  const after = await sources.getApproval(params.approvalId);
  assertApprovalScope(after, params.taskId, params.expectedVersion, params.expectedRevisionHash);
  if (after!.status === desired) {
    return {
      status: commandStatus === "handled" ? "handled" : "duplicate",
      approvalId: params.approvalId,
      decision: desired,
    };
  }
  if (after!.status !== "pending") throw staleDecision();
  throw unknownOutcome(
    "Approval resolution is not confirmed. Read the approval state before retrying.",
  );
}

async function resolveInputRequest(
  sources: BrowserApprovalSources,
  params: InputResponseParams,
): Promise<{
  status: "handled" | "duplicate";
  requestId: string;
  decision: "submitted" | "dismissed";
}> {
  await assertTaskScope(sources, params.workspaceId, params.taskId);
  const before = await sources.getInputRequest(params.requestId);
  assertInputRequestScope(before, params.taskId, params.expectedVersion);
  if (params.status === "submitted") validateAnswerQuestions(params.answers, before!.questions);
  if (before!.status !== "pending") {
    if (before!.status === params.status) {
      return { status: "duplicate", requestId: params.requestId, decision: params.status };
    }
    throw staleDecision();
  }
  let commandStatus = "unknown";
  try {
    const response: InputRequestResponse = {
      requestId: params.requestId,
      status: params.status,
      ...(params.status === "submitted" && params.answers ? { answers: params.answers } : {}),
    };
    const result = await sources.commands.respondToInputRequest(response);
    commandStatus = result.status;
  } catch {
    // Re-read the durable row below. The result intentionally excludes answer values.
  }
  const after = await sources.getInputRequest(params.requestId);
  assertInputRequestScope(after, params.taskId, params.expectedVersion);
  if (after!.status === params.status) {
    return {
      status: commandStatus === "handled" ? "handled" : "duplicate",
      requestId: params.requestId,
      decision: params.status,
    };
  }
  if (after!.status !== "pending") throw staleDecision();
  throw unknownOutcome("Input response is not confirmed. Read the request state before retrying.");
}

async function resolveTaskScope(
  sources: BrowserApprovalSources,
  scope: ListScope,
  candidateTaskIds: string[],
): Promise<{ tasks: Task[]; taskById: Map<string, Task> }> {
  const workspace = await sources.getWorkspace(scope.workspaceId);
  if (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id)) throw invalidRequest();
  let tasks: Task[];
  if (scope.taskId) {
    const task = await sources.getTask(scope.taskId);
    if (!task || task.workspaceId !== scope.workspaceId) throw invalidRequest();
    tasks = [task];
  } else {
    const distinctTaskIds = [...new Set(candidateTaskIds)];
    tasks = (await Promise.all(distinctTaskIds.map((taskId) => sources.getTask(taskId)))).filter(
      (task): task is Task => task !== null,
    );
  }
  const taskById = new Map(
    tasks.filter((task) => task.workspaceId === scope.workspaceId).map((task) => [task.id, task]),
  );
  return { tasks: [...taskById.values()], taskById };
}

async function assertTaskScope(
  sources: BrowserApprovalSources,
  workspaceId: string,
  taskId: string,
): Promise<Task> {
  const workspace = await sources.getWorkspace(workspaceId);
  const task = await sources.getTask(taskId);
  if (
    !workspace ||
    workspace.isTemp ||
    isTempWorkspaceId(workspace.id) ||
    !task ||
    task.workspaceId !== workspaceId
  ) {
    throw invalidRequest();
  }
  return task;
}

function assertApprovalScope(
  approval: ApprovalRequest | null,
  taskId: string,
  expectedVersion: number,
  expectedRevisionHash: string,
): asserts approval is ApprovalRequest {
  if (!approval || approval.taskId !== taskId) throw invalidRequest();
  if (
    approval.requestedAt !== expectedVersion ||
    !approvalRevisionMatches(approval, expectedRevisionHash)
  )
    throw staleVersion();
}

function assertInputRequestScope(
  request: InputRequest | null,
  taskId: string,
  expectedVersion: number,
): asserts request is InputRequest {
  if (!request || request.taskId !== taskId) throw invalidRequest();
  if (request.requestedAt !== expectedVersion) throw staleVersion();
}

function toPublicApproval(approval: ApprovalRequest, task: Task): PublicApproval {
  const revisionHash = approvalRequestRevisionHash(approval);
  return {
    id: approval.id,
    taskId: approval.taskId,
    workspaceId: task.workspaceId,
    taskTitle: truncate(task.title, 300),
    taskStatus: task.status,
    type: String(approval.type),
    description: truncate(approval.description, 2000),
    details: sanitizeForBrowser(approval.details),
    status: "pending",
    requestedAt: approval.requestedAt,
    expectedVersion: approval.requestedAt,
    revisionHash,
  };
}

async function toPublicInputRequest(
  request: InputRequest,
  task: Task,
  sources: BrowserApprovalSources,
): Promise<PublicInputRequest> {
  const reviewFields = await publicInputReviewFields(sources, request);
  return {
    id: request.id,
    taskId: request.taskId,
    workspaceId: task.workspaceId,
    taskTitle: truncate(task.title, 300),
    taskStatus: task.status,
    questions: request.questions.map((question) => ({
      header: truncate(question.header, 32),
      id: question.id,
      question: truncate(question.question, 2000),
      options: question.options.map((option) => ({
        label: truncate(option.label, 200),
        description: truncate(option.description, 500),
      })),
    })),
    ...reviewFields,
    status: "pending",
    requestedAt: request.requestedAt,
    expectedVersion: request.requestedAt,
  };
}

async function publicInputReviewFields(
  sources: BrowserApprovalSources,
  request: InputRequest,
): Promise<
  Pick<PublicInputRequest, "responsibilityActionReview" | "draftReview">
> {
  const required = request.questions.some(
    (question) => question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
  );
  if (!sources.getInputRequestDraftReview) {
    return required
      ? { responsibilityActionReview: { required: true, state: "invalid" } }
      : {};
  }
  let loaded: InlineApprovalDraftReview | undefined;
  try {
    loaded = await sources.getInputRequestDraftReview(request.id, request.taskId);
  } catch {
    // A marked proposal must fail closed; it can never be reconstructed from prompt text.
  }
  const responsibilityActionReview = loaded?.responsibilityActionReview;
  if (!required && !responsibilityActionReview) return {};
  return {
    responsibilityActionReview:
      responsibilityActionReview ?? { required: true, state: "invalid" },
    ...(loaded ? { draftReview: { draft: loaded.draft, previews: loaded.previews } } : {}),
  };
}

function publicApprovalOutcome(approval: ApprovalRequest): Record<string, unknown> {
  return {
    id: approval.id,
    taskId: approval.taskId,
    status: approval.status,
    decision: approval.status === "pending" ? null : approval.status,
    requestedAt: approval.requestedAt,
    revisionHash: approvalRequestRevisionHash(approval),
    resolvedAt: approval.resolvedAt ?? null,
  };
}

function publicInputOutcome(request: InputRequest): Record<string, unknown> {
  return {
    id: request.id,
    taskId: request.taskId,
    status: request.status,
    decision: request.status === "pending" ? null : request.status,
    requestedAt: request.requestedAt,
    resolvedAt: request.resolvedAt ?? null,
  };
}

function pageRows<T>(
  rows: T[],
  scope: ListScope,
  key: "approvals" | "inputRequests" = "approvals",
): Record<string, unknown> {
  return {
    [key]: rows.slice(scope.offset, scope.offset + scope.limit),
    hasMore: rows.length > scope.offset + scope.limit,
    limit: scope.limit,
    offset: scope.offset,
    workspaceId: scope.workspaceId,
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
  };
}

function comparePendingRows(
  a: { requestedAt: number; id: string },
  b: { requestedAt: number; id: string },
): number {
  return a.requestedAt - b.requestedAt || a.id.localeCompare(b.id);
}

function parseListScope(value: unknown): ListScope {
  if (!isRecord(value)) throw invalidRequest();
  const workspaceId = parseIdentifier(value.workspaceId, 128);
  const taskId = value.taskId === undefined ? undefined : parseIdentifier(value.taskId, 128);
  const limit = value.limit === undefined ? 50 : value.limit;
  const offset = value.offset === undefined ? 0 : value.offset;
  if (
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > MAX_LIST_LIMIT ||
    !Number.isInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > MAX_OFFSET
  ) {
    throw invalidRequest();
  }
  return {
    workspaceId,
    ...(taskId ? { taskId } : {}),
    limit: Number(limit),
    offset: Number(offset),
  };
}

function parseApprovalLookup(value: unknown): {
  approvalId: string;
  workspaceId: string;
  taskId: string;
  expectedVersion: number;
  expectedRevisionHash: string;
} {
  if (!isRecord(value)) throw invalidRequest();
  return {
    approvalId: parseIdentifier(value.approvalId, 128),
    workspaceId: parseIdentifier(value.workspaceId, 128),
    taskId: parseIdentifier(value.taskId, 128),
    expectedVersion: parseVersion(value.expectedVersion),
    expectedRevisionHash: parseApprovalRevisionHash(value.expectedRevisionHash),
  };
}

function parseInputLookup(value: unknown): {
  requestId: string;
  workspaceId: string;
  taskId: string;
  expectedVersion: number;
} {
  if (!isRecord(value)) throw invalidRequest();
  const requestId = parseIdentifier(value.requestId, 128);
  if (!UUID_RE.test(requestId)) throw invalidRequest();
  return {
    requestId,
    workspaceId: parseIdentifier(value.workspaceId, 128),
    taskId: parseIdentifier(value.taskId, 128),
    expectedVersion: parseVersion(value.expectedVersion),
  };
}

function parseApprovalResponse(value: unknown): ApprovalResponseParams {
  if (!isRecord(value) || typeof value.approved !== "boolean") throw invalidRequest();
  return {
    approvalId: parseIdentifier(value.approvalId, 128),
    workspaceId: parseIdentifier(value.workspaceId, 128),
    taskId: parseIdentifier(value.taskId, 128),
    expectedVersion: parseVersion(value.expectedVersion),
    expectedRevisionHash: parseApprovalRevisionHash(value.expectedRevisionHash),
    approved: value.approved,
  };
}

function parseApprovalRevisionHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw invalidRequest();
  return value;
}

function parseInputResponse(value: unknown): InputResponseParams {
  if (!isRecord(value)) throw invalidRequest();
  const requestId = parseIdentifier(value.requestId, 128);
  const status = value.status;
  if (!UUID_RE.test(requestId) || (status !== "submitted" && status !== "dismissed")) {
    throw invalidRequest();
  }
  const answers = value.answers === undefined ? undefined : parseAnswers(value.answers);
  if (
    (status === "submitted" && answers === undefined) ||
    (status === "dismissed" && answers !== undefined)
  ) {
    throw invalidRequest();
  }
  return {
    requestId,
    workspaceId: parseIdentifier(value.workspaceId, 128),
    taskId: parseIdentifier(value.taskId, 128),
    expectedVersion: parseVersion(value.expectedVersion),
    status,
    ...(answers ? { answers } : {}),
  };
}

function parseAnswers(value: unknown): Record<string, InputRequestAnswer> {
  if (!isRecord(value) || Object.keys(value).length > 10) throw invalidRequest();
  const answers: Record<string, InputRequestAnswer> = {};
  for (const [id, rawAnswer] of Object.entries(value)) {
    if (!INPUT_ID_RE.test(id) || !isRecord(rawAnswer)) throw invalidRequest();
    const keys = Object.keys(rawAnswer);
    if (keys.length !== 1 || (keys[0] !== "optionLabel" && keys[0] !== "otherText")) {
      throw invalidRequest();
    }
    const answer: InputRequestAnswer = {};
    if (keys[0] === "optionLabel") {
      if (typeof rawAnswer.optionLabel !== "string") throw invalidRequest();
      const optionLabel = rawAnswer.optionLabel.trim();
      if (optionLabel.length < 1 || optionLabel.length > 200) throw invalidRequest();
      answer.optionLabel = optionLabel;
    } else {
      if (typeof rawAnswer.otherText !== "string") throw invalidRequest();
      const otherText = rawAnswer.otherText.trim();
      if (otherText.length < 1 || otherText.length > 8_000) throw invalidRequest();
      answer.otherText = otherText;
    }
    answers[id] = answer;
  }
  return answers;
}

function validateAnswerQuestions(
  answers: Record<string, InputRequestAnswer> | undefined,
  questions: InputRequest["questions"],
): void {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  if (
    !answers ||
    questionById.size !== questions.length ||
    Object.keys(answers).length !== questions.length
  ) {
    throw invalidRequest();
  }
  for (const [id, answer] of Object.entries(answers ?? {})) {
    const question = questionById.get(id);
    if (!question) throw invalidRequest();
    if (
      answer.optionLabel !== undefined &&
      !question.options.some((option) => option.label === answer.optionLabel)
    ) {
      throw invalidRequest();
    }
  }
}

function parseIdentifier(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw invalidRequest();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalidRequest();
  return normalized;
}

function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalidRequest();
  return value;
}

async function executeOperation<T>(
  context: WebRequestContext,
  fingerprint: string,
  receipts: Map<string, OperationReceipt>,
  action: () => Promise<T>,
): Promise<T> {
  if (!context.operationKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(context.operationKey)) {
    throw invalidRequest();
  }
  pruneReceipts(receipts);
  const key = [
    context.identity.profileId,
    context.audience,
    context.sessionId,
    context.operationKey,
  ].join(":");
  const existing = receipts.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw staleDecision();
    if (existing.promise) return (await existing.promise) as T;
    return existing.result as T;
  }
  const receipt: OperationReceipt = {
    fingerprint,
    expiresAt: Date.now() + OPERATION_RECEIPT_TTL_MS,
  };
  const promise = action();
  receipt.promise = promise;
  receipts.set(key, receipt);
  try {
    const result = await promise;
    receipt.result = result;
    receipt.expiresAt = Date.now() + OPERATION_RECEIPT_TTL_MS;
    delete receipt.promise;
    pruneReceipts(receipts);
    return result;
  } catch (error) {
    if (receipts.get(key) === receipt) receipts.delete(key);
    throw error;
  }
}

async function serializeResolution<T>(
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

function pruneReceipts(receipts: Map<string, OperationReceipt>): void {
  const now = Date.now();
  for (const [key, receipt] of receipts) {
    if (!receipt.promise && receipt.expiresAt <= now) receipts.delete(key);
  }
  while (receipts.size > MAX_OPERATION_RECEIPTS) {
    const oldest = receipts.keys().next().value as string | undefined;
    if (!oldest) break;
    if (receipts.get(oldest)?.promise) break;
    receipts.delete(oldest);
  }
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sanitizeForBrowser(value: unknown, depth = 0, key?: string): unknown {
  if (depth > 3) return "[truncated]";
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return truncate(value, key === "message" ? 12_000 : 2_000);
  if (Array.isArray(value))
    return value.slice(0, 50).map((entry) => sanitizeForBrowser(entry, depth + 1));
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const property of Object.keys(value).slice(0, 50)) {
    if (SECRET_KEY_RE.test(property) || PROMPT_KEY_RE.test(property)) {
      result[property] = "[REDACTED]";
    } else {
      result[property] = sanitizeForBrowser(value[property], depth + 1, property);
    }
  }
  return result;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError(
    "INVALID_REQUEST",
    "Invalid browser approval or input request.",
    400,
  );
}

function staleVersion(): WebApplicationError {
  return new WebApplicationError(
    "STALE_STATE",
    "This pending request changed. Refresh and try again.",
    409,
  );
}

function staleDecision(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    "This request has already received a different decision.",
    409,
  );
}

function unknownOutcome(message: string): WebApplicationError {
  return new WebApplicationError("OUTCOME_UNKNOWN", message, 503, true);
}
