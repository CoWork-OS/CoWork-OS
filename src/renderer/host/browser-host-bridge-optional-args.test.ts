import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHostTransport } from "../../renderer-web/transport";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import { installBrowserHostBridge } from "./browser-host-bridge";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser host optional desktop arguments", () => {
  it("encodes an omitted middle argument separately from an explicit null", async () => {
    const fakeWindow = {
      electronAPI: undefined,
      coworkBrowserHost: undefined,
      coworkBrowserHostInfo: undefined,
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("navigator", { platform: "Win32" });

    const wireCalls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const request = vi.fn(async (method: string, params: unknown, options: unknown) => {
      wireCalls.push({ method, params: JSON.parse(JSON.stringify(params)), options });
      return [];
    });
    const session = {
      apiVersion: 1,
      host: {
        installationId: "installation-one",
        profileId: "profile-one",
        generation: "generation-one",
        runtime: "node",
        platform: "linux",
        appVersion: "1.0.0",
      },
      capabilities: {},
      csrfToken: "csrf-token",
      providerReady: true,
      onboardingCompleted: true,
      disclaimerAccepted: true,
      activeWorkspaceId: null,
      desktopMethods: { listRoutineWorkflowRuns: { mutation: false } },
    } as unknown as WebSessionBootstrap;
    const dispose = installBrowserHostBridge(
      { request } as unknown as BrowserHostTransport,
      session,
    );
    const api = fakeWindow.electronAPI as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;

    await api.listRoutineWorkflowRuns("task-one", undefined, 60);
    expect(wireCalls.at(-1)).toEqual({
      method: "desktop.listRoutineWorkflowRuns",
      params: { args: ["task-one", null, 60], omittedArgs: [1] },
      options: { timeoutMs: 120_000 },
    });

    await api.listRoutineWorkflowRuns("task-one", null, 60);
    expect(wireCalls.at(-1)).toEqual({
      method: "desktop.listRoutineWorkflowRuns",
      params: { args: ["task-one", null, 60] },
      options: { timeoutMs: 120_000 },
    });
    dispose();
  });
});
