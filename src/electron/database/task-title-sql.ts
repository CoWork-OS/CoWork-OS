import type Database from "better-sqlite3";
import type { Task } from "../../shared/types";

/** Conditional title update used by TaskStore.updateTitleIfUnchanged storage units. */
export function updateTaskTitleIfUnchanged(
  db: Database.Database,
  id: string,
  expectedTitle: string,
  title: string,
  findTask: (taskId: string) => Task | undefined,
  invalidateTaskRowReads: (db: Database.Database) => void,
  enqueueTaskUpdate: (before: Task | undefined, after: Task | undefined) => void,
): boolean {
  const before = findTask(id);
  const result = db
    .prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
    .run(title, Date.now(), id, expectedTitle);
  if (result.changes === 0) return false;
  invalidateTaskRowReads(db);
  enqueueTaskUpdate(before, findTask(id));
  return true;
}
