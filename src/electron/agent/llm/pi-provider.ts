import { currentTurnStartIndex, piAiReplay, reasoningFromPiAiResponse } from "./reasoning-replay";
import type {
  Model,
  AssistantMessage as PiAiAssistantMessage,
  Message as PiAiMessage,
  Context as PiAiContext,
  Tool as PiAiTool,
  KnownProvider,
} from "@earendil-works/pi-ai";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  LLMToolResult,
  PI_PROVIDERS,
  PiProviderKey as _PiProviderKey,
} from "./types";
import { imageToTextFallback } from "./image-utils";
import { loadPiAiModule } from "./pi-ai-loader";
import { parseOpenAICompatibleToolArguments } from "./openai-compatible";
import {
  buildOpenAIPromptCacheFields,
  isPromptCacheRequestUnsupportedError,
  mapPromptCacheTtlToPiAiRetention,
  prependVolatileSystemContextToMessages,
  splitSystemBlocksForOpenAIPrefix,
} from "./prompt-cache";

const DEFAULT_PI_PROVIDER: KnownProvider = "anthropic";

/** Placeholder usage data for historical assistant messages replayed as context.
 *  pi-ai requires these fields but the actual values are unknown for past messages. */
const PLACEHOLDER_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/**
 * Pi provider implementation using pi-ai unified LLM API.
 *
 * Pi (by Mario Zechner) provides a unified interface to multiple LLM providers
 * including Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, and more.
 * This provider lets CoWork OS route LLM calls through pi-ai's API layer.
 */
export class PiProvider implements LLMProvider {
  readonly type = "pi" as const;
  private piProvider: KnownProvider;
  private apiKey: string;
  private modelId: string;

