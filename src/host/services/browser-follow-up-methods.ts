import { createHash } from "node:crypto";
import type {
  AgentMessageSendResult,
  PermissionMode,
  TaskEvent,
  QuotedAssistantMessage,
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
import type { WebRequestContext, WebRpcMethod } from "../web/WebApplication";
import { WebApplicationError } from "../web/WebApplication";
import { sanitizeTaskMessageParams } from "../../electron/control-plane/sanitize";
import { sanitizeToolCallTextFromAssistant } from "../../shared/tool-call-text-sanitizer";
import type { BrowserCapturedTaskMedia, BrowserTaskMediaDescriptor } from "./browser-task-media";
import { parseBrowserTaskMediaDescriptors } from "./browser-task-media";
import { releaseBrowserTaskMedia } from "./browser-task-media";

const MAX_MESSAGE_LENGTH = 64_000;
const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_OPERATION_RECEIPTS = 5_000;

export type BrowserFollowUpOptions = Pick<
  TaskFollowUpInput,
  | "interactionMode"
  | "accessProfileId"
  | "permissionMode"
  | "shellAccess"
  | "expectedTurnId"
  | "quotedAssistantMessage"
  | "integrationMentions"
>;

export interface BrowserFollowUpCommands {
  sendFollowUp(
    taskId: string,
    message: string,
    messageId: string,
    options: BrowserFollowUpOptions,
    capturedAttachments?: BrowserCapturedTaskMedia[],
    requestFingerprint?: string,
  ): Promise<AgentMessageSendResult>;
  getFollowUpReceipt(taskId: string, messageId: string): Promise<AgentMessageSendResult | null>;
}

export interface BrowserFollowUpSources {
  getTask(taskId: string): Promise<Task | null>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  /** Reads only the requested task's persisted event; required for event-backed quotes. */
  getQuotedAssistantEvent?(taskId: string, eventId: string): Promise<TaskEvent | null>;
  /** Returns verified byte snapshots; raw browser paths never leave the authorized workspace. */
  prepareFollowUpMedia?(
    context: WebRequestContext,
    workspaceId: string,
    descriptors: BrowserTaskMediaDescriptor[],
  ): Promise<BrowserCapturedTaskMedia[]>;
  commands: BrowserFollowUpCommands;
}

interface FollowUpRequest {
  taskId: string;
  workspaceId: string;
  message: string;
  options: BrowserFollowUpOptions;
  images?: BrowserTaskMediaDescriptor[];
}

interface ReceiptRequest {
  taskId: string;
  workspaceId: string;
  operationKey: string;
}

interface InFlightOperation {
  requestFingerprint: string;
  fingerprint?: string;
  promise: Promise<unknown>;
}

export type BrowserFollowUpState = "admitted" | "pending" | "unavailable";

/** Scoped task continuation access backed by validated inputs and durable event receipts. */
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
        await validateQuoteSource(sources, task, request.options.quotedAssistantMessage);
        const key = requireOperationKey(context.operationKey);
        const scopedKey = scopeKey(context.audience, context.sessionId, key);
        const messageId = stableMessageId(context.audience, key);
        const requestFingerprint = hashPayload({
          taskId: task.id,
          workspaceId: request.workspaceId,
          message: request.message,
          options: request.options,
          images: request.images ?? [],
        });

        const prior = operations.get(scopedKey);
        if (prior) {
          if (prior.requestFingerprint !== requestFingerprint) throw operationConflict();
          // The descriptor fingerprint binds the caller's relative path and
          // declared metadata, but a file may have changed at that path while
          // this host instance remained alive. Re-read media before replaying
          // a cached receipt so the host-computed byte fingerprint remains the
          // idempotency boundary for same-key retries.
          if (request.images?.length) {
            const capturedAttachments = await resolveFollowUpMedia(sources, context, request);
            try {
              const fingerprint = createMediaRequestFingerprint(
                task.id,
                request.workspaceId,
                request.message,
                request.options,
                capturedAttachments,
              );
              const result = await prior.promise;
              if (prior.fingerprint !== fingerprint) throw operationConflict();
              return result;
            } finally {
              releaseBrowserTaskMedia(capturedAttachments);
            }
          }
          return prior.promise;
        }
        if (operations.size >= MAX_OPERATION_RECEIPTS) {
          throw new WebApplicationError(
            "RATE_LIMITED",
            "Pair a new browser session to continue.",
            429,
          );
        }

        const operation: InFlightOperation = { requestFingerprint, promise: Promise.resolve(null) };
        operation.promise = (async () => {
          let admissionStarted = false;
          let capturedAttachments: BrowserCapturedTaskMedia[] = [];
          try {
            capturedAttachments = await resolveFollowUpMedia(sources, context, request);
            const fingerprint = createMediaRequestFingerprint(
              task.id,
              request.workspaceId,
              request.message,
              request.options,
              capturedAttachments,
            );
            operation.fingerprint = fingerprint;
            admissionStarted = true;
            return await admitFollowUp(
              sources,
              task.id,
              request.message,
              messageId,
              request.options,
              capturedAttachments,
              fingerprint,
            );
          } catch (error) {
            // Failed media resolution happened before the native admission boundary.
            if (!admissionStarted && operations.get(scopedKey) === operation) {
              operations.delete(scopedKey);
            }
            // A stale optimistic turn is a confirmed rejection only after
            // admitFollowUp has checked that no durable receipt exists.
            if (
              admissionStarted &&
              error instanceof WebApplicationError &&
              error.code === "STALE_STATE" &&
              operations.get(scopedKey) === operation
            ) {
              operations.delete(scopedKey);
            }
            throw error;
          } finally {
            releaseBrowserTaskMedia(capturedAttachments);
          }
        })();
        operations.set(scopedKey, operation);
        return operation.promise;
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
  capturedAttachments: BrowserCapturedTaskMedia[],
  requestFingerprint: string,
): Promise<Record<string, unknown>> {
  try {
    await sources.commands.sendFollowUp(
      taskId,
      message,
      messageId,
      options,
      capturedAttachments.length > 0 ? capturedAttachments : undefined,
      requestFingerprint,
    );
  } catch (error) {
    if (isMessageIdConflict(error)) throw operationConflict();

    // A follow-up may have crossed its durable admission boundary before the
    // runtime reported an unrelated execution failure. Return only the receipt
    // if it exists; otherwise the caller can reconcile with the same key.
    const receipt = await sources.commands.getFollowUpReceipt(taskId, messageId).catch(() => null);
    if (receipt) return toPublicReceipt(taskId, messageId, receipt);
    if (isStaleTurnError(error)) {
      throw new WebApplicationError(
        "STALE_STATE",
        "This task moved to a newer turn. Refresh the task before sending this follow-up.",
        409,
        false,
      );
    }
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
    "expectedTurnId",
    "quotedAssistantMessage",
    "integrationMentions",
    "images",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) throw invalidRequest();
  const options: BrowserFollowUpOptions = {};
  const images = value.images === undefined ? undefined : parseMediaDescriptors(value.images);
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
  if (value.expectedTurnId !== undefined) {
    if (
      typeof value.expectedTurnId !== "string" ||
      !value.expectedTurnId.trim() ||
      value.expectedTurnId.trim().length > 200
    ) {
      throw invalidRequest();
    }
    options.expectedTurnId = value.expectedTurnId.trim();
  }

  if (value.quotedAssistantMessage !== undefined && !isRecord(value.quotedAssistantMessage)) {
    throw invalidRequest();
  }
  if (value.integrationMentions !== undefined && !Array.isArray(value.integrationMentions)) {
    throw invalidRequest();
  }
  if (
    value.quotedAssistantMessage !== undefined ||
    value.integrationMentions !== undefined ||
    value.expectedTurnId !== undefined
  ) {
    try {
      const sanitized = sanitizeTaskMessageParams({
        taskId,
        message,
        ...(options.expectedTurnId ? { expectedTurnId: options.expectedTurnId } : {}),
        ...(value.quotedAssistantMessage !== undefined
          ? { quotedAssistantMessage: value.quotedAssistantMessage }
          : {}),
        ...(value.integrationMentions !== undefined
          ? { integrationMentions: value.integrationMentions }
          : {}),
      });
      if (sanitized.quotedAssistantMessage) {
        options.quotedAssistantMessage = sanitized.quotedAssistantMessage;
      }
      if (sanitized.integrationMentions) {
        options.integrationMentions = sanitized.integrationMentions;
      }
      if (sanitized.expectedTurnId) options.expectedTurnId = sanitized.expectedTurnId;
    } catch {
      throw invalidRequest();
    }
  }
  return { taskId, workspaceId, message, options, ...(images !== undefined ? { images } : {}) };
}

