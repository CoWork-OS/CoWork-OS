import type Anthropic from "@anthropic-ai/sdk";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  ANTHROPIC_HEALTHCHECK_MODEL_ID,
  normalizeAnthropicModelId,
} from "./types";
import {
  applyAnthropicExplicitCacheControl,
  applyExplicitSystemBlockMarker,
  buildAnthropicCacheMarker,
  convertSystemBlocksToTextParts,
  extractAnthropicUsage,
  isPromptCacheAutoUnsupportedError,
  isPromptCacheRequestUnsupportedError,
  normalizeSystemBlocks,
} from "./prompt-cache";
import { ensureNoTrailingAssistantPrefill } from "./assistant-prefill";
import {
  anthropicReasoningFromResponse,
  classifyAnthropicThinkingRejection,
  planAnthropicThinking,
  trailingToolTurnStartsWithThinking,
} from "./anthropic-thinking";
import {
  ANTHROPIC_TURN_CONTEXT_BETA,
  anthropicContextFromResponse,
  isAnthropicTurnContextUnsupported,
  prepareAnthropicConversation,
} from "./anthropic-turn-context";
import { createLogger } from "../../utils/logger";
import { lazyClient, loadAnthropicSdk } from "./sdk-loaders";

/**
 * Anthropic API provider implementation
 */
const logger = createLogger("Anthropic");

interface ThinkingRequestOptions {
  /** Replay thinking blocks produced by this model (see anthropic-thinking.ts). */
  replay: boolean;
  /** Send thinking/effort parameters. */
  sendConfig: boolean;
}

interface BuiltRequest {
  payload: Any;
  model: string;
  /** Prefix hash recorded on the response's thinking blocks. */
  prefixHash: string;
  /** The request carries thinking parameters or replayed thinking blocks. */
  usesThinking: boolean;
  usesTurnContext: boolean;
  pendingContext: ReturnType<typeof prepareAnthropicConversation>["pendingContext"];
}

export class AnthropicProvider implements LLMProvider {
  readonly type = "anthropic" as const;
  /** The SDK client, created on the first request (see sdk-loaders). */
  private readonly getClient: () => Promise<Anthropic>;
  private readonly configuredModel: string;
  private readonly reasoningEffort?: string;
  private promptCacheAutoSupported = true;
  private readonly promptCacheRejectedModels = new Set<string>();
  /** Models whose endpoint rejected thinking/effort parameters (sticky per instance). */
  private readonly thinkingConfigRejectedModels = new Set<string>();
  private readonly turnContextRejectedModels = new Set<string>();
  private readonly subscriptionBetas: string;
  private static readonly STREAMING_REQUIRED_ERROR_FRAGMENT =
    "Streaming is required for operations that may take longer than 10 minutes";

