/**
 * Tests for StandupReportService
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StandupReport, Task } from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockReports: Map<string, Any>;
let mockTasks: Map<string, Any>;
let reportIdCounter: number;
let timestampCounter: number;

// Mock StandupReportService
class MockStandupReportService {
  private deliverToChannel?: (report: StandupReport, config: Any) => Promise<void>;

  constructor(deliverToChannel?: (report: StandupReport, config: Any) => Promise<void>) {
    this.deliverToChannel = deliverToChannel;
  }

  async generateReport(workspaceId: string, date: Date = new Date()): Promise<StandupReport> {
    const reportDate = this.formatDate(date);
    const yesterday = date.getTime() - 24 * 60 * 60 * 1000;

    // Check if report already exists
    const existing = this.getByDate(workspaceId, reportDate);
    if (existing) {
      return existing;
    }

    // Get tasks
    const completedTasks = this.getTasksByColumn(workspaceId, "done", yesterday);
    const inProgressTasks = this.getTasksByColumn(workspaceId, "in_progress");
    const blockedTasks = this.getBlockedTasks(workspaceId);

    // Generate summary
    const summary = this.buildSummary(completedTasks, inProgressTasks, blockedTasks);

    const report: StandupReport = {
      id: `report-${++reportIdCounter}`,
      workspaceId,
      reportDate,
      completedTaskIds: completedTasks.map((t) => t.id),
      inProgressTaskIds: inProgressTasks.map((t) => t.id),
      blockedTaskIds: blockedTasks.map((t) => t.id),
      summary,
      createdAt: ++timestampCounter, // Use incrementing timestamp for deterministic ordering
    };

    // Save
    this.save(report);

    return report;
  }

  async deliverReport(
    report: StandupReport,
    config: { channelType: string; channelId: string },
  ): Promise<void> {
    if (!this.deliverToChannel) {
      throw new Error("No delivery handler configured");
    }

    await this.deliverToChannel(report, config);

    // Update delivered status
    const stored = mockReports.get(report.id);
    if (stored) {
      stored.delivered_to_channel = `${config.channelType}:${config.channelId}`;
    }
  }

  getLatest(workspaceId: string): StandupReport | undefined {
    let latest: StandupReport | undefined;
    let latestTime = 0;

    mockReports.forEach((stored) => {
      if (stored.workspace_id === workspaceId && stored.created_at > latestTime) {
        latestTime = stored.created_at;
        latest = this.mapRowToReport(stored);
      }
    });

    return latest;
  }

  getByDate(workspaceId: string, reportDate: string): StandupReport | undefined {
    for (const stored of mockReports.values()) {
      if (stored.workspace_id === workspaceId && stored.report_date === reportDate) {
        return this.mapRowToReport(stored);
      }
    }
    return undefined;
  }

  list(query: {
    workspaceId: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
  }): StandupReport[] {
    const results: StandupReport[] = [];

    mockReports.forEach((stored) => {
      if (stored.workspace_id !== query.workspaceId) return;
      if (query.startDate && stored.report_date < query.startDate) return;
      if (query.endDate && stored.report_date > query.endDate) return;
      results.push(this.mapRowToReport(stored));
    });

    results.sort((a, b) => b.reportDate.localeCompare(a.reportDate));

    if (query.limit) {
      return results.slice(0, query.limit);
    }

    return results;
  }

  findById(id: string): StandupReport | undefined {
    const stored = mockReports.get(id);
    return stored ? this.mapRowToReport(stored) : undefined;
  }

  deleteOlderThan(workspaceId: string, daysToKeep: number): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = this.formatDate(cutoffDate);

    let deleted = 0;
    for (const [id, stored] of mockReports) {
      if (stored.workspace_id === workspaceId && stored.report_date < cutoffStr) {
        mockReports.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  formatReportMessage(report: StandupReport, tasks: Map<string, Task>): string {
    const lines: string[] = [`**Daily Standup Report - ${report.reportDate}**`, ""];

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

    lines.push("**Summary:**");
    lines.push(report.summary);

    return lines.join("\n");
  }

  private save(report: StandupReport): void {
    mockReports.set(report.id, {
      id: report.id,
      workspace_id: report.workspaceId,
      report_date: report.reportDate,
      completed_task_ids: JSON.stringify(report.completedTaskIds),
      in_progress_task_ids: JSON.stringify(report.inProgressTaskIds),
      blocked_task_ids: JSON.stringify(report.blockedTaskIds),
      summary: report.summary,
      delivered_to_channel: report.deliveredToChannel || null,
      created_at: report.createdAt,
    });
  }

  private getTasksByColumn(workspaceId: string, column: string, updatedAfter?: number): Task[] {
    const results: Task[] = [];
    mockTasks.forEach((stored) => {
      if (stored.workspace_id !== workspaceId) return;
      if (stored.board_column !== column) return;
      if (updatedAfter && stored.updated_at < updatedAfter) return;
      results.push(this.mapRowToTask(stored));
    });
    return results;
  }

  private getBlockedTasks(workspaceId: string): Task[] {
    const results: Task[] = [];
    mockTasks.forEach((stored) => {
      if (stored.workspace_id !== workspaceId) return;
      if (stored.status !== "blocked" && stored.status !== "failed") return;
      results.push(this.mapRowToTask(stored));
    });
    return results;
  }

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

  private formatDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

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

// Helper to add test tasks
function addTask(
  id: string,
  workspaceId: string,
  status: string,
  boardColumn: string,
  updatedAt?: number,
) {
  mockTasks.set(id, {
    id,
    title: `Task ${id}`,
    prompt: `Prompt for ${id}`,
    status,
    workspace_id: workspaceId,
    board_column: boardColumn,
    created_at: Date.now() - 86400000,
    updated_at: updatedAt || Date.now(),
  });
}

describe("StandupReportService", () => {
  let service: MockStandupReportService;

  beforeEach(() => {
    mockReports = new Map();
    mockTasks = new Map();
    reportIdCounter = 0;
    timestampCounter = Date.now(); // Start from current time for realistic timestamps
    service = new MockStandupReportService();
  });

  describe("generateReport", () => {
    it("should generate a report with no tasks", async () => {
      const report = await service.generateReport("workspace-1");

      expect(report).toBeDefined();
      expect(report.id).toBeDefined();
      expect(report.workspaceId).toBe("workspace-1");
      expect(report.completedTaskIds).toHaveLength(0);
      expect(report.inProgressTaskIds).toHaveLength(0);
      expect(report.blockedTaskIds).toHaveLength(0);
      expect(report.summary).toBe("No task activity today.");
    });

    it("should include completed tasks from last 24 hours", async () => {
      addTask("task-1", "workspace-1", "done", "done");
      addTask("task-2", "workspace-1", "done", "done");

      const report = await service.generateReport("workspace-1");

      expect(report.completedTaskIds).toHaveLength(2);
      expect(report.summary).toContain("2 tasks completed");
    });

    it("should include in-progress tasks", async () => {
      addTask("task-1", "workspace-1", "in_progress", "in_progress");
      addTask("task-2", "workspace-1", "in_progress", "in_progress");
      addTask("task-3", "workspace-1", "in_progress", "in_progress");

      const report = await service.generateReport("workspace-1");

      expect(report.inProgressTaskIds).toHaveLength(3);
      expect(report.summary).toContain("3 tasks in progress");
    });

    it("should include blocked tasks", async () => {
      addTask("task-1", "workspace-1", "blocked", "in_progress");

      const report = await service.generateReport("workspace-1");

      expect(report.blockedTaskIds).toHaveLength(1);
      expect(report.summary).toContain("1 task blocked");
    });

    it("should not include old completed tasks", async () => {
      const twoDaysAgo = Date.now() - 2 * 86400000;
      addTask("task-1", "workspace-1", "done", "done", twoDaysAgo);

      const report = await service.generateReport("workspace-1");

      expect(report.completedTaskIds).toHaveLength(0);
    });

    it("should return existing report for same date", async () => {
      const report1 = await service.generateReport("workspace-1");
      const report2 = await service.generateReport("workspace-1");

      expect(report1.id).toBe(report2.id);
    });

    it("should filter by workspace", async () => {
      addTask("task-1", "workspace-1", "in_progress", "in_progress");
      addTask("task-2", "workspace-2", "in_progress", "in_progress");

      const report = await service.generateReport("workspace-1");

      expect(report.inProgressTaskIds).toHaveLength(1);
      expect(report.inProgressTaskIds).toContain("task-1");
    });
  });

  describe("deliverReport", () => {
    it("should throw if no delivery handler configured", async () => {
      const report = await service.generateReport("workspace-1");

      await expect(
        service.deliverReport(report, { channelType: "telegram", channelId: "chat-1" }),
      ).rejects.toThrow("No delivery handler configured");
    });

    it("should call delivery handler and update report", async () => {
      const deliveryHandler = vi.fn().mockResolvedValue(undefined);
      const serviceWithHandler = new MockStandupReportService(deliveryHandler);

      // Generate report first
      const report = await serviceWithHandler.generateReport("workspace-1");

      // Deliver
      await serviceWithHandler.deliverReport(report, {
        channelType: "telegram",
        channelId: "chat-1",
      });

      expect(deliveryHandler).toHaveBeenCalledWith(report, {
        channelType: "telegram",
        channelId: "chat-1",
      });

      // Verify delivered_to_channel is set
      const stored = mockReports.get(report.id);
      expect(stored.delivered_to_channel).toBe("telegram:chat-1");
    });
  });

  describe("getLatest", () => {
    it("should return the latest report", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-02"));
      await service.generateReport("workspace-1", new Date("2024-01-03"));

      const latest = service.getLatest("workspace-1");

      expect(latest).toBeDefined();
      expect(latest?.reportDate).toBe("2024-01-03");
    });

    it("should return undefined if no reports exist", () => {
      const latest = service.getLatest("workspace-1");

      expect(latest).toBeUndefined();
    });
  });

  describe("getByDate", () => {
    it("should return report by date", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-15"));

      const report = service.getByDate("workspace-1", "2024-01-15");

      expect(report).toBeDefined();
      expect(report?.reportDate).toBe("2024-01-15");
    });

    it("should return undefined for non-existent date", () => {
      const report = service.getByDate("workspace-1", "2024-01-01");

      expect(report).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should list all reports for workspace", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-02"));
      await service.generateReport("workspace-2", new Date("2024-01-01"));

      const reports = service.list({ workspaceId: "workspace-1" });

      expect(reports).toHaveLength(2);
    });

    it("should filter by date range", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-15"));
      await service.generateReport("workspace-1", new Date("2024-01-31"));

      const reports = service.list({
        workspaceId: "workspace-1",
        startDate: "2024-01-10",
        endDate: "2024-01-20",
      });

      expect(reports).toHaveLength(1);
      expect(reports[0].reportDate).toBe("2024-01-15");
    });

    it("should respect limit", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-02"));
      await service.generateReport("workspace-1", new Date("2024-01-03"));

      const reports = service.list({ workspaceId: "workspace-1", limit: 2 });

      expect(reports).toHaveLength(2);
    });

    it("should sort by date descending", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-03"));
      await service.generateReport("workspace-1", new Date("2024-01-02"));

      const reports = service.list({ workspaceId: "workspace-1" });

      expect(reports[0].reportDate).toBe("2024-01-03");
      expect(reports[1].reportDate).toBe("2024-01-02");
      expect(reports[2].reportDate).toBe("2024-01-01");
    });
  });

  describe("findById", () => {
    it("should find report by ID", async () => {
      const created = await service.generateReport("workspace-1");

      const found = service.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it("should return undefined for non-existent ID", () => {
      const found = service.findById("non-existent");

      expect(found).toBeUndefined();
    });
  });

  describe("deleteOlderThan", () => {
    it("should delete old reports", async () => {
      // Generate some reports with old dates
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-1", new Date("2024-01-15"));

      // Delete reports older than today (all test reports are old)
      const deleted = service.deleteOlderThan("workspace-1", 0);

      expect(deleted).toBe(2);
      expect(service.list({ workspaceId: "workspace-1" })).toHaveLength(0);
    });

    it("should only delete for specified workspace", async () => {
      await service.generateReport("workspace-1", new Date("2024-01-01"));
      await service.generateReport("workspace-2", new Date("2024-01-01"));

      service.deleteOlderThan("workspace-1", 0);

      expect(service.list({ workspaceId: "workspace-1" })).toHaveLength(0);
      expect(service.list({ workspaceId: "workspace-2" })).toHaveLength(1);
    });
  });

  describe("formatReportMessage", () => {
    it("should format report with all sections", async () => {
      addTask("task-1", "workspace-1", "done", "done");
      addTask("task-2", "workspace-1", "in_progress", "in_progress");
      addTask("task-3", "workspace-1", "blocked", "in_progress");

      const report = await service.generateReport("workspace-1");

      const taskMap = new Map<string, Task>();
      mockTasks.forEach((stored, id) => {
        taskMap.set(id, {
          id: stored.id,
          title: stored.title,
          prompt: stored.prompt,
          status: stored.status,
          workspaceId: stored.workspace_id,
          createdAt: stored.created_at,
          updatedAt: stored.updated_at,
          boardColumn: stored.board_column,
        });
      });

      const message = service.formatReportMessage(report, taskMap);

      expect(message).toContain("Daily Standup Report");
      expect(message).toContain("Completed Today:");
      expect(message).toContain("In Progress:");
      expect(message).toContain("Blocked:");
      expect(message).toContain("Summary:");
    });
  });
});
