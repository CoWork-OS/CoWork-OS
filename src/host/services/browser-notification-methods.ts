import type { NotificationService } from "../../electron/notifications/service";
import type { AppNotification, NotificationType, Task, Workspace } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError, type WebRequestContext } from "../web/WebApplication";

const NOTIFICATION_TYPES = new Set<NotificationType>([
  "task_completed",
  "task_failed",
  "scheduled_task",
  "input_required",
  "companion_suggestion",
  "info",
  "warning",
  "error",
]);

type AddNotification = Pick<AppNotification, "type" | "title" | "message"> &
  Partial<
    Pick<
      AppNotification,
      | "taskId"
      | "cronJobId"
      | "workspaceId"
      | "suggestionId"
      | "recommendedDelivery"
      | "companionStyle"
    >
  >;

export interface BrowserNotificationSources {
  service: NotificationService;
  resolveWorkspace: (
    workspaceId: string,
  ) => Workspace | null | undefined | Promise<Workspace | null | undefined>;
  getTask: (taskId: string) => Task | null | undefined | Promise<Task | null | undefined>;
}

/** Browser notifications reuse the host profile's service and enforce workspace scope. */
export function createBrowserNotificationDefinitions(
  sources: BrowserNotificationSources,
): BrowserDesktopDefinitions {
  const listAuthorized = async (context: WebRequestContext): Promise<AppNotification[]> => {
    assertSession(context);
    const rows = sources.service.list();
    const visible: AppNotification[] = [];
    for (const notification of rows) {
      if (await canAccessNotification(sources, notification)) visible.push(notification);
    }
    return visible;
  };

  return {
    listNotifications: {
      capability: "notifications.read",
      minArgs: 0,
      maxArgs: 0,
      handler: (_args, context) => listAuthorized(context),
    },
    getUnreadNotificationCount: {
      capability: "notifications.read",
      minArgs: 0,
      maxArgs: 0,
      handler: async (_args, context) =>
        (await listAuthorized(context)).filter((notification) => !notification.read).length,
    },
    markNotificationRead: {
      capability: "notifications.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([id]) => [parseId(id)],
      handler: async ([id], context) => {
        assertSession(context);
        const notification = sources.service.list().find((item) => item.id === id);
        if (!notification || !(await canAccessNotification(sources, notification))) {
          throw notificationUnavailable();
        }
        return sources.service.markRead(id as string);
      },
    },
    markAllNotificationsRead: {
      capability: "notifications.manage",
      mutation: true,
      minArgs: 0,
      maxArgs: 0,
      handler: async (_args, context) => {
        const visible = await listAuthorized(context);
        for (const notification of visible) {
          if (notification.read) continue;
          if (await canAccessNotification(sources, notification)) {
            await sources.service.markRead(notification.id);
          }
        }
      },
    },
    deleteNotification: {
      capability: "notifications.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([id]) => [parseId(id)],
      handler: async ([id], context) => {
        assertSession(context);
        const notification = sources.service.list().find((item) => item.id === id);
        if (!notification || !(await canAccessNotification(sources, notification))) {
          throw notificationUnavailable();
        }
        return sources.service.delete(id as string);
      },
    },
    deleteAllNotifications: {
      capability: "notifications.manage",
      mutation: true,
      minArgs: 0,
      maxArgs: 0,
      handler: async (_args, context) => {
        const visible = await listAuthorized(context);
        for (const notification of visible) {
          if (await canAccessNotification(sources, notification)) {
            await sources.service.delete(notification.id);
          }
        }
      },
    },
    addNotification: {
      capability: "notifications.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([input]) => [parseAddNotification(input)],
      handler: async ([input], context) => {
        assertSession(context);
        const notification = input as AddNotification;
        const candidate: AppNotification = {
          ...notification,
          id: "pending",
          read: false,
          createdAt: Date.now(),
        };
        if (!(await canAccessNotification(sources, candidate))) {
          throw notificationUnavailable();
        }
        return sources.service.add(notification);
      },
    },
  };
}

function assertSession(context: WebRequestContext): void {
  if (!context.sessionId || !context.identity.profileId) {
    throw new WebApplicationError("UNAUTHENTICATED", "A paired browser session is required.", 401);
  }
}

async function canAccessNotification(
  sources: BrowserNotificationSources,
  notification: AppNotification,
): Promise<boolean> {
  let task: Task | null | undefined;
  if (notification.taskId) {
    task = await sources.getTask(notification.taskId);
    if (!task?.workspaceId) return false;
    if (notification.workspaceId && notification.workspaceId !== task.workspaceId) return false;
  }

  const workspaceId = notification.workspaceId ?? task?.workspaceId;
  if (!workspaceId) return true;
  const workspace = await sources.resolveWorkspace(workspaceId);
  return Boolean(workspace && workspace.id === workspaceId && workspace.permissions.read === true);
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid notification identifier.");
  }
  return value;
}

function parseAddNotification(value: unknown): AddNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid notification.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "type",
    "title",
    "message",
    "taskId",
    "cronJobId",
    "workspaceId",
    "suggestionId",
    "recommendedDelivery",
    "companionStyle",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid notification fields.");
  }
  if (typeof input.type !== "string" || !NOTIFICATION_TYPES.has(input.type as NotificationType)) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid notification type.");
  }

  const title = parseText(input.title, 256, "title");
  const message = parseText(input.message, 8_000, "message");
  const result: AddNotification = { type: input.type as NotificationType, title, message };
  for (const key of ["taskId", "cronJobId", "workspaceId", "suggestionId"] as const) {
    if (input[key] !== undefined) result[key] = parseId(input[key]);
  }
  if (input.recommendedDelivery !== undefined) {
    if (!new Set(["briefing", "inbox", "nudge"]).has(input.recommendedDelivery as string)) {
      throw new WebApplicationError("INVALID_REQUEST", "Invalid notification delivery.");
    }
    result.recommendedDelivery =
      input.recommendedDelivery as AddNotification["recommendedDelivery"];
  }
  if (input.companionStyle !== undefined) {
    if (!new Set(["email", "note"]).has(input.companionStyle as string)) {
      throw new WebApplicationError("INVALID_REQUEST", "Invalid notification style.");
    }
    result.companionStyle = input.companionStyle as AddNotification["companionStyle"];
  }
  return result;
}

function parseText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new WebApplicationError("INVALID_REQUEST", `Invalid notification ${label}.`);
  }
  return value.trim();
}

function notificationUnavailable(): WebApplicationError {
  return new WebApplicationError("NOT_FOUND", "Notification is unavailable.", 404);
}
