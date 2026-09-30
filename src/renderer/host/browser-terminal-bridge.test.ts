import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellSessionInfo, Task, Workspace } from "../../shared/types";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import { createBrowserTerminalBridge } from "./browser-terminal-bridge";

const workspace = {
  id: "workspace-1",
  name: "Project",
  path: "/workspace/project",
  createdAt: 1,
  permissions: { shell: true },
} as Workspace;
const task = { id: "task-1", workspaceId: workspace.id } as Task;
const session = {
  host: { installationId: "install-1", profileId: "profile-1", generation: "generation-1" },
} as WebSessionBootstrap;

function tab(overrides: Partial<ShellSessionInfo> = {}) {
  return {
    id: "tab-1",
    taskId: "host-tab-token",
    workspaceId: workspace.id,
    scope: "tab",
    scopeTaskId: task.id,
    cwd: workspace.path,
    status: "active",
    retained: true,
    commandCount: 0,
    aliases: [],
    envKeys: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness() {
  const calls: Array<{ method: string; params: unknown; options?: unknown }> = [];
  let replay: Record<string, unknown> = {
    chunks: [],
    nextOffset: 0,
    hasMore: false,
    tab: tab(),
  };
  let isActive = true;
  const rpc = vi.fn(async (method: string, params: unknown, options?: unknown) => {
    calls.push({ method, params, options });
    if (method === "terminal.list") {
      return { workspaceId: workspace.id, taskId: task.id, tabs: [] };
    }
    if (method === "terminal.open") {
      return { attachmentId: "attachment-1", writer: true, tab: tab(), nextOffset: 0 };
    }
    if (method === "terminal.attach") {
      return { attachmentId: "attachment-1", writer: true, tab: tab(), nextOffset: 0 };
    }
    if (method === "terminal.replay") return replay;
    if (method === "terminal.input") {
      return { accepted: true, nextOffset: 0, tab: tab({ status: "running", commandCount: 1 }) };
    }
    if (method === "terminal.resize") {
      return { cols: 80, rows: 24, tab: tab() };
    }
    if (method === "terminal.stop") return tab({ status: "inactive" });
    if (method === "terminal.close") return { closed: true };
    if (method === "terminal.detach") return { detached: true };
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const bridge = createBrowserTerminalBridge({
    rpc: rpc as unknown as Parameters<typeof createBrowserTerminalBridge>[0]["rpc"],
    listWorkspaces: async () => [workspace],
    getTask: async (id) => (id === task.id ? task : null),
    session,
    isActive: () => isActive,
    createOperationKey: (() => {
      let index = 0;
      return () => `operation-key-${++index}`;
    })(),
  });
  return {
    bridge,
    calls,
    rpc,
    methods: bridge.methods,
    setReplay: (next: Record<string, unknown>) => (replay = next),
    setActive: (next: boolean) => (isActive = next),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("browser terminal bridge", () => {
  it("maps list and open to task-scoped DTOs and refuses caller-selected cwd", async () => {
    const h = harness();
    h.rpc.mockImplementation(async (method: string, params: unknown, options?: unknown) => {
      h.calls.push({ method, params, options });
      if (method === "terminal.list") {
        return { workspaceId: workspace.id, taskId: task.id, tabs: [tab()] };
      }
      if (method === "terminal.open") {
        return { attachmentId: "attachment-1", writer: true, tab: tab(), nextOffset: 0 };
      }
      if (method === "terminal.detach") return { detached: true };
      throw new Error(`Unexpected RPC: ${method}`);
    });

    const tabs = await h.methods.listTerminalTabs(workspace.id, task.id);
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as ShellSessionInfo & { scopeTaskId: string }).scopeTaskId).toBe(task.id);
    await expect(
      h.methods.createTerminalTab({ workspaceId: workspace.id, taskId: task.id, cwd: "/etc" }),
    ).rejects.toThrow("always start at the workspace root");

    const created = await h.methods.createTerminalTab({
      workspaceId: workspace.id,
      taskId: task.id,
      title: "Browser terminal",
    });
    expect(created.cwd).toBe(workspace.path);
    const openCall = h.calls.find((call) => call.method === "terminal.open");
    expect(openCall?.params).toEqual({
      workspaceId: workspace.id,
      taskId: task.id,
      title: "Browser terminal",
    });
    expect(openCall?.options).toMatchObject({ mutation: true, operationKey: expect.any(String) });
    expect(h.calls.some((call) => /run|command/i.test(call.method))).toBe(false);
    h.bridge.dispose();
  });

  it("validates task-workspace scope before sending any terminal RPC", async () => {
    const h = harness();
    await expect(h.methods.listTerminalTabs(workspace.id, "another-task")).rejects.toThrow(
      "unavailable for this task and workspace",
    );
    expect(h.rpc).not.toHaveBeenCalled();
    h.bridge.dispose();
  });

  it("attaches only to a listed task tab before accepting terminal input", async () => {
    const h = harness();
    h.rpc.mockImplementation(async (method: string, params: unknown, options?: unknown) => {
      h.calls.push({ method, params, options });
      if (method === "terminal.list") {
        return { workspaceId: workspace.id, taskId: task.id, tabs: [tab()] };
      }
      if (method === "terminal.attach") {
        return { attachmentId: "listed-attachment", writer: true, tab: tab(), nextOffset: 12 };
      }
      if (method === "terminal.input") {
        return { accepted: true, nextOffset: 12, tab: tab() };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });

    const [listed] = await h.methods.listTerminalTabs(workspace.id, task.id);
    await h.methods.writeTerminalTabInput({
      tabId: listed!.id,
      workspaceId: workspace.id,
      taskId: task.id,
      input: "",
    });
    expect(h.calls.map((call) => call.method)).toEqual([
      "terminal.list",
      "terminal.attach",
      "terminal.input",
    ]);
    expect(h.calls[1]?.params).toEqual({
      workspaceId: workspace.id,
      taskId: task.id,
      tabId: "tab-1",
    });
    expect(h.calls[2]?.params).toMatchObject({ attachmentId: "listed-attachment", input: "" });
    h.bridge.dispose();
  });

  it("maps input, resize, stop, and close through scoped attachments only", async () => {
    const h = harness();
    const created = await h.methods.createTerminalTab({
      workspaceId: workspace.id,
      taskId: task.id,
    });
    await h.methods.writeTerminalTabInput({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
      input: "",
    });
    await h.methods.writeTerminalTabInput({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
      input: "ls\r",
    });
    await h.methods.resizeTerminalTab({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
      cols: 80,
      rows: 24,
    });
    const stopped = await h.methods.stopTerminalTab({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
    });
    expect(stopped?.status).toBe("inactive");
    expect((stopped as (ShellSessionInfo & { scopeTaskId: string }) | null)?.scopeTaskId).toBe(
      task.id,
    );
    await h.methods.closeTerminalTab({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
    });
    expect(h.calls.map((call) => call.method)).toEqual([
      "terminal.open",
      "terminal.input",
      "terminal.input",
      "terminal.resize",
      "terminal.stop",
      "terminal.close",
    ]);
    for (const call of h.calls) {
      if (call.method === "terminal.detach") continue;
      expect(call.params).toMatchObject({ workspaceId: workspace.id, taskId: task.id });
    }
    expect(
      h.calls.find(
        (call) =>
          call.method === "terminal.input" && (call.params as { input?: string }).input === "ls\r",
      )?.params,
    ).toMatchObject({
      attachmentId: "attachment-1",
      input: "ls\r",
    });
    expect(h.calls.find((call) => call.method === "terminal.stop")?.params).toMatchObject({
      attachmentId: "attachment-1",
    });
    expect(h.calls.find((call) => call.method === "terminal.close")?.params).toMatchObject({
      attachmentId: "attachment-1",
    });
    h.bridge.dispose();
  });

  it("replays actual output metadata and emits status-only updates", async () => {
    vi.useFakeTimers();
    const h = harness();
    const created = await h.methods.createTerminalTab({
      workspaceId: workspace.id,
      taskId: task.id,
    });
    const received: unknown[] = [];
    const unsubscribe = h.methods.onTerminalTabOutput((event) => received.push(event));
    await h.methods.writeTerminalTabInput({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
      input: "",
    });
    h.setReplay({
      chunks: [
        {
          offset: 0,
          text: "ready\r\n",
          stream: "stdout",
          cwd: "/workspace/project/sub",
          status: "running",
        },
      ],
      nextOffset: 7,
      hasMore: false,
      tab: tab({ cwd: "/workspace/project/sub", status: "running" }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received[0]).toMatchObject({
      tabId: created.id,
      workspaceId: workspace.id,
      stream: "stdout",
      output: "ready\r\n",
      cwd: "/workspace/project/sub",
      status: "running",
    });

    received.length = 0;
    h.setReplay({
      chunks: [],
      nextOffset: 7,
      hasMore: false,
      tab: tab({ cwd: "/workspace/project", status: "inactive" }),
    });
    await vi.advanceTimersByTimeAsync(351);
    expect(received).toContainEqual(
      expect.objectContaining({ output: "", cwd: "/workspace/project", status: "inactive" }),
    );
    unsubscribe();
    h.bridge.dispose();
  });

  it("keeps a stable open key for an unconfirmed retry and blocks changed payloads", async () => {
    const h = harness();
    let shouldTimeout = true;
    h.rpc.mockImplementation(async (method: string, params: unknown, options?: unknown) => {
      h.calls.push({ method, params, options });
      if (method === "terminal.open" && shouldTimeout) {
        shouldTimeout = false;
        throw Object.assign(new Error("unknown outcome"), { code: "OUTCOME_UNKNOWN" });
      }
      if (method === "terminal.open") {
        return { attachmentId: "attachment-1", writer: true, tab: tab(), nextOffset: 0 };
      }
      if (method === "terminal.detach") return { detached: true };
      throw new Error(`Unexpected RPC: ${method}`);
    });

    const request = { workspaceId: workspace.id, taskId: task.id, title: "Same request" };
    await expect(h.methods.createTerminalTab(request)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    const firstKey = (h.calls[0]?.options as { operationKey: string }).operationKey;
    await expect(
      h.methods.createTerminalTab({ ...request, title: "Changed request" }),
    ).rejects.toThrow("previous terminal action is unconfirmed");
    const created = await h.methods.createTerminalTab(request);
    expect(created.id).toBe("tab-1");
    const secondKey = (h.calls.at(-1)?.options as { operationKey: string }).operationKey;
    expect(secondKey).toBe(firstKey);
    h.bridge.dispose();
  });

  it("detaches scoped attachments on disposal", async () => {
    const h = harness();
    const created = await h.methods.createTerminalTab({
      workspaceId: workspace.id,
      taskId: task.id,
    });
    await h.methods.writeTerminalTabInput({
      tabId: created.id,
      workspaceId: workspace.id,
      taskId: task.id,
      input: "",
    });
    h.bridge.dispose();
    await Promise.resolve();
    expect(h.calls.some((call) => call.method === "terminal.detach")).toBe(true);
  });
});
