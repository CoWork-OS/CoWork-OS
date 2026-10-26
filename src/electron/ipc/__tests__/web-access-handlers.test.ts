import { beforeEach, describe, expect, it, vi } from "vitest";

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel, handler) => registered.set(channel, handler)) },
  shell: { openExternal: vi.fn() },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { canOpenSignInLinkPrivately, setupWebAccessHandlers } from "../web-access-handlers";
import type { WebAccessServer } from "../../web-server/WebAccessServer";

const LINK = {
  url: "http://127.0.0.1:3847/app/#pair=abcdefghijklmnopqrstuvwxyz",
  appUrl: "http://127.0.0.1:3847/app/",
  expiresAt: 1_000,
};

function invoke(channel: string, ...args: unknown[]) {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

function setup(platform: NodeJS.Platform) {
  const server = {
    getConfig: vi.fn(() => ({ enabled: true })),
    applyConfig: vi.fn(async (updates: unknown) => ({ enabled: true, ...(updates as object) })),
    getStatus: vi.fn(() => ({ running: true, browserApplication: true, connectedClients: 0 })),
  };
  const openExternal = vi.fn(async () => {});
  const onSettingsApplied = vi.fn(async () => {});
  const saveSettings = vi.fn();
  const browserApp = {
    createPairingCode: vi.fn(() => ({ code: "x".repeat(32), expiresAt: 1_000 })),
    createSignInLink: vi.fn(() => LINK),
    signOutAll: vi.fn(() => ({ signedOut: 3 })),
    getStatus: vi.fn(() => ({
      enabled: true,
      appUrl: LINK.appUrl,
      remote: false,
      signedInBrowsers: 3,
    })),
  };
  setupWebAccessHandlers(server as unknown as WebAccessServer, {
    saveSettings,
    onSettingsApplied,
    browserApp,
    openExternal,
    platform,
  });
  return { server, openExternal, onSettingsApplied, saveSettings, browserApp };
}

describe("Web Access IPC", () => {
  beforeEach(() => registered.clear());

  it("opens the sign-in link where its command line stays private", async () => {
    const { openExternal } = setup("darwin");
    await expect(invoke(IPC_CHANNELS.WEBACCESS_OPEN_BROWSER_APP)).resolves.toEqual({
      opened: true,
      appUrl: LINK.appUrl,
    });
    expect(openExternal).toHaveBeenCalledWith(LINK.url);
  });

  it("hands the link back instead of opening it on Linux", async () => {
    const { openExternal } = setup("linux");
    await expect(invoke(IPC_CHANNELS.WEBACCESS_OPEN_BROWSER_APP)).resolves.toEqual({
      opened: false,
      link: LINK,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("applies saved settings to the browser app after saving them", async () => {
    const { server, saveSettings, onSettingsApplied } = setup("darwin");
    await invoke(IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS, { browserApp: true });
    expect(server.applyConfig).toHaveBeenCalledWith({ browserApp: true });
    expect(saveSettings).toHaveBeenCalledWith({ enabled: true, browserApp: true });
    expect(onSettingsApplied).toHaveBeenCalledWith({ enabled: true, browserApp: true });
  });

  it("ignores a settings payload that is not an object", async () => {
    const { server } = setup("darwin");
    await invoke(IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS, "enabled=true");
    await invoke(IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS, ["enabled"]);
    expect(server.applyConfig).toHaveBeenNthCalledWith(1, {});
    expect(server.applyConfig).toHaveBeenNthCalledWith(2, {});
  });

  it("adds browser app sign-ins to the listener status and signs everyone out", async () => {
    const { browserApp } = setup("darwin");
    await expect(invoke(IPC_CHANNELS.WEBACCESS_GET_STATUS)).resolves.toMatchObject({
      running: true,
      signedInBrowsers: 3,
      browserAppUrl: LINK.appUrl,
    });
    await expect(invoke(IPC_CHANNELS.WEBACCESS_SIGN_OUT_BROWSERS)).resolves.toEqual({
      signedOut: 3,
    });
    expect(browserApp.signOutAll).toHaveBeenCalledTimes(1);
  });

  it("knows where opening a link keeps it private", () => {
    expect(canOpenSignInLinkPrivately("darwin")).toBe(true);
    expect(canOpenSignInLinkPrivately("win32")).toBe(true);
    expect(canOpenSignInLinkPrivately("linux")).toBe(false);
    expect(canOpenSignInLinkPrivately("freebsd")).toBe(false);
  });
});
