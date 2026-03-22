import type { Task, TaskStatus } from "./types";

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["pending", "queued", "planning", "executing"]);

export function isActiveTaskStatus(status: TaskStatus | undefined): boolean {
  return typeof status === "string" && ACTIVE_TASK_STATUSES.has(status);
}

export function deriveCanonicalTaskStatus(task: Pick<Task, "status" | "completedAt" | "terminalStatus">): TaskStatus {
  const status = task.status;
  const completedAt =
    typeof task.completedAt === "number" && Number.isFinite(task.completedAt) ? task.completedAt : undefined;

  if (!isActiveTaskStatus(status)) {
    return status;
  }

  switch (task.terminalStatus) {
    case "failed":
      return "failed";
    case "resume_available":
      return "interrupted";
    case "awaiting_approval":
      return "blocked";
    case "needs_user_action":
      return completedAt !== undefined ? "completed" : "paused";
    case "ok":
    case "partial_success":
      return "completed";
    default:
      break;
  }

  if (completedAt !== undefined) {
    return "completed";
  }

  return status;
}

export function normalizeTaskLifecycleState<T extends Pick<Task, "status" | "completedAt" | "terminalStatus">>(
  task: T,
): T {
  const canonicalStatus = deriveCanonicalTaskStatus(task);
  if (canonicalStatus === task.status) {
    return task;
  }
  return { ...task, status: canonicalStatus };
}
