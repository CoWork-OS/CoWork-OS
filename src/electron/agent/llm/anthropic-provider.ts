import Anthropic from "@anthropic-ai/sdk";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  normalizeAnthropicModelId,
} from "./types";
import {
  applyAnthropicExplicitCacheControl,
  applyExplicitSystemBlockMarker,
  buildAnthropicCacheMarker,
  convertSystemBlocksToTextParts,
  extractAnthropicUsage,
  isPromptCacheAutoUnsupportedError,
  normalizeSystemBlocks,
} from "./prompt-cache";
import { createLogger } from "../../utils/logger";

/**
 * Anthropic API provider implementation
 */
const logger = createLogger("Anthropic");

export class AnthropicProvider implements LLMProvider {
  readonly type = "anthropic" as const;
  private client: Anthropic;
  private promptCacheAutoSupported = true;
  private static readonly STREAMING_REQUIRED_ERROR_FRAGMENT =
    "Streaming is required for operations that may take longer than 10 minutes";

  constructor(config: LLMProviderConfig) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new Error(
        "Claude API key or subscription token is required. Configure it in Settings or get one from https://console.anthropic.com/",
      );
    }

    const isSubscriptionToken = apiKey.includes("sk-ant-oat");
    this.client = isSubscriptionToken
      ? new Anthropic({
          apiKey: null,
          authToken: apiKey,
          defaultHeaders: {
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "x-app": "cli",
          },
        })
      : new Anthropic({ apiKey });
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const tools = request.tools ? this.convertTools(request.tools) : undefined;
    const model = normalizeAnthropicModelId(request.model);
    const requestedPromptCache =
      request.promptCache?.mode === "disabled"
        ? undefined
        : request.promptCache;
    const effectivePromptCache =
      requestedPromptCache?.mode === "anthropic_auto" &&
      !this.promptCacheAutoSupported
        ? { ...requestedPromptCache, mode: "anthropic_explicit" as const }
        : requestedPromptCache;

    try {
      logger.debug(`Calling API with model: ${model}`);

      const response = await this.createWithPromptCache(
        request,
        effectivePromptCache,
        tools,
      );

      return this.convertResponse(response);
    } catch (error: Any) {
      if (
        effectivePromptCache?.mode === "anthropic_auto" &&
        isPromptCacheAutoUnsupportedError(error?.status, error?.message || "")
      ) {
        this.promptCacheAutoSupported = false;
        logger.warn(
          "Automatic prompt caching rejected by endpoint; downgrading this provider instance to explicit caching.",
          {
            status: error?.status,
            message: error?.message,
          },
        );

        const fallbackResponse = await this.createWithPromptCache(
          request,
          { ...effectivePromptCache, mode: "anthropic_explicit" },
          tools,
        );
        return this.convertResponse(fallbackResponse);
      }

      if (
        typeof error?.message === "string" &&
        error.message.includes(
          AnthropicProvider.STREAMING_REQUIRED_ERROR_FRAGMENT,
        )
      ) {
        logger.warn(
          "Retrying request with streaming because the SDK rejected the non-streaming timeout budget.",
          {
            model,
            maxTokens: request.maxTokens,
          },
        );
        const streamedResponse = await this.createWithStreaming(
          request,
          effectivePromptCache,
          tools,
        );
        return this.convertResponse(streamedResponse);
      }

      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      logger.error("API error:", {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
        headers: error.headers ? Object.fromEntries(error.headers) : undefined,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // Send a minimal request to test the connection
      await this.client.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 10,
        messages: [{ role: "user", content: "Hi" }],
      });
      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Anthropic API",
      };
    }
  }

  private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      if (typeof msg.content === "string") {
        return {
          role: msg.role,
          content: msg.content,
        };
      }

      // Handle array content (tool results or mixed content)
      const content = msg.content.map((item) => {
        if (item.type === "tool_result") {
          return {
            type: "tool_result" as const,
            tool_use_id: item.tool_use_id,
            content: item.content,
            ...(item.is_error && { is_error: true }),
          };
        }
        if (item.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: item.id,
            name: item.name,
            input: item.input,
          };
        }
        if (item.type === "image") {
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: item.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: item.data,
            },
          };
        }
        return {
          type: "text" as const,
          text: item.text,
        };
      });

      return {
        role: msg.role,
        content,
      };
    }) as Anthropic.MessageParam[];
  }

  private async createWithPromptCache(
    request: LLMRequest,
    promptCache: LLMRequest["promptCache"] | undefined,
    tools: Anthropic.Tool[] | undefined,
  ): Promise<Anthropic.Message> {
    const model = normalizeAnthropicModelId(request.model);
    const payload: Any = {
      model,
      max_tokens: request.maxTokens,
      system: this.buildSystemPayload(request, promptCache),
      messages: this.buildMessagesPayload(request.messages, promptCache),
      ...(tools && { tools }),
    };

    if (promptCache?.mode === "anthropic_auto") {
      payload.cache_control = buildAnthropicCacheMarker(promptCache.ttl);
    }

    return this.client.messages.create(
      payload,
      request.signal ? { signal: request.signal } : undefined,
    ) as Promise<Anthropic.Message>;
  }

  private async createWithStreaming(
    request: LLMRequest,
    promptCache: LLMRequest["promptCache"] | undefined,
    tools: Anthropic.Tool[] | undefined,
  ): Promise<Anthropic.Message> {
    const model = normalizeAnthropicModelId(request.model);
    const payload: Any = {
      model,
      max_tokens: request.maxTokens,
      system: this.buildSystemPayload(request, promptCache),
      messages: this.buildMessagesPayload(request.messages, promptCache),
      ...(tools && { tools }),
    };

    if (promptCache?.mode === "anthropic_auto") {
      payload.cache_control = buildAnthropicCacheMarker(promptCache.ttl);
    }

    const stream = this.client.messages.stream(
      payload,
      request.signal ? { signal: request.signal } : undefined,
    );
    return stream.finalMessage() as Promise<Anthropic.Message>;
  }

  private buildSystemPayload(
    request: Pick<LLMRequest, "system" | "systemBlocks">,
    promptCache: LLMRequest["promptCache"] | undefined,
  ):
    | string
    | Array<{
        type: "text";
        text: string;
        cache_control?: { type: "ephemeral"; ttl?: "1h" };
      }> {
    const blocks = normalizeSystemBlocks(request.system, request.systemBlocks);
    if (blocks.length === 0) {
      return request.system;
    }

    const parts = convertSystemBlocksToTextParts(
      request.system,
      request.systemBlocks,
    );
    if (promptCache?.mode === "anthropic_explicit") {
      applyExplicitSystemBlockMarker(parts, blocks, promptCache.ttl);
    }

    if (
      !request.systemBlocks &&
      parts.length === 1 &&
      !parts[0].cache_control
    ) {
      return parts[0].text;
    }

    return parts;
  }

  private buildMessagesPayload(
    messages: LLMMessage[],
    promptCache: LLMRequest["promptCache"] | undefined,
  ): Anthropic.MessageParam[] {
    const converted = this.convertMessages(messages) as Any[];
    if (promptCache?.mode !== "anthropic_explicit") {
      return converted as Anthropic.MessageParam[];
    }

    return applyAnthropicExplicitCacheControl(converted, {
      ttl: promptCache.ttl,
      includeSystem: false,
      maxBreakpoints: Math.max(0, promptCache.explicitRecentMessages || 3),
      nativeAnthropic: true,
    }) as Anthropic.MessageParam[];
  }

  private convertTools(tools: LLMTool[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private convertResponse(response: Anthropic.Message): LLMResponse {
    const content: LLMContent[] = response.content
      .filter((block) => block.type === "text" || block.type === "tool_use")
      .map((block) => {
        if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, Any>,
          };
        }
        // Type guard: at this point block must be a TextBlock
        return {
          type: "text" as const,
          text: (block as Anthropic.TextBlock).text,
        };
      });

    return {
      content,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: extractAnthropicUsage(response.usage),
    };
  }

  private mapStopReason(
    reason: Anthropic.Message["stop_reason"],
  ): LLMResponse["stopReason"] {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }
}
