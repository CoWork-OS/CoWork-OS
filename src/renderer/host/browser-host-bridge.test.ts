import { afterEach, describe, expect, it, vi } from "vitest";
import { WebTransportError, type BrowserHostTransport } from "../../renderer-web/transport";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import { installBrowserHostBridge } from "./browser-host-bridge";

const workspace = {
  id: "workspace-1",
  name: "Authorized workspace",
  path: "/work/authorized",
  createdAt: 1,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
};

const taskSummary = {
  id: "task-1",
  title: "Review source",
  status: "completed",
  workspaceId: workspace.id,
  createdAt: 2,
  updatedAt: 3,
};

const taskDetail = { ...taskSummary, prompt: "Review the authorized source tree." };

const session = {
  apiVersion: 1,
  host: {
    installationId: "installation-1",
    profileId: "profile-1",
    generation: "generation-1",
    runtime: "electron",
    platform: "darwin",
    appVersion: "1.0.0",
  },
  capabilities: {},
  csrfToken: "csrf-token",
  providerReady: true,
  onboardingCompleted: true,
  disclaimerAccepted: true,
  activeWorkspaceId: workspace.id,
} as WebSessionBootstrap;

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, String(value)),
  };
}

function stubBrowserWindow(previousApi?: unknown) {
  const fakeWindow = {
    electronAPI: previousApi,
    coworkBrowserHost: undefined,
    coworkBrowserHostInfo: undefined,
    sessionStorage: createMemoryStorage(),
    localStorage: createMemoryStorage(),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("navigator", { platform: "Win32" });
  return fakeWindow;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser host bridge", () => {
  it("installs truthful first-paint reads and persists appearance locally", async () => {
    const previousApi = { getPlatform: () => "win32" };
    const fakeWindow = stubBrowserWindow(previousApi);
    const initialSession = {
      ...session,
      onboardingCompleted: false,
      disclaimerAccepted: false,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.workspace.list") return { workspaces: [workspace] };
      if (method === "task.list") {
        return { tasks: [taskSummary], hasMore: false, limit: 50, offset: 0 };
      }
      if (method === "desktop.task.get") return { task: taskDetail };
      if (method === "task.events.snapshot") {
        return {
          taskId: taskDetail.id,
          workspaceId: workspace.id,
          events: [],
          cursor: { taskId: taskDetail.id, position: 3 },
          hasMoreHistory: false,
          nextHistoryCursor: null,
        };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const transport = { request } as unknown as BrowserHostTransport;

    const dispose = installBrowserHostBridge(transport, initialSession);
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;

    expect(fakeWindow.coworkBrowserHost).toBe(true);
    expect(fakeWindow.coworkBrowserHostInfo).toEqual({
      providerReady: true,
      activeWorkspaceId: workspace.id,
    });
    expect(api.getPlatform()).toBe("darwin");
    await expect(api.getAppVersion()).resolves.toEqual({ version: "1.0.0" });
    expect(api.getNativeFrameMode()).toBe(false);
    expect(await api.getAppearanceSettings()).toMatchObject({
      disclaimerAccepted: false,
      onboardingCompleted: false,
    });
    await api.saveAppearanceSettings({
      disclaimerAccepted: true,
      onboardingCompleted: true,
      themeMode: "dark",
      timelineVerbosity: "verbose",
    });

    await expect(api.listWorkspaces()).resolves.toEqual([workspace]);
    await expect(api.selectWorkspace(workspace.id)).resolves.toEqual(workspace);
    await expect(api.listSidebarTasks({ limit: 50 })).resolves.toMatchObject([
      { id: taskSummary.id, title: taskSummary.title, prompt: "" },
    ]);
    await expect(api.getTask(taskDetail.id)).resolves.toEqual(taskDetail);
    await expect(api.getTaskEvents(taskDetail.id)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(
      "task.list",
      { limit: 50, offset: 0, workspaceId: workspace.id },
      undefined,
    );

    dispose();
    expect(fakeWindow.electronAPI).toBe(previousApi);
    expect(fakeWindow.coworkBrowserHost).toBeUndefined();

    const secondDispose = installBrowserHostBridge(transport, initialSession);
    const refreshedApi = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    await expect(refreshedApi.getAppearanceSettings()).resolves.toMatchObject({
      disclaimerAccepted: true,
      onboardingCompleted: true,
      themeMode: "dark",
      timelineVerbosity: "verbose",
    });
    secondDispose();
  });

  it("reuses a persisted task admission key after an uncertain reply", async () => {
    const fakeWindow = stubBrowserWindow();
    const admissionKeys: string[] = [];
    const mutationOptions: Array<{ operationKey?: string; mutation?: boolean }> = [];
    let admissionCount = 0;
    const createdTask = {
      id: "created-task",
      title: "Prepare a handoff",
      status: "pending",
      workspaceId: workspace.id,
      createdAt: 5,
      updatedAt: 5,
    };
    const createdDetail = { ...createdTask, prompt: "Prepare the handoff." };
    const request = vi.fn(
      async (
        method: string,
        params: unknown,
        options?: { operationKey?: string; mutation?: boolean },
      ) => {
        if (method === "task.admission.get") {
          const operationKey = (params as { operationKey: string }).operationKey;
          admissionKeys.push(operationKey);
          admissionCount += 1;
          return admissionCount < 3
            ? { found: false }
            : { found: true, taskId: createdTask.id, task: createdTask };
        }
        if (method === "task.create") {
          mutationOptions.push(options ?? {});
          throw new WebTransportError({
            code: "OUTCOME_UNKNOWN",
            message: "The reply was lost.",
            retryable: true,
          });
        }
        if (method === "desktop.task.get") return { task: createdDetail };
        throw new Error(`Unexpected RPC method ${method}`);
      },
    );
    const transport = { request } as unknown as BrowserHostTransport;
    const dispose = installBrowserHostBridge(transport, session);
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const composerPayload = {
      title: createdTask.title,
      prompt: "Prepare the handoff.",
      workspaceId: workspace.id,
      generateTitle: true,
      agentConfig: {
        interactionMode: { mode: "smart" },
        executionMode: "execute",
        taskDomain: "auto",
        chronicleMode: "inherit",
        accessProfileId: "ask_for_approval",
      },
    };

    await expect(api.createTask(composerPayload)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    await expect(api.createTask(composerPayload)).resolves.toMatchObject({
      id: createdTask.id,
      prompt: "Prepare the handoff.",
    });

    expect(mutationOptions).toHaveLength(1);
    expect(mutationOptions[0]).toMatchObject({ mutation: true });
    expect(admissionKeys).toHaveLength(3);
    expect(new Set(admissionKeys)).toEqual(new Set([mutationOptions[0].operationKey]));
    dispose();
  });

  it("fails closed instead of replaying a pending operation from another browser session", async () => {
    const fakeWindow = stubBrowserWindow();
    const request = vi.fn(async (method: string) => {
      if (method === "task.admission.get") return { found: false };
      if (method === "task.create") {
        throw new WebTransportError({
          code: "OUTCOME_UNKNOWN",
          message: "The reply was lost.",
          retryable: true,
        });
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const requestPayload = {
      title: "Prepare a handoff",
      prompt: "Prepare the handoff.",
      workspaceId: workspace.id,
    };

    await expect(api.createTask(requestPayload)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    dispose();

    const nextRequest = vi.fn(async () => {
      throw new Error("A fresh session must not send this request.");
    });
    const nextDispose = installBrowserHostBridge(
      { request: nextRequest } as unknown as BrowserHostTransport,
      { ...session, csrfToken: "new-browser-session-csrf" },
    );
    const nextApi = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    await expect(nextApi.createTask(requestPayload)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("Do not clear browser storage"),
    });
    expect(nextRequest).not.toHaveBeenCalled();
    nextDispose();
  });

  it("polls committed events for observed selected-task timelines and unsubscribes", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    const event = {
      id: "event-2",
      taskId: taskDetail.id,
      timestamp: 4,
      type: "progress_update",
      payload: { message: "Committed progress" },
      schemaVersion: 2,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.task.get") return { task: taskDetail };
      if (method === "task.events.snapshot") {
        return {
          taskId: taskDetail.id,
          workspaceId: workspace.id,
          events: [],
          cursor: { taskId: taskDetail.id, position: 1 },
          hasMoreHistory: false,
          nextHistoryCursor: null,
        };
      }
      if (method === "task.events.page") {
        return {
          outcome: "page",
          taskId: taskDetail.id,
          changes: [{ operation: "upsert", cursor: 2, event }],
          nextCursor: { taskId: taskDetail.id, position: 2 },
          hasMore: false,
        };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const transport = { request } as unknown as BrowserHostTransport;
    const dispose = installBrowserHostBridge(transport, session);
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const listener = vi.fn();
    const unsubscribe = api.onTaskEvent(listener);

    await api.getTaskEvents(taskDetail.id);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(listener).toHaveBeenCalledWith(event);
    expect(request).toHaveBeenCalledWith(
      "task.events.page",
      expect.objectContaining({
        taskId: taskDetail.id,
        workspaceId: workspace.id,
        afterCursor: { taskId: taskDetail.id, position: 1 },
      }),
      undefined,
    );
    unsubscribe();
    const pageCalls = request.mock.calls.filter(([method]) => method === "task.events.page").length;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request.mock.calls.filter(([method]) => method === "task.events.page")).toHaveLength(
      pageCalls,
    );
    dispose();
  });
});
