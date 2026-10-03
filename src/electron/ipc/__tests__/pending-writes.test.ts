import { describe, expect, it } from "vitest";
import { createPendingWriteTracker } from "../pending-writes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPendingWriteTracker", () => {
  it("waits for every tracked write, including one that fails", async () => {
    const tracker = createPendingWriteTracker();
    const ok = deferred<string>();
    const failing = deferred<string>();
    expect(tracker.track(ok.promise)).toBe(ok.promise);
    const failed = tracker.track(failing.promise).catch((error) => String(error));

    let settled = false;
    const waiting = tracker.waitForAll(0).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    ok.resolve("saved");
    failing.reject(new Error("closed"));
    await waiting;
    expect(settled).toBe(true);
    expect(await failed).toContain("closed");
  });

  it("waits for a write that starts during the settle window", async () => {
    const tracker = createPendingWriteTracker();
    const late = deferred<void>();
    let settled = false;
    const waiting = tracker.waitForAll(30).then(() => {
      settled = true;
    });
    tracker.track(late.promise);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);

    late.resolve();
    await waiting;
    expect(settled).toBe(true);
  });

  it("returns at once after the settle window when nothing is pending", async () => {
    const tracker = createPendingWriteTracker();
    const done = deferred<void>();
    tracker.track(done.promise);
    done.resolve();
    await done.promise;

    await expect(tracker.waitForAll(0)).resolves.toBeUndefined();
  });
});
