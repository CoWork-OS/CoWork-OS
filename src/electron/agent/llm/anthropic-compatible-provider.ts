import {
  LLMProvider,
  LLMProviderType,
  LLMProviderError,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
} from "./types";
import { assertNormalizedTurnTranscript } from "../runtime/turn-transcript-normalizer";
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
import { isOpenCodeGoBaseUrl, normalizeOpenCodeGoModelId } from "./opencode-go-routing";
import { ensureNoTrailingAssistantPrefill } from "./assistant-prefill";
import {
  anthropicReasoningFromResponse,
  anthropicThinkingPrefixSeed,
  applyAnthropicThinkingReplay,
  classifyAnthropicThinkingRejection,
  planAnthropicThinking,
  trailingToolTurnStartsWithThinking,
} from "./anthropic-thinking";
import { createLogger } from "../../utils/logger";

const logger = createLogger("AnthropicCompatible");

const ANTHROPIC_VERSION = "2023-06-01";

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function resolveMessagesUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const lowerBase = trimmedBase.toLowerCase();
  if (lowerBase.endsWith("/messages")) {
    return trimmedBase;
  }
  // Anthropic-compatible providers vary:
  // - Some expose base URLs that already include /v1
  // - Others expose a root (e.g. .../anthropic) and expect /v1/messages
  if (/\/v\d+(?:[a-z]+\d*)?$/i.test(trimmedBase)) {
    return joinUrl(trimmedBase, "/messages");
  }
  return joinUrl(trimmedBase, "/v1/messages");
}

function resolveModelsUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const lowerBase = trimmedBase.toLowerCase();
  if (lowerBase.endsWith("/models")) {
    return trimmedBase;
  }
  if (/\/v\d+(?:[a-z]+\d*)?$/i.test(trimmedBase)) {
    return joinUrl(trimmedBase, "/models");
  }
  return joinUrl(trimmedBase, "/v1/models");
}

function isNanoGptBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    return hostname === "nano-gpt.com" || hostname.endsWith(".nano-gpt.com");
  } catch {
    return false;
  }
}

function extractProviderErrorMessage(errorData: Any): string {
  const error = errorData?.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    return typeof error.message === "string" ? error.message : "";
  }
  return typeof errorData?.message === "string" ? errorData.message : "";
}

export interface AnthropicCompatibleProviderOptions {
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /**
   * Send Anthropic thinking/effort parameters for recognised Claude models. Only
   * for endpoints that serve Anthropic's own models (Azure Anthropic); thinking
   * blocks returned by any endpoint are replayed regardless.
   */
  sendThinkingConfig?: boolean;
  reasoningEffort?: string;
}

interface ThinkingRequestOptions {
  replay: boolean;
  sendConfig: boolean;
}

