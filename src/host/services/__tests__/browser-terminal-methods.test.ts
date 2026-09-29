import { describe, expect, it, vi } from "vitest";
import type { ShellSessionInfo, Task, Workspace } from "../../../shared/types";
import type { TerminalPtyManager } from "../../../electron/terminal/TerminalPtyManager";
import type { WebRequestContext } from "../../web/WebApplication";
import { BrowserTerminalAttachmentService } from "../browser-terminal-methods";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/work/project",
  createdAt: 1,
  permissions: { shell: true },
} as Workspace;
const task = { id: "task-1", workspaceId: workspace.id } as Task;
const task2 = { id: "task-2", workspaceId: workspace.id } as Task;

interface FakeOutputState {
  output: string;
  offset: number;
  nextOffset: number;
}

function terminalTab(id = "tab:workspace-1:tab-1"): ShellSessionInfo {
  return {
    id,
    taskId: "tab-token",
    workspaceId: workspace.id,
    scope: "tab",
    cwd: "/private/work/path",
    status: "active",
    retained: true,
    commandCount: 0,
    aliases: [],
    envKeys: [],
    createdAt: 1,
    updatedAt: 2,
    lastCommand: "private command text",
  };
}

function context(sessionId = "session-1", operationKey?: string): WebRequestContext {
  return {
    audience: "web-access",
    identity: {
      installationId: "installation-1",
      profileId: "profile-1",
      generation: "generation-1",
      runtime: "node",
      platform: "linux",
      appVersion: "1.0.0",
    },
    sessionId,
    ...(operationKey ? { operationKey } : {}),
  };
}

function harness(options: { allowShell?: boolean; task?: Task } = {}) {
  let clock = 1_000;
  let idCounter = 0;
  const tabs = new Map<string, ShellSessionInfo>();
  const streams = new Map<string, FakeOutputState>();
  const listeners = new Map<
    string,
    { tabId: string; listener: Parameters<TerminalPtyManager["attachTerminalTabOutput"]>[2] }
  >();
  const tab = terminalTab();
  let browserOwnedTabId: string | null = null;
  tabs.set(tab.id, tab);
  streams.set(tab.id, { output: "", offset: 0, nextOffset: 0 });

  const terminal = {
    createTab: vi.fn(
      (params: { workspaceId: string; workspacePath: string; cwd?: string; title?: string }) => {
        const created = terminalTab(`tab:${params.workspaceId}:opened-${tabs.size}`);
        created.cwd = params.cwd ?? params.workspacePath;
        created.lastCommand = params.title;
        tabs.set(created.id, created);
        streams.set(created.id, { output: "", offset: 0, nextOffset: 0 });
        return { ...created };
      },
    ),
    listTabs: vi.fn((workspaceId?: string) =>
      [...tabs.values()].filter(
        (candidate) => !workspaceId || candidate.workspaceId === workspaceId,
      ),
    ),
    attachTerminalTabOutput: vi.fn(
      (
        tabId: string,
        listenerKey: string,
        listener: Parameters<TerminalPtyManager["attachTerminalTabOutput"]>[2],
      ) => {
        listeners.set(listenerKey, { tabId, listener });
        const stream = streams.get(tabId)!;
        if (stream.output) {
          const snapshot = { ...stream };
          queueMicrotask(() => {
            if (listeners.get(listenerKey)?.listener === listener) {
              listener({
                stream: "stdout",
                output: snapshot.output,
                offset: snapshot.offset,
                nextOffset: snapshot.nextOffset,
                cwd: "/private/work/path",
                status: "active",
              });
            }
          });
        }
        return { ...tabs.get(tabId)! };
      },
    ),
    detachTerminalTabOutput: vi.fn((tabId: string, listenerKey: string) => {
      if (listeners.get(listenerKey)?.tabId !== tabId) return false;
      return listeners.delete(listenerKey);
    }),
    writeToTab: vi.fn((tabId: string) => {
      const value = tabs.get(tabId)!;
      value.commandCount += 1;
      value.status = "running";
      return { ...value };
    }),
    resizeTab: vi.fn((tabId: string) => ({ ...tabs.get(tabId)! })),
    stopTab: vi.fn((tabId: string) => {
      const tab = tabs.get(tabId);
      if (!tab) return null;
      tab.status = "inactive";
      return { ...tab };
    }),
    closeTab: vi.fn((tabId: string) => {
      const closed = tabs.get(tabId) ?? null;
      tabs.delete(tabId);
      streams.delete(tabId);
      return closed ? { ...closed, status: "ended" as const } : null;
    }),
  };
  const sources = {
    getWorkspace: vi.fn(async (id: string) => (id === workspace.id ? workspace : null)),
    getTask: vi.fn(async (id: string) => {
      if (id === task.id) return options.task ?? task;
      if (id === task2.id) return task2;
      if (id === "task-other") return { id, workspaceId: "workspace-other" } as Task;
      return null;
    }),
    assertShellAllowed: vi.fn(async () => {
      if (options.allowShell === false) throw new Error("denied");
    }),
    terminal: terminal as unknown as Pick<
      TerminalPtyManager,
      | "createTab"
      | "listTabs"
      | "attachTerminalTabOutput"
      | "detachTerminalTabOutput"
      | "writeToTab"
      | "resizeTab"
      | "stopTab"
      | "closeTab"
    >,
    now: () => clock,
    createAttachmentId: () => `attachment-${++idCounter}`,
  };
  const service = new BrowserTerminalAttachmentService(sources);
  const methods = service.methods();

  const call = async <T = unknown>(
    name: string,
    params: unknown,
    requestContext = context(),
  ): Promise<T> => {
    const method = methods[name];
    if (!method) throw new Error(`Missing method ${name}`);
    const parsed = method.validateParams ? method.validateParams(params) : params;
    return (await method.handler(requestContext, parsed)) as T;
  };

  const emit = (tabId: string, output: string) => {
    const stream = streams.get(tabId)!;
    const offset = stream.nextOffset;
    stream.output += output;
    stream.nextOffset += output.length;
    const maxReplay = 256 * 1024;
    if (stream.output.length > maxReplay) {
      stream.output = stream.output.slice(-maxReplay);
      stream.offset = stream.nextOffset - stream.output.length;
    }
    for (const registration of listeners.values()) {
      if (registration.tabId === tabId) {
        registration.listener({
          stream: "stdout",
          output,
          offset,
          nextOffset: stream.nextOffset,
          cwd: "/private/work/path",
          status: "active",
        });
      }
    }
  };

  return {
    methods,
    service,
    call,
    sources,
    terminal,
    tabs,
    emit,
    setNow: (value: number) => (clock = value),
    get browserOwnedTabId() {
      return browserOwnedTabId;
    },
    set browserOwnedTabId(value: string | null) {
      browserOwnedTabId = value;
    },
  };
}

