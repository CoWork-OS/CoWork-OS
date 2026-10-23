import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_GATED_TOOL_TIMEOUT_MS,
  APPROVAL_GRANT_TTL_MS,
  APPROVAL_REQUEST_TIMEOUT_MS,
  APPROVAL_WAIT_MAX_PAUSE_MS,
  approvalGrantUsable,
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

describe("approved requests are used promptly", () => {
  const requestedAt = 1_000_000;
  const hour = 60 * 60 * 1000;

  it("is usable shortly after the person decides, even hours after the request", () => {
    const decidedAt = requestedAt + 6 * hour;
    expect(approvalGrantUsable(requestedAt, decidedAt, decidedAt + 60_000)).toBe(true);
  });

  it("lapses five minutes after the decision", () => {
    const decidedAt = requestedAt + 60_000;
    expect(approvalGrantUsable(requestedAt, decidedAt, decidedAt + APPROVAL_GRANT_TTL_MS)).toBe(
      false,
    );
    expect(approvalGrantUsable(requestedAt, decidedAt, requestedAt + 23 * hour)).toBe(false);
  });

  it("counts from the request when no decision time is recorded", () => {
    expect(approvalGrantUsable(requestedAt, null, requestedAt + 60_000)).toBe(true);
    expect(approvalGrantUsable(requestedAt, null, requestedAt + APPROVAL_GRANT_TTL_MS)).toBe(false);
  });

  it("is never usable past the request window or with a bad request time", () => {
    const late = requestedAt + APPROVAL_REQUEST_TIMEOUT_MS;
    expect(approvalGrantUsable(requestedAt, late - 1_000, late)).toBe(false);
    expect(approvalGrantUsable("x", requestedAt, requestedAt)).toBe(false);
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
