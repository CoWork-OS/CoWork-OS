import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
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

describe("NotificationPanel needs-you count", () => {
  const item = (id: string, urgent: boolean) =>
    ({
      id,
      kind: "approval",
      state: "Approval needed",
      title: `Item ${id}`,
      createdAt: 1,
      urgent,
      actor: { kind: "agent", name: "Ops bot" },
      origin: { kind: "you", label: "" },
      place: { kind: "local", label: "" },
      taskId: id,
      ref: { type: "approval", approvalId: id, taskId: id },
    }) as AttentionItem;

  it("shows how many decisions wait on you, from the shared queue", () => {
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(
      <NotificationPanel attention={[item("a", true), item("b", true), item("idea", false)]} />,
    );
    expect(markup).toContain('aria-label="Notifications, 2 need you"');
    expect(markup).toContain('class="notif-bell-count" aria-hidden="true">2</span>');
  });

  it("keeps the plain bell when nothing waits", () => {
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(<NotificationPanel attention={[item("idea", false)]} />);
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).not.toContain("notif-bell-count");
  });
});