  constructor(config: LLMProviderConfig) {
    const requestedProvider = config.piProvider || DEFAULT_PI_PROVIDER;
    if (!(requestedProvider in PI_PROVIDERS)) {
      throw new Error(
        `Unknown Pi backend provider: "${requestedProvider}". Valid providers: ${Object.keys(PI_PROVIDERS).join(", ")}`,
      );
    }
    this.piProvider = requestedProvider as KnownProvider;
    this.apiKey = config.piApiKey || "";
    this.modelId = config.model;

    if (!this.apiKey) {
      throw new Error(
        `Pi provider requires an API key for the ${this.piProvider} backend. Configure it in Settings.`,
      );
    }

    console.log(`[Pi] Initialized with provider: ${this.piProvider}, model: ${this.modelId}`);
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    try {
      const { complete: piAiComplete } = await loadPiAiModule();
      // Resolve the model from pi-ai's registry
      const model = await this.resolveModel(request.model);

      console.log(
        `[Pi] Calling ${this.piProvider} with model: ${model.id} (requested: ${request.model})`,
      );

      const { stableText, volatileText } = splitSystemBlocksForOpenAIPrefix(
        request.system || "",
        request.systemBlocks,
      );
      const piMessageInput =
        request.promptCache && request.promptCache.mode !== "disabled"
          ? prependVolatileSystemContextToMessages(request.messages, volatileText)
          : request.messages;

      // Convert messages to pi-ai format
      const piAiMessages = this.convertMessagesToPiAi(piMessageInput);

      // Convert tools to pi-ai format
      const piAiTools = request.tools ? this.convertToolsToPiAi(request.tools) : undefined;

      // Build context
      const context: PiAiContext = {
        systemPrompt: stableText || request.system,
        messages: piAiMessages,
        tools: piAiTools,
      };

      // Make the API call using pi-ai
      const cacheRetention = mapPromptCacheTtlToPiAiRetention(request.promptCache);
      const sessionId =
        cacheRetention === "none" ? undefined : request.promptCache?.cacheKey || undefined;
      const isOpenAIPiModel =
        String((model as Any).api || "")
          .toLowerCase()
          .includes("openai") || /(?:^|[-/.])(?:gpt|o[1-9])(?:[-/.]|$)/i.test(model.id);
      const cacheFields = isOpenAIPiModel
        ? buildOpenAIPromptCacheFields(
            request.promptCache && request.promptCache.mode !== "disabled"
              ? { ...request.promptCache, mode: "openai_key" }
              : undefined,
            model.id,
          )
        : {};
      const response = await piAiComplete(model, context, {
        apiKey: this.apiKey,
        maxTokens: request.maxTokens,
        signal: request.signal,
        cacheRetention,
        ...(sessionId ? { sessionId } : {}),
        ...(Object.keys(cacheFields).length > 0
          ? {
              onPayload: (payload: unknown) => ({
                ...((payload || {}) as Record<string, Any>),
                ...cacheFields,
              }),
            }
          : {}),
      });

      // Convert pi-ai response to CoWork OS format
      return this.convertPiAiResponse(response);
    } catch (error: Any) {
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        console.log(`[Pi] Request aborted`);
        throw new Error("Request cancelled");
      }

      if (
        request.promptCache &&
        isPromptCacheRequestUnsupportedError(
          error?.status,
          error?.providerMessage || error?.message,
        )
      ) {
        console.warn(`[Pi] Prompt cache controls rejected; retrying without cache controls`);
        return this.createMessage({ ...request, promptCache: undefined });
      }

      console.error(`[Pi] API error (${this.piProvider}):`, {
        message: error.message,
        type: error.type || error.name,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const { complete: piAiComplete } = await loadPiAiModule();
      const model = await this.resolveModel(this.modelId);

      await piAiComplete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Hi" }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: this.apiKey, maxTokens: 10 },
      );

      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || `Failed to connect to ${this.piProvider} via Pi`,
      };
    }
  }

  /**
   * Get available models for the configured Pi provider
   */
  static async getAvailableModels(
    piProvider?: string,
  ): Promise<Array<{ id: string; name: string; description: string }>> {
    const provider = (piProvider as KnownProvider) || DEFAULT_PI_PROVIDER;
    try {
      const { getModels } = await loadPiAiModule();
      const models = getModels(provider);
      return models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        description: `${PI_PROVIDERS[provider as keyof typeof PI_PROVIDERS]?.displayName || provider} - ${m.reasoning ? "Reasoning model" : "Standard model"} (${m.contextWindow.toLocaleString()} ctx)`,
      }));
    } catch (error: Any) {
      console.error(`[Pi] Failed to get models for ${provider}:`, error);
      return [];
    }
  }

  /**
   * Get available Pi providers from pi-ai
   */
  static async getAvailableProviders(): Promise<
    Array<{
      id: string;
      name: string;
    }>
  > {
    try {
      const { getProviders } = await loadPiAiModule();
      const providers = getProviders();
      return providers.map((p) => ({
        id: p,
        name: PI_PROVIDERS[p as keyof typeof PI_PROVIDERS]?.displayName || p,
      }));
    } catch (error: Any) {
      console.error("[Pi] Failed to get providers:", error);
      // Return fallback list
      return Object.entries(PI_PROVIDERS).map(([id, info]) => ({
        id,
        name: info.displayName,
      }));
    }
  }

  /**
   * Resolve model from pi-ai's registry.
   * Requires an exact match — no partial or fallback matching to avoid
   * silently routing to an unintended (and potentially costly) model.
   */
  private async resolveModel(modelId: string): Promise<Model<Any>> {
    const { getModels } = await loadPiAiModule();
    const availableModels = getModels(this.piProvider);
    const found = availableModels.find((m) => m.id === modelId);
    if (found) {
      return found;
    }

    const availableIds = availableModels
      .map((m) => m.id)
      .slice(0, 10)
      .join(", ");
    throw new Error(
      `Model "${modelId}" not found for provider ${this.piProvider}. Available models: ${availableIds}${availableModels.length > 10 ? "..." : ""}`,
    );
  }

  /**
   * Convert messages to pi-ai format
   */
  private convertMessagesToPiAi(messages: LLMMessage[]): PiAiMessage[] {
    const result: PiAiMessage[] = [];
    const now = Date.now();
    // Track tool call IDs to their names so we can populate toolName on results.
    // LLMToolResult doesn't carry tool_name, but pi-ai requires it.
    const toolCallNames = new Map<string, string>();
    const turnStart = currentTurnStartIndex(messages);

    for (const [msgIndex, msg] of messages.entries()) {
      if (typeof msg.content === "string") {
        if (msg.role === "user") {
          result.push({
            role: "user",
            content: [{ type: "text", text: msg.content }],
            timestamp: now,
          });
        } else {
          // pi-ai's AssistantMessage type requires api/provider/model/usage/stopReason
          // fields. These are synthetic placeholders for historical messages being replayed
          // as conversation context — the actual values are unknown at this point.
          result.push({
            role: "assistant",
            content: [{ type: "text", text: msg.content }],
            api: "openai-completions",
            provider: this.piProvider,
            model: this.modelId,
            usage: PLACEHOLDER_USAGE,
            stopReason: "stop",
            timestamp: now,
          });
        }
      } else if (Array.isArray(msg.content)) {
        // Check if this is a tool result array
        const toolResults = msg.content.filter(
          (item): item is LLMToolResult => item.type === "tool_result",
        );

        if (toolResults.length > 0) {
          for (const toolResult of toolResults) {
            result.push({
              role: "toolResult",
              toolCallId: toolResult.tool_use_id,
              toolName: toolCallNames.get(toolResult.tool_use_id) || "",
              content: [{ type: "text", text: toolResult.content }],
              isError: toolResult.is_error || false,
              timestamp: now,
            });
          }
        } else {
          // Handle mixed content (text, tool_use, image)
          if (msg.role === "user") {
            const textContent: Array<{ type: "text"; text: string }> = [];
            for (const item of msg.content) {
              if (item.type === "text") {
                textContent.push({ type: "text" as const, text: (item as Any).text });
              } else if (item.type === "image") {
                // pi-ai SDK doesn't support inline images; use text fallback
                textContent.push({ type: "text" as const, text: imageToTextFallback(item) });
              }
            }

            if (textContent.length > 0) {
              result.push({
                role: "user",
                content: textContent,
                timestamp: now,
              });
            }
          } else {
            // Assistant message with tool calls
            const content: Any[] = [];

            for (const item of msg.content) {
              if (item.type === "text") {
                content.push({ type: "text", text: (item as Any).text });
              } else if (item.type === "tool_use") {
                const toolUse = item as Any;
                toolCallNames.set(toolUse.id, toolUse.name);
                content.push({
                  type: "toolCall",
                  id: toolUse.id,
                  name: toolUse.name,
                  arguments: toolUse.input,
                });
              }
            }

            const replay = msgIndex >= turnStart ? piAiReplay(msg, this.modelId) : null;
            if (replay) content.unshift(...replay.blocks);

            if (content.length > 0) {
              // Synthetic metadata — see comment above for string assistant messages. When
              // replaying reasoning, use the original api/provider so pi-ai keeps it.
              result.push({
                role: "assistant",
                content,
                api: (replay?.api as Any) || "openai-completions",
                provider: (replay?.provider as Any) || this.piProvider,
                model: this.modelId,
                usage: PLACEHOLDER_USAGE,
                stopReason: "stop",
                timestamp: now,
              });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Convert tools to pi-ai format
   */
  private convertToolsToPiAi(tools: LLMTool[]): PiAiTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Any,
    }));
  }

  /**
   * Convert pi-ai response to CoWork OS format
   */
  private convertPiAiResponse(response: PiAiAssistantMessage): LLMResponse {
    const content: LLMContent[] = [];

    if (response.content) {
      for (const block of response.content) {
        if (block.type === "text") {
          content.push({
            type: "text",
            text: block.text,
          });
        } else if (block.type === "toolCall") {
          const parsedArguments = parseOpenAICompatibleToolArguments(block.arguments);
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: parsedArguments.input,
            ...(parsedArguments.inputError ? { inputError: parsedArguments.inputError } : {}),
          });
        }
        // 'thinking' blocks are carried as opaque reasoning (below), not as content.
      }
    }
    const reasoning = reasoningFromPiAiResponse(response);

    // Map stop reason
    let stopReason: LLMResponse["stopReason"] = "end_turn";
    if (response.stopReason === "toolUse") {
      stopReason = "tool_use";
    } else if (response.stopReason === "length") {
      stopReason = "max_tokens";
    }

    return {
      content,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      stopReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.input || 0,
            outputTokens: response.usage.output || 0,
            cachedTokens: response.usage.cacheRead || undefined,
            cacheWriteTokens: response.usage.cacheWrite || undefined,
          }
        : undefined,
    };
  }
}
