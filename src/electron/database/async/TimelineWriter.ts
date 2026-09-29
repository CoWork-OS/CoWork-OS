import type Database from "better-sqlite3";
import { createLogger } from "../../utils/logger";
import type { Activity } from "../../../shared/types";
import type { LlmCallRow } from "../llm-call-events";
import { TASK_EVENT_COLUMN_NAMES, type PreparedTaskEvent } from "../repositories";
import {
  type PendingTimelineWrites,
  registerPendingTimelineWrites,
} from "../timeline-write-registry";
import type { DatabaseClient } from "./DatabaseClient";
import {
  applyTimelineWrites,
  MAX_TIMELINE_WRITE_OPS,
  type TimelineWriteOp,
} from "./timeline-commands";

const logger = createLogger("TimelineWriter");

export interface TimelineWriterOptions {
  /** Called with the ids of events that became durable, whichever side inserted them. */
  onEventsCommitted?: (eventIds: string[]) => void;
  maxBatchOps?: number;
  maxBatchBytes?: number;
  /** Backpressure: past either mark the host commits the whole backlog itself. */
  highWaterOps?: number;
  highWaterBytes?: number;
}

interface PendingOp {
  order: number;
  op: TimelineWriteOp;
  bytes: number;
  state: "queued" | "sent";
  afterCommit?: () => void;
}

const DEFAULTS = {
  maxBatchOps: 256,
  maxBatchBytes: 2 * 1024 * 1024,
  highWaterOps: 2_000,
  highWaterBytes: 32 * 1024 * 1024,
};
const RETRY_BASE_DELAY_MS = 50;
const RETRY_MAX_DELAY_MS = 2_000;

function opBytes(op: TimelineWriteOp): number {
  if (op.kind === "taskEvent") {
    return op.params.reduce<number>(
      (total, value) => total + (typeof value === "string" ? value.length : 8),
      0,
    );
  }
  return JSON.stringify(op.kind === "activity" ? op.activity : op.row.params).length;
}

/**
 * Host side of timeline writes in the database worker (async SQLite migration plan,
 * DB3). The host accepts events, activity rows, and usage rows in order and the worker
 * inserts them in batches, off the host thread.
 *
 * Reads never observe a gap: before any repository read or write of a task's events
 * (or of the activity feed) the pending rows are committed on the host first ("flush
 * through"). The same happens when the worker is not ready, and when the backlog
 * passes the high-water mark, which is how backpressure reaches producers. Milestone
 * events (lifecycle, approval, input and the like) go to the worker like every other row
 * (DB6 slice C2): callers that must not proceed before one is durable await
 * `committed(taskId)`, which waits without blocking the host thread, so another process's
 * write lock no longer stalls it. Every insert is idempotent, so the worker skips rows the host
 * already committed, and each row's post-commit effect runs once.
 *
 * What remains weaker than a synchronous insert, accepted in DB6: a process crash (not a
 * shutdown, which commits everything) loses accepted non-milestone rows that neither side
 * committed yet. That is normally the batch in flight (`maxBatchOps`); it can reach the
 * high-water mark (`highWaterOps` rows or `highWaterBytes`) when the worker falls behind,
 * after which the host commits new rows itself. Milestones never fall in this window, and
 * an interrupted task resumes from the rows that were committed.
 */
export class TimelineWriter implements PendingTimelineWrites {
  private readonly options: typeof DEFAULTS & Pick<TimelineWriterOptions, "onEventsCommitted">;
  private readonly pending = new Map<number, PendingOp>();
  private readonly eventOps = new Map<string, PendingOp>();
  private readonly taskEventOrders = new Map<string, Set<number>>();
  private readonly unregister: () => void;
  private nextOrder = 1;
  private pendingBytes = 0;
  private sendScheduled = false;
  private sending = false;
  private stopped = false;
  private committingOnHost = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_BASE_DELAY_MS;
  private degradedLogged = false;
  private readonly taskWaiters = new Map<string, Set<{ upTo: number; resolve: () => void }>>();

