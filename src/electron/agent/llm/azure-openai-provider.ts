import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMTool,
  LLMContent,
  LLMToolResult,
  LLMToolUse,
  LLMTextContent,
  LLMImageContent,
  StreamProgressCallback,
  type AzureReasoningEffort,
} from "./types";
import {
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
  fromOpenAICompatibleResponse,
} from "./openai-compatible";

const DEFAULT_AZURE_API_VERSION = "2024-02-15-preview";
const AZURE_MAX_TOOLS = 128;
const textDecoder = new TextDecoder();

const isToolResult = (item: LLMContent | LLMToolResult): item is LLMToolResult =>
  item?.type === "tool_result";
const isToolUse = (item: LLMContent | LLMToolResult): item is LLMToolUse =>
  item?.type === "tool_use";
const isTextContent = (item: LLMContent | LLMToolResult): item is LLMTextContent =>
  item?.type === "text";
const isImageContent = (item: LLMContent | LLMToolResult): item is LLMImageContent =>
  item?.type === "image";

type AzureRequestKind = "chat_completions" | "responses" | "test_connection";
type AzureRequestReasoningEffort = "low" | "medium" | "high" | "xhigh";

export class AzureOpenAIProvider implements LLMProvider {
  readonly type = "azure" as const;
  private apiKey: string;
  private endpoint: string;
  private deployment: string;
  private apiVersion: string;
  private reasoningEffort?: AzureReasoningEffort;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.azureApiKey?.trim();
    const endpoint = config.azureEndpoint?.trim();
    const deployment = config.azureDeployment?.trim();

