import { describe, expect, it } from "vitest";

import { calculateCost, getModelPricing } from "../pricing";

describe("Astra pricing", () => {
  it("exposes the documented standard and cache rates", () => {
    expect(getModelPricing("gpt-6-astra")).toEqual({
      inputPer1M: 10,
      outputPer1M: 50,
      cachedInputPer1M: 1,
      cacheWritePer1M: 12.5,
    });
  });

  it("charges cached reads and writes separately from regular input", () => {
    expect(calculateCost("gpt-6-astra", 15_000, 12, 12_000, 3_000)).toBeCloseTo(
      (12_000 / 1_000_000) * 1 + (3_000 / 1_000_000) * 12.5 + (12 / 1_000_000) * 50,
      10,
    );
  });

  it("applies Astra long-context multipliers above 272K input tokens", () => {
    expect(calculateCost("openai/gpt-6-astra", 300_000, 100_000)).toBeCloseTo(
      0.3 * 10 * 2 + 0.1 * 50 * 1.5,
      8,
    );
  });
});
