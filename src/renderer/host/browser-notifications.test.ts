import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppNotification } from "../../shared/types";
import {
  BROWSER_NOTIFICATIONS_STORAGE_KEY,
  createBrowserNotificationMirror,
  formatBrowserNotificationBody,
  getBrowserNotificationState,
  readBrowserNotificationOptIn,
  requestBrowserNotificationPermission,
  showBrowserNotificationConfirmation,
  writeBrowserNotificationOptIn,
  type BrowserNotificationFeedEvent,
} from "./browser-notifications";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeNotificationApi(permission: NotificationPermission) {
  const instances: Array<{
    title: string;
    options: NotificationOptions;
    onclick: (() => void) | null;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const Api = vi.fn(function (this: unknown, title: string, options: NotificationOptions) {
    const instance = { title, options, onclick: null, close: vi.fn() };
    instances.push(instance);
    return instance;
  }) as unknown as typeof Notification & { permission: NotificationPermission };
  (Api as { permission: NotificationPermission }).permission = permission;
  (Api as unknown as { requestPermission: unknown }).requestPermission = vi.fn(async () => {
    (Api as { permission: NotificationPermission }).permission = "granted";
    return "granted";
  });
  return { Api, instances };
}

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "n-1",
    type: "input_required",
    title: "Approval needed",
    message: "Run **npm install** in the workspace?",
    read: false,
    createdAt: 1,
    taskId: "task-1",
    ...overrides,
  };
}

function makeMirror(
  options: { permission?: NotificationPermission; away?: boolean; optedIn?: boolean } = {},
) {
  const { Api, instances } = makeNotificationApi(options.permission ?? "granted");
  const win = { Notification: Api, isSecureContext: true, focus: vi.fn() };
  const doc = { hidden: options.away ?? true, hasFocus: () => !(options.away ?? true) };
  let emit: (event: BrowserNotificationFeedEvent) => void = () => undefined;
  const unsubscribe = vi.fn();
  const onOpen = vi.fn();
  const dispose = createBrowserNotificationMirror({
    win: win as never,
    doc,
    subscribe: (listener) => {
      emit = listener;
      return unsubscribe;
    },
    onOpen,
    isOptedIn: () => options.optedIn ?? true,
  });
  return {
    win,
    doc,
    instances,
    onOpen,
    unsubscribe,
    dispose,
    emit: (e: BrowserNotificationFeedEvent) => emit(e),
  };
}

describe("browser notification state", () => {
  it("reports all five states", () => {
    expect(getBrowserNotificationState(undefined)).toBe("unsupported");
    expect(getBrowserNotificationState({ isSecureContext: true })).toBe("unsupported");
    expect(
      getBrowserNotificationState({
        isSecureContext: false,
        Notification: makeNotificationApi("default").Api,
      }),
    ).toBe("insecure");
    for (const permission of ["default", "denied", "granted"] as const) {
      expect(
        getBrowserNotificationState({
          isSecureContext: true,
          Notification: makeNotificationApi(permission).Api,
        }),
      ).toBe(permission);
    }
  });

  it("asks for permission only in the default state", async () => {
    const { Api } = makeNotificationApi("default");
    const win = { isSecureContext: true, Notification: Api };
    await expect(requestBrowserNotificationPermission(win)).resolves.toBe("granted");
    expect(Api.requestPermission).toHaveBeenCalledTimes(1);

    const denied = makeNotificationApi("denied");
    await expect(
      requestBrowserNotificationPermission({ isSecureContext: true, Notification: denied.Api }),
    ).resolves.toBe("denied");
    expect(denied.Api.requestPermission).not.toHaveBeenCalled();
  });
});

describe("browser notification opt-in", () => {
  it("defaults off and round-trips through localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    expect(readBrowserNotificationOptIn()).toBe(false);
    writeBrowserNotificationOptIn(true);
    expect(store.get(BROWSER_NOTIFICATIONS_STORAGE_KEY)).toBe("1");
    expect(readBrowserNotificationOptIn()).toBe(true);
    writeBrowserNotificationOptIn(false);
    expect(readBrowserNotificationOptIn()).toBe(false);
  });

  it("survives a throwing localStorage", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(readBrowserNotificationOptIn()).toBe(false);
    expect(() => writeBrowserNotificationOptIn(true)).not.toThrow();
  });
});

