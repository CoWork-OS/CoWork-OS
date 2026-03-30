import { describe, expect, it } from "vitest";
import { usageLocalDateKey } from "../usageInsightsDates";

describe("usageLocalDateKey", () => {
  it("buckets timestamps into local calendar days", () => {
    const d1 = new Date(2026, 2, 10, 15, 0, 0);
    const d2 = new Date(2026, 2, 11, 10, 0, 0);
    expect(usageLocalDateKey(d1.getTime())).toBe("2026-03-10");
    expect(usageLocalDateKey(d2.getTime())).toBe("2026-03-11");
  });
});
