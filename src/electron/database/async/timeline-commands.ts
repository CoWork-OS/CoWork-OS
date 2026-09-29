import type Database from "better-sqlite3";
import { SessionProgressService } from "../../sessions/SessionProgressService";
import {
  drainTimelineProjectionOutbox,
  skipTimelineProjectionOutboxHead,
  type TimelineOutboxDrainResult,
} from "../../sessions/timeline-projection";
import { WorkSessionContractService } from "../../sessions/WorkSessionContractService";
import { WorkSessionProtocolService } from "../../sessions/WorkSessionProtocolService";
import { InvalidCommandArgumentsError } from "./command-errors";
import { ActivityStore } from "../../activity/ActivityRepository";
import type { Activity } from "../../../shared/types";
import { insertLlmCallRow, type LlmCallRow } from "../llm-call-events";
import { TaskEventRepository } from "../repositories";
import { TimelineProjectionOutboxRepository } from "../TimelineProjectionOutboxRepository";
import { applyMigratedEventParams, type MigratedEventParams } from "../migrated-event-sql";

/**
 * Timeline projection commands for the database worker (async SQLite migration plan,
 * DB3). The worker keeps one set of WorkSession services per connection; their lease
 * tokens live here, so lease upkeep runs here too, triggered by the host on a timer.
 */

interface WorkerTimelineServices {
  protocol: WorkSessionProtocolService;
  contracts: WorkSessionContractService;
  progress: SessionProgressService;
}

const servicesByConnection = new WeakMap<Database.Database, WorkerTimelineServices>();

function servicesFor(db: Database.Database): WorkerTimelineServices {
  let services = servicesByConnection.get(db);
  if (!services) {
    const protocol = new WorkSessionProtocolService(db);
    services = {
      protocol,
      contracts: new WorkSessionContractService(db, protocol),
      progress: new SessionProgressService(db),
    };
    servicesByConnection.set(db, services);
  }
  return services;
}

export const MAX_TIMELINE_DRAIN_BATCH = 256;
export const MAX_TIMELINE_WRITE_OPS = 1_024;
/** One task's converted legacy rows are written in one command, so a task is never half converted. */
export const MAX_MIGRATED_EVENT_ROWS = 200_000;

function requireMigratedRows(value: unknown): MigratedEventParams[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MIGRATED_EVENT_ROWS) {
    throw new InvalidCommandArgumentsError(
      `rows must be a non-empty array of at most ${MAX_MIGRATED_EVENT_ROWS} rows`,
    );
  }
  for (const row of value) {
    if (
      !Array.isArray(row) ||
      row.length !== 11 ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "string" ||
      typeof row[10] !== "string"
    ) {
      throw new InvalidCommandArgumentsError("each row must be an 11-value migrated event");
    }
  }
  return value as MigratedEventParams[];
}

/**
 * Rows the host accepted for the timeline domain. Every insert is keyed by an id the
 * host generated and ignored if present, so a batch may be applied more than once (a
 * retry after an unknown outcome, or after the host committed it itself).
 */
export type TimelineWriteOp =
  | { kind: "taskEvent"; eventId: string; taskId: string; params: unknown[] }
  | { kind: "activity"; activity: Activity }
  | { kind: "llmCall"; row: LlmCallRow };

/** Apply ops in order; an event's outbox row is written only by the insert that took effect. */
export function applyTimelineWrites(
  db: Database.Database,
  ops: readonly TimelineWriteOp[],
): { insertedEventIds: string[] } {
  const events = new TaskEventRepository(db);
  const outbox = new TimelineProjectionOutboxRepository(db);
  const activities = new ActivityStore(db);
  const insertedEventIds: string[] = [];
  for (const op of ops) {
    if (op.kind === "taskEvent") {
      if (events.insertParamsIfAbsent(op.params, op.taskId)) {
        outbox.enqueue(op.eventId, op.taskId);
        insertedEventIds.push(op.eventId);
      }
    } else if (op.kind === "activity") {
      activities.insertIfAbsent(op.activity);
    } else {
      insertLlmCallRow(db, op.row);
    }
  }
  return { insertedEventIds };
}

export const TIMELINE_COMMANDS = {
  /** Write back one task's legacy events converted on a host read (DB4). Idempotent. */
  "timeline.persistMigratedEvents": {
    kind: "write",
    tables: ["task_events"],
    run(
      db: Database.Database,
      args: { taskId: string; rows: MigratedEventParams[] },
    ): {
      updated: number;
    } {
      if (typeof args?.taskId !== "string" || !args.taskId) {
        throw new InvalidCommandArgumentsError("taskId must be a non-empty string");
      }
      const rows = requireMigratedRows(args.rows);
      applyMigratedEventParams(db, rows);
      return { updated: rows.length };
    },
  },
  /** Insert accepted timeline rows (events with their outbox rows, activity, usage). */
  "timeline.applyWrites": {
    kind: "write",
    tables: ["task_events", "timeline_projection_outbox", "activity_feed", "llm_call_events"],
    run(db: Database.Database, args: { ops: TimelineWriteOp[] }): { insertedEventIds: string[] } {
      const ops = args?.ops;
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_TIMELINE_WRITE_OPS) {
        throw new InvalidCommandArgumentsError(
          `ops must be a non-empty array of at most ${MAX_TIMELINE_WRITE_OPS} writes`,
        );
      }
      return applyTimelineWrites(db, ops);
    },
  },
  /** Project the oldest outbox entries and delete them in the same transaction. */
  "timeline.drainProjectionOutbox": {
    kind: "write",
    tables: ["timeline_projection_outbox", "task_events", "tasks", "work_sessions"],
    run(
      db: Database.Database,
      args: { limit: number; budgetMs?: number },
    ): TimelineOutboxDrainResult {
      const limit = Math.floor(Number(args?.limit));
      if (!Number.isFinite(limit) || limit < 1 || limit > MAX_TIMELINE_DRAIN_BATCH) {
        throw new InvalidCommandArgumentsError(
          `limit must be between 1 and ${MAX_TIMELINE_DRAIN_BATCH}`,
        );
      }
      const budgetMs =
        args?.budgetMs === undefined ? Number.POSITIVE_INFINITY : Number(args.budgetMs);
      if (!(budgetMs > 0)) throw new InvalidCommandArgumentsError("budgetMs must be positive");
      return drainTimelineProjectionOutbox(db, servicesFor(db), limit, budgetMs);
    },
  },
  /** Drop the head entry after it has aborted its transaction repeatedly. */
  "timeline.skipProjectionOutboxHead": {
    kind: "write",
    tables: ["timeline_projection_outbox"],
    run(db: Database.Database): { eventId: string; taskId: string } | null {
      return skipTimelineProjectionOutboxHead(db);
    },
  },
  /** Expire stale activity leases and renew the ones this worker holds. */
  "timeline.maintainLeases": {
    kind: "write",
    tables: ["work_session_activity_leases"],
    run(db: Database.Database): { ok: true } {
      servicesFor(db).protocol.getReliabilityService().maintainLeases();
      return { ok: true };
    },
  },
} as const;
