import { afterEach, describe, expect, it } from "vitest";

import { buildModelMetadata } from "../model-metadata-build";
import {
  registerLiveModelMetadata,
  resetRuntimeModelMetadata,
  resolveModelMetadata,
  setRefreshedModelMetadata,
} from "../model-metadata";

afterEach(() => resetRuntimeModelMetadata());

describe("model metadata layers", () => {
  it("prefers provider-reported data, then a refreshed catalogue, then the bundled snapshot", () => {
    const bundled = resolveModelMetadata("claude-opus-4-6");
    expect(bundled?.input).toBe(5);

    setRefreshedModelMetadata({
      "claude-opus-4-6": { provider: "anthropic", input: 4, output: 20 },
    });
    expect(resolveModelMetadata("claude-opus-4-6")?.input).toBe(4);

    registerLiveModelMetadata({ "claude-opus-4-6": { provider: "live", input: 3 } });
    const live = resolveModelMetadata("claude-opus-4-6");
    expect(live?.input).toBe(3);
    // Fields the provider did not report are filled from the catalogue layer below.
    expect(live?.output).toBe(20);

    resetRuntimeModelMetadata();
    expect(resolveModelMetadata("claude-opus-4-6")?.input).toBe(5);
  });
});

describe("buildModelMetadata", () => {
  it("keeps first-party listings, lowercases ids and captures long-context tiers", () => {
    const models = buildModelMetadata({
      openrouter: { models: { "GPT-X": { cost: { input: 9, output: 9 } } } },
      openai: {
        models: {
          "GPT-X": {
            cost: {
              input: 1,
              output: 2,
              cache_read: 0.1,
              tiers: [{ input: 2, output: 3, tier: { type: "context", size: 272000 } }],
            },
            limit: { context: 1_000_000, output: 64_000 },
          },
        },
      },
    });
    expect(models["gpt-x"]).toEqual({
      provider: "openai",
      input: 1,
      output: 2,
      cacheRead: 0.1,
      longContext: { threshold: 272000, input: 2, output: 3 },
      context: 1_000_000,
      maxOutput: 64_000,
    });
  });

  it("ignores malformed catalogues", () => {
    expect(buildModelMetadata(null)).toEqual({});
    expect(buildModelMetadata({ openai: { models: { bad: null } } })).toEqual({});
  });
});
