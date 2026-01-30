/**
 * Notification module exports
 */

export { NotificationService } from './service';
export type { NotificationEvent, NotificationEventType, NotificationServiceConfig } from './service';
export {
  loadNotificationStore,
  loadNotificationStoreSync,
  saveNotificationStore,
  saveNotificationStoreSync,
  DEFAULT_NOTIFICATION_STORE_PATH,
  DEFAULT_NOTIFICATION_DIR,
} from './store';
