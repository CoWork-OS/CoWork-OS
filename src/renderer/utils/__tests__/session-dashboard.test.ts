import { describe, expect, it } from "vitest";
import type { SessionProgressState, Task, TaskEvent } from "../../../shared/types";
import { buildSessionDashboardMetrics } from "../session-dashboard";

const task = { id: "task-1", source: "cron" } as Task;
const progress = {
  schemaVersion: 1,
  taskId: "task-1",
  status: "executing",
  phase: "executing",
  headline: "Working",
  completedSteps: 2,
  totalSteps: 4,
  activeAgentCount: 1,
  pendingApprovals: [
    { id: "approval-1", type: "shell" as never, description: "Approval", requestedAt: 1 },
  ],
  pendingInputRequests: [],
  connectionState: "connected",
  updatedAt: 1,
} as SessionProgressState;

function event(id: string, type: TaskEvent["type"], payload: Record<string, unknown>): TaskEvent {
  return {
    id,
    eventId: id,
    taskId: "task-1",
    timestamp: Number(id),
    type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

describe("buildSessionDashboardMetrics", () => {
  it("summarizes progress, approvals, artifacts, and distinct workspace changes", () => {
    const metrics = buildSessionDashboardMetrics(
      task,
      progress,
      [
        event("1", "file_created", { path: "src/a.ts" }),
        event("2", "file_modified", { path: "src/a.ts" }),
        event("3", "artifact_created", { path: "dist/report.md" }),
        event("4", "log" as TaskEvent["type"], { runId: "run-1", automationRun: true }),
      ],
      { artifactCount: 3, memberCount: 2 },
    );

    expect(metrics.progressPercent).toBe(50);
    expect(metrics.approvalCount).toBe(1);
    expect(metrics.artifactCount).toBe(3);
    expect(metrics.memberCount).toBe(2);
    expect(metrics.automationRunCount).toBe(1);
    expect(metrics.workspaceChangeCount).toBe(2);
  });

  it("counts automated tasks even when no automation event was emitted", () => {
    const metrics = buildSessionDashboardMetrics({ ...task, source: "cron" } as Task, progress, []);
    expect(metrics.automationRunCount).toBe(1);
  });
});
