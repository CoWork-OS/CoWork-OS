import { describe, expect, it } from "vitest";

import {
  formatUsageCost,
  formatUsageCount,
  formatUsageTokens,
  pickBookComparison,
} from "../usageInsightsFormatting";

describe("formatUsageCount", () => {
  it("renders counts with a multiplication sign instead of the escaped token text", () => {
    expect(formatUsageCount(22)).toBe("22×");
    expect(formatUsageCount(22)).not.toContain("\\u00D7");
  });
});

describe("formatUsageCost and formatUsageTokens", () => {
  it("shows cents, then more digits only for small amounts", () => {
    expect(formatUsageCost(0)).toBe("$0");
    expect(formatUsageCost(12.345)).toBe("$12.35");
    expect(formatUsageCost(0.4)).toBe("$0.40");
    expect(formatUsageCost(0.005)).toBe("$0.005");
    expect(formatUsageCost(0.00012)).toBe("$0.0001");
  });

  it("shortens token counts", () => {
    expect(formatUsageTokens(950)).toBe("950");
    expect(formatUsageTokens(10_500)).toBe("10.5K");
    expect(formatUsageTokens(2_400_000)).toBe("2.4M");
  });
});

describe("pickBookComparison", () => {
  it("returns nothing before any tokens are used", () => {
    expect(pickBookComparison(0)).toBeNull();
  });

  it("describes a multiple above one as a times comparison", () => {
    expect(pickBookComparison(1_350_000)).toBe("You've used ~5.0× as many tokens as Moby-Dick.");
    expect(pickBookComparison(100_000_000)).toBe(
      "You've used ~71× as many tokens as the Harry Potter series.",
    );
  });

  it("says about as many when the multiple rounds to one", () => {
    expect(pickBookComparison(270_000)).toBe("You've used about as many tokens as Moby-Dick.");
  });

  it("describes a multiple below one as a share instead of 'more'", () => {
    expect(pickBookComparison(54_000)).toBe("You've used about 20% as many tokens as Moby-Dick.");
    expect(pickBookComparison(13_500)).toBe("You've used about 5% as many tokens as Moby-Dick.");
    expect(pickBookComparison(1_000)).toBe("You've used under 1% as many tokens as Moby-Dick.");
    expect(pickBookComparison(54_000)).not.toContain("more tokens than");
  });
});