  constructor(config: LLMProviderConfig) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new Error(
        "Claude API key or subscription token is required. Configure it in Settings or get one from https://console.anthropic.com/",
      );
    }

    this.configuredModel = config.model;
    this.reasoningEffort = config.anthropicReasoningEffort;
    const isSubscriptionToken = apiKey.includes("sk-ant-oat");
    this.subscriptionBetas = isSubscriptionToken ? "claude-code-20250219,oauth-2025-04-20" : "";
    const clientOptions: ConstructorParameters<typeof Anthropic>[0] = isSubscriptionToken
      ? {
          apiKey: null,
          authToken: apiKey,
          defaultHeaders: {
            "anthropic-beta": this.subscriptionBetas,
            "x-app": "cli",
          },
        }
      : { apiKey };
    this.getClient = lazyClient(async () => new (await loadAnthropicSdk())(clientOptions));
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    return this.createMessageWithThinking(request, {
      replay: true,
      sendConfig: !this.thinkingConfigRejectedModels.has(normalizeAnthropicModelId(request.model)),
    });
  }

  private async createMessageWithThinking(
    request: LLMRequest,
    thinkingOptions: ThinkingRequestOptions,
  ): Promise<LLMResponse> {
    const tools = request.tools ? this.convertTools(request.tools) : undefined;
    const model = normalizeAnthropicModelId(request.model);
    const requestedPromptCache =
      request.promptCache?.mode === "disabled" || this.promptCacheRejectedModels.has(model)
        ? undefined
        : request.promptCache;
    const effectivePromptCache =
      requestedPromptCache?.mode === "anthropic_auto" && !this.promptCacheAutoSupported
        ? { ...requestedPromptCache, mode: "anthropic_explicit" as const }
        : requestedPromptCache;
    const built = this.buildRequest(request, effectivePromptCache, tools, thinkingOptions);

    const retryWithoutTurnContext = (error: Any): Promise<LLMResponse> | null => {
      if (
        !built.usesTurnContext ||
        !isAnthropicTurnContextUnsupported(error?.status, error?.message || "")
      )
        return null;
      this.turnContextRejectedModels.add(model);
      logger.warn("Scoped turn context rejected; retrying with all current system instructions", {
        model,
        status: error?.status,
      });
      return this.createMessageWithThinking(request, thinkingOptions);
    };

    // A thinking block or parameter the endpoint rejects: retry once without
    // replayed blocks and thinking parameters instead of failing the turn.
    const retryWithoutThinking = (error: Any): Promise<LLMResponse> | null => {
      const rejection = classifyAnthropicThinkingRejection(error?.status, error?.message || "");
      if (!rejection || !built.usesThinking) return null;
      logger.warn("Thinking rejected by the API; retrying without thinking blocks or parameters", {
        model,
        status: error?.status,
        reason: rejection,
      });
      if (rejection === "config") this.thinkingConfigRejectedModels.add(model);
      return this.createMessageWithThinking(request, { replay: false, sendConfig: false });
    };

    try {
      logger.debug(`Calling API with model: ${model}`);

      let response: Anthropic.Message;
      try {
        response = await this.send(built, request.signal);
      } catch (error: Any) {
        if (!error?.message?.includes(AnthropicProvider.STREAMING_REQUIRED_ERROR_FRAGMENT))
          throw error;
        logger.warn("Retrying with streaming because the SDK requires it for this output budget", {
          model,
          maxTokens: built.payload.max_tokens,
        });
        response = await this.sendStreaming(built, request.signal);
      }

      return this.convertResponse(response, built);
    } catch (error: Any) {
      const contextRetry = retryWithoutTurnContext(error);
      if (contextRetry) return contextRetry;
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

        // Re-enter the normal error handling with explicit caching, so a second
        // cache rejection can still fall back to a request without controls.
        return this.createMessageWithThinking(request, thinkingOptions);
      }

      const retried = retryWithoutThinking(error);
      if (retried) return retried;

      if (
        effectivePromptCache &&
        isPromptCacheRequestUnsupportedError(error?.status, error?.message || "")
      ) {
        this.promptCacheRejectedModels.add(model);
        logger.warn("Prompt cache controls rejected; retrying without cache controls", {
          model,
          status: error?.status,
        });
        return this.createMessageWithThinking(request, thinkingOptions);
      }

      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      const REDACTED_HEADER_KEYS =
        /^(authorization|x-api-key|cookie|set-cookie|proxy-authorization)$/i;
      const safeHeaders = error.headers
        ? Object.fromEntries(
            (Array.from(error.headers.entries()) as [string, string][]).map(
              ([k, v]: [string, string]) =>
                REDACTED_HEADER_KEYS.test(k) ? [k, "[REDACTED]"] : [k, v],
            ),
          )
        : undefined;
      logger.error("API error:", {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
        headers: safeHeaders,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const model = normalizeAnthropicModelId(
        this.configuredModel || ANTHROPIC_HEALTHCHECK_MODEL_ID,
      );
      // Send a minimal request to test the connection
      const client = await this.getClient();
      await client.messages.create({
        model,
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
              media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
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

  /**
   * Request body: thinking/effort per model (anthropic-thinking.ts), thinking
   * blocks replayed when they still belong to this conversation, and cache
   * markers. Sampling parameters and tool_choice are never sent, so thinking is
   * always combined with the default `auto` tool choice.
   */
  private buildRequest(
    request: LLMRequest,
    promptCache: LLMRequest["promptCache"] | undefined,
    tools: Anthropic.Tool[] | undefined,
    thinkingOptions: ThinkingRequestOptions,
  ): BuiltRequest {
    const model = normalizeAnthropicModelId(request.model);
    const messages = ensureNoTrailingAssistantPrefill(request.messages, model);
    const replay = prepareAnthropicConversation({
      request,
      messages,
      converted: this.convertMessages(messages),
      model,
      provider: this.type,
      tools,
      replay: thinkingOptions.replay,
      enableTurnContext:
        (request.promptCache?.mode === "anthropic_auto" ||
          request.promptCache?.mode === "anthropic_explicit") &&
        !this.turnContextRejectedModels.has(model),
    });
    if (replay.droppedBlocks > 0) {
      logger.debug("Dropped thinking blocks that no longer match the conversation or model", {
        model,
        dropped: replay.droppedBlocks,
        replayed: replay.replayedBlocks,
      });
    }

    let plan = thinkingOptions.sendConfig
      ? planAnthropicThinking({
          model,
          maxTokens: request.maxTokens,
          effort: request.reasoningEffort || this.reasoningEffort,
        })
      : { maxTokens: request.maxTokens };
    if (plan.thinking?.type === "enabled" && !trailingToolTurnStartsWithThinking(replay.messages)) {
      // Budget-mode thinking needs the tool-calling turn to start with its thinking.
      plan = {
        ...(plan.outputConfig ? { outputConfig: plan.outputConfig } : {}),
        maxTokens: request.maxTokens,
      };
    }

    const payload: Any = {
      model,
      max_tokens: plan.maxTokens,
      system: this.buildSystemPayload(replay.systemRequest, promptCache),
      messages: this.buildMessagesPayload(replay.messages as Anthropic.MessageParam[], promptCache),
      ...(tools && { tools }),
      ...(plan.thinking && { thinking: plan.thinking }),
      ...(plan.outputConfig && { output_config: plan.outputConfig }),
    };

    if (promptCache?.mode === "anthropic_auto") {
      payload.cache_control = buildAnthropicCacheMarker(promptCache.ttl);
    }

    return {
      payload,
      model,
      prefixHash: replay.prefixHash,
      usesThinking: replay.replayedBlocks > 0 || Boolean(plan.thinking || plan.outputConfig),
      usesTurnContext: replay.usesTurnContext,
      pendingContext: replay.pendingContext,
    };
  }

  private requestOptions(built: BuiltRequest, signal: AbortSignal | undefined) {
    if (!signal && !built.usesTurnContext) return undefined;
    return {
      ...(signal ? { signal } : {}),
      ...(built.usesTurnContext
        ? {
            headers: {
              "anthropic-beta": [this.subscriptionBetas, ANTHROPIC_TURN_CONTEXT_BETA]
                .filter(Boolean)
                .join(","),
            },
          }
        : {}),
    };
  }

  private async send(
    built: BuiltRequest,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.Message> {
    const client = await this.getClient();
    return client.messages.create(
      built.payload,
      this.requestOptions(built, signal),
    ) as Promise<Anthropic.Message>;
  }

  private async sendStreaming(
    built: BuiltRequest,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.Message> {
    const client = await this.getClient();
    const stream = client.messages.stream(built.payload, this.requestOptions(built, signal));
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

    const parts = convertSystemBlocksToTextParts(request.system, request.systemBlocks);
    // Explicit mode marks the system prefix and recent turns. Automatic mode's
    // single top-level breakpoint follows the conversation tail, so the static
    // system prefix also gets its own marker: a read point that survives
    // whatever changes later in the transcript. Two breakpoints stay within the
    // limit of four, and both use the request TTL so the longer-TTL-first
    // ordering rule holds.
    if (promptCache?.mode === "anthropic_explicit" || promptCache?.mode === "anthropic_auto") {
      applyExplicitSystemBlockMarker(parts, blocks, promptCache.ttl);
    }

    if (!request.systemBlocks && parts.length === 1 && !parts[0].cache_control) {
      return parts[0].text;
    }

    return parts;
  }

  private buildMessagesPayload(
    converted: Anthropic.MessageParam[],
    promptCache: LLMRequest["promptCache"] | undefined,
  ): Anthropic.MessageParam[] {
    if (promptCache?.mode !== "anthropic_explicit") {
      return converted as Anthropic.MessageParam[];
    }

    return applyAnthropicExplicitCacheControl(converted, {
      ttl: promptCache.ttl,
      includeSystem: false,
      maxBreakpoints: Math.min(3, Math.max(0, promptCache.explicitRecentMessages ?? 3)),
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

  private convertResponse(response: Anthropic.Message, built: BuiltRequest): LLMResponse {
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

    const visibleContent = this.convertMessages([{ role: "assistant", content }])[0]?.content;
    const providerContext = anthropicContextFromResponse(built.pendingContext, visibleContent);
    const reasoning = anthropicReasoningFromResponse({
      content: response.content,
      visibleContent,
      model: built.model,
      provider: this.type,
      prefixHash: built.prefixHash,
    });

    return {
      content,
      ...(providerContext ? { providerContext } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: extractAnthropicUsage(response.usage),
    };
  }

  private mapStopReason(reason: Anthropic.Message["stop_reason"]): LLMResponse["stopReason"] {
    switch (reason) {
      case "end_turn":
        return "end_turn";
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      case "refusal":
        return "refusal";
      // The context window, not max_tokens, cut the answer off: recover like a truncation.
      case "model_context_window_exceeded":
      // A resumable server-side pause: continue the turn like a truncated one.
      case "pause_turn":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }
}
