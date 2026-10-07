import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { NotificationInboxStore } from "./NotificationInboxStore";
const make = (db: Database.Database) => new NotificationInboxStore(db);
export const NOTIFICATION_INBOX_UNITS = {
  notificationInbox_initialize: storeUnit(make, "initialize", { readonly: false }),
  notificationInbox_list: storeUnit(make, "list", { readonly: true }),
  notificationInbox_contains: storeUnit(make, "contains", { readonly: true }),
  notificationInbox_add: storeUnit(make, "add", { readonly: false }),
  notificationInbox_markRead: storeUnit(make, "markRead", { readonly: false }),
  notificationInbox_markAllRead: storeUnit(make, "markAllRead", { readonly: false }),
  notificationInbox_delete: storeUnit(make, "delete", { readonly: false }),
  notificationInbox_deleteAll: storeUnit(make, "deleteAll", { readonly: false }),
};
