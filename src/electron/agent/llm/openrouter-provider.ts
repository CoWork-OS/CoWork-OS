import {
  LLMProvider,
  LLMProviderConfig,
  LLMProviderError,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
} from "./types";
import { getOpenRouterAttributionHeaders } from "./openrouter-attribution";
import {
  applyAnthropicExplicitCacheControl,
  applyExplicitSystemBlockMarker,
  convertSystemBlocksToTextParts,
  extractOpenAICompatibleCacheUsage,
  normalizeSystemBlocks,
} from "./prompt-cache";
import { buildOpenAICompatibleSystemMessages } from "./openai-compatible";
import { createLogger } from "../../utils/logger";

const logger = createLogger("OpenRouter");
const SHARED_MODEL_IMAGE_SUPPORT = new Map<string, boolean>();
const OPENROUTER_KNOWN_TEXT_ONLY_MODEL_PATTERNS = [
  /\bminimax\/minimax-m2\.5\b/i,
  /\bqwen\/qwen3(?:[.-]|$)/i,
  /\bnemotron\b/i,
];
const MODEL_CATALOG_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-3.5-sonnet";
export const OPENROUTER_PARETO_CODE_MODEL = "openrouter/pareto-code";
export const OPENROUTER_PARETO_CODE_NITRO_MODEL = `${OPENROUTER_PARETO_CODE_MODEL}:nitro`;

