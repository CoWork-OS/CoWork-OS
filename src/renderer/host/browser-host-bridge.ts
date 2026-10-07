import type { ElectronAPI } from "../../electron/preload";
import type {
  AppNotification,
  AppearanceSettings,
  Task,
  TaskEvent,
  TaskTimelinePageCursor,
  Workspace,
} from "../../shared/types";
import type { MailboxEvent } from "../../shared/mailbox";
import type { CronEvent } from "../../electron/cron/types";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import { createLLMSettingsPatch } from "../../shared/host-api/llm-settings-patch";
import type {
  BrowserGitAction,
  BrowserGitApi,
  BrowserGitDiffSummary,
  BrowserGitMutationInput,
  BrowserGitMutationResult,
  BrowserGitStatusSummary,
} from "../../shared/host-api/git";
import { BrowserHostTransport, WebTransportError, webEndpoint } from "../../renderer-web/transport";
import { createBrowserComposerDraftBridge } from "./browser-composer-draft-bridge";
import { createBrowserFileBridge } from "./browser-file-bridge";
import { createBrowserDecisionBridge } from "./browser-decision-bridge";
import { createBrowserTerminalBridge } from "./browser-terminal-bridge";
import { browserVisualAttachments } from "./browser-task-input";
import { BROWSER_HOST_UNSUPPORTED_ACTION_EVENT } from "./browser-capabilities";

/** A browser build can only invoke operations implemented by the browser host API. */
export class UnsupportedBrowserHostMethodError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY" as const;
  readonly retryable = false;

  constructor(method: string) {
    super(`The browser host does not support ${method}.`);
    this.name = "UnsupportedBrowserHostMethodError";
  }
}

interface WorkspaceListResponse {
  workspaces: Workspace[];
}

