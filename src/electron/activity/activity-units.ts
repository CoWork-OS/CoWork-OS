import type Database from "better-sqlite3";
import type { Activity } from "../../shared/types";
import { StatementCatalogError, type UnitCatalog } from "../database/statements/statement-catalog";
import { contextStoreUnit } from "../database/statements/store-units";
import { ActivityStore } from "./ActivityRepository";

const activityStore = (db: Database.Database, pending: Activity[]) =>
  new ActivityStore(db, pending);

/** The host timeline writer's accepted, uncommitted activity rows. */
function pendingArg(value: unknown): Activity[] {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object")) {
    throw new StatementCatalogError("args[0] must be the pending activity rows");
  }
  return value as Activity[];
}

const read = { readonly: true, context: pendingArg };
const write = { readonly: false, context: pendingArg };

/**
 * Activity feed transaction units (async SQLite migration plan, DB6), in the services
 * domain. Each takes the host's pending activity rows first.
 */
export const ACTIVITY_UNITS = {
  activity_insertIfAbsent: contextStoreUnit(activityStore, "insertIfAbsent", write),
  activity_findById: contextStoreUnit(activityStore, "findById", read),
  activity_list: contextStoreUnit(activityStore, "list", read),
  activity_search: contextStoreUnit(activityStore, "search", read),
  activity_getUnreadCount: contextStoreUnit(activityStore, "getUnreadCount", read),
  activity_markRead: contextStoreUnit(activityStore, "markRead", write),
  activity_markAllRead: contextStoreUnit(activityStore, "markAllRead", write),
  activity_togglePin: contextStoreUnit(activityStore, "togglePin", write),
  activity_delete: contextStoreUnit(activityStore, "delete", write),
  activity_deleteOld: contextStoreUnit(activityStore, "deleteOld", write),
} satisfies UnitCatalog;
