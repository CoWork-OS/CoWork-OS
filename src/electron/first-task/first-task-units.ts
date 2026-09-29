import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { FirstTaskStore } from "./first-task-sql";

const make = (db: Database.Database) => new FirstTaskStore(db);

/** First-task flow units (async SQLite migration plan, DB6), in the services domain. */
export const FIRST_TASK_UNITS = {
  firstTask_getSetup: storeUnit(make, "getSetup", { readonly: true }),
  firstTask_setSetupChoice: storeUnit(make, "setSetupChoice", { readonly: false }),
  firstTask_markModelReady: storeUnit(make, "markModelReady", { readonly: false }),
  firstTask_findAttempt: storeUnit(make, "findAttempt", { readonly: true }),
  firstTask_attemptTaskIds: storeUnit(make, "attemptTaskIds", { readonly: true }),
  firstTask_createSampleAttempt: storeUnit(make, "createSampleAttempt", { readonly: false }),
  firstTask_clearCheck: storeUnit(make, "clearCheck", { readonly: false }),
  firstTask_recordCheck: storeUnit(make, "recordCheck", { readonly: false }),
  firstTask_markInspected: storeUnit(make, "markInspected", { readonly: false }),
  firstTask_requestRevision: storeUnit(make, "requestRevision", { readonly: false }),
  firstTask_cancelRevision: storeUnit(make, "cancelRevision", { readonly: false }),
  firstTask_readRealWork: storeUnit(make, "readRealWork", { readonly: true }),
  firstTask_recordRealWorkInspection: storeUnit(make, "recordRealWorkInspection", {
    readonly: false,
  }),
  firstTask_recordRealWorkUseful: storeUnit(make, "recordRealWorkUseful", { readonly: false }),
} satisfies UnitCatalog;
