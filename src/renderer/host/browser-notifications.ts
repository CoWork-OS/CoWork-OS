/**
 * Browser sessions only: opt-in system notifications that mirror the host notification
 * feed, the same feed that drives native alerts on desktop. They show only while the tab is
 * open and the user is looking elsewhere; there is no push to a closed tab.
 */
import type { AppNotification } from "../../shared/types";
import { isUserAway } from "./browser-tab-attention";

export type BrowserNotificationState =
  | "unsupported"
  | "insecure"
  | "default"
  | "denied"
  | "granted";

/** Per-browser device preference; never a host setting. */
export const BROWSER_NOTIFICATIONS_STORAGE_KEY = "cowork:browser-notifications:enabled";
export const BROWSER_NOTIFICATION_BODY_MAX = 140;
const SEEN_LIMIT = 200;

export interface BrowserNotificationFeedEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

type NotificationWindow = Partial<Pick<Window, "isSecureContext">> & {
  Notification?: typeof Notification;
};

export function getBrowserNotificationState(
  win: NotificationWindow | undefined = typeof window === "undefined" ? undefined : window,
): BrowserNotificationState {
  if (!win || !("Notification" in win) || typeof win.Notification !== "function") {
    return "unsupported";
  }
  if (!win.isSecureContext) return "insecure";
  const permission = win.Notification.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

export function readBrowserNotificationOptIn(): boolean {
  try {
    return window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBrowserNotificationOptIn(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, "1");
    else window.localStorage.removeItem(BROWSER_NOTIFICATIONS_STORAGE_KEY);
  } catch {
    // Storage blocked: the preference lasts for this page only.
  }
}

/** Must be called from a click handler; browsers ignore or penalise prompts on load. */
export async function requestBrowserNotificationPermission(
  win: NotificationWindow = window,
): Promise<BrowserNotificationState> {
  const state = getBrowserNotificationState(win);
  if (state !== "default") return state;
  const api = win.Notification!;
  try {
    await new Promise<void>((resolve) => {
      // Older Safari only takes a callback; newer browsers return a promise.
      const result = api.requestPermission(() => resolve());
      if (result && typeof result.then === "function") {
        result.then(
          () => resolve(),
          () => resolve(),
        );
      }
    });
  } catch {
    // Treat a failed prompt as unanswered.
  }
  return getBrowserNotificationState(win);
}

/** Plain, short text: the body can appear on a lock screen. */
export function formatBrowserNotificationBody(message: string | undefined): string {
  const text = (message ?? "")
    // Bold markers and backticks only; underscores stay, they belong to names like __init__.
    .replace(/\*{2,}|`+/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= BROWSER_NOTIFICATION_BODY_MAX) return text;
  return `${text.slice(0, BROWSER_NOTIFICATION_BODY_MAX - 1).trimEnd()}…`;
}

const CONFIRMATION_TAG = "cowork:browser-notifications:on";
const CONFIRMATION_CLOSE_MS = 5000;

/**
 * Confirms the opt-in with a real notification, which also proves this browser can show one
 * from a page. Returns false when it can't: Chrome on Android has the permission prompt but
 * only lets a service worker show notifications.
 */
export function showBrowserNotificationConfirmation(
  win: NotificationWindow & Partial<Pick<Window, "setTimeout">>,
): boolean {
  if (getBrowserNotificationState(win) !== "granted") return false;
  try {
    const shown = new win.Notification!("Browser notifications are on", {
      body: "You'll get one here when a task needs you and this tab is in the background.",
      tag: CONFIRMATION_TAG,
    });
    win.setTimeout?.(() => shown.close(), CONFIRMATION_CLOSE_MS);
    return true;
  } catch {
    return false;
  }
}

/** Exactly what desktop would alert on: a new, unread notification that asks for an alert. */
export function isAlertableNotificationEvent(
  event: BrowserNotificationFeedEvent | null | undefined,
): event is BrowserNotificationFeedEvent & { notification: AppNotification } {
  return Boolean(
    event &&
    event.type === "added" &&
    event.notification &&
    event.notification.desktopAlert !== false &&
    !event.notification.read,
  );
}

export interface BrowserNotificationMirrorOptions {
  win: NotificationWindow & Pick<Window, "focus">;
  doc: Pick<Document, "hidden" | "hasFocus">;
  subscribe: (listener: (event: BrowserNotificationFeedEvent) => void) => () => void;
  onOpen: (notification: AppNotification) => void;
  isOptedIn?: () => boolean;
}

/** Subscribes to the feed and shows a system notification for each alertable event. */
export function createBrowserNotificationMirror({
  win,
  doc,
  subscribe,
  onOpen,
  isOptedIn = readBrowserNotificationOptIn,
}: BrowserNotificationMirrorOptions): () => void {
  const seen = new Set<string>();

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  const listener = (event: BrowserNotificationFeedEvent) => {
    if (!isAlertableNotificationEvent(event)) return;
    const notification = event.notification;
    if (!remember(notification.id)) return;
    if (!isOptedIn() || getBrowserNotificationState(win) !== "granted" || !isUserAway(doc)) {
      return;
    }
    try {
      const body = formatBrowserNotificationBody(notification.message);
      const shown = new win.Notification!(notification.title || "CoWork OS", {
        ...(body ? { body } : {}),
        // Several open tabs replace one another's alert instead of stacking.
        tag: notification.id,
      });
      shown.onclick = () => {
        try {
          win.focus();
        } catch {
          // Focus can be refused; still open the target.
        }
        shown.close();
        onOpen(notification);
      };
    } catch {
      // Some browsers (Android Chrome) only allow notifications from a service worker.
    }
  };

  return subscribe(listener);
}
