import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../executor-helpers";

describe("withTimeout approval pause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = () => new Promise<never>(() => {});

  it("still times out on schedule when nothing pauses the clock", async () => {
    const onTimeout = vi.fn();
    const result = withTimeout(never(), 30_000, "Tool x", onTimeout, {
      isPaused: () => false,
      maxPauseMs: 300_000,
    });
    const assertion = expect(result).rejects.toThrow("Tool x timed out after 30s");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not count time spent on an open approval", async () => {
    let pending = true;
    let resolveTool!: (value: string) => void;
    const tool = new Promise<string>((resolve) => {
      resolveTool = resolve;
    });
    const result = withTimeout(tool, 30_000, "Tool canvas_create", undefined, {
      isPaused: () => pending,
      maxPauseMs: 300_000,
      pollMs: 100,
    });

    // The person takes 90s to approve: well past the 30s tool timeout.
    await vi.advanceTimersByTimeAsync(90_000);
    pending = false;
    // The tool then runs for 10s and finishes.
    await vi.advanceTimersByTimeAsync(10_000);
    resolveTool("ok");
    await expect(result).resolves.toBe("ok");
  });

  it("times out once the tool itself overruns after approval", async () => {
    let pending = true;
    const result = withTimeout(never(), 30_000, "Tool canvas_push", undefined, {
      isPaused: () => pending,
      maxPauseMs: 300_000,
      pollMs: 100,
    });
    let rejected = false;
    result.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    pending = false;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).rejects.toThrow("timed out after 30s");
  });

  it("caps the paused time at the approval budget", async () => {
    const result = withTimeout(never(), 30_000, "Tool y", undefined, {
      isPaused: () => true,
      maxPauseMs: 60_000,
      pollMs: 100,
    });
    let rejected = false;
    result.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(85_000);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).rejects.toThrow("Tool y timed out");
  });

  it("keeps the old behavior without pause options", async () => {
    const result = withTimeout(never(), 1_000, "Tool z");
    const assertion = expect(result).rejects.toThrow("Tool z timed out after 1s");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
