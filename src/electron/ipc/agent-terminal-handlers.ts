import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { IPC_CHANNELS, type AgentTerminalEvent, type AgentTerminalTab } from "../../shared/types";
import {
  getBackgroundProcessManager,
  type BackgroundProcessManager,
  type BackgroundProcessSummary,
} from "../agent/tools/background-processes";
import {
  AgentTerminalListRequestSchema,
  AgentTerminalTabRequestSchema,
  validateInput,
} from "../utils/validation";

/** How often streamed output is sent to a window, so a flood of output stays one event. */
const OUTPUT_FLUSH_MS = 60;
/** Tasks one window keeps hearing about; the oldest is dropped beyond this. */
const MAX_WATCHED_TASKS_PER_WINDOW = 20;

export type AgentTerminalHandlerDeps = {
  /** Current trusted client binding; never supplied by a renderer request. */
  principalForEvent: (event: IpcMainInvokeEvent) => string;
  /** Throws when the sender may not act on the task with that capability. */
  authorizeTask: (
    event: IpcMainInvokeEvent,
    taskId: string,
    capability: "view" | "manage",
  ) => Promise<unknown>;
  /** Records a stop or close in the conversation's audit log. */
  recordAction: (
    event: IpcMainInvokeEvent,
    taskId: string,
    action: "agent_process_stop" | "agent_process_close",
    tabId: string,
  ) => Promise<void>;
  manager?: BackgroundProcessManager;
};

