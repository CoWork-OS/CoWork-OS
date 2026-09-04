import {
  LLMProvider,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  PROVIDER_IMAGE_CAPS,
} from "./types";
import {
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
  fromOpenAICompatibleResponse,
  type OpenAICompatibleToolOptions,
} from "./openai-compatible";
import { buildOpenAIPromptCacheFields } from "./prompt-cache";

const OPENCODE_GO_KIMI_MAX_COMPLETION_TOKENS = 32_768;

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function normalizeBaseUrl(baseUrl: string, providerType?: LLMProviderType): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const lowerBase = trimmedBase.toLowerCase();
  let normalizedBase = trimmedBase;
  if (lowerBase.endsWith("/chat/completions")) {
    normalizedBase = trimmedBase.slice(0, -"/chat/completions".length);
  } else if (lowerBase.endsWith("/models")) {
    normalizedBase = trimmedBase.slice(0, -"/models".length);
  }

  // MLX-LM and hf-agents expose the OpenAI-compatible API below /v1. Keep
  // accepting the legacy localhost:8080 value so existing saved settings do
  // not silently call the wrong endpoint.
  if (
    (providerType === "mlx" || providerType === "hf-agents") &&
    !normalizedBase.toLowerCase().endsWith("/v1")
  ) {
    return joinUrl(normalizedBase, "/v1");
  }
  return normalizedBase;
}

function resolveChatCompletionsUrl(baseUrl: string, providerType?: LLMProviderType): string {
  return joinUrl(normalizeBaseUrl(baseUrl, providerType), "/chat/completions");
}

function resolveModelsUrl(baseUrl: string, providerType?: LLMProviderType): string {
  return joinUrl(normalizeBaseUrl(baseUrl, providerType), "/models");
}

