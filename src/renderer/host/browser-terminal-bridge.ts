import type { ElectronAPI } from "../../electron/preload";
import type {
  ShellSessionInfo,
  ShellSessionStatus,
  Task,
  TerminalTabOutputEvent,
  Workspace,
} from "../../shared/types";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import type { BrowserHostTransport } from "../../renderer-web/transport";
import { isTempWorkspaceId } from "../../shared/types";

const REPLAY_LIMIT = 16 * 1024;
const POLL_INTERVAL_MS = 350;
const TERMINAL_STATUS = new Set<ShellSessionStatus>([
  "inactive",
  "active",
  "running",
  "resetting",
  "ended",
  "fallback",
]);
const DEFINITIVE_MUTATION_ERRORS = new Set([
  "INVALID_REQUEST",
  "FORBIDDEN",
  "UNSUPPORTED_CAPABILITY",
  "STALE_STATE",
  "CONFLICT",
  "RATE_LIMITED",
]);

type Rpc = <T = unknown>(
  method: string,
  params: unknown,
  options?: Parameters<BrowserHostTransport["request"]>[2],
) => Promise<T>;

export interface BrowserTerminalBridgeOptions {
  rpc: Rpc;
  listWorkspaces(): Promise<Workspace[]>;
  getTask(taskId: string): Promise<Task | null>;
  session: WebSessionBootstrap;
  isActive(): boolean;
  createOperationKey?: () => string;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

type BrowserTerminalMethods = Pick<
  ElectronAPI,
  | "listTerminalTabs"
  | "createTerminalTab"
  | "writeTerminalTabInput"
  | "resizeTerminalTab"
  | "stopTerminalTab"
  | "closeTerminalTab"
  | "onTerminalTabOutput"
>;

export interface BrowserTerminalBridge {
  methods: BrowserTerminalMethods;
  dispose(): void;
}

interface TerminalScope {
  workspaceId: string;
  taskId: string;
}

interface Attachment {
  scope: TerminalScope;
  tabId: string;
  attachmentId: string;
  cursor: number;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastCwd?: string;
  lastStatus?: ShellSessionStatus;
}

interface PendingMutation {
  fingerprint: string;
  operationKey: string;
}

interface RpcTab extends ShellSessionInfo {
  scopeTaskId: string;
}

/**
 * Exposes only the shared desktop terminal-tab controls backed by the paired
 * browser host's scoped PTY service. The host chooses workspace-root cwd and
 * the bridge intentionally provides no arbitrary-command API.
 */
export function createBrowserTerminalBridge(
  options: BrowserTerminalBridgeOptions,
): BrowserTerminalBridge {
  const attachments = new Map<string, Attachment>();
  const attachmentPromises = new Map<string, Promise<Attachment>>();
  const knownTabs = new Map<string, RpcTab>();
  const outputListeners = new Set<(event: TerminalTabOutputEvent) => void>();
  const pendingMutations = new Map<string, PendingMutation>();
  let disposed = false;

  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const createOperationKey = options.createOperationKey ?? (() => crypto.randomUUID());

  const ensureActive = () => {
    if (disposed || !options.isActive()) throw new Error("This browser session has ended.");
  };

  const authorizeScope = async (workspaceIdValue: unknown, taskIdValue: unknown) => {
    ensureActive();
    const workspaceId = requireId(workspaceIdValue, "workspaceId");
    const taskId = requireId(taskIdValue, "taskId");
    const [workspaces, task] = await Promise.all([
      options.listWorkspaces(),
      options.getTask(taskId),
    ]);
    ensureActive();
    const workspace = workspaces.find(
      (candidate) =>
        candidate.id === workspaceId && !candidate.isTemp && !isTempWorkspaceId(candidate.id),
    );
    if (!workspace || !task || task.id !== taskId || task.workspaceId !== workspace.id) {
      throw new Error("Terminal access is unavailable for this task and workspace.");
    }
    return { workspace, task, scope: { workspaceId, taskId } as TerminalScope };
  };

  const rpc = async <T>(method: string, params: unknown, operationKey?: string): Promise<T> => {
    ensureActive();
    return options.rpc<T>(method, params, {
      ...(operationKey ? { operationKey, mutation: true } : {}),
      timeoutMs: 120_000,
    });
  };

  const mutationKey = (method: string, scope: TerminalScope, resourceId = "") =>
    `${method}:${scope.workspaceId}:${scope.taskId}:${resourceId}`;

  const mutate = async <T>(
    method: string,
    params: Record<string, unknown>,
    scope: TerminalScope,
    resourceId = "",
    retrySameUnknown = false,
  ): Promise<T> => {
    const slot = mutationKey(method, scope, resourceId);
    const fingerprint = JSON.stringify(params);
    let pending = retrySameUnknown ? pendingMutations.get(slot) : undefined;
    if (pending && pending.fingerprint !== fingerprint) {
      throw new Error(
        "A previous terminal action is unconfirmed. Retry it before changing the request.",
      );
    }
    if (!pending) pending = { fingerprint, operationKey: createOperationKey() };
    if (retrySameUnknown) pendingMutations.set(slot, pending);
    try {
      const result = await rpc<T>(method, params, pending.operationKey);
      if (pendingMutations.get(slot) === pending) pendingMutations.delete(slot);
      return result;
    } catch (error) {
      if (hasDefinitiveError(error) && pendingMutations.get(slot) === pending) {
        pendingMutations.delete(slot);
      }
      throw error;
    }
  };

  const parseTab = (value: unknown, scope: TerminalScope): RpcTab => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !value.id ||
      value.workspaceId !== scope.workspaceId ||
      value.scopeTaskId !== scope.taskId ||
      typeof value.taskId !== "string" ||
      value.scope !== "tab" ||
      typeof value.cwd !== "string" ||
      typeof value.status !== "string" ||
      !TERMINAL_STATUS.has(value.status as ShellSessionStatus) ||
      typeof value.retained !== "boolean" ||
      !Number.isSafeInteger(value.commandCount) ||
      !Array.isArray(value.aliases) ||
      !value.aliases.every((item) => typeof item === "string") ||
      !Array.isArray(value.envKeys) ||
      !value.envKeys.every((item) => typeof item === "string") ||
      !isFiniteNumber(value.createdAt) ||
      !isFiniteNumber(value.updatedAt)
    ) {
      throw new InvalidBrowserTerminalResponseError("terminal tab");
    }
    return { ...(value as unknown as ShellSessionInfo), scopeTaskId: scope.taskId };
  };

  const registerAttachment = (raw: unknown, scope: TerminalScope, tabId?: string): Attachment => {
    if (
      !isRecord(raw) ||
      typeof raw.attachmentId !== "string" ||
      !raw.attachmentId ||
      typeof raw.writer !== "boolean" ||
      !isSafeInteger(raw.nextOffset) ||
      raw.nextOffset < 0
    ) {
      throw new InvalidBrowserTerminalResponseError("terminal attachment");
    }
    const tab = rememberTab(parseTab(raw.tab, scope));
    if (tabId && tab.id !== tabId)
      throw new InvalidBrowserTerminalResponseError("terminal attachment scope");
    const key = knownTabKey(scope.workspaceId, scope.taskId, tab.id);
    const attachment: Attachment = {
      scope,
      tabId: tab.id,
      attachmentId: raw.attachmentId,
      cursor: 0,
      polling: false,
      timer: null,
      lastCwd: tab.cwd,
      lastStatus: tab.status,
    };
    attachments.set(key, attachment);
    schedulePoll(attachment, 0);
    return attachment;
  };

  const rememberTab = (tab: RpcTab) => {
    knownTabs.set(knownTabKey(tab.workspaceId, tab.scopeTaskId, tab.id), tab);
    return tab;
  };

  const requireKnownTab = (scope: TerminalScope, tabIdValue: unknown): RpcTab => {
    const tabId = requireId(tabIdValue, "tabId");
    const tab = knownTabs.get(knownTabKey(scope.workspaceId, scope.taskId, tabId));
    if (!tab) throw new Error("This terminal tab is unavailable in the current task.");
    return tab;
  };

  const ensureAttachment = async (scope: TerminalScope, tabId: string): Promise<Attachment> => {
    ensureActive();
    const key = knownTabKey(scope.workspaceId, scope.taskId, tabId);
    const existing = attachments.get(key);
    if (existing) return existing;
    const pending = attachmentPromises.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const response = await mutate<unknown>(
        "terminal.attach",
        { ...scope, tabId },
        scope,
        tabId,
        true,
      );
      ensureActive();
      // Replay from offset zero so retained host output is delivered to xterm.
      return registerAttachment(response, scope, tabId);
    })().finally(() => attachmentPromises.delete(key));
    attachmentPromises.set(key, promise);
    return promise;
  };

  const emit = (attachment: Attachment, event: TerminalTabOutputEvent) => {
    if (disposed || !options.isActive()) return;
    const owned = attachments.get(
      knownTabKey(attachment.scope.workspaceId, attachment.scope.taskId, attachment.tabId),
    );
    if (owned !== attachment) return;
    for (const listener of outputListeners) listener(event);
  };

  const schedulePoll = (attachment: Attachment, delayMs = POLL_INTERVAL_MS) => {
    if (
      disposed ||
      attachment.timer ||
      outputListeners.size === 0 ||
      attachments.get(
        knownTabKey(attachment.scope.workspaceId, attachment.scope.taskId, attachment.tabId),
      ) !== attachment
    ) {
      return;
    }
    attachment.timer = schedule(() => {
      attachment.timer = null;
      void poll(attachment);
    }, delayMs);
  };

  const poll = async (attachment: Attachment) => {
    if (
      disposed ||
      attachment.polling ||
      outputListeners.size === 0 ||
      attachments.get(
        knownTabKey(attachment.scope.workspaceId, attachment.scope.taskId, attachment.tabId),
      ) !== attachment
    ) {
      return;
    }
    attachment.polling = true;
    let hasMore = false;
    try {
      const response = await rpc<unknown>("terminal.replay", {
        ...attachment.scope,
        attachmentId: attachment.attachmentId,
        afterOffset: attachment.cursor,
        limit: REPLAY_LIMIT,
      });
      if (!isRecord(response) || !Array.isArray(response.chunks)) {
        throw new InvalidBrowserTerminalResponseError("terminal.replay");
      }
      const tab = rememberTab(parseTab(response.tab, attachment.scope));
      if (
        !isSafeInteger(response.nextOffset) ||
        response.nextOffset < attachment.cursor ||
        typeof response.hasMore !== "boolean"
      ) {
        throw new InvalidBrowserTerminalResponseError("terminal.replay");
      }

      if (
        isRecord(response.gap) &&
        isSafeInteger(response.gap.from) &&
        isSafeInteger(response.gap.to) &&
        response.gap.to > response.gap.from
      ) {
        emit(attachment, {
          tabId: attachment.tabId,
          workspaceId: attachment.scope.workspaceId,
          stream: "stdout",
          output: "\r\n[Earlier terminal output was omitted.]\r\n",
          timestamp: now(),
        });
      }

      for (const rawChunk of response.chunks) {
        if (
          !isRecord(rawChunk) ||
          !isSafeInteger(rawChunk.offset) ||
          typeof rawChunk.text !== "string" ||
          rawChunk.stream !== "stdout" ||
          typeof rawChunk.cwd !== "string" ||
          typeof rawChunk.status !== "string" ||
          !TERMINAL_STATUS.has(rawChunk.status as ShellSessionStatus)
        ) {
          throw new InvalidBrowserTerminalResponseError("terminal.replay chunk");
        }
        emit(attachment, {
          tabId: attachment.tabId,
          workspaceId: attachment.scope.workspaceId,
          stream: rawChunk.stream,
          output: rawChunk.text,
          cwd: rawChunk.cwd,
          status: rawChunk.status as ShellSessionStatus,
          timestamp: now(),
        });
      }
      attachment.cursor = response.nextOffset;
      hasMore = response.hasMore;
      if (attachment.lastCwd !== tab.cwd || attachment.lastStatus !== tab.status) {
        emit(attachment, {
          tabId: attachment.tabId,
          workspaceId: attachment.scope.workspaceId,
          stream: "stdout",
          output: "",
          cwd: tab.cwd,
          status: tab.status,
          timestamp: now(),
        });
      }
      attachment.lastCwd = tab.cwd;
      attachment.lastStatus = tab.status;
    } catch (error) {
      // A stale or revoked attachment cannot recover by polling. Leave the tab
      // visible, but stop hammering the host; a new explicit attach will retry.
      if (hasDefinitiveError(error)) {
        const key = knownTabKey(
          attachment.scope.workspaceId,
          attachment.scope.taskId,
          attachment.tabId,
        );
        forgetAttachment(key, attachment, true);
      }
    } finally {
      attachment.polling = false;
      if (!disposed && attachments.size && outputListeners.size > 0) {
        schedulePoll(attachment, hasMore ? 0 : POLL_INTERVAL_MS);
      }
    }
  };

  const listTerminalTabs: BrowserTerminalMethods["listTerminalTabs"] = async (
    workspaceId,
    taskId,
  ) => {
    const { scope } = await authorizeScope(workspaceId, taskId);
    const response = await rpc<unknown>("terminal.list", scope);
    if (
      !isRecord(response) ||
      response.workspaceId !== scope.workspaceId ||
      response.taskId !== scope.taskId ||
      !Array.isArray(response.tabs)
    ) {
      throw new InvalidBrowserTerminalResponseError("terminal.list");
    }
    const tabs = response.tabs.map((value) => rememberTab(parseTab(value, scope)));
    const activeKeys = new Set(
      tabs.map((tab) => knownTabKey(scope.workspaceId, scope.taskId, tab.id)),
    );
    for (const key of knownTabs.keys()) {
      const keyScope = parseKnownTabKey(key);
      if (
        keyScope?.workspaceId === scope.workspaceId &&
        keyScope.taskId === scope.taskId &&
        !activeKeys.has(key)
      ) {
        knownTabs.delete(key);
        const attachment = attachments.get(key);
        if (attachment) forgetAttachment(key, attachment, true);
      }
    }
    return tabs as ShellSessionInfo[];
  };

  const createTerminalTab: BrowserTerminalMethods["createTerminalTab"] = async (data) => {
    if (Object.prototype.hasOwnProperty.call(data, "cwd")) {
      throw new Error("Browser terminals always start at the workspace root.");
    }
    const { scope } = await authorizeScope(data.workspaceId, data.taskId);
    const params = { ...scope, ...(data.title ? { title: data.title } : {}) };
    const response = await mutate<unknown>("terminal.open", params, scope, "open", true);
    const attachment = registerAttachment(response, scope);
    const tab = knownTabs.get(knownTabKey(scope.workspaceId, scope.taskId, attachment.tabId));
    if (!tab) throw new InvalidBrowserTerminalResponseError("terminal.open");
    return tab as ShellSessionInfo;
  };

  const writeTerminalTabInput: BrowserTerminalMethods["writeTerminalTabInput"] = async (data) => {
    const { scope } = await authorizeScope(data.workspaceId, data.taskId);
    const tab = requireKnownTab(scope, data.tabId);
    const attachment = await ensureAttachment(scope, tab.id);
    const response = await mutate<unknown>(
      "terminal.input",
      { ...scope, attachmentId: attachment.attachmentId, input: data.input },
      scope,
      // Input represents keystrokes. Do not reuse a key for separate equal
      // strings such as two deliberate repeated characters.
      `input:${tab.id}:${createOperationKey()}`,
    );
    if (!isRecord(response) || response.accepted !== true || !isSafeInteger(response.nextOffset)) {
      throw new InvalidBrowserTerminalResponseError("terminal.input");
    }
    return rememberTab(parseTab(response.tab, scope)) as ShellSessionInfo;
  };

  const resizeTerminalTab: BrowserTerminalMethods["resizeTerminalTab"] = async (data) => {
    const { scope } = await authorizeScope(data.workspaceId, data.taskId);
    const tab = requireKnownTab(scope, data.tabId);
    const attachment = await ensureAttachment(scope, tab.id);
    const response = await mutate<unknown>(
      "terminal.resize",
      { ...scope, attachmentId: attachment.attachmentId, cols: data.cols, rows: data.rows },
      scope,
      `resize:${tab.id}:${createOperationKey()}`,
    );
    if (!isRecord(response) || !isSafeInteger(response.cols) || !isSafeInteger(response.rows)) {
      throw new InvalidBrowserTerminalResponseError("terminal.resize");
    }
    return rememberTab(parseTab(response.tab, scope)) as ShellSessionInfo;
  };

  const stopTerminalTab: BrowserTerminalMethods["stopTerminalTab"] = async (data) => {
    const { scope } = await authorizeScope(data.workspaceId, data.taskId);
    const tab = requireKnownTab(scope, data.tabId);
    const attachment = await ensureAttachment(scope, tab.id);
    const response = await mutate<unknown>(
      "terminal.stop",
      { ...scope, attachmentId: attachment.attachmentId },
      scope,
      `stop:${tab.id}`,
      true,
    );
    if (response === null) return null;
    return rememberTab(parseTab(response, scope)) as ShellSessionInfo;
  };

  const closeTerminalTab: BrowserTerminalMethods["closeTerminalTab"] = async (data) => {
    const { scope } = await authorizeScope(data.workspaceId, data.taskId);
    const tab = requireKnownTab(scope, data.tabId);
    const attachment = await ensureAttachment(scope, tab.id);
    const params = { ...scope, attachmentId: attachment.attachmentId };
    const response = await mutate<unknown>(
      "terminal.close",
      params,
      scope,
      `close:${tab.id}`,
      true,
    );
    if (!isRecord(response) || response.closed !== true) {
      throw new InvalidBrowserTerminalResponseError("terminal.close");
    }
    knownTabs.delete(knownTabKey(scope.workspaceId, scope.taskId, tab.id));
    forgetAttachment(knownTabKey(scope.workspaceId, scope.taskId, tab.id), attachment, false);
    return { success: true };
  };

  const onTerminalTabOutput: BrowserTerminalMethods["onTerminalTabOutput"] = (listener) => {
    ensureActive();
    outputListeners.add(listener);
    if (outputListeners.size === 1) {
      for (const attachment of attachments.values()) schedulePoll(attachment, 0);
    }
    return () => {
      outputListeners.delete(listener);
      if (outputListeners.size === 0) {
        for (const attachment of attachments.values()) {
          if (attachment.timer) cancelSchedule(attachment.timer);
          attachment.timer = null;
        }
      }
    };
  };

  function forgetAttachment(key: string, attachment: Attachment, detach: boolean): void {
    if (attachments.get(key) !== attachment) return;
    attachments.delete(key);
    if (attachment.timer) cancelSchedule(attachment.timer);
    attachment.timer = null;
    if (detach && !disposed && options.isActive()) {
      void mutate(
        "terminal.detach",
        { ...attachment.scope, attachmentId: attachment.attachmentId },
        attachment.scope,
        `detach:${attachment.tabId}:${createOperationKey()}`,
      ).catch(() => undefined);
    }
  }

  const methods: BrowserTerminalMethods = {
    listTerminalTabs,
    createTerminalTab,
    writeTerminalTabInput,
    resizeTerminalTab,
    stopTerminalTab,
    closeTerminalTab,
    onTerminalTabOutput,
  };

  return {
    methods,
    dispose() {
      if (disposed) return;
      disposed = true;
      outputListeners.clear();
      for (const [key, attachment] of attachments) {
        if (attachment.timer) cancelSchedule(attachment.timer);
        if (options.isActive()) {
          void options
            .rpc(
              "terminal.detach",
              {
                ...attachment.scope,
                attachmentId: attachment.attachmentId,
              },
              {
                operationKey: createOperationKey(),
                mutation: true,
                timeoutMs: 120_000,
              },
            )
            .catch(() => undefined);
        }
        attachments.delete(key);
      }
      attachmentPromises.clear();
      knownTabs.clear();
      pendingMutations.clear();
    },
  };
}

class InvalidBrowserTerminalResponseError extends Error {
  readonly code = "INVALID_REQUEST" as const;
  readonly retryable = false;

  constructor(method: string) {
    super(`The browser host returned an invalid response for ${method}.`);
    this.name = "InvalidBrowserTerminalResponseError";
  }
}

function knownTabKey(workspaceId: string, taskId: string, tabId: string): string {
  return JSON.stringify([workspaceId, taskId, tabId]);
}

function parseKnownTabKey(value: string): { workspaceId: string; taskId: string } | null {
  try {
    const parts: unknown = JSON.parse(value);
    if (
      Array.isArray(parts) &&
      typeof parts[0] === "string" &&
      typeof parts[1] === "string" &&
      typeof parts[2] === "string"
    ) {
      return { workspaceId: parts[0], taskId: parts[1] };
    }
  } catch {
    return null;
  }
  return null;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`A valid ${field} is required for browser terminal access.`);
  }
  return value.trim();
}

function hasDefinitiveError(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && DEFINITIVE_MUTATION_ERRORS.has(error.code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
