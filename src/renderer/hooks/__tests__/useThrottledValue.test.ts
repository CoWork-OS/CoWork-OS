import { describe, expect, it } from "vitest";

import { throttleWaitMs } from "../useThrottledValue";

describe("throttleWaitMs", () => {
  it("applies a value at once when the interval has passed", () => {
    expect(throttleWaitMs(0, 1500, 10_000)).toBe(0);
    expect(throttleWaitMs(8_500, 1500, 10_000)).toBe(0);
  });

  it("holds a value until the interval since the last update ends", () => {
    expect(throttleWaitMs(9_000, 1500, 10_000)).toBe(500);
    expect(throttleWaitMs(10_000, 1500, 10_000)).toBe(1500);
  });
});
