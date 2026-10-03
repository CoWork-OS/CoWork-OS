import { app } from "electron";
import type { DesktopNotificationStyle, TraySettings } from "../../shared/types";
import { NativeNotificationCenter } from "./NativeNotificationCenter";
import { NotificationOverlayManager } from "./NotificationOverlayWindow";

export interface DesktopNotificationInput {
  id: string;
  title: string;
  message: string;
  type?: string;
  taskId?: string;
}

export function updateDockNotificationBadge(settings: TraySettings, unreadCount: number): void {
  if (process.platform !== "darwin") return;
  const showBadge = settings.showNotifications && settings.notificationStyle === "near-dock";
  app.dock?.setBadge(showBadge && unreadCount > 0 ? String(unreadCount) : "");
}

export function showDesktopNotification(
  notification: DesktopNotificationInput,
  style: DesktopNotificationStyle = "system",
): void {
  const nearDock = process.platform === "darwin" && style === "near-dock";
  const showOverlay = () =>
    NotificationOverlayManager.getInstance().show(notification, nearDock ? "near-dock" : "system");
  if (nearDock || !NativeNotificationCenter.getInstance().show(notification, showOverlay)) {
    showOverlay();
  }
}
