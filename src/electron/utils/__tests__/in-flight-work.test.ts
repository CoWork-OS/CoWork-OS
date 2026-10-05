import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InFlightWork } from "../in-flight-work";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InFlightWork", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the tracked promise unchanged and forgets it once settled", async () => {
    const work = new InFlightWork();
    const job = deferred<number>();
    const tracked = work.track(job.promise);
    expect(tracked).toBe(job.promise);
    expect(work.size).toBe(1);
    job.resolve(7);
    await expect(tracked).resolves.toBe(7);
    await Promise.resolve();
    expect(work.size).toBe(0);
  });

  it("drains immediately when nothing is running", async () => {
    await expect(new InFlightWork().drain(1_000)).resolves.toBe(true);
  });

  it("waits for running work, including a rejection, and work it starts while draining", async () => {
    const work = new InFlightWork();
    const first = deferred();
    const second = deferred();
    const failing = deferred();
    work.track(first.promise);
    work.track(failing.promise).catch(() => undefined);
    let drained: boolean | undefined;
    const draining = work.drain(5_000).then((value) => (drained = value));

    failing.reject(new Error("learning failed"));
    // Tracked work that starts more work while shutdown waits.
    first.promise.then(() => work.track(second.promise));
    first.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(drained).toBeUndefined();

    second.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(work.size).toBe(0);
  });

  it("gives up after the bound and reports what is still running", async () => {
    const work = new InFlightWork();
    work.track(new Promise<void>(() => undefined));
    const draining = work.drain(3_000);
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void draining.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(draining).resolves.toBe(false);
    expect(work.size).toBe(1);
  });
});
