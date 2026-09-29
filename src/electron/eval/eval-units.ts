import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { EvalStore } from "./EvalService";

const evalStore = (db: Database.Database) => new EvalStore(db);

/** Eval transaction units (async SQLite migration plan, DB6), in the services domain. */
export const EVAL_UNITS = {
  eval_listSuites: storeUnit(evalStore, "listSuites", { readonly: true }),
  eval_getCase: storeUnit(evalStore, "getCase", { readonly: true }),
  eval_getRun: storeUnit(evalStore, "getRun", { readonly: true }),
  eval_getBaselineMetrics: storeUnit(evalStore, "getBaselineMetrics", { readonly: true }),
  eval_createCaseFromTask: storeUnit(evalStore, "createCaseFromTask", { readonly: false }),
  eval_runSuite: storeUnit(evalStore, "runSuite", { readonly: false }),
} satisfies UnitCatalog;
