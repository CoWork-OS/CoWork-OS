import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AutomationRunOutcomeStore } from "./AutomationRunOutcomeRepository";

// The facade ensured the table on the host.
const make = (db: Database.Database) => new AutomationRunOutcomeStore(db, { ensureSchema: false });

/** Automation run outcome transaction units (async SQLite migration plan, DB6), in the services domain. */
export const AUTOMATION_OUTCOME_UNITS = {
  automationOutcome_create: storeUnit(make, "create", { readonly: false }),
  automationOutcome_findLatestByNotificationKey: storeUnit(make, "findLatestByNotificationKey", {
    readonly: true,
  }),
  automationOutcome_findById: storeUnit(make, "findById", { readonly: true }),
  automationOutcome_list: storeUnit(make, "list", { readonly: true }),
  automationOutcome_summarize: storeUnit(make, "summarize", { readonly: true }),
  automationOutcome_markNotificationDelivered: storeUnit(make, "markNotificationDelivered", {
    readonly: false,
  }),
  automationOutcome_markNotificationSkipped: storeUnit(make, "markNotificationSkipped", {
    readonly: false,
  }),
} satisfies UnitCatalog;
