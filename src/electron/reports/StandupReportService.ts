import type Database from "better-sqlite3";
import type { StandupReport, Task } from "../../shared/types";
import type { AsyncStore } from "../database/statements/store-units";
import { reportsFacade } from "./reports-statement-port";
import {
  StandupReportStore,
  type DeliveryConfig,
  type StandupListQuery,
} from "./standup-report-sql";

export type { DeliveryConfig, StandupListQuery } from "./standup-report-sql";

type StandupMethod =
  | "generateReport"
  | "markDelivered"
  | "getLatest"
  | "getByDate"
  | "list"
  | "findById"
  | "deleteOlderThan";

/**
 * Daily standup reports (async SQLite migration plan, DB6). Generating a report (finding
 * an existing one for the date, reading the tasks, saving it) is one reports-domain unit;
 * reads are report units on the reporting reader when one is running. Delivery stays here.
 */
export class StandupReportService {
  private readonly store: AsyncStore<StandupReportStore, StandupMethod>;
  /** Formatting only; runs no SQL. */
  private readonly formatter: StandupReportStore;

  constructor(
    db: Database.Database,
    private deliverToChannel?: (report: StandupReport, config: DeliveryConfig) => Promise<void>,
  ) {
    this.store = reportsFacade<StandupReportStore, StandupMethod>(db, "standup_", [
      "generateReport",
      "markDelivered",
      "getLatest",
      "getByDate",
      "list",
      "findById",
      "deleteOlderThan",
    ]);
    this.formatter = new StandupReportStore(db);
  }

  /**
   * Generate a standup report for a workspace
   * Aggregates task status from the past 24 hours
   */
  generateReport(workspaceId: string, date: Date = new Date()): Promise<StandupReport> {
    return this.store.generateReport(workspaceId, date.getTime());
  }

  /**
   * Deliver a standup report to a configured channel
   */
  async deliverReport(report: StandupReport, config: DeliveryConfig): Promise<void> {
    if (!this.deliverToChannel) {
      throw new Error("No delivery handler configured");
    }
    await this.deliverToChannel(report, config);
    await this.store.markDelivered(report.id, `${config.channelType}:${config.channelId}`);
  }

  getLatest(workspaceId: string): Promise<StandupReport | undefined> {
    return this.store.getLatest(workspaceId);
  }

  getByDate(workspaceId: string, reportDate: string): Promise<StandupReport | undefined> {
    return this.store.getByDate(workspaceId, reportDate);
  }

  list(query: StandupListQuery): Promise<StandupReport[]> {
    return this.store.list(query);
  }

  findById(id: string): Promise<StandupReport | undefined> {
    return this.store.findById(id);
  }

  deleteOlderThan(workspaceId: string, daysToKeep: number): Promise<number> {
    return this.store.deleteOlderThan(workspaceId, daysToKeep);
  }

  formatReportMessage(report: StandupReport, tasks: Map<string, Task>): string {
    return this.formatter.formatReportMessage(report, tasks);
  }
}
