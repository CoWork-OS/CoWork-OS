import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { MemoryObservationStore } from "./memory-observation-sql";

/** Memory observation units (async SQLite migration plan, DB6), part of the memory domain. */

const store = (db: Database.Database) => new MemoryObservationStore(db);
const read = { readonly: true };
const write = { readonly: false };

export const MEMORY_OBSERVATION_READS = [
  "search",
  "timeline",
  "details",
  "isPromptSuppressed",
  "suppressedIds",
  "countBackfill",
] as const;
export const MEMORY_OBSERVATION_WRITES = [
  "createForMemory",
  "backfill",
  "update",
  "redact",
  "delete",
] as const;

export const MEMORY_OBSERVATION_UNITS = {
  observation_search: storeUnit(store, "search", read),
  observation_timeline: storeUnit(store, "timeline", read),
  observation_details: storeUnit(store, "details", read),
  observation_isPromptSuppressed: storeUnit(store, "isPromptSuppressed", read),
  observation_suppressedIds: storeUnit(store, "suppressedIds", read),
  observation_countBackfill: storeUnit(store, "countBackfill", read),
  observation_createForMemory: storeUnit(store, "createForMemory", write),
  observation_backfill: storeUnit(store, "backfill", write),
  observation_update: storeUnit(store, "update", write),
  observation_redact: storeUnit(store, "redact", write),
  observation_delete: storeUnit(store, "delete", write),
} satisfies UnitCatalog;
