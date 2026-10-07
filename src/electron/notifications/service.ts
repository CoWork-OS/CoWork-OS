import type Database from "better-sqlite3";
import { NotificationInboxRepository } from "./NotificationInboxRepository";
import type { BotInboxAuthority } from "./NotificationInboxStore";
/**
 * Notification Service - Manages in-app notifications
 * Provides CRUD operations and emits events for UI updates
 */

import { randomUUID } from "node:crypto";
import type { AppNotification, NotificationType, NotificationStoreFile } from "../../shared/types";
import {
  loadNotificationStore as _loadNotificationStore,
  loadNotificationStoreSync,
  saveNotificationStore,
  saveNotificationStoreSync,
  getNotificationStorePath,
} from "./store";
import { createLogger } from "../utils/logger";

const log = createLogger("NotificationService");

export type NotificationEventType = "added" | "updated" | "removed" | "cleared";

export interface NotificationEvent {
  type: NotificationEventType;
  notification?: AppNotification;
  notifications?: AppNotification[];
}

export interface NotificationServiceConfig {
  storePath?: string;
  db?: Database.Database;
  onEvent?: (event: NotificationEvent) => unknown;
}

type AddNotificationParams = {
  beforePublish?: () => Promise<void>;
  id?: string;
  agentRoleId?: string;
  desktopAlert?: boolean;
  type: NotificationType;
  title: string;
  message: string;
  taskId?: string;
  cronJobId?: string;
  workspaceId?: string;
  suggestionId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
};

function getInputRequiredDedupeKey(notification: AppNotification): string | null {
  if (notification.type !== "input_required" || !notification.taskId) return null;
  return `input_required:${notification.taskId}`;
}

function getIntegrationAuthDedupeKey(notification: AppNotification): string | null {
  if (notification.type !== "warning") return null;
  const title = notification.title.trim();
  const message = notification.message.trim();
  if (!/^Reconnect\s+\S/.test(title)) return null;
  if (!/\bneeds attention in\b/.test(message) || !/\bReconnect or resync\b/.test(message)) {
    return null;
  }
  return `integration_auth:${title.toLowerCase()}`;
}

function getPersistentDedupeKey(notification: AppNotification): string | null {
  if (
    /^bot-[a-f0-9]{64}$/.test(notification.id) &&
    notification.workspaceId &&
    notification.agentRoleId
  )
    return `bot:${notification.id}`;
  return getInputRequiredDedupeKey(notification) || getIntegrationAuthDedupeKey(notification);
}

function collapseDuplicateNotifications(notifications: AppNotification[]): {
  notifications: AppNotification[];
  changed: boolean;
} {
  const newestByDedupeKey = new Map<string, AppNotification>();

  for (const notification of notifications) {
    const dedupeKey = getPersistentDedupeKey(notification);
    if (!dedupeKey) continue;
    const existing = newestByDedupeKey.get(dedupeKey);
    if (!existing || notification.createdAt > existing.createdAt) {
      newestByDedupeKey.set(dedupeKey, notification);
    }
  }

  if (newestByDedupeKey.size === 0) {
    return { notifications, changed: false };
  }

  const keptDedupeIds = new Set(
    [...newestByDedupeKey.values()].map((notification) => notification.id),
  );
  const collapsed = notifications.filter((notification) => {
    const dedupeKey = getPersistentDedupeKey(notification);
    return !dedupeKey || keptDedupeIds.has(notification.id);
  });

  return {
    notifications: collapsed,
    changed: collapsed.length !== notifications.length,
  };
}

export class NotificationService {
  private notifications: AppNotification[] = [];
  private storePath: string;
  private onEvent?: NotificationServiceConfig["onEvent"];
  private inbox?: InstanceType<typeof NotificationInboxRepository>;
  private initialized: Promise<void> = Promise.resolve();
  private additions: Promise<unknown> = Promise.resolve();