interface TaskListResponse {
  tasks: unknown[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

type BrowserTaskSummary = Pick<
  Task,
  "id" | "title" | "status" | "workspaceId" | "createdAt" | "updatedAt"
> &
  Partial<
    Pick<
      Task,
      | "parentTaskId"
      | "agentType"
      | "depth"
      | "assignedAgentRoleId"
      | "boardColumn"
      | "priority"
      | "labels"
      | "dueDate"
      | "pinned"
      | "sessionArchived"
      | "sessionId"
      | "source"
    >
  > & { prompt: "" };

interface TaskResponse {
  task: Task | null;
}

interface TaskEventsResponse {
  taskId: string;
  workspaceId: string;
  events: TaskEvent[];
  cursor?: unknown;
  hasMoreHistory: boolean;
  nextHistoryCursor?: unknown;
}

interface PendingOperation {
  key: string;
  fingerprint: string;
}

interface PendingCancellation extends PendingOperation {
  workspaceId: string;
  expectedStatus: Task["status"];
  expectedUpdatedAt: number;
}

interface FollowUpReceipt {
  found: boolean;
  state: "admitted" | "pending" | "unavailable";
  deliveryStatus?: "accepted" | "queued" | "started";
  acceptedAt?: number;
  queuedAt?: number;
  startedAt?: number;
}

interface CancellationResult {
  taskId: string;
  workspaceId: string;
  operationKey: string;
  outcome: "observed_terminal" | "pending";
  status: Task["status"];
  updatedAt: number;
}

interface TaskMutationCursor {
  taskId: string;
  position: number;
}

interface ObservedTaskEventScope {
  taskId: string;
  workspaceId: string;
  cursor: TaskMutationCursor;
  knownEventIds: Set<string>;
}

interface BrowserNotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PROVIDER_SETTINGS_RELOAD_MESSAGE =
  "Provider settings changed after this page loaded. Reload AI & Models to review the latest values, then reapply your changes.";
const PROVIDER_SETTINGS_MUTATION_METHODS = new Set([
  "saveLLMSettings",
  "resetLLMProviderCredentials",
  "setLLMModel",
  "setLLMProvider",
]);
const TERMINAL_TASK_STATUSES = new Set<Task["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Installs an ElectronAPI-shaped browser bridge before the shared desktop App is
 * imported. The disposer restores the previous globals so a later sign-in can
 * install a bridge backed by its own session and transport.
 */
export function installBrowserHostBridge(
  transport: BrowserHostTransport,
  session: WebSessionBootstrap,
): () => void {
  const previousElectronApi = window.electronAPI;
  const previousBrowserGit = window.coworkBrowserGit;
  const previousBrowserMarker = window.coworkBrowserHost;
  const previousBrowserInfo = window.coworkBrowserHostInfo;
  const browserInfo = {
    providerReady: session.providerReady,
    activeWorkspaceId: session.activeWorkspaceId,
    capabilities: session.capabilities,
    desktopMethods: session.desktopMethods,
  };
  const appearanceStorageKey = `cowork:browser-appearance:${session.host.installationId}:${session.host.profileId}`;
  let active = true;
  let providerSettingsRevision: string | null = null;
  let providerSettingsRevisionBlocked = false;
  let providerSettingsSnapshot: unknown;
  let providerSettingsSnapshotLoaded = false;
  let disposeQueueUpdatePolling: () => void = () => undefined;
  let disposeCronEventPolling: () => void = () => undefined;
  let disposeMailboxEventPolling: () => void = () => undefined;
  let disposePersonalitySettingsPolling: () => void = () => undefined;
  let disposeRoutingStatusPolling: () => void = () => undefined;
  const disposeIntegrationPolling: Array<() => void> = [];
  let selectedWorkspaceId = session.activeWorkspaceId;
  const taskOffsets = new Map<string, number>();
  const observedTaskEventScopes = new Map<string, ObservedTaskEventScope>();
  const taskEventListeners = new Set<(event: TaskEvent) => void>();
  let taskEventPollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingTaskEvents = false;
  const sessionScopePromise = fingerprintPayload({
    csrfToken: session.csrfToken,
    generation: session.host.generation,
  });
  const sessionScopeReady = sessionScopePromise.then((scope) =>
    verifyBrowserOperationSession(session, scope),
  );
  const getOperationStorageKey = async (
    method: "create" | "follow-up" | "cancel" | "decision" | "desktop" | "git",
    scope: string,
  ): Promise<string> => {
    const sessionScope = await sessionScopePromise;
    if (!(await sessionScopeReady)) throw new UnresolvedBrowserSessionOperationError();
    return operationStorageKey(session, sessionScope, method, scope);
  };

  const rpc = async <T>(
    method: string,
    params: unknown,
    options?: Parameters<BrowserHostTransport["request"]>[2],
  ): Promise<T> => {
    if (!active) throw new StaleBrowserHostBridgeError();
    const result = await transport.request<T>(method, params, options);
    if (!active) throw new StaleBrowserHostBridgeError();
    return result;
  };

  const readProviderSettingsSnapshot = async (): Promise<unknown> => {
    const snapshot = await rpc<unknown>("desktop.getLLMSettings", { args: [] });
    if (
      !isRecord(snapshot) ||
      !Object.hasOwn(snapshot, "settings") ||
      typeof snapshot.revision !== "string"
    ) {
      throw new Error("The host returned an invalid provider settings snapshot.");
    }
    providerSettingsRevision = snapshot.revision;
    providerSettingsRevisionBlocked = false;
    providerSettingsSnapshot = snapshot.settings;
    providerSettingsSnapshotLoaded = true;
    return snapshot.settings;
  };

  const mutateGit = async (action: BrowserGitAction, request: BrowserGitMutationInput) => {
    const fingerprint = await fingerprintPayload({ action, request });
    const storageKey = await getOperationStorageKey(
      "git",
      `${request.workspaceId}:${action}:${fingerprint}`,
    );
    const operation = await getOrCreatePendingOperation(storageKey, fingerprint);
    try {
      const result = await rpc<BrowserGitMutationResult>(`git.${action}`, request, {
        operationKey: operation.key,
        mutation: true,
        timeoutMs: 120_000,
      });
      clearPendingOperation(storageKey, operation.key);
      return result;
    } catch (error) {
      if (
        [
          "INVALID_REQUEST",
          "FORBIDDEN",
          "UNSUPPORTED_CAPABILITY",
          "STALE_STATE",
          "CONFLICT",
          "RATE_LIMITED",
        ].some((code) => hasErrorCode(error, code))
      ) {
        clearPendingOperation(storageKey, operation.key);
      }
      throw error;
    }
  };
  const browserGit: BrowserGitApi = {
    status: (workspaceId) => rpc<BrowserGitStatusSummary>("git.status", { workspaceId }),
    diff: (request) => rpc<BrowserGitDiffSummary>("git.diff", request),
    stage: (request) => mutateGit("stage", request),
    unstage: (request) => mutateGit("unstage", request),
    commit: (request) => mutateGit("commit", request),
  };

  const mutateDecision = async <T>(
    method: string,
    params: unknown,
    scope: { workspaceId: string; taskId: string; id: string; expectedVersion: number },
  ): Promise<T> => {
    const storageKey = await getOperationStorageKey(
      "decision",
      `${method}:${scope.workspaceId}:${scope.taskId}:${scope.id}`,
    );
    const operation = await getOrCreatePendingOperation(
      storageKey,
      await fingerprintPayload(params),
    );
    try {
      const result = await rpc<T>(method, params, {
        operationKey: operation.key,
        mutation: true,
        timeoutMs: 120_000,
      });
      const outcome = isRecord(result) ? result.status : undefined;
      if (outcome === "handled" || outcome === "duplicate" || outcome === "not_found") {
        clearPendingOperation(storageKey, operation.key);
      }
      return result;
    } catch (error) {
      if (
        [
          "INVALID_REQUEST",
          "FORBIDDEN",
          "UNSUPPORTED_CAPABILITY",
          "STALE_STATE",
          "CONFLICT",
          "RATE_LIMITED",
        ].some((code) => hasErrorCode(error, code))
      ) {
        clearPendingOperation(storageKey, operation.key);
      }
      throw error;
    }
  };

  const listWorkspaces = async (): Promise<Workspace[]> => {
    const response = await rpc<WorkspaceListResponse>("desktop.workspace.list", {});
    if (!isRecord(response) || !Array.isArray(response.workspaces)) {
      throw new InvalidBrowserHostResponseError("workspace.list");
    }
    return response.workspaces as Workspace[];
  };

  const selectWorkspace = async (workspaceId: string): Promise<Workspace> => {
    const workspaces = await listWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error("That workspace is unavailable to this browser session.");
    }
    // Workspace selection is renderer state. The browser host exposes no
    // separate workspace.select mutation, so this does not change host state.
    selectedWorkspaceId = workspace.id;
    browserInfo.activeWorkspaceId = workspace.id;
    return workspace;
  };

  const getTask = async (taskId: string): Promise<Task | null> => {
    const response = await rpc<TaskResponse>("desktop.task.get", { taskId });
    if (!isRecord(response) || !Object.prototype.hasOwnProperty.call(response, "task")) {
      throw new InvalidBrowserHostResponseError("desktop.task.get");
    }
    return (response.task as Task | null) ?? null;
  };

  const decisions = createBrowserDecisionBridge({
    rpc,
    listWorkspaces,
    getTask,
    mutate: mutateDecision,
  });

  const listTasks = async (
    options?: Parameters<ElectronAPI["listTasks"]>[0],
  ): Promise<BrowserTaskSummary[]> => {
    const limit = normalizePageLimit(options?.limit);
    const workspaceId = selectedWorkspaceId || session.activeWorkspaceId || null;
    const offset = resolveTaskOffset(
      options?.cursor?.id,
      workspaceId,
      options?.offset,
      taskOffsets,
    );
    const response = await rpc<TaskListResponse>("task.list", {
      limit,
      offset,
      workspaceId,
    });
    if (!isRecord(response) || !Array.isArray(response.tasks)) {
      throw new InvalidBrowserHostResponseError("task.list");
    }
    const tasks = response.tasks.map(toBrowserTaskSummary);
    tasks.forEach((task, index) => {
      taskOffsets.set(taskOffsetKey(workspaceId, task.id), offset + index);
    });
    return tasks;
  };

  const readTaskEventSnapshot = async (task: Task, limit: number) => {
    const response = await rpc<TaskEventsResponse>("task.events.snapshot", {
      taskId: task.id,
      workspaceId: task.workspaceId,
      limit,
    });
    if (
      !isRecord(response) ||
      response.taskId !== task.id ||
      response.workspaceId !== task.workspaceId ||
      !Array.isArray(response.events)
    ) {
      throw new InvalidBrowserHostResponseError("task.events.snapshot");
    }
    const events = await Promise.all(
      (response.events as TaskEvent[]).map((event) => decisions.hydrateTaskEvent(event)),
    );
    const cursor = parseTaskMutationCursor(response.cursor, task.id);
    if (cursor) {
      observedTaskEventScopes.delete(task.id);
      observedTaskEventScopes.set(task.id, {
        taskId: task.id,
        workspaceId: task.workspaceId,
        cursor,
        knownEventIds: new Set(events.flatMap((event) => (event.id ? [event.id] : []))),
      });
      while (observedTaskEventScopes.size > 8) {
        const oldest = observedTaskEventScopes.keys().next().value as string | undefined;
        if (!oldest) break;
        observedTaskEventScopes.delete(oldest);
      }
      scheduleTaskEventPoll();
    }
    return { response, events };
  };

  const getTaskEvents = async (taskId: string): Promise<TaskEvent[]> => {
    const task = await getTask(taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    return (await readTaskEventSnapshot(task, 600)).events;
  };

  const getTaskTimelinePage: ElectronAPI["getTaskTimelinePage"] = async (request) => {
    const task = await getTask(request.taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    const limit = normalizeTimelineLimit(request.limit);
    let events: TaskEvent[];
    let hasMoreHistory: boolean;
    let nextCursor: TaskTimelinePageCursor | null;

    if (request.cursor) {
      const beforeCursor = parseTimelineHistoryCursor(request.cursor);
      if (!beforeCursor) throw new Error("Invalid task timeline cursor.");
      const response = await rpc<unknown>("task.events.history", {
        taskId: task.id,
        workspaceId: task.workspaceId,
        beforeCursor,
        limit,
      });
      if (!isRecord(response) || !Array.isArray(response.events)) {
        throw new InvalidBrowserHostResponseError("task.events.history");
      }
      events = await Promise.all(
        (response.events as TaskEvent[]).map((event) => decisions.hydrateTaskEvent(event)),
      );
      hasMoreHistory = response.hasMoreHistory === true;
      nextCursor = parseTimelineHistoryCursor(response.nextHistoryCursor);
    } else {
      const snapshot = await readTaskEventSnapshot(task, limit);
      events = snapshot.events;
      hasMoreHistory = snapshot.response.hasMoreHistory === true;
      nextCursor = parseTimelineHistoryCursor(snapshot.response.nextHistoryCursor);
    }

    const summary = summarizeTimelinePage(events);
    return {
      taskId: task.id,
      events,
      hasMoreHistory,
      nextCursor: hasMoreHistory ? nextCursor : null,
      summary,
    };
  };

  const getTaskEventDetail: ElectronAPI["getTaskEventDetail"] = async (request) => {
    const taskId = typeof request?.taskId === "string" ? request.taskId.trim() : "";
    const eventId = typeof request?.eventId === "string" ? request.eventId.trim() : "";
    if (!taskId || !eventId || eventId.length > 256) {
      throw new Error("A valid task and event are required.");
    }
    const events = await getTaskEvents(taskId);
    const event =
      events.find((candidate) => candidate.id === eventId || candidate.eventId === eventId) ?? null;
    return {
      event,
      payloadBytes: event ? utf8Size(JSON.stringify(event.payload ?? {})) : 0,
    };
  };

  const onTaskEvent: ElectronAPI["onTaskEvent"] = (callback) => {
    taskEventListeners.add(callback as (event: TaskEvent) => void);
    scheduleTaskEventPoll();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      taskEventListeners.delete(callback as (event: TaskEvent) => void);
      if (taskEventListeners.size === 0 && taskEventPollTimer) {
        clearTimeout(taskEventPollTimer);
        taskEventPollTimer = null;
      }
    };
  };

  function scheduleTaskEventPoll(): void {
    if (
      !active ||
      taskEventListeners.size === 0 ||
      observedTaskEventScopes.size === 0 ||
      taskEventPollTimer
    ) {
      return;
    }
    taskEventPollTimer = setTimeout(() => {
      taskEventPollTimer = null;
      void pollTaskEvents();
    }, 2_500);
  }

  async function pollTaskEvents(): Promise<void> {
    if (!active || pollingTaskEvents || taskEventListeners.size === 0) return;
    pollingTaskEvents = true;
    try {
      for (const scope of observedTaskEventScopes.values()) {
        if (!active || taskEventListeners.size === 0) break;
        let cursor = scope.cursor;
        for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
          const raw = await rpc<unknown>("task.events.page", {
            taskId: scope.taskId,
            workspaceId: scope.workspaceId,
            afterCursor: cursor,
            limit: 100,
          });
          if (!isRecord(raw) || typeof raw.outcome !== "string") break;
          if (raw.outcome === "cursor_expired") {
            const resyncCursor = parseTaskMutationCursor(raw.resyncCursor, scope.taskId);
            if (!resyncCursor) break;
            const snapshot = await rpc<unknown>("task.events.snapshot", {
              taskId: scope.taskId,
              workspaceId: scope.workspaceId,
              limit: 600,
            });
            if (
              !isRecord(snapshot) ||
              !Array.isArray(snapshot.events) ||
              !parseTaskMutationCursor(snapshot.cursor, scope.taskId)
            ) {
              break;
            }
            cursor = parseTaskMutationCursor(snapshot.cursor, scope.taskId)!;
            scope.cursor = cursor;
            for (const candidate of snapshot.events) {
              if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
              if (!scope.knownEventIds.has(candidate.id)) {
                await emitTaskEvent(candidate as unknown as TaskEvent);
              }
              rememberEventId(scope, candidate.id);
            }
            break;
          }
          if (raw.outcome === "no_changes") {
            const nextCursor = parseTaskMutationCursor(raw.nextCursor, scope.taskId);
            if (nextCursor) scope.cursor = nextCursor;
            break;
          }
          if (raw.outcome !== "page" && raw.outcome !== "page_with_more") break;
          if (!Array.isArray(raw.changes)) break;
          for (const change of raw.changes) {
            if (!isRecord(change) || change.operation !== "upsert" || !isRecord(change.event)) {
              continue;
            }
            if (change.event.taskId !== scope.taskId) continue;
            if (typeof change.event.id === "string") rememberEventId(scope, change.event.id);
            await emitTaskEvent(change.event as unknown as TaskEvent);
          }
          const nextCursor = parseTaskMutationCursor(raw.nextCursor, scope.taskId);
          if (!nextCursor) break;
          scope.cursor = nextCursor;
          cursor = nextCursor;
          if (raw.outcome !== "page_with_more") break;
        }
      }
    } catch {
      // Polling is best-effort; the next bounded interval can reconcile again.
    } finally {
      pollingTaskEvents = false;
      scheduleTaskEventPoll();
    }
  }

  async function emitTaskEvent(event: TaskEvent): Promise<void> {
    const hydrated = await decisions.hydrateTaskEvent(event);
    for (const listener of taskEventListeners) {
      try {
        listener(hydrated);
      } catch {
        // An individual renderer subscriber must not stop other updates.
      }
    }
  }

  function rememberEventId(scope: ObservedTaskEventScope, eventId: string): void {
    scope.knownEventIds.add(eventId);
    if (scope.knownEventIds.size <= 1_200) return;
    const oldest = scope.knownEventIds.values().next().value as string | undefined;
    if (oldest) scope.knownEventIds.delete(oldest);
  }

  const createTask = async (data: unknown): Promise<Task> => {
    if (!session.providerReady) throw new BrowserProviderNotReadyError();
    const parsed = parseTaskCreateRequest(data);
    const { images, ...taskInput } = parsed;
    const workspace = images?.length
      ? (await listWorkspaces()).find((candidate) => candidate.id === parsed.workspaceId)
      : undefined;
    if (images?.length && !workspace) throw new Error("The attachment workspace is unavailable.");
    const request = {
      ...taskInput,
      ...(images?.length ? { images: browserVisualAttachments(images, workspace!.path) } : {}),
    };
    const storageKey = await getOperationStorageKey("create", request.workspaceId);
    const fingerprint = await fingerprintPayload(request);
    const operation = await getOrCreatePendingOperation(storageKey, fingerprint);

    // Admission lookup always precedes a retry. This lets a tab recover a task
    // after a lost response without submitting the work a second time.
    const prior = await rpc<unknown>("task.admission.get", { operationKey: operation.key });
    const priorTask = await taskFromAdmission(prior, request, getTask);
    if (priorTask) {
      clearPendingOperation(storageKey, operation.key);
      return priorTask;
    }

    try {
      const result = await rpc<unknown>("task.create", request, {
        operationKey: operation.key,
        mutation: true,
        timeoutMs: 120_000,
      });
      const task = await taskFromAdmission(result, request, getTask);
      if (!task) throw new InvalidBrowserHostResponseError("task.create");
      clearPendingOperation(storageKey, operation.key);
      return task;
    } catch (error) {
      const reconciled = await rpc<unknown>("task.admission.get", {
        operationKey: operation.key,
      })
        .then((receipt) => taskFromAdmission(receipt, request, getTask))
        .catch(() => null);
      if (reconciled) {
        clearPendingOperation(storageKey, operation.key);
        return reconciled;
      }
      if (isDefinitiveInputRejection(error)) {
        clearPendingOperation(storageKey, operation.key);
      }
      throw error;
    }
  };

  const sendMessage: ElectronAPI["sendMessage"] = async (
    taskId,
    message,
    images,
    quotedAssistantMessage,
    options,
  ) => {
    if (!session.providerReady) throw new BrowserProviderNotReadyError();
    if (!isSupportedFollowUpOptions(options)) {
      throw new UnsupportedBrowserHostMethodError("these follow-up options");
    }
    const cleanMessage = typeof message === "string" ? message.trim() : "";
    if (!cleanMessage || cleanMessage.length > 64_000) {
      throw new Error("A follow-up message between 1 and 64,000 characters is required.");
    }
    const task = await getTask(taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    const workspace = images?.length
      ? (await listWorkspaces()).find((candidate) => candidate.id === task.workspaceId)
      : undefined;
    if (images?.length && !workspace) throw new Error("The attachment workspace is unavailable.");
    const request = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      message: cleanMessage,
      ...(images?.length ? { images: browserVisualAttachments(images, workspace!.path) } : {}),
      ...(quotedAssistantMessage ? { quotedAssistantMessage } : {}),
      ...(options?.expectedTurnId !== undefined ? { expectedTurnId: options.expectedTurnId } : {}),
      ...(options?.integrationMentions?.length
        ? { integrationMentions: options.integrationMentions }
        : {}),
      ...(options?.interactionMode ? { interactionMode: options.interactionMode } : {}),
      ...(options?.accessProfileId ? { accessProfileId: options.accessProfileId } : {}),
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options?.shellAccess !== undefined ? { shellAccess: options.shellAccess } : {}),
    };
    const storageKey = await getOperationStorageKey("follow-up", `${task.workspaceId}:${task.id}`);
    const fingerprint = await fingerprintPayload(request);
    const existing = readStoredOperation(storageKey);
    if (existing && existing.fingerprint !== fingerprint) {
      const previous = parseFollowUpReceipt(
        await rpc<unknown>("task.followUp.receipt", {
          taskId: task.id,
          workspaceId: task.workspaceId,
          operationKey: existing.key,
        }),
      );
      if (previous.found) {
        clearPendingOperation(storageKey, existing.key);
        throw new Error(
          previous.state === "unavailable"
            ? "The previous follow-up failed. Review its task history before sending again."
            : "The previous follow-up was accepted. Review its task history before sending again.",
        );
      }
    }
    const operation = await getOrCreatePendingOperation(storageKey, fingerprint);
    const receiptParams = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      operationKey: operation.key,
    };

    const priorReceipt = parseFollowUpReceipt(
      await rpc<unknown>("task.followUp.receipt", receiptParams),
    );
    if (priorReceipt.found && priorReceipt.state === "unavailable") {
      clearPendingOperation(storageKey, operation.key);
      throw new Error(
        "The host could not deliver this follow-up. Review the message before retrying.",
      );
    }
    const priorResult = followUpResult(priorReceipt);
    if (priorResult) {
      clearPendingOperation(storageKey, operation.key);
      return priorResult;
    }

    try {
      const result = parseFollowUpReceipt(
        await rpc<unknown>("task.followUp", request, {
          operationKey: operation.key,
          mutation: true,
          timeoutMs: 120_000,
        }),
      );
      if (result.found && result.state === "unavailable") {
        clearPendingOperation(storageKey, operation.key);
        throw new Error(
          "The host could not deliver this follow-up. Review the message before retrying.",
        );
      }
      const normalized = followUpResult(result);
      if (normalized) {
        clearPendingOperation(storageKey, operation.key);
        return normalized;
      }
      throw new InvalidBrowserHostResponseError("task.followUp");
    } catch (error) {
      const reconciled = await rpc<unknown>("task.followUp.receipt", receiptParams)
        .then(parseFollowUpReceipt)
        .catch(() => null);
      if (reconciled?.found && reconciled.state === "unavailable") {
        clearPendingOperation(storageKey, operation.key);
        throw new Error(
          "The host could not deliver this follow-up. Review the message before retrying.",
        );
      }
      const reconciledResult = reconciled ? followUpResult(reconciled) : null;
      if (reconciledResult) {
        clearPendingOperation(storageKey, operation.key);
        return reconciledResult;
      }
      if (isDefinitiveInputRejection(error)) {
        clearPendingOperation(storageKey, operation.key);
      }
      throw error;
    }
  };

