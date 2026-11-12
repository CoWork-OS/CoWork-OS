import { randomUUID } from "node:crypto";
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { OpenAIProvider } from "./openai-provider";
import { LLMProvider, LLMProviderType, LLMRequest, LLMResponse } from "./types";
import type { ProviderDiagnosticFetch } from "./provider-diagnostic-fetch";
import {
  getOpenCodeModelTransport,
  isOpenCodeGoBaseUrl,
  normalizeOpenCodeGoAnthropicBaseUrl,
  normalizeOpenCodeGoModelId,
  type OpenCodeProduct,
} from "./opencode-go-routing";

/**
 * OpenCode Go rejects requests without this header ("Request is missing
 * x-opencode-session and cannot be routed efficiently"). It identifies the
 * client session so the gateway can route a conversation's turns together.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export interface OpenCodeProviderOptions {
  diagnosticFetch?: ProviderDiagnosticFetch;
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /**
   * Session identifier sent as `x-opencode-session` on OpenCode Go requests.
   * Defaults to a random UUID that stays fixed for the provider instance.
   */
  sessionId?: string;
}

export class OpenCodeProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private defaultModel: string;
  private openaiProvider: OpenAICompatibleProvider;
  private anthropicProvider: AnthropicCompatibleProvider;
  private responsesProvider: OpenAIProvider;
  private product: OpenCodeProduct;
  private diagnosticFetch?: ProviderDiagnosticFetch;
  /** Value sent as `x-opencode-session`; only set (and sent) for OpenCode Go. */
  readonly sessionId?: string;

  constructor(options: OpenCodeProviderOptions) {
    this.diagnosticFetch = options.diagnosticFetch;
    this.type = options.type;
    this.defaultModel = options.defaultModel;
    this.product = isOpenCodeGoBaseUrl(options.baseUrl) ? "go" : "zen";
    // Go requires a session header on every request (chat, models and the
    // settings connection test); Zen does not ask for one.
    this.sessionId =
      this.product === "go" ? options.sessionId?.trim() || randomUUID() : undefined;
    const extraHeaders = this.sessionId
      ? { [OPENCODE_SESSION_HEADER]: this.sessionId }
      : undefined;
    // OpenCode serves hosted models that return native tool calls; text that
    // looks like a call is not recovered here.
    this.openaiProvider = new OpenAICompatibleProvider({
      ...options,
      textToolCallFallback: false,
      ...(extraHeaders ? { extraHeaders } : {}),
    });
    const baseUrl = normalizeOpenCodeGoAnthropicBaseUrl(options.baseUrl);
    this.anthropicProvider = new AnthropicCompatibleProvider({
      ...options,
      baseUrl,
      defaultModel: normalizeOpenCodeGoModelId(options.defaultModel),
      ...(extraHeaders ? { extraHeaders } : {}),
    });
    this.responsesProvider = new OpenAIProvider({
      type: "openai",
      model: normalizeOpenCodeGoModelId(options.defaultModel),
      openaiApiKey: options.apiKey,
      openaiBaseUrl: baseUrl,
      openaiResponsesApi: true,
      ...(extraHeaders ? { openaiDefaultHeaders: extraHeaders } : {}),
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
    if (this.diagnosticFetch) {
      // The Responses SDK does not use the host diagnostic transport. Verify
      // browser connectivity through the same bounded model endpoint instead.
      const models = await this.openaiProvider.getAvailableModels();
      return models.length
        ? { success: true }
        : { success: false, error: "Provider model discovery failed or returned no models." };
    }
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
