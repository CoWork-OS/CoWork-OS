import type { ModelPricing } from "./pricing";

/**
 * Hand-maintained pricing exceptions. Everything else comes from the generated
 * models.dev snapshot (src/shared/model-metadata.json, `npm run models:sync`).
 *
 * Only two kinds of entries belong here, and pricing-coverage.test.ts enforces it:
 *  - retired models the catalogue no longer lists but saved settings may still use;
 *  - deliberate overrides of a catalogue price, listed in INTENTIONAL_OVERRIDES
 *    with the reason.
 * Keys are matched with the same exact-candidate rules as the snapshot, so a
 * dated id such as "claude-3-5-sonnet-20241022" resolves to "claude-3-5-sonnet".
 */
export const PRICING_OVERRIDES: Record<string, ModelPricing> = {
  // Retired Anthropic models (list prices at retirement).
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  "claude-3-5-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
  "claude-3-opus": { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  "claude-3-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25, cachedInputPer1M: 0.025 },

  // Retired Google and OpenAI models.
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-pro-1.5": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "o1-mini": { inputPer1M: 3.0, outputPer1M: 12.0 },
  "o1-preview": { inputPer1M: 15.0, outputPer1M: 60.0 },
  "llama-3.1-405b-instruct": { inputPer1M: 3.0, outputPer1M: 3.0 },

  // Image generation is billed per image by calculateImageCost(); pricing the
  // same call per token as well would double-count it.
  "gemini-2.5-flash-image": { inputPer1M: 0, outputPer1M: 0 },
  "gemini-3-pro-image-preview": { inputPer1M: 0, outputPer1M: 0 },
};

/** Overrides that intentionally shadow a catalogue price, with the reason. */
export const INTENTIONAL_OVERRIDES: Record<string, string> = {
  "gemini-2.5-flash-image": "billed per image by calculateImageCost()",
  "gemini-3-pro-image-preview": "billed per image by calculateImageCost()",
};

/** Providers that run on the user's machine and never bill per token. */
export const LOCAL_PROVIDER_TYPES = new Set(["ollama", "mlx", "atomic-chat"]);
