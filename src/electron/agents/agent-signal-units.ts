import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AgentSignalStore } from "./agent-signal-sql";

const make = (db: Database.Database) => new AgentSignalStore(db);

/** Agent kit rebuild reads (async SQLite migration plan, DB6), in the services domain. */
export const AGENT_SIGNAL_UNITS = {
  agentSignal_recentEventsOfType: storeUnit(make, "recentEventsOfType", { readonly: true }),
  agentSignal_eventsInRange: storeUnit(make, "eventsInRange", { readonly: true }),
} satisfies UnitCatalog;
