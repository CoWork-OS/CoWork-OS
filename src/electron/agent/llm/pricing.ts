import { CUSTOM_PROVIDER_MAP } from "../../../shared/llm-provider-catalog";
import type { LLMProviderType } from "../../../shared/types";
import {
  lookupModelMetadata,
  modelIdCandidates,
  type ModelMetadataEntry,
} from "../../../shared/model-metadata";
import { LOCAL_PROVIDER_TYPES, PRICING_OVERRIDES } from "./pricing-overrides";

/**
 * Model pricing, per 1 million tokens in USD.
 *
 * Prices come from the generated models.dev snapshot (src/shared/model-metadata.json,
 * refreshed with `npm run models:sync`). Retired models and deliberate exceptions
 * live in ./pricing-overrides.ts. Unknown models are reported as unpriced rather
 * than silently free: see getModelPricing() / isModelPriced().
 */

export interface ModelPricing {
  inputPer1M: number; // Cost per 1M input tokens in USD
  outputPer1M: number; // Cost per 1M output tokens in USD
  /** Cost per 1M cached-read tokens. Defaults to 50% of inputPer1M (OpenAI/Azure rate) if omitted. */
  cachedInputPer1M?: number;
  /** Cost per 1M cache-write tokens. Defaults to inputPer1M for legacy providers. */
  cacheWritePer1M?: number;
  /** Rates for the whole request once input exceeds `thresholdTokens` (e.g. GPT-6 above 272K). */
  longContext?: {
    thresholdTokens: number;
    inputPer1M: number;
    outputPer1M: number;
    cachedInputPer1M?: number;
    cacheWritePer1M?: number;
  };
}

export type CacheTokenAccounting = "inclusive" | "disjoint";

export interface CacheCostOptions {
  /** Provider route used to choose provider-specific cache-write pricing. */
  providerType?: string | null;
  /** Requested or provider-reported cache-write TTL. */
  cacheTtl?: "5m" | "1h";
}

export function getCacheTokenAccounting(
  providerType?: string | null,
  modelId?: string | null,
): CacheTokenAccounting {
  const provider = String(providerType || "")
    .trim()
    .toLowerCase();
  if (
    provider === "anthropic" ||
    provider === "azure-anthropic" ||
    provider === "anthropic-compatible" ||
    provider === "bedrock"
  ) {
    return "disjoint";
  }

  if (CUSTOM_PROVIDER_MAP.get(provider as LLMProviderType)?.compatibility === "anthropic") {
    return "disjoint";
  }

  // Pi is a transport over several upstreams. Its Anthropic and Bedrock
  // backends expose the same disjoint usage counters as their native APIs.
  if (
    provider === "pi" &&
    /(?:^|[./_-])(?:claude|anthropic)(?:[./_-]|$)/i.test(String(modelId || ""))
  ) {
    return "disjoint";
  }

  return "inclusive";
}

function fromMetadata(entry: ModelMetadataEntry): ModelPricing | null {
  if (entry.input === undefined || entry.output === undefined) return null;
  const pricing: ModelPricing = { inputPer1M: entry.input, outputPer1M: entry.output };
  if (entry.cacheRead !== undefined) pricing.cachedInputPer1M = entry.cacheRead;
  if (entry.cacheWrite !== undefined) pricing.cacheWritePer1M = entry.cacheWrite;
  if (entry.longContext) {
    pricing.longContext = {
      thresholdTokens: entry.longContext.threshold,
      inputPer1M: entry.longContext.input,
      outputPer1M: entry.longContext.output,
      ...(entry.longContext.cacheRead !== undefined
        ? { cachedInputPer1M: entry.longContext.cacheRead }
        : {}),
      ...(entry.longContext.cacheWrite !== undefined
        ? { cacheWritePer1M: entry.longContext.cacheWrite }
        : {}),
    };
  }
  return pricing;
}

/**
 * Resolve pricing for a model id in any shape (API id, OpenRouter id, Bedrock id,
 * CoWork catalog key). Returns null when the model is unknown.
 */
