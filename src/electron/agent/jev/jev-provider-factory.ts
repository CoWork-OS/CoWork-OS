import type { LLMSettingsData, JevSettingsData } from "../../../shared/types";
import {
  OpenRouterDecisionProvider,
  OPENROUTER_DECISION_ENDPOINT,
  OPENROUTER_DEFAULT_MODEL,
  TypeSafeDecisionProvider,
  TYPESAFE_DECISION_ENDPOINT,
  TYPESAFE_DEFAULT_MODEL,
  type DecisionProvider,
  type DecisionFetch,
  type DecisionSleep,
} from "../decisions";
import { normalizeDecisionApiKey } from "../decisions/http-client";

const TYPESAFE_PATH = "/v1/systemone";
const OPENROUTER_PATH = "/api/alpha/decisions";

export interface JevProviderResolution {
  provider: DecisionProvider;
  providerType: "typesafe" | "openrouter";
  model: string;
}

export interface JevProviderFactoryOptions {
  fetch?: DecisionFetch;
  fetchImpl?: DecisionFetch;
  sleep?: DecisionSleep;
}

export function isConfiguredJevDecisionLayerEnabled(settings: JevSettingsData): boolean {
  return (
    settings.enabled === true &&
    (settings.teamSelectionEnabled === true ||
      (settings.harnessEnabled === true &&
        (settings.toolReviewMode === "observe" || settings.toolReviewMode === "active")))
  );
}

/**
 * Active mode is intentionally narrower than merely having a Jev provider.
 * It is the opt-in contract that allows bounded harness decisions to influence
 * routing or escalation. Deterministic policy, permissions, and security are
 * still evaluated separately and remain authoritative.
 */
export function isJevActiveHarnessEnabled(settings: JevSettingsData): boolean {
  return (
    settings.enabled === true &&
    settings.harnessEnabled === true &&
    settings.toolReviewMode === "active"
  );
}

function resolveEndpoint(
  baseUrl: string | undefined,
  path: string,
  defaultEndpoint: string,
): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, "");
  if (!normalized) return defaultEndpoint;
  if (normalized.endsWith(path)) return normalized;

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname === "/api/v1" || parsed.pathname === "/v1") {
      parsed.pathname = path;
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // IPC validation rejects malformed URLs before this factory is called.
  }

  return `${normalized}${path}`;
}

function resolveProviderSettings(
  settings: JevSettingsData,
  mainOpenRouterApiKey?: string,
): {
  providerType: "typesafe" | "openrouter";
  apiKey?: string;
  endpoint: string;
  model: string;
  usesMainOpenRouterKey: boolean;
} {
  const providerType = settings.provider ?? "typesafe";
  if (providerType === "openrouter") {
    const openrouter = settings.openrouter;
    // When main-key reuse is enabled, the adjacent OpenRouter provider key is
    // authoritative. Ignore any legacy Jev-specific key so users do not need
    // to maintain two credentials for the same OpenRouter account.
    const usesMainOpenRouterKey = openrouter?.reuseOpenRouterKey === true;
    const explicitApiKey =
      !usesMainOpenRouterKey && openrouter?.apiKey
        ? normalizeDecisionApiKey(openrouter.apiKey)
        : undefined;
    return {
      providerType,
      apiKey:
        explicitApiKey ||
        (usesMainOpenRouterKey && mainOpenRouterApiKey
          ? normalizeDecisionApiKey(mainOpenRouterApiKey)
          : undefined),
      endpoint: resolveEndpoint(openrouter?.baseUrl, OPENROUTER_PATH, OPENROUTER_DECISION_ENDPOINT),
      model: openrouter?.model?.trim() || OPENROUTER_DEFAULT_MODEL,
      usesMainOpenRouterKey,
    };
  }

  const typesafe = settings.typesafe;
  return {
    providerType,
    apiKey: typesafe?.apiKey ? normalizeDecisionApiKey(typesafe.apiKey) : undefined,
    endpoint: resolveEndpoint(typesafe?.baseUrl, TYPESAFE_PATH, TYPESAFE_DECISION_ENDPOINT),
    model: typesafe?.model?.trim() || TYPESAFE_DEFAULT_MODEL,
    usesMainOpenRouterKey: false,
  };
}

function validateJevEndpoint(
  endpoint: string,
  providerType: "typesafe" | "openrouter",
  usesMainOpenRouterKey: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Jev endpoint must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Jev endpoints must use HTTPS.");
  }

  const expectedHostname = providerType === "openrouter" ? "openrouter.ai" : "api.typesafe.ai";
  if (
    parsed.hostname.toLowerCase() !== expectedHostname ||
    (parsed.port !== "" && parsed.port !== "443")
  ) {
    throw new Error(
      `${providerType === "openrouter" ? "OpenRouter" : "TypeSafe"} Jev endpoints must use the official provider host.`,
    );
  }

  if (
    usesMainOpenRouterKey &&
    (parsed.hostname.toLowerCase() !== "openrouter.ai" ||
      (parsed.port !== "" && parsed.port !== "443"))
  ) {
    throw new Error(
      "The saved main OpenRouter key may only be reused with the official https://openrouter.ai endpoint.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("Jev endpoints must not include embedded credentials.");
  }
}

export function createJevProvider(
  settings: JevSettingsData,
  mainOpenRouterApiKey?: string,
  factoryOptions: JevProviderFactoryOptions = {},
): JevProviderResolution {
  const resolved = resolveProviderSettings(settings, mainOpenRouterApiKey);
  validateJevEndpoint(resolved.endpoint, resolved.providerType, resolved.usesMainOpenRouterKey);
  if (!resolved.apiKey) {
    const label = resolved.providerType === "openrouter" ? "OpenRouter" : "TypeSafe";
    throw new Error(`${label} API key is required for Jev.`);
  }

  const options = {
    apiKey: resolved.apiKey,
    endpoint: resolved.endpoint,
    model: resolved.model,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    ...factoryOptions,
  };
  const provider =
    resolved.providerType === "openrouter"
      ? new OpenRouterDecisionProvider(options)
      : new TypeSafeDecisionProvider(options);

  return {
    provider,
    providerType: resolved.providerType,
    model: resolved.model,
  };
}

export function createConfiguredJevProvider(
  settings: Pick<LLMSettingsData, "jev" | "openrouter">,
): JevProviderResolution | null {
  if (!settings.jev || !isConfiguredJevDecisionLayerEnabled(settings.jev)) return null;
  return createJevProvider(settings.jev, settings.openrouter?.apiKey);
}

export async function testJevProvider(
  settings: JevSettingsData,
  mainOpenRouterApiKey?: string,
  factoryOptions: JevProviderFactoryOptions = {},
): Promise<{
  success: boolean;
  provider: "typesafe" | "openrouter";
  model?: string;
  latencyMs: number;
  error?: string;
}> {
  const resolved = createJevProvider(settings, mainOpenRouterApiKey, factoryOptions);
  const startedAt = Date.now();
  const result = await resolved.provider.testConnection();
  return {
    success: result.success,
    provider: resolved.providerType,
    model: result.model || resolved.model,
    latencyMs: Math.max(0, Date.now() - startedAt),
    ...(result.error ? { error: result.error } : {}),
  };
}
