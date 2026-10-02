import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  LLMToolUse,
} from "./types";
import { parseOpenAICompatibleToolArguments } from "./openai-compatible";

function supportsOllamaThinkingControl(model: string): boolean {
  const normalized = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, "");
  return /^(?:qwen3|deepseek-r1|gpt-oss|magistral)(?:[.:-]|$)/.test(normalized);
}

/**
 * Context window requested from Ollama unless COWORK_OLLAMA_NUM_CTX overrides
 * it. Without num_ctx Ollama runs every model with its server default (4K on
 * smaller GPUs), silently truncating the system prompt and tool schemas.
 */
export const DEFAULT_OLLAMA_NUM_CTX = 32_768;
const MIN_OLLAMA_NUM_CTX = 2_048;
// Changing num_ctx or letting the model unload between agent turns forces a
// reload, so keep both stable for the life of a task.
const OLLAMA_KEEP_ALIVE = "30m";
const OLLAMA_SHOW_TIMEOUT_MS = 5_000;

/** Effective windows resolved per model; read by the executor's context budget. */
const effectiveOllamaContextWindows = new Map<string, number>();

function resolveOllamaNumCtxCap(): number {
  const configured = Number(process.env.COWORK_OLLAMA_NUM_CTX);
  return Number.isFinite(configured) && configured >= MIN_OLLAMA_NUM_CTX
    ? Math.floor(configured)
    : DEFAULT_OLLAMA_NUM_CTX;
}

/**
 * The context window CoWork runs an Ollama model with: the model's own limit
 * (or an explicit Modelfile num_ctx) bounded by the configured cap. Before the
 * model has been inspected this is the cap itself.
 */
export function getOllamaEffectiveContextWindow(modelId: string): number {
  return (
    effectiveOllamaContextWindows.get(String(modelId || "").trim()) ?? resolveOllamaNumCtxCap()
  );
}

function readPositiveInteger(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : null;
}

function readModelContextLength(modelInfo: unknown): number | null {
  if (!modelInfo || typeof modelInfo !== "object") return null;
  const info = modelInfo as Record<string, unknown>;
  const architecture =
    typeof info["general.architecture"] === "string" ? info["general.architecture"] : "";
  const direct = architecture ? readPositiveInteger(info[`${architecture}.context_length`]) : null;
  if (direct) return direct;
  const key = Object.keys(info).find((name) => name.endsWith(".context_length"));
  return key ? readPositiveInteger(info[key]) : null;
}

function readModelfileNumCtx(parameters: unknown): number | null {
  if (typeof parameters !== "string") return null;
  const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/);
  return match ? readPositiveInteger(match[1]) : null;
}

/** Settle with `promise`, or reject with an AbortError as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new DOMException("The operation was aborted", "AbortError");
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isUnsupportedThinkingResponse(status: number, message: string): boolean {
  return (
    status === 400 &&
    /(?:does not|doesn't) support thinking|unsupported[^\n]*think|unknown (?:field|parameter)[^\n]*think/i.test(
      message,
    )
  );
}

/**
 * Ollama API provider implementation
 * Supports local and remote Ollama servers
 * https://ollama.ai/
 */
export class OllamaProvider implements LLMProvider {
  readonly type = "ollama" as const;
  private baseUrl: string;
  private apiKey?: string;
  private readonly contextWindowByModel = new Map<string, Promise<number>>();

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.ollamaBaseUrl || "http://localhost:11434";
    this.apiKey = config.ollamaApiKey;

