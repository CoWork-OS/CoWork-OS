import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { BoxBrainStore } from "./box-brain-sql";

/** Box brain units (async SQLite migration plan, DB6), part of the memory domain. */

const store = (db: Database.Database) => new BoxBrainStore(db);
const read = { readonly: true };
const write = { readonly: false };

export const BOX_BRAIN_READS = [
  "findSource",
  "findSourceById",
  "listSources",
  "listDueSources",
  "findRunById",
  "listRuns",
  "findItem",
  "listItems",
] as const;

export const BOX_BRAIN_WRITES = [
  "ensureSource",
  "updateSource",
  "createRun",
  "updateRun",
  "upsertItem",
  "updateItemStatus",
] as const;

export const BOX_BRAIN_UNITS = {
  boxBrain_findSource: storeUnit(store, "findSource", read),
  boxBrain_findSourceById: storeUnit(store, "findSourceById", read),
  boxBrain_listSources: storeUnit(store, "listSources", read),
  boxBrain_listDueSources: storeUnit(store, "listDueSources", read),
  boxBrain_findRunById: storeUnit(store, "findRunById", read),
  boxBrain_listRuns: storeUnit(store, "listRuns", read),
  boxBrain_findItem: storeUnit(store, "findItem", read),
  boxBrain_listItems: storeUnit(store, "listItems", read),
  boxBrain_ensureSource: storeUnit(store, "ensureSource", write),
  boxBrain_updateSource: storeUnit(store, "updateSource", write),
  boxBrain_createRun: storeUnit(store, "createRun", write),
  boxBrain_updateRun: storeUnit(store, "updateRun", write),
  boxBrain_upsertItem: storeUnit(store, "upsertItem", write),
  boxBrain_updateItemStatus: storeUnit(store, "updateItemStatus", write),
} satisfies UnitCatalog;
