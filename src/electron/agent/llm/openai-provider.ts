import OpenAI from 'openai';
import {
  getModel,
  getModels,
  complete as piAiComplete,
  type Model,
  type Message as PiAiMessage,
  type Context as PiAiContext,
  type Tool as PiAiTool,
} from '@mariozechner/pi-ai';
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMTool,
  LLMToolResult,
} from './types';
import { OpenAIOAuth, OpenAIOAuthTokens } from './openai-oauth';

// Default model for openai-codex (ChatGPT backend)
const DEFAULT_CODEX_MODEL = 'gpt-5.1-codex-mini';

/**
 * OpenAI API provider implementation
 * Supports both API key and OAuth token authentication
 * - API Key: Uses OpenAI SDK directly with api.openai.com
 * - OAuth: Uses pi-ai SDK with ChatGPT backend (chatgpt.com/backend-api/)
 */
export class OpenAIProvider implements LLMProvider {
  readonly type = 'openai' as const;
  private client: OpenAI | null = null;
  private authMethod: 'api_key' | 'oauth';
  private oauthTokens?: OpenAIOAuthTokens;
  private model: string;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.openaiApiKey;
    const accessToken = config.openaiAccessToken;
    const refreshToken = config.openaiRefreshToken;
    const tokenExpiresAt = config.openaiTokenExpiresAt;
    this.model = config.model;

