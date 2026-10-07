import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { EventTriggerStore } from "./trigger-sql";

const make = (db: Database.Database) => new EventTriggerStore(db);

/** Event trigger transaction units (async SQLite migration plan, DB6), in the services domain. */
export const TRIGGER_UNITS = {
  eventTrigger_recoverProcessing: storeUnit(make, "recoverProcessing", { readonly: false }),
  eventTrigger_recoverOccurrences: storeUnit(make, "recoverOccurrences", { readonly: false }),
  eventTrigger_loadTriggerRows: storeUnit(make, "loadTriggerRows", { readonly: true }),
  eventTrigger_saveTrigger: storeUnit(make, "saveTrigger", { readonly: false }),
  eventTrigger_deleteTrigger: storeUnit(make, "deleteTrigger", { readonly: false }),
  eventTrigger_saveHistory: storeUnit(make, "saveHistory", { readonly: false }),
  eventTrigger_acceptOccurrence: storeUnit(make, "acceptOccurrence", { readonly: false }),
  eventTrigger_claimNextOccurrence: storeUnit(make, "claimNextOccurrence", { readonly: false }),
  eventTrigger_markOccurrenceIntent: storeUnit(make, "markOccurrenceIntent", { readonly: false }),
  eventTrigger_completeOccurrence: storeUnit(make, "completeOccurrence", { readonly: false }),
  eventTrigger_markOccurrenceUnknown: storeUnit(make, "markOccurrenceUnknown", { readonly: false }),
  eventTrigger_markOccurrenceFailed: storeUnit(make, "markOccurrenceFailed", { readonly: false }),
  eventTrigger_releaseOccurrence: storeUnit(make, "releaseOccurrence", { readonly: false }),
  eventTrigger_enqueue: storeUnit(make, "enqueue", { readonly: false }),
  eventTrigger_claimNext: storeUnit(make, "claimNext", { readonly: false }),
  eventTrigger_completeQueued: storeUnit(make, "completeQueued", { readonly: false }),
  eventTrigger_retryQueued: storeUnit(make, "retryQueued", { readonly: false }),
} satisfies UnitCatalog;