type Watcher = {
  sender: WebContents;
  event: IpcMainInvokeEvent;
  principalId: string;
  taskIds: Set<string>;
  taskGenerations: Map<string, number>;
  generation: number;
  pending: Map<string, { taskId: string; output: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  delivery: Promise<void>;
  queued: number;
  readVersions: Map<string, { taskId: string; version: number }>;
  onDestroyed: () => void;
};

export function toAgentTerminalTab(
  taskId: string,
  process: BackgroundProcessSummary,
): AgentTerminalTab {
  return {
    id: process.process_id,
    taskId,
    title: process.title,
    command: process.command,
    cwd: process.cwd,
    status: process.running ? "running" : process.status === "stopped" ? "stopped" : "exited",
    exitCode: process.exit_code,
    startedAt: process.started_at,
  };
}

/**
 * Register the handlers behind the agent's tabs in the terminal panel: one read-only tab per
 * background process the agent started with run_command background: true.
 *
 * The window can only watch, stop and close processes the agent already started through the
 * normal run_command approval, policy and sandbox path; it cannot start one or write to it.
 * Listing and reading need view access to the conversation, stopping and closing need manage
 * access and are recorded in its audit log. Output reaches only windows that listed the task.
 */
export function setupAgentTerminalHandlers(deps: AgentTerminalHandlerDeps): void {
  const manager = deps.manager ?? getBackgroundProcessManager();
  const watchers = new Map<number, Watcher>();

  const dropTask = (watcher: Watcher, taskId: string) => {
    watcher.taskIds.delete(taskId);
    watcher.taskGenerations.delete(taskId);
    for (const [tabId, entry] of watcher.pending)
      if (entry.taskId === taskId) watcher.pending.delete(tabId);
    for (const [tabId, entry] of watcher.readVersions)
      if (entry.taskId === taskId) watcher.readVersions.delete(tabId);
  };
  const dropWatcher = (watcher: Watcher) => {
    if (watcher.flushTimer) clearTimeout(watcher.flushTimer);
    watcher.flushTimer = null;
    watcher.pending.clear();
    watcher.taskIds.clear();
    watcher.taskGenerations.clear();
    watcher.readVersions.clear();
    watcher.sender.removeListener("destroyed", watcher.onDestroyed);
    if (watchers.get(watcher.sender.id) === watcher) watchers.delete(watcher.sender.id);
  };
  const current = (watcher: Watcher) => {
    if (watchers.get(watcher.sender.id) !== watcher) return false;
    if (
      watcher.sender.isDestroyed() ||
      deps.principalForEvent(watcher.event) !== watcher.principalId
    ) {
      dropWatcher(watcher);
      return false;
    }
    return true;
  };
  const canDeliver = async (watcher: Watcher, taskId: string, generation: number | undefined) => {
    if (
      !current(watcher) ||
      !watcher.taskIds.has(taskId) ||
      watcher.taskGenerations.get(taskId) !== generation
    )
      return false;
    try {
      await deps.authorizeTask(watcher.event, taskId, "view");
    } catch {
      dropTask(watcher, taskId);
      return false;
    }
    return (
      current(watcher) &&
      watcher.taskIds.has(taskId) &&
      watcher.taskGenerations.get(taskId) === generation
    );
  };
  const enqueue = (watcher: Watcher, deliver: () => Promise<void>) => {
    // A stalled authority lookup must not retain an unbounded output queue.
    if (++watcher.queued > MAX_WATCHED_TASKS_PER_WINDOW * 2) {
      dropWatcher(watcher);
      return;
    }
    watcher.delivery = watcher.delivery
      .then(deliver)
      .catch(() => dropWatcher(watcher))
      .finally(() => {
        watcher.queued--;
      });
  };

  const flush = (watcher: Watcher) => {
    if (watcher.flushTimer) clearTimeout(watcher.flushTimer);
    watcher.flushTimer = null;
    const batch = Array.from(watcher.pending, ([tabId, entry]) => ({
      tabId,
      ...entry,
      version: watcher.readVersions.get(tabId)?.version ?? 0,
      generation: watcher.taskGenerations.get(entry.taskId),
    }));
    watcher.pending.clear();
    if (!batch.length) return;
    enqueue(watcher, async () => {
      for (const entry of batch) {
        if (!(await canDeliver(watcher, entry.taskId, entry.generation))) continue;
        if ((watcher.readVersions.get(entry.tabId)?.version ?? 0) !== entry.version) continue;
        watcher.sender.send(IPC_CHANNELS.AGENT_TERMINAL_EVENT, {
          kind: "output",
          taskId: entry.taskId,
          tabId: entry.tabId,
          output: entry.output,
        } satisfies AgentTerminalEvent);
      }
    });
  };

  const watch = (event: IpcMainInvokeEvent, taskId: string, principalId: string) => {
    const sender = event.sender;
    let watcher = watchers.get(sender.id);
    if (watcher && !current(watcher)) watcher = undefined;
    if (!watcher) {
      const created: Watcher = {
        sender,
        event,
        principalId,
        taskIds: new Set(),
        taskGenerations: new Map(),
        generation: 0,
        pending: new Map(),
        flushTimer: null,
        delivery: Promise.resolve(),
        queued: 0,
        readVersions: new Map(),
        onDestroyed: () => dropWatcher(created),
      };
      watchers.set(sender.id, created);
      sender.once("destroyed", created.onDestroyed);
      watcher = created;
    }
    watcher.taskIds.delete(taskId);
    watcher.taskIds.add(taskId);
    if (!watcher.taskGenerations.has(taskId))
      watcher.taskGenerations.set(taskId, ++watcher.generation);
    while (watcher.taskIds.size > MAX_WATCHED_TASKS_PER_WINDOW) {
      const oldest = watcher.taskIds.values().next().value;
      if (oldest === undefined) break;
      dropTask(watcher, oldest);
    }
  };

  manager.subscribe((change) => {
    for (const watcher of watchers.values()) {
      if (!current(watcher) || !watcher.taskIds.has(change.taskId)) continue;
      if (change.kind === "output") {
        const entry = watcher.pending.get(change.processId);
        if (entry) entry.output += change.output;
        else
          watcher.pending.set(change.processId, { taskId: change.taskId, output: change.output });
        watcher.flushTimer ??= setTimeout(() => flush(watcher), OUTPUT_FLUSH_MS);
        continue;
      }
      // Output that arrived before a status change is sent first, so the tab ends in order.
      flush(watcher);
      const event: AgentTerminalEvent =
        change.kind === "status"
          ? {
              kind: "status",
              taskId: change.taskId,
              tab: toAgentTerminalTab(change.taskId, change.process),
            }
          : { kind: "removed", taskId: change.taskId, tabId: change.processId };
      const generation = watcher.taskGenerations.get(change.taskId);
      enqueue(watcher, async () => {
        if (!(await canDeliver(watcher, change.taskId, generation))) return;
        watcher.sender.send(IPC_CHANNELS.AGENT_TERMINAL_EVENT, event);
        if (change.kind === "removed") watcher.readVersions.delete(change.processId);
      });
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TERMINAL_LIST,
    async (event, data: unknown): Promise<AgentTerminalTab[]> => {
      const request = validateInput(AgentTerminalListRequestSchema, data, "agent terminal list");
      const principalId = deps.principalForEvent(event);
      await deps.authorizeTask(event, request.taskId, "view");
      if (deps.principalForEvent(event) !== principalId)
        throw new Error("Terminal client identity changed");
      watch(event, request.taskId, principalId);
      return manager
        .list(request.taskId)
        .sort((a, b) => a.started_at - b.started_at)
        .map((process) => toAgentTerminalTab(request.taskId, process));
    },
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_TERMINAL_READ, async (event, data: unknown) => {
    const request = validateInput(AgentTerminalTabRequestSchema, data, "agent terminal read");
    const principalId = deps.principalForEvent(event);
    await deps.authorizeTask(event, request.taskId, "view");
    if (deps.principalForEvent(event) !== principalId)
      throw new Error("Terminal client identity changed");
    watch(event, request.taskId, principalId);
    // The buffer already holds output not yet flushed to this window, and the window ignores
    // a tab's output until this reply arrives; output after this point follows the reply.
    watchers.get(event.sender.id)?.pending.delete(request.tabId);
    const watcher = watchers.get(event.sender.id)!;
    watcher.readVersions.set(request.tabId, {
      taskId: request.taskId,
      version: (watcher.readVersions.get(request.tabId)?.version ?? 0) + 1,
    });
    return manager.peek(request.taskId, request.tabId);
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TERMINAL_STOP,
    async (event, data: unknown): Promise<AgentTerminalTab> => {
      const request = validateInput(AgentTerminalTabRequestSchema, data, "agent terminal stop");
      await deps.authorizeTask(event, request.taskId, "manage");
      await deps.recordAction(event, request.taskId, "agent_process_stop", request.tabId);
      const summary = await manager.stop(request.taskId, request.tabId, "stopped_by_user");
      return toAgentTerminalTab(request.taskId, summary);
    },
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_TERMINAL_CLOSE, async (event, data: unknown) => {
    const request = validateInput(AgentTerminalTabRequestSchema, data, "agent terminal close");
    await deps.authorizeTask(event, request.taskId, "manage");
    await deps.recordAction(event, request.taskId, "agent_process_close", request.tabId);
    await manager.remove(request.taskId, request.tabId, "tab_closed_by_user");
    return { success: true };
  });
}
