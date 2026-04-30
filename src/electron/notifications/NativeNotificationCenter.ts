import { Notification } from "electron";

interface NativeNotificationInput {
  id: string;
  title: string;
  message: string;
  type?: string;
  taskId?: string;
}

export class NativeNotificationCenter {
  private static instance: NativeNotificationCenter | null = null;
  private activeNotifications = new Map<string, Notification>();
  private notificationOrder: string[] = [];
  private onClickCallback:
    | ((notificationId: string, taskId?: string) => void)
    | null = null;

  static getInstance(): NativeNotificationCenter {
    if (!NativeNotificationCenter.instance) {
      NativeNotificationCenter.instance = new NativeNotificationCenter();
    }
    return NativeNotificationCenter.instance;
  }

  private constructor() {}

  setOnClick(
    callback: (notificationId: string, taskId?: string) => void,
  ): void {
    this.onClickCallback = callback;
  }

  show(notification: NativeNotificationInput): boolean {
    if (!Notification.isSupported()) {
      return false;
    }

    try {
      const nativeNotification = new Notification({
        title: notification.title,
        body: notification.message,
        silent: false,
        timeoutType: "default",
      });

      const releaseReference = () => {
        this.activeNotifications.delete(notification.id);
        this.notificationOrder = this.notificationOrder.filter(
          (id) => id !== notification.id,
        );
      };

      nativeNotification.on("click", () => {
        this.onClickCallback?.(notification.id, notification.taskId);
        releaseReference();
      });
      // Do not release on "close": macOS fires it when the banner leaves the screen,
      // while the delivered item can still belong in Notification Center.
      nativeNotification.on("failed", releaseReference);

      this.activeNotifications.set(notification.id, nativeNotification);
      this.notificationOrder.push(notification.id);
      this.pruneRetainedNotifications();
      nativeNotification.show();
      return true;
    } catch (error) {
      console.warn("[Notifications] Native notification failed:", error);
      this.activeNotifications.delete(notification.id);
      this.notificationOrder = this.notificationOrder.filter(
        (id) => id !== notification.id,
      );
      return false;
    }
  }

  private pruneRetainedNotifications(): void {
    const maxRetainedNotifications = 100;
    while (this.notificationOrder.length > maxRetainedNotifications) {
      const oldestId = this.notificationOrder.shift();
      if (oldestId) {
        this.activeNotifications.delete(oldestId);
      }
    }
  }
}
