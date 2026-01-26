import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
} from './types';

/**
 * OpenRouter API provider implementation
 * OpenRouter provides access to multiple LLM providers through a unified API
 */
export class OpenRouterProvider implements LLMProvider {
  readonly type = 'openrouter' as const;
  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';
  private defaultModel: string;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.openrouterApiKey;
    if (!apiKey) {
      throw new Error('OpenRouter API key is required. Configure it in Settings or get one from https://openrouter.ai/keys');
    }

    this.apiKey = apiKey;
    this.defaultModel = config.model || 'anthropic/claude-3.5-sonnet';
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages, request.system);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      console.log(`[OpenRouter] Calling API with model: ${request.model || this.defaultModel}`);

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/mesutfelat/cowork-oss',
          'X-Title': 'CoWork-OSS',
        },
        body: JSON.stringify({
          model: request.model || this.defaultModel,
          messages,
          max_tokens: request.maxTokens,
          ...(tools && { tools, tool_choice: 'auto' }),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(
          `OpenRouter API error: ${response.status} ${response.statusText}` +
          (errorData.error?.message ? ` - ${errorData.error.message}` : '')
        );
      }

      const data = await response.json() as any;
      return this.convertResponse(data);
    } catch (error: any) {
      console.error(`[OpenRouter] API error:`, {
        message: error.message,
        status: error.status,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/mesutfelat/cowork-oss',
          'X-Title': 'CoWork-OSS',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        return {
          success: false,
          error: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to OpenRouter API',
      };
    }
  }

  private convertMessages(
    messages: LLMMessage[],
    system?: string
  ): Array<{ role: string; content: any; tool_call_id?: string }> {
    const result: Array<{ role: string; content: any; tool_call_id?: string }> = [];

    // Add system message if provided
    if (system) {
      result.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else {
        // Handle array content (tool results or mixed content)
        for (const item of msg.content) {
          if (item.type === 'tool_result') {
            result.push({
              role: 'tool',
              content: item.content,
              tool_call_id: item.tool_use_id,
            });
          } else if (item.type === 'tool_use') {
            // Tool use from assistant - add as assistant message with tool_calls
            result.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: item.id,
                type: 'function',
                function: {
                  name: item.name,
                  arguments: JSON.stringify(item.input),
                },
              }],
            } as any);
          } else if (item.type === 'text') {
            result.push({ role: msg.role, content: item.text });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: LLMTool[]): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: any;
    };
  }> {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertResponse(response: any): LLMResponse {
    const content: LLMContent[] = [];
    const choice = response.choices?.[0];

    if (!choice) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
      };
    }

    const message = choice.message;

    // Handle text content
    if (message.content) {
      content.push({
        type: 'text',
        text: message.content,
      });
    }

    // Handle tool calls
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || '{}'),
          });
        }
      }
    }

    // If no content was parsed, return empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens || 0,
            outputTokens: response.usage.completion_tokens || 0,
          }
        : undefined,
    };
  }

  private mapStopReason(finishReason?: string): LLMResponse['stopReason'] {
    switch (finishReason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      case 'content_filter':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }

  /**
   * Fetch available models from OpenRouter API
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string; context_length: number }>> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data?: any[] };
      return (data.data || []).map((model: any) => ({
        id: model.id,
        name: model.name || model.id,
        context_length: model.context_length || 0,
      }));
    } catch (error) {
      console.error('Failed to fetch OpenRouter models:', error);
      return [];
    }
  }
}
