import { CUSTOM_PROVIDER_CATALOG } from "../../../shared/llm-provider-catalog";
import type { LLMSettingsData } from "../../../shared/types";

export const PROVIDER_DEFAULT_BASE_URLS = {
  ollama: "http://localhost:11434",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  kimi: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com",
} as const;

const AUTH_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "subscriptiontoken",
  "bearertoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "credential",
]);

export function isCredentialQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    AUTH_QUERY_KEYS.has(normalized) ||
    /(?:apikey|token|authorization|password|secret|credential)$/.test(normalized)
  );
}

function destination(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    // Snapshot keys: deleting entries while iterating the live params can skip the next secret.
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const key of [...parsed.searchParams.keys()]) {
      if (isCredentialQueryKey(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    // Providers append operation paths after removing a trailing slash.
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function sameCredentialDestination(left?: string, right?: string): boolean {
  if (!left?.trim() && !right?.trim()) return true;
  const target = destination(left);
  return target !== undefined && target === destination(right);
}

export class CredentialDestinationError extends Error {
  constructor(label: string) {
    super(
      `${label} endpoint changed. Enter a replacement credential for the new endpoint or keep the saved endpoint.`,
    );
    this.name = "CredentialDestinationError";
  }
}

function changedDestination(label: string): never {
  throw new CredentialDestinationError(label);
}

/** A blank credential may reuse a saved key only at that key's saved destination. */
export function resolveEndpointCredential(options: {
  explicit?: string;
  saved?: string;
  endpoint?: string;
  savedEndpoint?: string;
  defaultEndpoint?: string;
  label: string;
}): string | undefined {
  const explicit = options.explicit?.trim();
  if (explicit) return explicit;
  const saved = options.saved?.trim();
  if (!saved) return undefined;
  if (
    !sameCredentialDestination(
      options.endpoint?.trim() || options.defaultEndpoint,
      options.savedEndpoint?.trim() || options.defaultEndpoint,
    )
  )
    changedDestination(options.label);
  return saved;
}

function valueAt(settings: unknown, path: string[]): string | undefined {
  let value = settings;
  for (const key of path) {
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Records explicit caller credentials, never the credentials added by a host merge. */
export function explicitCredentialPaths(value: unknown, path: string[] = []): Set<string> {
  const paths = new Set<string>();
  if (!value || typeof value !== "object") return paths;
  for (const [key, entry] of Object.entries(value)) {
    const nested = [...path, key];
    if (
      typeof entry === "string" &&
      entry.trim() &&
      /^(?:apiKey|imageApiKey|videoApiKey|accessToken|refreshToken|idToken)$/.test(key)
    ) {
      paths.add(JSON.stringify(nested));
    } else if (entry && typeof entry === "object") {
      for (const candidate of explicitCredentialPaths(entry, nested)) paths.add(candidate);
    }
  }
  return paths;
}

type Binding = { path: string[]; endpoint?: string; label: string };

function settingsBindings(settings: LLMSettingsData): Binding[] {
  const bindings: Binding[] = [];
  const add = (path: string[], endpoint: string | undefined, label: string) => {
    if (valueAt(settings, path)) bindings.push({ path, endpoint, label });
  };
  for (const [provider, defaultUrl] of Object.entries(PROVIDER_DEFAULT_BASE_URLS)) {
    const endpoint = valueAt(settings, [provider, "baseUrl"]) || defaultUrl;
    add([provider, "apiKey"], endpoint, provider);
    if (provider === "xai") {
      add([provider, "accessToken"], endpoint, provider);
      add([provider, "refreshToken"], endpoint, provider);
    }
  }
  for (const provider of ["azure", "azureAnthropic", "openaiCompatible"]) {
    add(
      [provider, "apiKey"],
      valueAt(settings, [provider, provider.startsWith("azure") ? "endpoint" : "baseUrl"]),
      provider,
    );
  }
  for (const provider of Object.keys(settings.customProviders ?? {})) {
    const canonical = provider === "kimi-coding" ? "kimi-code" : provider;
    const endpoint =
      settings.customProviders?.[provider]?.baseUrl?.trim() ||
      CUSTOM_PROVIDER_CATALOG.find((entry) => entry.id === canonical)?.baseUrl;
    add(["customProviders", provider, "apiKey"], endpoint, `Custom provider ${provider}`);
  }
  for (const [group, provider, credential, urlField, parent, parentUrl, defaultUrl] of [
    [
      "imageGeneration",
      "openrouter",
      "apiKey",
      "baseUrl",
      "openrouter",
      "baseUrl",
      PROVIDER_DEFAULT_BASE_URLS.openrouter,
    ],
    ["imageGeneration", "azure", "imageApiKey", "imageEndpoint", "azure", "endpoint", undefined],
    ["videoGeneration", "azure", "videoApiKey", "videoEndpoint", "azure", "endpoint", undefined],
  ] as const) {
    const ownPath = [group, provider, credential];
    const path = valueAt(settings, ownPath) ? ownPath : [parent, "apiKey"];
    add(
      path,
      valueAt(settings, [group, provider, urlField]) ||
        valueAt(settings, [parent, parentUrl]) ||
        defaultUrl,
      `${group} ${provider}`,
    );
  }
  add(
    ["videoGeneration", "kling", "apiKey"],
    settings.videoGeneration?.kling?.baseUrl?.trim() || "https://api.klingai.com",
    "Kling",
  );
  return bindings;
}

/** Validate the completed host merge so omitted or deleted fields cannot restore a secret. */
export function assertSettingsCredentialDestinations(
  next: LLMSettingsData,
  saved: LLMSettingsData,
  replacements: ReadonlySet<string> = new Set(),
): void {
  const previousBindings = settingsBindings(saved);
  for (const binding of settingsBindings(next)) {
    const path = JSON.stringify(binding.path);
    const credential = valueAt(next, binding.path);
    if (replacements.has(path) || credential !== valueAt(saved, binding.path)) continue;
    const allowed = previousBindings.some(
      (previous) =>
        JSON.stringify(previous.path) === path &&
        sameCredentialDestination(binding.endpoint, previous.endpoint),
    );
    if (!allowed) changedDestination(binding.label);
  }
}
