import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { BriefingStore } from "./briefing-sql";

const make = (db: Database.Database) => new BriefingStore(db);

/** Daily briefing units (async SQLite migration plan, DB6), in the services domain. */
export const BRIEFING_UNITS = {
  briefing_saveBriefing: storeUnit(make, "saveBriefing", { readonly: false }),
  briefing_latestBriefing: storeUnit(make, "latestBriefing", { readonly: true }),
  briefing_saveConfig: storeUnit(make, "saveConfig", { readonly: false }),
  briefing_config: storeUnit(make, "config", { readonly: true }),
  briefing_configuredWorkspaceIds: storeUnit(make, "configuredWorkspaceIds", { readonly: true }),
} satisfies UnitCatalog;
