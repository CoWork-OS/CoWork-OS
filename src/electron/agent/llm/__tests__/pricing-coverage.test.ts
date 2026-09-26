import { describe, expect, it } from "vitest";

import { CUSTOM_PROVIDER_CATALOG } from "../../../../shared/llm-provider-catalog";
import { lookupModelMetadata, modelIdCandidates } from "../../../../shared/model-metadata";
import { calculateCost, getModelPricing, isModelPriced } from "../pricing";
import { INTENTIONAL_OVERRIDES, PRICING_OVERRIDES } from "../pricing-overrides";
import {
  DEEPSEEK_MODELS,
  GEMINI_MODELS,
  GROQ_MODELS,
  KIMI_MODELS,
  MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  XAI_MODELS,
} from "../types";

/**
 * Models CoWork offers that deliberately have no price. Their cost is shown as
 * unknown instead of $0. Anything else the app offers must resolve to a price:
 * add it to the models.dev catalogue (npm run models:sync) or pricing-overrides.ts.
 */
const KNOWN_UNPRICED: Record<string, string> = {
  "hf-agents::auto": "router alias; the routed model is not known ahead of time",
  "openrouter/pareto-code": "OpenRouter router alias",
  "openrouter/pareto-code:nitro": "OpenRouter router alias",
  "qwen-portal::coder-model": "subscription portal alias, not billed per token",
  "kimi-code::kimi-for-coding": "subscription plan alias, not billed per token",
  "deepseek-chat": "DeepSeek alias whose target model is not published in the catalogue",
  "kimi-k2-0905-preview": "retired preview id, not in the catalogue",
  "kimi-k2-turbo-preview": "retired preview id, not in the catalogue",
  "kimi-k2-thinking": "retired id, not in the catalogue",
  "kimi-k2-thinking-turbo": "retired id, not in the catalogue",
  "glm::glm-4-plus": "legacy Zhipu model, not in the catalogue",
  "cerebras::llama3.1-8b": "not listed for Cerebras in the catalogue",
  "venice::llama-3.3-70b": "Venice route, not in the catalogue",
  "xiaomi::mimo-v2-flash": "not in the catalogue",
  "minimax::MiniMax-M2.1-highspeed": "not in the catalogue",
  "minimax-portal::MiniMax-M2.1-highspeed": "not in the catalogue",
  "nano-gpt::google/gemini-3-pro-preview": "nano-gpt route id, not in the catalogue",
};

function offeredModelIds(): string[] {
  const ids = new Set<string>();
  for (const model of Object.values(MODELS)) {
    ids.add(model.anthropic);
    ids.add(model.bedrock);
  }
  for (const catalog of [
    GEMINI_MODELS,
    OPENROUTER_MODELS,
    OPENAI_MODELS,
    GROQ_MODELS,
    XAI_MODELS,
    KIMI_MODELS,
    DEEPSEEK_MODELS,
  ]) {
    for (const model of Object.values(catalog)) ids.add((model as { id: string }).id);
  }
  for (const provider of CUSTOM_PROVIDER_CATALOG) {
    ids.add(`${provider.id}::${provider.defaultModel}`);
    for (const model of provider.knownModels || []) ids.add(`${provider.id}::${model}`);
  }
  return [...ids].sort();
}

function splitOffered(offered: string): [string, string | undefined] {
  const [provider, modelId] = offered.includes("::") ? offered.split("::") : [undefined, offered];
  return [modelId, provider];
}

describe("model pricing coverage", () => {
  it("prices every model CoWork offers, unless it is explicitly listed as unpriced", () => {
    const missing = offeredModelIds().filter((offered) => {
      const [modelId, provider] = splitOffered(offered);
      return !isModelPriced(modelId, provider) && !(offered in KNOWN_UNPRICED);
    });
    expect(missing).toEqual([]);
  });

  it("keeps the unpriced allowlist current", () => {
    const nowPriced = Object.keys(KNOWN_UNPRICED).filter((offered) => {
      const [modelId, provider] = splitOffered(offered);
      return isModelPriced(modelId, provider);
    });
    expect(nowPriced).toEqual([]);
  });

  it("only overrides catalogue prices on purpose", () => {
    const shadowing = Object.keys(PRICING_OVERRIDES).filter(
      (key) =>
        modelIdCandidates(key).some(
          (candidate) => lookupModelMetadata(candidate)?.input !== undefined,
        ) && !(key in INTENTIONAL_OVERRIDES),
    );
    expect(shadowing).toEqual([]);
  });
});

describe("catalogue prices for current models", () => {
  it.each([
    ["claude-opus-5-5", 4, 20],
    ["claude-sonnet-5", 2, 10],
    ["claude-fable-5-1", 10, 50],
    ["claude-opus-4-6", 5, 25],
    ["claude-opus-4-5-20251101", 5, 25],
    ["claude-haiku-4-5", 1, 5],
  ] as const)("prices %s at $%s/$%s per 1M tokens", (model, input, output) => {
    expect(getModelPricing(model)).toMatchObject({ inputPer1M: input, outputPer1M: output });
  });

  it.each([
    "glm-5.3",
    "deepseek-v4-flash",
    "kimi-k3",
    "qwen3.7-plus",
    "minimax-m2.7",
    "gemini-3.5-flash",
    "anthropic/claude-opus-4.6",
    "us.anthropic.claude-opus-4-6-v1",
  ])("prices %s from the catalogue instead of treating it as free", (model) => {
    expect(isModelPriced(model)).toBe(true);
    expect(calculateCost(model, 1_000_000, 0)).toBeGreaterThan(0);
  });

  it("prices Bedrock ids at Bedrock rates, with or without the version suffix", () => {
    expect(getModelPricing("anthropic.claude-opus-4-6")?.inputPer1M).toBe(5.5);
    expect(getModelPricing("anthropic.claude-opus-4-6-v1")?.inputPer1M).toBe(5.5);
    expect(getModelPricing("claude-opus-4-6")?.inputPer1M).toBe(5);
  });

  it("matches exact ids only, so gpt-4.1 never inherits gpt-4's price", () => {
    expect(getModelPricing("gpt-4.1")?.inputPer1M).not.toBe(getModelPricing("gpt-4")?.inputPer1M);
  });

  it("reports unknown models as unpriced and local models as free", () => {
    expect(isModelPriced("totally-made-up-model")).toBe(false);
    expect(isModelPriced("llama3.2", "ollama")).toBe(true);
    expect(
      calculateCost("llama3.2", 1_000_000, 1_000_000, 0, 0, undefined, { providerType: "ollama" }),
    ).toBe(0);
  });

  it("applies catalogue long-context tiers to the whole request", () => {
    expect(calculateCost("gpt-6-astra", 300_000, 100_000)).toBeCloseTo(0.3 * 20 + 0.1 * 75, 8);
    expect(calculateCost("gpt-6-astra", 200_000, 100_000)).toBeCloseTo(0.2 * 10 + 0.1 * 50, 8);
  });
});
