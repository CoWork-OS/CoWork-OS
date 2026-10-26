import { createHash } from "node:crypto";
import { looksLikeSecretReference } from "../../../shared/secret-references";
import { resolveSecretValue } from "../../security/secret-references/resolver";
import type { LLMProvider, LLMProviderConfig, LLMRequest, LLMResponse } from "./types";

/** Provider config fields that hold an API key and may be a vault reference instead. */
export const PROVIDER_SECRET_FIELDS = [
  "anthropicApiKey",
  "awsAccessKeyId",
  "awsSecretAccessKey",
  "awsSessionToken",
  "ollamaApiKey",
  "geminiApiKey",
  "openrouterApiKey",
  "deepseekApiKey",
  "openaiApiKey",
  "azureApiKey",
  "azureAnthropicApiKey",
  "groqApiKey",
  "xaiApiKey",
  "kimiApiKey",
  "piApiKey",
  "openaiCompatibleApiKey",
  "providerApiKey",
] as const satisfies ReadonlyArray<keyof LLMProviderConfig>;

export function providerConfigHasSecretReferences(config: LLMProviderConfig): boolean {
  return PROVIDER_SECRET_FIELDS.some((field) => looksLikeSecretReference(config[field]));
}

/** A copy of the config with every vault reference replaced by the value it points to. */
export async function resolveProviderConfigSecrets(
  config: LLMProviderConfig,
  resolve: (value: string | undefined) => Promise<string | undefined> = resolveSecretValue,
): Promise<LLMProviderConfig> {
  const resolved: LLMProviderConfig = { ...config };
  await Promise.all(
    PROVIDER_SECRET_FIELDS.map(async (field) => {
      if (looksLikeSecretReference(config[field])) resolved[field] = await resolve(config[field]);
    }),
  );
  return resolved;
}

function fingerprint(config: LLMProviderConfig): string {
  const hash = createHash("sha256");
  for (const field of PROVIDER_SECRET_FIELDS) hash.update(`${field}=${config[field] ?? ""}\n`);
  return hash.digest("hex");
}

/**
 * Provider creation is synchronous, but reading a vault is not. The returned provider reads its
 * references on each request (the resolver caches them briefly), builds the real provider with
 * the values, and rebuilds it when a value changes. A reference that can't be read fails the
 * request with the resolver's explanation.
 */
export function wrapProviderWithSecretReferences(
  config: LLMProviderConfig,
  build: (resolved: LLMProviderConfig) => LLMProvider,
  resolve?: (value: string | undefined) => Promise<string | undefined>,
): LLMProvider {
  let current: { key: string; provider: LLMProvider } | null = null;
  const provider = async (): Promise<LLMProvider> => {
    const resolved = await resolveProviderConfigSecrets(config, resolve);
    const key = fingerprint(resolved);
    if (!current || current.key !== key) current = { key, provider: build(resolved) };
    return current.provider;
  };
  return {
    type: config.type,
    async createMessage(request: LLMRequest): Promise<LLMResponse> {
      return (await provider()).createMessage(request);
    },
    async testConnection() {
      try {
        return await (await provider()).testConnection();
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
