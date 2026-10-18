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
  taskIds: Set<string>;
  pending: Map<string, { taskId: string; output: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
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

  const flush = (watcher: Watcher) => {
    if (watcher.flushTimer) clearTimeout(watcher.flushTimer);
    watcher.flushTimer = null;
    if (watcher.sender.isDestroyed()) return;
    for (const [tabId, entry] of watcher.pending) {
      const outputEvent: AgentTerminalEvent = {
        kind: "output",
        taskId: entry.taskId,
        tabId,
        output: entry.output,
      };
      watcher.sender.send(IPC_CHANNELS.AGENT_TERMINAL_EVENT, outputEvent);
    }
    watcher.pending.clear();
  };

  const watch = (sender: WebContents, taskId: string) => {
    let watcher = watchers.get(sender.id);
    if (!watcher) {
      const created: Watcher = { sender, taskIds: new Set(), pending: new Map(), flushTimer: null };
      watchers.set(sender.id, created);
      sender.once("destroyed", () => {
        if (created.flushTimer) clearTimeout(created.flushTimer);
        watchers.delete(sender.id);
      });
      watcher = created;
    }
    watcher.taskIds.delete(taskId);
    watcher.taskIds.add(taskId);
    while (watcher.taskIds.size > MAX_WATCHED_TASKS_PER_WINDOW) {
      const oldest = watcher.taskIds.values().next().value;
      if (oldest === undefined) break;
      watcher.taskIds.delete(oldest);
    }
  };

  manager.subscribe((change) => {
    for (const watcher of watchers.values()) {
      if (!watcher.taskIds.has(change.taskId) || watcher.sender.isDestroyed()) continue;
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
      watcher.sender.send(IPC_CHANNELS.AGENT_TERMINAL_EVENT, event);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_TERMINAL_LIST,
    async (event, data: unknown): Promise<AgentTerminalTab[]> => {
      const request = validateInput(AgentTerminalListRequestSchema, data, "agent terminal list");
      await deps.authorizeTask(event, request.taskId, "view");
      watch(event.sender, request.taskId);
      return manager
        .list(request.taskId)
        .sort((a, b) => a.started_at - b.started_at)
        .map((process) => toAgentTerminalTab(request.taskId, process));
    },
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_TERMINAL_READ, async (event, data: unknown) => {
    const request = validateInput(AgentTerminalTabRequestSchema, data, "agent terminal read");
    await deps.authorizeTask(event, request.taskId, "view");
    watch(event.sender, request.taskId);
    // The buffer already holds output not yet flushed to this window, and the window ignores
    // a tab's output until this reply arrives; output after this point follows the reply.
    watchers.get(event.sender.id)?.pending.delete(request.tabId);
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