describe("browser notification body", () => {
  it("is plain, single-line and capped", () => {
    expect(formatBrowserNotificationBody("  Run **npm install**\n\n## now ")).toBe(
      "Run npm install now",
    );
    expect(formatBrowserNotificationBody("Edit `__init__.py` in my_pkg")).toBe(
      "Edit __init__.py in my_pkg",
    );
    const long = formatBrowserNotificationBody("word ".repeat(80));
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
    expect(formatBrowserNotificationBody(undefined)).toBe("");
  });
});

describe("browser notification confirmation", () => {
  it("shows one notification and closes it after a moment", () => {
    vi.useFakeTimers();
    try {
      const { Api, instances } = makeNotificationApi("granted");
      const win = {
        isSecureContext: true,
        Notification: Api,
        setTimeout: ((fn: () => void, ms: number) =>
          setTimeout(fn, ms)) as unknown as Window["setTimeout"],
      };
      expect(showBrowserNotificationConfirmation(win)).toBe(true);
      expect(instances).toHaveLength(1);
      expect(instances[0].title).toBe("Browser notifications are on");
      expect(instances[0].close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(instances[0].close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports false without permission or when the page can't construct one", () => {
    const pending = makeNotificationApi("default");
    expect(
      showBrowserNotificationConfirmation({ isSecureContext: true, Notification: pending.Api }),
    ).toBe(false);
    expect(pending.instances).toHaveLength(0);

    // Chrome on Android: permission is granted but only a service worker may notify.
    const illegal = Object.assign(
      () => {
        throw new TypeError("Illegal constructor");
      },
      { permission: "granted" },
    ) as unknown as typeof Notification;
    expect(
      showBrowserNotificationConfirmation({ isSecureContext: true, Notification: illegal }),
    ).toBe(false);
  });
});

describe("browser notification mirror", () => {
  it("shows an added alertable notification when opted in, granted and away", () => {
    const mirror = makeMirror();
    mirror.emit({ type: "added", notification: notification() });
    expect(mirror.instances).toHaveLength(1);
    expect(mirror.instances[0].title).toBe("Approval needed");
    expect(mirror.instances[0].options).toEqual({
      body: "Run npm install in the workspace?",
      tag: "n-1",
    });
  });

  it("stays quiet when not opted in, not granted, or the user is present", () => {
    for (const options of [
      { optedIn: false },
      { permission: "default" as const },
      { permission: "denied" as const },
      { away: false },
    ]) {
      const mirror = makeMirror(options);
      mirror.emit({ type: "added", notification: notification() });
      expect(mirror.instances).toHaveLength(0);
    }
  });

  it("only mirrors added, unread events that ask for a desktop alert", () => {
    const mirror = makeMirror();
    mirror.emit({ type: "updated", notification: notification({ id: "a" }) });
    mirror.emit({ type: "removed", notification: notification({ id: "b" }) });
    mirror.emit({ type: "cleared" });
    mirror.emit({ type: "added" });
    mirror.emit({ type: "added", notification: notification({ id: "c", desktopAlert: false }) });
    mirror.emit({ type: "added", notification: notification({ id: "d", read: true }) });
    expect(mirror.instances).toHaveLength(0);
    mirror.emit({ type: "added", notification: notification({ id: "e", desktopAlert: true }) });
    expect(mirror.instances).toHaveLength(1);
  });

  it("dedupes by notification id", () => {
    const mirror = makeMirror();
    mirror.emit({ type: "added", notification: notification() });
    mirror.emit({ type: "added", notification: notification() });
    mirror.emit({ type: "added", notification: notification({ id: "n-2" }) });
    expect(mirror.instances.map((item) => item.options.tag)).toEqual(["n-1", "n-2"]);
  });

  it("focuses the window, closes the alert and opens the notification on click", () => {
    const mirror = makeMirror();
    const item = notification();
    mirror.emit({ type: "added", notification: item });
    mirror.instances[0].onclick?.();
    expect(mirror.win.focus).toHaveBeenCalledTimes(1);
    expect(mirror.instances[0].close).toHaveBeenCalledTimes(1);
    expect(mirror.onOpen).toHaveBeenCalledWith(item);
  });

  it("returns the feed unsubscribe", () => {
    const mirror = makeMirror();
    mirror.dispose();
    expect(mirror.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("swallows a constructor that throws", () => {
    const mirror = makeMirror();
    (mirror.win as { Notification: unknown }).Notification = Object.assign(
      () => {
        throw new TypeError("Illegal constructor");
      },
      { permission: "granted" },
    );
    expect(() => mirror.emit({ type: "added", notification: notification() })).not.toThrow();
  });
});
