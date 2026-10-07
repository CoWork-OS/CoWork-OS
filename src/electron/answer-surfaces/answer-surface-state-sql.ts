import type Database from "better-sqlite3";

/**
 * Saved control values for interactive answer surfaces, one row per surface. A surface is
 * identified by its task and a content-derived key (see `answerSurfaceKey`), so the state
 * follows the answer wherever it is shown. `reported_at` records when the latest change
 * was passed to the model, so each change is reported once.
 */
export const ANSWER_SURFACE_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS answer_surface_state (
    task_id TEXT NOT NULL,
    surface_key TEXT NOT NULL,
    state_json TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    reported_at INTEGER,
    PRIMARY KEY (task_id, surface_key)
  );
`;

export const MAX_ANSWER_SURFACE_STATE_BYTES = 32 * 1024;
export const MAX_ANSWER_SURFACE_SUMMARY_CHARS = 2000;

export type AnswerSurfaceStateRow = {
  key: string;
  state: Record<string, unknown>;
  updatedAt: number;
};
export type AnswerSurfaceChange = { key: string; summary: string; updatedAt: number };

interface Row {
  surface_key: string;
  state_json: string;
  summary: string;
  updated_at: number;
}

function parseState(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Deletes a task's saved answer state inside the task-delete transaction. The table is
 * created at startup; it is ensured here too for a profile last opened by an older build.
 */
export function deleteAnswerSurfaceStateForTask(db: Database.Database, taskId: string): void {
  db.exec(ANSWER_SURFACE_STATE_SCHEMA);
  db.prepare("DELETE FROM answer_surface_state WHERE task_id = ?").run(taskId);
}

export class AnswerSurfaceStateSqlStore {
  constructor(private readonly db: Database.Database) {}

  get(taskId: string, keys: string[]): AnswerSurfaceStateRow[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT surface_key, state_json, summary, updated_at FROM answer_surface_state
         WHERE task_id = ? AND surface_key IN (${placeholders})`,
      )
      .all(taskId, ...keys) as Row[];
    return rows.map((row) => ({
      key: row.surface_key,
      state: parseState(row.state_json),
      updatedAt: row.updated_at,
    }));
  }

  upsert(taskId: string, key: string, stateJson: string, summary: string, now: number): void {
    if (stateJson.length > MAX_ANSWER_SURFACE_STATE_BYTES) {
      throw new Error("Answer surface state is too large");
    }
    this.db
      .prepare(
        `INSERT INTO answer_surface_state (task_id, surface_key, state_json, summary, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, surface_key) DO UPDATE SET
           state_json = excluded.state_json,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, key, stateJson, summary.slice(0, MAX_ANSWER_SURFACE_SUMMARY_CHARS), now);
  }

  /** Changes the model has not seen yet, oldest first. */
  listUnreported(taskId: string): AnswerSurfaceChange[] {
    const rows = this.db
      .prepare(
        `SELECT surface_key, state_json, summary, updated_at FROM answer_surface_state
         WHERE task_id = ? AND summary != '' AND (reported_at IS NULL OR reported_at < updated_at)
         ORDER BY updated_at ASC LIMIT 20`,
      )
      .all(taskId) as Row[];
    return rows.map((row) => ({
      key: row.surface_key,
      summary: row.summary,
      updatedAt: row.updated_at,
    }));
  }

  markReported(taskId: string, keys: string[], now: number): void {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE answer_surface_state SET reported_at = ?
         WHERE task_id = ? AND surface_key IN (${placeholders})`,
      )
      .run(now, taskId, ...keys);
  }

  deleteForTask(taskId: string): void {
    this.db.prepare("DELETE FROM answer_surface_state WHERE task_id = ?").run(taskId);
  }
}
