import { createHash } from "node:crypto";
import type {
  AgentMessageSendResult,
  PermissionMode,
  Task,
  TaskFollowUpInput,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import {
  resolveAccessProfileDefinitionWithStatus,
  type AccessProfileId,
} from "../../shared/access-profiles";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import type { InteractionModeSelection } from "../../shared/interaction-mode";
import type { WebRpcMethod } from "../web/WebApplication";
import { WebApplicationError } from "../web/WebApplication";

const MAX_MESSAGE_LENGTH = 64_000;
const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_OPERATION_RECEIPTS = 5_000;

export type BrowserFollowUpOptions = Pick<
  TaskFollowUpInput,
  "interactionMode" | "accessProfileId" | "permissionMode" | "shellAccess"
>;

export interface BrowserFollowUpCommands {
  sendFollowUp(
    taskId: string,
    message: string,
    messageId: string,
    options: BrowserFollowUpOptions,
  ): Promise<AgentMessageSendResult>;
  getFollowUpReceipt(taskId: string, messageId: string): Promise<AgentMessageSendResult | null>;
}

export interface BrowserFollowUpSources {
  getTask(taskId: string): Promise<Task | null>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  commands: BrowserFollowUpCommands;
}

interface FollowUpRequest {
  taskId: string;
  workspaceId: string;
  message: string;
  options: BrowserFollowUpOptions;
}

interface ReceiptRequest {
  taskId: string;
  workspaceId: string;
  operationKey: string;
}

interface InFlightOperation {
  fingerprint: string;
  promise: Promise<unknown>;
}

export type BrowserFollowUpState = "admitted" | "pending" | "unavailable";

/** Narrow text-only continuation access backed by the daemon's durable task event receipt. */
export function createBrowserFollowUpMethods(
  sources: BrowserFollowUpSources,
): Record<string, WebRpcMethod> {
  // Keep accepted identities for the lifetime of the host. This prevents a
  // completed browser key from being reused with a different mode/profile.
  // Durable task events remain the recovery source after a host restart.
  const operations = new Map<string, InFlightOperation>();

  return {
    "task.followUp": {
      capability: "tasks.followUp",
      mutation: true,
      validateParams: parseFollowUpRequest,
      handler: async (context, rawParams) => {
        const request = rawParams as FollowUpRequest;
        const task = await requireTaskScope(sources, request);
        const key = requireOperationKey(context.operationKey);
        const scopedKey = scopeKey(context.audience, context.sessionId, key);
        const messageId = stableMessageId(context.audience, key);
        const fingerprint = hashPayload({
          taskId: task.id,
          workspaceId: request.workspaceId,
          message: request.message,
          options: request.options,
        });

        const prior = operations.get(scopedKey);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw operationConflict();
          return prior.promise;
        }
        if (operations.size >= MAX_OPERATION_RECEIPTS) {
          throw new WebApplicationError(
            "RATE_LIMITED",
            "Pair a new browser session to continue.",
            429,
          );
        }

        const promise = admitFollowUp(
          sources,
          task.id,
          request.message,
          messageId,
          request.options,
        );
        operations.set(scopedKey, { fingerprint, promise });
        return promise;
      },
    },
    "task.followUp.receipt": {
      capability: "tasks.followUp",
      validateParams: parseReceiptRequest,
      handler: async (context, rawParams) => {
        const request = rawParams as ReceiptRequest;
        const task = await requireTaskScope(sources, request);
        const messageId = stableMessageId(context.audience, request.operationKey);
        const receipt = await sources.commands.getFollowUpReceipt(task.id, messageId);
        return toPublicReceipt(task.id, messageId, receipt);
      },
    },
  };
}

async function admitFollowUp(
  sources: BrowserFollowUpSources,
  taskId: string,
  message: string,
  messageId: string,
  options: BrowserFollowUpOptions,
): Promise<Record<string, unknown>> {
  try {
    await sources.commands.sendFollowUp(taskId, message, messageId, options);
  } catch (error) {
    if (isMessageIdConflict(error)) throw operationConflict();

    // A follow-up may have crossed its durable admission boundary before the
    // runtime reported an unrelated execution failure. Return only the receipt
    // if it exists; otherwise the caller can reconcile with the same key.
    const receipt = await sources.commands.getFollowUpReceipt(taskId, messageId).catch(() => null);
    if (receipt) return toPublicReceipt(taskId, messageId, receipt);
    throw new WebApplicationError(
      "OUTCOME_UNKNOWN",
      "The follow-up receipt is not available yet. Retry or look it up with the same operation key.",
      503,
      true,
    );
  }

  const receipt = await sources.commands.getFollowUpReceipt(taskId, messageId).catch(() => null);
  if (!receipt) {
    throw new WebApplicationError(
      "OUTCOME_UNKNOWN",
      "The follow-up was submitted, but its durable receipt is not available yet. Retry or look it up with the same operation key.",
      503,
      true,
    );
  }
  return toPublicReceipt(taskId, messageId, receipt);
}

