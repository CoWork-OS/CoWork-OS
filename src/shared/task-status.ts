import type { Task, TaskStatus } from "./types";

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(["pending", "queued", "planning", "executing"]);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

export function isActiveTaskStatus(status: TaskStatus | undefined): boolean {
  return typeof status === "string" && ACTIVE_TASK_STATUSES.has(status);
}

export function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return typeof status === "string" && TERMINAL_TASK_STATUSES.has(status);
}

export function deriveCanonicalTaskStatus(
  task: Pick<Task, "status" | "completedAt" | "terminalStatus">,
): TaskStatus {
  const status = task.status;
  const completedAt =
    typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
      ? task.completedAt
      : undefined;

  // Verification is an explicit non-terminal lifecycle marker. Treat it as
  // blocked even if a stale writer left the raw status as `completed`.
  if (task.terminalStatus === "awaiting_verification") {
    return "blocked";
  }

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

export function normalizeTaskLifecycleState<
  T extends Pick<Task, "status" | "completedAt" | "terminalStatus">,
>(task: T): T {
  const canonicalStatus = deriveCanonicalTaskStatus(task);
  if (canonicalStatus === task.status) {
    return task;
  }
  return { ...task, status: canonicalStatus };
}

export function resolveTaskStatusUpdateFromEvent<
  T extends Pick<Task, "status" | "completedAt" | "terminalStatus">,
>(task: T, nextStatus: TaskStatus | undefined): TaskStatus | undefined {
  if (!nextStatus) return undefined;

  const currentStatus = deriveCanonicalTaskStatus(task);
  if (isTerminalTaskStatus(currentStatus) && !isTerminalTaskStatus(nextStatus)) {
    return currentStatus;
  }

  return nextStatus;
}
