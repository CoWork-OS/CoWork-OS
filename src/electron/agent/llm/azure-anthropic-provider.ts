/**
 * Azure Anthropic provider - uses Azure's OpenAI-compatible gateway for Anthropic models.
 * Endpoint format: https://<resource>.openai.azure.com/anthropic
 * API: Anthropic Messages API (x-api-key, anthropic-version: 2023-06-01)
 */
import type { LLMProvider, LLMProviderConfig } from "./types";
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  // If user entered Azure OpenAI resource URL (e.g. https://xxx.openai.azure.com),
  // append /anthropic for the Anthropic gateway
  if (
    trimmed &&
    !/\/anthropic(?:\/|$)/i.test(trimmed) &&
    /\.openai\.azure\.com$/i.test(trimmed)
  ) {
    return `${trimmed}/anthropic`;
  }
  return trimmed;
}

export class AzureAnthropicProvider implements LLMProvider {
  readonly type = "azure-anthropic" as const;
  private delegate: AnthropicCompatibleProvider;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.azureAnthropicApiKey?.trim() ?? "";
    const endpoint = config.azureAnthropicEndpoint?.trim() ?? "";
    const deployment = config.azureAnthropicDeployment?.trim() ?? config.model?.trim() ?? "";

    if (!apiKey) {
      throw new Error("Azure Anthropic API key is required. Configure it in Settings.");
    }
    if (!endpoint) {
      throw new Error("Azure Anthropic endpoint is required. Configure it in Settings.");
    }
    if (!deployment) {
      throw new Error("Azure Anthropic deployment/model name is required. Configure it in Settings.");
    }

    const baseUrl = normalizeEndpoint(endpoint);
    this.delegate = new AnthropicCompatibleProvider({
      type: "azure-anthropic",
      providerName: "Azure Anthropic",
      apiKey,
      baseUrl,
      defaultModel: deployment,
    });
  }

  async createMessage(request: Parameters<LLMProvider["createMessage"]>[0]) {
    return this.delegate.createMessage(request);
  }

  async testConnection() {
    return this.delegate.testConnection();
  }

  async getAvailableModels() {
    return this.delegate.getAvailableModels();
  }
}
