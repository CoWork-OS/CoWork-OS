import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { DurableContextStore } from "./durable-context-sql";

/** Durable context units (async SQLite migration plan, DB6), part of the memory domain. */

const store = (db: Database.Database) => new DurableContextStore(db);

export const DURABLE_CONTEXT_READS = ["search", "describe"] as const;
export const DURABLE_CONTEXT_WRITES = [
  "recordHistory",
  "recordCompactionSummary",
  "clearWorkspace",
] as const;

export const DURABLE_CONTEXT_UNITS = {
  durable_search: storeUnit(store, "search", { readonly: true }),
  durable_describe: storeUnit(store, "describe", { readonly: true }),
  durable_recordHistory: storeUnit(store, "recordHistory", { readonly: false }),
  durable_recordCompactionSummary: storeUnit(store, "recordCompactionSummary", {
    readonly: false,
  }),
  durable_clearWorkspace: storeUnit(store, "clearWorkspace", { readonly: false }),
} satisfies UnitCatalog;
