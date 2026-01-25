import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  LLMToolUse,
} from './types';

/**
 * Ollama API provider implementation
 * Supports local and remote Ollama servers
 * https://ollama.ai/
 */
export class OllamaProvider implements LLMProvider {
  readonly type = 'ollama' as const;
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.apiKey = config.ollamaApiKey || process.env.OLLAMA_API_KEY;

    // Remove trailing slash if present
    if (this.baseUrl.endsWith('/')) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages, request.system);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages,
        stream: false,
        options: {
          num_predict: request.maxTokens,
        },
        ...(tools && tools.length > 0 && { tools }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as OllamaChatResponse;
    return this.convertResponse(data);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      // First check if Ollama is running
      const response = await fetch(`${this.baseUrl}/api/tags`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to connect to Ollama: ${response.status}`);
      }

      const data = await response.json() as { models?: Array<{ name: string }> };
      if (!data.models || data.models.length === 0) {
        return {
          success: false,
          error: 'No models available. Run "ollama pull <model>" to download a model.',
        };
      }

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Ollama server',
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
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/api/tags`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json() as {
        models?: Array<{ name: string; size: number; modified_at: string }>;
      };

      return (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at,
      }));
    } catch (error: any) {
      console.error('Failed to fetch Ollama models:', error);
      return [];
    }
  }

  private convertMessages(
    messages: LLMMessage[],
    systemPrompt: string
  ): OllamaMessage[] {
    const ollamaMessages: OllamaMessage[] = [];

    // Add system message first
    if (systemPrompt) {
      ollamaMessages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        ollamaMessages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        });
      } else {
        // Handle array content (tool results or mixed content)
        const textParts: string[] = [];
        const toolCalls: OllamaToolCall[] = [];

        for (const item of msg.content) {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else if (item.type === 'tool_use') {
            toolCalls.push({
              function: {
                name: item.name,
                arguments: item.input,
              },
            });
          } else if (item.type === 'tool_result') {
            // Tool results in Ollama format
            ollamaMessages.push({
              role: 'tool',
              content: item.content,
            });
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0) {
          ollamaMessages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: textParts.join('\n') || '',
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          });
        }
      }
    }

    return ollamaMessages;
  }

  private convertTools(tools: LLMTool[]): OllamaTool[] {
    return tools.map(tool => ({
      type: 'function',
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

    // Handle text content
    if (message.content) {
      content.push({
        type: 'text',
        text: message.content,
      });
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          name: toolCall.function.name,
          input: typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments,
        } as LLMToolUse);
      }
    }

    // Determine stop reason
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    if (message.tool_calls && message.tool_calls.length > 0) {
      stopReason = 'tool_use';
    } else if (response.done_reason === 'length') {
      stopReason = 'max_tokens';
    } else if (response.done_reason === 'stop') {
      stopReason = 'stop_sequence';
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, any> | string;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
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
