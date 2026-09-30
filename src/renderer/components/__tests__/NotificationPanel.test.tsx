import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPanel } from "../NotificationPanel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationPanel browser host support", () => {
  it("clearly disables notifications when the host exposes no notification services", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: {} },
    });

    const markup = renderToStaticMarkup(<NotificationPanel />);

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-label="Notifications unavailable"');
    expect(markup).toContain(
      'title="Notifications are not available in this browser session yet."',
    );
  });

  it("enables the panel when the paired host exposes its notification service", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: {
        desktopMethods: Object.fromEntries(
          [
            "listNotifications",
            "getUnreadNotificationCount",
            "markNotificationRead",
            "markAllNotificationsRead",
            "deleteNotification",
            "deleteAllNotifications",
            "onNotificationEvent",
          ].map((name) => [
            name,
            { mutation: name.startsWith("mark") || name.startsWith("delete") },
          ]),
        ),
      },
    });

    const markup = renderToStaticMarkup(<NotificationPanel />);

    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('aria-label="Notifications"');
  });

  it("keeps notifications available in the native desktop app", () => {
    vi.stubGlobal("window", {});

    const markup = renderToStaticMarkup(<NotificationPanel />);

    expect(markup).not.toContain('aria-label="Notifications unavailable"');
    expect(markup).toContain('aria-label="Notifications"');
  });
});
