import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AgentPerformanceReviewStore } from "./agent-performance-review-sql";
import { DailyBriefingStore } from "./daily-briefing-sql";
import { StandupReportStore } from "./standup-report-sql";
import { UsageInsightsService } from "./UsageInsightsService";

/**
 * Reports-domain transaction units (async SQLite migration plan, DB6). Reads are report
 * units: they run on the reporting reader when one is running, so a scan never queues
 * ahead of writes. Usage insights reports and rollups already run through the DB4 usage
 * commands.
 */

const standup = (db: Database.Database) => new StandupReportStore(db);
const review = (db: Database.Database) => new AgentPerformanceReviewStore(db);
const briefing = (db: Database.Database) => new DailyBriefingStore(db);
const usage = (db: Database.Database) => new UsageInsightsService(db);
const report = { readonly: true, report: true };
const write = { readonly: false };

export const REPORTS_UNITS = {
  standup_generateReport: storeUnit(standup, "generateReport", write),
  standup_markDelivered: storeUnit(standup, "markDelivered", write),
  standup_getLatest: storeUnit(standup, "getLatest", report),
  standup_getByDate: storeUnit(standup, "getByDate", report),
  standup_list: storeUnit(standup, "list", report),
  standup_findById: storeUnit(standup, "findById", report),
  standup_deleteOlderThan: storeUnit(standup, "deleteOlderThan", write),
  review_generate: storeUnit(review, "generate", write),
  review_getLatest: storeUnit(review, "getLatest", report),
  review_list: storeUnit(review, "list", report),
  review_delete: storeUnit(review, "delete", write),
  briefing_countTasks: storeUnit(briefing, "countTasks", report),
  briefing_countScheduledTasks: storeUnit(briefing, "countScheduledTasks", report),
  usage_getEarliestActivityMs: storeUnit(usage, "getEarliestActivityMs", report),
} satisfies UnitCatalog;
