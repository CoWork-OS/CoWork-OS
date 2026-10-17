/**
 * Kimi (Moonshot) model facts shared by the main process, Settings and onboarding.
 *
 * Source: https://platform.kimi.ai/docs/models.md and
 * https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-10-17).
 */

/** Default model for the built-in Kimi provider and the Moonshot catalog entry. */
export const KIMI_DEFAULT_MODEL = "kimi-k3";

/** Moonshot API model ids the platform serves today. */
export const KIMI_CURRENT_MODEL_IDS = [
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
] as const;

/** Kimi Code (coding plan) model ids; the plan uses its own keys and endpoint. */
export const KIMI_CODE_MODEL_IDS = [
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3",
  "k3-256k",
] as const;

export interface DiscontinuedKimiModel {
  replacement: string;
  discontinuedOn: string;
}

/**
 * Models Moonshot no longer serves. Thinking and flagship models move to K3;
 * the general-purpose and turbo K2 / moonshot-v1 models move to K2.6, the
 * current non-flagship model with thinking that can be turned off.
 */
const DISCONTINUED_KIMI_MODELS: Record<string, DiscontinuedKimiModel> = {
  "kimi-k2.5": { replacement: "kimi-k3", discontinuedOn: "2026-08-31" },
  "kimi-k2-thinking": { replacement: "kimi-k3", discontinuedOn: "2026-05-25" },
  "kimi-k2-thinking-turbo": { replacement: "kimi-k3", discontinuedOn: "2026-05-25" },
  "kimi-k2-0905-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-05-25" },
  "kimi-k2-0711-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-05-25" },
  "kimi-k2-turbo-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-05-25" },
  "kimi-latest": { replacement: "kimi-k3", discontinuedOn: "2026-01-28" },
  "kimi-thinking-preview": { replacement: "kimi-k3", discontinuedOn: "2025-11-11" },
  "moonshot-v1-8k": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-32k": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-128k": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-auto": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-8k-vision-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-32k-vision-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
  "moonshot-v1-128k-vision-preview": { replacement: "kimi-k2.6", discontinuedOn: "2026-08-31" },
};

/** Lowercase model id without a router prefix ("moonshotai/") or variant (":thinking"). */
export function kimiBareModelId(model: string): string {
  const normalized = model.toLowerCase().trim();
  const bare = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
}

/** The discontinued-model record for a Moonshot API model id, if it was retired. */
export function getDiscontinuedKimiModel(model: string): DiscontinuedKimiModel | undefined {
  const key = model.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DISCONTINUED_KIMI_MODELS, key)
    ? DISCONTINUED_KIMI_MODELS[key]
    : undefined;
}

/**
 * Map a discontinued Moonshot model id to its replacement. Only exact Moonshot
 * API ids are rewritten; router ids such as "moonshotai/kimi-k2.5" belong to
 * other providers that may still serve them.
 */
export function normalizeKimiModelId(model: string): string {
  return getDiscontinuedKimiModel(model)?.replacement ?? model;
}

/** Kimi models that take image input (K3, K2.6, K2.7 Code and the Kimi Code plan models). */
export function isKimiVisionModel(model: string): boolean {
  const bare = kimiBareModelId(model);
  return (
    bare === "kimi-k3" ||
    bare.startsWith("kimi-k3-") ||
    bare.startsWith("kimi-k3.") ||
    bare === "kimi-k2.6" ||
    bare.startsWith("kimi-k2.7") ||
    bare === "k3" ||
    bare === "k3-256k" ||
    bare.startsWith("kimi-for-coding")
  );
}

/**
 * Kimi models that think on tool turns and need every
 * assistant message sent back with its `reasoning_content`
 * (https://platform.kimi.ai/docs/guide/use-thinking-effort.md).
 */
export function requiresKimiReasoningReplay(model: string): boolean {
  const bare = kimiBareModelId(model);
  return (
    bare === "kimi-k3" ||
    bare.startsWith("kimi-k3-") ||
    bare.startsWith("kimi-k3.") ||
    bare.startsWith("kimi-k2.7") ||
    bare === "k3" ||
    bare === "k3-256k" ||
    bare.startsWith("kimi-for-coding")
  );
}
