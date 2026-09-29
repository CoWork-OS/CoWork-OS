import type Database from "better-sqlite3";
import type { Activity } from "../../shared/types";

/**
 * Timeline rows accepted on the host but not yet committed by the database worker
 * (async SQLite migration plan, DB3). Repositories call these hooks before reading or
 * writing the affected rows, which commits the pending rows on the host connection
 * first; the inserts are idempotent, so the worker later skips them. With no writer
 * registered (the default host backend) every hook is a no-op. Deferred legacy-event
 * migrations (DB4) register through the same hooks.
 */
export interface PendingTimelineWrites {
  /**
   * The task's accepted event rows that are not committed yet, in the stored row shape
   * (DB6). Reads merge these instead of committing them on the host first.
   */
  pendingTaskEventRows?(taskId: string): Array<Record<string, unknown>>;
  /** Accepted activity rows not committed yet, for activity-feed reads (DB6). */
  pendingActivities?(): Activity[];
  /** Resolve once every task event row accepted so far is committed (DB6). */
  allCommitted?(): Promise<void>;
  flushTask(taskId: string): void;
  flushEvent(eventId: string): void;
  flushActivities(): void;
  flushAll(): void;
}

const writersByConnection = new Map<Database.Database, Set<PendingTimelineWrites>>();

export function registerPendingTimelineWrites(
  db: Database.Database,
  writes: PendingTimelineWrites,
): () => void {
  let writers = writersByConnection.get(db);
  if (!writers) {
    writers = new Set();
    writersByConnection.set(db, writers);
  }
  writers.add(writes);
  return () => {
    const current = writersByConnection.get(db);
    current?.delete(writes);
    if (current?.size === 0) writersByConnection.delete(db);
  };
}

function each(db: Database.Database, apply: (writes: PendingTimelineWrites) => void): void {
  const writers = writersByConnection.get(db);
  if (writers) for (const writes of writers) apply(writes);
}

export function flushPendingTimelineTask(db: Database.Database, taskId: string): void {
  if (taskId) each(db, (writes) => writes.flushTask(taskId));
}

/** Accepted, uncommitted event rows of a task across registered writers (DB6). */
export function pendingTimelineTaskRows(
  db: Database.Database,
  taskId: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  if (taskId) each(db, (writes) => rows.push(...(writes.pendingTaskEventRows?.(taskId) ?? [])));
  return rows;
}

/** Accepted, uncommitted activity rows across registered writers (DB6). */
export function pendingTimelineActivities(db: Database.Database): Activity[] {
  const rows: Activity[] = [];
  each(db, (writes) => rows.push(...(writes.pendingActivities?.() ?? [])));
  return rows;
}

export function flushPendingTimelineEvent(db: Database.Database, eventId: string): void {
  if (eventId) each(db, (writes) => writes.flushEvent(eventId));
}

export function flushPendingTimelineActivities(db: Database.Database): void {
  each(db, (writes) => writes.flushActivities());
}

export function flushAllPendingTimelineWrites(db: Database.Database): void {
  each(db, (writes) => writes.flushAll());
}

/**
 * Resolve once the task event rows every registered writer has accepted are committed,
 * without committing them on the host (DB6). For readers that scan events across tasks.
 */
export function pendingTimelineWritesCommitted(db: Database.Database): Promise<void> {
  const waits: Array<Promise<void>> = [];
  each(db, (writes) => {
    if (writes.allCommitted) waits.push(writes.allCommitted());
  });
  return Promise.all(waits).then(() => undefined);
}
