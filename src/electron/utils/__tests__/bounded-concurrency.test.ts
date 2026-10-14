import { describe, expect, it } from "vitest";
import { mapBounded, mapBoundedSettled } from "../bounded-concurrency";

function tracker() {
  let active = 0;
  let peak = 0;
  return {
    run: async <T>(value: T) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    },
    get peak() {
      return peak;
    },
  };
}

describe("bounded concurrency", () => {
  it("keeps input order and never exceeds the limit", async () => {
    const t = tracker();
    const items = Array.from({ length: 50 }, (_, i) => i);
    await expect(mapBounded(items, 8, (item) => t.run(item * 2))).resolves.toEqual(
      items.map((i) => i * 2),
    );
    expect(t.peak).toBe(8);
  });

  it("handles empty input and limits above the item count", async () => {
    await expect(mapBounded([], 8, async () => 1)).resolves.toEqual([]);
    await expect(mapBounded([1, 2], 50, async (x) => x)).resolves.toEqual([1, 2]);
  });

  it("settles every item even when some fail", async () => {
    const results = await mapBoundedSettled([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    });
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
