import Anthropic from '@anthropic-ai/sdk';
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
 * Anthropic API provider implementation
 */
export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic' as const;
  private client: Anthropic;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      throw new Error('Anthropic API key is required. Configure it in Settings or get one from https://console.anthropic.com/');
    }

    this.client = new Anthropic({ apiKey });
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    // Convert our generic format to Anthropic format
    const messages = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      console.log(`[Anthropic] Calling API with model: ${request.model}`);
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages,
        ...(tools && { tools }),
      });

      return this.convertResponse(response);
    } catch (error: any) {
      console.error(`[Anthropic] API error:`, {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
        headers: error.headers ? Object.fromEntries(error.headers) : undefined,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // Send a minimal request to test the connection
      await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Anthropic API',
      };
    }
  }

  private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content,
        };
      }

      // Handle array content (tool results or mixed content)
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
        return {
          type: 'text' as const,
          text: item.text,
        };
      });

      return {
        role: msg.role,
        content,
      };
    }) as Anthropic.MessageParam[];
  }

  private convertTools(tools: LLMTool[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private convertResponse(response: Anthropic.Message): LLMResponse {
    const content: LLMContent[] = response.content
      .filter((block) => block.type === 'text' || block.type === 'tool_use')
      .map((block) => {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, any>,
          };
        }
        // Type guard: at this point block must be a TextBlock
        return {
          type: 'text' as const,
          text: (block as Anthropic.TextBlock).text,
        };
      });

    return {
      content,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private mapStopReason(
    reason: Anthropic.Message['stop_reason']
  ): LLMResponse['stopReason'] {
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