  const cancelTask: ElectronAPI["cancelTask"] = async (taskId) => {
    const task = await getTask(taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    const storageKey = await getOperationStorageKey("cancel", task.id);
    const pending = readPendingCancellation(storageKey);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      if (pending) clearPendingOperation(storageKey, pending.key);
      return;
    }
    let attempt: PendingCancellation;
    if (pending) {
      attempt = pending;
      if (attempt.workspaceId !== task.workspaceId) {
        throw new InvalidBrowserHostResponseError("saved task cancellation");
      }
    } else {
      if (!isTaskStatus(task.status) || !isValidTimestamp(task.updatedAt)) {
        throw new InvalidBrowserHostResponseError("desktop.task.get");
      }
      const payload = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        expectedStatus: task.status,
        expectedUpdatedAt: task.updatedAt,
      };
      const fingerprint = await fingerprintPayload(payload);
      attempt = {
        ...(await getOrCreatePendingOperation(storageKey, fingerprint)),
        workspaceId: task.workspaceId,
        expectedStatus: task.status,
        expectedUpdatedAt: task.updatedAt,
      };
    }

    const request = {
      taskId: task.id,
      workspaceId: attempt.workspaceId,
      expectedStatus: attempt.expectedStatus,
      expectedUpdatedAt: attempt.expectedUpdatedAt,
    };
    const fingerprint = await fingerprintPayload(request);
    if (fingerprint !== attempt.fingerprint) {
      throw new InvalidBrowserHostResponseError("saved task cancellation");
    }

