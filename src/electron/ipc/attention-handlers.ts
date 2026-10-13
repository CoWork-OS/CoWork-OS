/**
 * Shared "needs you" queue IPC. `attention:list` returns the snapshot; it takes no arguments
 * and rejects any it is given. `attention:changed` is a payload-free signal sent to the
 * renderer after task, approval and question events, so surfaces reload the snapshot
 * instead of trusting pushed data.
 */
import { ipcMain, type BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { createDebouncedSignal, type AttentionService } from "../attention/AttentionService";

/** Daemon events after which the queue may have changed. */
export const ATTENTION_DAEMON_EVENTS = [
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "approval_wait_cleared",
  "input_request_created",
  "input_request_dismissed",
  "input_request_submitted",
  "task_status",
  "task_paused",
  "task_resumed",
  "task_completed",
  "task_cancelled",
] as const;

export interface AttentionIpcDeps {
  service: Pick<AttentionService, "snapshot">;
}

type Handler = (raw: unknown) => Promise<unknown>;

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createAttentionIpcHandlers(deps: AttentionIpcDeps): Record<string, Handler> {
  return {
    [IPC_CHANNELS.ATTENTION_LIST]: async (raw) => {
      if (raw !== undefined && raw !== null) {
        throw new Error("attention:list takes no arguments");
      }
      return deps.service.snapshot();
    },
  };
}

interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface AttentionSetupDeps extends AttentionIpcDeps {
  /** The daemon, whose task, approval and question events can change the queue. */
  events: EventSource;
  getMainWindow: () => BrowserWindow | null;
}

let sharedService: Pick<AttentionService, "snapshot"> | null = null;

/** The queue the desktop app serves, so the browser host on the same profile can read it. */
export function getAttentionService(): Pick<AttentionService, "snapshot"> | null {
  return sharedService;
}

/** Registers the handlers and starts signalling changes. Returns the change trigger. */
export function setupAttentionHandlers(deps: AttentionSetupDeps): { notifyChanged: () => void } {
  sharedService = deps.service;
  const handlers = createAttentionIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
  const signal = createDebouncedSignal(() => {
    const window = deps.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.ATTENTION_CHANGED);
    }
  });
  for (const event of ATTENTION_DAEMON_EVENTS) deps.events.on(event, signal.trigger);
  return { notifyChanged: signal.trigger };
}