    if (accessToken && refreshToken) {
      // Use OAuth - will use pi-ai SDK for API calls
      this.oauthTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: tokenExpiresAt || 0, // Use stored expiry or 0 if not available
      };
      this.authMethod = 'oauth';
      console.log(`[OpenAI] Using OAuth authentication with pi-ai SDK (token expires: ${tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : 'unknown'})`);
    } else if (apiKey) {
      // Use API key - standard OpenAI SDK
      this.client = new OpenAI({ apiKey });
      this.authMethod = 'api_key';
      console.log('[OpenAI] Using API key authentication');
    } else {
      throw new Error('OpenAI authentication required. Use API key or sign in with ChatGPT.');
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    if (this.authMethod === 'oauth') {
      return this.createMessageWithOAuth(request);
    } else {
      return this.createMessageWithApiKey(request);
    }
  }

  /**
   * Create message using API key (standard OpenAI SDK)
   */
  private async createMessageWithApiKey(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const messages = this.convertMessages(request.messages, request.system);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      console.log(`[OpenAI] Calling API with model: ${request.model}`);

      const response = await this.client.chat.completions.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          messages,
          ...(tools && tools.length > 0 && { tools }),
        },
        request.signal ? { signal: request.signal } : undefined
      );

      return this.convertResponse(response);
    } catch (error: any) {
      // Handle abort errors gracefully
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        console.log(`[OpenAI] Request aborted`);
        throw new Error('Request cancelled');
      }

      console.error(`[OpenAI] API error:`, {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
      });
      throw error;
    }
  }

  /**
   * Map public model names to openai-codex model IDs
   */
  private mapToCodexModel(modelId: string): string {
    // Map common public model names to ChatGPT internal models
    const modelMap: Record<string, string> = {
      // Map gpt-4o models to gpt-5.1
      'gpt-4o': 'gpt-5.1',
      'gpt-4o-mini': 'gpt-5.1-codex-mini',
      // Map o1/reasoning models to gpt-5.2
      'o1': 'gpt-5.2',
      'o1-mini': 'gpt-5.2-codex',
      'o1-preview': 'gpt-5.2',
      // Default mappings
      'gpt-4-turbo': 'gpt-5.1',
      'gpt-4': 'gpt-5.1',
      'gpt-3.5-turbo': 'gpt-5.1-codex-mini',
    };

    return modelMap[modelId] || modelId;
  }

  /**
   * Create message using OAuth (pi-ai SDK with ChatGPT backend)
   */
  private async createMessageWithOAuth(request: LLMRequest): Promise<LLMResponse> {
    if (!this.oauthTokens) {
      throw new Error('OAuth tokens not available');
    }

    try {
      // Map model ID to ChatGPT internal model
      const codexModelId = this.mapToCodexModel(request.model);
      console.log(`[OpenAI] Calling ChatGPT backend with model: ${codexModelId} (requested: ${request.model})`);

      // Get the model object from pi-ai SDK
      let model: Model<any>;
      try {
        // Get available models and find one that matches
        const availableModels = getModels('openai-codex');
        const found = availableModels.find(m => m.id === codexModelId);
        if (found) {
          model = found;
        } else {
          // Use default if not found
          console.log(`[OpenAI] Model ${codexModelId} not found, using default: ${DEFAULT_CODEX_MODEL}`);
          model = availableModels.find(m => m.id === DEFAULT_CODEX_MODEL) || availableModels[0];
        }
      } catch (e) {
        console.error('[OpenAI] Failed to get model from pi-ai SDK:', e);
        throw new Error(`Model not available: ${codexModelId}`);
      }

      // Convert messages to pi-ai format
      const piAiMessages = this.convertMessagesToPiAi(request.messages);

      // Convert tools to pi-ai format
      const piAiTools = request.tools ? this.convertToolsToPiAi(request.tools) : undefined;

      // Get API key from OAuth tokens (with auto-refresh)
      const { apiKey, newTokens } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);

      // Update tokens if they were refreshed
      if (newTokens) {
        this.oauthTokens = newTokens;
      }

      // Build context
      const context: PiAiContext = {
        systemPrompt: request.system,
        messages: piAiMessages,
        tools: piAiTools,
      };

      // Make the API call using pi-ai SDK
      const response = await piAiComplete(model, context, {
        apiKey,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });

      // Convert pi-ai response to our format
      return this.convertPiAiResponse(response);
    } catch (error: any) {
      // Handle abort errors gracefully
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        console.log(`[OpenAI] Request aborted`);
        throw new Error('Request cancelled');
      }

      console.error(`[OpenAI] ChatGPT API error:`, {
        message: error.message,
        type: error.type || error.name,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.authMethod === 'oauth') {
        // For OAuth, try to get the API key and make a simple request
        if (!this.oauthTokens) {
          return { success: false, error: 'OAuth tokens not available' };
        }

        const { apiKey } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);

        // Get a model from the available models
        const availableModels = getModels('openai-codex');
        const model = availableModels.find(m => m.id === DEFAULT_CODEX_MODEL) || availableModels[0];

        await piAiComplete(
          model,
          {
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: 'Hi' }],
              timestamp: Date.now(),
            }],
          },
          { apiKey, maxTokens: 10 }
        );

        return { success: true };
      } else {
        // For API key, use standard OpenAI SDK
        if (!this.client) {
          return { success: false, error: 'OpenAI client not initialized' };
        }

        await this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        });
        return { success: true };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to OpenAI API',
      };
    }
  }

  /**
   * Get available models
   * For API key: uses the models.list API
   * For OAuth: uses pi-ai SDK's model list for openai-codex provider
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    // For OAuth authentication, use pi-ai SDK's model list
    if (this.authMethod === 'oauth') {
      console.log('[OpenAI] Using OAuth - fetching models from pi-ai SDK...');

      try {
        // Get models from pi-ai SDK for openai-codex provider
        const piAiModels = getModels('openai-codex');

        const models = piAiModels.map((m) => ({
          id: m.id,
          name: m.name || this.formatModelName(m.id),
          description: this.getModelDescription(m.id),
        }));

        // Sort by priority
        models.sort((a, b) => {
          const priority = (id: string) => {
            if (id.includes('5.1-codex-mini')) return 0;
            if (id.includes('5.1-codex-max')) return 1;
            if (id === 'gpt-5.1') return 2;
            if (id.includes('5.2-codex')) return 3;
            if (id === 'gpt-5.2') return 4;
            return 5;
          };
          return priority(a.id) - priority(b.id);
        });

        console.log(`[OpenAI] Found ${models.length} models via pi-ai SDK`);
        return models;
      } catch (error) {
        console.error('[OpenAI] Failed to get models from pi-ai SDK:', error);
        // Return defaults on error
        return this.getDefaultCodexModels();
      }
    }

    // For API key authentication, use the standard models list API
    if (this.client) {
      try {
        const response = await this.client.models.list();
        const models = response.data
          .filter((m) => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3'))
          .map((m) => ({
            id: m.id,
            name: this.formatModelName(m.id),
            description: this.getModelDescription(m.id),
          }))
          .sort((a, b) => {
            const priority = (id: string) => {
              if (id.includes('gpt-4o')) return 0;
              if (id.includes('gpt-4')) return 1;
              if (id.includes('gpt-3.5')) return 2;
              if (id.includes('o1')) return 3;
              if (id.includes('o3')) return 4;
              return 5;
            };
            return priority(a.id) - priority(b.id);
          });
        return models;
      } catch (error: any) {
        console.error('Failed to fetch OpenAI models:', error);
      }
    }

    // Return defaults if nothing else works
    return this.getDefaultModels();
  }

  private getDefaultModels(): Array<{ id: string; name: string; description: string }> {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Most capable model for complex tasks' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and affordable for most tasks' },
      { id: 'o1', name: 'o1', description: 'Advanced reasoning model' },
      { id: 'o1-mini', name: 'o1 Mini', description: 'Fast reasoning model' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Previous generation flagship' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Fast and cost-effective' },
    ];
  }

  private getDefaultCodexModels(): Array<{ id: string; name: string; description: string }> {
    return [
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'Fast and efficient for most tasks' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'Maximum capability for complex tasks' },
      { id: 'gpt-5.1', name: 'GPT-5.1', description: 'Balanced performance and capability' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'Advanced reasoning model' },
      { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Most advanced reasoning' },
    ];
  }

  private formatModelName(modelId: string): string {
    // Format model ID to display name
    if (modelId === 'gpt-4o') return 'GPT-4o';
    if (modelId === 'gpt-4o-mini') return 'GPT-4o Mini';
    if (modelId.includes('gpt-4o-')) return `GPT-4o (${modelId.replace('gpt-4o-', '')})`;
    if (modelId === 'gpt-4-turbo') return 'GPT-4 Turbo';
    if (modelId.includes('gpt-4-turbo-')) return `GPT-4 Turbo (${modelId.replace('gpt-4-turbo-', '')})`;
    if (modelId === 'gpt-4') return 'GPT-4';
    if (modelId.includes('gpt-4-')) return `GPT-4 (${modelId.replace('gpt-4-', '')})`;
    if (modelId === 'gpt-3.5-turbo') return 'GPT-3.5 Turbo';
    if (modelId.includes('gpt-3.5-turbo-')) return `GPT-3.5 Turbo (${modelId.replace('gpt-3.5-turbo-', '')})`;
    if (modelId === 'o1') return 'o1';
    if (modelId === 'o1-mini') return 'o1 Mini';
    if (modelId === 'o1-preview') return 'o1 Preview';
    if (modelId === 'o3-mini') return 'o3 Mini';
    // ChatGPT internal models
    if (modelId === 'gpt-5.1') return 'GPT-5.1';
    if (modelId === 'gpt-5.1-codex-mini') return 'GPT-5.1 Codex Mini';
    if (modelId === 'gpt-5.1-codex-max') return 'GPT-5.1 Codex Max';
    if (modelId === 'gpt-5.2') return 'GPT-5.2';
    if (modelId === 'gpt-5.2-codex') return 'GPT-5.2 Codex';
    return modelId;
  }

  private getModelDescription(modelId: string): string {
    if (modelId.includes('gpt-4o') && !modelId.includes('mini')) return 'Most capable model for complex tasks';
    if (modelId.includes('gpt-4o-mini')) return 'Fast and affordable for most tasks';
    if (modelId.includes('gpt-4-turbo')) return 'Previous generation flagship';
    if (modelId.includes('gpt-4')) return 'High capability model';
    if (modelId.includes('gpt-3.5')) return 'Fast and cost-effective';
    if (modelId === 'o1' || modelId === 'o1-preview') return 'Advanced reasoning model';
    if (modelId === 'o1-mini') return 'Fast reasoning model';
    if (modelId.includes('o3')) return 'Next generation reasoning';
    // ChatGPT internal models
    if (modelId === 'gpt-5.1') return 'Balanced performance and capability';
    if (modelId === 'gpt-5.1-codex-mini') return 'Fast and efficient for most tasks';
    if (modelId === 'gpt-5.1-codex-max') return 'Maximum capability for complex tasks';
    if (modelId === 'gpt-5.2') return 'Most advanced reasoning';
    if (modelId === 'gpt-5.2-codex') return 'Advanced reasoning model';
    return 'OpenAI model';
  }

  /**
   * Convert messages to pi-ai SDK format
   */
  private convertMessagesToPiAi(messages: LLMMessage[]): PiAiMessage[] {
    const result: PiAiMessage[] = [];
    const now = Date.now();

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        if (msg.role === 'user') {
          result.push({
            role: 'user',
            content: [{ type: 'text', text: msg.content }],
            timestamp: now,
          });
        } else {
          // Assistant message
          result.push({
            role: 'assistant',
            content: [{ type: 'text', text: msg.content }],
            api: 'openai-codex-responses',
            provider: 'openai-codex',
            model: this.model,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: now,
          });
        }
      } else if (Array.isArray(msg.content)) {
        // Check if this is a tool result array
        const toolResults = msg.content.filter((item): item is LLMToolResult => item.type === 'tool_result');

        if (toolResults.length > 0) {
          // Convert tool results to pi-ai format
          for (const toolResult of toolResults) {
            result.push({
              role: 'toolResult',
              toolCallId: toolResult.tool_use_id,
              toolName: '', // Will be filled by the SDK
              content: [{ type: 'text', text: toolResult.content }],
              isError: toolResult.is_error || false,
              timestamp: now,
            });
          }
        } else {
          // Handle mixed content (text and tool_use)
          if (msg.role === 'user') {
            const textContent = msg.content
              .filter((item) => item.type === 'text')
              .map((item) => ({ type: 'text' as const, text: (item as any).text }));

            if (textContent.length > 0) {
              result.push({
                role: 'user',
                content: textContent,
                timestamp: now,
              });
            }
          } else {
            // Assistant message with tool calls
            const content: any[] = [];

            for (const item of msg.content) {
              if (item.type === 'text') {
                content.push({ type: 'text', text: (item as any).text });
              } else if (item.type === 'tool_use') {
                content.push({
                  type: 'toolCall',
                  id: (item as any).id,
                  name: (item as any).name,
                  arguments: (item as any).input,
                });
              }
            }

            if (content.length > 0) {
              result.push({
                role: 'assistant',
                content,
                api: 'openai-codex-responses',
                provider: 'openai-codex',
                model: this.model,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: 'stop',
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
      parameters: tool.input_schema as any,
    }));
  }

  /**
   * Convert pi-ai response to our format
   */
  private convertPiAiResponse(response: any): LLMResponse {
    const content: LLMContent[] = [];

    if (response.content) {
      for (const block of response.content) {
        if (block.type === 'text') {
          content.push({
            type: 'text',
            text: block.text,
          });
        } else if (block.type === 'toolCall') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.arguments || {},
          });
        }
      }
    }

    // Map stop reason
    let stopReason: LLMResponse['stopReason'] = 'end_turn';
    if (response.stopReason === 'toolUse') {
      stopReason = 'tool_use';
    } else if (response.stopReason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      content,
      stopReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.input || 0,
            outputTokens: response.usage.output || 0,
          }
        : undefined,
    };
  }

  /**
   * Convert messages to OpenAI format (for API key auth)
   */
  private convertMessages(messages: LLMMessage[], system?: string): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system message first if provided
    if (system) {
      result.push({
        role: 'system',
        content: system,
      });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({
          role: msg.role,
          content: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        // Check if this is a tool result array
        const toolResults = msg.content.filter((item): item is LLMToolResult => item.type === 'tool_result');

        if (toolResults.length > 0) {
          // Convert tool results to OpenAI format
          for (const toolResult of toolResults) {
            result.push({
              role: 'tool',
              tool_call_id: toolResult.tool_use_id,
              content: toolResult.content,
            });
          }
        } else {
          // Handle mixed content (text and tool_use)
          const textContent = msg.content
            .filter((item) => item.type === 'text')
            .map((item) => (item as { type: 'text'; text: string }).text)
            .join('\n');

          const toolUses = msg.content.filter((item) => item.type === 'tool_use');

          if (msg.role === 'assistant') {
            const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
              role: 'assistant',
              content: textContent || null,
            };

            if (toolUses.length > 0) {
              assistantMsg.tool_calls = toolUses.map((tool) => ({
                id: (tool as any).id,
                type: 'function' as const,
                function: {
                  name: (tool as any).name,
                  arguments: JSON.stringify((tool as any).input),
                },
              }));
            }

            result.push(assistantMsg);
          } else {
            result.push({
              role: msg.role,
              content: textContent,
            });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: LLMTool[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
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
        type: 'text',
        text: choice.message.content,
      });
    }

    // Add tool calls if present
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        // Only handle function-type tool calls
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

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  private mapStopReason(
    reason: OpenAI.ChatCompletion.Choice['finish_reason']
  ): LLMResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      case 'content_filter':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }
}
