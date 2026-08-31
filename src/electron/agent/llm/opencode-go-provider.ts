import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import { LLMProvider, LLMProviderType, LLMRequest, LLMResponse } from "./types";
import {
  getOpenCodeModelTransport,
  isOpenCodeGoBaseUrl,
  normalizeOpenCodeGoAnthropicBaseUrl,
  normalizeOpenCodeGoModelId,
  type OpenCodeProduct,
} from "./opencode-go-routing";

export interface OpenCodeProviderOptions {
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

export class OpenCodeProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private defaultModel: string;
  private openaiProvider: OpenAICompatibleProvider;
  private anthropicProvider: AnthropicCompatibleProvider;
  private responsesProvider: OpenAIProvider;
  private product: OpenCodeProduct;

  constructor(options: OpenCodeProviderOptions) {
    this.type = options.type;
    this.defaultModel = options.defaultModel;
    this.product = isOpenCodeGoBaseUrl(options.baseUrl) ? "go" : "zen";
    this.openaiProvider = new OpenAICompatibleProvider(options);
    const baseUrl = normalizeOpenCodeGoAnthropicBaseUrl(options.baseUrl);
    this.anthropicProvider = new AnthropicCompatibleProvider({
      ...options,
      baseUrl,
      defaultModel: normalizeOpenCodeGoModelId(options.defaultModel),
    });
    this.responsesProvider = new OpenAIProvider({
      type: "openai",
      model: normalizeOpenCodeGoModelId(options.defaultModel),
      openaiApiKey: options.apiKey,
      openaiBaseUrl: baseUrl,
      openaiResponsesApi: true,
    });
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const normalizedModel = normalizeOpenCodeGoModelId(model);
    switch (getOpenCodeModelTransport(normalizedModel, this.product)) {
      case "responses":
        return this.responsesProvider.createMessage({
          ...request,
          model: normalizedModel,
        });
      case "messages":
        return this.anthropicProvider.createMessage({
          ...request,
          model: normalizedModel,
        });
      default:
        return this.openaiProvider.createMessage({
          ...request,
          model: normalizedModel,
        });
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    switch (getOpenCodeModelTransport(this.defaultModel, this.product)) {
      case "responses":
        return this.responsesProvider.testConnection();
      case "messages":
        return this.anthropicProvider.testConnection();
      default:
        return this.openaiProvider.testConnection();
    }
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    // OpenCode's Gemini entries use the Google Generative AI surface, which is
    // intentionally not advertised until CoWork has a matching adapter.
    const models = await this.openaiProvider.getAvailableModels();
    return models.filter((model) => !model.id.toLowerCase().startsWith("gemini-"));
  }
}

// Kept as an export alias for integrations that used the earlier Go-only name.
export const OpenCodeGoProvider = OpenCodeProvider;
export type OpenCodeGoProviderOptions = OpenCodeProviderOptions;