    // Remove trailing slash if present
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages, request.system);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // Use AbortController for timeout (5 minutes for large models)
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 5 * 60 * 1000);

    // Track if abort came from external signal (cancellation) vs timeout
    let abortedByExternalSignal = false;

    // If external signal provided, abort our controller when it fires
    if (request.signal) {
      request.signal.addEventListener("abort", () => {
        abortedByExternalSignal = true;
        timeoutController.abort();
      });
      // Check if already aborted
      if (request.signal.aborted) {
        abortedByExternalSignal = true;
        timeoutController.abort();
      }
    }

    try {
      console.log(`[Ollama] Sending request to model: ${request.model}`);
      const startTime = Date.now();

      const chatUrl = `${this.baseUrl}/api/chat`;
      const numCtx = await untilAborted(
        this.resolveNumCtx(request.model, headers),
        timeoutController.signal,
      );
      const requestBody: Record<string, unknown> = {
        model: request.model,
        messages,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_predict: request.maxTokens,
          num_ctx: numCtx,
        },
        ...(tools && tools.length > 0 && { tools }),
      };
      if (supportsOllamaThinkingControl(request.model)) {
        // Ollama enables reasoning by default for supported models. Disable it
        // so private reasoning cannot consume the final-answer token budget.
        requestBody.think = false;
      }

      let response = await fetch(chatUrl, {
        method: "POST",
        headers,
        signal: timeoutController.signal,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const error = await response.text();
        if (requestBody.think === false && isUnsupportedThinkingResponse(response.status, error)) {
          const { think: _think, ...retryBody } = requestBody;
          response = await fetch(chatUrl, {
            method: "POST",
            headers,
            signal: timeoutController.signal,
            body: JSON.stringify(retryBody),
          });
        } else {
          throw new Error(`Ollama API error: ${response.status} - ${error}`);
        }
      }

      clearTimeout(timeoutId);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Ollama] Response received in ${elapsed}s`);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      return this.convertResponse(data);
    } catch (error: Any) {
      clearTimeout(timeoutId);
      console.error(`[Ollama] API error:`, {
        name: error.name,
        message: error.message,
        code: error.code,
      });
      if (error.name === "AbortError") {
        if (abortedByExternalSignal) {
          console.log(`[Ollama] Request aborted by caller signal`);
          throw new Error("Request cancelled");
        }
        throw new Error(
          "Ollama request timed out after 5 minutes. The model may be too slow or not responding.",
        );
      }
      throw error;
    }
  }

  /** Resolve (once per model) the num_ctx to run the model with. */
  private resolveNumCtx(model: string, headers: Record<string, string>): Promise<number> {
    const key = String(model || "").trim();
    let pending = this.contextWindowByModel.get(key);
    if (!pending) {
      pending = this.lookupContextWindow(key, headers);
      this.contextWindowByModel.set(key, pending);
    }
    return pending;
  }

  private async lookupContextWindow(
    model: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const cap = resolveOllamaNumCtxCap();
    let effective = cap;
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(OLLAMA_SHOW_TIMEOUT_MS),
      });
      if (response.ok) {
        const data = (await response.json()) as { model_info?: unknown; parameters?: unknown };
        const modelMax = readModelContextLength(data?.model_info);
        // An explicit Modelfile num_ctx is the operator's choice; otherwise cap
        // long-context models so memory use stays predictable.
        const configured = readModelfileNumCtx(data?.parameters) ?? cap;
        effective = modelMax ? Math.min(configured, modelMax) : configured;
      }
    } catch (error: Any) {
      console.warn(
        `[Ollama] Could not read the context length of ${model}; using num_ctx ${cap}:`,
        error?.message || error,
      );
    }
    effectiveOllamaContextWindows.set(model, effective);
    return effective;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      // First check if Ollama is running
      const response = await fetch(`${this.baseUrl}/api/tags`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to connect to Ollama: ${response.status}`);
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      if (!data.models || data.models.length === 0) {
        return {
          success: false,
          error: 'No models available. Run "ollama pull <model>" to download a model.',
        };
      }

      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Ollama server",
      };
    }
  }

  /**
   * Fetch available models from Ollama server
   */
  async getAvailableModels(): Promise<Array<{ name: string; size: number; modified: string }>> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/api/tags`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string; size: number; modified_at: string }>;
      };

      return (data.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
      }));
    } catch (error: Any) {
      const message = error?.message || String(error);
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(this.baseUrl);
      const isUnavailable =
        /(fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)/i.test(message);

      if (isLocalhost && isUnavailable) {
        console.info(
          `[OllamaProvider] Ollama is not reachable at ${this.baseUrl}; returning no models`,
        );
      } else {
        console.warn(`[OllamaProvider] Failed to fetch Ollama models: ${message}`);
      }
      return [];
    }
  }

  private convertMessages(messages: LLMMessage[], systemPrompt: string): OllamaMessage[] {
    const ollamaMessages: OllamaMessage[] = [];

    // Add system message first
    if (systemPrompt) {
      ollamaMessages.push({
        role: "system",
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        ollamaMessages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      } else {
        // Handle array content (tool results, mixed content, images)
        const textParts: string[] = [];
        const toolCalls: OllamaToolCall[] = [];
        const images: string[] = [];

        for (const item of msg.content) {
          if (item.type === "text") {
            textParts.push(item.text);
          } else if (item.type === "tool_use") {
            toolCalls.push({
              function: {
                name: item.name,
                arguments: item.input,
              },
            });
          } else if (item.type === "tool_result") {
            // Tool results in Ollama format
            ollamaMessages.push({
              role: "tool",
              content: item.content,
            });
          } else if (item.type === "image") {
            // Ollama expects raw base64 in a top-level images array
            images.push(item.data);
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0 || images.length > 0) {
          ollamaMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: textParts.join("\n") || "",
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            ...(images.length > 0 && { images }),
          });
        }
      }
    }

    return ollamaMessages;
  }

  private convertTools(tools: LLMTool[]): OllamaTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertResponse(response: OllamaChatResponse): LLMResponse {
    const content: LLMContent[] = [];
    const message = response.message;

    // Handle missing message
    if (!message) {
      console.error("Ollama response missing message:", response);
      return {
        content: [{ type: "text", text: "Error: Ollama returned an empty response" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    // Handle text content
    if (message.content) {
      content.push({
        type: "text",
        text: message.content,
      });
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const parsedArguments = parseOpenAICompatibleToolArguments(toolCall.function.arguments);
        if (parsedArguments.inputError) {
          console.error("Ollama tool arguments rejected:", parsedArguments.inputError.message);
        }
        content.push({
          type: "tool_use",
          id: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name: toolCall.function.name,
          input: parsedArguments.input,
          ...(parsedArguments.inputError ? { inputError: parsedArguments.inputError } : {}),
        } as LLMToolUse);
      }
    }

    const hasToolCalls = Boolean(message.tool_calls && message.tool_calls.length > 0);
    const hasFinalContent = Boolean(message.content?.trim());
    const hasThinkingOnly = !hasFinalContent && !hasToolCalls && Boolean(message.thinking?.trim());

    if (hasThinkingOnly) {
      console.warn(
        "[Ollama] Response contained reasoning without a final answer; treating it as token exhaustion",
        {
          thinkingChars: message.thinking?.length || 0,
          doneReason: response.done_reason,
        },
      );
    }

    // Determine stop reason
    let stopReason: LLMResponse["stopReason"] = "end_turn";
    if (hasToolCalls) {
      stopReason = "tool_use";
    } else if (response.done_reason === "length" || hasThinkingOnly) {
      stopReason = "max_tokens";
    } else if (response.done_reason === "stop") {
      // Ollama uses "stop" for a normal completed response. Mapping it to
      // stop_sequence prevents the executor from accepting usable text as the
      // end of a step and can cause repeated empty follow-up calls.
      stopReason = "end_turn";
    }

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.prompt_eval_count || 0,
        outputTokens: response.eval_count || 0,
      },
    };
  }
}

// Ollama API types
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  images?: string[]; // Base64-encoded image data for vision models
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, Any> | string;
  };
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, Any>;
      required?: string[];
    };
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}
