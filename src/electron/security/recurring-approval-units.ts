import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { RecurringApprovalStore } from "./recurring-approval-service";

const make = (db: Database.Database) => new RecurringApprovalStore(db);

/** Recurring approval transaction units (async SQLite migration plan, DB6), in the services domain. */
export const RECURRING_APPROVAL_UNITS = {
  recurringApproval_findActive: storeUnit(make, "findActive", { readonly: true }),
  recurringApproval_create: storeUnit(make, "create", { readonly: false }),
  recurringApproval_list: storeUnit(make, "list", { readonly: true }),
  recurringApproval_revoke: storeUnit(make, "revoke", { readonly: false }),
} satisfies UnitCatalog;
