import type { ElectronAPI } from "../../electron/preload";
import type { AppearanceSettings, Task, TaskEvent, Workspace } from "../../shared/types";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import { BrowserHostTransport, webEndpoint } from "../../renderer-web/transport";
import { createBrowserComposerDraftBridge } from "./browser-composer-draft-bridge";
import { createBrowserFileBridge } from "./browser-file-bridge";
import { createBrowserDecisionBridge } from "./browser-decision-bridge";
import { createBrowserTerminalBridge } from "./browser-terminal-bridge";

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
  deliveryStatus?: "accepted" | "queued";
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

const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
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
  const previousBrowserMarker = window.coworkBrowserHost;
  const previousBrowserInfo = window.coworkBrowserHostInfo;
  const browserInfo = {
    providerReady: session.providerReady,
    activeWorkspaceId: session.activeWorkspaceId,
    desktopMethods: session.desktopMethods,
  };
  const appearanceStorageKey = `cowork:browser-appearance:${session.host.installationId}:${session.host.profileId}`;
  let active = true;
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
    method: "create" | "follow-up" | "cancel" | "decision" | "desktop",
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

  const getTaskEvents = async (taskId: string): Promise<TaskEvent[]> => {
    const task = await getTask(taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    const response = await rpc<TaskEventsResponse>("task.events.snapshot", {
      taskId,
      workspaceId: task.workspaceId,
      limit: 600,
    });
    if (!isRecord(response) || !Array.isArray(response.events)) {
      throw new InvalidBrowserHostResponseError("task.events.snapshot");
    }
    const events = response.events as TaskEvent[];
    const hydratedEvents = await Promise.all(
      events.map((event) => decisions.hydrateTaskEvent(event)),
    );
    const cursor = parseTaskMutationCursor(response.cursor, task.id);
    if (cursor) {
      observedTaskEventScopes.delete(task.id);
      observedTaskEventScopes.set(task.id, {
        taskId: task.id,
        workspaceId: task.workspaceId,
        cursor,
        knownEventIds: new Set(hydratedEvents.flatMap((event) => (event.id ? [event.id] : []))),
      });
      while (observedTaskEventScopes.size > 8) {
        const oldest = observedTaskEventScopes.keys().next().value as string | undefined;
        if (!oldest) break;
        observedTaskEventScopes.delete(oldest);
      }
      scheduleTaskEventPoll();
    }
    return hydratedEvents;
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
    const request = parseTaskCreateRequest(data);
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
    if (
      (images && images.length > 0) ||
      quotedAssistantMessage ||
      !isSupportedFollowUpOptions(options)
    ) {
      throw new UnsupportedBrowserHostMethodError("attachments or advanced follow-up options");
    }
    const cleanMessage = typeof message === "string" ? message.trim() : "";
    if (!cleanMessage || cleanMessage.length > 64_000) {
      throw new Error("A follow-up message between 1 and 64,000 characters is required.");
    }
    const task = await getTask(taskId);
    if (!task) throw new Error("This task is unavailable to the browser session.");
    const request = {
      taskId: task.id,
      workspaceId: task.workspaceId,
      message: cleanMessage,
      ...(options?.interactionMode ? { interactionMode: options.interactionMode } : {}),
      ...(options?.accessProfileId ? { accessProfileId: options.accessProfileId } : {}),
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options?.shellAccess !== undefined ? { shellAccess: options.shellAccess } : {}),
    };
    const storageKey = await getOperationStorageKey("follow-up", `${task.workspaceId}:${task.id}`);
    const fingerprint = await fingerprintPayload(request);
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
    getNativeFrameMode: () => false,
    getAppearanceSettings,
    saveAppearanceSettings,
    listWorkspaces,
    selectWorkspace,
    listTasks,
    listSidebarTasks: listTasks,
    getTask,
    getTaskEvents,
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
  }
  browserInfo.desktopMethods = {
    ...browserInfo.desktopMethods,
    ...Object.fromEntries(
      [
        ...(session.capabilities["files.read"]?.available ? ["listBrowserWorkspaceFiles"] : []),
        ...(session.capabilities["artifacts.read"]?.available
          ? ["listBrowserTaskArtifacts", "createBrowserArtifactDownload"]
          : []),
      ].map((name) => [name, { mutation: name === "createBrowserArtifactDownload" }]),
    ),
  };
  const files = createBrowserFileBridge({ session, listWorkspaces, isActive: () => active });
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
    emitLocal("llm");
  };

  for (const [name, descriptor] of Object.entries(session.desktopMethods ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(name) || name === "constructor") continue;
    supported[name] = async (...args: unknown[]) => {
      while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
      const omittedArgs = args.flatMap((arg, index) => (arg === undefined ? [index] : []));
      const params = { args, ...(omittedArgs.length ? { omittedArgs } : {}) };
      let operation: PendingOperation | null = null;
      let storageKey: string | null = null;
      if (descriptor.mutation) {
        storageKey = await getOperationStorageKey("desktop", name);
        operation = await getOrCreatePendingOperation(storageKey, await fingerprintPayload(params));
      }
      try {
        const result = await rpc(`desktop.${name}`, params, {
          ...(operation ? { operationKey: operation.key, mutation: true } : {}),
          timeoutMs: 120_000,
        });
        if (storageKey && operation) clearPendingOperation(storageKey, operation.key);
        if (name === "saveLLMSettings" || name === "setLLMProvider" || name === "setLLMModel") {
          await refreshProviderReadiness();
        }
        return result;
      } catch (error) {
        if (
          storageKey &&
          operation &&
          [
            "INVALID_REQUEST",
            "FORBIDDEN",
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
    "checkForUpdates",
    "listBotConversations",
    "getTaskEventDetail",
    "getTaskTimelinePage",
  ]);
  const unsupported = new Map<string, (...args: unknown[]) => Promise<never>>();
  const adapter = new Proxy(supported, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
      if (absentOptionalMethods.has(property)) return undefined;
      if (property.startsWith("on")) return noOpSubscription;
      let stub = unsupported.get(property);
      if (!stub) {
        stub = () => Promise.reject(new UnsupportedBrowserHostMethodError(property));
        unsupported.set(property, stub);
      }
      return stub;
    },
  }) as unknown as ElectronAPI;

  window.electronAPI = adapter;
  window.coworkBrowserHost = true;
  window.coworkBrowserHostInfo = browserInfo;

  return () => {
    if (!active) return;
    terminals.dispose();
    active = false;
    const ownsBridge = window.electronAPI === adapter;
    if (ownsBridge) {
      if (previousElectronApi) window.electronAPI = previousElectronApi;
      else Reflect.deleteProperty(window, "electronAPI");
      if (previousBrowserMarker === true) window.coworkBrowserHost = true;
      else Reflect.deleteProperty(window, "coworkBrowserHost");
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

class BrowserProviderNotReadyError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY" as const;
  readonly retryable = false;

  constructor() {
    super("This CoWork host does not currently have a model provider ready.");
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
  method: "create" | "follow-up" | "cancel" | "decision" | "desktop",
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
  if (!isEmptyArray(value.images)) throw new UnsupportedBrowserHostMethodError("image task input");
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
  if (!isEmptyArray(options.integrationMentions)) return false;
  if (
    options.interactionMode !== undefined &&
    (!isRecord(options.interactionMode) ||
      !["smart", "chat"].includes(String(options.interactionMode.mode)))
  )
    return false;
  return true;
}

function isEmptyArray(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
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
    value.deliveryStatus !== "queued"
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
