import {
  currentTurnStartIndex,
  piAiReplay,
  reasoningFromPiAiResponse,
  reasoningFromResponsesOutput,
  responsesReplayItems,
} from "./reasoning-replay";
import OpenAI from "openai";
import type {
  Model,
  Message as PiAiMessage,
  Context as PiAiContext,
  Tool as PiAiTool,
} from "@earendil-works/pi-ai";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMSystemBlock,
  LLMTool,
  LLMToolResult,
  LLMToolUse,
  LLMTextContent,
  LLMImageContent,
  OpenAIReasoningEffort,
  LLMTextVerbosity,
} from "./types";
import { OpenAIOAuth, OpenAIOAuthTokens } from "./openai-oauth";
import { OpenAISiwcError, OpenAISiwcOAuth, SIWC_RESOURCE, siwcFetch } from "./openai-siwc-oauth";
import { imageToTextFallback } from "./image-utils";
import { loadPiAiModule } from "./pi-ai-loader";
import {
  mapResponsesApiStopReason,
  parseOpenAICompatibleToolArguments,
  toOpenAICompatibleMessages,
} from "./openai-compatible";
import { resolveOutputTokenParamName, withReasoningOutputHeadroom } from "./output-token-policy";
import { classifyProviderError } from "./provider-error-classifier";
import {
  buildOpenAIPromptCacheFields,
  extractOpenAICompatibleCacheUsage,
  extractPiAiUsage,
  isPromptCacheRequestUnsupportedError,
  mapPromptCacheTtlToPiAiRetention,
  prependVolatileSystemContextToMessages,
  splitSystemBlocksForOpenAIPrefix,
} from "./prompt-cache";
import { createLogger } from "../../utils/logger";

// Default model for openai-codex (ChatGPT backend)
const DEFAULT_CODEX_MODEL = "gpt-6-astra";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CHATGPT_SUBSCRIPTION_MODEL_IDS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
];
const UNSUPPORTED_CHATGPT_SUBSCRIPTION_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);
// Sign in with ChatGPT (SIWC) plan usage: the preview route rejects these Responses
// fields, requires store=false/stream=true, and only accepts function tools grouped
// in a namespace. https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
const SIWC_UNSUPPORTED_RESPONSES_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "previous_response_id",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;
const SIWC_TOOL_NAMESPACE = "cowork";
// Models confirmed to work through SIWC plan usage even though OpenAI's /models
// catalog does not list them (verified 2026-10-02 with gpt-6.1-sol).
const SIWC_UNLISTED_MODEL_IDS = ["gpt-6.1-sol"];
// The SIWC route rejects prompt-cache fields for every request, and providers are
// created per task, so remember the rejection for the whole app session.
let siwcPromptCacheUnsupported = false;
// The ChatGPT OAuth and API-key routes can reject prompt-cache fields per model. Providers
// are created per task, so an instance flag would re-pay the failed request on every task;
// remember rejections by route and model for the whole app session instead.
const promptCacheRejectedModels = new Set<string>();
const promptCacheRejectionKey = (route: "oauth" | "api_key", model: string | undefined) =>
  `${route}:${model || ""}`;
