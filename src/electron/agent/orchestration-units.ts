import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { OrchestrationStore } from "./OrchestrationRepository";

const make = (db: Database.Database) => new OrchestrationStore(db);

/** Orchestration run transaction units (async SQLite migration plan, DB6), in the services domain. */
export const ORCHESTRATION_UNITS = {
  orchestration_create: storeUnit(make, "create", { readonly: false }),
  orchestration_update: storeUnit(make, "update", { readonly: false }),
  orchestration_findById: storeUnit(make, "findById", { readonly: true }),
  orchestration_findByRootTaskId: storeUnit(make, "findByRootTaskId", { readonly: true }),
  orchestration_findRunning: storeUnit(make, "findRunning", { readonly: true }),
  orchestration_list: storeUnit(make, "list", { readonly: true }),
} satisfies UnitCatalog;
