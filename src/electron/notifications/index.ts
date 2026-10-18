/**
 * Notification module exports
 */

export { NotificationService } from "./service";
export type {
  NotificationEvent,
  NotificationEventType,
  NotificationServiceConfig,
} from "./service";
export {
  loadNotificationStore,
  loadNotificationStoreSync,
  saveNotificationStore,
  saveNotificationStoreSync,
  getNotificationStorePath,
  getNotificationDir,
  DEFAULT_NOTIFICATION_STORE_PATH,
  DEFAULT_NOTIFICATION_DIR,
} from "./store";
export { NativeNotificationCenter } from "./NativeNotificationCenter";
export {
  isLikelyIntegrationAuthError,
  notifyIntegrationAuthIssue,
  resetIntegrationAuthNotificationDedupe,
  setIntegrationAuthNotificationServiceProvider,
} from "./integration-auth";