async function requireTaskScope(
  sources: BrowserFollowUpSources,
  request: Pick<FollowUpRequest, "taskId" | "workspaceId">,
): Promise<Task> {
  const [task, workspace] = await Promise.all([
    sources.getTask(request.taskId),
    sources.getWorkspace(request.workspaceId),
  ]);
  if (
    !task ||
    !workspace ||
    workspace.isTemp ||
    isTempWorkspaceId(workspace.id) ||
    !workspace.permissions?.read ||
    !workspace.permissions.write ||
    task.workspaceId !== workspace.id
  ) {
    throw invalidRequest();
  }
  return task;
}

function parseFollowUpRequest(value: unknown): FollowUpRequest {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([
    "taskId",
    "workspaceId",
    "message",
    "interactionMode",
    "accessProfileId",
    "permissionMode",
    "shellAccess",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) throw invalidRequest();
  const options: BrowserFollowUpOptions = {};
  if (value.interactionMode !== undefined) {
    options.interactionMode = parseInteractionMode(value.interactionMode);
  }
  if (value.accessProfileId !== undefined) {
    options.accessProfileId = parseAccessProfileId(value.accessProfileId);
  }
  if (value.permissionMode !== undefined) {
    options.permissionMode = parsePermissionMode(value.permissionMode);
  }
  if (value.shellAccess !== undefined) {
    // Browser follow-ups can preserve a disabled shell boundary. Enabling the
    // legacy shell override is an authority increase, so it stays desktop-only.
    if (value.shellAccess !== false) throw invalidRequest();
    options.shellAccess = false;
  }
  return { taskId, workspaceId, message, options };
}

function parseReceiptRequest(value: unknown): ReceiptRequest {
  if (!isRecord(value)) throw invalidRequest();
  if (Object.keys(value).some((key) => !["taskId", "workspaceId", "operationKey"].includes(key))) {
    throw invalidRequest();
  }
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const operationKey = requireOperationKey(value.operationKey);
  return { taskId, workspaceId, operationKey };
}

function parseId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw invalidRequest();
  return id;
}

function parseInteractionMode(value: unknown): InteractionModeSelection {
  if (!isRecord(value)) throw invalidRequest();
  if (value.mode === "chat" && Object.keys(value).length === 1) return { mode: "chat" };
  if (
    value.mode === "smart" &&
    (value.executionOverride === undefined || isExecutionOverride(value.executionOverride)) &&
    Object.keys(value).every((key) => key === "mode" || key === "executionOverride")
  ) {
    return {
      mode: "smart",
      ...(value.executionOverride
        ? {
            executionOverride: value.executionOverride as
              | "execute"
              | "plan"
              | "analyze"
              | "debug"
              | "verified",
          }
        : {}),
    } as InteractionModeSelection;
  }
  throw invalidRequest();
}

function isExecutionOverride(
  value: unknown,
): value is NonNullable<Extract<InteractionModeSelection, { mode: "smart" }>["executionOverride"]> {
  return (
    value === "execute" ||
    value === "plan" ||
    value === "analyze" ||
    value === "debug" ||
    value === "verified"
  );
}

function parseAccessProfileId(value: unknown): AccessProfileId {
  const profileId = typeof value === "string" ? value.trim() : "";
  if (!profileId || profileId.length > 100 || /[\u0000-\u001f\u007f]/.test(profileId)) {
    throw invalidRequest();
  }
  const settings = PermissionSettingsManager.loadSettings();
  const resolution = resolveAccessProfileDefinitionWithStatus(
    profileId,
    settings.accessProfiles ?? [],
  );
  if (resolution.status !== "resolved") throw invalidRequest();
  return profileId as AccessProfileId;
}

function parsePermissionMode(value: unknown): PermissionMode {
  if (value === "default" || value === "plan" || value === "dangerous_only") return value;
  throw invalidRequest();
}

function requireOperationKey(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_KEY_RE.test(value)) throw invalidRequest();
  return value;
}

function scopeKey(audience: string, sessionId: string, operationKey: string): string {
  return `${audience}:${sessionId}:${operationKey}`;
}

function stableMessageId(audience: string, operationKey: string): string {
  const operationHash = createHash("sha256").update(operationKey).digest("hex");
  return `web:${audience}:${operationHash}`;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toPublicReceipt(
  taskId: string,
  messageId: string,
  receipt: AgentMessageSendResult | null,
): Record<string, unknown> {
  if (!receipt) return { taskId, messageId, found: false, state: "unavailable" };
  const deliveryStatus = receipt.deliveryStatus ?? "accepted";
  const state: BrowserFollowUpState =
    deliveryStatus === "queued" || deliveryStatus === "started"
      ? "pending"
      : deliveryStatus === "failed" || deliveryStatus === "quarantined"
        ? "unavailable"
        : "admitted";
  return {
    taskId,
    messageId,
    found: true,
    state,
    ...(state === "pending"
      ? { deliveryStatus: deliveryStatus === "started" ? "started" : "queued" }
      : state === "admitted"
        ? { deliveryStatus: "accepted" }
        : {}),
    ...(receipt.acceptedAt !== undefined ? { acceptedAt: receipt.acceptedAt } : {}),
    ...(receipt.queuedAt !== undefined ? { queuedAt: receipt.queuedAt } : {}),
    ...(receipt.startedAt !== undefined ? { startedAt: receipt.startedAt } : {}),
  };
}

function isMessageIdConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Message ID .+ was already used for different content/i.test(message);
}

function operationConflict(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    "This follow-up operation key was already used for a different request.",
    409,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid browser follow-up request.", 400);
}
