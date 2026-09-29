import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { MissionControlIntelligenceStore } from "./MissionControlIntelligenceService";

const make = (db: Database.Database) => new MissionControlIntelligenceStore(db);

/** Mission Control transaction units (async SQLite migration plan, DB6), in the services domain. */
export const MISSION_CONTROL_UNITS = {
  missionControl_refresh: storeUnit(make, "refresh", { readonly: false }),
  missionControl_listItems: storeUnit(make, "listItems", { readonly: true }),
  missionControl_getEvidence: storeUnit(make, "getEvidence", { readonly: true }),
  missionControl_getBrief: storeUnit(make, "getBrief", { readonly: true }),
  missionControl_recordHeartbeatEvent: storeUnit(make, "recordHeartbeatEvent", { readonly: false }),
} satisfies UnitCatalog;