async function attach(
  h: ReturnType<typeof harness>,
  requestContext = context("session-1", "attach-0001"),
  params?: unknown,
) {
  if (!params && !h.browserOwnedTabId) {
    const opened = await h.call<{ attachmentId: string; tab: ShellSessionInfo }>(
      "terminal.open",
      { workspaceId: workspace.id, taskId: task.id },
      context("session-1", "open-default-01"),
    );
    h.browserOwnedTabId = opened.tab.id;
    if (requestContext.sessionId === "session-1") return opened;
  }
  const resolvedParams = params ?? {
    workspaceId: workspace.id,
    taskId: task.id,
    tabId: h.browserOwnedTabId,
  };
  return h.call<{
    attachmentId: string;
    writer: boolean;
    tab: ShellSessionInfo;
    nextOffset: number;
    gap?: { from: number; to: number };
  }>("terminal.attach", resolvedParams, requestContext);
}

describe("browser terminal methods", () => {
  it("revokes attachments and output listeners when their browser session ends", async () => {
    const h = harness();
    const attached = await attach(h);
    h.service.revokeSession("session-1");
    expect(h.terminal.detachTerminalTabOutput).toHaveBeenCalled();
    await expect(
      h.call("terminal.replay", {
        workspaceId: workspace.id,
        taskId: task.id,
        attachmentId: attached.attachmentId,
        afterOffset: 0,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.service.dispose();
  });

  it("returns complete host-owned terminal DTOs and enforces task-workspace scope", async () => {
    const h = harness();
    const opened = await h.call<{ tab: ShellSessionInfo }>(
      "terminal.open",
      { workspaceId: workspace.id, taskId: task.id },
      context("session-1", "open-list-01"),
    );
    const result = await h.call<{ tabs: Array<Record<string, unknown>> }>("terminal.list", {
      workspaceId: workspace.id,
      taskId: task.id,
    });

    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]).toEqual({ ...opened.tab, scopeTaskId: task.id });
    expect(result.tabs[0]).toMatchObject({ taskId: "tab-token", scopeTaskId: task.id });
    await expect(
      h.call("terminal.list", { workspaceId: workspace.id, taskId: "task-other" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("opens only at the workspace root and deduplicates open retries", async () => {
    const h = harness();
    await expect(
      h.call(
        "terminal.open",
        { workspaceId: workspace.id, taskId: task.id, cwd: "/etc" },
        context("session-1", "open-bad-001"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const params = { workspaceId: workspace.id, taskId: task.id, title: "Browser shell" };
    const opened = await h.call<{ attachmentId: string; tab: ShellSessionInfo }>(
      "terminal.open",
      params,
      context("session-1", "open-good-01"),
    );
    const retry = await h.call<{ attachmentId: string; tab: ShellSessionInfo }>(
      "terminal.open",
      params,
      context("session-1", "open-good-01"),
    );

    expect(h.terminal.createTab).toHaveBeenCalledTimes(1);
    expect(h.terminal.createTab).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      cwd: workspace.path,
      title: "Browser shell",
    });
    expect(opened.tab.cwd).toBe(workspace.path);
    expect(opened.tab.scope).toBe("tab");
    expect(retry).toEqual(opened);
    expect(opened.tab.scopeTaskId).toBe(task.id);
  });

  it("hides unowned desktop tabs and prevents one task from attaching to another task tab", async () => {
    const h = harness();
    const unowned = await h.call<{ tabs: ShellSessionInfo[] }>("terminal.list", {
      workspaceId: workspace.id,
      taskId: task.id,
    });
    expect(unowned.tabs).toEqual([]);

    const taskOne = await h.call<{ tab: ShellSessionInfo }>(
      "terminal.open",
      { workspaceId: workspace.id, taskId: task.id },
      context("session-1", "open-task1-01"),
    );
    const taskTwo = await h.call<{ tab: ShellSessionInfo }>(
      "terminal.open",
      { workspaceId: workspace.id, taskId: task2.id },
      context("session-1", "open-task2-01"),
    );

    const taskOneTabs = await h.call<{ tabs: ShellSessionInfo[] }>("terminal.list", {
      workspaceId: workspace.id,
      taskId: task.id,
    });
    expect(taskOneTabs.tabs.map((candidate) => candidate.id)).toEqual([taskOne.tab.id]);
    await expect(
      h.call(
        "terminal.attach",
        { workspaceId: workspace.id, taskId: task.id, tabId: taskTwo.tab.id },
        context("session-2", "attach-cross-task-1"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("grants one writer, promotes a reader after detach, and deduplicates input", async () => {
    const h = harness();
    const writer = await attach(h);
    const reader = await attach(h, context("session-2", "attach-0002"));
    expect(writer.writer).toBe(true);
    expect(reader.writer).toBe(false);

    const inputRequest = {
      workspaceId: workspace.id,
      taskId: task.id,
      attachmentId: reader.attachmentId,
      input: "blocked\r",
    };
    await expect(
      h.call("terminal.input", inputRequest, context("session-2", "input-read-01")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.terminal.writeToTab).not.toHaveBeenCalled();

    const writerInput = { ...inputRequest, attachmentId: writer.attachmentId, input: "\x03" };
    const inputResult = await h.call<{
      accepted: true;
      nextOffset: number;
      tab: ShellSessionInfo;
    }>("terminal.input", writerInput, context("session-1", "input-write-1"));
    const duplicateInput = await h.call(
      "terminal.input",
      writerInput,
      context("session-1", "input-write-1"),
    );
    expect(h.terminal.writeToTab).toHaveBeenCalledTimes(1);
    expect(h.terminal.writeToTab).toHaveBeenCalledWith(writer.tab.id, "\x03");
    expect(duplicateInput).toEqual(inputResult);
    expect(inputResult.tab.commandCount).toBe(1);

    await h.call(
      "terminal.resize",
      {
        workspaceId: workspace.id,
        taskId: task.id,
        attachmentId: writer.attachmentId,
        cols: 999,
        rows: 999,
      },
      context("session-1", "resize-write-1"),
    );
    expect(h.terminal.resizeTab).toHaveBeenCalledWith(writer.tab.id, 500, 300);
    await h.call(
      "terminal.detach",
      { workspaceId: workspace.id, taskId: task.id, attachmentId: writer.attachmentId },
      context("session-1", "detach-write-1"),
    );

    const promotedInput = { ...inputRequest, input: "after promotion\r" };
    await h.call("terminal.input", promotedInput, context("session-2", "input-promote-1"));
    expect(h.terminal.writeToTab).toHaveBeenCalledTimes(2);
    await expect(
      h.call(
        "terminal.close",
        { workspaceId: workspace.id, taskId: task.id, attachmentId: reader.attachmentId },
        context("session-2", "close-writer-1"),
      ),
    ).resolves.toEqual({ closed: true });
    expect(h.terminal.closeTab).toHaveBeenCalledWith(writer.tab.id);
  });

  it("replays bounded output with explicit retention gaps and progressing offsets", async () => {
    const h = harness();
    const attached = await attach(h);
    h.emit(attached.tab.id, "x".repeat(300_000));

    const first = await h.call<{
      chunks: Array<{
        offset: number;
        text: string;
        stream: "stdout";
        cwd: string;
        status: ShellSessionInfo["status"];
      }>;
      nextOffset: number;
      hasMore: boolean;
      gap?: { from: number; to: number };
      tab: ShellSessionInfo;
    }>("terminal.replay", {
      workspaceId: workspace.id,
      taskId: task.id,
      attachmentId: attached.attachmentId,
      afterOffset: 0,
      limit: 16_000,
    });
    if (!first.gap) throw new Error("Expected replay to report the retention gap.");
    expect(first.gap).toEqual({ from: 0, to: 300_000 - 256 * 1024 });
    expect(first.chunks).toHaveLength(1);
    expect(first.chunks[0]).toMatchObject({ offset: first.gap.to, text: "x".repeat(16_000) });
    expect(first.chunks[0]).toMatchObject({
      stream: "stdout",
      cwd: "/private/work/path",
      status: "active",
    });
    expect(first.tab).toEqual({ ...attached.tab, scopeTaskId: task.id });
    expect(first.nextOffset).toBe(first.gap.to + 16_000);
    expect(first.hasMore).toBe(true);

    const next = await h.call<{
      chunks: Array<{
        offset: number;
        text: string;
        stream: "stdout";
        cwd: string;
        status: string;
      }>;
      nextOffset: number;
      hasMore: boolean;
      tab: ShellSessionInfo;
    }>("terminal.replay", {
      workspaceId: workspace.id,
      taskId: task.id,
      attachmentId: attached.attachmentId,
      afterOffset: first.nextOffset,
    });
    expect(next.chunks[0]?.offset).toBe(first.nextOffset);
    expect(next.nextOffset).toBeGreaterThan(first.nextOffset);
    expect(next.hasMore).toBe(true);
  });

  it("stops the underlying PTY only for its writer attachment and deduplicates retries", async () => {
    const h = harness();
    const writer = await attach(h);
    const reader = await attach(h, context("session-2", "attach-0002"));
    const params = {
      workspaceId: workspace.id,
      taskId: task.id,
      attachmentId: writer.attachmentId,
    };

    await expect(
      h.call(
        "terminal.stop",
        { ...params, attachmentId: reader.attachmentId },
        context("session-2", "stop-read-1"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.terminal.stopTab).not.toHaveBeenCalled();

    const requestContext = context("session-1", "stop-write-01");
    const stopped = await h.call<ShellSessionInfo | null>("terminal.stop", params, requestContext);
    const retry = await h.call<ShellSessionInfo | null>("terminal.stop", params, requestContext);
    expect(stopped?.status).toBe("inactive");
    expect(retry).toEqual(stopped);
    expect(h.terminal.stopTab).toHaveBeenCalledTimes(1);
    expect(h.terminal.stopTab).toHaveBeenCalledWith(writer.tab.id);
    expect(h.terminal.closeTab).not.toHaveBeenCalled();
  });

  it("binds attachments to the creating session and rechecks shell permission", async () => {
    const h = harness();
    const attached = await attach(h);
    const replayRequest = {
      workspaceId: workspace.id,
      taskId: task.id,
      attachmentId: attached.attachmentId,
      afterOffset: 0,
    };
    await expect(
      h.call("terminal.replay", replayRequest, context("session-2")),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      h.call(
        "terminal.detach",
        { workspaceId: workspace.id, taskId: task.id, attachmentId: attached.attachmentId },
        context("session-2", "detach-foreign"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const denied = harness({ allowShell: false });
    await expect(attach(denied)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(denied.terminal.attachTerminalTabOutput).not.toHaveBeenCalled();
  });
});
