import type Database from "better-sqlite3";
import type { Task } from "../../shared/types";

/** A persisted pending sample has no executor checkpoint after process restart. */
export function reconcilePendingSampleAttempts(
  db: Database.Database,
  findTask: (taskId: string) => Pick<Task, "status" | "source"> | null | undefined,
  failTask: (taskId: string, error: string, completedAt: number) => void,
  now = Date.now(),
): void {
  for (const row of db.prepare("SELECT task_id FROM first_task_attempts").all() as Array<{
    task_id: string;
  }>) {
    const task = findTask(row.task_id);
    if (task?.source === "sample" && task.status === "pending") {
      failTask(
        row.task_id,
        "Sample preparation was interrupted before execution. Start a fresh sample attempt.",
        now,
      );
    }
  }
}
