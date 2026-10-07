import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AnswerSurfaceStateSqlStore } from "./answer-surface-state-sql";

const make = (db: Database.Database) => new AnswerSurfaceStateSqlStore(db);

/** Answer surface state units (async SQLite migration plan, DB6), in the services domain. */
export const ANSWER_SURFACE_UNITS = {
  answerSurface_get: storeUnit(make, "get", { readonly: true }),
  answerSurface_upsert: storeUnit(make, "upsert", { readonly: false }),
  answerSurface_listUnreported: storeUnit(make, "listUnreported", { readonly: true }),
  answerSurface_markReported: storeUnit(make, "markReported", { readonly: false }),
  answerSurface_deleteForTask: storeUnit(make, "deleteForTask", { readonly: false }),
} satisfies UnitCatalog;