    try {
      const result = parseCancellationResult(
        await rpc<unknown>("task.cancel", request, {
          operationKey: attempt.key,
          mutation: true,
          timeoutMs: 120_000,
        }),
        task.id,
        task.workspaceId,
        attempt.key,
      );
      if (result.outcome === "observed_terminal") {
        clearPendingOperation(storageKey, attempt.key);
      }
      return;
    } catch (error) {
      if (hasErrorCode(error, "STALE_STATE")) {
        clearPendingOperation(storageKey, attempt.key);
      }
      throw error;
    }
  };

  const getAppearanceSettings: ElectronAPI["getAppearanceSettings"] = async () => {
    const local = readBrowserAppearance(appearanceStorageKey);
    return {
      themeMode: "system",
      visualTheme: "warm",
      accentColor: "blue",
      uiDensity: "focused",
      timelineVerbosity: "summary",
      commandOutputStyle: "terminal",
      ...local,
      // The authenticated host flags are authoritative when already accepted.
      // Local completion is only a browser preference and is never written to
      // the host's profile or represented as host consent.
      disclaimerAccepted: session.disclaimerAccepted || local.disclaimerAccepted === true,
      onboardingCompleted: session.onboardingCompleted || local.onboardingCompleted === true,
    };
  };

  const saveAppearanceSettings: ElectronAPI["saveAppearanceSettings"] = async (settings) => {
    if (settings.devRunLoggingEnabled !== undefined) {
      throw new UnsupportedBrowserHostMethodError("developer logging preferences");
    }
    const current = readBrowserAppearance(appearanceStorageKey);
    const next = {
      ...current,
      ...sanitizeBrowserAppearance(settings as Record<string, unknown>),
    };
    try {
      window.localStorage.setItem(appearanceStorageKey, JSON.stringify(next));
      return { success: true };
    } catch {
      throw new Error("This browser could not save its local appearance preference.");
    }
  };

  // Session auto-approval is renderer-scoped in a browser. The shared App owns
  // the actual state; these methods provide the optional desktop persistence
  // seam without sending an unsupported RPC or persisting across sign-out.
  let sessionAutoApprove = false;

  const supported: Record<string, unknown> = {
    listBrowserWorkspaceFiles: (request: unknown) => rpc("workspace.files.list", request),
    listBrowserTaskArtifacts: (request: unknown) => rpc("task.artifacts.list", request),
    createBrowserArtifactDownload: async (request: unknown) => {
      const storageKey = await getOperationStorageKey("desktop", "artifact.download.create");
      const operation = await getOrCreatePendingOperation(
        storageKey,
        await fingerprintPayload(request),
      );
      const result = await rpc("artifact.download.create", request, {
        operationKey: operation.key,
        mutation: true,
      });
      clearPendingOperation(storageKey, operation.key);
      return result;
    },
    getPlatform: () => session.host.platform,
    getAppVersion: async () => ({ version: session.host.appVersion }),
    openExternal: (rawUrl: unknown) => {
      if (typeof rawUrl !== "string")
        throw new Error("Only http, https, and mailto URLs are allowed.");
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new Error("Only http, https, and mailto URLs are allowed.");
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        throw new Error("Only http, https, and mailto URLs are allowed.");
      }
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    getNativeFrameMode: () => false,
    getSessionAutoApprove: async () => sessionAutoApprove,
    setSessionAutoApprove: async (enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new TypeError("Session auto-approval must be a boolean.");
      }
      sessionAutoApprove = enabled;
    },
    getAppearanceSettings,
    saveAppearanceSettings,
    listWorkspaces,
    selectWorkspace,
    listTasks,
    listSidebarTasks: listTasks,
    getTask,
    getTaskEvents,
    getTaskTimelinePage,
    getTaskEventDetail,
    onTaskEvent,
    createTask,
    sendMessage,
    cancelTask,
  };
  if (session.capabilities["tasks.approvals"]?.available) {
    supported.respondToApproval = decisions.methods.respondToApproval;
  }
  if (session.capabilities["tasks.inputRequests"]?.available) {
    supported.listInputRequests = decisions.methods.listInputRequests;
    supported.respondToInputRequest = decisions.methods.respondToInputRequest;
    supported.getInputRequestDraftReview = decisions.methods.getInputRequestDraftReview;
  }
  browserInfo.desktopMethods = {
    ...browserInfo.desktopMethods,
    openExternal: { mutation: false },
    getSessionAutoApprove: { mutation: false },
    setSessionAutoApprove: { mutation: false },
    getTaskTimelinePage: { mutation: false },
    getTaskEventDetail: { mutation: false },
    ...Object.fromEntries(
      [
        ...(session.capabilities["files.read"]?.available ? ["listBrowserWorkspaceFiles"] : []),
        ...(session.capabilities["artifacts.read"]?.available
          ? ["listBrowserTaskArtifacts", "createBrowserArtifactDownload"]
          : []),
      ].map((name) => [name, { mutation: name === "createBrowserArtifactDownload" }]),
    ),
  };
  const files = createBrowserFileBridge({
    session,
    listWorkspaces,
    createMediaHandle: (workspaceId, relativePath) =>
      rpc("workspace.file.media.create", { workspaceId, relativePath }),
    isActive: () => active,
  });
  const drafts = createBrowserComposerDraftBridge({
    installationId: session.host.installationId,
    profileId: session.host.profileId,
    isActive: () => active,
    rekeyAttachments: files.rekeyAttachments,
    releaseAttachments: files.releaseAttachments,
  });
  Object.assign(supported, drafts.methods);
  browserInfo.desktopMethods = {
    ...browserInfo.desktopMethods,
    ...Object.fromEntries(
      Object.keys(drafts.methods).map((name) => [name, { mutation: name !== "getComposerDraft" }]),
    ),
  };
  for (const [name, method] of Object.entries(files.methods)) {
    const capability =
      name === "readFileForViewer" || name === "openFile" ? "files.read" : "files.upload";
    if (!session.capabilities[capability]?.available) continue;
    supported[name] = method;
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      [name]: { mutation: name.startsWith("import") },
    };
  }

  const terminals = createBrowserTerminalBridge({
    rpc,
    listWorkspaces,
    getTask,
    session,
    isActive: () => active,
  });
  if (session.capabilities["terminal.attach"]?.available) {
    Object.assign(supported, terminals.methods);
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      ...Object.fromEntries(
        Object.keys(terminals.methods).map((name) => [
          name,
          { mutation: !name.startsWith("list") && !name.startsWith("on") },
        ]),
      ),
    };
  }

  const localListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emitLocal = (name: string, ...args: unknown[]) => {
    for (const listener of localListeners.get(name) ?? []) listener(...args);
  };
  const subscribeLocal = (name: string) => (listener: (...args: unknown[]) => void) => {
    const listeners = localListeners.get(name) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(listener);
    localListeners.set(name, listeners);
    return () => listeners.delete(listener);
  };
  supported.onLLMSettingsChanged = subscribeLocal("llm");

  const refreshProviderReadiness = async () => {
    const response = await fetch(webEndpoint("session/bootstrap"), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return;
    const updated = (await response.json()) as WebSessionBootstrap;
    if (updated.host?.generation !== session.host.generation) return;
    session.providerReady = updated.providerReady;
    browserInfo.providerReady = updated.providerReady;
    session.capabilities = updated.capabilities;
    browserInfo.capabilities = updated.capabilities;
    emitLocal("llm");
  };

  for (const [name, descriptor] of Object.entries(session.desktopMethods ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(name) || name === "constructor") continue;
    supported[name] = async (...args: unknown[]) => {
      while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
      if (name === "getLLMSettings") return readProviderSettingsSnapshot();
      const requestArgs = [...args];
      const providerSettingsMutation = PROVIDER_SETTINGS_MUTATION_METHODS.has(name);
      if (providerSettingsMutation) {
        if (providerSettingsRevisionBlocked) {
          throw new Error(PROVIDER_SETTINGS_RELOAD_MESSAGE);
        }
        if (!providerSettingsRevision || !providerSettingsSnapshotLoaded) {
          await readProviderSettingsSnapshot();
        }
        if (!providerSettingsRevision) throw new Error(PROVIDER_SETTINGS_RELOAD_MESSAGE);
        if (name === "saveLLMSettings") {
          requestArgs[0] = createLLMSettingsPatch(requestArgs[0], providerSettingsSnapshot);
        }
        requestArgs.push(providerSettingsRevision);
      }
      const omittedArgs = requestArgs.flatMap((arg, index) => (arg === undefined ? [index] : []));
      const params = { args: requestArgs, ...(omittedArgs.length ? { omittedArgs } : {}) };
      let operation: PendingOperation | null = null;
      let storageKey: string | null = null;
      if (descriptor.mutation) {
        // Independent pack controls can be used while another toggle is awaiting
        // its receipt. Retain reconciliation for each logical target rather than
        // making every pack share one pending operation slot.
        const targetScope =
          name === "togglePluginPack" || name === "togglePluginPackSkill"
            ? `${name}:${await fingerprintPayload(
                name === "togglePluginPack" ? args.slice(0, 1) : args.slice(0, 2),
              )}`
            : name;
        storageKey = await getOperationStorageKey("desktop", targetScope);
        operation = await getOrCreatePendingOperation(storageKey, await fingerprintPayload(params));
      }
      try {
        const result = await rpc(`desktop.${name}`, params, {
          ...(operation ? { operationKey: operation.key, mutation: true } : {}),
          timeoutMs: 120_000,
        });
        if (storageKey && operation) clearPendingOperation(storageKey, operation.key);
        if (providerSettingsMutation) {
          providerSettingsRevision =
            isRecord(result) && typeof result.revision === "string" ? result.revision : null;
          providerSettingsRevisionBlocked = providerSettingsRevision === null;
          providerSettingsSnapshotLoaded = false;
          if (!providerSettingsRevisionBlocked) {
            try {
              await readProviderSettingsSnapshot();
            } catch {
              providerSettingsRevision = null;
              providerSettingsRevisionBlocked = true;
            }
          }
        }
        if (name === "openaiOAuthLogout") await readProviderSettingsSnapshot();
        if (
          name === "saveLLMSettings" ||
          name === "resetLLMProviderCredentials" ||
          name === "setLLMProvider" ||
          name === "setLLMModel" ||
          name === "openaiOAuthLogout"
        ) {
          await refreshProviderReadiness();
        }
        return result;
      } catch (error) {
        if (providerSettingsMutation && hasErrorCode(error, "CONFLICT")) {
          providerSettingsRevision = null;
          providerSettingsRevisionBlocked = true;
        }
        if (
          storageKey &&
          operation &&
          [
            "INVALID_REQUEST",
            "FORBIDDEN",
            "NOT_FOUND",
            "UNSUPPORTED_CAPABILITY",
            "CONFLICT",
            "RATE_LIMITED",
          ].some((code) => hasErrorCode(error, code))
        ) {
          clearPendingOperation(storageKey, operation.key);
        }
        throw error;
      }
    };
  }

  // Portable integration managers expose scoped snapshots. Poll only while the
  // shared settings screen has subscribers, and release all timers on teardown.
  function subscribeIntegrationSnapshot(
    read: () => Promise<unknown>,
    publish: (current: unknown, previous: unknown, listener: (...args: unknown[]) => void) => void,
  ) {
    const listeners = new Set<(...args: unknown[]) => void>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    let previous: unknown;
    let serialized: string | undefined;
    const poll = async () => {
      if (!active || inFlight || !listeners.size) return;
      inFlight = true;
      try {
        const current = await read();
        if (!active || !listeners.size) return;
        const next = JSON.stringify(current);
        if (next === serialized) return;
        for (const listener of listeners) {
          try {
            publish(current, previous, listener);
          } catch {
            /* Isolate renderer observers. */
          }
        }
        previous = current;
        serialized = next;
      } catch {
        /* Reconcile after transient disconnect on the next poll. */
      } finally {
        inFlight = false;
      }
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      previous = undefined;
      serialized = undefined;
    };
    disposeIntegrationPolling.push(() => {
      stop();
      listeners.clear();
    });
    return (listener: (...args: unknown[]) => void) => {
      listeners.add(listener);
      if (!timer) {
        void poll();
        timer = setInterval(() => void poll(), 2500);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    };
  }
  if (Object.hasOwn(session.desktopMethods ?? {}, "getMCPStatus")) {
    supported.onMCPStatusChange = subscribeIntegrationSnapshot(
      () => rpc("desktop.getMCPStatus", { args: [{ workspaceId: selectedWorkspaceId }] }),
      (current, _previous, listener) => {
        if (Array.isArray(current)) listener(current);
      },
    );
  }
  if (Object.hasOwn(session.desktopMethods ?? {}, "getGatewayChangeSignal")) {
    supported.onGatewayUsersUpdated = subscribeIntegrationSnapshot(
      () =>
        rpc("desktop.getGatewayChangeSignal", {
          args: [selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}],
        }),
      (current, previous, listener) => {
        if (!Array.isArray(current)) return;
        const prior = new Map(
          (Array.isArray(previous) ? previous : [])
            .filter(isRecord)
            .map((row) => [row.channelId, row.revision]),
        );
        for (const row of current.filter(isRecord)) {
          if (
            typeof row.channelId === "string" &&
            typeof row.channelType === "string" &&
            row.revision !== prior.get(row.channelId)
          )
            listener({ channelId: row.channelId, channelType: row.channelType });
        }
      },
    );
  }
  if (Object.hasOwn(session.desktopMethods ?? {}, "getWhatsAppInfo")) {
    supported.onWhatsAppQRCode = subscribeIntegrationSnapshot(
      () => rpc("desktop.getWhatsAppInfo", { args: [] }),
      (current, previous, listener) => {
        if (
          isRecord(current) &&
          typeof current.qrCode === "string" &&
          current.qrCode !== (isRecord(previous) ? previous.qrCode : undefined)
        )
          listener(undefined, current.qrCode);
      },
    );
    supported.onWhatsAppConnected = subscribeIntegrationSnapshot(
      () => rpc("desktop.getWhatsAppInfo", { args: [] }),
      (current, previous, listener) => {
        if (
          isRecord(current) &&
          current.status === "connected" &&
          (!isRecord(previous) || previous.status !== "connected")
        )
          listener();
      },
    );
    supported.onWhatsAppStatus = subscribeIntegrationSnapshot(
      () => rpc("desktop.getWhatsAppInfo", { args: [] }),
      (current, _previous, listener) => {
        if (isRecord(current) && typeof current.status === "string")
          listener({ status: current.status });
      },
    );
  }

  // Desktop cron events are delivered over IPC. A browser host polls the
  // permission-filtered cron snapshot only while a subscriber is mounted and
  // synthesizes a change event so the shared Scheduled Tasks screen refreshes.
  type CronEventListener = Parameters<ElectronAPI["onCronEvent"]>[0];
  type CronStatus = Awaited<ReturnType<ElectronAPI["getCronStatus"]>>;
  type CronJobs = Awaited<ReturnType<ElectronAPI["listCronJobs"]>>;
  if (
    Object.hasOwn(session.desktopMethods ?? {}, "getCronStatus") &&
    Object.hasOwn(session.desktopMethods ?? {}, "listCronJobs")
  ) {
    const cronListeners = new Set<CronEventListener>();
    let cronPollTimer: ReturnType<typeof setInterval> | null = null;
    let cronPollInFlight = false;
    let lastCronJobs: Map<string, string> | null = null;
    let lastCronStatus: string | null = null;
    const pollCronEvents = async () => {
      if (!active || cronPollInFlight || cronListeners.size === 0) return;
      cronPollInFlight = true;
      try {
        const [status, jobs] = await Promise.all([
          rpc<CronStatus>("desktop.getCronStatus", { args: [] }),
          rpc<CronJobs>("desktop.listCronJobs", { args: [{ includeDisabled: true }] }),
        ]);
        if (!active || cronListeners.size === 0 || !Array.isArray(jobs)) return;
        const nextJobs = new Map(jobs.map((job) => [job.id, JSON.stringify(job)]));
        const nextStatus = JSON.stringify({
          enabled: status.enabled,
          jobCount: status.jobCount,
          enabledJobCount: status.enabledJobCount,
          runningJobCount: status.runningJobCount,
          maxConcurrentRuns: status.maxConcurrentRuns,
          nextWakeAtMs: status.nextWakeAtMs,
          nextWakeReason: status.nextWakeReason,
          nextWakeScheduleKind: status.nextWakeScheduleKind,
          nextWakeTimeZone: status.nextWakeTimeZone,
          scheduler: {
            profileScope: status.scheduler.profileScope,
            runnerKind: status.scheduler.runnerKind,
            state: status.scheduler.state,
            timeZone: status.scheduler.timeZone,
            runnerExclusivity: status.scheduler.runnerExclusivity,
          },
          webhookEnabled: status.webhook?.enabled,
        });
        const previousJobs = lastCronJobs;
        const previousStatus = lastCronStatus;
        lastCronJobs = nextJobs;
        lastCronStatus = nextStatus;
        if (!previousJobs) return;

        let event: CronEvent | null = null;
        for (const [jobId, serialized] of nextJobs) {
          if (!previousJobs.has(jobId)) {
            event = { jobId, action: "added" };
            break;
          }
          if (previousJobs.get(jobId) !== serialized) {
            event = { jobId, action: "updated" };
            break;
          }
        }
        if (!event) {
          for (const jobId of previousJobs.keys()) {
            if (!nextJobs.has(jobId)) {
              event = { jobId, action: "removed" };
              break;
            }
          }
        }
        if (!event && previousStatus !== nextStatus) {
          event = { jobId: "scheduler", action: "updated" };
        }
        if (!event) return;
        for (const listener of cronListeners) {
          try {
            listener(event);
          } catch {
            // One renderer subscriber must not stop other cron observers.
          }
        }
      } catch {
        // A later poll reconciles state after a transient host or network failure.
      } finally {
        cronPollInFlight = false;
      }
    };
    const stopCronPolling = () => {
      if (cronPollTimer) clearInterval(cronPollTimer);
      cronPollTimer = null;
      lastCronJobs = null;
      lastCronStatus = null;
    };
    disposeCronEventPolling = () => {
      stopCronPolling();
      cronListeners.clear();
    };
    supported.onCronEvent = (listener: CronEventListener) => {
      cronListeners.add(listener);
      if (!cronPollTimer) {
        void pollCronEvents();
        cronPollTimer = setInterval(() => void pollCronEvents(), 2_500);
      }
      return () => {
        cronListeners.delete(listener);
        if (cronListeners.size === 0) stopCronPolling();
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onCronEvent: { mutation: false },
    };
  }

  // The desktop emits queue updates through IPC. A browser host uses the same
  // queue read method and polls only while a shared-UI subscriber is mounted.
  // Do not expose a no-op subscription that leaves queue state stale.
  type QueueStatus = Awaited<ReturnType<ElectronAPI["getQueueStatus"]>>;
  type QueueUpdateListener = Parameters<ElectronAPI["onQueueUpdate"]>[0];
  if (Object.hasOwn(session.desktopMethods ?? {}, "getQueueStatus")) {
    const queueListeners = new Set<QueueUpdateListener>();
    let queuePollTimer: ReturnType<typeof setInterval> | null = null;
    let queuePollInFlight = false;
    let lastQueueStatus: string | null = null;
    disposeQueueUpdatePolling = () => {
      if (queuePollTimer) clearInterval(queuePollTimer);
      queuePollTimer = null;
      queueListeners.clear();
    };
    const pollQueueStatus = async () => {
      if (!active || queuePollInFlight || queueListeners.size === 0) return;
      queuePollInFlight = true;
      try {
        const status = await rpc<QueueStatus>("desktop.getQueueStatus", { args: [] });
        if (!active || queueListeners.size === 0) return;
        const serialized = JSON.stringify(status);
        if (serialized === lastQueueStatus) return;
        lastQueueStatus = serialized;
        for (const listener of queueListeners) {
          try {
            listener(status);
          } catch {
            // One renderer subscriber must not stop other queue observers.
          }
        }
      } catch {
        // A later poll reconciles state after transient host or network failures.
      } finally {
        queuePollInFlight = false;
      }
    };
    supported.onQueueUpdate = (listener: QueueUpdateListener) => {
      queueListeners.add(listener);
      if (!queuePollTimer) {
        void pollQueueStatus();
        queuePollTimer = setInterval(() => void pollQueueStatus(), 2_500);
      }
      return () => {
        queueListeners.delete(listener);
        if (queueListeners.size === 0 && queuePollTimer) {
          clearInterval(queuePollTimer);
          queuePollTimer = null;
        }
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onQueueUpdate: { mutation: false },
    };
  }

  if (Object.hasOwn(session.desktopMethods ?? {}, "listMailboxEvents")) {
    type MailboxEventListener = Parameters<ElectronAPI["onMailboxEvent"]>[0];
    const mailboxListeners = new Set<MailboxEventListener>();
    let mailboxPollTimer: ReturnType<typeof setInterval> | null = null;
    let mailboxPollInFlight = false;
    let lastMailboxEvent: string | null = null;
    const pollMailboxEvents = async () => {
      if (!active || mailboxPollInFlight || mailboxListeners.size === 0) return;
      mailboxPollInFlight = true;
      try {
        const events = await rpc<MailboxEvent[]>("desktop.listMailboxEvents", { args: [1] });
        if (!active || mailboxListeners.size === 0 || !Array.isArray(events)) return;
        const latest = events[0];
        const serialized = latest ? JSON.stringify(latest) : null;
        if (serialized === lastMailboxEvent) return;
        const previous = lastMailboxEvent;
        lastMailboxEvent = serialized;
        if (!previous || !latest) return;
        for (const listener of mailboxListeners) {
          try {
            listener(latest);
          } catch {
            // One renderer subscriber must not stop other mailbox observers.
          }
        }
      } catch {
        // A later poll reconciles state after a transient host or network failure.
      } finally {
        mailboxPollInFlight = false;
      }
    };
    disposeMailboxEventPolling = () => {
      if (mailboxPollTimer) clearInterval(mailboxPollTimer);
      mailboxPollTimer = null;
      mailboxListeners.clear();
      lastMailboxEvent = null;
    };
    supported.onMailboxEvent = (listener: MailboxEventListener) => {
      mailboxListeners.add(listener);
      if (!mailboxPollTimer) {
        void pollMailboxEvents();
        mailboxPollTimer = setInterval(() => void pollMailboxEvents(), 2_500);
      }
      return () => {
        mailboxListeners.delete(listener);
        if (mailboxListeners.size === 0 && mailboxPollTimer) {
          clearInterval(mailboxPollTimer);
          mailboxPollTimer = null;
          lastMailboxEvent = null;
        }
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onMailboxEvent: { mutation: false },
    };
  }

  if (Object.hasOwn(session.desktopMethods ?? {}, "getPersonalitySettingsChangeSignal")) {
    type PersonalitySettingsListener = Parameters<ElectronAPI["onPersonalitySettingsChanged"]>[0];
    const personalityListeners = new Set<PersonalitySettingsListener>();
    let personalityPollTimer: ReturnType<typeof setInterval> | null = null;
    let personalityPollInFlight = false;
    let lastPersonalitySignal: string | null = null;
    const pollPersonalitySettings = async () => {
      if (!active || personalityPollInFlight || personalityListeners.size === 0) return;
      personalityPollInFlight = true;
      try {
        const signal = await rpc<Record<string, unknown>>(
          "desktop.getPersonalitySettingsChangeSignal",
          { args: [] },
        );
        if (!active || personalityListeners.size === 0) return;
        const serialized = JSON.stringify(signal);
        if (serialized === lastPersonalitySignal) return;
        const previous = lastPersonalitySignal;
        lastPersonalitySignal = serialized;
        if (previous === null) return;
        for (const listener of personalityListeners) {
          try {
            listener(signal);
          } catch {
            // One renderer subscriber must not stop other settings observers.
          }
        }
      } catch {
        // A later poll reconciles state after a transient host or network failure.
      } finally {
        personalityPollInFlight = false;
      }
    };
    disposePersonalitySettingsPolling = () => {
      if (personalityPollTimer) clearInterval(personalityPollTimer);
      personalityPollTimer = null;
      personalityListeners.clear();
      lastPersonalitySignal = null;
    };
    supported.onPersonalitySettingsChanged = (listener: PersonalitySettingsListener) => {
      personalityListeners.add(listener);
      if (!personalityPollTimer) {
        void pollPersonalitySettings();
        personalityPollTimer = setInterval(() => void pollPersonalitySettings(), 2_500);
      }
      return () => {
        personalityListeners.delete(listener);
        if (personalityListeners.size === 0 && personalityPollTimer) {
          clearInterval(personalityPollTimer);
          personalityPollTimer = null;
          lastPersonalitySignal = null;
        }
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onPersonalitySettingsChanged: { mutation: false },
    };
  }

  if (Object.hasOwn(session.desktopMethods ?? {}, "getLLMRoutingStatus")) {
    type RoutingStatus = Awaited<ReturnType<ElectronAPI["getLLMRoutingStatus"]>>;
    type RoutingListener = Parameters<ElectronAPI["onLLMRoutingEvent"]>[0];
    const routingListeners = new Set<RoutingListener>();
    let routingPollTimer: ReturnType<typeof setInterval> | null = null;
    let routingPollInFlight = false;
    let lastRoutingStatus: string | null = null;
    const pollRoutingStatus = async () => {
      if (!active || routingPollInFlight || routingListeners.size === 0) return;
      routingPollInFlight = true;
      try {
        const status = await rpc<RoutingStatus>("desktop.getLLMRoutingStatus", { args: [] });
        if (!active || routingListeners.size === 0) return;
        const serialized = JSON.stringify(status);
        if (serialized === lastRoutingStatus) return;
        const previous = lastRoutingStatus;
        lastRoutingStatus = serialized;
        if (previous === null) return;
        for (const listener of routingListeners) {
          try {
            listener(status);
          } catch {
            // One renderer subscriber must not stop other routing observers.
          }
        }
      } catch {
        // A later poll reconciles state after a transient host or network failure.
      } finally {
        routingPollInFlight = false;
      }
    };
    disposeRoutingStatusPolling = () => {
      if (routingPollTimer) clearInterval(routingPollTimer);
      routingPollTimer = null;
      routingListeners.clear();
      lastRoutingStatus = null;
    };
    supported.onLLMRoutingEvent = (listener: RoutingListener) => {
      routingListeners.add(listener);
      if (!routingPollTimer) {
        void pollRoutingStatus();
        routingPollTimer = setInterval(() => void pollRoutingStatus(), 2_500);
      }
      return () => {
        routingListeners.delete(listener);
        if (routingListeners.size === 0 && routingPollTimer) {
          clearInterval(routingPollTimer);
          routingPollTimer = null;
          lastRoutingStatus = null;
        }
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onLLMRoutingEvent: { mutation: false },
    };
  }

  const notificationMethods = [
    "listNotifications",
    "getUnreadNotificationCount",
    "markNotificationRead",
    "markAllNotificationsRead",
    "deleteNotification",
    "deleteAllNotifications",
  ];
  let notificationSnapshot: Map<string, AppNotification> | null = null;
  let notificationPollTimer: ReturnType<typeof setInterval> | null = null;
  let notificationPollInFlight = false;
  if (notificationMethods.every((name) => Object.hasOwn(session.desktopMethods ?? {}, name))) {
    const pollNotifications = async () => {
      if (!active || notificationPollInFlight) return;
      notificationPollInFlight = true;
      try {
        const notifications = await rpc<AppNotification[]>("desktop.listNotifications", {
          args: [],
        });
        if (!Array.isArray(notifications) || !active) return;
        const next = new Map(notifications.map((notification) => [notification.id, notification]));
        const previous = notificationSnapshot;
        notificationSnapshot = next;
        if (!previous) return;

        if (previous.size > 0 && next.size === 0) {
          emitLocal("notification", { type: "cleared" } satisfies BrowserNotificationEvent);
          return;
        }
        for (const [id, notification] of previous) {
          if (!next.has(id)) {
            emitLocal("notification", {
              type: "removed",
              notification,
            } satisfies BrowserNotificationEvent);
          }
        }
        for (const [id, notification] of next) {
          const prior = previous.get(id);
          if (!prior) {
            emitLocal("notification", {
              type: "added",
              notification,
            } satisfies BrowserNotificationEvent);
          } else if (JSON.stringify(prior) !== JSON.stringify(notification)) {
            emitLocal("notification", {
              type: "updated",
              notification,
            } satisfies BrowserNotificationEvent);
          }
        }
      } catch {
        // A later poll reconciles state after a transient host or network failure.
      } finally {
        notificationPollInFlight = false;
      }
    };

    supported.onNotificationEvent = (listener: (...args: unknown[]) => void) => {
      const unsubscribe = subscribeLocal("notification")(listener);
      if (!notificationPollTimer) {
        void pollNotifications();
        notificationPollTimer = setInterval(() => void pollNotifications(), 2_500);
      }
      return () => {
        unsubscribe();
        if ((localListeners.get("notification")?.size ?? 0) === 0 && notificationPollTimer) {
          clearInterval(notificationPollTimer);
          notificationPollTimer = null;
          notificationSnapshot = null;
        }
      };
    };
    browserInfo.desktopMethods = {
      ...browserInfo.desktopMethods,
      onNotificationEvent: { mutation: false },
    };
  }

  // These optional probes are used by the shared desktop App to decide whether
  // to start Electron-only workflows. Keep them absent when the browser host
  // has no corresponding RPC, so those workflows do not start and then fail.
  const absentOptionalMethods = new Set([
    "getAppearanceRuntimeInfo",
    "getLLMConfigStatus",
    "getLLMSettings",
    "getTempWorkspace",
    "getMigrationStatus",
    "dismissMigrationNotification",
    "getQueueStatus",
    "getVoiceSettings",
    "onVoiceEvent",
    "onTrayOpenAbout",
    "infraGetStatus",
    "infraGetSettings",
    "onInfraStatusChange",
    "checkForUpdates",
    "listBotConversations",
    // Local server management is optional in ElectronAPI and currently has no
    // browser-host service. The settings UI checks the method manifest and
    // disables these controls with an explanation.
    "checkHf",
    "detectHardware",
    "startLocalAIServer",
    "stopLocalAIServer",
    "getLocalAIServerStatus",
    "getLocalAIServerLog",
    "onBrowserWorkbenchOpenRequest",
    "onNavigateToTask",
    "onNavigateToBotConversation",
  ]);
  const unsupported = new Map<string, (...args: unknown[]) => Promise<never>>();
  const unsupportedSubscriptions = new Map<string, (...args: unknown[]) => () => void>();
  const adapter = new Proxy(supported, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
      if (absentOptionalMethods.has(property)) return undefined;
      if (property.startsWith("on")) {
        let stub = unsupportedSubscriptions.get(property);
        if (!stub) {
          stub = () => {
            notifyUnsupportedAction(property);
            return noOpSubscription;
          };
          unsupportedSubscriptions.set(property, stub);
        }
        return stub;
      }
      let stub = unsupported.get(property);
      if (!stub) {
        stub = () => {
          notifyUnsupportedAction(property);
          return Promise.reject(new UnsupportedBrowserHostMethodError(property));
        };
        unsupported.set(property, stub);
      }
      return stub;
    },
  }) as unknown as ElectronAPI;

  window.electronAPI = adapter;
  window.coworkBrowserGit = browserGit;
  window.coworkBrowserHost = true;
  window.coworkBrowserHostInfo = browserInfo;

  return () => {
    if (!active) return;
    terminals.dispose();
    disposeQueueUpdatePolling();
    disposeCronEventPolling();
    for (const dispose of disposeIntegrationPolling) dispose();
    disposeMailboxEventPolling();
    disposePersonalitySettingsPolling();
    disposeRoutingStatusPolling();
    if (notificationPollTimer) clearInterval(notificationPollTimer);
    notificationPollTimer = null;
    notificationSnapshot = null;
    active = false;
    const ownsBridge = window.electronAPI === adapter;
    if (ownsBridge) {
      if (previousElectronApi) window.electronAPI = previousElectronApi;
      else Reflect.deleteProperty(window, "electronAPI");
      if (previousBrowserMarker === true) window.coworkBrowserHost = true;
      else Reflect.deleteProperty(window, "coworkBrowserHost");
    }
    if (window.coworkBrowserGit === browserGit) {
      if (previousBrowserGit) window.coworkBrowserGit = previousBrowserGit;
      else Reflect.deleteProperty(window, "coworkBrowserGit");
    }
    if (ownsBridge && window.coworkBrowserHostInfo === browserInfo) {
      if (previousBrowserInfo) window.coworkBrowserHostInfo = previousBrowserInfo;
      else Reflect.deleteProperty(window, "coworkBrowserHostInfo");
    }
    if (taskEventPollTimer) {
      clearTimeout(taskEventPollTimer);
      taskEventPollTimer = null;
    }
    taskEventListeners.clear();
    observedTaskEventScopes.clear();
    taskOffsets.clear();
    localListeners.clear();
    decisions.dispose();
    drafts.dispose();
    files.dispose();
  };
}

class InvalidBrowserHostResponseError extends Error {
  readonly code = "INVALID_REQUEST" as const;
  readonly retryable = false;

  constructor(method: string) {
    super(`The browser host returned an invalid response for ${method}.`);
    this.name = "InvalidBrowserHostResponseError";
  }
}

class StaleBrowserHostBridgeError extends Error {
  readonly code = "STALE_HOST" as const;
  readonly retryable = false;

  constructor() {
    super("This browser host session is no longer active.");
    this.name = "StaleBrowserHostBridgeError";
  }
}

class UnresolvedBrowserSessionOperationError extends Error {
  readonly code = "OUTCOME_UNKNOWN" as const;
  readonly retryable = false;

  constructor() {
    super(
      "A previous browser session has an unconfirmed task request, so this session is blocking new work. Reopen the original paired session and retry that action so CoWork can check its saved receipt. Do not clear browser storage. If you cannot access that session, ask an administrator to reconcile the request.",
    );
    this.name = "UnresolvedBrowserSessionOperationError";
  }
}

function normalizePageLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function normalizeTimelineLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 160;
  return Math.min(600, Math.max(1, Math.trunc(value)));
}

function parseTimelineHistoryCursor(value: unknown): TaskTimelinePageCursor | null {
  if (
    !isRecord(value) ||
    typeof value.order !== "number" ||
    !Number.isSafeInteger(value.order) ||
    typeof value.timestamp !== "number" ||
    !Number.isSafeInteger(value.timestamp) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 1024
  ) {
    return null;
  }
  return { order: value.order, timestamp: value.timestamp, id: value.id };
}

function summarizeTimelinePage(events: TaskEvent[]) {
  const payloadSizes = events.map((event) => utf8Size(JSON.stringify(event.payload ?? {})));
  return {
    eventCount: events.length,
    payloadBytes: payloadSizes.reduce((total, size) => total + size, 0),
    truncatedEventCount: events.filter(
      (event) => isRecord(event.payload) && event.payload.truncated === true,
    ).length,
    largestEventPayloadBytes: Math.max(0, ...payloadSizes),
  };
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function resolveTaskOffset(
  cursorId: string | undefined,
  workspaceId: string | null,
  requestedOffset: number | undefined,
  offsets: Map<string, number>,
): number {
  if (cursorId) {
    const cursorOffset = offsets.get(taskOffsetKey(workspaceId, cursorId));
    if (cursorOffset === undefined) {
      throw new UnsupportedBrowserHostMethodError("task list cursor pagination");
    }
    return cursorOffset + 1;
  }
  if (typeof requestedOffset !== "number" || !Number.isFinite(requestedOffset)) return 0;
  return Math.max(0, Math.trunc(requestedOffset));
}

function taskOffsetKey(workspaceId: string | null, taskId: string): string {
  return `${workspaceId ?? "*"}:${taskId}`;
}

function parseTaskMutationCursor(value: unknown, taskId: string): TaskMutationCursor | null {
  if (
    !isRecord(value) ||
    value.taskId !== taskId ||
    typeof value.position !== "number" ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0
  ) {
    return null;
  }
  return { taskId, position: value.position };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDefinitiveInputRejection(error: unknown): boolean {
  return (
    error instanceof WebTransportError &&
    !error.retryable &&
    ["INVALID_REQUEST", "STALE_STATE", "FORBIDDEN", "UNSUPPORTED_CAPABILITY"].includes(error.code)
  );
}

class BrowserProviderNotReadyError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY" as const;
  readonly retryable = false;

  constructor() {
    super(
      "Choose and configure a model provider in Settings → AI & Models before starting a task.",
    );
    this.name = "BrowserProviderNotReadyError";
  }
}

async function getOrCreatePendingOperation(
  storageKey: string,
  fingerprint: string,
): Promise<PendingOperation> {
  const existing = readStoredOperation(storageKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error(
        "A previous browser request is still unconfirmed. Reconcile it before sending different content.",
      );
    }
    return existing;
  }
  const operation: PendingOperation = { key: createOperationKey(), fingerprint };
  writePendingOperation(storageKey, operation);
  return operation;
}

function readStoredOperation(storageKey: string): PendingOperation | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    throw new Error("This browser cannot access local storage. The host was not sent a request.");
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("A saved browser request key is invalid. The host was not sent a request.");
  }
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !OPERATION_KEY_RE.test(value.key) ||
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint)
  ) {
    throw new Error("A saved browser request key is invalid. The host was not sent a request.");
  }
  return { key: value.key, fingerprint: value.fingerprint };
}

