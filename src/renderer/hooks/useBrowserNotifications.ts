import { useCallback, useEffect, useRef, useState } from "react";
import type { AppNotification } from "../../shared/types";
import { hasHostMethod, isBrowserHost } from "../host/browser-capabilities";
import {
  createBrowserNotificationMirror,
  getBrowserNotificationState,
  readBrowserNotificationOptIn,
  requestBrowserNotificationPermission,
  showBrowserNotificationConfirmation,
  writeBrowserNotificationOptIn,
  type BrowserNotificationFeedEvent,
  type BrowserNotificationState,
} from "../host/browser-notifications";

/**
 * Browser sessions only: mirrors the host notification feed as system notifications while
 * the user is away from the tab. Clicking one opens the same place the bell would.
 */
export function useBrowserNotifications(onOpen: (notification: AppNotification) => void): void {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!isBrowserHost() || !hasHostMethod("onNotificationEvent")) return;
    return createBrowserNotificationMirror({
      win: window,
      doc: document,
      subscribe: (listener) =>
        window.electronAPI.onNotificationEvent((event: BrowserNotificationFeedEvent) =>
          listener(event),
        ),
      onOpen: (notification) => {
        // Same as a click on the desktop alert: the notification counts as read.
        if (hasHostMethod("markNotificationRead")) {
          void window.electronAPI.markNotificationRead(notification.id).catch(() => undefined);
        }
        onOpenRef.current(notification);
      },
    });
  }, []);
}

export interface BrowserNotificationPreference {
  state: BrowserNotificationState;
  enabled: boolean;
  turnOn: () => void;
  turnOff: () => void;
}

/** The bell panel's on/off control. Only mount it in a browser session. */
export function useBrowserNotificationPreference(): BrowserNotificationPreference {
  const [state, setState] = useState<BrowserNotificationState>(() => getBrowserNotificationState());
  const [optedIn, setOptedIn] = useState(() => readBrowserNotificationOptIn());

  const turnOn = useCallback(() => {
    void requestBrowserNotificationPermission().then((next) => {
      if (next !== "granted") {
        setState(next);
        return;
      }
      // Permission alone isn't enough everywhere, so the first notification is the check.
      if (!showBrowserNotificationConfirmation(window)) {
        writeBrowserNotificationOptIn(false);
        setOptedIn(false);
        setState("unsupported");
        return;
      }
      setState(next);
      writeBrowserNotificationOptIn(true);
      setOptedIn(true);
    });
  }, []);

  const turnOff = useCallback(() => {
    writeBrowserNotificationOptIn(false);
    setOptedIn(false);
  }, []);

  return { state, enabled: optedIn && state === "granted", turnOn, turnOff };
}
