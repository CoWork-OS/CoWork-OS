import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { HookSessionStore } from "./HookSessionRepository";

const make = (db: Database.Database) => new HookSessionStore(db);

/** Hook session transaction units (async SQLite migration plan, DB6), in the services domain. */
export const HOOK_SESSION_UNITS = {
  hookSession_findBySessionKey: storeUnit(make, "findBySessionKey", { readonly: true }),
  hookSession_create: storeUnit(make, "create", { readonly: false }),
  hookSession_acquireLock: storeUnit(make, "acquireLock", { readonly: false }),
  hookSession_releaseLock: storeUnit(make, "releaseLock", { readonly: false }),
} satisfies UnitCatalog;