function readPendingCancellation(storageKey: string): PendingCancellation | null {
  const operation = readStoredOperation(storageKey);
  if (!operation) return null;
  let value: unknown;
  try {
    value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
  } catch {
    throw new Error("The saved cancellation request is invalid. The host was not sent a request.");
  }
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== "string" ||
    !isTaskStatus(value.expectedStatus) ||
    !isValidTimestamp(value.expectedUpdatedAt)
  ) {
    throw new Error("The saved cancellation request is invalid. The host was not sent a request.");
  }
  return {
    ...operation,
    workspaceId: value.workspaceId,
    expectedStatus: value.expectedStatus,
    expectedUpdatedAt: value.expectedUpdatedAt,
  };
}

function writePendingOperation(
  storageKey: string,
  operation: PendingOperation | PendingCancellation,
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(operation));
  } catch {
    throw new Error("This tab could not save the request key. The host was not sent a request.");
  }
}

function clearPendingOperation(storageKey: string, operationKey: string): void {
  try {
    const current = readStoredOperation(storageKey);
    if (!current || current.key !== operationKey) return;
    window.localStorage.removeItem(storageKey);
  } catch {
    // A confirmed operation can safely remain in storage: its receipt will be
    // reconciled before any later request can reuse the key.
  }
}

function createOperationKey(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("This browser cannot create a stable host request key.");
  }
  return crypto.randomUUID();
}

