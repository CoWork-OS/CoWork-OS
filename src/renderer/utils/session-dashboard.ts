import type { SessionProgressState, Task, TaskEvent } from "../../shared/types";

export interface SessionDashboardMetrics {
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  artifactCount: number;
  approvalCount: number;
  memberCount: number;
  automationRunCount: number;
  workspaceChangeCount: number;
  recentChanges: string[];
}

function eventType(event: TaskEvent): string {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  return typeof event.legacyType === "string" && event.legacyType.trim()
    ? event.legacyType.trim()
    : typeof (payload as Record<string, unknown>).legacyType === "string"
      ? String((payload as Record<string, unknown>).legacyType)
      : String(event.type || "");
}

function payload(event: TaskEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function pathForEvent(event: TaskEvent): string | undefined {
  const value = payload(event).path || payload(event).filePath || payload(event).outputPath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function automationKey(event: TaskEvent): string {
  const data = payload(event);
  for (const key of ["runId", "automationRunId", "automationId", "routineId"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
  }
  return event.id;
}

export function buildSessionDashboardMetrics(
  task: Task,
  progress: SessionProgressState,
  events: TaskEvent[],
  options: { artifactCount?: number; memberCount?: number } = {},
): SessionDashboardMetrics {
  const changeEvents = events.filter((event) =>
    ["file_created", "file_modified", "file_deleted", "artifact_created"].includes(
      eventType(event),
    ),
  );
  const changedPaths = new Set(changeEvents.map(pathForEvent).filter(Boolean));
  const automationEvents = events.filter((event) => {
    const type = eventType(event).toLowerCase();
    const data = payload(event);
    return (
      type.includes("automation") ||
      type.includes("routine_run") ||
      data.automationRun === true ||
      typeof data.automationRunId === "string" ||
      (typeof data.runId === "string" && typeof data.automationId === "string")
    );
  });
  const automationRuns = new Set(automationEvents.map(automationKey));
  if (
    automationRuns.size === 0 &&
    ["cron", "hook", "subconscious", "symphony"].includes(task.source || "")
  ) {
    automationRuns.add(task.id);
  }

  const recentChanges = changeEvents
    .slice(-5)
    .reverse()
    .map((event) => {
      const path = pathForEvent(event);
      const type = eventType(event);
      const verb =
        type === "file_deleted" ? "Deleted" : type === "file_modified" ? "Updated" : "Created";
      return path ? `${verb} ${path.split(/[\\/]/).pop() || path}` : type;
    });

  const totalSteps = Math.max(0, progress.totalSteps);
  const completedSteps = Math.min(
    Math.max(0, progress.completedSteps),
    totalSteps || progress.completedSteps,
  );
  return {
    completedSteps,
    totalSteps,
    progressPercent: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    artifactCount: Math.max(
      options.artifactCount || 0,
      changeEvents.filter((event) => eventType(event) === "artifact_created").length,
    ),
    approvalCount: progress.pendingApprovals.length + progress.pendingInputRequests.length,
    memberCount: Math.max(0, options.memberCount || 0),
    automationRunCount: automationRuns.size,
    workspaceChangeCount: changedPaths.size,
    recentChanges,
  };
}
