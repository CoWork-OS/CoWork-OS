import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHostTransport } from "../../renderer-web/transport";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import type { Workspace } from "../../shared/types";
import { installBrowserHostBridge } from "./browser-host-bridge";
import {
  chooseBrowserHostFolderWorkspace,
  getBrowserHostFolderApi,
  hasBrowserHostFolderPicker,
  registerBrowserHostFolderPicker,
} from "./browser-host-folders";

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
  activeWorkspaceId: null,
} as unknown as WebSessionBootstrap;

const folderMethods = {
  listHostFolders: { mutation: false },
  openHostFolderWorkspace: { mutation: true },
};

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

function install(desktopMethods: Record<string, { mutation: boolean }>) {
  const fakeWindow = {
    electronAPI: undefined as unknown,
    coworkBrowserHost: undefined as true | undefined,
    coworkBrowserHostInfo: undefined as unknown,
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) =>
    method === "desktop.openHostFolderWorkspace"
      ? { id: "workspace-1", name: "api", path: "/home/me/api" }
      : { roots: [], rootId: "home", path: [], displayPath: "~", folders: [], truncated: false },
  );
  const dispose = installBrowserHostBridge(
    { request } as unknown as BrowserHostTransport,
    {
      ...session,
      desktopMethods,
    } as WebSessionBootstrap,
  );
  return { fakeWindow, request, dispose };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser host folder picker bridge", () => {
  it("maps the folder methods to the host's desktop RPCs", async () => {
    const { request, dispose } = install(folderMethods);
    expect(hasBrowserHostFolderPicker()).toBe(true);
    const api = getBrowserHostFolderApi();

    await api.listHostFolders({ rootId: "home", path: ["Projects"], includeHidden: true });
    expect(request).toHaveBeenLastCalledWith(
      "desktop.listHostFolders",
      { args: [{ rootId: "home", path: ["Projects"], includeHidden: true }] },
      { timeoutMs: 120_000 },
    );

    await expect(
      api.openHostFolderWorkspace({ rootId: "home", path: ["Projects", "api"] }),
    ).resolves.toMatchObject({ id: "workspace-1" });
    const [method, params, options] = request.mock.calls.at(-1)!;
    expect(method).toBe("desktop.openHostFolderWorkspace");
    expect(params).toEqual({ args: [{ rootId: "home", path: ["Projects", "api"] }] });
    // Adding a workspace is a keyed mutation, so a lost reply replays instead of re-running.
    expect(options).toMatchObject({ mutation: true, operationKey: expect.any(String) });
    dispose();
  });

  it("keeps the picker off when the host does not serve both methods", async () => {
    const { dispose } = install({ listHostFolders: { mutation: false } });
    expect(hasBrowserHostFolderPicker()).toBe(false);
    const unregister = registerBrowserHostFolderPicker(async () => null);
    await expect(chooseBrowserHostFolderWorkspace()).rejects.toThrow(/not available/);
    unregister();
    dispose();
  });

  it("opens the mounted picker and passes where to start", async () => {
    const { dispose } = install(folderMethods);
    await expect(chooseBrowserHostFolderWorkspace()).rejects.toThrow(/not available/);

    const workspace = { id: "workspace-1" } as Workspace;
    const opener = vi.fn(async () => workspace);
    const unregister = registerBrowserHostFolderPicker(opener);
    await expect(chooseBrowserHostFolderWorkspace({ startWorkspaceId: "current" })).resolves.toBe(
      workspace,
    );
    expect(opener).toHaveBeenCalledWith({ startWorkspaceId: "current" });

    unregister();
    await expect(chooseBrowserHostFolderWorkspace()).rejects.toThrow(/not available/);
    dispose();
  });

  it("is never offered outside a browser session", () => {
    vi.stubGlobal("window", { electronAPI: {}, coworkBrowserHost: undefined });
    expect(hasBrowserHostFolderPicker()).toBe(false);
  });
});
