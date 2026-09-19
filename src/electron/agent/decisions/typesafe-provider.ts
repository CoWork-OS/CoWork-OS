import { HttpDecisionProvider, type HttpDecisionProviderOptions } from "./decision-provider";
import { resolveDecisionEndpoint } from "./endpoint-utils";

export const TYPESAFE_DECISION_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type TypeSafeDecisionProviderOptions = Omit<
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
  options: string | TypeSafeDecisionProviderOptions,
): HttpDecisionProviderOptions {
  const resolved = typeof options === "string" ? { apiKey: options } : options;
  return {
    ...resolved,
    endpoint: resolveDecisionEndpoint(
      resolved.endpoint,
      resolved.baseUrl ?? resolved.baseURL,
      TYPESAFE_DECISION_ENDPOINT,
      "/v1/systemone",
    ),
    providerName: "TypeSafe",
    defaultModel: resolved.defaultModel ?? resolved.model ?? TYPESAFE_DEFAULT_MODEL,
  };
}

export class TypeSafeDecisionProvider extends HttpDecisionProvider {
  constructor(options: string | TypeSafeDecisionProviderOptions) {
    super(resolveOptions(options));
  }
}

export const TypeSafeTransport = TypeSafeDecisionProvider;
export const TypeSafeJevProvider = TypeSafeDecisionProvider;
