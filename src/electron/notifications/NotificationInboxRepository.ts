import { serviceRepositoryFacade } from "../database/service-statements";
import type { NotificationInboxStore } from "./NotificationInboxStore";
export const NotificationInboxRepository = serviceRepositoryFacade<
  NotificationInboxStore,
  "initialize" | "list" | "contains" | "add" | "markRead" | "markAllRead" | "delete" | "deleteAll"
>("notificationInbox_", [
  "initialize",
  "list",
  "contains",
  "add",
  "markRead",
  "markAllRead",
  "delete",
  "deleteAll",
]);
