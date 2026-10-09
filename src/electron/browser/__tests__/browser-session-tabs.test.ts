import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";
import { BrowserSessionManager } from "../browser-session-manager";
import { BrowserWorkbenchService, detectSignInWall } from "../browser-workbench-service";
import { el, FakePage } from "./fake-page";

const button = (id: string, label: string) =>
  el("button", { attrs: { id }, rect: { x: 10, y: 10, width: 80, height: 30 } }, label);

/** A manager whose webContents lookup returns one FakePage per webContents id. */
function tabbedManager(pages: Record<number, FakePage>) {
  const manager = new BrowserSessionManager();
  (manager as Any).getWebContents = async (tab: Any) =>
    tab ? pages[tab.webContentsId]?.contents(tab.webContentsId) || null : null;
  return manager;
}

describe("BrowserSessionManager workbench tabs", () => {
  it("lists every registered tab and acts on the active one", async () => {
    const pages = { 11: new FakePage(), 12: new FakePage(), 13: new FakePage() };
    pages[11].mount(button("a", "Alpha"));
    pages[12].mount(button("b", "Beta"));
    pages[13].mount(button("c", "Gamma"));
    const manager = tabbedManager(pages);

    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "a", webContentsId: 11 });
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "b", webContentsId: 12 });
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "c", webContentsId: 13 });

    const tabs = manager.getTabs("t");
    expect(tabs.map((tab) => tab.tabId)).toEqual(["a", "b", "c"]);
    // The first tab stays active until another is activated.
    expect(tabs.filter((tab) => tab.active).map((tab) => tab.tabId)).toEqual(["a"]);

    expect(manager.activateTab("t", "c")).toBe(true);
    const snapshot = await manager.snapshot({ taskId: "t" });
    expect(snapshot?.tabId).toBe("c");
    expect(snapshot?.nodes.map((node) => node.name)).toContain("Gamma");
    expect(manager.activateTab("t", "missing")).toBe(false);
  });

  it("rejects a ref from another tab with the owning tab id", async () => {
    const pages = { 21: new FakePage(), 22: new FakePage() };
    pages[21].mount(button("save", "Save"));
    pages[22].mount(button("other", "Other"));
    const manager = tabbedManager(pages);
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "a", webContentsId: 21 });
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "b", webContentsId: 22 });

    const snapshot = await manager.snapshot({ taskId: "t" });
    const ref = snapshot?.nodes.find((node) => node.name === "Save")?.ref;
    expect(ref).toBeTruthy();

    manager.activateTab("t", "b");
    await expect(manager.clickRef({ taskId: "t", ref: ref! })).rejects.toThrow(
      /belongs to tab "a".*browser_switch_tab/,
    );

    manager.activateTab("t", "a");
    await expect(manager.clickRef({ taskId: "t", ref: ref! })).resolves.toMatchObject({
      success: true,
    });
  });

  it("returns control to the opener when an active popup closes", async () => {
    const pages = { 31: new FakePage(), 32: new FakePage(), 33: new FakePage() };
    const manager = tabbedManager(pages);
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "a", webContentsId: 31 });
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "b", webContentsId: 32 });
    await manager.registerElectronWorkbenchSession({
      taskId: "t",
      tabId: "popup-1",
      kind: "popup",
      openerTabId: "b",
      activate: true,
      webContentsId: 33,
    });
    expect(manager.getActiveTabId("t")).toBe("popup-1");
    expect(manager.findTabOwner(33)).toMatchObject({ tabId: "popup-1", kind: "popup" });

    const result = manager.unregisterSession({ taskId: "t", tabId: "popup-1" });
    expect(result).toEqual({ activeTabClosed: true, activeTabId: "b" });
    expect(manager.getTabs("t").map((tab) => tab.tabId)).toEqual(["a", "b"]);

    // A stale unregister from a replaced webContents removes nothing.
    expect(manager.unregisterSession({ taskId: "t", tabId: "a", webContentsId: 99 })).toEqual({
      activeTabClosed: false,
      activeTabId: "b",
    });
    manager.unregisterSession({ taskId: "t" });
    expect(manager.getTabs("t")).toEqual([]);
  });
});

