import {
  LLMProvider,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

export interface AnthropicCompatibleProviderOptions {
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

export class AnthropicCompatibleProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private providerName: string;

  constructor(options: AnthropicCompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;
    const model = request.model || this.defaultModel;

    try {
      console.log(`[${this.providerName}] Calling API with model: ${model}`);
      const response = await fetch(joinUrl(this.baseUrl, '/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages,
          ...(tools && { tools }),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(
          `${this.providerName} API error: ${response.status} ${response.statusText}` +
          (errorData.error?.message ? ` - ${errorData.error.message}` : '')
        );
      }

      const data = await response.json() as any;
      return this.convertResponse(data);
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        console.log(`[${this.providerName}] Request aborted`);
        throw new Error('Request cancelled');
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
      const response = await fetch(joinUrl(this.baseUrl, '/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
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
        error: error.message || `Failed to connect to ${this.providerName} API`,
      };
    }
  }

  private convertMessages(messages: LLMMessage[]): Array<{ role: string; content: any }> {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content,
        };
      }

      const content = msg.content.map((item) => {
        if (item.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: item.tool_use_id,
            content: item.content,
            ...(item.is_error && { is_error: true }),
          };
        }
        if (item.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: item.id,
            name: item.name,
            input: item.input,
          };
        }
        if (item.type === 'image') {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: item.mimeType,
              data: item.data,
            },
          };
        }
        return {
          type: 'text' as const,
          text: item.text,
        };
      });

      return {
        role: msg.role,
        content,
      };
    });
  }

  private convertTools(tools: LLMTool[]): Array<{ name: string; description: string; input_schema: any }> {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private convertResponse(response: any): LLMResponse {
    const content: LLMContent[] = (response.content || [])
      .filter((block: any) => block.type === 'text' || block.type === 'tool_use')
      .map((block: any) => {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>,
          };
        }
        return {
          type: 'text' as const,
          text: block.text || '',
        };
      });

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      stopReason: this.mapStopReason(response.stop_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens || 0,
            outputTokens: response.usage.output_tokens || 0,
          }
        : undefined,
    };
  }

  private mapStopReason(reason?: string): LLMResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }
}
