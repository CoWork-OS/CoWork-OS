import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_GATED_TOOL_TIMEOUT_MS,
  APPROVAL_GRANT_TTL_MS,
  APPROVAL_REQUEST_TIMEOUT_MS,
  APPROVAL_WAIT_MAX_PAUSE_MS,
  formatApprovalWindow,
} from "../approval-timeouts";
import { withTimeout } from "../executor-helpers";

describe("approval answer window", () => {
  it("keeps a request answerable for a day but a granted approval only briefly", () => {
    expect(APPROVAL_REQUEST_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    expect(APPROVAL_GRANT_TTL_MS).toBe(5 * 60 * 1000);
    expect(APPROVAL_WAIT_MAX_PAUSE_MS).toBeGreaterThan(APPROVAL_REQUEST_TIMEOUT_MS);
    // The fixed tool allowance stays small; decision time is credited separately.
    expect(APPROVAL_GATED_TOOL_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
  });

  it("describes the window in words", () => {
    expect(formatApprovalWindow()).toBe("24 hours");
    expect(formatApprovalWindow(60 * 60 * 1000)).toBe("1 hour");
    expect(formatApprovalWindow(5 * 60 * 1000)).toBe("5 minutes");
  });
});

describe("tool deadlines while a decision waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a tool wait hours for an approval without timing out", async () => {
    let pending = true;
    let resolveTool!: (value: string) => void;
    const tool = new Promise<string>((resolve) => {
      resolveTool = resolve;
    });
    const result = withTimeout(
      tool,
      APPROVAL_GATED_TOOL_TIMEOUT_MS,
      "Tool run_command",
      undefined,
      {
        isPaused: () => pending,
        maxPauseMs: APPROVAL_WAIT_MAX_PAUSE_MS,
        pollMs: 1_000,
      },
    );
    let rejected = false;
    result.catch(() => {
      rejected = true;
    });

    // Approved 6 hours later, then the command runs for a minute.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(rejected).toBe(false);
    pending = false;
    await vi.advanceTimersByTimeAsync(60_000);
    resolveTool("done");
    await expect(result).resolves.toBe("done");
  });
});
