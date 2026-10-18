import { NativeNotificationCenter } from "./NativeNotificationCenter";

export interface DesktopNotificationInput {
  id: string;
  title: string;
  message: string;
  type?: string;
  taskId?: string;
}

/**
 * Desktop alerts go through the operating system's notification center only.
 * CoWork draws no banners of its own: when the system declines or fails to
 * deliver one, the alert stays in the in-app notification inbox.
 */
export function showDesktopNotification(notification: DesktopNotificationInput): boolean {
  return NativeNotificationCenter.getInstance().show(notification);
}
