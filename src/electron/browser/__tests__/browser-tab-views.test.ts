import { describe, expect, it, vi } from "vitest";
import { BrowserTabViewHost, isLoadableTabViewUrl } from "../browser-tab-views";

let nextId = 100;

function fakeContents(session: unknown) {
  const listeners = new Map<string, (...args: Any[]) => void>();
  return {
    id: nextId++,
    session,
    destroyed: false,
    url: "",
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    on: vi.fn((event: string, listener: Any) => listeners.set(event, listener)),
    once: vi.fn((event: string, listener: Any) => listeners.set(event, listener)),
    loadURL: vi.fn(async function (this: Any, url: string) {
      this.url = url;
    }),
    getURL() {
      return this.url;
    },
    getTitle: () => "Page",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn() },
    reload: vi.fn(),
    setZoomLevel: vi.fn(),
    findInPage: vi.fn(),
    invalidate: vi.fn(),
    capturePage: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => "data:image/png;x" })),
    close: vi.fn(function (this: Any) {
      this.destroyed = true;
    }),
  };
}

function setup(options: { maxLiveViews?: number; driving?: boolean } = {}) {
  const session = { name: "browser" };
  const children: Any[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 1 },
    contentView: {
      addChildView: vi.fn((view: Any) => children.push(view)),
      removeChildView: vi.fn((view: Any) => children.splice(children.indexOf(view), 1)),
    },
  };
  class FakeView {
    webContents = fakeContents(session);
    bounds: Any = null;
    visible = true;
    setBounds(bounds: Any) {
      this.bounds = bounds;
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    setBackgroundColor() {}
  }
  const calls: string[] = [];
  const events: Any[] = [];
  const deps = {
    getWindow: () => window,
    WebContentsView: FakeView as Any,
    prepareSession: vi.fn(() => session),
    attachGuest: vi.fn(() => calls.push("attach")),
    register: vi.fn(async () => {
      calls.push("register");
    }),
    unregister: vi.fn(),
    updateStatus: vi.fn(),
    guard: vi.fn(() => calls.push("guard")),
    emit: vi.fn((event: Any) => events.push(event)),
    isAgentDriving: () => options.driving === true,
    maxLiveViews: options.maxLiveViews,
  };
  const host = new BrowserTabViewHost(deps);
  const key = (tabId: string) => ({ taskId: "t", sessionId: "s", tabId });
  const open = (tabId: string, activate = true) =>
    host.open({ ...key(tabId), partition: "persist:cowork-browser-ws", activate });
  return { host, deps, children, calls, events, key, open };
}

