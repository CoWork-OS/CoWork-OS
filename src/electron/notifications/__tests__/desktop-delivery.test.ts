import { afterEach, describe, expect, it, vi } from "vitest";
import { showDesktopNotification, updateDockNotificationBadge } from "../desktop-delivery";
import type { TraySettings } from "../../../shared/types";

const mocks = vi.hoisted(() => ({ native: vi.fn(), overlay: vi.fn(), badge: vi.fn() }));
vi.mock("electron", () => ({ app: { dock: { setBadge: mocks.badge } } }));
vi.mock("../NativeNotificationCenter", () => ({
  NativeNotificationCenter: { getInstance: () => ({ show: mocks.native }) },
}));
vi.mock("../NotificationOverlayWindow", () => ({
  NotificationOverlayManager: { getInstance: () => ({ show: mocks.overlay }) },
}));
const notification = { id: "test", title: "TEST DATA", message: "Preview" };

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("desktop notification delivery", () => {
  it("updates unread counts and clears the Dock badge when read, disabled, or switched to system", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const settings = { showNotifications: true, notificationStyle: "near-dock" } as TraySettings;
    updateDockNotificationBadge(settings, 2);
    expect(mocks.badge).toHaveBeenLastCalledWith("2");
    updateDockNotificationBadge(settings, 0);
    expect(mocks.badge).toHaveBeenLastCalledWith("");
    updateDockNotificationBadge({ ...settings, showNotifications: false }, 2);
    expect(mocks.badge).toHaveBeenLastCalledWith("");
    updateDockNotificationBadge({ ...settings, notificationStyle: "system" }, 2);
    expect(mocks.badge).toHaveBeenLastCalledWith("");
  });
  it("uses only the Dock card on macOS when selected", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    showDesktopNotification(notification, "near-dock");
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.overlay).toHaveBeenCalledExactlyOnceWith(notification, "near-dock");
  });

  it("preserves native notifications on other platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.native.mockReturnValue(true);
    showDesktopNotification(notification, "near-dock");
    expect(mocks.native).toHaveBeenCalledOnce();
    expect(mocks.overlay).not.toHaveBeenCalled();
  });

  it("falls back when native delivery fails immediately or asynchronously", () => {
    mocks.native.mockReturnValue(false);
    showDesktopNotification(notification);
    expect(mocks.overlay).toHaveBeenCalledExactlyOnceWith(notification, "system");
    mocks.overlay.mockClear();
    mocks.native.mockReturnValue(true);
    showDesktopNotification(notification);
    mocks.native.mock.calls.at(-1)?.[1]();
    expect(mocks.overlay).toHaveBeenCalledExactlyOnceWith(notification, "system");
  });
});
