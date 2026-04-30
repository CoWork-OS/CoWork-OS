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
} from "./openai-compatible";
import { buildOpenAIPromptCacheFields } from "./prompt-cache";

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const lowerBase = trimmedBase.toLowerCase();
  if (lowerBase.endsWith("/chat/completions")) {
    return trimmedBase.slice(0, -"/chat/completions".length);
  }
  if (lowerBase.endsWith("/models")) {
    return trimmedBase.slice(0, -"/models".length);
  }
  return trimmedBase;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  if (trimmedBase.toLowerCase().endsWith("/chat/completions")) {
    return trimmedBase;
  }
  return joinUrl(trimmedBase, "/chat/completions");
}

function resolveModelsUrl(baseUrl: string): string {
  return joinUrl(normalizeBaseUrl(baseUrl), "/models");
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
  private defaultModel: string;
  private providerName: string;
  private extraHeaders?: Record<string, string>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.chatCompletionsUrl = resolveChatCompletionsUrl(options.baseUrl);
    this.modelsUrl = resolveModelsUrl(options.baseUrl);
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.extraHeaders = options.extraHeaders;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const caps = PROVIDER_IMAGE_CAPS[this.type];
    const supportsImages = caps?.supportsImages === true;
    const messages = toOpenAICompatibleMessages(request.messages, request.system, {
      supportsImages,
      systemBlocks: request.systemBlocks,
    });
    const tools = request.tools ? toOpenAICompatibleTools(request.tools) : undefined;

    try {
      const model = request.model || this.defaultModel;
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
          max_tokens: request.maxTokens,
          ...(tools && tools.length > 0
            ? {
                tools,
                tool_choice: request.toolChoice || "auto",
              }
            : {}),
          ...buildOpenAIPromptCacheFields(request.promptCache),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(
          `${this.providerName} API error: ${response.status} ${response.statusText}` +
            (errorData.error?.message ? ` - ${errorData.error.message}` : ""),
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
          model: this.defaultModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 10,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        return {
          success: false,
          error: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`,
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