  constructor(
    private readonly db: Database.Database,
    private readonly client: DatabaseClient,
    options: TimelineWriterOptions = {},
  ) {
    this.options = {
      ...DEFAULTS,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    } as typeof this.options;
    this.options.maxBatchOps = Math.min(MAX_TIMELINE_WRITE_OPS, this.options.maxBatchOps);
    this.unregister = registerPendingTimelineWrites(db, this);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  enqueueTaskEvent(prepared: PreparedTaskEvent, options: { afterCommit?: () => void } = {}): void {
    const { id: eventId, taskId } = prepared.stored;
    const pendingOp = this.add(
      { kind: "taskEvent", eventId, taskId, params: prepared.params },
      options.afterCommit,
    );
    this.eventOps.set(eventId, pendingOp);
    let orders = this.taskEventOrders.get(taskId);
    if (!orders) {
      orders = new Set();
      this.taskEventOrders.set(taskId, orders);
    }
    orders.add(pendingOp.order);
    this.afterEnqueue();
  }

  enqueueActivity(activity: Activity): void {
    this.add({ kind: "activity", activity });
    this.afterEnqueue();
  }

  enqueueLlmCall(row: LlmCallRow, afterCommit?: () => void): void {
    this.add({ kind: "llmCall", row }, afterCommit);
    this.afterEnqueue();
  }

  /**
   * Resolve once the task's rows accepted so far are committed by either side. Async
   * readers and milestone boundaries use this instead of the synchronous flush-through,
   * so they do not write on the host. Every `timeoutMs` without a commit the host takes
   * the rows only if the worker is no longer ready; a ready worker that is merely slow
   * (for example waiting on another process's write lock) keeps them, because committing
   * on the host would block this thread on the same lock.
   */
  committed(taskId: string, timeoutMs = 5_000): Promise<void> {
    const orders = this.taskEventOrders.get(taskId);
    if (!orders?.size) return Promise.resolve();
    let upTo = 0;
    for (const order of orders) upTo = Math.max(upTo, order);
    return new Promise<void>((resolve) => {
      let waiters = this.taskWaiters.get(taskId);
      if (!waiters) {
        waiters = new Set();
        this.taskWaiters.set(taskId, waiters);
      }
      const waiter = {
        upTo,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const onTimeout = () => {
        if (!this.stopped && this.client.getState() === "ready") {
          timer = setTimeout(onTimeout, timeoutMs);
          return;
        }
        waiters!.delete(waiter);
        try {
          this.flushTask(taskId);
        } catch (error) {
          logger.warn(`Could not commit pending rows for task ${taskId}:`, error);
        }
        resolve();
      };
      let timer = setTimeout(onTimeout, timeoutMs);
      waiters.add(waiter);
    });
  }

  /** Resolve once every task's rows accepted so far are committed (see `committed`). */
  allCommitted(timeoutMs = 5_000): Promise<void> {
    return Promise.all(
      [...this.taskEventOrders.keys()].map((taskId) => this.committed(taskId, timeoutMs)),
    ).then(() => undefined);
  }

  pendingActivities(): Activity[] {
    const activities: Activity[] = [];
    for (const entry of this.pending.values()) {
      if (entry.op.kind === "activity") activities.push(entry.op.activity);
    }
    return activities;
  }

  pendingTaskEventRows(taskId: string): Array<Record<string, unknown>> {
    const orders = this.taskEventOrders.get(taskId);
    if (!orders || orders.size === 0) return [];
    const rows: Array<Record<string, unknown>> = [];
    for (const order of orders) {
      const entry = this.pending.get(order);
      if (entry?.op.kind !== "taskEvent") continue;
      const params = entry.op.params;
      const row: Record<string, unknown> = {};
      TASK_EVENT_COLUMN_NAMES.forEach((column, index) => {
        row[column] = params[index];
      });
      rows.push(row);
    }
    return rows;
  }

  flushTask(taskId: string): void {
    const orders = this.taskEventOrders.get(taskId);
    if (!orders || orders.size === 0) return;
    this.commitOnHost([...orders].map((order) => this.pending.get(order)!).filter(Boolean));
  }

  flushEvent(eventId: string): void {
    const pendingOp = this.eventOps.get(eventId);
    if (pendingOp?.op.kind === "taskEvent") this.flushTask(pendingOp.op.taskId);
  }

  flushActivities(): void {
    const activities = [...this.pending.values()].filter((entry) => entry.op.kind === "activity");
    this.commitOnHost(activities);
  }

  flushAll(): void {
    this.commitOnHost([...this.pending.values()]);
  }

  /**
   * Stop sending and commit anything left on the host, so shutdown loses nothing.
   * Waits briefly for an in-flight batch first; its rows are idempotent either way.
   */
  async stop(timeoutMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const deadline = Date.now() + timeoutMs;
    while (this.sending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      this.flushAll();
    } catch (error) {
      logger.error("Could not commit pending timeline rows at shutdown:", error);
    }
    this.unregister();
  }

  private add(op: TimelineWriteOp, afterCommit?: () => void): PendingOp {
    const pendingOp: PendingOp = {
      order: this.nextOrder++,
      op,
      bytes: opBytes(op),
      state: "queued",
      afterCommit,
    };
    this.pending.set(pendingOp.order, pendingOp);
    this.pendingBytes += pendingOp.bytes;
    return pendingOp;
  }

  private afterEnqueue(): void {
    if (this.stopped || this.client.getState() !== "ready") {
      // Degraded: the worker is restarting, failed, or closed. Rows must not wait in
      // memory for it, so the host backend takes them for now.
      if (!this.degradedLogged && !this.stopped) {
        this.degradedLogged = true;
        logger.warn(
          `Database worker is ${this.client.getState()}; committing timeline rows on the host`,
        );
      }
      this.flushAll();
      return;
    }
    this.degradedLogged = false;
    if (
      this.pending.size > this.options.highWaterOps ||
      this.pendingBytes > this.options.highWaterBytes
    ) {
      this.flushAll();
      return;
    }
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.sendScheduled || this.sending || this.retryTimer || this.stopped) return;
    this.sendScheduled = true;
    setImmediate(() => {
      this.sendScheduled = false;
      void this.send();
    });
  }

  private async send(): Promise<void> {
    if (this.sending || this.stopped) return;
    const batch: PendingOp[] = [];
    let bytes = 0;
    for (const entry of this.pending.values()) {
      if (entry.state !== "queued") continue;
      if (
        batch.length > 0 &&
        (batch.length >= this.options.maxBatchOps ||
          bytes + entry.bytes > this.options.maxBatchBytes)
      ) {
        break;
      }
      batch.push(entry);
      bytes += entry.bytes;
    }
    if (batch.length === 0) return;
    this.sending = true;
    for (const entry of batch) entry.state = "sent";
    try {
      const result = await this.client.execute("timeline.applyWrites", {
        ops: batch.map((entry) => entry.op),
      });
      this.retryDelayMs = RETRY_BASE_DELAY_MS;
      for (const entry of batch) this.complete(entry);
      if (result.insertedEventIds.length > 0) {
        this.options.onEventsCommitted?.(result.insertedEventIds);
      }
    } catch (error) {
      // Nothing is lost: the rows stay pending (and visible to reads through
      // flush-through). Retrying is safe because every insert is idempotent.
      for (const entry of batch) {
        if (this.pending.get(entry.order) === entry) entry.state = "queued";
      }
      logger.warn("Timeline write batch failed; retrying:", error);
      this.scheduleRetry();
    } finally {
      this.sending = false;
    }
    if (!this.stopped && [...this.pending.values()].some((entry) => entry.state === "queued")) {
      if (this.client.getState() !== "ready") this.afterEnqueue();
      else this.scheduleSend();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(RETRY_MAX_DELAY_MS, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.client.getState() !== "ready") this.afterEnqueue();
      else this.scheduleSend();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Commit the given pending rows, in queue order, on the host connection. */
  private commitOnHost(entries: PendingOp[]): void {
    if (entries.length === 0 || this.committingOnHost) return;
    const ordered = entries.slice().sort((left, right) => left.order - right.order);
    this.committingOnHost = true;
    let insertedEventIds: string[];
    try {
      insertedEventIds = this.db
        .transaction(() =>
          applyTimelineWrites(
            this.db,
            ordered.map((entry) => entry.op),
          ),
        )
        .immediate().insertedEventIds;
    } finally {
      this.committingOnHost = false;
    }
    for (const entry of ordered) this.complete(entry);
    if (insertedEventIds.length > 0) this.options.onEventsCommitted?.(insertedEventIds);
  }

  /** Resolve the task's waiters whose rows are all committed (orders ascend in each set). */
  private settleWaiters(taskId: string, orders: Set<number> | undefined): void {
    const waiters = this.taskWaiters.get(taskId);
    if (!waiters) return;
    const oldestPending = orders?.size ? orders.values().next().value! : Infinity;
    for (const waiter of waiters) {
      if (waiter.upTo < oldestPending) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    if (waiters.size === 0) this.taskWaiters.delete(taskId);
  }

  private complete(entry: PendingOp): void {
    if (this.pending.get(entry.order) !== entry) return;
    this.pending.delete(entry.order);
    this.pendingBytes -= entry.bytes;
    if (entry.op.kind === "taskEvent") {
      this.eventOps.delete(entry.op.eventId);
      const orders = this.taskEventOrders.get(entry.op.taskId);
      orders?.delete(entry.order);
      if (orders?.size === 0) this.taskEventOrders.delete(entry.op.taskId);
      this.settleWaiters(entry.op.taskId, orders);
    }
    try {
      entry.afterCommit?.();
    } catch (error) {
      logger.debug("Timeline post-commit effect failed:", error);
    }
  }
}