describe("BrowserTabViewHost", () => {
  it("registers and guards a view before anything loads, then reattaches it", async () => {
    const { host, children, calls, key, open } = setup();
    const state = await open("a");
    expect(state).toMatchObject({ reused: false, url: "" });
    expect(calls).toEqual(["attach", "register", "guard"]);
    expect(children).toHaveLength(1);
    expect(children[0].visible).toBe(false);
    const contents = children[0].webContents;
    expect(contents.loadURL).not.toHaveBeenCalled();

    expect(host.load(key("a"), "https://example.com/")).toBe(true);
    expect(contents.loadURL).toHaveBeenCalledWith("https://example.com/");
    expect(host.load(key("a"), "javascript:alert(1)")).toBe(false);

    const again = await open("a");
    expect(again).toMatchObject({
      reused: true,
      webContentsId: contents.id,
      url: "https://example.com/",
    });
    expect(children).toHaveLength(1);
  });

  it("shows only the active tab of a session at the given bounds", async () => {
    const { host, children, open } = setup();
    await open("a");
    await open("b");
    host.layout({
      taskId: "t",
      sessionId: "s",
      tabId: "b",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
    expect(children.map((view) => view.visible)).toEqual([false, true]);
    expect(children[1].bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(children[1].webContents.invalidate).toHaveBeenCalled();
    // Hiding another tab leaves the shown one visible.
    host.layout({ taskId: "t", sessionId: "s", tabId: "a", bounds: null });
    expect(children.map((view) => view.visible)).toEqual([false, true]);
    host.layout({ taskId: "t", sessionId: "s", tabId: "b", bounds: null });
    expect(children.map((view) => view.visible)).toEqual([false, false]);
    host.layout({
      taskId: "t",
      sessionId: "s",
      tabId: "b",
      bounds: { x: 1, y: 1, width: 5, height: 5 },
    });
    host.hideSession("t", "s");
    expect(children.map((view) => view.visible)).toEqual([false, false]);
  });

  it("forwards page events and turns clicks into a take-over request while CoWork drives", async () => {
    const driving = setup({ driving: true });
    await driving.open("a");
    const contents = driving.children[0].webContents;
    contents.listeners.get("did-navigate")?.({}, "https://example.com/next");
    expect(driving.events[0]).toMatchObject({
      tabId: "a",
      type: "navigate",
      url: "https://example.com/next",
      inPage: false,
      canGoBack: true,
    });
    expect(driving.deps.updateStatus).toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    contents.listeners.get("before-mouse-event")?.(event, { type: "mouseDown" });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(driving.events.at(-1)).toMatchObject({ type: "takeover-click" });

    const idle = setup();
    await idle.open("a");
    const idleEvent = { preventDefault: vi.fn() };
    idle.children[0].webContents.listeners.get("before-mouse-event")?.(idleEvent, {
      type: "mouseDown",
    });
    expect(idleEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("closes views explicitly and evicts the least recently used hidden ones", async () => {
    const { host, deps, children, events, key, open } = setup({ maxLiveViews: 2 });
    await open("a");
    await open("b");
    host.layout({
      taskId: "t",
      sessionId: "s",
      tabId: "b",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    await open("c");
    expect(children).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ tabId: "a", type: "gone", reason: "discarded" });
    expect(deps.unregister).toHaveBeenCalledWith(expect.objectContaining({ tabId: "a" }));

    host.close(key("b"));
    expect(children).toHaveLength(1);
    expect(host.get(key("b"))).toBeUndefined();
  });

  it("closes a deleted task's views and every view when the window goes", async () => {
    const { host, children, open } = setup();
    await open("a");
    await open("b");
    await host.open({
      taskId: "other",
      sessionId: "s",
      tabId: "c",
      partition: "persist:cowork-browser-ws",
      activate: true,
    });
    host.closeTask("t");
    expect(children).toHaveLength(1);
    host.closeAll();
    expect(children).toHaveLength(0);
  });

  it("clamps the zoom level", async () => {
    const { host, children, key, open } = setup();
    await open("a");
    host.command(key("a"), "setZoomLevel", { level: Infinity });
    host.command(key("a"), "setZoomLevel", { level: 99 });
    expect(children[0].webContents.setZoomLevel.mock.calls).toEqual([[0], [9]]);
  });

  it("captures a still image of the page", async () => {
    const { host, key, open } = setup();
    await open("a");
    await expect(host.capture(key("a"))).resolves.toBe("data:image/png;x");
    await expect(host.capture(key("missing"))).resolves.toBeNull();
  });
});

describe("isLoadableTabViewUrl", () => {
  it("allows web, file and blank pages only", () => {
    expect(isLoadableTabViewUrl("https://a.example")).toBe(true);
    expect(isLoadableTabViewUrl("http://127.0.0.1:5173/")).toBe(true);
    expect(isLoadableTabViewUrl("file:///ws/index.html")).toBe(true);
    expect(isLoadableTabViewUrl("about:blank")).toBe(true);
    expect(isLoadableTabViewUrl("javascript:alert(1)")).toBe(false);
    expect(isLoadableTabViewUrl("chrome://settings")).toBe(false);
    expect(isLoadableTabViewUrl("not a url")).toBe(false);
  });
});
