import { describe, expect, it } from "vitest";

import { computeOffsets, findStartIndex, shouldAutoScrollOnItemsChange } from "../useVirtualList";

describe("computeOffsets", () => {
  it("returns empty arrays for zero items", () => {
    const { offsets, totalHeight } = computeOffsets(0, () => 40);
    expect(offsets).toHaveLength(0);
    expect(totalHeight).toBe(0);
  });

  it("computes cumulative offsets for uniform heights", () => {
    const { offsets, totalHeight } = computeOffsets(4, () => 50);
    expect(offsets).toEqual([0, 50, 100, 150]);
    expect(totalHeight).toBe(200);
  });

  it("computes cumulative offsets for variable heights", () => {
    const heights = [30, 60, 40, 100];
    const { offsets, totalHeight } = computeOffsets(4, (i) => heights[i]);
    expect(offsets).toEqual([0, 30, 90, 130]);
    expect(totalHeight).toBe(230);
  });

  it("handles a single item", () => {
    const { offsets, totalHeight } = computeOffsets(1, () => 42);
    expect(offsets).toEqual([0]);
    expect(totalHeight).toBe(42);
  });
});

describe("findStartIndex", () => {
  // Offsets:  [0, 50, 100, 150, 200]
  const offsets = [0, 50, 100, 150, 200];

  it("returns 0 when scrollTop is 0", () => {
    expect(findStartIndex(offsets, 0)).toBe(0);
  });

  it("returns the item that contains the scrollTop position", () => {
    expect(findStartIndex(offsets, 75)).toBe(1); // item at offset 50 is partially visible
  });

  it("returns exact match minus one for exact offset boundaries", () => {
    expect(findStartIndex(offsets, 100)).toBe(1); // item 2 starts exactly at 100, but item 1 might still be partially visible
  });

  it("returns last item index for scrollTop past all offsets", () => {
    // Binary search clamps to max(lo-1, 0), so the last visible start is index 3
    expect(findStartIndex(offsets, 999)).toBe(3);
  });

  it("returns 0 for negative scrollTop", () => {
    expect(findStartIndex(offsets, -10)).toBe(0);
  });

  it("handles single-item offsets", () => {
    expect(findStartIndex([0], 0)).toBe(0);
  });
});

describe("shouldAutoScrollOnItemsChange", () => {
  it("does not move a list when callers suppress item-change auto-scroll", () => {
    expect(
      shouldAutoScrollOnItemsChange({
        itemCountChanged: true,
        enabled: true,
        suppressAutoScrollOnItemsChange: true,
        isAtBottom: true,
      }),
    ).toBe(false);
  });

  it("keeps the existing bottom-follow behavior when not suppressed", () => {
    expect(
      shouldAutoScrollOnItemsChange({
        itemCountChanged: true,
        enabled: true,
        suppressAutoScrollOnItemsChange: false,
        isAtBottom: true,
      }),
    ).toBe(true);
  });
});
