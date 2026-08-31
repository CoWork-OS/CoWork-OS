import OpenAI from "openai";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMTool,
  LLMToolResult,
  LLMToolUse,
  LLMTextContent,
  LLMImageContent,
} from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { XAIOAuth, XAIOAuthTokens, isXAIAccessTokenExpiring } from "./xai-oauth";

const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_MODEL = "grok-4.3";

const isToolResult = (item: LLMContent | LLMToolResult): item is LLMToolResult =>
  item?.type === "tool_result";
const isToolUse = (item: LLMContent | LLMToolResult): item is LLMToolUse =>
  item?.type === "tool_use";
const isTextContent = (item: LLMContent | LLMToolResult): item is LLMTextContent =>
  item?.type === "text";
const isImageContent = (item: LLMContent | LLMToolResult): item is LLMImageContent =>
  item?.type === "image";

export class XAIProvider implements LLMProvider {
  readonly type: "xai" | "xai-oauth";
  private client?: OpenAICompatibleProvider;
  private responsesClient?: OpenAI;
  private oauthTokens?: XAIOAuthTokens;
  private oauthTokenUpdater?: LLMProviderConfig["xaiOAuthTokenUpdater"];
  private model: string;
  private baseUrl: string;

  constructor(config: LLMProviderConfig) {
    this.type = config.type === "xai-oauth" ? "xai-oauth" : "xai";
    this.model = config.model || DEFAULT_XAI_MODEL;
    this.baseUrl = config.xaiBaseUrl || XAI_BASE_URL;
    this.oauthTokenUpdater = config.xaiOAuthTokenUpdater;

    if (this.type === "xai-oauth") {
      if (!config.xaiAccessToken || !config.xaiRefreshToken) {
        throw new Error("Grok OAuth is not connected. Sign in with Grok in Settings.");
      }
      this.oauthTokens = {
        access_token: config.xaiAccessToken,
        refresh_token: config.xaiRefreshToken,
        expires_at: config.xaiTokenExpiresAt,
        token_endpoint: config.xaiTokenEndpoint,
      };
      this.responsesClient = new OpenAI({
        apiKey: config.xaiAccessToken,
        baseURL: this.baseUrl,
      });
      return;
    }

    if (!config.xaiApiKey) {
      throw new Error("xAI API key is required. Configure it in Settings.");
    }

    this.client = new OpenAICompatibleProvider({
      type: "xai",
      providerName: "xAI",
      apiKey: config.xaiApiKey,
      baseUrl: this.baseUrl,
      defaultModel: this.model,
    });
  }

  createMessage(request: LLMRequest): Promise<LLMResponse> {
    if (this.type === "xai-oauth") {
      return this.createResponsesMessage(request);
    }
    return this.client!.createMessage(request);
  }

  testConnection() {
    if (this.type !== "xai-oauth") return this.client!.testConnection();
    return this.createResponsesMessage({
      system: "",
      model: this.model,
      messages: [{ role: "user", content: "Hi" }],
      maxTokens: 10,
    })
      .then(() => ({ success: true }))
      .catch((error: Error) => ({ success: false, error: error.message }));
  }

  getAvailableModels() {
    if (this.type !== "xai-oauth") return this.client!.getAvailableModels();
    return Promise.resolve([
      { id: "grok-4.3", name: "Grok 4.3" },
      { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning" },
      { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 Non-Reasoning" },
      { id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 Multi-Agent" },
    ]);
  }

  private async refreshOAuthIfNeeded(): Promise<void> {
    if (!this.oauthTokens || !this.responsesClient) return;
    if (!this.oauthTokens.refresh_token) return;
    if (!isXAIAccessTokenExpiring(this.oauthTokens.access_token, this.oauthTokens.expires_at)) {
      return;
    }
    const refreshed = await XAIOAuth.refreshTokens(this.oauthTokens);
    this.oauthTokens = refreshed;
    this.responsesClient = new OpenAI({
      apiKey: refreshed.access_token,
      baseURL: this.baseUrl,
    });
    await this.oauthTokenUpdater?.(refreshed);
  }

  private buildResponsesInput(request: LLMRequest): Any[] {
    const input: Any[] = [];
    if (request.system) {
      input.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: request.system }],
      });
    }

    for (const msg of request.messages) {
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
      if (!Array.isArray(msg.content)) continue;

      for (const item of msg.content) {
        if (isToolResult(item)) {
          input.push({
            type: "function_call_output",
            call_id: item.tool_use_id,
            output: item.content,
          });
        }
      }

      const contentParts: Any[] = msg.content.filter(isTextContent).map((block) => ({
        type: msg.role === "assistant" ? "output_text" : "input_text",
        text: block.text,
      }));
      for (const img of msg.content.filter(isImageContent)) {
        contentParts.push({
          type: "input_image",
          image_url: `data:${img.mimeType};base64,${img.data}`,
        });
      }
      if (contentParts.length > 0) {
        input.push({ type: "message", role: msg.role, content: contentParts });
      }

      if (msg.role === "assistant") {
        for (const toolUse of msg.content.filter(isToolUse)) {
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

  private toResponsesTools(tools: LLMTool[]) {
    return tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));
  }

  private convertResponsesResponse(response: Any): LLMResponse {
    const content: LLMContent[] = [];
    for (const item of response?.output || []) {
      if (item?.type === "message") {
        for (const part of item.content || []) {
          const text = part?.text || part?.content || "";
          if (text) content.push({ type: "text", text });
        }
      } else if (item?.type === "function_call") {
        let input: Record<string, Any> = {};
        try {
          input = JSON.parse(item.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: item.call_id || item.id,
          name: item.name,
          input,
        });
      } else if (item?.type === "output_text" && item.text) {
        content.push({ type: "text", text: item.text });
      }
    }

    const hasToolUse = content.some((item) => item.type === "tool_use");
    return {
      content,
      stopReason: hasToolUse
        ? "tool_use"
        : response?.status === "incomplete"
          ? "max_tokens"
          : "end_turn",
      usage: response?.usage
        ? {
            inputTokens: response.usage.input_tokens || 0,
            outputTokens: response.usage.output_tokens || 0,
            cachedTokens: response.usage.input_tokens_details?.cached_tokens,
          }
        : undefined,
    };
  }

  private async createResponsesMessage(request: LLMRequest): Promise<LLMResponse> {
    await this.refreshOAuthIfNeeded();
    const tools = request.tools ? this.toResponsesTools(request.tools) : undefined;
    const response = await (this.responsesClient as Any).responses.create(
      {
        model: request.model || this.model,
        input: this.buildResponsesInput(request),
        max_output_tokens: request.maxTokens,
        ...(tools?.length
          ? {
              tools,
              tool_choice: request.toolChoice || "auto",
            }
          : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    return this.convertResponsesResponse(response);
  }
}
