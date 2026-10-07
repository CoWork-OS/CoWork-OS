import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { BotNotificationStore } from "./BotNotificationStore";
import { BotReceiptRetentionStore } from "../automation/receipt-retention";
const make = (db: Database.Database) => new BotNotificationStore(db);
export const BOT_NOTIFICATION_UNITS = {
  botNotification_retry: storeUnit(make, "retry", { readonly: false }),
  botNotification_get: storeUnit(make, "get", { readonly: true }),
  botNotification_update: storeUnit(make, "update", { readonly: false }),
  botNotification_list: storeUnit(make, "list", { readonly: true }),
  botNotification_discover: storeUnit(make, "discover", { readonly: false }),
  botNotification_claim: storeUnit(make, "claim", { readonly: false }),
  botNotification_recover: storeUnit(make, "recover", { readonly: true }),
  botNotification_assertDelivery: storeUnit(make, "assertDelivery", { readonly: true }),
  botNotification_settle: storeUnit(make, "settle", { readonly: false }),
  botReceipts_prune: storeUnit((db: Database.Database) => new BotReceiptRetentionStore(db), "prune", {
    readonly: false,
  }),
};
