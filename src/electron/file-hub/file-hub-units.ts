import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { FileHubStore } from "./file-hub-sql";

const make = (db: Database.Database) => new FileHubStore(db);

/** File hub recent-file units (async SQLite migration plan, DB6), in the services domain. */
export const FILE_HUB_UNITS = {
  fileHub_recentRows: storeUnit(make, "recentRows", { readonly: true }),
  fileHub_trackRecent: storeUnit(make, "trackRecent", { readonly: false }),
} satisfies UnitCatalog;
