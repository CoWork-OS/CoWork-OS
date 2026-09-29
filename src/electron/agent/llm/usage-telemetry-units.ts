import type Database from "better-sqlite3";
import type { UnitCatalog } from "../../database/statements/statement-catalog";
import { storeUnit } from "../../database/statements/store-units";
import { UsageTelemetryStore } from "./usage-telemetry-sql";

const make = (db: Database.Database) => new UsageTelemetryStore(db);

/** Usage telemetry units (async SQLite migration plan, DB6), in the services domain. */
export const USAGE_TELEMETRY_UNITS = {
  usageTelemetry_insertLlmCall: storeUnit(make, "insertLlmCall", { readonly: false }),
  usageTelemetry_insertJevCall: storeUnit(make, "insertJevCall", { readonly: false }),
  usageTelemetry_taskCostTotals: storeUnit(make, "taskCostTotals", { readonly: true }),
} satisfies UnitCatalog;
