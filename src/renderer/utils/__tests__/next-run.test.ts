import { describe, expect, it } from "vitest";
import { formatNextRun } from "../next-run";

describe("formatNextRun", () => {
  const now = new Date(2026, 9, 7, 12, 0).getTime();
  it("labels upcoming runs by day", () => {
    expect(formatNextRun(new Date(2026, 9, 7, 15, 0).getTime(), now)).toMatch(/^today /);
    expect(formatNextRun(new Date(2026, 9, 8, 9, 0).getTime(), now)).toMatch(/^tomorrow /);
  });
  it("calls a missed run overdue instead of today", () => {
    expect(formatNextRun(new Date(2026, 9, 7, 9, 0).getTime(), now)).toMatch(/^overdue since /);
    expect(formatNextRun(new Date(2026, 9, 4, 9, 0).getTime(), now)).toMatch(/^overdue since /);
    // A run due this minute is not yet overdue.
    expect(formatNextRun(now - 30_000, now)).toMatch(/^today /);
  });
});
