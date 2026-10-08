import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "../../electron/preload";
import type { CronEvent, CronJob, CronStatusSummary } from "../../electron/cron/types";
import { WebTransportError, type BrowserHostTransport } from "../../renderer-web/transport";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import type { BrowserGitApi } from "../../shared/host-api/git";
import type { MailboxEvent } from "../../shared/mailbox";
import { BROWSER_HOST_UNSUPPORTED_ACTION_EVENT } from "./browser-capabilities";
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
    open: vi.fn(),
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
  it("polls scoped MCP status only while a shared screen subscribes", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    let statuses = [{ id: "qa", status: "connecting" }];
    const request = vi.fn(async () => statuses);
    const dispose = installBrowserHostBridge({ request } as unknown as BrowserHostTransport, {
      ...session,
      desktopMethods: { getMCPStatus: { mutation: false } },
    });
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const listener = vi.fn();
    const unsubscribe = api.onMCPStatusChange(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith(
      "desktop.getMCPStatus",
      {
        args: [{ workspaceId: workspace.id }],
      },
      undefined,
    );
    expect(listener).toHaveBeenLastCalledWith(statuses);
    statuses = [{ id: "qa", status: "connected" }];
    await vi.advanceTimersByTimeAsync(2500);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    const requests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(requests);
    dispose();
  });

  it("publishes only changed gateway revisions and stops on bridge disposal", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    let rows = [{ channelId: "qa", channelType: "discord", revision: "one" }];
    const request = vi.fn(async () => rows);
    const dispose = installBrowserHostBridge({ request } as unknown as BrowserHostTransport, {
      ...session,
      desktopMethods: { getGatewayChangeSignal: { mutation: false } },
    });
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const listener = vi.fn();
    api.onGatewayUsersUpdated(listener);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(listener).toHaveBeenCalledTimes(1);
    rows = [{ ...rows[0], revision: "two" }];
    await vi.advanceTimersByTimeAsync(2500);
    expect(listener).toHaveBeenLastCalledWith({ channelId: "qa", channelType: "discord" });
    dispose();
    const requests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(requests);
  });

  it("connects Git Changes to read and replay-safe mutation RPCs", async () => {
    const fakeWindow = stubBrowserWindow();
    const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
      if (method === "git.status") {
        return {
          workspaceId: workspace.id,
          isRepository: true,
          branch: "main",
          revision: "a".repeat(64),
          clean: false,
          changedFiles: 1,
          stagedChanges: 0,
          unstagedChanges: 1,
          untrackedFiles: 0,
          conflictedFiles: 0,
          files: [],
          filesTruncated: false,
          truncated: false,
        };
      }
      return { workspaceId: workspace.id, action: "stage", outcome: "applied" };
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      session,
    );
    const git = (fakeWindow as unknown as { coworkBrowserGit: BrowserGitApi }).coworkBrowserGit;

    await expect(git.status(workspace.id)).resolves.toMatchObject({ branch: "main" });
    await expect(
      git.stage({
        workspaceId: workspace.id,
        expectedRevision: "a".repeat(64),
        relativePaths: ["notes.txt"],
      }),
    ).resolves.toMatchObject({ action: "stage", outcome: "applied" });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "git.status",
      { workspaceId: workspace.id },
      undefined,
    );
    expect(request.mock.calls[1]?.[0]).toBe("git.stage");
    expect(request.mock.calls[1]?.[2]).toMatchObject({ mutation: true });
    expect((request.mock.calls[1]?.[2] as { operationKey: string }).operationKey).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    dispose();
    expect(
      (fakeWindow as unknown as { coworkBrowserGit?: unknown }).coworkBrowserGit,
    ).toBeUndefined();
  });

  it("publishes authenticated workflow capabilities to the shared renderer", () => {
    const fakeWindow = stubBrowserWindow();
    const capabilities = {
      "browser.interactive": {
        available: false as const,
        reason: "Interactive browser streaming is unavailable on this host.",
      },
    };
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      { ...session, capabilities } as WebSessionBootstrap,
    );

    expect(fakeWindow.coworkBrowserHostInfo).toMatchObject({ capabilities });
    dispose();
  });

  it("exposes scoped inline write-review loading when browser input requests are available", () => {
    const fakeWindow = stubBrowserWindow();
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      {
        ...session,
        capabilities: {
          "tasks.inputRequests": { available: true },
        },
      } as WebSessionBootstrap,
    );
    const api = fakeWindow.electronAPI as unknown as Record<string, unknown>;

    expect(api.getInputRequestDraftReview).toEqual(expect.any(Function));
    dispose();
  });

  it("leaves optional native local-model controls absent so browser UI can gate them", () => {
    const fakeWindow = stubBrowserWindow();
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<string, unknown>;

    expect(api.startLocalAIServer).toBeUndefined();
    expect(api.stopLocalAIServer).toBeUndefined();
    expect(api.detectHardware).toBeUndefined();
    expect(api.getVoiceSettings).toBeUndefined();
    expect(api.onTrayOpenAbout).toBeUndefined();
    expect(typeof api.createTask).toBe("function");
    dispose();
  });

  it("announces an unsupported browser action before rejecting its host call", async () => {
    const fakeWindow = stubBrowserWindow();
    const dispatchEvent = vi.fn();
    Object.assign(fakeWindow, { dispatchEvent });
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    await expect(api.agentSecurityScan()).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BROWSER_HOST_UNSUPPORTED_ACTION_EVENT,
        detail: { method: "agentSecurityScan" },
      }),
    );
    dispose();
  });

  it("announces an unsupported subscription instead of silently accepting it", () => {
    const fakeWindow = stubBrowserWindow();
    const dispatchEvent = vi.fn();
    Object.assign(fakeWindow, { dispatchEvent });
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    const unsubscribe = api.onTaskBoardEvent(vi.fn());

    expect(typeof unsubscribe).toBe("function");
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BROWSER_HOST_UNSUPPORTED_ACTION_EVENT,
        detail: { method: "onTaskBoardEvent" },
      }),
    );
    dispose();
  });

  it("polls host notification changes for shared renderer subscriptions", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    const methodNames = [
      "listNotifications",
      "getUnreadNotificationCount",
      "markNotificationRead",
      "markAllNotificationsRead",
      "deleteNotification",
      "deleteAllNotifications",
    ];
    const hostMethods = Object.fromEntries(
      methodNames.map((name) => [
        name,
        { mutation: name.startsWith("mark") || name.startsWith("delete") },
      ]),
    );
    const notification = {
      id: "notification-one",
      type: "task_completed",
      title: "Task completed",
      message: "The browser task finished.",
      read: false,
      createdAt: 1,
    };
    let notifications: (typeof notification)[] = [];
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "desktop.listNotifications") return notifications;
        if (method === "desktop.getUnreadNotificationCount") {
          return notifications.filter((item) => !item.read).length;
        }
        return null;
      }),
    } as unknown as BrowserHostTransport;
    const dispose = installBrowserHostBridge(transport, {
      ...session,
      desktopMethods: hostMethods,
    });
    const api = fakeWindow.electronAPI as unknown as {
      onNotificationEvent: (
        listener: (event: { type: string; notification?: unknown }) => void,
      ) => () => void;
    };
    const onEvent = vi.fn();
    const unsubscribe = api.onNotificationEvent(onEvent);

    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).not.toHaveBeenCalled();
    notifications = [notification];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenCalledWith({ type: "added", notification });
    notifications = [{ ...notification, read: true }];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenCalledWith({
      type: "updated",
      notification: { ...notification, read: true },
    });
    notifications = [];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenCalledWith({ type: "cleared" });
    unsubscribe();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls queue status while subscribed and releases the timer when unsubscribed", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    const initialStatus: Awaited<ReturnType<ElectronAPI["getQueueStatus"]>> = {
      runningCount: 1,
      queuedCount: 0,
      runningTaskIds: ["task-1"],
      queuedTaskIds: [],
      maxConcurrent: 4,
    };
    let currentStatus = initialStatus;
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.getQueueStatus") return currentStatus;
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      {
        ...session,
        desktopMethods: { getQueueStatus: { mutation: false } },
      } as WebSessionBootstrap,
    );
    const api = fakeWindow.electronAPI as unknown as {
      onQueueUpdate: (listener: (status: typeof initialStatus) => void) => () => void;
    };
    const onUpdate = vi.fn();
    const unsubscribe = api.onQueueUpdate(onUpdate);

    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledWith(initialStatus);
    currentStatus = { ...initialStatus, queuedCount: 1, queuedTaskIds: ["task-2"] };
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onUpdate).toHaveBeenLastCalledWith(currentStatus);
    const callsAfterUpdate = request.mock.calls.length;

    unsubscribe();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request).toHaveBeenCalledTimes(callsAfterUpdate);
    expect(
      (
        fakeWindow.coworkBrowserHostInfo as unknown as {
          desktopMethods: Record<string, unknown>;
        }
      ).desktopMethods.onQueueUpdate,
    ).toEqual({ mutation: false });
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls cron snapshots and emits bounded change events while Scheduled Tasks is mounted", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    let jobs: CronJob[] = [];
    let observedAtMs = 1_000;
    let schedulerEnabled = true;
    const makeStatus = (): CronStatusSummary => ({
      enabled: schedulerEnabled,
      storePath: "/private/cron.json",
      jobCount: jobs.length,
      enabledJobCount: jobs.filter((job) => job.enabled).length,
      runningJobCount: jobs.filter((job) => job.state.runningAtMs !== undefined).length,
      maxConcurrentRuns: 1,
      nextWakeAtMs: null,
      scheduler: {
        profileScope: "current_profile",
        runnerKind: "daemon",
        state: schedulerEnabled ? "running" : "disabled",
        observedAtMs,
        timeZone: "UTC",
        runnerExclusivity: "unknown",
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.getCronStatus") return makeStatus();
      if (method === "desktop.listCronJobs") return jobs;
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      {
        ...session,
        desktopMethods: {
          getCronStatus: { mutation: false },
          listCronJobs: { mutation: false },
        },
      } as WebSessionBootstrap,
    );
    const api = fakeWindow.electronAPI as unknown as {
      onCronEvent: (listener: (event: CronEvent) => void) => () => void;
    };
    const onEvent = vi.fn();
    const unsubscribe = api.onCronEvent(onEvent);

    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).not.toHaveBeenCalled();
    observedAtMs += 2_500;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).not.toHaveBeenCalled();

    const job = { id: "cron-job-1", name: "Daily check", enabled: false, state: {} } as CronJob;
    jobs = [job];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenLastCalledWith({ jobId: job.id, action: "added" });

    jobs = [{ ...job, name: "Updated check" }];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenLastCalledWith({ jobId: job.id, action: "updated" });

    jobs = [];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenLastCalledWith({ jobId: job.id, action: "removed" });

    schedulerEnabled = false;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenLastCalledWith({ jobId: "scheduler", action: "updated" });

    unsubscribe();
    const callsAfterUnsubscribe = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request).toHaveBeenCalledTimes(callsAfterUnsubscribe);
    expect(
      (
        fakeWindow.coworkBrowserHostInfo as unknown as {
          desktopMethods: Record<string, unknown>;
        }
      ).desktopMethods.onCronEvent,
    ).toEqual({ mutation: false });
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls mailbox events for shared renderer subscriptions", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    const firstEvent: MailboxEvent = {
      id: "mail-event-1",
      fingerprint: "fingerprint-1",
      type: "thread_summarized",
      workspaceId: workspace.id,
      timestamp: 1,
      threadId: "thread-1",
      evidenceRefs: [],
      payload: {},
    };
    let events = [firstEvent];
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.listMailboxEvents") return events;
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge({ request } as unknown as BrowserHostTransport, {
      ...session,
      desktopMethods: { listMailboxEvents: { mutation: false } },
    });
    const api = fakeWindow.electronAPI as unknown as {
      onMailboxEvent: (listener: (event: MailboxEvent) => void) => () => void;
    };
    const onEvent = vi.fn();
    const unsubscribe = api.onMailboxEvent(onEvent);

    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).not.toHaveBeenCalled();
    const nextEvent = { ...firstEvent, id: "mail-event-2", timestamp: 2 };
    events = [nextEvent];
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onEvent).toHaveBeenCalledWith(nextEvent);

    unsubscribe();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls a compact personality signal while subscribed", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    let signal = { agentName: "CoWork", activePersonality: "professional" };
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.getPersonalitySettingsChangeSignal") return signal;
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge({ request } as unknown as BrowserHostTransport, {
      ...session,
      desktopMethods: { getPersonalitySettingsChangeSignal: { mutation: false } },
    });
    const api = fakeWindow.electronAPI as unknown as {
      onPersonalitySettingsChanged: (listener: (settings: unknown) => void) => () => void;
    };
    const onChanged = vi.fn();
    const unsubscribe = api.onPersonalitySettingsChanged(onChanged);

    await vi.advanceTimersByTimeAsync(0);
    expect(onChanged).not.toHaveBeenCalled();
    signal = { agentName: "Assistant", activePersonality: "friendly" };
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onChanged).toHaveBeenCalledWith(signal);

    unsubscribe();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls host model-routing status for shared settings subscriptions", async () => {
    vi.useFakeTimers();
    const fakeWindow = stubBrowserWindow();
    let status = { activeProvider: "openai", activeModel: "model-a" };
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.getLLMRoutingStatus") return status;
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge({ request } as unknown as BrowserHostTransport, {
      ...session,
      desktopMethods: { getLLMRoutingStatus: { mutation: false } },
    });
    const api = fakeWindow.electronAPI as unknown as {
      onLLMRoutingEvent: (listener: (event: unknown) => void) => () => void;
    };
    const onChanged = vi.fn();
    const unsubscribe = api.onLLMRoutingEvent(onChanged);

    await vi.advanceTimersByTimeAsync(0);
    expect(onChanged).not.toHaveBeenCalled();
    status = { activeProvider: "anthropic", activeModel: "model-b" };
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onChanged).toHaveBeenCalledWith(status);

    unsubscribe();
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens only safe external URL schemes in a new browser tab", () => {
    const fakeWindow = stubBrowserWindow();
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    api.openExternal("https://example.com/docs");
    expect(fakeWindow.open).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    expect(() => api.openExternal("javascript:alert(1)")).toThrow(
      "Only http, https, and mailto URLs are allowed.",
    );
    const hostInfo = fakeWindow.coworkBrowserHostInfo as unknown as
      | { desktopMethods?: Record<string, unknown> }
      | undefined;
    expect(hostInfo?.desktopMethods?.openExternal).toEqual({ mutation: false });
    dispose();
  });

  it("keeps session auto-approval scoped to the authenticated browser page", async () => {
    const fakeWindow = stubBrowserWindow();
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;

    expect(await api.getSessionAutoApprove()).toBe(false);
    await api.setSessionAutoApprove(true);
    expect(await api.getSessionAutoApprove()).toBe(true);
    expect(
      (
        fakeWindow.coworkBrowserHostInfo as unknown as {
          desktopMethods: Record<string, unknown>;
        }
      ).desktopMethods,
    ).toMatchObject({
      getSessionAutoApprove: { mutation: false },
      setSessionAutoApprove: { mutation: false },
    });
    await expect(api.setSessionAutoApprove("true")).rejects.toThrow(
      "Session auto-approval must be a boolean.",
    );
    dispose();
  });

  it("keeps independent pack toggles usable while another target awaits its receipt", async () => {
    const fakeWindow = stubBrowserWindow();
    const pending: Array<() => void> = [];
    const request = vi.fn(
      async (_method: string, params: { args: unknown[] }, _options?: unknown) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({ success: true, name: params.args[0], enabled: params.args.at(-1) }),
          ),
        ),
    );
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      {
        ...session,
        desktopMethods: {
          togglePluginPack: { mutation: true },
          togglePluginPackSkill: { mutation: true },
        },
      } as WebSessionBootstrap,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const operations = Promise.all([
      api.togglePluginPack("pack-one", false),
      api.togglePluginPack("pack-two", false),
      api.togglePluginPackSkill("pack-one", "skill-one", false),
      api.togglePluginPackSkill("pack-one", "skill-two", false),
    ]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(
      new Set(request.mock.calls.map((call) => (call[2] as { operationKey: string }).operationKey))
        .size,
    ).toBe(4);
    pending.forEach((finish) => finish());
    await expect(operations).resolves.toHaveLength(4);
    dispose();
  });

  it("enables task submission after provider settings refresh the current host readiness", async () => {
    const fakeWindow = stubBrowserWindow();
    vi.stubGlobal("document", { baseURI: "http://127.0.0.1:18989/app/" });
    const initialSession = {
      ...session,
      providerReady: false,
      desktopMethods: {
        getLLMSettings: { mutation: false },
        saveLLMSettings: { mutation: true },
      },
    } as WebSessionBootstrap;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "desktop.getLLMSettings") {
        return { settings: { providerType: "anthropic" }, revision: "revision-one" };
      }
      if (method === "desktop.saveLLMSettings") {
        expect(params).toMatchObject({
          args: [{ set: [], remove: [], replaceSecrets: [] }, "revision-one"],
        });
        return { success: true, revision: "revision-two" };
      }
      if (method === "task.admission.get") return { found: false };
      if (method === "task.create") return { taskId: taskDetail.id, task: taskSummary };
      throw new Error(`Unexpected RPC method ${method}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...initialSession, providerReady: true }),
      })),
    );
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      initialSession,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const providerReadinessChanged = vi.fn();
    (
      api as unknown as {
        onLLMSettingsChanged: (listener: () => void) => () => void;
      }
    ).onLLMSettingsChanged(providerReadinessChanged);
    const input = { title: "Provider test", prompt: "Test", workspaceId: workspace.id };
    await expect(api.createTask(input)).rejects.toThrow("Settings → AI & Models");
    expect(request).not.toHaveBeenCalled();
    await api.saveLLMSettings({ providerType: "anthropic" } as never);
    expect(fakeWindow.coworkBrowserHostInfo).toMatchObject({ providerReady: true });
    expect(providerReadinessChanged).toHaveBeenCalledOnce();
    await expect(api.createTask(input)).resolves.toMatchObject({ id: taskDetail.id });
    dispose();
  });

  it("sends provider edits as field changes and protected secret replacements", async () => {
    const fakeWindow = stubBrowserWindow();
    vi.stubGlobal("document", { baseURI: "http://127.0.0.1:18989/app/" });
    const initialSettings = {
      providerType: "openai",
      modelKey: "gpt-4o",
      openai: { apiKeyConfigured: true },
    };
    const updatedSettings = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: { apiKeyConfigured: true },
    };
    let snapshotReads = 0;
    const initialSession = {
      ...session,
      desktopMethods: {
        getLLMSettings: { mutation: false },
        saveLLMSettings: { mutation: true },
      },
    } as WebSessionBootstrap;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "desktop.getLLMSettings") {
        const firstRead = snapshotReads++ === 0;
        return {
          settings: firstRead ? initialSettings : updatedSettings,
          revision: firstRead ? "revision-one" : "revision-two",
        };
      }
      if (method === "desktop.saveLLMSettings") {
        return { success: true, revision: "revision-two" };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => initialSession })),
    );
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      initialSession,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;

    await api.saveLLMSettings({
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: { apiKey: "sk-new-provider-secret", apiKeyConfigured: true },
    } as never);

    const saveCall = request.mock.calls.find(([method]) => method === "desktop.saveLLMSettings");
    expect(saveCall?.[1]).toMatchObject({
      args: [
        {
          set: [{ path: ["modelKey"], value: "gpt-4.1" }],
          remove: [],
          replaceSecrets: [{ path: ["openai", "apiKey"], value: "sk-new-provider-secret" }],
        },
        "revision-one",
      ],
    });
    const serializedFieldChanges = JSON.stringify(
      (saveCall?.[1] as { args: [{ set: unknown[] }] }).args[0].set,
    );
    expect(serializedFieldChanges).not.toContain("sk-new-provider-secret");
    dispose();
  });

  it("surfaces stale provider settings and requires an explicit reload before retry", async () => {
    const fakeWindow = stubBrowserWindow();
    vi.stubGlobal("document", { baseURI: "http://127.0.0.1:18989/app/" });
    let settingsReads = 0;
    let saveAttempts = 0;
    const initialSession = {
      ...session,
      desktopMethods: {
        getLLMSettings: { mutation: false },
        saveLLMSettings: { mutation: true },
      },
    } as WebSessionBootstrap;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "desktop.getLLMSettings") {
        settingsReads += 1;
        return {
          settings: {
            providerType: "openai",
            modelKey: settingsReads === 1 ? "gpt-4o" : "gpt-4.1",
          },
          revision: settingsReads === 1 ? "revision-one" : "revision-two",
        };
      }
      if (method === "desktop.saveLLMSettings") {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          throw new WebTransportError({
            code: "CONFLICT",
            message: "Provider settings changed after this page loaded.",
            retryable: false,
          });
        }
        return { success: true, revision: "revision-three" };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => initialSession })),
    );
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      initialSession,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;

    await expect(api.getLLMSettings()).resolves.toEqual({
      providerType: "openai",
      modelKey: "gpt-4o",
    });
    await expect(api.saveLLMSettings({ providerType: "openai" } as never)).rejects.toThrow(
      "Provider settings changed after this page loaded.",
    );
    await expect(api.saveLLMSettings({ providerType: "openai" } as never)).rejects.toThrow(
      /reload AI & Models/i,
    );
    expect(saveAttempts).toBe(1);

    await expect(api.getLLMSettings()).resolves.toEqual({
      providerType: "openai",
      modelKey: "gpt-4.1",
    });
    await expect(api.saveLLMSettings({ providerType: "openai" } as never)).resolves.toMatchObject({
      success: true,
    });
    expect(saveAttempts).toBe(2);
    const providerWrites = request.mock.calls.filter(
      ([method]) => method === "desktop.saveLLMSettings",
    );
    expect(providerWrites[0]?.[1]).toMatchObject({
      args: [{ set: [], remove: [], replaceSecrets: [] }, "revision-one"],
    });
    expect(providerWrites[1]?.[1]).toMatchObject({
      args: [{ set: [], remove: [], replaceSecrets: [] }, "revision-two"],
    });
    dispose();
  });

  it.each(["INVALID_REQUEST", "STALE_STATE", "FORBIDDEN", "UNSUPPORTED_CAPABILITY"] as const)(
    "allows correcting a follow-up after definitive %s rejection",
    async (code) => {
      const fakeWindow = stubBrowserWindow();
      let attempts = 0;
      const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
        if (method === "desktop.task.get") return { task: taskDetail };
        if (method === "task.followUp.receipt") return { found: false, state: "pending" };
        if (method === "task.followUp") {
          if (++attempts === 1)
            throw new WebTransportError({
              code,
              message: "Invalid quote",
              retryable: false,
            });
          return { found: true, state: "admitted" };
        }
        throw new Error(`Unexpected RPC method ${method}`);
      });
      const dispose = installBrowserHostBridge(
        { request } as unknown as BrowserHostTransport,
        session,
      );
      const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
      await expect(api.sendMessage(taskDetail.id, "First")).rejects.toMatchObject({
        code,
      });
      await expect(api.sendMessage(taskDetail.id, "Corrected")).resolves.toMatchObject({
        deliveryStatus: "accepted",
      });
      const keys = request.mock.calls
        .filter(([method]) => method === "task.followUp")
        .map((call) => (call[2] as { operationKey: string }).operationKey);
      expect(new Set(keys).size).toBe(2);
      dispose();
    },
  );

  it.each(["pending", "unavailable"] as const)(
    "reconciles a changed draft against its previous %s receipt before any new submission",
    async (state) => {
      const fakeWindow = stubBrowserWindow();
      let lookups = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "desktop.task.get") return { task: taskDetail };
        if (method === "task.followUp.receipt") {
          lookups++;
          if (lookups === 1) return { found: false, state: "unavailable" };
          if (lookups === 2) throw new Error("Reply lost");
          return {
            found: true,
            state,
            ...(state === "pending" ? { deliveryStatus: "started" } : {}),
          };
        }
        if (method === "task.followUp") throw new Error("Reply lost");
        throw new Error(`Unexpected RPC method ${method}`);
      });
      const dispose = installBrowserHostBridge(
        { request } as unknown as BrowserHostTransport,
        session,
      );
      const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
      await expect(api.sendMessage(taskDetail.id, "Original")).rejects.toThrow("Reply lost");
      await expect(api.sendMessage(taskDetail.id, "Changed draft")).rejects.toThrow(
        state === "pending" ? "previous follow-up was accepted" : "previous follow-up failed",
      );
      expect(request.mock.calls.filter(([method]) => method === "task.followUp")).toHaveLength(1);
      expect(
        Array.from({ length: fakeWindow.localStorage.length }, (_, index) =>
          fakeWindow.localStorage.key(index),
        ).some((key) => key?.includes(":follow-up:")),
      ).toBe(false);
      dispose();
    },
  );

  it.each(["queued", "started"] as const)(
    "reconciles a %s follow-up receipt without submitting it again",
    async (deliveryStatus) => {
      const fakeWindow = stubBrowserWindow();
      const request = vi.fn(async (method: string) => {
        if (method === "desktop.task.get") return { task: taskDetail };
        if (method === "task.followUp.receipt")
          return { found: true, state: "pending", deliveryStatus, queuedAt: 10, startedAt: 20 };
        throw new Error(`Unexpected RPC method ${method}`);
      });
      const dispose = installBrowserHostBridge(
        { request } as unknown as BrowserHostTransport,
        session,
      );
      const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
      await expect(api.sendMessage(taskDetail.id, "Existing follow-up")).resolves.toMatchObject({
        queued: true,
        deliveryStatus: "queued",
      });
      expect(request.mock.calls.some(([method]) => method === "task.followUp")).toBe(false);
      dispose();
    },
  );

  it("translates shared composer attachments and preserves rich follow-up context", async () => {
    const fakeWindow = stubBrowserWindow();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "desktop.workspace.list") return { workspaces: [workspace] };
      if (method === "desktop.task.get") return { task: taskDetail };
      if (method === "task.admission.get") return { found: false };
      if (method === "task.create")
        return { found: true, taskId: taskDetail.id, task: taskSummary };
      if (method === "task.followUp.receipt") return { found: false, state: "pending" };
      if (method === "task.followUp") return { found: true, state: "admitted", acceptedAt: 10 };
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;
    const images = [
      {
        filePath: `${workspace.path}/attachment.png`,
        filename: "attachment.png",
        mimeType: "image/png" as const,
        sizeBytes: 10,
      },
    ];
    await api.createTask({
      title: "Read image",
      prompt: "Read this",
      workspaceId: workspace.id,
      images,
    });
    const quote = { taskId: taskDetail.id, eventId: "event-1", message: "Previous answer" };
    const mentions = [
      {
        id: "mcp:test",
        label: "Test",
        source: "mcp" as const,
        providerKey: "test",
        iconKey: "test",
        tools: ["read"],
        promptHint: "Use test",
      },
    ];
    await api.sendMessage(taskDetail.id, "Continue", images, quote, {
      expectedTurnId: "turn-1",
      integrationMentions: mentions,
    });
    const expectedImages = [
      {
        relativePath: "attachment.png",
        filename: "attachment.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
    ];
    expect(request.mock.calls.find(([method]) => method === "task.create")?.[1]).toMatchObject({
      images: expectedImages,
    });
    expect(request.mock.calls.find(([method]) => method === "task.followUp")?.[1]).toMatchObject({
      images: expectedImages,
      quotedAssistantMessage: quote,
      expectedTurnId: "turn-1",
      integrationMentions: mentions,
    });
    dispose();
  });

  it("exposes file viewing independently of upload permission", () => {
    const fakeWindow = stubBrowserWindow();
    const readOnlySession = {
      ...session,
      capabilities: { "files.read": { available: true } },
    } as WebSessionBootstrap;
    const dispose = installBrowserHostBridge(
      { request: vi.fn() } as unknown as BrowserHostTransport,
      readOnlySession,
    );
    const manifest = (
      fakeWindow.coworkBrowserHostInfo as unknown as { desktopMethods: Record<string, unknown> }
    ).desktopMethods;
    expect(manifest).toHaveProperty("readFileForViewer");
    expect(manifest).toHaveProperty("openFile");
    expect(manifest).not.toHaveProperty("selectFiles");
    expect(manifest).not.toHaveProperty("importFilesToWorkspace");
    dispose();
  });

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
    expect(fakeWindow.coworkBrowserHostInfo).toMatchObject({
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

  it("loads older task timeline pages and exposes only the browser-safe event detail", async () => {
    const fakeWindow = stubBrowserWindow();
    const recentEvent = {
      id: "recent-event",
      taskId: taskDetail.id,
      timestamp: 20,
      type: "assistant_message",
      payload: { message: "Recent answer", privateData: "[REDACTED]" },
      schemaVersion: 2,
    };
    const olderEvent = {
      id: "older-event",
      taskId: taskDetail.id,
      timestamp: 10,
      type: "progress_update",
      payload: { message: "Earlier progress" },
      schemaVersion: 2,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "desktop.task.get") return { task: taskDetail };
      if (method === "task.events.snapshot") {
        return {
          taskId: taskDetail.id,
          workspaceId: workspace.id,
          events: [recentEvent],
          cursor: { taskId: taskDetail.id, position: 3 },
          hasMoreHistory: true,
          nextHistoryCursor: { order: 2, timestamp: 10, id: "older-event" },
        };
      }
      if (method === "task.events.history") {
        return {
          events: [olderEvent],
          hasMoreHistory: false,
          nextHistoryCursor: null,
        };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    });
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as typeof window.electronAPI;

    const recentPage = await api.getTaskTimelinePage({ taskId: taskDetail.id, limit: 1 });
    expect(recentPage).toMatchObject({
      taskId: taskDetail.id,
      events: [recentEvent],
      hasMoreHistory: true,
      nextCursor: { order: 2, timestamp: 10, id: "older-event" },
      summary: { eventCount: 1 },
    });
    const historyPage = await api.getTaskTimelinePage({
      taskId: taskDetail.id,
      cursor: recentPage.nextCursor,
      limit: 1,
    });
    expect(historyPage).toMatchObject({
      events: [olderEvent],
      hasMoreHistory: false,
      nextCursor: null,
    });
    expect(request).toHaveBeenCalledWith(
      "task.events.history",
      {
        taskId: taskDetail.id,
        workspaceId: workspace.id,
        beforeCursor: { order: 2, timestamp: 10, id: "older-event" },
        limit: 1,
      },
      undefined,
    );
    await expect(
      api.getTaskEventDetail({ taskId: taskDetail.id, eventId: "recent-event" }),
    ).resolves.toMatchObject({ event: recentEvent });
    expect(
      (
        fakeWindow.coworkBrowserHostInfo as unknown as {
          desktopMethods: Record<string, unknown>;
        }
      ).desktopMethods,
    ).toMatchObject({
      getTaskTimelinePage: { mutation: false },
      getTaskEventDetail: { mutation: false },
    });
    dispose();
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
