import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { StandupReport, Task, BoardColumn } from "../../shared/types";

/**
 * Query for standup reports
 */
export interface StandupListQuery {
  workspaceId: string;
  limit?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}

/**
 * Channel configuration for report delivery
 */
export interface DeliveryConfig {
  channelType: string; // telegram, discord, slack, etc.
  channelId: string;
}

/**
 * Service for generating and managing daily standup reports
 */
export class StandupReportService {
  constructor(
    private db: Database.Database,
    private deliverToChannel?: (report: StandupReport, config: DeliveryConfig) => Promise<void>,
  ) {}

  /**
   * Generate a standup report for a workspace
   * Aggregates task status from the past 24 hours
   */
  async generateReport(workspaceId: string, date: Date = new Date()): Promise<StandupReport> {
    const reportDate = this.formatDate(date);
    const yesterday = date.getTime() - 24 * 60 * 60 * 1000;

    // Check if report already exists for this date
    const existing = this.getByDate(workspaceId, reportDate);
    if (existing) {
      return existing;
    }

    // Get completed tasks (done column, updated in last 24h)
    const completedTasks = this.getTasksByColumn(workspaceId, "done", yesterday);

    // Get in-progress tasks
    const inProgressTasks = this.getTasksByColumn(workspaceId, "in_progress");

    // Get blocked tasks (status = 'blocked' or 'failed')
    const blockedTasks = this.getBlockedTasks(workspaceId);

    // Generate summary
    const summary = this.buildSummary(completedTasks, inProgressTasks, blockedTasks);

    const report: StandupReport = {
      id: uuidv4(),
      workspaceId,
      reportDate,
      completedTaskIds: completedTasks.map((t) => t.id),
      inProgressTaskIds: inProgressTasks.map((t) => t.id),
      blockedTaskIds: blockedTasks.map((t) => t.id),
      summary,
      createdAt: Date.now(),
    };

    // Save to database
    this.save(report);

    return report;
  }

  /**
   * Deliver a standup report to a configured channel
   */
  async deliverReport(report: StandupReport, config: DeliveryConfig): Promise<void> {
    if (!this.deliverToChannel) {
      throw new Error("No delivery handler configured");
    }

    await this.deliverToChannel(report, config);

    // Update report with delivery info
    const deliveredToChannel = `${config.channelType}:${config.channelId}`;
    const stmt = this.db.prepare(
      "UPDATE standup_reports SET delivered_to_channel = ? WHERE id = ?",
    );
    stmt.run(deliveredToChannel, report.id);
  }