async function fingerprintPayload(payload: unknown): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("This browser cannot safely reconcile host requests.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function operationStorageKey(
  session: WebSessionBootstrap,
  sessionScope: string,
  method: "create" | "follow-up" | "cancel" | "decision" | "desktop" | "git",
  scope: string,
): string {
  return `cowork:browser-host:${session.host.installationId}:${session.host.profileId}:${sessionScope}:${method}:${scope}`;
}

async function verifyBrowserOperationSession(
  session: WebSessionBootstrap,
  currentScope: string,
): Promise<boolean> {
  const profilePrefix = `cowork:browser-host:${session.host.installationId}:${session.host.profileId}:`;
  const sessionKey = `${profilePrefix}session`;
  const activeOperationPrefix = `${profilePrefix}${currentScope}:`;
  try {
    const previousScope = window.localStorage.getItem(sessionKey);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        !key ||
        !key.startsWith(profilePrefix) ||
        key === sessionKey ||
        key.startsWith(activeOperationPrefix)
      ) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
        if (
          isRecord(value) &&
          typeof value.key === "string" &&
          OPERATION_KEY_RE.test(value.key) &&
          typeof value.fingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(value.fingerprint)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (previousScope !== currentScope) window.localStorage.setItem(sessionKey, currentScope);
    return true;
  } catch {
    return false;
  }
}

