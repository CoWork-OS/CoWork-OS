import { OPENROUTER_FREE_MODEL_ID } from "../../shared/llm-provider-catalog";
import type { LLMSettingsData, OpenAIReasoningEffort, LLMTextVerbosity } from "../../shared/types";

export interface ClaudeCredentialInput {
  apiKey?: string;
  subscriptionToken?: string;
  authMethod: "api_key" | "subscription";
}

export function isClaudeSubscriptionToken(value?: string | null): boolean {
  return typeof value === "string" && value.includes("sk-ant-oat");
}

export function resolveClaudeAuthMethod(
  anthropic?: LLMSettingsData["anthropic"],
): "api_key" | "subscription" {
  if (anthropic?.authMethod) {
    return anthropic.authMethod;
  }
  if (anthropic?.subscriptionToken || isClaudeSubscriptionToken(anthropic?.apiKey)) {
    return "subscription";
  }
  return "api_key";
}

export function buildClaudeCredentialInput(
  anthropic?: LLMSettingsData["anthropic"] | null,
): ClaudeCredentialInput | undefined {
  if (!anthropic) return undefined;

  const apiKey = anthropic.apiKey?.trim() || undefined;
  const subscriptionToken = anthropic.subscriptionToken?.trim() || undefined;

  if (!apiKey && !subscriptionToken) {
    return undefined;
  }

  return {
    apiKey,
    subscriptionToken,
    authMethod: resolveClaudeAuthMethod({
      ...anthropic,
      apiKey,
      subscriptionToken,
    }),
  };
}

export function selectClaudeModelKey(
  providerModels: Array<{ key: string }>,
  currentModelKey?: string,
): string {
  if (currentModelKey && providerModels.some((model) => model.key === currentModelKey)) {
    return currentModelKey;
  }

  return providerModels[0]?.key || currentModelKey || "sonnet-4-5";
}

export function resolveOpenAIReasoningEffort(
  openai?: LLMSettingsData["openai"] | null,
): OpenAIReasoningEffort {
  const value = openai?.reasoningEffort;
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
    ? value
    : "medium";
}

export function resolveOpenAITextVerbosity(
  openai?: LLMSettingsData["openai"] | null,
): LLMTextVerbosity {
  const value = openai?.textVerbosity;
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

/**
 * The OpenRouter form after a browser sign-in. Main created and saved the key; the form shows
 * the stored key and the model main chose (the free router on a first sign-in).
 */
export function resolveOpenRouterSignIn(
  result: { model?: string },
  saved?: Pick<LLMSettingsData, "openrouter"> | null,
): { apiKey: string; model: string } {
  return {
    apiKey: saved?.openrouter?.apiKey || "",
    model: result.model || saved?.openrouter?.model || OPENROUTER_FREE_MODEL_ID,
  };
}
