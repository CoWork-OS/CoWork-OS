import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run effects synchronously so the hooks can be called as plain functions here.
const cleanups: Array<() => void> = [];
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  },
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, () => undefined],
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));

import type { Task } from "../../shared/types";
import { useBrowserNotifications } from "./useBrowserNotifications";
import { useBrowserTabAttention } from "./useBrowserTabAttention";

const oneWaiting = new Map([["task-1", "Approval needed"]]);
const blockedTask = {
  id: "task-1",
  title: "Fixture",
  prompt: "",
  status: "blocked",
  workspaceId: "workspace-1",
  createdAt: 1,
  updatedAt: 1,
  terminalStatus: "awaiting_approval",
} as Task;

function fakeDocument() {
  return {
    title: "CoWork OS",
    hidden: true,
    hasFocus: () => false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    createElement: vi.fn(),
  };
}

function fakeWindow(browserHost: boolean) {
  return {
    coworkBrowserHost: browserHost,
    coworkBrowserHostInfo: { desktopMethods: { onNotificationEvent: {} } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    electronAPI: { onNotificationEvent: vi.fn(() => () => undefined) },
  };
}

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser attention hooks", () => {
  it("do nothing at all outside a browser host", () => {
    const doc = fakeDocument();
    const win = fakeWindow(false);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    useBrowserTabAttention({ queueWaiting: oneWaiting, fromQueue: true, tasks: [blockedTask] });
    useBrowserNotifications(() => undefined);

    expect(doc.title).toBe("CoWork OS");
    expect(doc.addEventListener).not.toHaveBeenCalled();
    expect(doc.querySelectorAll).not.toHaveBeenCalled();
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(win.setInterval).not.toHaveBeenCalled();
    expect(win.electronAPI.onNotificationEvent).not.toHaveBeenCalled();
    expect(cleanups).toHaveLength(0);
  });

  it("set the title and subscribe to the feed in a browser host, and clean up", () => {
    const doc = fakeDocument();
    const win = fakeWindow(true);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    useBrowserTabAttention({ queueWaiting: oneWaiting, fromQueue: true, tasks: [] });
    useBrowserNotifications(() => undefined);

    expect(doc.title).toBe("(1) CoWork OS");
    expect(win.electronAPI.onNotificationEvent).toHaveBeenCalledTimes(1);
    for (const cleanup of cleanups) cleanup();
    expect(doc.title).toBe("CoWork OS");
  });

  it("count from the task list when the host has no needs-you queue", () => {
    const doc = fakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", fakeWindow(true));

    // A Node daemon host: the queue map is empty, the task list still knows who waits.
    useBrowserTabAttention({
      queueWaiting: new Map(),
      fromQueue: false,
      tasks: [
        blockedTask,
        { ...blockedTask, id: "task-2", status: "executing", terminalStatus: undefined },
        { ...blockedTask, id: "task-3", parentTaskId: "task-1" },
      ],
    });
    expect(doc.title).toBe("(1) CoWork OS");

    // With the queue, the queue decides, even when the task list disagrees.
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    useBrowserTabAttention({ queueWaiting: new Map(), fromQueue: true, tasks: [blockedTask] });
    expect(doc.title).toBe("CoWork OS");
  });

  it("mark a clicked notification read before opening it, like the desktop alert", () => {
    const doc = fakeDocument();
    const shown: Array<{ onclick: (() => void) | null; close: () => void }> = [];
    const Api = Object.assign(
      vi.fn(function () {
        const instance = { onclick: null, close: vi.fn() };
        shown.push(instance);
        return instance;
      }),
      { permission: "granted" },
    );
    const markNotificationRead = vi.fn(async () => undefined);
    let emit: (event: unknown) => void = () => undefined;
    const win = {
      ...fakeWindow(true),
      coworkBrowserHostInfo: {
        desktopMethods: { onNotificationEvent: {}, markNotificationRead: {} },
      },
      isSecureContext: true,
      Notification: Api,
      focus: vi.fn(),
      localStorage: { getItem: () => "1" },
      electronAPI: {
        markNotificationRead,
        onNotificationEvent: vi.fn((listener: (event: unknown) => void) => {
          emit = listener;
          return () => undefined;
        }),
      },
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    const onOpen = vi.fn();

    useBrowserNotifications(onOpen);
    const notification = { id: "n-1", type: "input_required", title: "Approval needed" };
    emit({ type: "added", notification: { ...notification, message: "", read: false } });
    expect(shown).toHaveLength(1);
    shown[0].onclick?.();

    expect(markNotificationRead).toHaveBeenCalledWith("n-1");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining(notification));
  });
});
