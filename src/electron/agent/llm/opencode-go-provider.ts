import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import { FABLE_5_2_MODEL, isGpt62Model } from "../../../shared/llm-provider-catalog";
import { LLMProvider, LLMProviderType, LLMRequest, LLMResponse } from "./types";
import type { ProviderDiagnosticFetch } from "./provider-diagnostic-fetch";
import {
  getOpenCodeModelTransport,
  isOpenCodeGoBaseUrl,
  isOpenCodeZenBaseUrl,
  normalizeOpenCodeGoAnthropicBaseUrl,
  normalizeOpenCodeGoModelId,
  type OpenCodeProduct,
} from "./opencode-go-routing";

export interface OpenCodeProviderOptions {
  diagnosticFetch?: ProviderDiagnosticFetch;
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
  private zenGpt62Provider?: OpenAIProvider;
  private zenFable52Provider?: AnthropicCompatibleProvider;
  private product: OpenCodeProduct;
  private diagnosticFetch?: ProviderDiagnosticFetch;

  constructor(options: OpenCodeProviderOptions) {
    this.diagnosticFetch = options.diagnosticFetch;
    this.type = options.type;
    this.defaultModel = options.defaultModel;
    this.product = isOpenCodeGoBaseUrl(options.baseUrl) ? "go" : "zen";
    // OpenCode serves hosted models that return native tool calls; text that
    // looks like a call is not recovered here.
    this.openaiProvider = new OpenAICompatibleProvider({ ...options, textToolCallFallback: false });
    const baseUrl = normalizeOpenCodeGoAnthropicBaseUrl(options.baseUrl);
    this.anthropicProvider = new AnthropicCompatibleProvider({
      ...options,
      baseUrl,
      defaultModel: normalizeOpenCodeGoModelId(options.defaultModel),
    });
    const responsesConfig = {
      type: "openai",
      model: normalizeOpenCodeGoModelId(options.defaultModel),
      openaiApiKey: options.apiKey,
      openaiBaseUrl: baseUrl,
      openaiResponsesApi: true,
    } as const;
    this.responsesProvider = new OpenAIProvider(responsesConfig);
    if (isOpenCodeZenBaseUrl(baseUrl)) {
      this.zenGpt62Provider = new OpenAIProvider({
        ...responsesConfig,
        openaiBaseUrl: "https://opencode.ai/inference/openai/v1",
      });
      this.zenFable52Provider = new AnthropicCompatibleProvider({
        ...options,
        defaultModel: FABLE_5_2_MODEL.id,
        baseUrl: "https://opencode.ai/inference/anthropic/v1",
        sendThinkingConfig: true,
      });
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const model = normalizeOpenCodeGoModelId(request.model || this.defaultModel);
    return this.getModelProvider(model).createMessage({ ...request, model });
  }

  private getModelProvider(model: string): LLMProvider {
    if (this.zenGpt62Provider && isGpt62Model(model)) return this.zenGpt62Provider;
    if (this.zenFable52Provider && model === FABLE_5_2_MODEL.id) return this.zenFable52Provider;
    switch (getOpenCodeModelTransport(model, this.product)) {
      case "responses":
        return this.responsesProvider;
      case "messages":
        return this.anthropicProvider;
      default:
        return this.openaiProvider;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (this.diagnosticFetch) {
      // The Responses SDK does not use the host diagnostic transport. Verify
      // browser connectivity through the same bounded model endpoint instead.
      const models = await this.openaiProvider.getAvailableModels();
      return models.length
        ? { success: true }
        : { success: false, error: "Provider model discovery failed or returned no models." };
    }
    return this.getModelProvider(normalizeOpenCodeGoModelId(this.defaultModel)).testConnection();
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
