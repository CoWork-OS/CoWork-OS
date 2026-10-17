import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS, type AgentTerminalEvent } from "../../../shared/types";
import { BackgroundProcessManager } from "../../agent/tools/background-processes";

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { setupAgentTerminalHandlers } from "../agent-terminal-handlers";

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_TASK_ID = "550e8400-e29b-41d4-a716-446655440001";

function fakeSender(id = 7) {
  const sender = new EventEmitter() as EventEmitter & {
    id: number;
    sent: AgentTerminalEvent[];
    isDestroyed: () => boolean;
    send: (channel: string, event: AgentTerminalEvent) => void;
  };
  sender.id = id;
  sender.sent = [];
  sender.isDestroyed = () => false;
  sender.send = (channel, event) => {
    expect(channel).toBe(IPC_CHANNELS.AGENT_TERMINAL_EVENT);
    sender.sent.push(event);
  };
  return sender;
}

function startProcess(manager: BackgroundProcessManager, taskId = TASK_ID) {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    pid: 99,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
  });
  const summary = manager.start({
    taskId,
    command: "cloudflared tunnel --url http://127.0.0.1:8790",
    title: "https tunnel",
    cwd: "/w",
    launch: {
      child,
      sandboxType: "none",
      reachableFromHost: true,
      signalTree: (signal) => {
        if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      },
    },
    normalizeChunk: (chunk) => chunk,
    redact: (text) => text.replace(/hunter2/g, "[REDACTED]"),
  });
  return { child, summary };
}

const handler = (channel: string) => registeredHandlers.get(channel)!;
const flushOutput = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("agent terminal IPC handlers", () => {
  let manager: BackgroundProcessManager;
  let authorizeTask: ReturnType<typeof vi.fn>;
  let recordAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registeredHandlers.clear();
    manager = new BackgroundProcessManager();
    authorizeTask = vi.fn(async () => undefined);
    recordAction = vi.fn(async () => undefined);
    setupAgentTerminalHandlers({ manager, authorizeTask, recordAction });
  });

  it("lists a task's processes as tabs after checking view access", async () => {
    const { summary } = startProcess(manager);
    startProcess(manager, OTHER_TASK_ID);
    const sender = fakeSender();

    const tabs = await handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender }, { taskId: TASK_ID });

    expect(authorizeTask).toHaveBeenCalledWith({ sender }, TASK_ID, "view");
    expect(tabs).toEqual([
      expect.objectContaining({
        id: summary.process_id,
        taskId: TASK_ID,
        title: "https tunnel",
        status: "running",
        exitCode: null,
      }),
    ]);
    await manager.stopAll("test");
  });

  it("rejects malformed task and tab ids", async () => {
    const sender = fakeSender();
    await expect(
      handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender }, { taskId: "../etc" }),
    ).rejects.toThrow();
    await expect(
      handler(IPC_CHANNELS.AGENT_TERMINAL_READ)({ sender }, { taskId: TASK_ID, tabId: "tab:1" }),
    ).rejects.toThrow();
    expect(authorizeTask).not.toHaveBeenCalled();
  });

  it("propagates an authorization refusal before reading anything", async () => {
    const { summary } = startProcess(manager);
    authorizeTask.mockRejectedValueOnce(new Error("not a member"));
    await expect(
      handler(IPC_CHANNELS.AGENT_TERMINAL_READ)(
        { sender: fakeSender() },
        { taskId: TASK_ID, tabId: summary.process_id },
      ),
    ).rejects.toThrow("not a member");
    await manager.stopAll("test");
  });

  it("streams batched, redacted output only to windows that listed the task", async () => {
    const { child, summary } = startProcess(manager);
    const watching = fakeSender(1);
    const other = fakeSender(2);
    await handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender: watching }, { taskId: TASK_ID });
    await handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender: other }, { taskId: OTHER_TASK_ID });

    child.stdout!.emit("data", "token hunter2\n");
    child.stdout!.emit("data", "ready\n");
    await flushOutput();
    child.emit("exit", 0, null);

    expect(watching.sent).toEqual([
      {
        kind: "output",
        taskId: TASK_ID,
        tabId: summary.process_id,
        output: "token [REDACTED]\nready\n",
      },
      {
        kind: "status",
        taskId: TASK_ID,
        tab: expect.objectContaining({ id: summary.process_id, status: "exited", exitCode: 0 }),
      },
    ]);
    expect(other.sent).toEqual([]);
  });

  it("returns the buffer on read and drops output that buffer already holds", async () => {
    const { child, summary } = startProcess(manager);
    const sender = fakeSender();
    await handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender }, { taskId: TASK_ID });

    child.stdout!.emit("data", "first\n");
    const read = await handler(IPC_CHANNELS.AGENT_TERMINAL_READ)(
      { sender },
      { taskId: TASK_ID, tabId: summary.process_id },
    );
    child.stdout!.emit("data", "second\n");
    await flushOutput();

    expect(read).toEqual({ output: "first\n", truncated: false });
    expect(sender.sent).toEqual([
      { kind: "output", taskId: TASK_ID, tabId: summary.process_id, output: "second\n" },
    ]);
    await manager.stopAll("test");
  });

  it("stops and closes with manage access and an audit record", async () => {
    const { summary } = startProcess(manager);
    const sender = fakeSender();
    const request = { taskId: TASK_ID, tabId: summary.process_id };

    const stopped = await handler(IPC_CHANNELS.AGENT_TERMINAL_STOP)({ sender }, request);
    expect(stopped).toMatchObject({ id: summary.process_id, status: "stopped" });
    expect(manager.summary(TASK_ID, summary.process_id).stop_reason).toBe("stopped_by_user");

    await handler(IPC_CHANNELS.AGENT_TERMINAL_CLOSE)({ sender }, request);
    expect(manager.list(TASK_ID)).toEqual([]);

    expect(authorizeTask.mock.calls.map((call) => call[2])).toEqual(["manage", "manage"]);
    expect(recordAction.mock.calls.map((call) => call[2])).toEqual([
      "agent_process_stop",
      "agent_process_close",
    ]);
  });

  it("forgets a window once it is destroyed", async () => {
    const { child } = startProcess(manager);
    const sender = fakeSender();
    await handler(IPC_CHANNELS.AGENT_TERMINAL_LIST)({ sender }, { taskId: TASK_ID });
    sender.emit("destroyed");

    child.stdout!.emit("data", "after\n");
    await flushOutput();
    expect(sender.sent).toEqual([]);
    await manager.stopAll("test");
  });
});
