import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import type { RecentTaskEventRow } from "./agent-signal-sql";

/** Recent task events of one type, read in one services-domain unit. */
export function recentTaskEventsOfType(
  db: Database.Database,
  type: string,
  sinceMs: number,
  limit: number,
  order: "asc" | "desc",
): Promise<RecentTaskEventRow[]> {
  return serviceStatements(db).unit("agentSignal_recentEventsOfType", [
    type,
    sinceMs,
    limit,
    order,
  ]);
}
