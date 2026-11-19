import { randomUUID } from "node:crypto";
import { GeminiProvider } from "./gemini-provider";
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import {
  FABLE_5_2_MODEL,
  GEMINI_NEON_MODEL,
  QWEN4_MAX_MODEL,
  isGpt62Model,
} from "../../../shared/llm-provider-catalog";
import { LLMProvider, LLMProviderType, LLMRequest, LLMResponse } from "./types";
import type { ProviderDiagnosticFetch } from "./provider-diagnostic-fetch";
import {
  getOpenCodeModelTransport,
  isOpenCodeGoBaseUrl,
  isOpenCodeZenBaseUrl,
  normalizeOpenCodeGoAnthropicBaseUrl,
  OPENCODE_SESSION_HEADER,
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
  private zenNeonProvider?: GeminiProvider;
  private goQwen4Provider?: AnthropicCompatibleProvider;
  private zenGpt62Provider?: OpenAIProvider;
  private zenFable52Provider?: AnthropicCompatibleProvider;
  private product: OpenCodeProduct;
  private diagnosticFetch?: ProviderDiagnosticFetch;
  /**
   * One id per provider instance. Each task builds its own provider, so every
   * request of a conversation (and a settings "Test") shares one session.
   */
  readonly sessionId: string;

  constructor(options: OpenCodeProviderOptions) {
    this.diagnosticFetch = options.diagnosticFetch;
    this.type = options.type;
    this.defaultModel = options.defaultModel;
    this.product = isOpenCodeGoBaseUrl(options.baseUrl) ? "go" : "zen";
    this.sessionId = randomUUID();
    const extraHeaders = { [OPENCODE_SESSION_HEADER]: this.sessionId };
    // OpenCode serves hosted models that return native tool calls; text that
    // looks like a call is not recovered here.
    this.openaiProvider = new OpenAICompatibleProvider({
      ...options,
      extraHeaders,
      textToolCallFallback: false,
    });
    const baseUrl = normalizeOpenCodeGoAnthropicBaseUrl(options.baseUrl);
    this.anthropicProvider = new AnthropicCompatibleProvider({
      ...options,
      extraHeaders,
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
    this.responsesProvider = new OpenAIProvider(responsesConfig, { defaultHeaders: extraHeaders });
    if (this.product === "go") {
      this.goQwen4Provider = new AnthropicCompatibleProvider({
        ...options,
        extraHeaders,
        defaultModel: QWEN4_MAX_MODEL.id,
        baseUrl: "https://opencode.ai/inference/go/anthropic/v1",
      });
    }
    if (isOpenCodeZenBaseUrl(baseUrl)) {
      if (options.apiKey)
        this.zenNeonProvider = new GeminiProvider(
          { type: "gemini", model: GEMINI_NEON_MODEL.id, geminiApiKey: options.apiKey },
          { baseUrl: "https://opencode.ai/inference/google" },
        );
      this.zenGpt62Provider = new OpenAIProvider(
        { ...responsesConfig, openaiBaseUrl: "https://opencode.ai/inference/openai/v1" },
        { defaultHeaders: extraHeaders },
      );
      this.zenFable52Provider = new AnthropicCompatibleProvider({
        ...options,
        extraHeaders,
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
    if (this.zenNeonProvider && model === GEMINI_NEON_MODEL.id) return this.zenNeonProvider;
    if (this.goQwen4Provider && model === QWEN4_MAX_MODEL.id) return this.goQwen4Provider;
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
    // Neon uses the Google GenerateContent endpoint in the Zen catalog.
    const models = await this.openaiProvider.getAvailableModels();
    return models.filter(
      ({ id }) =>
        !id.toLowerCase().startsWith("gemini-") ||
        (this.product === "zen" && id === GEMINI_NEON_MODEL.id),
    );
  }
}

// Kept as an export alias for integrations that used the earlier Go-only name.
export const OpenCodeGoProvider = OpenCodeProvider;
