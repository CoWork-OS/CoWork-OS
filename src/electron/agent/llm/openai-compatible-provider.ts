import {
  LLMProvider,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  LLMProviderError,
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

export type AtomicChatErrorCode =
  | "cancelled"
  | "timeout"
  | "unreachable"
  | "authentication"
  | "model_unavailable"
  | "context_limit"
  | "unsupported_parameter"
  | "invalid_response"
  | "invalid_tool_call"
  | "temporarily_busy";

export type AtomicChatDiscoveryStatus =
  | "success"
  | "valid_empty"
  | "unreachable"
  | "authentication_rejected"
  | "invalid_response"
  | "cancelled"
  | "timeout";

export interface AtomicChatModelDiscoveryResult {
  status: AtomicChatDiscoveryStatus;
  models: Array<{ id: string; name: string }>;
  durationMs: number;
  error?: string;
}

export class AtomicChatProviderError extends Error implements LLMProviderError {
  readonly code: AtomicChatErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly providerMessage?: string;

  constructor(
    code: AtomicChatErrorCode,
    message: string,
    options?: { status?: number; providerMessage?: string; cause?: unknown },
  ) {
    super(message);
    // The executor treats AbortError as a terminal cancellation and will not
    // retry or fail over it. Preserve that contract while retaining the typed
    // Atomic error code for diagnostics.
    this.name = code === "cancelled" ? "AbortError" : "AtomicChatProviderError";
    this.code = code;
    this.retryable = code === "timeout" || code === "unreachable" || code === "temporarily_busy";
    this.status = options?.status;
    this.providerMessage = options?.providerMessage;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

const ATOMIC_CHAT_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const ATOMIC_CHAT_DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

interface RequestDeadline {
  signal?: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

function createRequestDeadline(
  parent: AbortSignal | undefined,
  timeoutMs?: number,
): RequestDeadline {
  const normalizedTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
  if (!normalizedTimeout) {
    return { signal: parent, didTimeout: () => false, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) {
      abortFromParent();
    } else {
      parent.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("request deadline exceeded"));
  }, normalizedTimeout);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", abortFromParent);
    },
  };
}

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
  /** Optional request deadline used by local/embedded servers. */
  requestTimeoutMs?: number;
  /** Optional /models deadline used by local/embedded servers. */
  discoveryTimeoutMs?: number;
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
  private requestTimeoutMs?: number;
  private discoveryTimeoutMs?: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.normalizedBaseUrl = normalizeBaseUrl(options.baseUrl, options.type);
    this.chatCompletionsUrl = resolveChatCompletionsUrl(options.baseUrl, options.type);
    this.modelsUrl = resolveModelsUrl(options.baseUrl, options.type);
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.extraHeaders = options.extraHeaders;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs;
  }

  private isAtomicChatProvider(): boolean {
    return this.type === "atomic-chat";
  }

  private buildAtomicError(
    code: AtomicChatErrorCode,
    message: string,
    options?: { status?: number; providerMessage?: string; cause?: unknown },
  ): AtomicChatProviderError {
    return new AtomicChatProviderError(code, message, options);
  }

  private addAuthHeaders(headers: Record<string, string>): void {
    if (!this.apiKey) return;
    headers.Authorization = `Bearer ${this.apiKey}`;
    // Atomic Chat accepts either form when proxy authentication is enabled.
    // Keep Authorization for all compatible servers and add X-Api-Key only for
    // Atomic so generic endpoints do not receive an unexpected header.
    if (this.isAtomicChatProvider()) {
      headers["X-Api-Key"] = this.apiKey;
    }
  }

  private classifyAtomicHttpError(
    status: number,
    message: string | undefined,
    cause?: unknown,
  ): AtomicChatProviderError {
    const normalized = String(message || "").toLowerCase();
    let code: AtomicChatErrorCode = "invalid_response";
    if (status === 401 || status === 403) {
      code = "authentication";
    } else if (status === 404 || /model.*(not found|unknown|unavailable)/.test(normalized)) {
      code = "model_unavailable";
    } else if (
      status === 409 ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      /busy|overload|temporar|no model available/.test(normalized)
    ) {
      code = "temporarily_busy";
    } else if (/context|token limit|maximum.*tokens|too long/.test(normalized)) {
      code = "context_limit";
    } else if (/unsupported|unknown parameter|does not support/.test(normalized)) {
      code = "unsupported_parameter";
    }

    return this.buildAtomicError(
      code,
      `${this.providerName} API error: ${status}${message ? ` - ${message}` : ""}`,
      { status, providerMessage: message, cause },
    );
  }

  private async resolveModelForRequest(model: string, signal?: AbortSignal): Promise<string> {
    const normalized = this.normalizeModelForEndpoint(model || this.defaultModel);
    if (!this.isAtomicChatProvider() || (normalized && normalized !== "auto")) {
      return normalized;
    }

    const discovery = await this.getAvailableModelsDetailed({ signal });
    const selected = discovery.models[0]?.id?.trim();
    if (selected) return selected;

    const code: AtomicChatErrorCode =
      discovery.status === "cancelled"
        ? "cancelled"
        : discovery.status === "timeout"
          ? "timeout"
          : discovery.status === "authentication_rejected"
            ? "authentication"
            : discovery.status === "unreachable"
              ? "unreachable"
              : "model_unavailable";
    throw this.buildAtomicError(
      code,
      discovery.error || "Atomic Chat did not report a loaded model.",
    );
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

  /**
   * Hook for route-specific capability evidence. The base adapter deliberately
   * does not infer support from a model name or from an ordinary response.
   */
  protected observeResponse(_model: string, _request: LLMRequest, _data: Any): void {
    // Provider subclasses may record tested observations without changing the
    // common request/response path.
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

    const deadline = createRequestDeadline(
      request.signal,
      this.isAtomicChatProvider()
        ? (this.requestTimeoutMs ?? ATOMIC_CHAT_DEFAULT_REQUEST_TIMEOUT_MS)
        : this.requestTimeoutMs,
    );

    try {
      const model = await this.resolveModelForRequest(
        request.model || this.defaultModel,
        deadline.signal,
      );
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
      this.addAuthHeaders(headers);

      const response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          [outputTokenField]: maxOutputTokens,
          ...(this.isAtomicChatProvider() ? { stream: false } : {}),
          ...(tools && tools.length > 0
            ? {
                tools,
                tool_choice: request.toolChoice || "auto",
              }
            : {}),
          ...this.getToolRequestExtras(model, tools),
          ...buildOpenAIPromptCacheFields(request.promptCache, request.model),
        }),
        ...(deadline.signal ? { signal: deadline.signal } : {}),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = this.getErrorMessage(errorData);
        if (this.isAtomicChatProvider()) {
          throw this.classifyAtomicHttpError(response.status, errorMessage);
        }
        throw new Error(
          `${this.providerName} API error: ${response.status} ${response.statusText}` +
            (errorMessage ? ` - ${errorMessage}` : ""),
        );
      }

      let data: Any;
      try {
        data = (await response.json()) as Any;
      } catch (error) {
        if (this.isAtomicChatProvider()) {
          throw this.buildAtomicError(
            "invalid_response",
            `${this.providerName} returned invalid JSON.`,
            { cause: error },
          );
        }
        throw error;
      }

      if (this.isAtomicChatProvider()) {
        const choice = data?.choices?.[0];
        if (!choice || !choice.message || typeof choice.message !== "object") {
          throw this.buildAtomicError(
            "invalid_response",
            `${this.providerName} returned no assistant message.`,
          );
        }
        const hasMessageContent =
          typeof choice.message.content === "string" ||
          (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0);
        if (!hasMessageContent) {
          throw this.buildAtomicError(
            "invalid_response",
            `${this.providerName} returned an empty assistant message.`,
          );
        }
        if (
          Array.isArray(choice.message.tool_calls) &&
          choice.message.tool_calls.some(
            (toolCall: Any) =>
              toolCall?.type !== "function" ||
              typeof toolCall?.id !== "string" ||
              typeof toolCall?.function?.name !== "string",
          )
        ) {
          throw this.buildAtomicError(
            "invalid_tool_call",
            `${this.providerName} returned an invalid tool call envelope.`,
          );
        }
        this.observeResponse(model, request, data);
      }

      return fromOpenAICompatibleResponse(data);
    } catch (error: Any) {
      if (error instanceof AtomicChatProviderError) {
        throw error;
      }

      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        console.log(`[${this.providerName}] Request aborted`);
        if (this.isAtomicChatProvider()) {
          throw this.buildAtomicError(
            deadline.didTimeout() ? "timeout" : "cancelled",
            deadline.didTimeout()
              ? `${this.providerName} request timed out.`
              : `${this.providerName} request cancelled.`,
            { cause: error },
          );
        }
        throw new Error("Request cancelled");
      }

      if (this.isAtomicChatProvider()) {
        const code = error?.cause?.code || error?.code;
        const unreachable =
          code === "ECONNREFUSED" ||
          code === "ECONNRESET" ||
          code === "ENOTFOUND" ||
          code === "EAI_AGAIN" ||
          error?.message?.toLowerCase?.().includes("fetch failed");
        if (unreachable) {
          throw this.buildAtomicError(
            "unreachable",
            `${this.providerName} network is unreachable at its configured local endpoint.`,
            { cause: error },
          );
        }
        throw this.buildAtomicError(
          "invalid_response",
          error?.message || `${this.providerName} request failed.`,
          { cause: error },
        );
      }

      console.error(`[${this.providerName}] API error:`, {
        message: error.message,
        status: error.status,
      });
      throw error;
    } finally {
      deadline.cleanup();
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const deadline = createRequestDeadline(
      undefined,
      this.isAtomicChatProvider()
        ? (this.requestTimeoutMs ?? ATOMIC_CHAT_DEFAULT_REQUEST_TIMEOUT_MS)
        : this.requestTimeoutMs,
    );
    try {
      const model = await this.resolveModelForRequest(this.defaultModel, deadline.signal);
      const outputTokenField = this.getOutputTokenField(model);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.extraHeaders,
      };
      this.addAuthHeaders(headers);

      const response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hi" }],
          [outputTokenField]: 10,
          ...(this.isAtomicChatProvider() ? { stream: false } : {}),
        }),
        ...(deadline.signal ? { signal: deadline.signal } : {}),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (this.isAtomicChatProvider()) {
          throw this.classifyAtomicHttpError(response.status, this.getErrorMessage(errorData));
        }
        return {
          success: false,
          error:
            this.getErrorMessage(errorData) || `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      if (this.isAtomicChatProvider()) {
        let data: Any;
        try {
          data = await response.json();
        } catch {
          return { success: false, error: `${this.providerName} returned invalid JSON.` };
        }
        if (!data?.choices?.[0]?.message) {
          return { success: false, error: `${this.providerName} returned no assistant message.` };
        }
      }

      return { success: true };
    } catch (error: Any) {
      if (this.isAtomicChatProvider() && error instanceof AtomicChatProviderError) {
        const messages: Partial<Record<AtomicChatErrorCode, string>> = {
          cancelled: `${this.providerName} connection was cancelled.`,
          timeout: `${this.providerName} connection timed out.`,
          unreachable: `${this.providerName} is unavailable at the configured endpoint.`,
          authentication: `${this.providerName} rejected the configured authentication.`,
          model_unavailable: `${this.providerName} did not report a usable model.`,
          temporarily_busy: `${this.providerName} is temporarily busy.`,
          context_limit: `${this.providerName} rejected the connection probe because of a context limit.`,
          unsupported_parameter: `${this.providerName} rejected a connection probe parameter.`,
        };
        return {
          success: false,
          error: messages[error.code] || error.message,
        };
      }
      return {
        success: false,
        error: error.message || `Failed to connect to ${this.providerName} API`,
      };
    } finally {
      deadline.cleanup();
    }
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.getAvailableModelsDetailed();
    return result.models;
  }

  async getAvailableModelsDetailed(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<AtomicChatModelDiscoveryResult> {
    const startedAt = Date.now();
    const deadline = createRequestDeadline(
      options?.signal,
      options?.timeoutMs ??
        (this.isAtomicChatProvider()
          ? (this.discoveryTimeoutMs ?? ATOMIC_CHAT_DEFAULT_DISCOVERY_TIMEOUT_MS)
          : this.discoveryTimeoutMs),
    );

    try {
      const headers: Record<string, string> = {};
      this.addAuthHeaders(headers);

      const response = await fetch(this.modelsUrl, {
        headers,
        ...(deadline.signal ? { signal: deadline.signal } : {}),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = this.getErrorMessage(errorData) || `HTTP ${response.status}`;
        if (this.isAtomicChatProvider()) {
          const status: AtomicChatDiscoveryStatus =
            response.status === 401 || response.status === 403
              ? "authentication_rejected"
              : response.status === 408 || response.status === 504
                ? "timeout"
                : "unreachable";
          return {
            status,
            models: [],
            durationMs: Date.now() - startedAt,
            error: errorMessage,
          };
        }
        return {
          status: "unreachable",
          models: [],
          durationMs: Date.now() - startedAt,
          error: errorMessage,
        };
      }

      let data: Any;
      try {
        data = (await response.json()) as Any;
      } catch {
        return {
          status: "invalid_response",
          models: [],
          durationMs: Date.now() - startedAt,
          error: "Model discovery returned invalid JSON.",
        };
      }

      if (!Array.isArray(data?.data)) {
        return {
          status: "invalid_response",
          models: [],
          durationMs: Date.now() - startedAt,
          error: "Model discovery response did not contain a data array.",
        };
      }

      const models = data.data
        .filter((model: Any) => typeof model?.id === "string" && model.id.trim().length > 0)
        .map((model: Any) => ({
          id: model.id.trim(),
          name: model.id.trim(),
        }));
      return {
        status: models.length > 0 ? "success" : "valid_empty",
        models,
        durationMs: Date.now() - startedAt,
        ...(models.length === 0 ? { error: "No loaded models were reported." } : {}),
      };
    } catch (error: Any) {
      if (this.isAtomicChatProvider()) {
        const status: AtomicChatDiscoveryStatus =
          error instanceof AtomicChatProviderError && error.code === "cancelled"
            ? "cancelled"
            : options?.signal?.aborted && !deadline.didTimeout()
              ? "cancelled"
              : deadline.didTimeout() || error?.name === "AbortError"
                ? "timeout"
                : "unreachable";
        return {
          status,
          models: [],
          durationMs: Date.now() - startedAt,
          error:
            error instanceof AtomicChatProviderError
              ? error.message
              : error?.message || `Failed to fetch models from ${this.providerName}.`,
        };
      }

      // ECONNREFUSED means the local server simply isn't running yet — not an error worth logging loudly
      const isOffline = error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
      if (!isOffline) console.error(`[${this.providerName}] Failed to fetch models:`, error);
      return {
        status: "unreachable",
        models: [],
        durationMs: Date.now() - startedAt,
        error: error?.message || `Failed to fetch models from ${this.providerName}.`,
      };
    } finally {
      deadline.cleanup();
    }
  }
}