    if (!apiKey) {
      throw new Error("Azure OpenAI API key is required. Configure it in Settings.");
    }
    if (!endpoint) {
      throw new Error("Azure OpenAI endpoint is required. Configure it in Settings.");
    }
    if (!deployment) {
      throw new Error("Azure OpenAI deployment name is required. Configure it in Settings.");
    }

    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.deployment = deployment;
    this.apiVersion = config.azureApiVersion?.trim() || DEFAULT_AZURE_API_VERSION;
    this.reasoningEffort = config.azureReasoningEffort?.trim() as AzureReasoningEffort | undefined;
  }

  private getReasoningEffort(): AzureRequestReasoningEffort | undefined {
    switch (this.reasoningEffort) {
      case "low":
      case "medium":
      case "high":
        return this.reasoningEffort;
      case "extra_high":
        return "xhigh";
      default:
        return undefined;
    }
  }

  private logRequestReasoning(kind: AzureRequestKind, model: string): void {
    const configured = this.reasoningEffort || "default";
    const effective = this.getReasoningEffort() || "default";
    const extra =
      configured === "extra_high" ? " (sent as xhigh; will fallback to high if rejected)" : "";
    console.log(
      `[Azure OpenAI] ${kind} reasoning level for model ${model}: configured=${configured}, effective=${effective}${extra}`,
    );
  }

  private getFallbackReasoningEffort(
    effort: AzureRequestReasoningEffort | undefined,
  ): AzureRequestReasoningEffort | undefined {
    if (effort === "xhigh") {
      return "high";
    }
    return undefined;
  }

  private getChatCompletionsUrl(): string {
    const deployment = encodeURIComponent(this.deployment);
    const apiVersion = encodeURIComponent(this.apiVersion);
    return `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  private getResponsesUrl(): string {
    return `${this.endpoint}/openai/v1/responses`;
  }

  private isMaxTokensUnsupported(errorData: Any): boolean {
    const message = errorData?.error?.message || "";
    return /max_tokens/i.test(message) && /max_completion_tokens/i.test(message);
  }

  private isChatCompletionUnsupported(errorData: Any): boolean {
    const message = errorData?.error?.message || "";
    return (
      /chatcompletion/i.test(message) && /(does not work|not supported|unsupported)/i.test(message)
    );
  }

  private buildChatCompletionsBody(
    request: LLMRequest,
    useMaxCompletionTokens: boolean,
    reasoningEffortOverride?: AzureRequestReasoningEffort,
  ): Record<string, Any> {
    const messages = toOpenAICompatibleMessages(request.messages, request.system, {
      supportsImages: true,
    });
    const rawTools = request.tools ? toOpenAICompatibleTools(request.tools) : undefined;
    if (rawTools && rawTools.length > AZURE_MAX_TOOLS) {
      console.warn(
        `[Azure] Tool list truncated: ${rawTools.length} → ${AZURE_MAX_TOOLS} (Azure limit). Tools beyond index ${AZURE_MAX_TOOLS - 1} will not be available for this call.`,
      );
    }
    const tools = rawTools ? rawTools.slice(0, AZURE_MAX_TOOLS) : undefined;
    const tokenField = useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens";
    const reasoningEffort = reasoningEffortOverride || this.getReasoningEffort();

    return {
      model: request.model || this.deployment,
      messages,
      [tokenField]: request.maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(tools && tools.length > 0 && { tools, tool_choice: "auto" }),
    };
  }

  private buildResponsesInput(messages: LLMMessage[]): Any[] {
    const input: Any[] = [];

    for (const msg of messages) {
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
        });
        continue;
      }

      if (!Array.isArray(msg.content)) {
        continue;
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
          });
        }
      }
    }

    return input;
  }

  private toResponsesTools(
    tools: LLMTool[],
  ): Array<{ type: "function"; name: string; description: string; parameters: Any }> {
    return tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: this.sanitizeSchemaForResponses(tool.input_schema),
    }));
  }

  private sanitizeSchemaForResponses(schema: Any): Any {
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    const result: Any = Array.isArray(schema) ? [...schema] : { ...schema };

    if (result.properties && typeof result.properties === "object") {
      const sanitizedProperties: Record<string, Any> = {};
      for (const [key, value] of Object.entries(result.properties)) {
        sanitizedProperties[key] = this.sanitizeSchemaForResponses(value);
      }
      result.properties = sanitizedProperties;
    }

    if (result.items) {
      result.items = this.sanitizeSchemaForResponses(result.items);
    }

    if (result.type === "array" && !result.items) {
      result.items = { type: "string" };
    }

    return result;
  }

  private buildResponsesBody(
    request: LLMRequest,
    reasoningEffortOverride?: AzureRequestReasoningEffort,
  ): Record<string, Any> {
    const input = this.buildResponsesInput(request.messages);
    const rawResponsesTools = request.tools ? this.toResponsesTools(request.tools) : undefined;
    if (rawResponsesTools && rawResponsesTools.length > AZURE_MAX_TOOLS) {
      console.warn(
        `[Azure] Tool list truncated: ${rawResponsesTools.length} → ${AZURE_MAX_TOOLS} (Azure limit). Tools beyond index ${AZURE_MAX_TOOLS - 1} will not be available for this call.`,
      );
    }
    const tools = rawResponsesTools ? rawResponsesTools.slice(0, AZURE_MAX_TOOLS) : undefined;
    const reasoningEffort = reasoningEffortOverride || this.getReasoningEffort();
    return {
      model: request.model || this.deployment,
      input,
      ...(request.system ? { instructions: request.system } : {}),
      max_output_tokens: request.maxTokens,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      ...(tools && tools.length > 0 && { tools, tool_choice: "auto" }),
    };
  }

  private async sendRequest(
    url: string,
    body: Record<string, Any>,
    signal?: AbortSignal,
    kind?: AzureRequestKind,
    model?: string,
  ): Promise<Response> {
    if (kind && model) {
      this.logRequestReasoning(kind, model);
    }
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async sendRequestWithReasoningFallback(
    url: string,
    body: Record<string, Any>,
    signal?: AbortSignal,
    kind?: AzureRequestKind,
    model?: string,
    fallbackBody?: Record<string, Any>,
  ): Promise<Response> {
    const response = await this.sendRequest(url, body, signal, kind, model);
    if (response.ok || !fallbackBody) {
      return response;
    }

    const fallbackEffort = String(
      (fallbackBody as Any)?.reasoning?.effort || (fallbackBody as Any)?.reasoning_effort || "",
    );
    if (fallbackEffort) {
      console.log(
        `[Azure OpenAI] ${kind || "request"} reasoning fallback for model ${model || this.deployment}: ${fallbackEffort}`,
      );
    }
    return this.sendRequest(url, fallbackBody, signal, kind, model);
  }

  private emitStreamProgress(
    onStreamProgress: StreamProgressCallback | undefined,
    startedAt: number,
    inputTokens: number,
    outputTokens: number,
    outputChars: number,
    streaming: boolean,
    text?: string,
  ): void {
    onStreamProgress?.({
      inputTokens,
      outputTokens,
      outputChars,
      elapsedMs: Date.now() - startedAt,
      streaming,
      ...(typeof text === "string" ? { text } : {}),
    });
  }

  private async consumeSseEvents(
    response: Response,
    onEvent: (eventData: string) => void,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Azure OpenAI streaming response body is unavailable");
    }

    let buffer = "";
    let eventDataLines: string[] = [];

    const flushEvent = () => {
      if (eventDataLines.length === 0) return;
      onEvent(eventDataLines.join("\n"));
      eventDataLines = [];
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += textDecoder.decode(value, { stream: !done });
        }

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }

          if (line === "") {
            flushEvent();
          } else if (line.startsWith("data:")) {
            eventDataLines.push(line.slice(5).trimStart());
          }

          newlineIndex = buffer.indexOf("\n");
        }

        if (done) {
          if (buffer.length > 0) {
            let line = buffer;
            if (line.endsWith("\r")) {
              line = line.slice(0, -1);
            }
            if (line === "") {
              flushEvent();
            } else if (line.startsWith("data:")) {
              eventDataLines.push(line.slice(5).trimStart());
            }
          }
          flushEvent();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async fromChatCompletionsStreamResponse(
    response: Response,
    request: LLMRequest,
    startedAt: number,
  ): Promise<LLMResponse> {
    let contentText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LLMResponse["stopReason"] = "end_turn";

    await this.consumeSseEvents(response, (eventData) => {
      if (!eventData || eventData === "[DONE]") return;

      let payload: Any;
      try {
        payload = JSON.parse(eventData);
      } catch {
        return;
      }

      if (payload?.usage) {
        inputTokens = payload.usage.prompt_tokens ?? inputTokens;
        outputTokens = payload.usage.completion_tokens ?? outputTokens;
      }

      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
      const deltaText = choice?.delta?.content;
      if (typeof deltaText === "string" && deltaText.length > 0) {
        contentText += deltaText;
          this.emitStreamProgress(
            request.onStreamProgress,
            startedAt,
            inputTokens,
            outputTokens,
            contentText.length,
            true,
            contentText,
          );
      }

      switch (choice?.finish_reason) {
        case "tool_calls":
          finishReason = "tool_use";
          break;
        case "length":
          finishReason = "max_tokens";
          break;
        case "stop":
          finishReason = "end_turn";
          break;
        case "content_filter":
          finishReason = "stop_sequence";
          break;
        default:
          break;
      }
    });

    this.emitStreamProgress(
      request.onStreamProgress,
      startedAt,
      inputTokens,
      outputTokens,
      contentText.length,
      false,
      contentText,
    );

    return {
      content: [{ type: "text", text: contentText }],
      stopReason: finishReason,
      usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    };
  }

  private async fromResponsesStreamResponse(
    response: Response,
    request: LLMRequest,
    startedAt: number,
  ): Promise<LLMResponse> {
    let contentText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LLMResponse["stopReason"] = "end_turn";

    await this.consumeSseEvents(response, (eventData) => {
      if (!eventData || eventData === "[DONE]") return;

      let payload: Any;
      try {
        payload = JSON.parse(eventData);
      } catch {
        return;
      }

      if (payload?.usage) {
        inputTokens = payload.usage.input_tokens ?? inputTokens;
        outputTokens = payload.usage.output_tokens ?? outputTokens;
      }

      switch (payload?.type) {
        case "response.output_text.delta":
          if (typeof payload.delta === "string" && payload.delta.length > 0) {
            contentText += payload.delta;
            this.emitStreamProgress(
              request.onStreamProgress,
              startedAt,
              inputTokens,
              outputTokens,
              contentText.length,
              true,
              contentText,
            );
          }
          break;
        case "response.output_text.done":
          if (typeof payload.text === "string" && payload.text.length > contentText.length) {
            contentText = payload.text;
          }
          break;
        case "response.completed":
          if (payload.response?.usage) {
            inputTokens = payload.response.usage.input_tokens ?? inputTokens;
            outputTokens = payload.response.usage.output_tokens ?? outputTokens;
          }
          if (typeof payload.response?.output_text === "string" && payload.response.output_text) {
            contentText = payload.response.output_text;
          }
          if (Array.isArray(payload.response?.output)) {
            for (const item of payload.response.output) {
              if (item?.type === "function_call") {
                finishReason = "tool_use";
              }
            }
          }
          break;
        default:
          break;
      }
    });

    this.emitStreamProgress(
      request.onStreamProgress,
      startedAt,
      inputTokens,
      outputTokens,
      contentText.length,
      false,
      contentText,
    );

    return {
      content: [{ type: "text", text: contentText }],
      stopReason: finishReason,
      usage: inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined,
    };
  }

  private parseFunctionCallArguments(value: Any): Record<string, Any> {
    if (!value) return {};
    if (typeof value === "object") return value;
    if (typeof value !== "string") return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  private fromResponsesApiResponse(response: Any): LLMResponse {
    const content: LLMContent[] = [];
    let sawToolCall = false;

    if (Array.isArray(response?.output)) {
      response.output.forEach((item: Any, index: number) => {
        if (item.type === "message") {
          const blocks = Array.isArray(item.content) ? item.content : [];
          for (const block of blocks) {
            if (block.type === "output_text" && typeof block.text === "string") {
              content.push({ type: "text", text: block.text });
            }
          }
        } else if (item.type === "function_call") {
          sawToolCall = true;
          const id = item.call_id || item.id || `call_${index}`;
          content.push({
            type: "tool_use",
            id,
            name: item.name,
            input: this.parseFunctionCallArguments(item.arguments),
          });
        }
      });
    }

    if (content.length === 0 && typeof response?.output_text === "string") {
      content.push({ type: "text", text: response.output_text });
    }

    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return {
      content,
      stopReason: sawToolCall ? "tool_use" : "end_turn",
      usage: response?.usage
        ? {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
          }
        : undefined,
    };
  }

  private isTransientInterruptionMessage(message: string): boolean {
    const normalized = String(message || "").toLowerCase();
    if (!normalized) return false;
    return (
      // "terminated" alone is too broad (e.g. "policy terminated", "process terminated").
      // Match only connection-specific termination phrases.
      normalized.includes("connection terminated") ||
      normalized.includes("stream terminated") ||
      normalized.includes("stream disconnected") ||
      normalized.includes("connection reset") ||
      normalized.includes("unexpected eof") ||
      normalized.includes("socket hang up") ||
      normalized.includes("fetch failed")
    );
  }

  private toStructuredProviderError(error: Any): Error {
    const message = String(error?.message || "Azure OpenAI request failed");
    const wrapped = new Error(message) as Any;
    wrapped.name = error?.name || "AzureOpenAIProviderError";
    wrapped.code = String(error?.code || error?.cause?.code || "").trim() || undefined;
    const status =
      typeof error?.status === "number"
        ? error.status
        : typeof error?.cause?.status === "number"
          ? error.cause.status
          : undefined;
    wrapped.retryable =
      (typeof status === "number" && status >= 500) ||
      this.isTransientInterruptionMessage(message) ||
      wrapped.code === "ECONNRESET" ||
      wrapped.code === "ETIMEDOUT" ||
      wrapped.code === "ENOTFOUND" ||
      wrapped.code === "EAI_AGAIN" ||
      wrapped.code === "ECONNREFUSED";
    if (status !== undefined) {
      wrapped.status = status;
    }
    wrapped.cause = error;
    return wrapped;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    try {
      const chatUrl = this.getChatCompletionsUrl();
      const responsesUrl = this.getResponsesUrl();
      const model = request.model || this.deployment;
      const startedAt = Date.now();
      const shouldStream = request.onStreamProgress !== undefined;
      const requestedReasoningEffort = this.getReasoningEffort();
      const fallbackReasoningEffort = this.getFallbackReasoningEffort(requestedReasoningEffort);

      const runResponses = async (
        streaming: boolean,
        reasoningEffortOverride?: AzureRequestReasoningEffort,
      ): Promise<LLMResponse> => {
        const body = this.buildResponsesBody(request, reasoningEffortOverride);
        const fallbackBody =
          fallbackReasoningEffort && reasoningEffortOverride === requestedReasoningEffort
            ? this.buildResponsesBody(request, fallbackReasoningEffort)
            : undefined;
        if (streaming) {
          body.stream = true;
          if (fallbackBody) {
            fallbackBody.stream = true;
          }
        }

        const response = await this.sendRequestWithReasoningFallback(
          responsesUrl,
          body,
          request.signal,
          "responses",
          model,
          fallbackBody,
        );
        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          const error = new Error(
            `Azure OpenAI API error: ${response.status} ${response.statusText}` +
              (errorData.error?.message ? ` - ${errorData.error.message}` : ""),
          );
          (error as Any).status = response.status;
          throw error;
        }

        if (streaming) {
          return await this.fromResponsesStreamResponse(response, request, startedAt);
        }

        const data = (await response.json()) as Any;
        return this.fromResponsesApiResponse(data);
      };

      const runChatCompletions = async (
        useMaxCompletionTokens: boolean,
        reasoningEffortOverride?: AzureRequestReasoningEffort,
      ): Promise<LLMResponse> => {
        const body = this.buildChatCompletionsBody(
          request,
          useMaxCompletionTokens,
          reasoningEffortOverride,
        );
        const fallbackBody =
          fallbackReasoningEffort && reasoningEffortOverride === requestedReasoningEffort
            ? this.buildChatCompletionsBody(request, useMaxCompletionTokens, fallbackReasoningEffort)
            : undefined;
        if (shouldStream) {
          body.stream = true;
          if (fallbackBody) {
            fallbackBody.stream = true;
          }
        }

        const response = await this.sendRequestWithReasoningFallback(
          chatUrl,
          body,
          request.signal,
          "chat_completions",
          model,
          fallbackBody,
        );
        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          return {
            content: [],
            stopReason: "end_turn",
            usage: undefined,
            errorData,
            response,
          } as Any;
        }

        if (shouldStream) {
          return await this.fromChatCompletionsStreamResponse(response, request, startedAt);
        }

        const data = (await response.json()) as Any;
        return fromOpenAICompatibleResponse(data);
      };

      const firstChatResult = await runChatCompletions(false, requestedReasoningEffort);
      if ((firstChatResult as Any).errorData) {
        let errorData = (firstChatResult as Any).errorData as { error?: { message?: string } };
        const response = (firstChatResult as Any).response as Response;

        if (this.isChatCompletionUnsupported(errorData)) {
          return await runResponses(shouldStream, requestedReasoningEffort);
        }

        if (this.isMaxTokensUnsupported(errorData)) {
          const retryResult = await runChatCompletions(true, requestedReasoningEffort);
          if (!(retryResult as Any).errorData) {
            return retryResult;
          }

          errorData = (retryResult as Any).errorData as { error?: { message?: string } };
          if (this.isChatCompletionUnsupported(errorData)) {
            return await runResponses(shouldStream, requestedReasoningEffort);
          }

          const error = new Error(
            `Azure OpenAI API error: ${response.status} ${response.statusText}` +
              (errorData.error?.message ? ` - ${errorData.error.message}` : ""),
          );
          (error as Any).status = response.status;
          throw error;
        }

        const error = new Error(
          `Azure OpenAI API error: ${response.status} ${response.statusText}` +
            (errorData.error?.message ? ` - ${errorData.error.message}` : ""),
        );
        (error as Any).status = response.status;
        throw error;
      }

      return firstChatResult;
    } catch (error: Any) {
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        console.log("[Azure OpenAI] Request aborted");
        throw new Error("Request cancelled");
      }

      console.error("[Azure OpenAI] API error:", {
        message: error.message,
        code: error?.code || error?.cause?.code,
      });
      throw this.toStructuredProviderError(error);
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const testMaxTokens = 16;
    try {
      const chatUrl = this.getChatCompletionsUrl();
      const responsesUrl = this.getResponsesUrl();
      const model = this.deployment;
      const requestedReasoningEffort = this.getReasoningEffort();
      const fallbackReasoningEffort = this.getFallbackReasoningEffort(requestedReasoningEffort);

      const runResponses = async (): Promise<{ success: boolean; error?: string }> => {
        const body: Record<string, Any> = {
          model: this.deployment,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Hi" }],
            },
          ],
          max_output_tokens: testMaxTokens,
          ...(requestedReasoningEffort ? { reasoning: { effort: requestedReasoningEffort } } : {}),
        };
        const fallbackBody =
          fallbackReasoningEffort
            ? {
                ...body,
                reasoning: { effort: fallbackReasoningEffort },
              }
            : undefined;
        const response = await this.sendRequestWithReasoningFallback(
          responsesUrl,
          body,
          undefined,
          "test_connection",
          model,
          fallbackBody,
        );
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
      };

      const chatBody: Record<string, Any> = {
        model: this.deployment,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: testMaxTokens,
        ...(requestedReasoningEffort ? { reasoning_effort: requestedReasoningEffort } : {}),
      };
      const chatFallbackBody =
        fallbackReasoningEffort
          ? {
              ...chatBody,
              reasoning_effort: fallbackReasoningEffort,
            }
          : undefined;

      let response = await this.sendRequestWithReasoningFallback(
        chatUrl,
        chatBody,
        undefined,
        "test_connection",
        model,
        chatFallbackBody,
      );

      if (!response.ok) {
        let errorData = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        if (this.isChatCompletionUnsupported(errorData)) {
          return await runResponses();
        }
        if (this.isMaxTokensUnsupported(errorData)) {
          response = await this.sendRequestWithReasoningFallback(
            chatUrl,
            {
              model: this.deployment,
              messages: [{ role: "user", content: "Hi" }],
              max_completion_tokens: testMaxTokens,
              ...(requestedReasoningEffort ? { reasoning_effort: requestedReasoningEffort } : {}),
            },
            undefined,
            "test_connection",
            model,
            fallbackReasoningEffort
              ? {
                  model: this.deployment,
                  messages: [{ role: "user", content: "Hi" }],
                  max_completion_tokens: testMaxTokens,
                  reasoning_effort: fallbackReasoningEffort,
                }
              : undefined,
          );
          if (response.ok) {
            return { success: true };
          }
          errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
          if (this.isChatCompletionUnsupported(errorData)) {
            return await runResponses();
          }
        }
        return {
          success: false,
          error: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      return { success: true };
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to Azure OpenAI",
      };
    }
  }
}
