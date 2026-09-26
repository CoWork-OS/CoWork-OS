/**
 * Transforms the models.dev catalogue (https://models.dev/api.json) into the compact
 * model-metadata format. Shared by scripts/sync-model-metadata.mjs (bundled snapshot)
 * and the opt-in in-app refresh, so both produce identical data.
 *
 * Kept free of imports and non-erasable TypeScript so Node can run it directly.
 */
import type { ModelMetadataEntry } from "./model-metadata";

export const MODELS_DEV_URL = "https://models.dev/api.json";

// Providers CoWork can route to, in precedence order. When the same model id
// appears under several providers, the first (first-party) listing wins.
export const PROVIDER_PRECEDENCE = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "zai",
  "zhipuai",
  "moonshotai",
  "alibaba",
  "minimax",
  "mistral",
  "groq",
  "cerebras",
  "amazon-bedrock",
  "azure",
  "openrouter",
  "opencode-go",
  "huggingface",
];

type Catalogue = Record<string, { models?: Record<string, CatalogueModel> } | undefined>;

interface CatalogueTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type?: string; size?: number };
}

interface CatalogueModel {
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: CatalogueTier[];
  };
  limit?: { context?: number; output?: number };
}

function roundPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1e6) / 1e6
    : undefined;
}

function toEntry(model: CatalogueModel, provider: string): ModelMetadataEntry | null {
  const cost = model.cost || {};
  const limit = model.limit || {};
  const entry: ModelMetadataEntry = { provider };
  const input = roundPrice(cost.input);
  const output = roundPrice(cost.output);
  if (input !== undefined && output !== undefined) {
    entry.input = input;
    entry.output = output;
    const cacheRead = roundPrice(cost.cache_read);
    const cacheWrite = roundPrice(cost.cache_write);
    if (cacheRead !== undefined) entry.cacheRead = cacheRead;
    if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
    const tier = Array.isArray(cost.tiers)
      ? cost.tiers.find((t) => t?.tier?.type === "context" && Number(t.tier.size) > 0)
      : undefined;
    if (tier) {
      entry.longContext = {
        threshold: Number(tier.tier?.size),
        input: roundPrice(tier.input) ?? input,
        output: roundPrice(tier.output) ?? output,
      };
      const tierCacheRead = roundPrice(tier.cache_read);
      const tierCacheWrite = roundPrice(tier.cache_write);
      if (tierCacheRead !== undefined) entry.longContext.cacheRead = tierCacheRead;
      if (tierCacheWrite !== undefined) entry.longContext.cacheWrite = tierCacheWrite;
    }
  }
  if (Number(limit.context) > 0) entry.context = Number(limit.context);
  if (Number(limit.output) > 0) entry.maxOutput = Number(limit.output);
  return entry.input === undefined && entry.context === undefined ? null : entry;
}

/** Build the lowercase-keyed, sorted model map from a models.dev catalogue. */
export function buildModelMetadata(catalogue: unknown): Record<string, ModelMetadataEntry> {
  const source = (catalogue && typeof catalogue === "object" ? catalogue : {}) as Catalogue;
  const models: Record<string, ModelMetadataEntry> = {};
  for (const provider of PROVIDER_PRECEDENCE) {
    const listing = source[provider]?.models;
    if (!listing || typeof listing !== "object") continue;
    for (const [id, model] of Object.entries(listing)) {
      const key = id.trim().toLowerCase();
      if (!key || models[key] || !model || typeof model !== "object") continue;
      const entry = toEntry(model, provider);
      if (entry) models[key] = entry;
    }
  }
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
}
