import type Database from "better-sqlite3";

export interface LocalRealWorkState {
  inspectedAt: number | null;
  usefulAt: number | null;
  returnUse: boolean;
}

export function readLocalRealWork(db: Database.Database, taskId: string): LocalRealWorkState {
  const row = db
    .prepare("SELECT inspected_at, useful_at FROM first_task_real_work WHERE task_id = ?")
    .get(taskId) as { inspected_at: number; useful_at: number | null } | undefined;
  const firstUseful = db
    .prepare(
      "SELECT MIN(useful_at) AS first_useful FROM first_task_real_work WHERE useful_at IS NOT NULL",
    )
    .get() as { first_useful: number | null };
  return {
    inspectedAt: row?.inspected_at ?? null,
    usefulAt: row?.useful_at ?? null,
    returnUse: Boolean(
      row?.useful_at &&
      firstUseful.first_useful &&
      Math.floor(row.useful_at / 86_400_000) > Math.floor(firstUseful.first_useful / 86_400_000),
    ),
  };
}

export function recordLocalRealWorkInspection(
  db: Database.Database,
  taskId: string,
  now = Date.now(),
): LocalRealWorkState {
  db.prepare(
    "INSERT INTO first_task_real_work (task_id, inspected_at) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING",
  ).run(taskId, now);
  return readLocalRealWork(db, taskId);
}

export function recordLocalRealWorkUseful(
  db: Database.Database,
  taskId: string,
  now = Date.now(),
): LocalRealWorkState {
  if (!readLocalRealWork(db, taskId).inspectedAt)
    throw new Error("Open the task output before marking it useful");
  db.prepare(
    "UPDATE first_task_real_work SET useful_at = COALESCE(useful_at, ?) WHERE task_id = ?",
  ).run(now, taskId);
  return readLocalRealWork(db, taskId);
}