function parseMediaDescriptors(value: unknown): BrowserTaskMediaDescriptor[] {
  try {
    const descriptors = parseBrowserTaskMediaDescriptors(value);
    if (!descriptors) throw invalidRequest();
    return descriptors;
  } catch {
    throw invalidRequest();
  }
}

async function resolveFollowUpMedia(
  sources: BrowserFollowUpSources,
  context: WebRequestContext,
  request: FollowUpRequest,
): Promise<BrowserCapturedTaskMedia[]> {
  if (!request.images?.length) return [];
  if (!sources.prepareFollowUpMedia) throw invalidRequest();
  try {
    return await sources.prepareFollowUpMedia(context, request.workspaceId, request.images);
  } catch (error) {
    if (error instanceof WebApplicationError) throw error;
    throw invalidRequest();
  }
}

async function validateQuoteSource(
  sources: BrowserFollowUpSources,
  task: Task,
  quote: QuotedAssistantMessage | undefined,
): Promise<void> {
  if (!quote) return;
  if (quote.taskId && quote.taskId !== task.id) throw invalidRequest();
  if (!quote.eventId) return;
  if (!sources.getQuotedAssistantEvent) throw invalidRequest();
  const event = await sources.getQuotedAssistantEvent(task.id, quote.eventId);
  if (
    !event ||
    (event.eventId ?? event.id) !== quote.eventId ||
    event.taskId !== task.id ||
    (event.legacyType ?? event.type) !== "assistant_message" ||
    !isRecord(event.payload) ||
    event.payload.internal === true ||
    typeof event.payload.message !== "string" ||
    !matchesAssistantQuote(event.payload.message, quote)
  ) {
    throw invalidRequest();
  }
}

