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
} from './types';
import {
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
  fromOpenAICompatibleResponse,
} from './openai-compatible';

const DEFAULT_AZURE_API_VERSION = '2024-02-15-preview';

const isToolResult = (item: LLMContent | LLMToolResult): item is LLMToolResult =>
  item?.type === 'tool_result';
const isToolUse = (item: LLMContent | LLMToolResult): item is LLMToolUse =>
  item?.type === 'tool_use';
const isTextContent = (item: LLMContent | LLMToolResult): item is LLMTextContent =>
  item?.type === 'text';
const isImageContent = (item: LLMContent | LLMToolResult): item is LLMImageContent =>
  item?.type === 'image';

export class AzureOpenAIProvider implements LLMProvider {
  readonly type = 'azure' as const;
  private apiKey: string;
  private endpoint: string;
  private deployment: string;
  private apiVersion: string;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.azureApiKey?.trim();
    const endpoint = config.azureEndpoint?.trim();
    const deployment = config.azureDeployment?.trim();

    if (!apiKey) {
      throw new Error('Azure OpenAI API key is required. Configure it in Settings.');
    }
    if (!endpoint) {
      throw new Error('Azure OpenAI endpoint is required. Configure it in Settings.');
    }
    if (!deployment) {
      throw new Error('Azure OpenAI deployment name is required. Configure it in Settings.');
    }

    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.deployment = deployment;
    this.apiVersion = config.azureApiVersion?.trim() || DEFAULT_AZURE_API_VERSION;
  }

  private getChatCompletionsUrl(): string {
    const deployment = encodeURIComponent(this.deployment);
    const apiVersion = encodeURIComponent(this.apiVersion);
    return `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  private getResponsesUrl(): string {
    return `${this.endpoint}/openai/v1/responses`;
  }

  private isMaxTokensUnsupported(errorData: any): boolean {
    const message = errorData?.error?.message || '';
    return /max_tokens/i.test(message) && /max_completion_tokens/i.test(message);
  }

  private isChatCompletionUnsupported(errorData: any): boolean {
    const message = errorData?.error?.message || '';
    return /chatcompletion/i.test(message) && /(does not work|not supported|unsupported)/i.test(message);
  }

  private buildChatCompletionsBody(request: LLMRequest, useMaxCompletionTokens: boolean): Record<string, any> {
    const messages = toOpenAICompatibleMessages(request.messages, request.system, { supportsImages: true });
    const tools = request.tools ? toOpenAICompatibleTools(request.tools) : undefined;
    const tokenField = useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';

    return {
      model: request.model || this.deployment,
      messages,
      [tokenField]: request.maxTokens,
      ...(tools && tools.length > 0 && { tools, tool_choice: 'auto' }),
    };
  }

  private buildResponsesInput(messages: LLMMessage[]): any[] {
    const input: any[] = [];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        input.push({
          type: 'message',
          role: msg.role,
          content: [
            {
              type: msg.role === 'assistant' ? 'output_text' : 'input_text',
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
            type: 'function_call_output',
            call_id: item.tool_use_id,
            output: typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''),
          });
        }
      }

      const textBlocks = msg.content.filter(isTextContent);
      const imageBlocks = msg.content.filter(isImageContent);
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const contentParts: any[] = textBlocks.map((block) => ({
          type: msg.role === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        }));
        for (const img of imageBlocks) {
          contentParts.push({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.data}`,
          });
        }
        input.push({
          type: 'message',
          role: msg.role,
          content: contentParts,
        });
      }

      if (msg.role === 'assistant') {
        const toolUses = msg.content.filter(isToolUse);
        for (const toolUse of toolUses) {
          input.push({
            type: 'function_call',
            call_id: toolUse.id,
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input ?? {}),
          });
        }
      }
    }

    return input;
  }

  private toResponsesTools(tools: LLMTool[]): Array<{ type: 'function'; name: string; description: string; parameters: any }> {
    return tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: this.sanitizeSchemaForResponses(tool.input_schema),
    }));
  }

  private sanitizeSchemaForResponses(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const result: any = Array.isArray(schema) ? [...schema] : { ...schema };

    if (result.properties && typeof result.properties === 'object') {
      const sanitizedProperties: Record<string, any> = {};
      for (const [key, value] of Object.entries(result.properties)) {
        sanitizedProperties[key] = this.sanitizeSchemaForResponses(value);
      }
      result.properties = sanitizedProperties;
    }

    if (result.items) {
      result.items = this.sanitizeSchemaForResponses(result.items);
    }

    if (result.type === 'array' && !result.items) {
      result.items = { type: 'string' };
    }

    return result;
  }

  private buildResponsesBody(request: LLMRequest): Record<string, any> {
    const input = this.buildResponsesInput(request.messages);
    const tools = request.tools ? this.toResponsesTools(request.tools) : undefined;
    return {
      model: request.model || this.deployment,
      input,
      ...(request.system ? { instructions: request.system } : {}),
      max_output_tokens: request.maxTokens,
      ...(tools && tools.length > 0 && { tools, tool_choice: 'auto' }),
    };
  }

  private async sendRequest(url: string, body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private parseFunctionCallArguments(value: any): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return {};
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  private fromResponsesApiResponse(response: any): LLMResponse {
    const content: LLMContent[] = [];
    let sawToolCall = false;

    if (Array.isArray(response?.output)) {
      response.output.forEach((item: any, index: number) => {
        if (item.type === 'message') {
          const blocks = Array.isArray(item.content) ? item.content : [];
          for (const block of blocks) {
            if (block.type === 'output_text' && typeof block.text === 'string') {
              content.push({ type: 'text', text: block.text });
            }
          }
        } else if (item.type === 'function_call') {
          sawToolCall = true;
          const id = item.call_id || item.id || `call_${index}`;
          content.push({
            type: 'tool_use',
            id,
            name: item.name,
            input: this.parseFunctionCallArguments(item.arguments),
          });
        }
      });
    }

    if (content.length === 0 && typeof response?.output_text === 'string') {
      content.push({ type: 'text', text: response.output_text });
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stopReason: sawToolCall ? 'tool_use' : 'end_turn',
      usage: response?.usage
        ? {
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens: response.usage.output_tokens ?? 0,
          }
        : undefined,
    };
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    try {
      const chatUrl = this.getChatCompletionsUrl();
      const responsesUrl = this.getResponsesUrl();

      const runResponses = async (): Promise<LLMResponse> => {
        const response = await this.sendRequest(responsesUrl, this.buildResponsesBody(request), request.signal);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(
            `Azure OpenAI API error: ${response.status} ${response.statusText}` +
            (errorData.error?.message ? ` - ${errorData.error.message}` : '')
          );
        }
        const data = await response.json() as any;
        return this.fromResponsesApiResponse(data);
      };

      let response = await this.sendRequest(chatUrl, this.buildChatCompletionsBody(request, false), request.signal);
      if (!response.ok) {
        let errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        if (this.isChatCompletionUnsupported(errorData)) {
          return await runResponses();
        }
        if (this.isMaxTokensUnsupported(errorData)) {
          response = await this.sendRequest(chatUrl, this.buildChatCompletionsBody(request, true), request.signal);
          if (response.ok) {
            const data = await response.json() as any;
            return fromOpenAICompatibleResponse(data);
          }
          errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
          if (this.isChatCompletionUnsupported(errorData)) {
            return await runResponses();
          }
        }
        throw new Error(
          `Azure OpenAI API error: ${response.status} ${response.statusText}` +
          (errorData.error?.message ? ` - ${errorData.error.message}` : '')
        );
      }

      const data = await response.json() as any;
      return fromOpenAICompatibleResponse(data);
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        console.log('[Azure OpenAI] Request aborted');
        throw new Error('Request cancelled');
      }

      console.error('[Azure OpenAI] API error:', {
        message: error.message,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const testMaxTokens = 16;
    try {
      const chatUrl = this.getChatCompletionsUrl();
      const responsesUrl = this.getResponsesUrl();

      const runResponses = async (): Promise<{ success: boolean; error?: string }> => {
        const response = await this.sendRequest(responsesUrl, {
          model: this.deployment,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Hi' }],
            },
          ],
          max_output_tokens: testMaxTokens,
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
          return {
            success: false,
            error: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`,
          };
        }
        return { success: true };
      };

      let response = await this.sendRequest(chatUrl, {
        model: this.deployment,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: testMaxTokens,
      });

      if (!response.ok) {
        let errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        if (this.isChatCompletionUnsupported(errorData)) {
          return await runResponses();
        }
        if (this.isMaxTokensUnsupported(errorData)) {
          response = await this.sendRequest(chatUrl, {
            model: this.deployment,
            messages: [{ role: 'user', content: 'Hi' }],
            max_completion_tokens: testMaxTokens,
          });
          if (response.ok) {
            return { success: true };
          }
          errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
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
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Azure OpenAI',
      };
    }
  }
}
