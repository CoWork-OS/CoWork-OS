import type Database from "better-sqlite3";
import { ensureMemoryItemsSchema } from "../memory-items-sql";

/** Whether the native SQLite module loads in this environment. */
export const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

/** An in-memory profile database with the tables memory items touch. */
export async function createMemoryItemsTestDb(workspaceIds: string[] = ["ws-1"]) {
  const { default: SqliteDatabase } = await import("better-sqlite3");
  const db: Database.Database = new SqliteDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT);
    CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE curated_memory_entries (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, target TEXT NOT NULL,
      kind TEXT NOT NULL, content TEXT NOT NULL, normalized_key TEXT NOT NULL, source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.7, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER
    );
  `);
  for (const id of workspaceIds) {
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)").run(
      id,
      id,
      `/tmp/${id}`,
    );
  }
  ensureMemoryItemsSchema(db);
  return db;
}

export function rowsOf(db: Database.Database, where = "1 = 1", ...params: unknown[]) {
  return db
    .prepare(`SELECT * FROM memory_items WHERE ${where} ORDER BY created_at, rowid`)
    .all(...params) as Array<Record<string, unknown>>;
}