function matchesAssistantQuote(sourceMessage: string, quote: QuotedAssistantMessage): boolean {
  const source = normalizeAssistantQuoteText(sourceMessage);
  const submitted = normalizeAssistantQuoteText(quote.message);
  if (!source || !submitted) return false;
  if (quote.truncated === true) {
    return submitted.endsWith("…") && source.startsWith(submitted.slice(0, -1));
  }
  return source === submitted;
}

function normalizeAssistantQuoteText(value: string): string {
  const displayText = sanitizeToolCallTextFromAssistant(
    value.replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1"),
  ).text;
  return (
    unwrapDisplayMarkdownFences(displayText)
      .replace(/\r\n?/g, "\n")
      // The renderer turns JSON host paths into links whose label and destination are the path.
      .replace(
        /^([ \t]*)\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}([ \t]*)$/gm,
        (_match, leading, encodedPath, trailing) => {
          try {
            return `${leading}${JSON.parse(`"${encodedPath}"`)}${trailing}`;
          } catch {
            return _match;
          }
        },
      )
      // Normalize only links the renderer can create automatically: local paths, bare URLs,
      // and bare domains. Authored links with different labels and destinations stay intact.
      .replace(/\[((?:\\.|[^\]])+)\]\(((?:\\.|[^)])+)\)/g, (link, rawLabel, rawHref) => {
        const label = unescapeMarkdownLinkText(rawLabel);
        let href = unescapeMarkdownLinkText(rawHref);
        try {
          href = decodeURI(href);
        } catch {
          return link;
        }
        if (href === label || isRendererAutolink(label, href)) return label;
        return link;
      })
      // Rendering protects glob tokens with inline-code ticks so markdown cannot parse them as
      // emphasis. Remove those generated ticks when checking the source event.
      .replace(/`(\*\*\/[^`\s,;()]+)`/g, "$1")
      // The renderer splits numbered sources that were compacted with pipe separators.
      .replace(/\s+\|\s+(?=\[\d+\])/g, " ")
      .replace(/\s+\((\d+)\)\s+/g, " $1. ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function unwrapDisplayMarkdownFences(value: string): string {
  return value
    .replace(/^[ \t]*```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gim, "$1")
    .replace(/^[ \t]*```(?!\w)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gm, (full, content) =>
      /\n#{1,6}\s/m.test(content) || /^#{1,6}\s/m.test(content) ? content : full,
    );
}

function unescapeMarkdownLinkText(value: string): string {
  return value.replace(/\\([\\[\]])/g, "$1");
}

function isRendererAutolink(label: string, href: string): boolean {
  if (isLocalPath(label)) return href === label;
  if (/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(label)) {
    return href === `https://${label}` || href === `http://${label}`;
  }
  return false;
}

function isLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("file://") ||
    /^[a-z]:[\\/]/i.test(value)
  );
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

function createMediaRequestFingerprint(
  taskId: string,
  workspaceId: string,
  message: string,
  options: BrowserFollowUpOptions,
  capturedAttachments: BrowserCapturedTaskMedia[],
): string {
  return hashPayload({
    taskId,
    workspaceId,
    message,
    options,
    media: capturedAttachments.map((capture) => ({
      relativePath: capture.relativePath,
      mimeType: capture.mimeType,
      filename: capture.filename,
      sizeBytes: capture.sizeBytes,
      sha256: capture.sha256,
      identity: capture.identity,
    })),
  });
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
  return /Message ID .+ was already used for a different (?:content|request)/i.test(message);
}

function isStaleTurnError(error: unknown): boolean {
  return isRecord(error) && error.code === "STALE_TURN";
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
