import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { PulseReportStore } from "./pulse-report-sql";

const make = (db: Database.Database) => new PulseReportStore(db);

/** Pulse read units (async SQLite migration plan, DB6), in the services domain. */
export const PULSE_REPORT_UNITS = {
  pulseReport_queueHead: storeUnit(make, "queueHead", { readonly: true }),
  pulseReport_receiptFor: storeUnit(make, "receiptFor", { readonly: true }),
  pulseReport_hasConsentWindow: storeUnit(make, "hasConsentWindow", { readonly: true }),
  pulseReport_openConsentStart: storeUnit(make, "openConsentStart", { readonly: true }),
  pulseReport_dayAggregates: storeUnit(make, "dayAggregates", { readonly: true }),
} satisfies UnitCatalog;