/** Test hook: forget remembered prompt-cache rejections. */
export function resetPromptCacheRejectionsForTests(): void {
  siwcPromptCacheUnsupported = false;
  promptCacheRejectedModels.clear();
}
const SIWC_NON_RETRYABLE_ERROR_CODES = new Set([
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
]);
const SIWC_RETRYABLE_ERROR_CODES = new Set([
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);
const logger = createLogger("OpenAI");

const isToolResult = (item: LLMContent | LLMToolResult): item is LLMToolResult =>
  item?.type === "tool_result";
const isToolUse = (item: LLMContent | LLMToolResult): item is LLMToolUse =>
  item?.type === "tool_use";
const isTextContent = (item: LLMContent | LLMToolResult): item is LLMTextContent =>
  item?.type === "text";
const isImageContent = (item: LLMContent | LLMToolResult): item is LLMImageContent =>
  item?.type === "image";

type OpenAIProviderErrorPhase = "api_key" | "oauth";

class OpenAIProviderError extends Error {
  code?: string;
  retryable?: boolean;
  phase?: OpenAIProviderErrorPhase;
}

/**
 * OpenAI API provider implementation
 * Supports both API key and OAuth token authentication
 * - API Key: Uses OpenAI SDK directly with api.openai.com
 * - OAuth: Uses pi-ai SDK with ChatGPT backend (chatgpt.com/backend-api/)
 */
export class OpenAIProvider implements LLMProvider {
  readonly type = "openai" as const;
  private client: OpenAI | null = null;
  private authMethod: "api_key" | "oauth";
  private oauthTokens?: OpenAIOAuthTokens;
  private model: string;
  private openaiReasoningEffort?: OpenAIReasoningEffort;
  private openaiTextVerbosity?: LLMTextVerbosity;
  private openaiBaseUrl?: string;
  private forceResponsesApi: boolean;
  private oauthTokenUpdater?: LLMProviderConfig["openaiOAuthTokenUpdater"];
  /** Set when the OAuth tokens come from Sign in with ChatGPT (public Responses API). */
  private siwcClientId?: string;
  // ChatGPT's compatibility backend can reject prompt-cache metadata for an
  // entire provider session. Remember that capability after the first explicit
  // rejection so every later turn does not pay for another failed request and
  // retry. A new provider instance (for example after account/model changes)
  // starts with a fresh capability probe.

  constructor(config: LLMProviderConfig) {
    const apiKey = config.openaiApiKey;
    const accessToken = config.openaiAccessToken;
    const refreshToken = config.openaiRefreshToken;
    const tokenExpiresAt = config.openaiTokenExpiresAt;
    this.model = config.model;
    this.openaiReasoningEffort = config.openaiReasoningEffort || "medium";
    this.openaiTextVerbosity = config.openaiTextVerbosity || "medium";
    this.openaiBaseUrl = config.openaiBaseUrl;
    this.forceResponsesApi = config.openaiResponsesApi === true;
    this.oauthTokenUpdater = config.openaiOAuthTokenUpdater;

    if (accessToken && refreshToken) {
      // Use OAuth - will use pi-ai SDK for API calls
      this.oauthTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at:
          typeof tokenExpiresAt === "number" &&
          Number.isFinite(tokenExpiresAt) &&
          tokenExpiresAt > 0
            ? tokenExpiresAt
            : 0,
      };
      this.authMethod = "oauth";
      this.siwcClientId = config.openaiSiwcClientId?.trim() || undefined;
      logger.debug(
        `Using ${this.siwcClientId ? "Sign in with ChatGPT" : "OAuth authentication with pi-ai SDK"} (token expires: ${
          this.oauthTokens.expires_at
            ? new Date(this.oauthTokens.expires_at).toISOString()
            : "unknown"
        })`,
      );
    } else if (apiKey) {
      // Use API key - standard OpenAI SDK
      this.client = new OpenAI({
        apiKey,
        ...(this.openaiBaseUrl ? { baseURL: this.openaiBaseUrl } : {}),
      });
      this.authMethod = "api_key";
      logger.debug("Using API key authentication");
    } else {
      throw new Error("OpenAI authentication required. Use API key or sign in with ChatGPT.");
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    if (this.isSiwc()) {
      return this.createMessageWithSiwc(request);
    }
    if (this.authMethod === "oauth") {
      return this.createMessageWithOAuth(request);
    } else {
      return this.createMessageWithApiKey(request);
    }
  }

  private toStructuredProviderError(error: Any, phase: OpenAIProviderErrorPhase): Error {
    const message = String(error?.message || "OpenAI request failed");
    const wrapped = new OpenAIProviderError(message);
    const classification = classifyProviderError(error);
    wrapped.name = error?.name || "OpenAIProviderError";
    wrapped.phase = phase;
    wrapped.code =
      String(error?.code || error?.cause?.code || classification.code || "").trim() || undefined;
    // SDK connection errors ("Connection error.") carry their errno several causes
    // deep, and an exhausted quota arrives as a 429; the shared classifier handles both.
    wrapped.retryable = classification.retryable;
    if (error?.status !== undefined) {
      (wrapped as Any).status = error.status;
    }
    (wrapped as Any).cause = error;
    return wrapped;
  }

  private async persistOAuthTokens(
    tokens: Parameters<NonNullable<LLMProviderConfig["openaiOAuthTokenUpdater"]>>[0] | undefined,
  ): Promise<void> {
    if (!tokens || !this.oauthTokenUpdater) return;
    try {
      await this.oauthTokenUpdater(tokens);
    } catch (error) {
      logger.warn("Failed to persist refreshed OpenAI OAuth tokens:", error);
    }
  }

  private normalizeCodexModelId(modelId: string): string {
    const trimmed = String(modelId || "").trim();
    const withoutProvider = /^(?:openai-codex|openai)\//i.test(trimmed)
      ? trimmed.slice(trimmed.indexOf("/") + 1)
      : trimmed;
    const withoutProfile = withoutProvider.includes("@")
      ? withoutProvider.slice(0, withoutProvider.indexOf("@"))
      : withoutProvider;
    return withoutProfile || DEFAULT_CODEX_MODEL;
  }

  private createCodexModel(modelId: string, availableModels: Array<Model<Any>>): Model<Any> {
    const normalizedId = this.mapToCodexModel(modelId);
    const found = availableModels.find((m) => m.id === normalizedId);
    if (found) return found;

    const template =
      availableModels.find((m) => m.id === DEFAULT_CODEX_MODEL) || availableModels[0];
    logger.debug(
      `Model ${normalizedId} not found in pi-ai registry; using OpenAI Codex model compatibility shim.`,
    );
    const contextWindow =
      /^gpt-6(?:\.\d+)?-/.test(normalizedId) || normalizedId === "gpt-5.4"
        ? 1_050_000
        : normalizedId === "gpt-5.5"
          ? 400_000
          : 272_000;
    return {
      ...template,
      id: normalizedId,
      name: this.formatModelName(normalizedId),
      api: OPENAI_CODEX_API,
      provider: OPENAI_CODEX_PROVIDER,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: normalizedId.includes("spark") ? ["text"] : ["text", "image"],
      contextWindow,
      maxTokens: 128_000,
    } as Model<Any>;
  }

  /**
   * Create message using API key (standard OpenAI SDK)
   */
  private async createMessageWithApiKey(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }

    if (this.shouldUseResponsesApi(request.model)) {
      return this.createResponsesMessageWithApiKey(request);
    }

    const model = this.normalizeCodexModelId(request.model || this.model || DEFAULT_CODEX_MODEL);
    const messages = this.convertMessages(request.messages, request.system, request.systemBlocks);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      logger.debug(`Calling API with model: ${model}`);
      const tokenField = resolveOutputTokenParamName({
        providerType: this.type,
        modelId: model,
        apiMode: "chat_completions",
      });

      const body: Any = {
        model,
        [tokenField]: request.maxTokens,
        messages,
        ...(tools && tools.length > 0
          ? {
              tools,
              tool_choice: request.toolChoice || "auto",
            }
          : {}),
        ...buildOpenAIPromptCacheFields(request.promptCache, model),
      };
      const response = await this.client.chat.completions.create(
        body,
        request.signal ? { signal: request.signal } : undefined,
      );

      return this.convertResponse(response);
    } catch (error: Any) {
      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      if (
        request.promptCache &&
        isPromptCacheRequestUnsupportedError(error?.status, error?.message || "")
      ) {
        logger.warn("Prompt cache controls rejected; retrying without cache controls", {
          model,
          status: error?.status,
        });
        return this.createMessageWithApiKey({ ...request, promptCache: undefined });
      }

      logger.error("API error:", {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
      });
      throw this.toStructuredProviderError(error, "api_key");
    }
  }

  private shouldUseResponsesApi(modelId: string | undefined): boolean {
    const normalizedModelId = this.normalizeCodexModelId(modelId || this.model).toLowerCase();
    return (
      this.forceResponsesApi ||
      /^gpt-6(?:\.\d+)?-/.test(normalizedModelId) ||
      normalizedModelId.startsWith("gpt-5")
    );
  }

  private getOpenAIReasoningEffort(request: LLMRequest): OpenAIReasoningEffort | undefined {
    const configured = request.reasoningEffort || this.openaiReasoningEffort || "medium";
    if (
      this.normalizeCodexModelId(request.model || this.model).toLowerCase() === "gpt-6.1-sol" &&
      configured === "none"
    ) {
      return "low";
    }
    // The public API exposes Astra's highest setting as `max`; `ultra` is
    // reserved for the ChatGPT subscription compatibility backend. SIWC uses the
    // public API even though it authenticates with OAuth.
    return (this.authMethod === "api_key" || this.isSiwc()) && configured === "ultra"
      ? "max"
      : configured;
  }

  private getOpenAITextVerbosity(request: LLMRequest): LLMTextVerbosity | undefined {
    return request.textVerbosity || this.openaiTextVerbosity || "medium";
  }

  private buildResponsesInput(
    messages: LLMMessage[],
    system?: string,
    systemBlocks?: LLMSystemBlock[],
    replayModel?: string,
  ): Any[] {
    const input: Any[] = [];
    const { volatileText } = splitSystemBlocksForOpenAIPrefix(system || "", systemBlocks);

    if (volatileText) {
      input.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: volatileText }],
      });
    }

    const turnStart = currentTurnStartIndex(messages);

    for (const [msgIndex, msg] of messages.entries()) {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: msg.role,
          content: [
            {
              type: msg.role === "assistant" ? "output_text" : "input_text",
              text: msg.content,
            },
          ],
          ...(msg.role === "assistant" && msg.phase ? { phase: msg.phase } : {}),
        });
        continue;
      }

      if (!Array.isArray(msg.content)) {
        continue;
      }

      if (replayModel && msg.role === "assistant" && msgIndex >= turnStart) {
        input.push(...responsesReplayItems(msg, replayModel));
      }

      for (const item of msg.content) {
        if (isToolResult(item)) {
          input.push({
            type: "function_call_output",
            call_id: item.tool_use_id,
            output:
              typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""),
          });
        }
      }

      const textBlocks = msg.content.filter(isTextContent);
      const imageBlocks = msg.content.filter(isImageContent);
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const contentParts: Any[] = textBlocks.map((block) => ({
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: block.text,
        }));
        for (const img of imageBlocks) {
          contentParts.push({
            type: "input_image",
            image_url: `data:${img.mimeType};base64,${img.data}`,
          });
        }
        input.push({
          type: "message",
          role: msg.role,
          content: contentParts,
          ...(msg.role === "assistant" && msg.phase ? { phase: msg.phase } : {}),
        });
      }

      if (msg.role === "assistant") {
        const toolUses = msg.content.filter(isToolUse);
        for (const toolUse of toolUses) {
          input.push({
            type: "function_call",
            call_id: toolUse.id,
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input ?? {}),
            ...(msg.phase ? { phase: msg.phase } : {}),
          });
        }
      }
    }

    return input;
  }

  private toResponsesTools(tools: LLMTool[]): Array<{
    type: "function";
    name: string;
    description: string;
    parameters: Any;
    strict: false;
  }> {
    return tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: this.sanitizeResponsesSchema(tool.input_schema),
      // Responses defaults to strict normalization, which makes optional MCP
      // filters mandatory. Preserve the server's original required fields.
      strict: false,
    }));
  }

  private sanitizeResponsesSchema(schema: Any): Any {
    if (!schema || typeof schema !== "object") return schema;
    const result: Any = Array.isArray(schema) ? [...schema] : { ...schema };
    if (result.properties && typeof result.properties === "object") {
      const nextProperties: Record<string, Any> = {};
      for (const [key, value] of Object.entries(result.properties)) {
        nextProperties[key] = this.sanitizeResponsesSchema(value);
      }
      result.properties = nextProperties;
    }
    if (result.items) {
      result.items = this.sanitizeResponsesSchema(result.items);
    }
    if (result.type === "array" && !result.items) {
      result.items = { type: "string" };
    }
    return result;
  }

  private buildResponsesBody(request: LLMRequest): Record<string, Any> {
    const { stableText } = splitSystemBlocksForOpenAIPrefix(
      request.system || "",
      request.systemBlocks,
    );
    const instructions =
      stableText || (!request.systemBlocks && request.system ? request.system : "") || undefined;
    const tools = request.tools ? this.toResponsesTools(request.tools) : undefined;
    const reasoningEffort = this.getOpenAIReasoningEffort(request);
    const textVerbosity = this.getOpenAITextVerbosity(request);
    return {
      model: this.normalizeCodexModelId(request.model || this.model || DEFAULT_CODEX_MODEL),
      input: this.buildResponsesInput(
        request.messages,
        request.system,
        request.systemBlocks,
        this.normalizeCodexModelId(request.model || this.model || DEFAULT_CODEX_MODEL),
      ),
      ...(instructions ? { instructions } : {}),
      max_output_tokens: reasoningEffort
        ? withReasoningOutputHeadroom(request.maxTokens, reasoningEffort)
        : request.maxTokens,
      ...(reasoningEffort
        ? {
            reasoning: { effort: reasoningEffort },
            // Return encrypted reasoning so it can be replayed on the next request in
            // this turn (see reasoning-replay.ts); works with or without response storage.
            include: ["reasoning.encrypted_content"],
          }
        : {}),
      ...(textVerbosity ? { text: { verbosity: textVerbosity } } : {}),
      ...(tools && tools.length > 0
        ? {
            tools,
            tool_choice: request.toolChoice || "auto",
          }
        : {}),
      ...buildOpenAIPromptCacheFields(
        request.promptCache,
        request.model || this.model || DEFAULT_CODEX_MODEL,
      ),
    };
  }

  private async createResponsesMessageWithApiKey(request: LLMRequest): Promise<LLMResponse> {
    if (
      request.promptCache &&
      promptCacheRejectedModels.has(promptCacheRejectionKey("api_key", request.model))
    ) {
      return this.createResponsesMessageWithApiKey({ ...request, promptCache: undefined });
    }
    try {
      logger.debug(`Calling Responses API with model: ${request.model}`);
      const body = this.buildResponsesBody(request);
      const response = await (this.client as Any).responses.create(
        body,
        request.signal ? { signal: request.signal } : undefined,
      );
      return this.convertResponsesResponse(response, body.model);
    } catch (error: Any) {
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      if (
        request.promptCache &&
        isPromptCacheRequestUnsupportedError(error?.status, error?.message || "")
      ) {
        promptCacheRejectedModels.add(promptCacheRejectionKey("api_key", request.model));
        logger.warn("Responses prompt cache controls rejected; retrying without cache controls", {
          model: request.model,
          status: error?.status,
        });
        return this.createResponsesMessageWithApiKey({ ...request, promptCache: undefined });
      }

      logger.error("Responses API error:", {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
      });
      throw this.toStructuredProviderError(error, "api_key");
    }
  }

  private convertResponsesResponse(response: Any, requestModel?: string): LLMResponse {
    const content: LLMContent[] = [];
    for (const item of response?.output || []) {
      if (item?.type === "message") {
        for (const part of item.content || []) {
          const text = part?.text || part?.content || "";
          if (
            text &&
            (part.type === "output_text" ||
              part.type === "text" ||
              part.type === "input_text" ||
              !part.type)
          ) {
            content.push({ type: "text", text });
          }
        }
      } else if (item?.type === "function_call") {
        const parsedArguments = parseOpenAICompatibleToolArguments(item.arguments);
        content.push({
          type: "tool_use",
          id: item.call_id || item.id,
          name: item.name,
          input: parsedArguments.input,
          ...(parsedArguments.inputError ? { inputError: parsedArguments.inputError } : {}),
        });
      } else if (item?.type === "output_text" && item.text) {
        content.push({ type: "text", text: item.text });
      }
    }

    const hasToolUse = content.some((item) => item.type === "tool_use");
    const stopReason = mapResponsesApiStopReason(response, hasToolUse);

    const usage = response?.usage;
    // Tag with the id we requested (and replay against), not response.model, which the
    // API may resolve to a dated snapshot id that would never match on replay.
    const reasoning = reasoningFromResponsesOutput(
      response?.output,
      String(requestModel || response?.model || this.model || ""),
    );
    return {
      content,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      stopReason,
      usage: usage
        ? {
            inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
            outputTokens: usage.output_tokens || usage.completion_tokens || 0,
            cachedTokens:
              usage.input_tokens_details?.cached_tokens ||
              usage.prompt_tokens_details?.cached_tokens ||
              undefined,
            cacheWriteTokens:
              usage.input_tokens_details?.cache_write_tokens ??
              usage.prompt_tokens_details?.cache_write_tokens ??
              usage.input_tokens_details?.cache_creation_input_tokens ??
              usage.prompt_tokens_details?.cache_creation_input_tokens ??
              usage.cache_write_tokens ??
              undefined,
          }
        : undefined,
    };
  }

  private isSiwc(): boolean {
    return this.authMethod === "oauth" && Boolean(this.siwcClientId);
  }

  /** Returns a current SIWC access token, refreshing and persisting rotated tokens. */
  private async getSiwcAccessToken(): Promise<string> {
    if (!this.oauthTokens || !this.siwcClientId) {
      throw new Error("Sign in with ChatGPT tokens not available");
    }
    const { accessToken, newTokens } = await OpenAISiwcOAuth.getAccessToken(
      this.siwcClientId,
      this.oauthTokens,
    );
    if (newTokens) {
      this.oauthTokens = {
        ...this.oauthTokens,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: newTokens.expires_at,
      };
      await this.persistOAuthTokens({ ...this.oauthTokens, id_token: newTokens.id_token });
    }
    return accessToken;
  }

  /** Builds a Responses body that satisfies the SIWC plan-usage preview route. */
  buildSiwcResponsesBody(request: LLMRequest): Record<string, Any> {
    const model = this.mapToCodexModel(request.model || this.model || DEFAULT_CODEX_MODEL);
    const body: Record<string, Any> = this.buildResponsesBody({ ...request, model });
    for (const field of SIWC_UNSUPPORTED_RESPONSES_FIELDS) delete body[field];
    body.model = model;
    body.store = false;
    body.stream = true;
    body.input = (Array.isArray(body.input) ? body.input : []).map((item: Any) => {
      if (item?.type === "message" && item.role === "system") {
        // Explicit system items are rejected; developer messages are accepted.
        return { ...item, role: "developer" };
      }
      if (item?.type === "function_call" || item?.type === "function_call_output") {
        return { ...item, namespace: SIWC_TOOL_NAMESPACE };
      }
      return item;
    });
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = [
        {
          type: "namespace",
          name: SIWC_TOOL_NAMESPACE,
          description: "CoWork OS tools available to this task.",
          tools: body.tools,
        },
      ];
    } else {
      delete body.tools;
      delete body.tool_choice;
    }
    return body;
  }

  /** Converts SIWC admission/stream errors into actionable provider errors. */
  private toSiwcProviderError(error: Any): Error {
    const status = Number(error?.status) || undefined;
    const body = error?.error && typeof error.error === "object" ? error.error : undefined;
    const code = String(error?.code || body?.code || body?.error?.code || "").trim() || undefined;
    const detail =
      String(body?.detail || body?.message || error?.message || "").trim() ||
      "ChatGPT request failed";
    let message = detail;
    let retryable: boolean | undefined;
    switch (code) {
      case "subscription_sharing_user_not_eligible":
        message =
          "Your ChatGPT plan can't be used in CoWork OS. Sign in with an eligible ChatGPT Plus or Pro account, or use an OpenAI API key.";
        break;
      case "subscription_sharing_usage_limit_exceeded":
        message =
          "CoWork OS reached its ChatGPT usage limit. Wait for the limit to reset or raise the CoWork OS cap in ChatGPT settings.";
        break;
      case "subscription_sharing_unsupported_capability":
        message = `This request uses a feature Sign in with ChatGPT doesn't support yet: ${detail}`;
        break;
      case "subscription_sharing_invalid_user":
        message = "ChatGPT no longer accepts this sign-in. Sign in with ChatGPT again in Settings.";
        break;
      default:
        if (status === 401) {
          message = `ChatGPT rejected the sign-in (401). Sign in with ChatGPT again in Settings. ${detail}`;
        } else if (status === 403) {
          message = `ChatGPT plan usage is not available for this request (403): ${detail}`;
        }
    }
    if (code && SIWC_NON_RETRYABLE_ERROR_CODES.has(code)) retryable = false;
    if ((code && SIWC_RETRYABLE_ERROR_CODES.has(code)) || status === 503) retryable = true;
    if (error instanceof OpenAISiwcError) retryable = false;

    const wrapped = this.toStructuredProviderError({ ...error, message, code, status }, "oauth");
    if (retryable !== undefined) (wrapped as OpenAIProviderError).retryable = retryable;
    (wrapped as Any).cause = error;
    return wrapped;
  }

  /**
   * Create message using Sign in with ChatGPT plan usage (public Responses API,
   * streamed; success only on `response.completed`).
   */
  private async createMessageWithSiwc(request: LLMRequest): Promise<LLMResponse> {
    if (request.promptCache && siwcPromptCacheUnsupported) {
      return this.createMessageWithSiwc({ ...request, promptCache: undefined });
    }
    const body = this.buildSiwcResponsesBody(request);
    try {
      const accessToken = await this.getSiwcAccessToken();
      // Retries are owned by the executor so usage-limit errors are not replayed.
      const client = new OpenAI({ apiKey: accessToken, baseURL: SIWC_RESOURCE, maxRetries: 0 });
      logger.debug(`Calling Responses API via Sign in with ChatGPT with model: ${body.model}`);
      const stream = await (client as Any).responses.create(
        body,
        request.signal ? { signal: request.signal } : undefined,
      );
      let finalResponse: Any;
      // With store=false the terminal event can omit `output`; keep the streamed
      // items (and raw text deltas as a last resort) to rebuild it.
      const streamedItems: Any[] = [];
      let streamedText = "";
      for await (const event of stream as AsyncIterable<Any>) {
        if (event?.type === "response.output_item.done" && event.item) {
          const index = Number.isInteger(event.output_index)
            ? event.output_index
            : streamedItems.length;
          streamedItems[index] = event.item;
        } else if (
          event?.type === "response.output_text.delta" &&
          typeof event.delta === "string"
        ) {
          streamedText += event.delta;
        } else if (event?.type === "response.completed" || event?.type === "response.incomplete") {
          finalResponse = event.response;
        } else if (event?.type === "response.failed") {
          const failure = event.response?.error || {};
          throw Object.assign(new Error(failure.message || "ChatGPT response failed"), {
            code: failure.code,
          });
        } else if (event?.type === "error") {
          throw Object.assign(new Error(event.message || "ChatGPT stream error"), {
            code: event.code,
          });
        }
      }
      if (!finalResponse) {
        throw Object.assign(new Error("ChatGPT stream ended before the response completed"), {
          code: "ECONNRESET",
        });
      }
      const finalOutput: Any[] =
        Array.isArray(finalResponse.output) && finalResponse.output.length > 0
          ? finalResponse.output
          : streamedItems.filter(Boolean);
      if (finalOutput.length === 0 && streamedText) {
        finalOutput.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: streamedText }],
        });
      }
      return this.convertResponsesResponse({ ...finalResponse, output: finalOutput }, body.model);
    } catch (error: Any) {
      if (error?.name === "AbortError" || error?.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }
      if (
        request.promptCache &&
        isPromptCacheRequestUnsupportedError(error?.status, error?.message || "")
      ) {
        siwcPromptCacheUnsupported = true;
        logger.warn("SIWC prompt cache controls rejected; retrying without cache controls", {
          model: body.model,
          status: error?.status,
        });
        return this.createMessageWithSiwc({ ...request, promptCache: undefined });
      }
      logger.error("Sign in with ChatGPT API error:", {
        status: error?.status,
        code: error?.code,
        message: error?.message,
      });
      throw this.toSiwcProviderError(error);
    }
  }

  /** Lists models included with the user's ChatGPT plan (`visibility == "list"`). */
  private async getSiwcModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    const accessToken = await this.getSiwcAccessToken();
    const response = await siwcFetch(`${SIWC_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Failed to list ChatGPT plan models (${response.status})`);
    }
    const payload = (await response.json()) as Any;
    const entries: Any[] = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
    const hasVisibility = entries.some((entry) => typeof entry?.visibility === "string");
    logger.info(
      "Sign in with ChatGPT model catalog:",
      entries
        .map((entry) => `${entry?.slug || entry?.id || "?"}(${entry?.visibility ?? "none"})`)
        .join(", "),
    );
    return entries
      .filter((entry) => !hasVisibility || entry?.visibility === "list")
      .map((entry) => {
        const id = String(entry?.slug || entry?.id || "").trim();
        return {
          id,
          name: String(entry?.display_name || "").trim() || this.formatModelName(id),
          description: this.getModelDescription(id),
        };
      })
      .filter((model) => model.id);
  }

  /**
   * Map public model names to openai-codex model IDs
   */
  private mapToCodexModel(modelId: string): string {
    const normalizedModelId = this.normalizeCodexModelId(modelId);
    // Map common public model names to ChatGPT internal models
    const modelMap: Record<string, string> = {
      // Map legacy OpenAI API model names to ChatGPT-account models.
      "gpt-4o": DEFAULT_CODEX_MODEL,
      "gpt-4o-mini": DEFAULT_CODEX_MODEL,
      // Map o1/reasoning models to gpt-5.2
      o1: "gpt-5.2",
      "o1-mini": "gpt-5.2-codex",
      "o1-preview": "gpt-5.2",
      // Default mappings
      "gpt-4-turbo": "gpt-5.1",
      "gpt-4": "gpt-5.1",
      "gpt-3.5-turbo": DEFAULT_CODEX_MODEL,
    };

    return modelMap[normalizedModelId] || normalizedModelId;
  }

  /**
   * Create message using OAuth (pi-ai SDK with ChatGPT backend)
   */
  private async createMessageWithOAuth(request: LLMRequest): Promise<LLMResponse> {
    if (!this.oauthTokens) {
      throw new Error("OAuth tokens not available");
    }

    if (
      request.promptCache &&
      promptCacheRejectedModels.has(promptCacheRejectionKey("oauth", request.model))
    ) {
      return this.createMessageWithOAuth({ ...request, promptCache: undefined });
    }

    try {
      const { getModels, complete: piAiComplete } = await loadPiAiModule();
      // Map model ID to ChatGPT internal model
      const codexModelId = this.mapToCodexModel(request.model);
      logger.debug(
        `Calling ChatGPT backend with model: ${codexModelId} (requested: ${request.model})`,
      );

      // Get the model object from pi-ai SDK
      let model: Model<Any>;
      try {
        // Get available models and find one that matches
        const availableModels = getModels(OPENAI_CODEX_PROVIDER);
        model = this.createCodexModel(codexModelId, availableModels);
      } catch (e) {
        logger.error("Failed to get model from pi-ai SDK:", e);
        throw new Error(`Model not available: ${codexModelId}`);
      }

      const { allBlocks, stableText, volatileText } = splitSystemBlocksForOpenAIPrefix(
        request.system || "",
        request.systemBlocks,
      );
      const useStableCachePrefix = request.promptCache && request.promptCache.mode !== "disabled";
      const piMessageInput = useStableCachePrefix
        ? prependVolatileSystemContextToMessages(request.messages, volatileText)
        : request.messages;

      // Convert messages to pi-ai format
      const piAiMessages = this.convertMessagesToPiAi(
        piMessageInput,
        Array.isArray((model as Any).input) && (model as Any).input.includes("image"),
      );

      // Convert tools to pi-ai format
      const piAiTools =
        request.toolChoice === "none"
          ? undefined
          : request.tools
            ? this.convertToolsToPiAi(request.tools)
            : undefined;

      // Get API key from OAuth tokens (with auto-refresh)
      const { apiKey, newTokens } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);

      // Update tokens if they were refreshed
      if (newTokens) {
        this.oauthTokens = newTokens;
        await this.persistOAuthTokens(newTokens);
      }

      // Build context
      const context: PiAiContext = {
        // Cache fallback changes transport metadata, never the instructions.
        // Without prefix splitting, retain the normalized blocks in their
        // original order rather than silently dropping current-turn context.
        systemPrompt: useStableCachePrefix
          ? stableText || undefined
          : allBlocks.map((block) => block.text).join("\n\n") || request.system,
        messages: piAiMessages,
        tools: piAiTools,
      };

      // Make the API call using pi-ai SDK
      const cacheRetention = mapPromptCacheTtlToPiAiRetention(request.promptCache);
      const sessionId =
        cacheRetention === "none" ? undefined : request.promptCache?.cacheKey || undefined;
      const cacheFields = buildOpenAIPromptCacheFields(
        request.promptCache && request.promptCache.mode !== "disabled"
          ? { ...request.promptCache, mode: "openai_key" }
          : undefined,
        codexModelId,
      );
      const configuredReasoningEffort = this.getOpenAIReasoningEffort(request);
      const piAiReasoningEffort =
        configuredReasoningEffort === "none" ? "medium" : configuredReasoningEffort;
      const response = await piAiComplete(model, context, {
        apiKey,
        maxTokens: withReasoningOutputHeadroom(request.maxTokens, piAiReasoningEffort),
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
        reasoningEffort: piAiReasoningEffort,
        textVerbosity: this.getOpenAITextVerbosity(request),
      });

      // pi-ai returns an AssistantMessage even on errors (stopReason: "error"/"aborted").
      // Our executor expects provider errors to be thrown so it can retry/fail loudly.
      if (response?.stopReason === "aborted") {
        throw new Error("Request cancelled");
      }
      if (response?.stopReason === "error") {
        throw this.toStructuredProviderError(
          { message: response?.errorMessage || "OpenAI request failed", code: "PI_AI_ERROR" },
          "oauth",
        );
      }

      // Convert pi-ai response to our format
      return this.convertPiAiResponse(response);
    } catch (error: Any) {
      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      if (
        request.promptCache &&
        isPromptCacheRequestUnsupportedError(error?.status, error?.message || "")
      ) {
        promptCacheRejectedModels.add(promptCacheRejectionKey("oauth", request.model));
        logger.warn("ChatGPT prompt cache controls rejected; retrying without cache controls", {
          model: request.model,
          status: error?.status,
        });
        return this.createMessageWithOAuth({ ...request, promptCache: undefined });
      }

      logger.error("ChatGPT API error:", {
        message: error.message,
        type: error.type || error.name,
      });
      throw this.toStructuredProviderError(error, "oauth");
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isSiwc()) {
        await this.createMessageWithSiwc({
          model: this.model,
          maxTokens: 16,
          system: "",
          messages: [{ role: "user", content: "Hi" }],
        });
        return { success: true };
      }
      if (this.authMethod === "oauth") {
        const { getModels, complete: piAiComplete } = await loadPiAiModule();
        // For OAuth, try to get the API key and make a simple request
        if (!this.oauthTokens) {
          return { success: false, error: "OAuth tokens not available" };
        }

        const { apiKey, newTokens } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);
        if (newTokens) {
          this.oauthTokens = newTokens;
          await this.persistOAuthTokens(newTokens);
        }

        // Get a model from the available models
        const availableModels = getModels(OPENAI_CODEX_PROVIDER);
        const model = this.createCodexModel(this.mapToCodexModel(this.model), availableModels);

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
          { apiKey, maxTokens: 10 },
        );

        return { success: true };
      } else {
        // For API key, use standard OpenAI SDK
        if (!this.client) {
          return { success: false, error: "OpenAI client not initialized" };
        }

        const model = this.normalizeCodexModelId(this.model || DEFAULT_CODEX_MODEL);
        if (this.forceResponsesApi || this.shouldUseResponsesApi(this.model)) {
          await (this.client as Any).responses.create({
            model,
            input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
            max_output_tokens: 10,
          });
          return { success: true };
        }

        await this.client.chat.completions.create({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        });
        return { success: true };
      }
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to OpenAI API",
      };
    }
  }

  /**
   * Get available models
   * For API key: uses the models.list API
   * For OAuth: uses pi-ai SDK's model list for openai-codex provider
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    if (this.isSiwc()) {
      try {
        const models = await this.getSiwcModels();
        if (models.length > 0) {
          logger.info(`Listed ${models.length} ChatGPT plan models via Sign in with ChatGPT.`);
          for (const id of SIWC_UNLISTED_MODEL_IDS) {
            if (!models.some((model) => model.id === id)) {
              models.push({
                id,
                name: this.formatModelName(id),
                description: `${this.getModelDescription(id)} (not in OpenAI's list for your plan)`,
              });
            }
          }
          const priority = (id: string) => {
            const index = CHATGPT_SUBSCRIPTION_MODEL_IDS.indexOf(id);
            return index >= 0 ? index : CHATGPT_SUBSCRIPTION_MODEL_IDS.length;
          };
          return models.sort((a, b) => priority(a.id) - priority(b.id));
        }
        logger.warn("Sign in with ChatGPT returned no listable models; using built-in defaults.");
        return this.getDefaultCodexModels();
      } catch (error) {
        logger.error("Failed to list Sign in with ChatGPT models; using built-in defaults:", error);
        return this.getDefaultCodexModels();
      }
    }

    // For OAuth authentication, use pi-ai SDK's model list
    if (this.authMethod === "oauth") {
      logger.debug("Using OAuth - fetching models from pi-ai SDK...");

      try {
        const { getModels } = await loadPiAiModule();
        // Get models from pi-ai SDK for openai-codex provider
        const piAiModels = getModels(OPENAI_CODEX_PROVIDER);

        const models = piAiModels
          .filter((m) => !UNSUPPORTED_CHATGPT_SUBSCRIPTION_MODEL_IDS.has(m.id))
          .map((m) => ({
            id: m.id,
            name: m.name || this.formatModelName(m.id),
            description: this.getModelDescription(m.id),
          }));
        for (const id of CHATGPT_SUBSCRIPTION_MODEL_IDS) {
          if (!models.some((model) => model.id === id)) {
            models.push({
              id,
              name: this.formatModelName(id),
              description: this.getModelDescription(id),
            });
          }
        }

        // Sort by priority
        models.sort((a, b) => {
          const priority = (id: string) => {
            const knownIndex = CHATGPT_SUBSCRIPTION_MODEL_IDS.indexOf(id);
            return knownIndex >= 0 ? knownIndex : CHATGPT_SUBSCRIPTION_MODEL_IDS.length;
          };
          return priority(a.id) - priority(b.id);
        });

        logger.debug(`Found ${models.length} models via pi-ai SDK`);
        return models.length > 0 ? models : this.getDefaultCodexModels();
      } catch (error) {
        logger.error("Failed to get models from pi-ai SDK:", error);
        // Return defaults on error
        return this.getDefaultCodexModels();
      }
    }

    // For API key authentication, use the standard models list API
    if (this.client) {
      try {
        const response = await this.client.models.list();
        const models = response.data
          .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3"))
          .map((m) => ({
            id: m.id,
            name: this.formatModelName(m.id),
            description: this.getModelDescription(m.id),
          }))
          .sort((a, b) => {
            const priority = (id: string) => {
              if (id === "gpt-6.1-sol") return -4;
              if (id === "gpt-6-astra") return -3;
              if (id === "gpt-6-sol") return -2;
              if (id === "gpt-6-luna") return -1;
              if (id.includes("gpt-4o")) return 0;
              if (id.includes("gpt-4")) return 1;
              if (id.includes("gpt-3.5")) return 2;
              if (id.includes("o1")) return 3;
              if (id.includes("o3")) return 4;
              return 5;
            };
            return priority(a.id) - priority(b.id);
          });
        return models.length > 0 ? models : this.getDefaultModels();
      } catch (error: Any) {
        logger.error("Failed to fetch OpenAI models:", error);
      }
    }

    // Return defaults if nothing else works
    return this.getDefaultModels();
  }

  private getDefaultModels(): Array<{ id: string; name: string; description: string }> {
    return [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        description: "Flagship model for complex reasoning and coding",
      },
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        description: "Complex coding and professional work",
      },
      { id: "gpt-6-sol", name: "GPT-6 Sol", description: "Complex coding and agentic workflows" },
      { id: "gpt-6-luna", name: "GPT-6 Luna", description: "Efficient focused tasks" },
      { id: "gpt-4o", name: "GPT-4o", description: "Most capable model for complex tasks" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast and affordable for most tasks" },
      { id: "o1", name: "o1", description: "Advanced reasoning model" },
      { id: "o1-mini", name: "o1 Mini", description: "Fast reasoning model" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "Previous generation flagship" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", description: "Fast and cost-effective" },
    ];
  }

  private getDefaultCodexModels(): Array<{ id: string; name: string; description: string }> {
    return [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        description: "GPT-6 Astra for ChatGPT subscription access",
      },
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        description: "GPT-6.1 Sol for ChatGPT subscription access",
      },
      {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        description: "GPT-6 Sol for ChatGPT subscription access",
      },
      {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        description: "GPT-6 Luna for ChatGPT subscription access",
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        description: "GPT-5.6 Sol for ChatGPT subscription access",
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        description: "GPT-5.6 Terra for ChatGPT subscription access",
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        description: "GPT-5.6 Luna for ChatGPT subscription access",
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        description: "Latest ChatGPT/Codex subscription model",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        description: "Current Codex model for ChatGPT subscription access",
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        description: "Fast GPT-5.4 model for ChatGPT subscription access",
      },
      {
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        description: "Fastest GPT-5.4 model for ChatGPT subscription access",
      },
      {
        id: "gpt-5.1-codex-max",
        name: "GPT-5.1 Codex Max",
        description: "Maximum capability for complex tasks",
      },
      { id: "gpt-5.1", name: "GPT-5.1", description: "Balanced performance and capability" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Advanced reasoning model" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Advanced reasoning model" },
      { id: "gpt-5.2", name: "GPT-5.2", description: "Most advanced reasoning" },
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        description: "Entitlement-dependent Codex Spark model",
      },
    ];
  }

  private formatModelName(modelId: string): string {
    // Format model ID to display name
    if (modelId === "gpt-4o") return "GPT-4o";
    if (modelId === "gpt-4o-mini") return "GPT-4o Mini";
    if (modelId.includes("gpt-4o-")) return `GPT-4o (${modelId.replace("gpt-4o-", "")})`;
    if (modelId === "gpt-4-turbo") return "GPT-4 Turbo";
    if (modelId.includes("gpt-4-turbo-"))
      return `GPT-4 Turbo (${modelId.replace("gpt-4-turbo-", "")})`;
    if (modelId === "gpt-4") return "GPT-4";
    if (modelId.includes("gpt-4-")) return `GPT-4 (${modelId.replace("gpt-4-", "")})`;
    if (modelId === "gpt-3.5-turbo") return "GPT-3.5 Turbo";
    if (modelId.includes("gpt-3.5-turbo-"))
      return `GPT-3.5 Turbo (${modelId.replace("gpt-3.5-turbo-", "")})`;
    if (modelId === "o1") return "o1";
    if (modelId === "o1-mini") return "o1 Mini";
    if (modelId === "o1-preview") return "o1 Preview";
    if (modelId === "o3-mini") return "o3 Mini";
    // ChatGPT internal models
    if (modelId === "gpt-6-astra") return "GPT-6 Astra";
    if (modelId === "gpt-6.1-sol") return "GPT-6.1 Sol";
    if (modelId === "gpt-6-sol") return "GPT-6 Sol";
    if (modelId === "gpt-6-luna") return "GPT-6 Luna";
    if (modelId === "gpt-5.6-sol") return "GPT-5.6 Sol";
    if (modelId === "gpt-5.6-terra") return "GPT-5.6 Terra";
    if (modelId === "gpt-5.6-luna") return "GPT-5.6 Luna";
    if (modelId === "gpt-5.5") return "GPT-5.5";
    if (modelId === "gpt-5.4") return "GPT-5.4";
    if (modelId === "gpt-5.4-mini") return "GPT-5.4 Mini";
    if (modelId === "gpt-5.4-nano") return "GPT-5.4 Nano";
    if (modelId === "gpt-5.1") return "GPT-5.1";
    if (modelId === "gpt-5.1-codex-mini") return "GPT-5.1 Codex Mini";
    if (modelId === "gpt-5.1-codex-max") return "GPT-5.1 Codex Max";
    if (modelId === "gpt-5.2") return "GPT-5.2";
    if (modelId === "gpt-5.2-codex") return "GPT-5.2 Codex";
    if (modelId === "gpt-5.3-codex") return "GPT-5.3 Codex";
    if (modelId === "gpt-5.3-codex-spark") return "GPT-5.3 Codex Spark";
    return modelId;
  }

  private getModelDescription(modelId: string): string {
    if (modelId.includes("gpt-4o") && !modelId.includes("mini"))
      return "Most capable model for complex tasks";
    if (modelId.includes("gpt-4o-mini")) return "Fast and affordable for most tasks";
    if (modelId.includes("gpt-4-turbo")) return "Previous generation flagship";
    if (modelId.includes("gpt-4")) return "High capability model";
    if (modelId.includes("gpt-3.5")) return "Fast and cost-effective";
    if (modelId === "o1" || modelId === "o1-preview") return "Advanced reasoning model";
    if (modelId === "o1-mini") return "Fast reasoning model";
    if (modelId.includes("o3")) return "Next generation reasoning";
    // ChatGPT internal models
    if (modelId === "gpt-6-astra") return "GPT-6 Astra for ChatGPT subscription access";
    if (modelId === "gpt-6.1-sol") return "Complex coding and professional work";
    if (modelId === "gpt-6-sol") return "GPT-6 Sol for ChatGPT subscription access";
    if (modelId === "gpt-6-luna") return "GPT-6 Luna for ChatGPT subscription access";
    if (modelId === "gpt-5.6-sol") return "GPT-5.6 Sol for ChatGPT subscription access";
    if (modelId === "gpt-5.6-terra") return "GPT-5.6 Terra for ChatGPT subscription access";
    if (modelId === "gpt-5.6-luna") return "GPT-5.6 Luna for ChatGPT subscription access";
    if (modelId === "gpt-5.5") return "Latest ChatGPT/Codex subscription model";
    if (modelId === "gpt-5.4") return "Current Codex model for ChatGPT subscription access";
    if (modelId === "gpt-5.4-mini") return "Fast GPT-5.4 model for ChatGPT subscription access";
    if (modelId === "gpt-5.4-nano") return "Fastest GPT-5.4 model for ChatGPT subscription access";
    if (modelId === "gpt-5.1") return "Balanced performance and capability";
    if (modelId === "gpt-5.1-codex-mini") return "Fast and efficient for most tasks";
    if (modelId === "gpt-5.1-codex-max") return "Maximum capability for complex tasks";
    if (modelId === "gpt-5.2") return "Most advanced reasoning";
    if (modelId === "gpt-5.2-codex") return "Advanced reasoning model";
    if (modelId === "gpt-5.3-codex") return "Advanced reasoning model";
    if (modelId === "gpt-5.3-codex-spark") return "Entitlement-dependent Codex Spark model";
    return "OpenAI model";
  }

  /**
   * Convert messages to pi-ai SDK format
   */
  private convertMessagesToPiAi(messages: LLMMessage[], supportsImages = true): PiAiMessage[] {
    const result: PiAiMessage[] = [];
    const now = Date.now();

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
          // Assistant message
          result.push({
            role: "assistant",
            content: [{ type: "text", text: msg.content }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: this.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
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
          // Convert tool results to pi-ai format
          for (const toolResult of toolResults) {
            const content: Any[] = [{ type: "text", text: toolResult.content }];
            for (const companion of toolResult.companion_user_content || []) {
              if (companion.type === "image") {
                content.push({
                  type: "image",
                  data: companion.data,
                  mimeType: companion.mimeType,
                });
              } else if (companion.type === "text") {
                content.push({ type: "text", text: companion.text });
              }
            }
            result.push({
              role: "toolResult",
              toolCallId: toolResult.tool_use_id,
              toolName: "", // Will be filled by the SDK
              content,
              isError: toolResult.is_error || false,
              timestamp: now,
            });
          }
        } else {
          // Handle mixed content (text, tool_use, image)
          if (msg.role === "user") {
            const textContent: Any[] = [];
            for (const item of msg.content) {
              if (item.type === "text") {
                textContent.push({ type: "text" as const, text: (item as Any).text });
              } else if (item.type === "image") {
                if (!supportsImages) {
                  textContent.push({ type: "text" as const, text: imageToTextFallback(item) });
                } else {
                  textContent.push({
                    type: "image" as const,
                    data: (item as Any).data,
                    mimeType: (item as Any).mimeType,
                  } as Any);
                }
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
                content.push({
                  type: "toolCall",
                  id: (item as Any).id,
                  name: (item as Any).name,
                  arguments: (item as Any).input,
                });
              }
            }

            const replay = msgIndex >= turnStart ? piAiReplay(msg, this.model) : null;
            if (replay) content.unshift(...replay.blocks);

            if (content.length > 0) {
              result.push({
                role: "assistant",
                content,
                api: (replay?.api as Any) || "openai-codex-responses",
                provider: (replay?.provider as Any) || "openai-codex",
                model: this.model,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
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
   * Convert tools to pi-ai SDK format
   */
  private convertToolsToPiAi(tools: LLMTool[]): PiAiTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Any,
    }));
  }

  /**
   * Convert pi-ai response to our format
   */
  private convertPiAiResponse(response: Any): LLMResponse {
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
      }
    }

    // Map stop reason
    let stopReason: LLMResponse["stopReason"] = "end_turn";
    if (response.stopReason === "toolUse") {
      stopReason = "tool_use";
    } else if (response.stopReason === "length") {
      stopReason = "max_tokens";
    }

    const reasoning = reasoningFromPiAiResponse(response);
    return {
      content,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      stopReason,
      usage: extractPiAiUsage(response.usage),
    };
  }

  /**
   * Convert messages to OpenAI format (for API key auth)
   */
  private convertMessages(
    messages: LLMMessage[],
    system?: string,
    systemBlocks?: LLMSystemBlock[],
  ): OpenAI.ChatCompletionMessageParam[] {
    return toOpenAICompatibleMessages(messages, system, {
      supportsImages: true,
      systemBlocks,
    }) as OpenAI.ChatCompletionMessageParam[];
  }

  private convertTools(tools: LLMTool[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    const content: LLMContent[] = [];

    // Add text content if present
    if (choice.message.content) {
      content.push({
        type: "text",
        text: choice.message.content,
      });
    }

    // Add tool calls if present
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        // Only handle function-type tool calls
        if (toolCall.type === "function") {
          const parsedArguments = parseOpenAICompatibleToolArguments(toolCall.function?.arguments);
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedArguments.input,
            ...(parsedArguments.inputError ? { inputError: parsedArguments.inputError } : {}),
          });
        }
      }
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            ...extractOpenAICompatibleCacheUsage(response.usage),
          }
        : undefined,
    };
  }

  private mapStopReason(
    reason: OpenAI.ChatCompletion.Choice["finish_reason"],
  ): LLMResponse["stopReason"] {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "refusal";
      default:
        return "end_turn";
    }
  }
}
