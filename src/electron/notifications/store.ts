/**
 * Notification Store - File-based persistence for in-app notifications
 * Uses atomic writes with temporary files for data safety
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppNotification, NotificationStoreFile } from '../../shared/types';

// Get the app data directory
function getConfigDir(): string {
  return path.join(app.getPath('userData'));
}

export const DEFAULT_NOTIFICATION_DIR = path.join(getConfigDir(), 'notifications');
export const DEFAULT_NOTIFICATION_STORE_PATH = path.join(DEFAULT_NOTIFICATION_DIR, 'notifications.json');

// Maximum notifications to keep (to prevent unbounded growth)
const MAX_NOTIFICATIONS = 100;

/**
 * Load notifications from the store file
 * Returns empty array if file doesn't exist or is invalid
 */
export async function loadNotificationStore(storePath: string = DEFAULT_NOTIFICATION_STORE_PATH): Promise<NotificationStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<NotificationStoreFile> | null;
    const notifications = Array.isArray(parsed?.notifications) ? parsed.notifications : [];

    // Validate and filter notifications
    const validNotifications = notifications.filter((n): n is AppNotification => {
      return (
        n &&
        typeof n === 'object' &&
        typeof n.id === 'string' &&
        typeof n.type === 'string' &&
        typeof n.title === 'string' &&
        typeof n.message === 'string' &&
        typeof n.read === 'boolean' &&
        typeof n.createdAt === 'number'
      );
    });

    return {
      version: 1,
      notifications: validNotifications,
    };
  } catch {
    // File doesn't exist or is invalid - return empty store
    return { version: 1, notifications: [] };
  }
}

/**
 * Load notification store synchronously (for initialization)
 */
export function loadNotificationStoreSync(storePath: string = DEFAULT_NOTIFICATION_STORE_PATH): NotificationStoreFile {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<NotificationStoreFile> | null;
    const notifications = Array.isArray(parsed?.notifications) ? parsed.notifications : [];

    // Validate and filter notifications
    const validNotifications = notifications.filter((n): n is AppNotification => {
      return (
        n &&
        typeof n === 'object' &&
        typeof n.id === 'string' &&
        typeof n.type === 'string' &&
        typeof n.title === 'string' &&
        typeof n.message === 'string' &&
        typeof n.read === 'boolean' &&
        typeof n.createdAt === 'number'
      );
    });

    return {
      version: 1,
      notifications: validNotifications,
    };
  } catch {
    return { version: 1, notifications: [] };
  }
}

/**
 * Save notifications to the store file
 * Uses atomic writes to prevent data corruption
 */
export async function saveNotificationStore(
  store: NotificationStoreFile,
  storePath: string = DEFAULT_NOTIFICATION_STORE_PATH
): Promise<void> {
  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  // Trim to max notifications (keep most recent)
  if (store.notifications.length > MAX_NOTIFICATIONS) {
    store.notifications = store.notifications
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_NOTIFICATIONS);
  }

  // Generate temp file path with process ID and random suffix
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, 'utf-8');

  // Atomic rename
  await fs.promises.rename(tmp, storePath);
}

/**
 * Save notification store synchronously
 */
export function saveNotificationStoreSync(
  store: NotificationStoreFile,
  storePath: string = DEFAULT_NOTIFICATION_STORE_PATH
): void {
  // Ensure directory exists
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  // Trim to max notifications (keep most recent)
  if (store.notifications.length > MAX_NOTIFICATIONS) {
    store.notifications = store.notifications
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_NOTIFICATIONS);
  }

  // Generate temp file path
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(tmp, json, 'utf-8');

  // Atomic rename
  fs.renameSync(tmp, storePath);
}
