import type Database from "better-sqlite3";

export function ensureFirstTaskTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS first_task_attempts (
    attempt_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    checked_at INTEGER,
    check_json TEXT,
    inspected_at INTEGER,
    revision_requested_at INTEGER,
    revision_base_hashes_json TEXT,
    revision_inspected_at INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS first_task_real_work (
    task_id TEXT PRIMARY KEY,
    inspected_at INTEGER NOT NULL,
    useful_at INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS first_task_setup (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    choice TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    model_ready_at INTEGER
  )`);
  const existing = new Set(
    (db.prepare("PRAGMA table_info(first_task_attempts)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const [column, type] of [
    ["revision_requested_at", "INTEGER"],
    ["revision_base_hashes_json", "TEXT"],
    ["revision_inspected_at", "INTEGER"],
  ] as const) {
    if (!existing.has(column))
      db.exec(`ALTER TABLE first_task_attempts ADD COLUMN ${column} ${type}`);
  }
}