function parseTaskCreateRequest(value: unknown): {
  title: string;
  prompt: string;
  workspaceId: string;
  generateTitle?: true;
  agentConfig?: Record<string, unknown>;
  assignedAgentRoleId?: string;
  images?: unknown[];
} {
  if (!isRecord(value)) throw new Error("Task creation requires a title, prompt, and workspace.");
  const allowed = new Set([
    "title",
    "prompt",
    "workspaceId",
    "generateTitle",
    "assignedAgentRoleId",
    "agentConfig",
    "images",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new UnsupportedBrowserHostMethodError("advanced task creation options");
  }
  if (value.generateTitle !== undefined && value.generateTitle !== true) {
    throw new UnsupportedBrowserHostMethodError("task title generation options");
  }
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 5))
    throw new Error("Attach up to five visual files per message.");
  if (value.agentConfig !== undefined && !isRecord(value.agentConfig))
    throw new Error("Invalid task options.");
  if (
    value.assignedAgentRoleId !== undefined &&
    (typeof value.assignedAgentRoleId !== "string" || value.assignedAgentRoleId.length > 128)
  )
    throw new Error("Invalid assigned agent.");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  if (
    !title ||
    title.length > 200 ||
    !prompt ||
    prompt.length > 64_000 ||
    !workspaceId ||
    workspaceId.length > 128
  ) {
    throw new Error("Task title, instructions, or workspace is invalid.");
  }
  return {
    title,
    prompt,
    workspaceId,
    ...(Array.isArray(value.images) && value.images.length ? { images: value.images } : {}),
    ...(value.generateTitle === true ? { generateTitle: true as const } : {}),
    ...(value.agentConfig ? { agentConfig: value.agentConfig as Record<string, unknown> } : {}),
    ...(value.assignedAgentRoleId
      ? { assignedAgentRoleId: value.assignedAgentRoleId as string }
      : {}),
  };
}

