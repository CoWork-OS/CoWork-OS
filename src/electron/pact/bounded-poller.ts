/**
 * A cancellable setTimeout loop with a deadline, backoff and a lease check before every attempt.
 *
 * Used for the device-authorization wait. It never spins: each attempt is scheduled after the
 * previous one settles, the interval only grows (slow_down, errors), and the loop stops when the
 * deadline passes, the signal aborts, or the caller loses its lease.
 */

export type PollStep<T> =
  | { kind: "done"; value: T }
  | { kind: "continue" }
  | { kind: "slow_down" }
  | { kind: "retry_after"; delayMs: number };

export type BoundedPollOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "expired" }
  | { kind: "aborted" }
  | { kind: "lease_lost" }
  | { kind: "failed"; error: unknown };

export interface BoundedPollOptions<T> {
  /** First wait and base interval. */
  intervalMs: number;
  /** Absolute epoch milliseconds after which no attempt starts. */
  deadline: number;
  attempt: () => Promise<PollStep<T>>;
  /** Called before every attempt; returning false stops the loop with `lease_lost`. */
  holdsLease?: () => boolean | Promise<boolean>;
  /** Transient errors are retried with backoff up to this many times in a row. */
  maxConsecutiveErrors?: number;
  isTransientError?: (error: unknown) => boolean;
  /** RFC 8628 §3.5: add this much on slow_down. */
  slowDownIncrementMs?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_SLOW_DOWN_MS = 5_000;
const DEFAULT_MAX_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ERRORS = 5;

export function runBoundedPoll<T>(options: BoundedPollOptions<T>): Promise<BoundedPollOutcome<T>> {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const maxInterval = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const maxErrors = options.maxConsecutiveErrors ?? DEFAULT_MAX_ERRORS;
  let interval = Math.max(1, options.intervalMs);
  let consecutiveErrors = 0;

  return new Promise((resolve) => {
    let settled = false;
    let timer: unknown;
    const finish = (outcome: BoundedPollOutcome<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "aborted" });
    if (options.signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const schedule = (delayMs: number) => {
      if (settled) return;
      if (now() + delayMs > options.deadline) {
        finish({ kind: "expired" });
        return;
      }
      timer = setTimer(() => {
        timer = undefined;
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (settled) return;
      try {
        if (options.holdsLease && !(await options.holdsLease())) {
          finish({ kind: "lease_lost" });
          return;
        }
      } catch (error) {
        finish({ kind: "failed", error });
        return;
      }
      if (settled) return;
      let step: PollStep<T>;
      try {
        step = await options.attempt();
        consecutiveErrors = 0;
      } catch (error) {
        if (settled) return;
        const transient = options.isTransientError?.(error) ?? false;
        consecutiveErrors += 1;
        if (!transient || consecutiveErrors > maxErrors) {
          finish({ kind: "failed", error });
          return;
        }
        interval = Math.min(maxInterval, interval * 2);
        schedule(interval);
        return;
      }
      if (settled) return;
      switch (step.kind) {
        case "done":
          finish({ kind: "done", value: step.value });
          return;
        case "slow_down":
          interval = Math.min(
            maxInterval,
            interval + (options.slowDownIncrementMs ?? DEFAULT_SLOW_DOWN_MS),
          );
          schedule(interval);
          return;
        case "retry_after":
          schedule(Math.min(maxInterval, Math.max(interval, step.delayMs)));
          return;
        case "continue":
          schedule(interval);
          return;
      }
    };

    schedule(interval);
  });
}
