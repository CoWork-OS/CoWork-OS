import { afterEach, describe, expect, it, vi } from "vitest";

const handle = vi.fn();
vi.mock("electron", () => ({ ipcMain: { handle: (...args: unknown[]) => handle(...args) } }));

import { IPC_CHANNELS } from "../../../shared/types";
import {
  ATTENTION_DAEMON_EVENTS,
  createAttentionIpcHandlers,
  setupAttentionHandlers,
} from "../attention-handlers";

const snapshot = { generatedAt: 1, items: [], failedSources: [] };

afterEach(() => {
  handle.mockReset();
  vi.useRealTimers();
});

describe("attention IPC", () => {
  it("returns the snapshot and rejects arguments", async () => {
    const service = { snapshot: vi.fn(async () => snapshot) };
    const handlers = createAttentionIpcHandlers({ service });
    expect(Object.keys(handlers)).toEqual([IPC_CHANNELS.ATTENTION_LIST]);
    await expect(handlers[IPC_CHANNELS.ATTENTION_LIST](undefined)).resolves.toBe(snapshot);
    await expect(handlers[IPC_CHANNELS.ATTENTION_LIST]({ limit: 5 })).rejects.toThrow(
      "takes no arguments",
    );
    expect(service.snapshot).toHaveBeenCalledOnce();
  });

  it("signals the window once after a burst of daemon events", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const send = vi.fn();
    setupAttentionHandlers({
      service: { snapshot: async () => snapshot },
      events: { on: (event: string, listener: () => void) => listeners.set(event, listener) },
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });
    expect(handle).toHaveBeenCalledWith(IPC_CHANNELS.ATTENTION_LIST, expect.any(Function));
    expect([...listeners.keys()]).toEqual([...ATTENTION_DAEMON_EVENTS]);
    listeners.get("approval_requested")!();
    listeners.get("task_status")!();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.ATTENTION_CHANGED);
  });
});