export function getModelPricing(
  modelId: string,
  providerType?: string | null,
): ModelPricing | null {
  const provider = String(providerType || "")
    .trim()
    .toLowerCase();
  if (LOCAL_PROVIDER_TYPES.has(provider)) return { inputPer1M: 0, outputPer1M: 0 };
  // OpenRouter ":free" routes and Ollama ":latest" tags are not billed per token.
  if (/:(?:free|latest)$/i.test(String(modelId || "").trim())) {
    return { inputPer1M: 0, outputPer1M: 0 };
  }

  for (const candidate of modelIdCandidates(modelId)) {
    const override = PRICING_OVERRIDES[candidate];
    if (override) return override;
    const entry = lookupModelMetadata(candidate);
    const pricing = entry ? fromMetadata(entry) : null;
    if (pricing) return pricing;
  }
  return null;
}

/** False when CoWork has no price for this model, so its cost is unknown (not $0). */
export function isModelPriced(modelId: string, providerType?: string | null): boolean {
  return getModelPricing(modelId, providerType) !== null;
}

/**
 * Image generation pricing (per image in USD)
 * Separate from token-based pricing for LLMs
 */
export const IMAGE_GENERATION_PRICING: Record<string, number> = {
  "gemini-2.5-flash-image": 0.02,
  "gemini-3-pro-image-preview": 0.04,
};

