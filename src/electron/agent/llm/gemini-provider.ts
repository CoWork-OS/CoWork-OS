import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
  Part,
  Tool,
  FunctionDeclaration,
  FunctionCallingMode,
  SchemaType,
} from '@google/generative-ai';
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
 * Google AI Studio (Gemini) provider implementation
 */
export class GeminiProvider implements LLMProvider {
  readonly type = 'gemini' as const;
  private client: GoogleGenerativeAI;
  private defaultModel: string;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is required. Get one from https://aistudio.google.com/apikey');
    }

    this.client = new GoogleGenerativeAI(apiKey);
    this.defaultModel = config.model || 'gemini-2.0-flash';
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const model = this.client.getGenerativeModel({
      model: request.model || this.defaultModel,
      systemInstruction: request.system,
    });

    const contents = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      console.log(`[Gemini] Calling API with model: ${request.model || this.defaultModel}`);

      const result = await model.generateContent({
        contents,
        generationConfig: {
          maxOutputTokens: request.maxTokens,
        },
        ...(tools && {
          tools,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingMode.AUTO,
            },
          },
        }),
      });

      const response = result.response;
      return this.convertResponse(response);
    } catch (error: any) {
      console.error(`[Gemini] API error:`, {
        message: error.message,
        status: error.status,
        statusText: error.statusText,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const model = this.client.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 10 },
      });
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Gemini API',
      };
    }
  }

  private convertMessages(messages: LLMMessage[]): Content[] {
    return messages.map((msg) => {
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else {
        // Handle array content (tool results or mixed content)
        for (const item of msg.content) {
          if (item.type === 'tool_result') {
            // Gemini uses functionResponse for tool results
            parts.push({
              functionResponse: {
                name: this.getToolNameFromId(item.tool_use_id),
                response: {
                  result: item.content,
                  is_error: item.is_error || false,
                },
              },
            });
          } else if (item.type === 'tool_use') {
            // Gemini uses functionCall for tool invocations
            parts.push({
              functionCall: {
                name: item.name,
                args: item.input,
              },
            });
          } else if (item.type === 'text') {
            parts.push({ text: item.text });
          }
        }
      }

      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
  }

  // Track tool names to IDs for result mapping
  private toolIdToName: Map<string, string> = new Map();

  private getToolNameFromId(toolUseId: string): string {
    return this.toolIdToName.get(toolUseId) || toolUseId;
  }

  private convertTools(tools: LLMTool[]): Tool[] {
    const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: tool.input_schema.properties,
        required: tool.input_schema.required || [],
      },
    }));

    return [{ functionDeclarations }];
  }

  private convertResponse(response: any): LLMResponse {
    const content: LLMContent[] = [];
    const candidate = response.candidates?.[0];

    if (!candidate) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
      };
    }

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        content.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.functionCall) {
        const toolUseId = `gemini_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.toolIdToName.set(toolUseId, part.functionCall.name);
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      }
    }

    // If no content was parsed, return empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stopReason: this.mapStopReason(candidate.finishReason),
      usage: response.usageMetadata
        ? {
            inputTokens: response.usageMetadata.promptTokenCount || 0,
            outputTokens: response.usageMetadata.candidatesTokenCount || 0,
          }
        : undefined,
    };
  }

  private mapStopReason(finishReason?: string): LLMResponse['stopReason'] {
    switch (finishReason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
      case 'OTHER':
        return 'stop_sequence';
      default:
        // Check if we have function calls (tool use)
        return 'end_turn';
    }
  }
}