  constructor(config: NotificationServiceConfig = {}) {
    this.storePath = config.storePath || getNotificationStorePath();
    this.onEvent = config.onEvent;

    // Load notifications synchronously on startup
    const store = loadNotificationStoreSync(this.storePath);
    const collapsed = collapseDuplicateNotifications(store.notifications);
    this.notifications = collapsed.notifications;
    if (config.db) {
      this.inbox = new NotificationInboxRepository(config.db);
      this.initialized = this.inbox
        .initialize(
          this.notifications.map((notification) => ({
            notification,
            key: getPersistentDedupeKey(notification),
          })),
        )
        .then(async () => {
          this.notifications = await this.inbox!.list();
        });
      void this.initialized.catch((error) =>
        log.warn("Canonical inbox initialization failed:", error),
        );
      }
    if (!config.db && collapsed.changed)
      saveNotificationStoreSync({ version: 1, notifications: this.notifications }, this.storePath);
    log.info(`Loaded ${this.notifications.length} notifications from store`);
  }

  /**
   * Get all notifications (sorted by date, newest first)
   */
  list(): AppNotification[] {
    return [...this.notifications].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get unread count
   */
  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  /**
   * Add a new notification
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.additions.catch(() => {}).then(operation);
    this.additions = next;
    return next;
  }
  async refresh(): Promise<void> {
    await this.initialized;
    if (this.inbox) this.notifications = await this.inbox.list();
  }
  async containsDeliveryIdentity(id: string): Promise<boolean> {
    await this.initialized;
    return this.inbox ? this.inbox.contains(id) : this.notifications.some((item) => item.id === id);
  }
  add(params: AddNotificationParams): Promise<AppNotification> {
    return this.serialize(async () => {
      const result = await this.addPersisted(params);
      return result.notification;
    });
  }
  addBotDelivery(
    params: AddNotificationParams,
    authority: BotInboxAuthority,
  ): Promise<{ notification: AppNotification; desktopRequested: boolean }> {
    return this.serialize(() => this.addPersisted(params, authority));
  }
  private async addPersisted(
    params: AddNotificationParams,
    authority?: BotInboxAuthority,
  ): Promise<{ notification: AppNotification; desktopRequested: boolean }> {
    await this.initialized;
    if (this.inbox) {
      await params.beforePublish?.();
      const notification = this.makeNotification(params);
      const key = getPersistentDedupeKey(notification);
      const result = await this.inbox.add(notification, key, authority);
      await this.refresh();
      if (!result.added) return { notification: result.notification, desktopRequested: false };
      await params.beforePublish?.();
      const delivery = this.emit({ type: "added", notification: result.notification });
      return {
        notification: result.notification,
        desktopRequested: delivery?.desktopRequested === true,
      };
    }
    const exact = params.id ? this.notifications.find((item) => item.id === params.id) : undefined;
    if (exact) {
      if (
        exact.workspaceId !== params.workspaceId ||
        exact.agentRoleId !== params.agentRoleId ||
        exact.taskId !== params.taskId
      )
        throw Error("Notification identity belongs to another scope");
      return { notification: exact, desktopRequested: false };
    }
    const existing = params.id ? null : this.findExistingPersistentNotification(params);
    if (existing) return { notification: existing, desktopRequested: false };
    const notification = this.makeNotification(params);
    await params.beforePublish?.();
    const next = [notification, ...this.notifications];
    await saveNotificationStore({ version: 1, notifications: next }, this.storePath);
    await params.beforePublish?.();
    this.notifications = next;
    const delivery = this.emit({ type: "added", notification });
    return { notification, desktopRequested: delivery?.desktopRequested === true };
    }
  private makeNotification(params: AddNotificationParams): AppNotification {
    return {
      id: params.id ?? randomUUID(),
      agentRoleId: params.agentRoleId,
      desktopAlert: params.desktopAlert,
      type: params.type,
      title: params.title,
      message: params.message,
      read: false,
      createdAt: Date.now(),
      taskId: params.taskId,
      cronJobId: params.cronJobId,
      workspaceId: params.workspaceId,
      suggestionId: params.suggestionId,
      recommendedDelivery: params.recommendedDelivery,
      companionStyle: params.companionStyle,
    };
  }
  private findExistingPersistentNotification(
    params: AddNotificationParams,
  ): AppNotification | null {
    const candidate: AppNotification = {
      id: "",
      type: params.type,
      title: params.title,
      message: params.message,
      read: false,
      createdAt: 0,
      taskId: params.taskId,
      cronJobId: params.cronJobId,
      workspaceId: params.workspaceId,
      suggestionId: params.suggestionId,
      recommendedDelivery: params.recommendedDelivery,
      companionStyle: params.companionStyle,
    };
    const dedupeKey = getPersistentDedupeKey(candidate);
    if (!dedupeKey) {
      return null;
    }
    return (
      this.notifications
        .filter((notification) => {
          return getPersistentDedupeKey(notification) === dedupeKey;
        })
        .sort((a, b) => b.createdAt - a.createdAt)[0] || null
    );
  }

  /**
   * Mark a notification as read
   */
  markRead(id: string): Promise<AppNotification | null> {
    return this.serialize(() => this.markReadPersisted(id));
  }
  private async markReadPersisted(id: string): Promise<AppNotification | null> {
    await this.initialized;
    if (this.inbox) {
      const value = await this.inbox.markRead(id);
      await this.refresh();
      if (value) this.emit({ type: "updated", notification: value });
      return value;
    }
    const notification = this.notifications.find((n) => n.id === id);
    if (!notification) return null;

    notification.read = true;
    await this.save();

    this.emit({ type: "updated", notification });
    return notification;
  }

  /**
   * Mark all notifications as read
   */
  markAllRead(): Promise<void> {
    return this.serialize(() => this.markAllReadPersisted());
  }
  private async markAllReadPersisted(): Promise<void> {
    await this.initialized;
    if (this.inbox) {
      this.notifications = await this.inbox.markAllRead();
      this.emit({ type: "updated", notifications: this.list() });
      return;
    }
    const unread = this.notifications.filter((n) => !n.read);
    if (unread.length === 0) return;

    for (const n of unread) {
      n.read = true;
    }
    await this.save();

    this.emit({ type: "updated", notifications: this.notifications });
  }

  /**
   * Delete a notification
   */
  delete(id: string): Promise<boolean> {
    return this.serialize(() => this.deletePersisted(id));
  }
  private async deletePersisted(id: string): Promise<boolean> {
    await this.initialized;
    if (this.inbox) {
      await this.refresh();
      const notification = this.notifications.find((item) => item.id === id);
      const removed = await this.inbox.delete(id);
      await this.refresh();
      if (removed) this.emit({ type: "removed", notification });
      return removed;
    }
    const index = this.notifications.findIndex((n) => n.id === id);
    if (index === -1) return false;

    const [removed] = this.notifications.splice(index, 1);
    await this.save();

    this.emit({ type: "removed", notification: removed });
    return true;
  }

  /**
   * Delete all notifications
   */
  deleteAll(): Promise<void> {
    return this.serialize(() => this.deleteAllPersisted());
  }
  private async deleteAllPersisted(): Promise<void> {
    await this.initialized;
    if (this.inbox) {
      await this.inbox.deleteAll();
      await this.refresh();
      this.emit({ type: "cleared" });
      return;
    }
    if (this.notifications.length === 0) return;

    this.notifications = [];
    await this.save();

    this.emit({ type: "cleared" });
  }

  /**
   * Save notifications to disk
   */
  private async save(): Promise<void> {
    const store: NotificationStoreFile = {
      version: 1,
      notifications: this.notifications,
    };
    await saveNotificationStore(store, this.storePath);
  }

  /**
   * Emit an event to listeners
   */
  private emit(event: NotificationEvent): { desktopRequested: boolean } {
    const result = this.onEvent?.(event);
    return {
      desktopRequested:
        !!result &&
        typeof result === "object" &&
        "desktopRequested" in result &&
        result.desktopRequested === true,
    };
    }
  }
