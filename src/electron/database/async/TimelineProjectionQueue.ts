import { createLogger } from "../../utils/logger";
import { DEFAULT_LEASE_MAINTENANCE_INTERVAL_MS } from "../../sessions/WorkSessionReliabilityService";
import type { TimelineProjectionFailure } from "../../sessions/timeline-projection";
import type { DatabaseClient } from "./DatabaseClient";
import { DatabaseRequestError } from "./protocol";

const logger = createLogger("TimelineProjection");

export interface TimelineProjectionQueueOptions {
  batchSize?: number;
  /**
   * Projection work per worker transaction. The host's own event inserts need the same
   * write lock, so long transactions stall the host; short ones cost more commits.
   */
  batchBudgetMs?: number;
  leaseMaintenanceIntervalMs?: number;
  /** Receives projection failures reported by the worker (logged as before by the daemon). */
  onProjectionFailures?: (failures: TimelineProjectionFailure[]) => void;
}

interface Waiter {
  taskId?: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const RETRY_BASE_DELAY_MS = 100;
const DEFAULT_BATCH_BUDGET_MS = 5;
/** Pending projections that trigger a (rate-limited) lag warning. */
const LAG_WARNING_THRESHOLD = 1_000;
const BACKPRESSURE_HIGH_WATER = 1_000;
const BACKPRESSURE_LOW_WATER = 500;
const BACKPRESSURE_MAX_WAIT_MS = 30_000;
const LAG_WARNING_INTERVAL_MS = 60_000;
const RETRY_MAX_DELAY_MS = 5_000;
/** Consecutive `command_failed` drains before the head entry is retried alone, then skipped. */
const ABORTS_BEFORE_ISOLATING = 2;

/**
 * Host side of timeline projections in the database worker (async SQLite migration
 * plan, DB3). The host still commits each TaskEvent itself, together with a durable
 * outbox row; this queue asks the worker to project outbox entries in order and tracks
 * which events of this process are still pending.
 *
 * `flush(taskId)` is the read barrier for derived WorkSession state: callers that act on
 * projected state (stale-turn checks, replay evaluation) await it first. If the worker
 * is unavailable the outbox keeps the entries, `flush` fails explicitly at its deadline,
 * and the next drain, possibly after a restart, repairs derived state.
 */
export class TimelineProjectionQueue {
  private readonly batchSize: number;
  private readonly batchBudgetMs: number;
  private readonly pendingByTask = new Map<string, Set<string>>();
  private readonly waiters = new Set<Waiter>();
  private draining = false;
  private drainRequested = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_BASE_DELAY_MS;
  private consecutiveAborts = 0;
  private lagWarnedAt = 0;
  private readonly capacityWaiters = new Set<() => void>();
  private readonly leaseTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: DatabaseClient,
    private readonly options: TimelineProjectionQueueOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.min(256, Math.floor(options.batchSize ?? 64)));
    this.batchBudgetMs = Math.max(1, options.batchBudgetMs ?? DEFAULT_BATCH_BUDGET_MS);
    this.leaseTimer = setInterval(() => {
      if (this.stopped) return;
      this.client.execute("timeline.maintainLeases", undefined).catch((error) => {
        logger.debug("Lease maintenance in the database worker failed:", error);
      });
    }, options.leaseMaintenanceIntervalMs ?? DEFAULT_LEASE_MAINTENANCE_INTERVAL_MS);
    this.leaseTimer.unref?.();
    // Entries left by a previous run are projected first.
    this.requestDrain();
  }

  /** Record an event the host just committed with its outbox row. */
  notifyEnqueued(taskId: string, eventId: string): void {
    let pending = this.pendingByTask.get(taskId);
    if (!pending) {
      pending = new Set();
      this.pendingByTask.set(taskId, pending);
    }
    pending.add(eventId);
    this.warnIfLagging();
    this.requestDrain();
  }

  /**
   * The worker projects roughly as fast as the host used to; under a sustained burst the
   * host now runs ahead and derived state trails. Entries stay durable in the outbox, but
   * barriers wait longer, so make a growing backlog visible.
   */
  private warnIfLagging(): void {
    const pending = this.pendingCount();
    if (pending < LAG_WARNING_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lagWarnedAt < LAG_WARNING_INTERVAL_MS) return;
    this.lagWarnedAt = now;
    logger.warn(`${pending} timeline events are waiting for projection in the database worker`);
  }

  /**
   * Backpressure for producers (async SQLite plan, decision 6). Resolves at once while at
   * most `highWater` events wait for projection; otherwise once the backlog is down to
   * `lowWater`, or after `maxWaitMs` so a stuck worker cannot stall tasks indefinitely.
   * Executors await this before each model call, which paces work at step boundaries.
   */
  waitForCapacity(
    options: { highWater?: number; lowWater?: number; maxWaitMs?: number } = {},
  ): Promise<void> {
    const highWater = options.highWater ?? BACKPRESSURE_HIGH_WATER;
    const lowWater = options.lowWater ?? BACKPRESSURE_LOW_WATER;
    if (this.stopped || this.pendingCount() <= highWater) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.stopped || this.pendingCount() <= lowWater) finish();
      };
      const finish = () => {
        clearTimeout(timer);
        this.capacityWaiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        logger.warn(
          `Proceeding after ${options.maxWaitMs ?? BACKPRESSURE_MAX_WAIT_MS} ms with ${this.pendingCount()} timeline events still waiting for projection`,
        );
        finish();
      }, options.maxWaitMs ?? BACKPRESSURE_MAX_WAIT_MS);
      this.capacityWaiters.add(check);
      this.requestDrain();
    });
  }

  /** Ask for a drain, for example after the worker committed new events. */
  wake(): void {
    this.requestDrain();
  }

  pendingCount(taskId?: string): number {
    if (taskId) return this.pendingByTask.get(taskId)?.size ?? 0;
    let total = 0;
    for (const pending of this.pendingByTask.values()) total += pending.size;
    return total;
  }

  /** Resolve once this process's events for `taskId` (or all tasks) are projected. */
  flush(taskId?: string, timeoutMs = 10_000): Promise<void> {
    if (this.pendingCount(taskId) === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        taskId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `Timeline projections ${taskId ? `for task ${taskId} ` : ""}are still pending after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.requestDrain();
    });
  }

  /** Stop scheduling work after trying to project everything pending. */
  async stop(timeoutMs = 5_000): Promise<void> {
    try {
      await this.flush(undefined, timeoutMs);
    } catch (error) {
      logger.warn("Stopping with timeline projections pending; the next run repairs them:", error);
    }
    this.stopped = true;
    for (const check of this.capacityWaiters) check();
    clearInterval(this.leaseTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private requestDrain(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    if (this.retryTimer) return;
    this.draining = true;
    setImmediate(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        this.drainRequested = false;
        const limit = this.consecutiveAborts >= ABORTS_BEFORE_ISOLATING ? 1 : this.batchSize;
        const result = await this.client.execute("timeline.drainProjectionOutbox", {
          limit,
          budgetMs: this.batchBudgetMs,
        });
        this.consecutiveAborts = 0;
        this.retryDelayMs = RETRY_BASE_DELAY_MS;
        for (const entry of result.processed) this.markProjected(entry.taskId, entry.eventId);
        if (result.failures.length > 0) this.options.onProjectionFailures?.(result.failures);
        // Stop when the outbox is empty, or when nothing was processed at all so a
        // malformed reply can never spin this loop.
        if ((result.exhausted || result.processed.length === 0) && !this.drainRequested) break;
        if (result.processed.length === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      await this.handleDrainError(error);
    } finally {
      this.draining = false;
      if (this.drainRequested && !this.retryTimer) this.requestDrain();
    }
  }

  private async handleDrainError(error: unknown): Promise<void> {
    const failure = error instanceof DatabaseRequestError ? error : null;
    if (failure?.code === "command_failed") {
      // A projection rolled back the whole batch. Retry the head entry alone, then skip it.
      this.consecutiveAborts += 1;
      if (this.consecutiveAborts > ABORTS_BEFORE_ISOLATING) {
        try {
          const skipped = await this.client.execute("timeline.skipProjectionOutboxHead", undefined);
          if (skipped) {
            this.markProjected(skipped.taskId, skipped.eventId);
            logger.error(
              `Skipped projections for event ${skipped.eventId} (task ${skipped.taskId}) after repeated failures; derived session state for that task may lag until replay:`,
              error,
            );
          }
          this.consecutiveAborts = 0;
        } catch (skipError) {
          logger.error("Could not skip the failing timeline projection:", skipError);
        }
      }
    } else {
      // Not committed or unknown: outbox entries are deleted only with their projection,
      // so draining again is always safe.
      logger.warn("Timeline projection drain failed; retrying:", error);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(RETRY_MAX_DELAY_MS, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestDrain();
    }, delay);
    this.retryTimer.unref?.();
  }

  private markProjected(taskId: string, eventId: string): void {
    const pending = this.pendingByTask.get(taskId);
    if (pending) {
      pending.delete(eventId);
      if (pending.size === 0) this.pendingByTask.delete(taskId);
    }
    for (const check of this.capacityWaiters) check();
    // Deleting the current entry while iterating a Set is well defined.
    for (const waiter of this.waiters) {
      if (this.pendingCount(waiter.taskId) > 0) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }
}
