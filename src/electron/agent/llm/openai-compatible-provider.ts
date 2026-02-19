import {
  LLMProvider,
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  PROVIDER_IMAGE_CAPS,
} from './types';
import {
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
  fromOpenAICompatibleResponse,
} from './openai-compatible';

export interface OpenAICompatibleProviderOptions {
  type: LLMProviderType;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly type: LLMProviderType;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private providerName: string;
  private extraHeaders?: Record<string, string>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.type = options.type;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.defaultModel = options.defaultModel;
    this.providerName = options.providerName;
    this.extraHeaders = options.extraHeaders;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const caps = PROVIDER_IMAGE_CAPS[this.type];
    const supportsImages = caps?.supportsImages === true;
    const messages = toOpenAICompatibleMessages(request.messages, request.system, { supportsImages });
    const tools = request.tools ? toOpenAICompatibleTools(request.tools) : undefined;

    try {
      const model = request.model || this.defaultModel;
      console.log(`[${this.providerName}] Calling API with model: ${model}`);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.extraHeaders || {}),
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: request.maxTokens,
          ...(tools && { tools, tool_choice: 'auto' }),
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
      return fromOpenAICompatibleResponse(data);
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.extraHeaders || {}),
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
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
        error: error.message || `Failed to connect to ${this.providerName} API`,
      };
    }
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/models`, {
        headers,
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { data?: any[] };
      return (data.data || []).map((model: any) => ({
        id: model.id,
        name: model.id,
      }));
    } catch (error) {
      console.error(`[${this.providerName}] Failed to fetch models:`, error);
      return [];
    }
  }
}