describe("BrowserSessionManager local and blocked navigation", () => {
  it("allows a user-opened dev server by origin for its session only", () => {
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    expect(manager.explainUrlBlock("t", "http://localhost:5173/")).toEqual({
      reason: "local_preview",
    });

    expect(manager.allowUserLocalPreviewUrl("t", "http://localhost:5173/")).toBe(true);
    // Routes and assets of the same dev server load too.
    expect(manager.explainUrlBlock("t", "http://localhost:5173/src/main.tsx")).toBeNull();
    expect(manager.explainUrlBlock("t", "http://localhost:5174/")).not.toBeNull();
    expect(manager.explainUrlBlock("other-task", "http://localhost:5173/")).not.toBeNull();
  });

  it("refuses a user dev-server allowance when the profile disables networking", () => {
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "disabled" });
    expect(manager.allowUserLocalPreviewUrl("t", "http://localhost:5173/")).toBe(false);
    expect(manager.explainUrlBlock("t", "http://localhost:5173/")).not.toBeNull();
  });

  it("revokes a user dev-server allowance when the profile tightens or is cleared", () => {
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    expect(manager.allowUserLocalPreviewUrl("t", "http://localhost:5173/")).toBe(true);
    manager.setAccessPolicy("t", { networkEnabled: false, accessNetworkMode: "enabled" });
    expect(manager.explainUrlBlock("t", "http://localhost:5173/")).not.toBeNull();
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    expect(manager.explainUrlBlock("t", "http://localhost:5173/")).toBeNull();
    manager.clearAccessPolicy("t");
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    expect(manager.explainUrlBlock("t", "http://localhost:5173/")).not.toBeNull();
  });

  it("classifies blocked URLs by scheme and policy", () => {
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("t", {
      networkEnabled: true,
      accessNetworkMode: "enabled",
      profileDomainRules: [{ pattern: "blocked.example", access: "deny" }],
    });
    expect(manager.explainUrlBlock("t", "mailto:someone@example.com")).toEqual({
      reason: "scheme",
      detail: "mailto",
    });
    expect(manager.explainUrlBlock("t", "https://blocked.example/")).toEqual({
      reason: "policy",
      detail: "profile_domain_denied",
    });
  });

  it("reports a cancelled main-frame navigation of a registered tab", async () => {
    let willNavigate: Any;
    const contents = {
      id: 41,
      getURL: () => "about:blank",
      isDestroyed: () => false,
      on: (event: string, handler: Any) => {
        if (event === "will-navigate") willNavigate = handler;
      },
      setWebRTCIPHandlingPolicy: vi.fn(),
      session: {
        setProxy: vi.fn(),
        closeAllConnections: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      },
    };
    const manager = new BrowserSessionManager();
    (manager as Any).prepareNetworkProxy = async () => undefined;
    (manager as Any).getWebContents = async (tab: Any) => {
      if (!tab) return null;
      (manager as Any).attachAccessGuards(tab, contents);
      return contents;
    };
    const events: Any[] = [];
    manager.setNavigationBlockedListener((event) => events.push(event));
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "disabled" });
    await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "a", webContentsId: 41 });

    const preventDefault = vi.fn();
    willNavigate({ preventDefault }, "https://example.com/next");
    expect(preventDefault).toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        taskId: "t",
        sessionId: "default",
        tabId: "a",
        url: "https://example.com/next",
        reason: "policy",
        detail: "profile_network_disabled",
      }),
    ]);
  });
});

describe("BrowserWorkbenchService tabs", () => {
  it("opens a tab through the renderer and waits for its registration", async () => {
    const manager = tabbedManager({ 51: new FakePage(), 52: new FakePage() });
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    const service = new BrowserWorkbenchService(manager);
    const send = vi.fn();
    service.setMainWindow({ isDestroyed: () => false, webContents: { send } });
    await service.registerSession({
      taskId: "t",
      sessionId: "default",
      tabId: "a",
      webContentsId: 51,
    });

    const opening = service.openTab({ taskId: "t", url: "https://example.com/" });
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.BROWSER_WORKBENCH_TAB_COMMAND,
      expect.objectContaining({ command: "open", url: "https://example.com/" }),
    );
    const tabId = send.mock.calls[0][1].tabId as string;
    await service.registerSession({
      taskId: "t",
      sessionId: "default",
      tabId,
      webContentsId: 52,
    });
    await expect(opening).resolves.toBe(tabId);

    expect(service.activateTab({ taskId: "t", tabId })).toBe(true);
    expect(service.getSession("t")).toMatchObject({ tabId, webContentsId: 52 });

    // Closing the active tab moves tools back to the remaining tab and shows it.
    service.unregisterSession({ taskId: "t", sessionId: "default", tabId });
    expect(service.getSession("t")).toMatchObject({ tabId: "a", webContentsId: 51 });
    expect(send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.BROWSER_WORKBENCH_TAB_COMMAND,
      expect.objectContaining({ command: "activate", tabId: "a" }),
    );
  });

  it("checks user navigations and allows local dev servers for the session", () => {
    const manager = new BrowserSessionManager();
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "enabled" });
    const service = new BrowserWorkbenchService(manager);

    expect(service.userNavigate({ taskId: "t", url: "localhost:5173" })).toEqual({
      allowed: true,
      url: "http://localhost:5173",
    });
    manager.setAccessPolicy("t", { networkEnabled: true, accessNetworkMode: "disabled" });
    expect(service.userNavigate({ taskId: "t", url: "https://example.com" })).toMatchObject({
      allowed: false,
      block: { reason: "policy", detail: "profile_network_disabled" },
    });
  });
});

describe("sign-in walls", () => {
  const contents = (hasPassword: boolean) => ({
    executeJavaScript: async () => hasPassword,
  });

  it("recognizes identity providers and login pages with a password field", async () => {
    await expect(
      detectSignInWall(contents(false), "https://accounts.google.com/v3/signin"),
    ).resolves.toBe(true);
    await expect(detectSignInWall(contents(true), "https://app.example/login")).resolves.toBe(true);
    await expect(detectSignInWall(contents(false), "https://app.example/login")).resolves.toBe(
      false,
    );
    await expect(detectSignInWall(contents(true), "https://app.example/settings")).resolves.toBe(
      false,
    );
  });
});

describe("BrowserWorkbenchService driving state", () => {
  it("nests tool calls, remembers recent driving and tells the renderer about pauses", () => {
    const service = new BrowserWorkbenchService(new BrowserSessionManager());
    const send = vi.fn();
    service.setMainWindow({ isDestroyed: () => false, webContents: { send } });
    service.beginDriving("t", "default", "browser_act_batch");
    service.beginDriving("t", "default", "browser_click");
    service.endDriving("t", "default");
    expect(service.isDriving("t")).toBe(true);
    service.endDriving("t", "default");
    expect(service.isDriving("t")).toBe(false);
    expect(service.wasRecentlyDriven("t")).toBe(true);

    service.setPausedByUser("t", "default", true);
    expect(service.isPausedByUser("t")).toBe(true);
    expect(send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.BROWSER_WORKBENCH_DRIVING,
      expect.objectContaining({ driving: null, pausedByUser: true }),
    );
  });
});
