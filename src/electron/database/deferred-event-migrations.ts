import type Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";
import { applyMigratedEventParams, type MigratedEventParams } from "./migrated-event-sql";

const logger = createLogger("DeferredEventMigrations");

/** Writes one task's converted rows elsewhere (the database worker); resolves on commit. */
export type DeferredMigrationExecutor = (
  taskId: string,
  rows: MigratedEventParams[],
) => Promise<void>;

const executorsByPath = new Map<string, DeferredMigrationExecutor>();

const normalizePath = (dbPath: string) => path.resolve(dbPath);

/**
 * Route deferred migration writes for connections to the database file `dbPath` to
 * another connection, typically the database worker. A `null` executor restores host
 * writes for that file; a `null` path clears every route.
 */
export function setDeferredMigrationExecutor(
  dbPath: string | null,
  executor: DeferredMigrationExecutor | null,
): void {
  if (dbPath === null) executorsByPath.clear();
  else if (executor) executorsByPath.set(normalizePath(dbPath), executor);
  else executorsByPath.delete(normalizePath(dbPath));
}

function executorFor(db: Database.Database): DeferredMigrationExecutor | undefined {
  if (executorsByPath.size === 0 || db.memory) return undefined;
  return executorsByPath.get(normalizePath(db.name));
}

/**
 * Legacy task events are converted to the v2 timeline shape when read. The conversion is
 * deterministic, so the read returns the converted events at once and this queue writes
 * them back afterwards (async SQLite migration plan, DB4); before, the whole write-back
 * ran inside the read, about 280 ms for a 15,000-event session.
 *
 * Each task is written in one transaction, so a task's rows are never half converted:
 * page ordering uses `COALESCE(seq, timestamp)`, and a mix of converted and legacy rows
 * would interleave wrongly. With an executor (the database worker) the write runs off
 * the host; otherwise one task per event-loop turn runs on the host.
 *
 * Reads do not wait: until the write lands they convert the legacy rows again, with the
 * same result. SQL that depends on the converted columns (the next `seq`) calls
 * `flushTask`, which writes the task's rows on the host at once; the writes are
 * idempotent, so a worker write in flight may land a second time. A lost write
 * (shutdown, a failed write) only means the next read converts the rows again.
 */
export class DeferredEventMigrations {
  private readonly pending = new Map<string, Map<string, MigratedEventParams>>();
  private scheduled = false;

  constructor(private readonly db: Database.Database) {}

  pendingCount(): number {
    let count = 0;
    for (const rows of this.pending.values()) count += rows.size;
    return count;
  }

  add(taskId: string, rows: MigratedEventParams[]): void {
    let task = this.pending.get(taskId);
    if (!task) {
      task = new Map();
      this.pending.set(taskId, task);
    }
    for (const row of rows) task.set(row[10], row);
    this.schedule();
  }

  /** Write the task's pending rows on the host now. */
  flushTask(taskId: string): void {
    const rows = this.take(taskId);
    if (rows) this.writeOnHost(taskId, rows);
  }

  private take(taskId: string): MigratedEventParams[] | null {
    const task = this.pending.get(taskId);
    if (!task) return null;
    this.pending.delete(taskId);
    return [...task.values()];
  }

  private schedule(): void {
    if (this.scheduled || this.pending.size === 0) return;
    this.scheduled = true;
    const timer = setImmediate(() => void this.drainOne());
    timer.unref?.();
  }

  private async drainOne(): Promise<void> {
    const taskId = this.pending.keys().next().value as string | undefined;
    const rows = taskId === undefined ? null : this.take(taskId);
    if (taskId !== undefined && rows) {
      const executor = executorFor(this.db);
      if (executor) {
        try {
          await executor(taskId, rows);
        } catch (error) {
          logger.warn(
            `Could not write converted events for task ${taskId}; they convert again on read:`,
            error,
          );
        }
      } else {
        this.writeOnHost(taskId, rows);
      }
    }
    this.scheduled = false;
    this.schedule();
  }

  private writeOnHost(taskId: string, rows: MigratedEventParams[]): void {
    try {
      this.db.transaction(() => applyMigratedEventParams(this.db, rows))();
    } catch (error) {
      logger.warn(
        `Could not write converted events for task ${taskId}; they convert again on read:`,
        error,
      );
    }
  }
}
