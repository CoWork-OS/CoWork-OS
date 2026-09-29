import type { Task } from "../../shared/types";

/** A persisted pending sample has no executor checkpoint after process restart. */
export function reconcilePendingSampleAttempts(
  attemptTaskIds: string[],
  findTask: (taskId: string) => Pick<Task, "status" | "source"> | null | undefined,
  failTask: (taskId: string, error: string, completedAt: number) => void,
  now = Date.now(),
): void {
  for (const taskId of attemptTaskIds) {
    const task = findTask(taskId);
    if (task?.source === "sample" && task.status === "pending") {
      failTask(
        taskId,
        "Sample preparation was interrupted before execution. Start a fresh sample attempt.",
        now,
      );
    }
  }
}
