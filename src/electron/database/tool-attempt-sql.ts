import type Database from "better-sqlite3";
import type { ToolAttempt, ToolAttemptEffect, ToolAttemptStatus } from "../../shared/types";

/**
 * Durable tool attempts (agent-first roadmap WP4): one row per dispatched call of a tool that
 * writes or whose effect is unknown, written before dispatch and finished after it. A row left
 * `started` by a crash, a timeout or a stop becomes `unknown`: the call may or may not have had
 * its effect. Runs only as storage-domain units behind `ToolAttemptRepository`.
 */
export interface ToolAttemptBeginInput {
  id: string;
  taskId: string;
  stepId?: string;
  toolName: string;
  argsHash: string;
  idempotencyKey: string;
  effect: Exclude<ToolAttemptEffect, "read">;
  target?: string;
  startedAt: number;
}

const MAX_LIST = 500;
const MAX_TEXT = 1_000;

type Row = Record<string, unknown>;

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapRow(row: Row): ToolAttempt {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ...(optionalText(row.step_id) ? { stepId: String(row.step_id) } : {}),
    toolName: String(row.tool_name),
    argsHash: String(row.args_hash),
    idempotencyKey: String(row.idempotency_key),
    effect: String(row.effect) as ToolAttempt["effect"],
    ...(optionalText(row.target) ? { target: String(row.target) } : {}),
    status: String(row.status) as ToolAttemptStatus,
    ...(optionalText(row.reason) ? { reason: String(row.reason) } : {}),
    startedAt: Number(row.started_at),
    ...(typeof row.finished_at === "number" ? { finishedAt: row.finished_at } : {}),
  };
}

export class ToolAttemptStore {
  constructor(private readonly db: Database.Database) {}

  begin(input: ToolAttemptBeginInput): ToolAttempt {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_attempts
           (id, task_id, step_id, tool_name, args_hash, idempotency_key, effect, target, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
      )
      .run(
        input.id,
        input.taskId,
        input.stepId ?? null,
        input.toolName.slice(0, 200),
        input.argsHash,
        input.idempotencyKey,
        input.effect,
        input.target ? input.target.slice(0, MAX_TEXT) : null,
        input.startedAt,
      );
    return mapRow(this.db.prepare("SELECT * FROM tool_attempts WHERE id = ?").get(input.id) as Row);
  }

  /**
   * Record how a call ended. A later definite result replaces `unknown` (a late completion is
   * more accurate than the guess made at a timeout or stop); a finished row is not reopened.
   */
  finish(
    id: string,
    status: Exclude<ToolAttemptStatus, "started">,
    finishedAt: number,
    reason?: string,
  ): ToolAttempt | undefined {
    this.db
      .prepare(
        `UPDATE tool_attempts
            SET status = ?, reason = ?, finished_at = ?
          WHERE id = ? AND status IN ('started', 'unknown')`,
      )
      .run(status, reason ? reason.slice(0, MAX_TEXT) : null, finishedAt, id);
    const row = this.db.prepare("SELECT * FROM tool_attempts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** The task's most recent attempts, oldest first. */
  listForTask(taskId: string, limit = MAX_LIST): ToolAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_attempts WHERE task_id = ?
          ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(taskId, Math.min(MAX_LIST, Math.max(1, Math.floor(limit)))) as Row[];
    return rows.map(mapRow).reverse();
  }

  /** A stopped task's calls that never finished: their outcome is now unknown. */
  markStartedUnknown(taskId: string, reason: string, finishedAt: number): ToolAttempt[] {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM tool_attempts WHERE task_id = ? AND status = 'started' LIMIT ${MAX_LIST}`,
        )
        .all(taskId) as Row[]
    ).map((row) => String(row.id));
    const update = this.db.prepare(
      `UPDATE tool_attempts SET status = 'unknown', reason = ?, finished_at = ?
        WHERE id = ? AND status = 'started'`,
    );
    for (const id of ids) update.run(reason.slice(0, MAX_TEXT), finishedAt, id);
    return ids.flatMap((id) => {
      const row = this.db.prepare("SELECT * FROM tool_attempts WHERE id = ?").get(id) as
        | Row
        | undefined;
      return row ? [mapRow(row)] : [];
    });
  }

  /**
   * Startup recovery: calls left `started` by a previous process for tasks that are not
   * running now become `unknown`. Bounded per call; returns the affected task ids, and the
   * caller repeats until it returns none.
   */
  recoverStartedAttempts(runningTaskIds: string[], finishedAt: number): string[] {
    const exclude = runningTaskIds.slice(0, 200);
    const placeholders = exclude.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, task_id FROM tool_attempts
          WHERE status = 'started'
            ${exclude.length > 0 ? `AND task_id NOT IN (${placeholders})` : ""}
          LIMIT ${MAX_LIST}`,
      )
      .all(...exclude) as Row[];
    const update = this.db.prepare(
      `UPDATE tool_attempts SET status = 'unknown', reason = 'process_restarted', finished_at = ?
        WHERE id = ? AND status = 'started'`,
    );
    for (const row of rows) update.run(finishedAt, String(row.id));
    return [...new Set(rows.map((row) => String(row.task_id)))];
  }
}