export interface OpenAICompatibleProviderOptions {
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private apiKey: string;
  private chatCompletionsUrl: string;
  private modelsUrl: string;
  private normalizedBaseUrl: string;
  private defaultModel: string;
  private providerName: string;
  private extraHeaders?: Record<string, string>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.normalizedBaseUrl = normalizeBaseUrl(options.baseUrl, options.type);
    this.chatCompletionsUrl = resolveChatCompletionsUrl(options.baseUrl, options.type);
    this.modelsUrl = resolveModelsUrl(options.baseUrl, options.type);
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.extraHeaders = options.extraHeaders;
  }

  private normalizeModelForEndpoint(model: string): string {
    const trimmed = model.trim();
    if (
      (this.type === "mlx" || this.type === "hf-agents") &&
      trimmed.toLowerCase().startsWith("mlx://")
    ) {
      return trimmed.slice("mlx://".length);
    }
    const lowerBase = this.normalizedBaseUrl.toLowerCase();
    if (lowerBase.includes("opencode.ai/zen/go/") && trimmed.startsWith("opencode-go/")) {
      return trimmed.slice("opencode-go/".length);
    }
    if (lowerBase.includes("opencode.ai/zen/") && trimmed.startsWith("opencode/")) {
      return trimmed.slice("opencode/".length);
    }
    return trimmed;
  }

  private isKimiK2Model(model: string): boolean {
    const normalized = model.toLowerCase().trim();
    const bareModel = normalized.includes("/")
      ? normalized.slice(normalized.lastIndexOf("/") + 1)
      : normalized;
    const withoutVariant = bareModel.includes(":")
      ? bareModel.slice(0, bareModel.indexOf(":"))
      : bareModel;
    return (
      withoutVariant === "kimi-k2.6" ||
      withoutVariant === "kimi-k2.5" ||
      withoutVariant === "kimi-k2" ||
      withoutVariant === "kimi-k2-thinking" ||
      withoutVariant.startsWith("kimi-k2.")
    );
  }

  private isOpenCodeGoEndpoint(): boolean {
    return this.normalizedBaseUrl.toLowerCase().includes("opencode.ai/zen/go/");
  }

  private getOutputTokenField(model: string): "max_tokens" | "max_completion_tokens" {
    return this.isKimiK2Model(model) ? "max_completion_tokens" : "max_tokens";
  }

  private getMaxOutputTokens(model: string, requestedMaxTokens: number): number {
    if (
      this.isOpenCodeGoEndpoint() &&
      this.isKimiK2Model(model) &&
      Number.isFinite(requestedMaxTokens) &&
      requestedMaxTokens > 0
    ) {
      return Math.min(Math.floor(requestedMaxTokens), OPENCODE_GO_KIMI_MAX_COMPLETION_TOKENS);
    }

    return requestedMaxTokens;
  }

  private getToolOptions(model: string): OpenAICompatibleToolOptions | undefined {
    if (!this.isKimiK2Model(model)) return undefined;
    return { functionStrict: false };
  }

  private getToolRequestExtras(model: string, tools?: Any[]): Record<string, Any> {
    if (!tools?.length || !this.isKimiK2Model(model)) return {};

    // Kimi K2.5/K2.6 thinking-mode tool turns require provider-specific
    // reasoning_content replay. CoWork's provider-agnostic transcript does not
    // retain that field, so disable thinking only for tool calls.
    return { thinking: { type: "disabled" } };
  }

  private getErrorMessage(errorData: Any): string | undefined {
    if (!errorData || typeof errorData !== "object") return undefined;
    if (typeof errorData.error === "string") return errorData.error;
    if (typeof errorData.error?.message === "string") return errorData.error.message;
    if (typeof errorData.message === "string") return errorData.message;
    return undefined;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const caps = PROVIDER_IMAGE_CAPS[this.type];
    const supportsImages = caps?.supportsImages === true;
    const messages = toOpenAICompatibleMessages(request.messages, request.system, {
      supportsImages,
      systemBlocks: request.systemBlocks,
    });

    try {
      const model = this.normalizeModelForEndpoint(request.model || this.defaultModel);
      const tools = request.tools
        ? toOpenAICompatibleTools(request.tools, this.getToolOptions(model))
        : undefined;
      const outputTokenField = this.getOutputTokenField(model);
      const maxOutputTokens = this.getMaxOutputTokens(model, request.maxTokens);
      console.log(`[${this.providerName}] Calling API with model: ${model}`);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.extraHeaders,
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          [outputTokenField]: maxOutputTokens,
          ...(tools && tools.length > 0
            ? {
                tools,
                tool_choice: request.toolChoice || "auto",
              }
            : {}),
          ...this.getToolRequestExtras(model, tools),
          ...buildOpenAIPromptCacheFields(request.promptCache),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = this.getErrorMessage(errorData);
        throw new Error(
          `${this.providerName} API error: ${response.status} ${response.statusText}` +
            (errorMessage ? ` - ${errorMessage}` : ""),
        );
      }

      const data = (await response.json()) as Any;
      return fromOpenAICompatibleResponse(data);
    } catch (error: Any) {
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        console.log(`[${this.providerName}] Request aborted`);
        throw new Error("Request cancelled");
      }

      console.error(`[${this.providerName}] API error:`, {
        message: error.message,
        status: error.status,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const model = this.normalizeModelForEndpoint(this.defaultModel);
      const outputTokenField = this.getOutputTokenField(model);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.extraHeaders,
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hi" }],
          [outputTokenField]: 10,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error:
            this.getErrorMessage(errorData) || `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || `Failed to connect to ${this.providerName} API`,
      };
    }
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.modelsUrl, {
        headers,
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as { data?: Any[] };
      return (data.data || []).map((model: Any) => ({
        id: model.id,
        name: model.id,
      }));
    } catch (error: Any) {
      // ECONNREFUSED means the local server simply isn't running yet — not an error worth logging loudly
      const isOffline = error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
      if (!isOffline) {
        console.error(`[${this.providerName}] Failed to fetch models:`, error);
      }
      return [];
    }
  }
}
