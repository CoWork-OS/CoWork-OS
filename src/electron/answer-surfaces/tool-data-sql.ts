import type Database from "better-sqlite3";
import type { AnswerDataTable } from "../../shared/answer-surfaces/data";

/**
 * Structured tool results kept for answer components, one row per tool call that returned
 * a table. Rows belong to their task and are deleted with it; a task keeps its newest
 * MAX_TOOL_DATA_PER_TASK tables.
 */
export const ANSWER_TOOL_DATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS answer_tool_data (
    task_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    table_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, handle)
  );
`;

export const MAX_TOOL_DATA_PER_TASK = 20;
export const MAX_TOOL_DATA_JSON_CHARS = 2 * 1024 * 1024;
/** All of a task's kept tables together. */
export const MAX_TOOL_DATA_TASK_CHARS = 8 * 1024 * 1024;

export type AnswerToolDataRow = { handle: string; toolName: string; table: AnswerDataTable };

/** Deletes a task's tool data inside the task-delete transaction. */
export function deleteAnswerToolDataForTask(db: Database.Database, taskId: string): void {
  db.exec(ANSWER_TOOL_DATA_SCHEMA);
  db.prepare("DELETE FROM answer_tool_data WHERE task_id = ?").run(taskId);
}

export class AnswerToolDataSqlStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Keeps a table for an existing task (a call that finishes after its task was deleted
   * keeps nothing). Insert-only: an existing handle is never replaced. Afterwards the task
   * keeps its newest tables within MAX_TOOL_DATA_PER_TASK and MAX_TOOL_DATA_TASK_CHARS.
   */
  put(
    taskId: string,
    handle: string,
    toolUseId: string,
    toolName: string,
    tableJson: string,
    now: number,
  ): void {
    if (tableJson.length > MAX_TOOL_DATA_JSON_CHARS) return;
    const hasTasks = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get();
    if (hasTasks && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO answer_tool_data
           (task_id, handle, tool_use_id, tool_name, table_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, handle, toolUseId, toolName, tableJson, now);
    const rows = this.db
      .prepare(
        `SELECT handle, length(table_json) AS size FROM answer_tool_data
         WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(taskId) as Array<{ handle: string; size: number }>;
    let total = 0;
    const remove = this.db.prepare("DELETE FROM answer_tool_data WHERE task_id = ? AND handle = ?");
    rows.forEach((row, index) => {
      total += row.size;
      if (index >= MAX_TOOL_DATA_PER_TASK || total > MAX_TOOL_DATA_TASK_CHARS) {
        remove.run(taskId, row.handle);
      }
    });
  }

  get(taskId: string, handle: string): AnswerToolDataRow | null {
    const row = this.db
      .prepare(
        "SELECT handle, tool_name, table_json FROM answer_tool_data WHERE task_id = ? AND handle = ?",
      )
      .get(taskId, handle) as { handle: string; tool_name: string; table_json: string } | undefined;
    if (!row) return null;
    try {
      return { handle: row.handle, toolName: row.tool_name, table: JSON.parse(row.table_json) };
    } catch {
      return null;
    }
  }

  deleteForTask(taskId: string): void {
    this.db.prepare("DELETE FROM answer_tool_data WHERE task_id = ?").run(taskId);
  }
}
