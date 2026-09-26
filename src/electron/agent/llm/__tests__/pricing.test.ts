import { describe, expect, it } from "vitest";

import { calculateCost, getCacheTokenAccounting, getModelPricing } from "../pricing";

describe("Astra pricing", () => {
  it("exposes the documented standard and cache rates", () => {
    expect(getModelPricing("gpt-6-astra")).toMatchObject({
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

  it("treats Anthropic and Bedrock cache counters as disjoint from regular input", () => {
    const cost = calculateCost("claude-sonnet-4-5", 100, 0, 50, 50, "disjoint");

    expect(cost).toBeCloseTo(
      // Cache writes use the catalogue's 5-minute rate (1.25x input).
      (100 / 1_000_000) * 3 + (50 / 1_000_000) * 0.3 + (50 / 1_000_000) * 3.75,
      10,
    );
    expect(getCacheTokenAccounting("anthropic", "claude-sonnet-4-5")).toBe("disjoint");
    expect(getCacheTokenAccounting("bedrock", "anthropic.claude-sonnet-4-5")).toBe("disjoint");
    expect(getCacheTokenAccounting("qwen-portal", "qwen3-coder")).toBe("disjoint");
    expect(getCacheTokenAccounting("openai", "gpt-5.6-sol")).toBe("inclusive");
  });
});

describe("GPT-6 Sol and Luna pricing", () => {
  it.each([
    ["gpt-6-sol", 2, 10, 0.2, 2.5],
    ["gpt-6-luna", 0.1, 0.5, 0.01, 0.125],
  ] as const)(
    "prices %s at published rates and applies the long-context multiplier",
    (model, input, output, cached, write) => {
      expect(getModelPricing(model)).toMatchObject({
        inputPer1M: input,
        outputPer1M: output,
        cachedInputPer1M: cached,
        cacheWritePer1M: write,
      });
      expect(calculateCost(model, 300_000, 100_000)).toBeCloseTo(
        0.3 * input * 2 + 0.1 * output * 1.5,
        8,
      );
    },
  );
});

describe("current OpenAI prompt-cache pricing", () => {
  it("recognizes GPT-5.6 model rates instead of treating them as free", () => {
    expect(getModelPricing("gpt-5.6-sol")).toMatchObject({
      inputPer1M: 4,
      cachedInputPer1M: 0.4,
      cacheWritePer1M: 5,
    });
    expect(
      calculateCost("gpt-5.6-sol", 200_000, 0, 0, 200_000, "inclusive", {
        providerType: "openai",
        cacheTtl: "5m",
      }),
    ).toBeCloseTo(1, 10);
  });

  it("uses the Anthropic TTL multiplier for cache writes", () => {
    expect(
      calculateCost("claude-sonnet-4-5", 0, 0, 0, 1_000_000, "disjoint", {
        providerType: "anthropic",
        cacheTtl: "5m",
      }),
    ).toBeCloseTo(3.75, 10);
    expect(
      calculateCost("claude-sonnet-4-5", 0, 0, 0, 1_000_000, "disjoint", {
        providerType: "anthropic",
        cacheTtl: "1h",
      }),
    ).toBeCloseTo(6, 10);
  });
});
