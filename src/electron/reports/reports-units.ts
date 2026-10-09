import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { DailyBriefingStore } from "./daily-briefing-sql";
import { UsageInsightsService } from "./UsageInsightsService";

/**
 * Reports-domain transaction units (async SQLite migration plan, DB6). Reads are report
 * units: they run on the reporting reader when one is running, so a scan never queues
 * ahead of writes. Usage insights reports and rollups already run through the DB4 usage
 * commands.
 */

const briefing = (db: Database.Database) => new DailyBriefingStore(db);
const usage = (db: Database.Database) => new UsageInsightsService(db);
const report = { readonly: true, report: true };

export const REPORTS_UNITS = {
  briefing_countTasks: storeUnit(briefing, "countTasks", report),
  briefing_countScheduledTasks: storeUnit(briefing, "countScheduledTasks", report),
  usage_getEarliestActivityMs: storeUnit(usage, "getEarliestActivityMs", report),
} satisfies UnitCatalog;
