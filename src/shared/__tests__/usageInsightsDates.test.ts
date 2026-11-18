import { describe, expect, it } from "vitest";
import {
  parseUsageInsightsDateRange,
  usageInsightsDayCount,
  usageInsightsRangeFromDates,
  usageLocalDateKey,
} from "../usageInsightsDates";

describe("usageLocalDateKey", () => {
  it("buckets timestamps into local calendar days", () => {
    const d1 = new Date(2026, 2, 10, 15, 0, 0);
    const d2 = new Date(2026, 2, 11, 10, 0, 0);
    expect(usageLocalDateKey(d1.getTime())).toBe("2026-03-10");
    expect(usageLocalDateKey(d2.getTime())).toBe("2026-03-11");
  });
});

describe("custom usage report dates", () => {
  it("includes both selected local calendar days", () => {
    const range = usageInsightsRangeFromDates("2026-10-18", "2026-11-16");
    expect(range).toEqual({
      startMs: new Date(2026, 9, 18, 0, 0, 0, 0).getTime(),
      endMs: new Date(2026, 10, 16, 23, 59, 59, 999).getTime(),
    });
  });

  it("accepts a single day", () => {
    const range = usageInsightsRangeFromDates("2026-11-16", "2026-11-16")!;
    expect(usageLocalDateKey(range.startMs)).toBe("2026-11-16");
    expect(usageLocalDateKey(range.endMs)).toBe("2026-11-16");
  });

  it("counts calendar days across the autumn daylight-saving transition", () => {
    const range = usageInsightsRangeFromDates("2026-10-18", "2026-11-16")!;
    expect(usageInsightsDayCount(range)).toBe(30);
  });

  it.each([
    ["", "2026-11-16"],
    ["2026-02-30", "2026-03-02"],
    ["2026-11-17", "2026-11-16"],
    ["2024-01-01", "2026-11-16"],
  ])("does not query for invalid date inputs %s to %s", (start, end) => {
    expect(usageInsightsRangeFromDates(start, end)).toBeNull();
  });

  it.each([
    null,
    {},
    { startMs: NaN, endMs: 10 },
    { startMs: 20, endMs: 10 },
    { startMs: -1, endMs: 10 },
  ])("rejects invalid bounds at the host boundary: %j", (range) => {
    expect(() => parseUsageInsightsDateRange(range)).toThrow();
  });
});