/**
 * Calculate the cost of an LLM API call.
 * @param modelId The model identifier
 * @param inputTokens Number of input tokens. May or may not include the cache
 *   counters below — see the inclusive/disjoint note in the body.
 * @param outputTokens Number of output tokens
 * @param cachedTokens Tokens served from the provider's prompt cache (billed at a discount)
 * @param cacheWriteTokens Tokens written to the provider's prompt cache (billed at a premium)
 * @returns Cost in USD
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  cacheTokenAccounting?: CacheTokenAccounting,
  cacheCostOptions?: CacheCostOptions,
): number {
  const basePricing = getModelPricing(modelId, cacheCostOptions?.providerType);

  // Unknown model: callers that need to distinguish "unpriced" from "free"
  // must check isModelPriced(); the numeric result stays 0 for compatibility.
  if (!basePricing) {
    return 0;
  }

  const normalizedModelId = String(modelId || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:openai-codex|openai)\//, "")
    .split("@", 1)[0];
  // Long-context tiers (e.g. GPT-6 above 272K input tokens) reprice the whole request.
  const tier = basePricing.longContext;
  const pricing: ModelPricing =
    tier && inputTokens > tier.thresholdTokens
      ? {
          inputPer1M: tier.inputPer1M,
          outputPer1M: tier.outputPer1M,
          cachedInputPer1M: tier.cachedInputPer1M ?? basePricing.cachedInputPer1M,
          cacheWritePer1M: tier.cacheWritePer1M ?? basePricing.cacheWritePer1M,
        }
      : basePricing;

  // Cached tokens are already counted in inputTokens but billed at a discount.
  // Discount rate varies by provider: Anthropic = 10% of input price, OpenAI/Azure = 50%.
  // Models with a known cachedInputPer1M use it; others fall back to 50% of inputPer1M.
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M * 0.5;
  const cacheWriteRate = resolveCacheWriteRate(pricing, normalizedModelId, cacheCostOptions);

  // Providers disagree on whether the cache counters live INSIDE inputTokens:
  //
  //   OpenAI/Azure — `prompt_tokens` is inclusive of
  //     `prompt_tokens_details.cached_tokens`, so the cached portion has to be
  //     subtracted out to avoid charging it twice.
  //   Anthropic    — `input_tokens`, `cache_read_input_tokens` and
  //     `cache_creation_input_tokens` are three DISJOINT counts. Subtracting
  //     there clamps a 100K cache read down to whatever tiny `input_tokens`
  //     was and bills it at ~$0, which is what made every Anthropic total and
  //     the budgetCost guard under-report by orders of magnitude.
  //
  // The counters not fitting inside inputTokens is the unambiguous signal that
  // they are disjoint; treat them as additive in that case.
  const safeCached = Math.max(0, cachedTokens);
  const safeCacheWrite = Math.max(0, cacheWriteTokens);
  const cacheCountersAreInclusive =
    cacheTokenAccounting === "inclusive"
      ? true
      : cacheTokenAccounting === "disjoint"
        ? false
        : safeCached + safeCacheWrite <= inputTokens;
  const regularInputTokens = cacheCountersAreInclusive
    ? inputTokens - safeCached - safeCacheWrite
    : inputTokens;
  const inputCost =
    (regularInputTokens / 1_000_000) * pricing.inputPer1M +
    (safeCached / 1_000_000) * cachedRate +
    (safeCacheWrite / 1_000_000) * cacheWriteRate;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return inputCost + outputCost;
}

function resolveCacheWriteRate(
  pricing: ModelPricing,
  normalizedModelId: string,
  options?: CacheCostOptions,
): number {
  const provider = String(options?.providerType || "")
    .trim()
    .toLowerCase();
  const anthropicRoute =
    provider === "anthropic" ||
    provider === "azure-anthropic" ||
    provider === "anthropic-compatible" ||
    provider === "bedrock" ||
    /(?:^|[./_-])(?:claude|anthropic)(?:[./_-]|$)/i.test(normalizedModelId);
  // Catalogue cache-write prices for Claude are the 5-minute rate; 1-hour writes cost 2x input.
  if (options && anthropicRoute && options.cacheTtl === "1h") return pricing.inputPer1M * 2;
  // An explicit zero is meaningful: GPT-5.4/GPT-5.5 cache writes are not
  // charged as a separate line item. Keep the table authoritative.
  if (pricing.cacheWritePer1M !== undefined) return pricing.cacheWritePer1M;
  // Preserve the legacy standalone helper behavior for callers that do not
  // know the provider route yet.
  if (!options) return pricing.inputPer1M;
  if (anthropicRoute) return pricing.inputPer1M * 1.25;

  // OpenAI's newer GPT-5.6+ models charge a premium for cache creation when
  // the table does not yet have a model-specific entry.
  const modernOpenAI = /^gpt-(?:[6-9]|5\.(?:6|[7-9]))(?:[.-]|$)/i.test(normalizedModelId);
  if (modernOpenAI) return pricing.inputPer1M * 1.25;

  // OpenAI-compatible routes generally inherit OpenAI's no-extra-write-fee
  // behavior for older models; unknown non-OpenAI providers retain the safer
  // legacy estimate of regular input pricing.
  if (
    provider === "openai" ||
    provider === "azure" ||
    provider === "openrouter" ||
    provider === "openai-compatible" ||
    provider === "pi"
  ) {
    return 0;
  }
  return pricing.inputPer1M;
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate the cost of image generation
 * @param modelId The image model identifier (e.g., 'gemini-3-pro-image-preview', 'imagen-3.0-fast-generate-001')
 * @param numberOfImages Number of images generated
 * @returns Cost in USD
 */
export function calculateImageCost(modelId: string, numberOfImages: number): number {
  const pricePerImage =
    IMAGE_GENERATION_PRICING[modelId] || IMAGE_GENERATION_PRICING[modelId.toLowerCase()];
  if (!pricePerImage) {
    // Default to common Gemini image pricing if unknown model
    return 0.03 * numberOfImages;
  }
  return pricePerImage * numberOfImages;
}

/**
 * Get image generation pricing info for a model
 * @param modelId The image model identifier
 * @returns Price per image in USD, or null if unknown
 */
export function getImagePricing(modelId: string): number | null {
  return (
    IMAGE_GENERATION_PRICING[modelId] || IMAGE_GENERATION_PRICING[modelId.toLowerCase()] || null
  );
}