export class AnthropicCompatibleProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private apiKey: string;
  private baseUrl: string;
  private messagesUrl: string;
  private defaultModel: string;
  private providerName: string;
  private promptCacheAutoSupported = true;
  private managedPromptCacheSupported = true;
  private readonly sendThinkingConfig: boolean;
  private readonly reasoningEffort?: string;
  /** Models whose endpoint rejected thinking/effort parameters (sticky per instance). */
  private readonly thinkingConfigRejectedModels = new Set<string>();

  constructor(options: AnthropicCompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.messagesUrl = resolveMessagesUrl(options.baseUrl);
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.managedPromptCacheSupported = !isNanoGptBaseUrl(options.baseUrl);
    this.sendThinkingConfig = options.sendThinkingConfig === true;
    this.reasoningEffort = options.reasoningEffort;
  }

  private normalizeModelForEndpoint(model: string): string {
    const trimmed = model.trim();
    if (isOpenCodeGoBaseUrl(this.baseUrl) && trimmed.toLowerCase().startsWith("opencode-go/")) {
      return normalizeOpenCodeGoModelId(trimmed);
    }
    return trimmed;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const tools = request.tools ? this.convertTools(request.tools) : undefined;
    const model = this.normalizeModelForEndpoint(request.model || this.defaultModel);
    const normalizedMessages = ensureNoTrailingAssistantPrefill(
      assertNormalizedTurnTranscript(request.messages, (message) =>
        console.warn(`[${this.providerName}] ${message}`),
      ),
      model,
    );
    const requestedPromptCache =
      request.promptCache?.mode === "disabled" || !this.managedPromptCacheSupported
        ? undefined
        : request.promptCache;
    const effectivePromptCache =
      requestedPromptCache?.mode === "anthropic_auto" && !this.promptCacheAutoSupported
        ? { ...requestedPromptCache, mode: "anthropic_explicit" as const }
        : requestedPromptCache;

    const thinking: ThinkingRequestOptions = {
      replay: true,
      sendConfig: this.sendThinkingConfig && !this.thinkingConfigRejectedModels.has(model),
    };

    try {
      console.log(`[${this.providerName}] Calling API with model: ${model}`);
      return await this.sendRequest({
        request,
        normalizedMessages,
        tools,
        model,
        promptCache: effectivePromptCache,
        thinking,
      });
    } catch (error: Any) {
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        console.log(`[${this.providerName}] Request aborted`);
        throw new Error("Request cancelled");
      }

      // A thinking block or parameter the endpoint rejects: retry once without them.
      const rejection = classifyAnthropicThinkingRejection(
        error?.status,
        error?.providerMessage || error?.message || "",
      );
      if (rejection && error?.usedThinking === true) {
        logger.warn(
          `${this.providerName} rejected thinking; retrying without thinking blocks or parameters`,
          { model, status: error?.status, reason: rejection },
        );
        if (rejection === "config") this.thinkingConfigRejectedModels.add(model);
        return await this.sendRequest({
          request,
          normalizedMessages,
          tools,
          model,
          promptCache: effectivePromptCache,
          thinking: { replay: false, sendConfig: false },
        });
      }

      if (
        effectivePromptCache &&
        isPromptCacheRequestUnsupportedError(
          error?.status,
          error?.providerMessage || error?.message,
        )
      ) {
        console.warn(
          `[${this.providerName}] Prompt cache controls rejected; retrying without cache controls`,
        );
        return await this.sendRequest({
          request,
          normalizedMessages,
          tools,
          model,
          promptCache: undefined,
          thinking,
        });
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
      const response = await fetch(this.messagesUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          ...(this.apiKey
            ? {
                "x-api-key": this.apiKey,
                Authorization: `Bearer ${this.apiKey}`,
              }
            : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Any;
        const providerMessage = extractProviderErrorMessage(errorData);
        return {
          success: false,
          error: providerMessage || `HTTP ${response.status}: ${response.statusText}`,
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
      const headers: Record<string, string> = {
        "anthropic-version": ANTHROPIC_VERSION,
      };
      if (this.apiKey) {
        headers["x-api-key"] = this.apiKey;
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(resolveModelsUrl(this.baseUrl), {
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.warn(
          `[${this.providerName}] Model refresh failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
        );
        return [];
      }

      const data = (await response.json()) as Any;
      const collections = [
        data,
        data?.data,
        data?.models,
        data?.data?.models,
        data?.result,
        data?.result?.models,
        data?.model_list,
        data?.modelList,
      ];
      const modelList = collections.find((value) => Array.isArray(value)) as Any[] | undefined;
      if (!modelList || modelList.length === 0) {
        console.warn(
          `[${this.providerName}] Model refresh returned no parseable models. Response keys: ${
            data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data
          }`,
        );
        return [];
      }

      return modelList
        .map((model: Any) => {
          const id = model.id || model.model || model.model_id || model.name;
          if (!id || typeof id !== "string") return null;
          return {
            id,
            name: model.display_name || model.displayName || model.model_name || model.name || id,
          };
        })
        .filter((model): model is { id: string; name: string } => !!model);
    } catch (error) {
      console.error(`[${this.providerName}] Failed to fetch models:`, error);
      return [];
    }
  }

  private convertMessages(messages: LLMMessage[]): Array<{ role: string; content: Any }> {
    return messages.map((msg) => {
      if (typeof msg.content === "string") {
        return {
          role: msg.role,
          content: msg.content,
        };
      }

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
              media_type: item.mimeType,
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
    });
  }

  private async sendRequest(args: {
    request: LLMRequest;
    normalizedMessages: LLMMessage[];
    tools: Array<{ name: string; description: string; input_schema: Any }> | undefined;
    model: string;
    promptCache: LLMRequest["promptCache"] | undefined;
    thinking: ThinkingRequestOptions;
  }): Promise<LLMResponse> {
    const systemTexts = normalizeSystemBlocks(args.request.system, args.request.systemBlocks).map(
      (block) => block.text,
    );
    const replay = applyAnthropicThinkingReplay({
      messages: args.normalizedMessages,
      converted: this.convertMessages(args.normalizedMessages),
      model: args.model,
      provider: this.type,
      seed: anthropicThinkingPrefixSeed(
        systemTexts.length > 0 ? systemTexts : [args.request.system],
        args.tools,
      ),
      replay: args.thinking.replay,
    });
    let plan = args.thinking.sendConfig
      ? planAnthropicThinking({
          model: args.model,
          maxTokens: args.request.maxTokens,
          effort: args.request.reasoningEffort || this.reasoningEffort,
        })
      : { maxTokens: args.request.maxTokens };
    if (plan.thinking?.type === "enabled" && !trailingToolTurnStartsWithThinking(replay.messages)) {
      // Budget-mode thinking needs the tool-calling turn to start with its thinking.
      plan = {
        ...(plan.outputConfig ? { outputConfig: plan.outputConfig } : {}),
        maxTokens: args.request.maxTokens,
      };
    }
    const usedThinking = replay.replayedBlocks > 0 || Boolean(plan.thinking || plan.outputConfig);
    const messages = this.buildMessagesPayload(replay.messages, args.promptCache);
    const response = await fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.apiKey
          ? {
              "x-api-key": this.apiKey,
              Authorization: `Bearer ${this.apiKey}`,
            }
          : {}),
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: plan.maxTokens,
        system: this.buildSystemPayload(args.request, args.promptCache),
        messages,
        ...(args.tools && { tools: args.tools }),
        ...(plan.thinking && { thinking: plan.thinking }),
        ...(plan.outputConfig && { output_config: plan.outputConfig }),
        ...(args.promptCache?.mode === "anthropic_auto"
          ? { cache_control: buildAnthropicCacheMarker(args.promptCache.ttl) }
          : {}),
      }),
      signal: args.request.signal,
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as Any;
      const providerMessage = extractProviderErrorMessage(errorData);
      if (
        args.promptCache?.mode === "anthropic_auto" &&
        isPromptCacheAutoUnsupportedError(response.status, providerMessage)
      ) {
        this.promptCacheAutoSupported = false;
        console.warn(
          `[${this.providerName}] Automatic prompt caching rejected by endpoint; downgrading this provider instance to explicit caching.`,
          {
            status: response.status,
            message: providerMessage,
          },
        );
        return this.sendRequest({
          ...args,
          promptCache: { ...args.promptCache, mode: "anthropic_explicit" },
        });
      }

      const error = new Error(
        `${this.providerName} API error: ${response.status} ${response.statusText}` +
          (providerMessage ? ` - ${providerMessage}` : ""),
      ) as LLMProviderError;
      error.status = response.status;
      error.providerMessage = providerMessage || undefined;
      error.errorData = errorData;
      (error as LLMProviderError & { usedThinking?: boolean }).usedThinking = usedThinking;
      throw error;
    }

    const data = (await response.json()) as Any;
    return this.convertResponse(data, { model: args.model, prefixHash: replay.prefixHash });
  }

  private buildSystemPayload(
    request: Pick<LLMRequest, "system" | "systemBlocks">,
    promptCache: LLMRequest["promptCache"] | undefined,
  ):
    | string
    | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } }> {
    const blocks = normalizeSystemBlocks(request.system, request.systemBlocks);
    if (blocks.length === 0) {
      return request.system;
    }

    const parts = convertSystemBlocksToTextParts(request.system, request.systemBlocks);
    if (promptCache?.mode === "anthropic_explicit") {
      applyExplicitSystemBlockMarker(parts, blocks, promptCache.ttl);
    }

    if (!request.systemBlocks && parts.length === 1 && !parts[0].cache_control) {
      return parts[0].text;
    }

    return parts;
  }

  private buildMessagesPayload(
    converted: Array<{ role: string; content: Any }>,
    promptCache: LLMRequest["promptCache"] | undefined,
  ): Array<{ role: string; content: Any }> {
    if (promptCache?.mode !== "anthropic_explicit") {
      return converted;
    }

    return applyAnthropicExplicitCacheControl(converted, {
      ttl: promptCache.ttl,
      includeSystem: false,
      maxBreakpoints: Math.max(0, promptCache.explicitRecentMessages || 3),
      nativeAnthropic: true,
    }) as Array<{ role: string; content: Any }>;
  }

  private convertTools(
    tools: LLMTool[],
  ): Array<{ name: string; description: string; input_schema: Any }> {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private convertResponse(
    response: Any,
    produced: { model: string; prefixHash: string },
  ): LLMResponse {
    const content: LLMContent[] = (response.content || [])
      .filter((block: Any) => block.type === "text" || block.type === "tool_use")
      .map((block: Any) => {
        if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, Any>,
          };
        }
        return {
          type: "text" as const,
          text: block.text || "",
        };
      });

    const visibleContent: LLMContent[] =
      content.length > 0 ? content : [{ type: "text", text: "" }];
    const reasoning = anthropicReasoningFromResponse({
      content: response.content,
      visibleContent: this.convertMessages([{ role: "assistant", content: visibleContent }])[0]
        ?.content,
      model: produced.model,
      provider: this.type,
      prefixHash: produced.prefixHash,
    });

    return {
      content: visibleContent,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: extractAnthropicUsage(response.usage),
    };
  }

  private mapStopReason(reason?: string): LLMResponse["stopReason"] {
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