  /**
   * Get the latest standup report for a workspace
   */
  getLatest(workspaceId: string): StandupReport | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM standup_reports
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(workspaceId) as Any;
    return row ? this.mapRowToReport(row) : undefined;
  }

  /**
   * Get a standup report by date
   */
  getByDate(workspaceId: string, reportDate: string): StandupReport | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM standup_reports
      WHERE workspace_id = ? AND report_date = ?
    `);
    const row = stmt.get(workspaceId, reportDate) as Any;
    return row ? this.mapRowToReport(row) : undefined;
  }

  /**
   * List standup reports for a workspace
   */
  list(query: StandupListQuery): StandupReport[] {
    const conditions: string[] = ["workspace_id = ?"];
    const params: Any[] = [query.workspaceId];

    if (query.startDate) {
      conditions.push("report_date >= ?");
      params.push(query.startDate);
    }

    if (query.endDate) {
      conditions.push("report_date <= ?");
      params.push(query.endDate);
    }

    let sql = `SELECT * FROM standup_reports WHERE ${conditions.join(" AND ")} ORDER BY report_date DESC`;

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToReport(row));
  }

  /**
   * Find a report by ID
   */
  findById(id: string): StandupReport | undefined {
    const stmt = this.db.prepare("SELECT * FROM standup_reports WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToReport(row) : undefined;
  }

  /**
   * Delete old reports (cleanup)
   */
  deleteOlderThan(workspaceId: string, daysToKeep: number): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = this.formatDate(cutoffDate);

    const stmt = this.db.prepare(
      "DELETE FROM standup_reports WHERE workspace_id = ? AND report_date < ?",
    );
    const result = stmt.run(workspaceId, cutoffStr);
    return result.changes;
  }

  /**
   * Format the standup report as a message for delivery
   */
  formatReportMessage(report: StandupReport, tasks: Map<string, Task>): string {
    const lines: string[] = [`**Daily Standup Report - ${report.reportDate}**`, ""];

    // Completed section
    if (report.completedTaskIds.length > 0) {
      lines.push("**Completed Today:**");
      for (const taskId of report.completedTaskIds) {
        const task = tasks.get(taskId);
        if (task) {
          lines.push(`- ${task.title}`);
        }
      }
      lines.push("");
    }

    // In Progress section
    if (report.inProgressTaskIds.length > 0) {
      lines.push("**In Progress:**");
      for (const taskId of report.inProgressTaskIds) {
        const task = tasks.get(taskId);
        if (task) {
          lines.push(`- ${task.title}`);
        }
      }
      lines.push("");
    }

    // Blocked section
    if (report.blockedTaskIds.length > 0) {
      lines.push("**Blocked:**");
      for (const taskId of report.blockedTaskIds) {
        const task = tasks.get(taskId);
        if (task) {
          lines.push(`- ${task.title}`);
        }
      }
      lines.push("");
    }

    // Summary
    lines.push("**Summary:**");
    lines.push(report.summary);

    return lines.join("\n");
  }

  /**
   * Save a report to the database
   */
  private save(report: StandupReport): void {
    const stmt = this.db.prepare(`
      INSERT INTO standup_reports (
        id, workspace_id, report_date, completed_task_ids,
        in_progress_task_ids, blocked_task_ids, summary,
        delivered_to_channel, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      report.id,
      report.workspaceId,
      report.reportDate,
      JSON.stringify(report.completedTaskIds),
      JSON.stringify(report.inProgressTaskIds),
      JSON.stringify(report.blockedTaskIds),
      report.summary,
      report.deliveredToChannel || null,
      report.createdAt,
    );
  }

  /**
   * Get tasks by board column with optional time filter
   */
  private getTasksByColumn(
    workspaceId: string,
    column: BoardColumn,
    updatedAfter?: number,
  ): Task[] {
    let sql = `
      SELECT * FROM tasks
      WHERE workspace_id = ? AND board_column = ?
    `;
    const params: Any[] = [workspaceId, column];

    if (updatedAfter) {
      sql += " AND updated_at >= ?";
      params.push(updatedAfter);
    }

    sql += " ORDER BY updated_at DESC";

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Get blocked tasks (status = blocked or failed)
   */
  private getBlockedTasks(workspaceId: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND status IN ('blocked', 'failed')
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all(workspaceId) as Any[];
    return rows.map((row) => this.mapRowToTask(row));
  }

  /**
   * Build a summary from task lists
   */
  private buildSummary(completed: Task[], inProgress: Task[], blocked: Task[]): string {
    const parts: string[] = [];

    if (completed.length > 0) {
      parts.push(`${completed.length} task${completed.length === 1 ? "" : "s"} completed`);
    }

    if (inProgress.length > 0) {
      parts.push(`${inProgress.length} task${inProgress.length === 1 ? "" : "s"} in progress`);
    }

    if (blocked.length > 0) {
      parts.push(`${blocked.length} task${blocked.length === 1 ? "" : "s"} blocked`);
    }

    if (parts.length === 0) {
      return "No task activity today.";
    }

    return parts.join(", ") + ".";
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  /**
   * Map database row to StandupReport
   */
  private mapRowToReport(row: Any): StandupReport {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      reportDate: row.report_date,
      completedTaskIds: JSON.parse(row.completed_task_ids || "[]"),
      inProgressTaskIds: JSON.parse(row.in_progress_task_ids || "[]"),
      blockedTaskIds: JSON.parse(row.blocked_task_ids || "[]"),
      summary: row.summary,
      deliveredToChannel: row.delivered_to_channel || undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * Map database row to Task (minimal mapping for standup)
   */
  private mapRowToTask(row: Any): Task {
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      boardColumn: row.board_column,
      assignedAgentRoleId: row.assigned_agent_role_id,
    };
  }
}
