import { HttpDecisionProvider, type HttpDecisionProviderOptions } from "./decision-provider";
import { resolveDecisionEndpoint } from "./endpoint-utils";

export const OPENROUTER_DECISION_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DEFAULT_MODEL = "~typesafe/jev-latest";

export type OpenRouterDecisionProviderOptions = Omit<
  HttpDecisionProviderOptions,
  "endpoint" | "providerName" | "defaultModel"
> & {
  endpoint?: string;
  baseUrl?: string;
  baseURL?: string;
  model?: string;
  defaultModel?: string;
};

function resolveOptions(
  options: string | OpenRouterDecisionProviderOptions,
): HttpDecisionProviderOptions {
  const resolved = typeof options === "string" ? { apiKey: options } : options;
  return {
    ...resolved,
    endpoint: resolveDecisionEndpoint(
      resolved.endpoint,
      resolved.baseUrl ?? resolved.baseURL,
      OPENROUTER_DECISION_ENDPOINT,
      "/api/alpha/decisions",
    ),
    providerName: "OpenRouter",
    defaultModel: resolved.defaultModel ?? resolved.model ?? OPENROUTER_DEFAULT_MODEL,
  };
}

export class OpenRouterDecisionProvider extends HttpDecisionProvider {
  constructor(options: string | OpenRouterDecisionProviderOptions) {
    super(resolveOptions(options));
  }
}

export const OpenRouterTransport = OpenRouterDecisionProvider;
export const OpenRouterJevProvider = OpenRouterDecisionProvider;