async function taskFromAdmission(
  value: unknown,
  request: { title: string; prompt: string; workspaceId: string },
  getTask: (taskId: string) => Promise<Task | null>,
): Promise<Task | null> {
  if (!isRecord(value)) throw new InvalidBrowserHostResponseError("task admission receipt");
  if (value.found === false) return null;
  const taskId = typeof value.taskId === "string" ? value.taskId : undefined;
  if (!taskId) throw new InvalidBrowserHostResponseError("task admission receipt");
  try {
    const detail = await getTask(taskId);
    if (detail && detail.id === taskId && detail.workspaceId === request.workspaceId) return detail;
  } catch {
    // The admission receipt remains the authoritative fallback when detail
    // hydration is temporarily unavailable.
  }
  const summary = isRecord(value.task) ? value.task : null;
  if (
    !summary ||
    summary.id !== taskId ||
    summary.workspaceId !== request.workspaceId ||
    typeof summary.status !== "string" ||
    typeof summary.createdAt !== "number" ||
    typeof summary.updatedAt !== "number"
  ) {
    throw new InvalidBrowserHostResponseError("task admission receipt");
  }
  return {
    id: taskId,
    title: typeof summary.title === "string" ? summary.title : request.title,
    prompt: request.prompt,
    status: summary.status as Task["status"],
    workspaceId: request.workspaceId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  } as Task;
}

function isSupportedFollowUpOptions(options: unknown): boolean {
  if (options === undefined || options === null) return true;
  if (!isRecord(options)) return false;
  const allowed = new Set([
    "interactionMode",
    "returnOnAccepted",
    "messageId",
    "deliveryMode",
    "accessProfileId",
    "integrationMentions",
    "permissionMode",
    "shellAccess",
    "expectedTurnId",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) return false;
  if (options.returnOnAccepted !== undefined && options.returnOnAccepted !== true) return false;
  if (options.deliveryMode !== undefined && options.deliveryMode !== "follow_up") return false;
  if (options.messageId !== undefined && typeof options.messageId !== "string") return false;
  if (options.accessProfileId !== undefined && typeof options.accessProfileId !== "string")
    return false;
  if (
    options.permissionMode !== undefined &&
    !["default", "plan", "dangerous_only"].includes(String(options.permissionMode))
  )
    return false;
  if (options.shellAccess !== undefined && options.shellAccess !== false) return false;
  if (options.integrationMentions !== undefined && !Array.isArray(options.integrationMentions))
    return false;
  if (
    options.expectedTurnId !== undefined &&
    (typeof options.expectedTurnId !== "string" ||
      !options.expectedTurnId ||
      options.expectedTurnId.length > 200)
  )
    return false;
  if (
    options.interactionMode !== undefined &&
    (!isRecord(options.interactionMode) ||
      !["smart", "chat"].includes(String(options.interactionMode.mode)))
  )
    return false;
  return true;
}

function parseFollowUpReceipt(value: unknown): FollowUpReceipt {
  if (
    !isRecord(value) ||
    typeof value.found !== "boolean" ||
    (value.state !== "admitted" && value.state !== "pending" && value.state !== "unavailable")
  ) {
    throw new InvalidBrowserHostResponseError("task.followUp.receipt");
  }
  if (
    value.deliveryStatus !== undefined &&
    value.deliveryStatus !== "accepted" &&
    value.deliveryStatus !== "queued" &&
    value.deliveryStatus !== "started"
  ) {
    throw new InvalidBrowserHostResponseError("task.followUp.receipt");
  }
  return {
    found: value.found,
    state: value.state,
    ...(value.deliveryStatus ? { deliveryStatus: value.deliveryStatus } : {}),
    ...(typeof value.acceptedAt === "number" ? { acceptedAt: value.acceptedAt } : {}),
    ...(typeof value.queuedAt === "number" ? { queuedAt: value.queuedAt } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
  };
}

function followUpResult(
  receipt: FollowUpReceipt,
): Awaited<ReturnType<ElectronAPI["sendMessage"]>> | null {
  if (!receipt.found) return null;
  if (receipt.state === "unavailable") {
    throw new Error(
      "The host could not deliver this follow-up. Review the message before retrying.",
    );
  }
  return {
    queued: receipt.state === "pending",
    deliveryMode: "follow_up",
    deliveryStatus: receipt.state === "pending" ? "queued" : "accepted",
    ...(receipt.acceptedAt !== undefined ? { acceptedAt: receipt.acceptedAt } : {}),
  };
}

function parseCancellationResult(
  value: unknown,
  taskId: string,
  workspaceId: string,
  operationKey: string,
): CancellationResult {
  if (
    !isRecord(value) ||
    value.taskId !== taskId ||
    value.workspaceId !== workspaceId ||
    value.operationKey !== operationKey ||
    (value.outcome !== "observed_terminal" && value.outcome !== "pending") ||
    !isTaskStatus(value.status) ||
    !isValidTimestamp(value.updatedAt) ||
    (value.outcome === "observed_terminal" && !TERMINAL_TASK_STATUSES.has(value.status)) ||
    (value.outcome === "pending" && TERMINAL_TASK_STATUSES.has(value.status))
  ) {
    throw new InvalidBrowserHostResponseError("task.cancel");
  }
  return {
    taskId,
    workspaceId,
    operationKey,
    outcome: value.outcome,
    status: value.status,
    updatedAt: value.updatedAt,
  };
}

function isTaskStatus(value: unknown): value is Task["status"] {
  return (
    value === "pending" ||
    value === "queued" ||
    value === "planning" ||
    value === "executing" ||
    value === "paused" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function readBrowserAppearance(storageKey: string): Partial<AppearanceSettings> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? sanitizeBrowserAppearance(value) : {};
  } catch {
    return {};
  }
}

function sanitizeBrowserAppearance(value: Record<string, unknown>): Partial<AppearanceSettings> {
  const result: Partial<AppearanceSettings> = {};
  if (value.themeMode === "light" || value.themeMode === "dark" || value.themeMode === "system") {
    result.themeMode = value.themeMode;
  }
  if (
    value.visualTheme === "terminal" ||
    value.visualTheme === "warm" ||
    value.visualTheme === "oblivion" ||
    value.visualTheme === "calm"
  ) {
    result.visualTheme = value.visualTheme;
  }
  if (
    value.accentColor === "cyan" ||
    value.accentColor === "blue" ||
    value.accentColor === "purple" ||
    value.accentColor === "pink" ||
    value.accentColor === "rose" ||
    value.accentColor === "orange" ||
    value.accentColor === "green" ||
    value.accentColor === "teal" ||
    value.accentColor === "coral"
  ) {
    result.accentColor = value.accentColor;
  }
  if (typeof value.transparencyEffectsEnabled === "boolean") {
    result.transparencyEffectsEnabled = value.transparencyEffectsEnabled;
  }
  if (value.uiDensity === "focused" || value.uiDensity === "full" || value.uiDensity === "power") {
    result.uiDensity = value.uiDensity;
  }
  if (value.timelineVerbosity === "summary" || value.timelineVerbosity === "verbose") {
    result.timelineVerbosity = value.timelineVerbosity;
  }
  if (value.commandOutputStyle === "terminal" || value.commandOutputStyle === "minimal") {
    result.commandOutputStyle = value.commandOutputStyle;
  }
  if (typeof value.homeResearchVaultEnabled === "boolean") {
    result.homeResearchVaultEnabled = value.homeResearchVaultEnabled;
  }
  if (typeof value.homeNextActionsEnabled === "boolean") {
    result.homeNextActionsEnabled = value.homeNextActionsEnabled;
  }
  if (typeof value.language === "string" && value.language.length <= 64) {
    result.language = value.language;
  }
  if (typeof value.disclaimerAccepted === "boolean") {
    result.disclaimerAccepted = value.disclaimerAccepted;
  }
  if (typeof value.onboardingCompleted === "boolean") {
    result.onboardingCompleted = value.onboardingCompleted;
  }
  if (typeof value.onboardingCompletedAt === "string" && value.onboardingCompletedAt.length <= 64) {
    result.onboardingCompletedAt = value.onboardingCompletedAt;
  }
  if (typeof value.assistantName === "string" && value.assistantName.length <= 100) {
    result.assistantName = value.assistantName;
  }
  return result;
}

function noOpSubscription(): () => void {
  return () => undefined;
}

function notifyUnsupportedAction(method: string): void {
  if (typeof window.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(BROWSER_HOST_UNSUPPORTED_ACTION_EVENT, { detail: { method } }),
  );
}

function toBrowserTaskSummary(value: unknown): BrowserTaskSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new InvalidBrowserHostResponseError("task.list");
  }
  const optionalFields = [
    "parentTaskId",
    "agentType",
    "depth",
    "assignedAgentRoleId",
    "boardColumn",
    "priority",
    "labels",
    "dueDate",
    "pinned",
    "sessionArchived",
    "sessionId",
    "source",
  ] as const;
  return {
    id: value.id,
    title: value.title,
    status: value.status as Task["status"],
    workspaceId: value.workspaceId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    // The list RPC intentionally omits prompt content. Empty is a safe summary
    // value; selecting a task loads its authorized detail through desktop.task.get.
    prompt: "",
    ...Object.fromEntries(
      optionalFields
        .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
        .map((field) => [field, value[field]]),
    ),
  } as BrowserTaskSummary;
}