function normalizeParetoMinCodingScore(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function isParetoCodeModel(model: string): boolean {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  return normalized.split(":")[0] === OPENROUTER_PARETO_CODE_MODEL;
}

/**
 * OpenRouter API provider implementation
 * OpenRouter provides access to multiple LLM providers through a unified API
 */
export class OpenRouterProvider implements LLMProvider {
  readonly type = "openrouter" as const;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private paretoMinCodingScore?: number;
  private modelImageSupport = new Map<string, boolean>();
  private modelCatalogLoaded = false;
  private modelCatalogLoadPromise: Promise<void> | null = null;
  private modelCatalogLastAttemptAt = 0;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.openrouterApiKey;
    if (!apiKey) {
      throw new Error(
        "OpenRouter API key is required (free, no credit card). Get one at https://openrouter.ai/keys then add it in Settings > LLM.",
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = config.openrouterBaseUrl || "https://openrouter.ai/api/v1";
    this.defaultModel = config.model || OPENROUTER_DEFAULT_MODEL;
    this.paretoMinCodingScore = normalizeParetoMinCodingScore(
      config.openrouterParetoMinCodingScore,
    );
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const promptCache =
      request.promptCache?.mode === "anthropic_auto"
        ? { ...request.promptCache, mode: "anthropic_explicit" as const }
        : request.promptCache?.mode === "disabled"
          ? undefined
          : request.promptCache;
    const tools = request.tools ? this.convertTools(request.tools) : undefined;
    const hasInlineImages = this.hasInlineImages(request.messages);
    if (hasInlineImages) {
      const supportsImages = await this.modelSupportsImageInput(model);
      if (!supportsImages) {
        throw this.buildImageInputUnsupportedError(model);
      }
    }
    const messages = this.convertMessages(request, promptCache);

    try {
      logger.debug(`Calling API with model: ${model}`);
      const data = await this.sendChatCompletion({
        model,
        messages,
        maxTokens: request.maxTokens,
        tools,
        toolChoice: request.toolChoice,
        signal: request.signal,
      });
      return this.convertResponse(data);
    } catch (error: Any) {
      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      if (this.shouldDemoteErrorLog(error)) {
        logger.debug("Retryable route error:", {
          model,
          message: error.message,
          status: error.status,
          providerMessage: error.providerMessage,
        });
      } else {
        logger.error("API error:", {
          model,
          message: error.message,
          status: error.status,
          providerMessage: error.providerMessage,
        });
      }
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...getOpenRouterAttributionHeaders(),
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 10,
          ...this.getParetoRouterPluginBody(this.defaultModel),
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
        error: error.message || "Failed to connect to OpenRouter API",
      };
    }
  }

  private isRetryableOpenRouterError(status: number, detail: string): boolean {
    const normalized = String(detail || "").toLowerCase();
    if (status === 429 || /rate limit|too many requests|free-models-per-min/i.test(normalized)) {
      return true;
    }

    // OpenRouter sometimes returns a generic 400 when the upstream route fails
    // even though the request shape itself is valid. Treat that as a route-level
    // incompatibility so the executor can advance to the next fallback model.
    if (status === 400 && normalized === "provider returned error") {
      return true;
    }

    if (this.isImageInputUnsupportedError(status, normalized)) {
      return true;
    }

    if (this.isToolChoiceUnsupportedError(status, normalized)) {
      return true;
    }

    // Some free OpenRouter routes are blocked behind OpenInference moderation.
    // That is a route-level incompatibility, so fail over to the next configured provider/model.
    return (
      status === 403 &&
      (normalized.includes("requires moderation on openinference") ||
        (normalized.includes("openinference") && normalized.includes("input was flagged")))
    );
  }

  private shouldDemoteErrorLog(error: Any): boolean {
    if (error?.retryable === true) {
      return true;
    }

    const status = Number(error?.status);
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    const providerMessage = String(error?.providerMessage || "").toLowerCase();
    return this.isImageInputUnsupportedError(status, providerMessage);
  }

  private convertMessages(
    request: Pick<LLMRequest, "messages" | "system" | "systemBlocks">,
    promptCache?: LLMRequest["promptCache"],
  ): Array<{ role: string; content: Any; tool_call_id?: string }> {
    const result: Array<{ role: string; content: Any; tool_call_id?: string }> = [];

    if (promptCache?.mode === "openrouter_implicit") {
      result.push(...buildOpenAICompatibleSystemMessages(request.system, request.systemBlocks));
    } else {
      const systemBlocks = normalizeSystemBlocks(request.system, request.systemBlocks);
      if (systemBlocks.length > 0) {
        const parts = convertSystemBlocksToTextParts(request.system, request.systemBlocks);
        if (promptCache?.mode === "anthropic_explicit") {
          applyExplicitSystemBlockMarker(parts, systemBlocks, promptCache.ttl);
        }
        result.push({
          role: "system",
          content:
            !request.systemBlocks && parts.length === 1 && !parts[0].cache_control
              ? parts[0].text
              : parts,
        });
      } else if (request.system) {
        result.push({ role: "system", content: request.system });
      }
    }

    for (const msg of request.messages) {
      if (typeof msg.content === "string") {
        result.push({ role: msg.role, content: msg.content });
      } else {
        // Handle array content (tool results, mixed content, images)
        const textParts: string[] = [];
        const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const item of msg.content) {
          if (item.type === "tool_result") {
            result.push({
              role: "tool",
              content: item.content,
              tool_call_id: item.tool_use_id,
            });
          } else if (item.type === "tool_use") {
            // Tool use from assistant - add as assistant message with tool_calls
            result.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: item.id,
                  type: "function",
                  function: {
                    name: item.name,
                    arguments: JSON.stringify(item.input),
                  },
                },
              ],
            } as Any);
          } else if (item.type === "text") {
            textParts.push(item.text);
          } else if (item.type === "image") {
            imageBlocks.push(item);
          }
        }

        // Emit text + images as a single message with content array
        if (imageBlocks.length > 0) {
          const contentParts: Any[] = [];
          if (textParts.length > 0) {
            contentParts.push({ type: "text", text: textParts.join("\n") });
          }
          for (const img of imageBlocks) {
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            });
          }
          result.push({ role: msg.role, content: contentParts });
        } else if (textParts.length > 0) {
          result.push({ role: msg.role, content: textParts.join("\n") });
        }
      }
    }

    if (promptCache?.mode !== "anthropic_explicit") {
      return result;
    }

    const systemMessage = result[0]?.role === "system" ? [result[0]] : [];
    const nonSystemMessages = systemMessage.length > 0 ? result.slice(1) : result.slice();
    return [
      ...systemMessage,
      ...(applyAnthropicExplicitCacheControl(nonSystemMessages as Any[], {
        ttl: promptCache.ttl,
        includeSystem: false,
        maxBreakpoints: Math.max(0, promptCache.explicitRecentMessages || 3),
        nativeAnthropic: false,
      }) as Array<{ role: string; content: Any; tool_call_id?: string }>),
    ];
  }

  private async sendChatCompletion(params: {
    model: string;
    messages: Array<{ role: string; content: Any; tool_call_id?: string }>;
    maxTokens: number;
    tools?: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Any;
      };
    }>;
    toolChoice?: LLMRequest["toolChoice"];
    signal?: AbortSignal;
  }): Promise<Any> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...getOpenRouterAttributionHeaders(),
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        ...this.getParetoRouterPluginBody(params.model),
        ...(params.tools && params.tools.length > 0
          ? {
              tools: params.tools,
              tool_choice: params.toolChoice || "auto",
            }
          : {}),
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const detail = errorData.error?.message || response.statusText;
      if (this.isImageInputUnsupportedError(response.status, detail)) {
        this.modelImageSupport.set(params.model, false);
        SHARED_MODEL_IMAGE_SUPPORT.set(params.model, false);
      }
      const fullMessage =
        `OpenRouter API error: ${response.status} ${response.statusText}` +
        (detail ? ` - ${detail}` : "");
      const err = new Error(fullMessage) as LLMProviderError;
      err.status = response.status;
      err.providerMessage = detail || undefined;
      err.errorData = errorData;
      err.retryable = this.isRetryableOpenRouterError(response.status, detail);
      throw err;
    }

    return (await response.json()) as Any;
  }

  private getParetoRouterPluginBody(model: string): {
    plugins?: Array<{ id: "pareto-router"; min_coding_score: number }>;
  } {
    if (!isParetoCodeModel(model)) {
      return {};
    }
    const minCodingScore = normalizeParetoMinCodingScore(this.paretoMinCodingScore);
    if (typeof minCodingScore !== "number") {
      return {};
    }
    return {
      plugins: [
        {
          id: "pareto-router",
          min_coding_score: minCodingScore,
        },
      ],
    };
  }

  private hasInlineImages(messages: LLMRequest["messages"]): boolean {
    return messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((item) => item.type === "image"),
    );
  }

  private isImageInputUnsupportedError(status: number | undefined, detail: string): boolean {
    return (
      status === 404 &&
      String(detail || "")
        .toLowerCase()
        .includes("no endpoints found that support image input")
    );
  }

  private isToolChoiceUnsupportedError(status: number | undefined, detail: string): boolean {
    const normalized = String(detail || "").toLowerCase();
    return (
      status === 404 &&
      normalized.includes("no endpoints found that support the provided 'tool_choice' value")
    );
  }

  private buildImageInputUnsupportedError(model: string): LLMProviderError {
    const detail = `No endpoints found that support image input for model ${model}`;
    const err = new Error(`OpenRouter API error: 404 Not Found - ${detail}`) as LLMProviderError;
    err.status = 404;
    err.providerMessage = detail;
    err.errorData = { error: { message: detail } };
    err.retryable = true;
    return err;
  }

  private async modelSupportsImageInput(model: string): Promise<boolean> {
    const sharedHint = OpenRouterProvider.getImageSupportHint(model);
    if (sharedHint != null) {
      this.modelImageSupport.set(model, sharedHint);
      return sharedHint;
    }

    const cached = this.modelImageSupport.get(model);
    if (cached != null) {
      return cached;
    }

    await this.loadModelCatalog();
    const resolved = this.modelImageSupport.get(model);
    return resolved ?? true;
  }

  private async loadModelCatalog(): Promise<void> {
    if (this.modelCatalogLoaded) {
      return;
    }
    if (this.modelCatalogLoadPromise) {
      await this.modelCatalogLoadPromise;
      return;
    }
    if (
      this.modelCatalogLastAttemptAt > 0 &&
      Date.now() - this.modelCatalogLastAttemptAt < MODEL_CATALOG_RETRY_COOLDOWN_MS
    ) {
      return;
    }

    this.modelCatalogLoadPromise = (async () => {
      this.modelCatalogLastAttemptAt = Date.now();
      try {
        const response = await fetch(`${this.baseUrl}/models?output_modalities=all`, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...getOpenRouterAttributionHeaders(),
          },
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as { data?: Any[] };
        for (const model of data.data || []) {
          const modelId = typeof model?.id === "string" ? model.id : "";
          if (!modelId) continue;
          const inputModalities = Array.isArray(model?.architecture?.input_modalities)
            ? model.architecture.input_modalities
            : [];
          const supportsImageInput = inputModalities.includes("image");
          this.modelImageSupport.set(modelId, supportsImageInput);
          SHARED_MODEL_IMAGE_SUPPORT.set(modelId, supportsImageInput);
        }
        this.modelCatalogLoaded = true;
      } catch (error) {
        logger.warn("Failed to fetch OpenRouter model capabilities:", error);
      } finally {
        this.modelCatalogLoadPromise = null;
      }
    })();

    await this.modelCatalogLoadPromise;
  }

  private convertTools(tools: LLMTool[]): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Any;
    };
  }> {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertResponse(response: Any): LLMResponse {
    const content: LLMContent[] = [];
    const choice = response.choices?.[0];

    if (!choice) {
      return {
        content: [{ type: "text", text: "" }],
        stopReason: "end_turn",
      };
    }

    const message = choice.message;

    // Handle text content
    if (message.content) {
      content.push({
        type: "text",
        text: message.content,
      });
    }

    // Handle tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === "function") {
          let input: Record<string, Any>;
          try {
            input =
              typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments || "{}")
                : (toolCall.function.arguments as Record<string, Any>) || {};
          } catch (err) {
            logger.error(
              `Failed to parse OpenRouter tool arguments for "${toolCall.function.name}":`,
              err,
            );
            throw new Error(
              `OpenRouter tool call "${toolCall.function.name}" has malformed arguments: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        }
      }
    }

    // If no content was parsed, return empty text
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens || response.usage.input_tokens || 0,
            outputTokens: response.usage.completion_tokens || response.usage.output_tokens || 0,
            ...extractOpenAICompatibleCacheUsage(response.usage),
          }
        : undefined,
    };
  }

  private mapStopReason(finishReason?: string): LLMResponse["stopReason"] {
    switch (finishReason) {
      case "stop":
        return "end_turn";
      case "length":
        return "max_tokens";
      case "tool_calls":
        return "tool_use";
      case "content_filter":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  /**
   * Fetch available models from OpenRouter API
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string; context_length: number }>> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...getOpenRouterAttributionHeaders(),
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as { data?: Any[] };
      return (data.data || []).map((model: Any) => ({
        id: model.id,
        name: model.name || model.id,
        context_length: model.context_length || 0,
      }));
    } catch (error) {
      logger.error("Failed to fetch OpenRouter models:", error);
      return [];
    }
  }

  static getImageSupportHint(model: string): boolean | undefined {
    const normalized = String(model || "").trim();
    if (!normalized) return undefined;
    const shared = SHARED_MODEL_IMAGE_SUPPORT.get(normalized);
    if (shared != null) return shared;
    return OPENROUTER_KNOWN_TEXT_ONLY_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))
      ? false
      : undefined;
  }
}
