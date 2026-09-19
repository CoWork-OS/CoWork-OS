import { DecisionClientError, type DecisionFetch, type DecisionSleep } from "./http-client";
import {
  OpenRouterDecisionProvider,
  type OpenRouterDecisionProviderOptions,
} from "./openrouter-provider";
import { type DecisionProvider } from "./decision-provider";
import {
  TypeSafeDecisionProvider,
  type TypeSafeDecisionProviderOptions,
} from "./typesafe-provider";

export type JevProviderKind = "typesafe" | "openrouter";

/** Shape a settings/IPC layer can map its persisted Jev settings onto. */
export interface StoredJevSettings {
  provider?: JevProviderKind | "type-safe" | "open-router";
  jevProvider?: JevProviderKind | "type-safe" | "open-router";
  apiKey?: string;
  jevApiKey?: string;
  typesafeApiKey?: string;
  openrouterApiKey?: string;
  openRouterApiKey?: string;
  model?: string;
  defaultModel?: string;
  endpoint?: string;
  baseUrl?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface JevProviderFactoryOptions {
  fetch?: DecisionFetch;
  fetchImpl?: DecisionFetch;
  sleep?: DecisionSleep;
}

function normalizeProvider(value: StoredJevSettings["provider"]): JevProviderKind {
  switch (value) {
    case undefined:
    case "typesafe":
    case "type-safe":
      return "typesafe";
    case "openrouter":
    case "open-router":
      return "openrouter";
    default:
      throw new DecisionClientError(
        "configuration",
        `Unsupported Jev provider "${String(value)}". Use "typesafe" or "openrouter".`,
        { provider: "Jev" },
      );
  }
}

function requiredKey(provider: JevProviderKind, settings: StoredJevSettings): string {
  const key =
    provider === "openrouter"
      ? (settings.openrouterApiKey ??
        settings.openRouterApiKey ??
        settings.apiKey ??
        settings.jevApiKey)
      : (settings.typesafeApiKey ?? settings.apiKey ?? settings.jevApiKey);
  if (!key?.trim()) {
    const label = provider === "openrouter" ? "OpenRouter" : "TypeSafe";
    throw new DecisionClientError(
      "configuration",
      `${label} API key is required in the stored Jev settings.`,
      { provider: label },
    );
  }
  return key;
}

function commonOptions(
  settings: StoredJevSettings,
  factoryOptions: JevProviderFactoryOptions,
): Pick<
  TypeSafeDecisionProviderOptions & OpenRouterDecisionProviderOptions,
  | "fetch"
  | "fetchImpl"
  | "sleep"
  | "endpoint"
  | "baseUrl"
  | "baseURL"
  | "model"
  | "defaultModel"
  | "timeoutMs"
  | "maxRetries"
  | "retryDelayMs"
> {
  return {
    fetch: factoryOptions.fetch,
    fetchImpl: factoryOptions.fetchImpl,
    sleep: factoryOptions.sleep,
    endpoint: settings.endpoint,
    baseUrl: settings.baseUrl,
    baseURL: settings.baseURL,
    model: settings.model,
    defaultModel: settings.defaultModel,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    retryDelayMs: settings.retryDelayMs,
  };
}

export function createDecisionProvider(
  settings: StoredJevSettings,
  factoryOptions: JevProviderFactoryOptions = {},
): DecisionProvider {
  const provider = normalizeProvider(settings.provider ?? settings.jevProvider);
  const options = commonOptions(settings, factoryOptions);
  if (provider === "openrouter") {
    return new OpenRouterDecisionProvider({
      ...options,
      apiKey: requiredKey(provider, settings),
    });
  }
  return new TypeSafeDecisionProvider({
    ...options,
    apiKey: requiredKey(provider, settings),
  });
}

export const createJevDecisionProvider = createDecisionProvider;
