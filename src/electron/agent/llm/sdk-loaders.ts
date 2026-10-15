import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

/**
 * The OpenAI, Anthropic and Bedrock SDKs are several hundred module files together. They
 * load when a provider sends its first request rather than at app start, which otherwise
 * read and compiled all of them before the first window.
 */
export async function loadAnthropicSdk(): Promise<typeof Anthropic> {
  return (await import("@anthropic-ai/sdk")).default;
}

export async function loadOpenAISdk(): Promise<typeof OpenAI> {
  return (await import("openai")).default;
}

export function loadBedrockRuntimeSdk() {
  return import("@aws-sdk/client-bedrock-runtime");
}

export function loadAwsIniCredentialProvider() {
  return import("@aws-sdk/credential-provider-ini");
}

/**
 * Creates a client the first time it is asked for and shares it afterwards. A failed
 * load or construction is not cached, so the next request tries again.
 */
export function lazyClient<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= create().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
