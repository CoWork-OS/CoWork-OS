import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefetchWhenIdle } from "../idle-prefetch";

describe("prefetchWhenIdle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs loaders one at a time after the delay, continuing past failures", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push("first");
          releaseFirst = resolve;
        }),
    );
    const failing = vi.fn(() => {
      calls.push("failing");
      return Promise.reject(new Error("offline"));
    });
    const last = vi.fn(async () => {
      calls.push("last");
    });

    prefetchWhenIdle([first, failing, last], { delayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(["first"]);

    releaseFirst();
    await vi.runAllTimersAsync();
    expect(calls).toEqual(["first", "failing", "last"]);
  });

  it("stops the remaining loaders when cancelled", async () => {
    const loader = vi.fn(async () => undefined);
    const cancel = prefetchWhenIdle([loader, loader], { delayMs: 500 });
    cancel();
    await vi.runAllTimersAsync();
    expect(loader).not.toHaveBeenCalled();
  });
});
