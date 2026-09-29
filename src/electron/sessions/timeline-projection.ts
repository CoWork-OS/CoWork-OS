import type Database from "better-sqlite3";
import { performance } from "perf_hooks";
import type { TaskEvent } from "../../shared/types";
import { TaskEventRepository, withTaskRowReadScope } from "../database/repositories";
import { TimelineProjectionOutboxRepository } from "../database/TimelineProjectionOutboxRepository";
import type { SessionProgressService } from "./SessionProgressService";
import type { WorkSessionContractService } from "./WorkSessionContractService";
import type { WorkSessionProtocolService } from "./WorkSessionProtocolService";

/**
 * The derived WorkSession state written for each persisted timeline event: protocol
 * items, contract/evidence records, and session progress. Shared by the host (inline,
 * or when draining the outbox without a worker) and the database worker (DB3), so both
 * run exactly the same projections with the same best-effort semantics.
 */

export type TimelineProjectionName = "protocol" | "contracts" | "progress";

export interface TimelineProjectionServices {
  protocol?: Pick<WorkSessionProtocolService, "recordTaskEvent">;
  contracts?: Pick<WorkSessionContractService, "recordTaskEvent">;
  progress?: Pick<SessionProgressService, "updateFromEvent"> &
    Partial<Pick<SessionProgressService, "rebuild" | "isStructuralEvent">>;
}

export interface TimelineProjectionFailure {
  eventId: string;
  taskId: string;
  projection: TimelineProjectionName;
  message: string;
  /** The original error; survives structured clone from the worker. */
  error?: unknown;
}

/** Thrown when a projection error rolled back the enclosing transaction. */
export class TimelineProjectionAbortedError extends Error {
  constructor(
    readonly eventId: string,
    cause: unknown,
  ) {
    super(
      `Projection of event ${eventId} aborted the transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TimelineProjectionAbortedError";
  }
}

/**
 * Run each projection for one stored event. A failing projection is reported and the
 * rest still run, as before: projections are additive and must never fail the event.
 */
export function projectTimelineEvent(
  services: TimelineProjectionServices,
  event: TaskEvent,
  db?: Database.Database,
): TimelineProjectionFailure[] {
  const failures: TimelineProjectionFailure[] = [];
  const run = (projection: TimelineProjectionName, apply: () => void) => {
    try {
      apply();
    } catch (error) {
      if (db && !db.inTransaction) throw new TimelineProjectionAbortedError(event.id, error);
      failures.push({
        eventId: event.id,
        taskId: event.taskId,
        projection,
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    }
  };
  run("protocol", () => services.protocol?.recordTaskEvent(event.taskId, event));
  run("contracts", () => services.contracts?.recordTaskEvent(event.taskId, event));
  run("progress", () => {
    if (!services.progress) throw new Error("Session progress service is not available");
    services.progress.updateFromEvent(event);
  });
  return failures;
}

export interface TimelineOutboxDrainResult {
  processed: Array<{ eventId: string; taskId: string }>;
  failures: TimelineProjectionFailure[];
  /** True when the outbox had fewer than `limit` entries and all were processed. */
  exhausted: boolean;
}

/**
 * Project up to `limit` outbox entries, oldest first, deleting each entry with its
 * projection writes. Must run inside a write transaction; entries whose event no longer
 * exists (the task was deleted) are dropped. With `budgetMs`, it stops after the entry
 * that crosses the budget, which bounds how long the transaction holds the write lock.
 */
export function drainTimelineProjectionOutbox(
  db: Database.Database,
  services: TimelineProjectionServices,
  limit: number,
  budgetMs = Number.POSITIVE_INFINITY,
): TimelineOutboxDrainResult {
  if (!db.inTransaction) throw new Error("drainTimelineProjectionOutbox needs a transaction");
  const outbox = new TimelineProjectionOutboxRepository(db);
  const events = new TaskEventRepository(db);
  const result: TimelineOutboxDrainResult = { processed: [], failures: [], exhausted: false };
  const startedAt = performance.now();
  const batch = outbox.listBatch(limit);
  // Progress state is rebuilt from the whole history, and nothing observes it between
  // events of one transaction, so rebuild once per task at the end of the batch.
  const progress = services.progress;
  const coalesce = Boolean(progress?.rebuild && progress.isStructuralEvent);
  const progressDue = new Map<string, TaskEvent>();
  const batchServices: TimelineProjectionServices = coalesce
    ? {
        ...services,
        progress: {
          updateFromEvent: (event) => {
            if (progress!.isStructuralEvent!(event)) progressDue.set(event.taskId, event);
            return undefined;
          },
        },
      }
    : services;
  for (const entry of batch) {
    const event = events.findById(entry.eventId);
    // One task-row read scope per event, as `logEvent` uses on the host.
    if (event) {
      result.failures.push(
        ...withTaskRowReadScope(() => projectTimelineEvent(batchServices, event, db)),
      );
    }
    outbox.remove(entry.eventId);
    result.processed.push(entry);
    if (performance.now() - startedAt >= budgetMs) break;
  }
  for (const [taskId, event] of progressDue) {
    try {
      withTaskRowReadScope(() => progress!.rebuild!(taskId));
    } catch (error) {
      if (!db.inTransaction) throw new TimelineProjectionAbortedError(event.id, error);
      result.failures.push({
        eventId: event.id,
        taskId,
        projection: "progress",
        message: error instanceof Error ? error.message : String(error),
        error,
      });
    }
  }
  result.exhausted = result.processed.length === batch.length && batch.length < limit;
  return result;
}

/** Drop the oldest outbox entry without projecting it; used after it aborts repeatedly. */
export function skipTimelineProjectionOutboxHead(
  db: Database.Database,
): { eventId: string; taskId: string } | null {
  const outbox = new TimelineProjectionOutboxRepository(db);
  const [head] = outbox.listBatch(1);
  if (!head) return null;
  outbox.remove(head.eventId);
  return head;
}
