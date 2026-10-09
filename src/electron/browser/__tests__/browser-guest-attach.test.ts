import { describe, expect, it, vi } from "vitest";
import { attachBrowserGuest, routeWindowOpen } from "../browser-guest-attach";
import { buildChromeCompatibleUserAgent } from "../browser-user-agent";

const owner = { taskId: "t", sessionId: "default", tabId: "a", kind: "tab" as const };

describe("window.open routing", () => {
  it("routes by disposition and policy", () => {
    const route = (disposition: string, url = "https://example.com/", allowed = true) =>
      routeWindowOpen({ owner, url, disposition, allowed });
    expect(route("foreground-tab")).toBe("tab");
    expect(route("default")).toBe("tab");
    expect(route("background-tab")).toBe("background-tab");
    expect(route("new-window")).toBe("popup");
    // window.open() with no URL needs a real window the opener can script.
    expect(route("foreground-tab", "about:blank")).toBe("popup");
    expect(route("save-to-disk")).toBe("deny");
    expect(route("new-window", "https://example.com/", false)).toBe("deny");
    expect(
      routeWindowOpen({ owner: null, url: "https://x/", disposition: "new-window", allowed: true }),
    ).toBe("deny");
  });
});

function guestSetup(block: { reason: string; detail?: string } | null = null) {
  let handler: Any;
  const partitionSession = { partition: "persist:cowork-browser-ws" };
  const listeners = new Map<string, Any>();
  const guest = {
    id: 7,
    session: partitionSession,
    setWindowOpenHandler: (next: Any) => (handler = next),
    on: (event: string, listener: Any) => listeners.set(event, listener),
  };
  const order: string[] = [];
  const service = {
    openTab: vi.fn().mockResolvedValue("tab-new"),
    registerSession: vi.fn(async () => {
      order.push("register");
    }),
    unregisterSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    notifyNavigationBlocked: vi.fn(),
    sendShortcut: vi.fn(),
  };
  const manager = {
    findTabOwner: vi.fn((id: number) => (id === 7 ? owner : null)),
    explainUrlBlock: vi.fn(() => block),
    getTabs: vi.fn(() => [] as Array<{ kind: string }>),
    guardTabContents: vi.fn(),
  };
  const popupContents = {
    id: 99,
    session: partitionSession as Any,
    once: vi.fn(),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getURL: () => "https://accounts.example/auth",
  };
  const BrowserWindow = vi.fn(function (this: Any, options: Any) {
    order.push("window");
    this.options = options;
    this.webContents = popupContents;
    this.isDestroyed = () => false;
    this.close = vi.fn();
    this.destroy = vi.fn();
  });
  attachBrowserGuest(guest, {
    service: service as Any,
    manager: manager as Any,
    BrowserWindow: BrowserWindow as Any,
    getParentWindow: () => null,
    platform: "darwin",
  });
  return {
    handler: () => handler,
    service,
    manager,
    BrowserWindow,
    popupContents,
    order,
    listeners,
  };
}

describe("attachBrowserGuest", () => {
  it("turns target=_blank links into workbench tabs", () => {
    const { handler, service } = guestSetup();
    const result = handler()({ url: "https://example.com/doc", disposition: "foreground-tab" });
    expect(result).toEqual({ action: "deny" });
    expect(service.openTab).toHaveBeenCalledWith({
      taskId: "t",
      sessionId: "default",
      url: "https://example.com/doc",
      background: false,
      openerTabId: "a",
      waitForRegistration: false,
    });
  });

  it("opens window.open popups as hardened windows registered before they load", () => {
    const { handler, service, BrowserWindow, popupContents, order } = guestSetup();
    const result = handler()({
      url: "https://accounts.example/auth",
      disposition: "new-window",
    });
    expect(result.action).toBe("allow");
    const contents = result.createWindow({
      width: 480,
      height: 600,
      webPreferences: { preload: "x" },
    });
    expect(contents).toBe(popupContents);
    expect(order).toEqual(["window", "register"]);
    const options = (BrowserWindow.mock.instances[0] as Any).options;
    expect(options.webPreferences).toMatchObject({
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(service.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t",
        kind: "popup",
        openerTabId: "a",
        activate: true,
        webContentsId: 99,
      }),
    );
    // Popups get their own window-open handler and immediate navigation guards.
    expect(popupContents.setWindowOpenHandler).toHaveBeenCalled();
  });

  it("caps open popup windows per session", () => {
    const { handler, manager, BrowserWindow } = guestSetup();
    manager.getTabs.mockReturnValue(Array.from({ length: 4 }, () => ({ kind: "popup" })));
    expect(handler()({ url: "https://accounts.example/auth", disposition: "new-window" })).toEqual({
      action: "deny",
    });
    expect(BrowserWindow).not.toHaveBeenCalled();
  });

  it("destroys a popup that did not land on the opener's partition", () => {
    const { handler, service, popupContents } = guestSetup();
    (popupContents as Any).session = { other: true };
    const result = handler()({ url: "https://accounts.example/auth", disposition: "new-window" });
    result.createWindow({});
    expect(service.registerSession).not.toHaveBeenCalled();
  });

  it("denies blocked targets and reports them on the opener tab", () => {
    const { handler, service, BrowserWindow } = guestSetup({
      reason: "policy",
      detail: "profile_domain_denied",
    });
    expect(handler()({ url: "https://blocked.example/", disposition: "new-window" })).toEqual({
      action: "deny",
    });
    expect(BrowserWindow).not.toHaveBeenCalled();
    expect(service.notifyNavigationBlocked).toHaveBeenCalledWith(
      owner,
      "https://blocked.example/",
      {
        reason: "policy",
        detail: "profile_domain_denied",
      },
    );
  });
});

describe("browser shortcuts from pages", () => {
  it("runs browser chords as workbench commands and leaves other keys to the page", () => {
    const { listeners, service } = guestSetup();
    const onInput = listeners.get("before-input-event");
    const reload = { preventDefault: vi.fn() };
    onInput(reload, { type: "keyDown", key: "r", meta: true });
    expect(reload.preventDefault).toHaveBeenCalled();
    expect(service.sendShortcut).toHaveBeenCalledWith(owner, "reload");

    const pageKey = { preventDefault: vi.fn() };
    onInput(pageKey, { type: "keyDown", key: "k", meta: true });
    onInput(pageKey, { type: "keyUp", key: "r", meta: true });
    expect(pageKey.preventDefault).not.toHaveBeenCalled();
    expect(service.sendShortcut).toHaveBeenCalledTimes(1);
  });
});

describe("Chrome-compatible user agent", () => {
  it("names Chrome with a reduced version and no Electron token", () => {
    const ua = buildChromeCompatibleUserAgent("darwin", "146.0.7680.65");
    expect(ua).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
    expect(ua).not.toMatch(/Electron|CoWork/);
    expect(buildChromeCompatibleUserAgent("win32", "146.1")).toContain(
      "Windows NT 10.0; Win64; x64",
    );
    expect(buildChromeCompatibleUserAgent("linux", "146.1")).toContain("X11; Linux x86_64");
  });
});
