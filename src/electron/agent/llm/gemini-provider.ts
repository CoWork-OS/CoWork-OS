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
      const model = this.client.getGenerativeModel({ model: this.defaultModel });
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
            const thoughtSignature = this.getThoughtSignatureFromId(item.id);
            const functionCallPart: any = {
              functionCall: {
                name: item.name,
                args: item.input,
              },
            };
            // Include thought signature if present (required for Gemini 3 models)
            if (thoughtSignature) {
              functionCallPart.thoughtSignature = thoughtSignature;
            }
            parts.push(functionCallPart);
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

  // Track tool names and thought signatures for result mapping
  private toolIdToName: Map<string, string> = new Map();
  private toolIdToThoughtSignature: Map<string, string> = new Map();

  private getToolNameFromId(toolUseId: string): string {
    return this.toolIdToName.get(toolUseId) || toolUseId;
  }

  private getThoughtSignatureFromId(toolUseId: string): string | undefined {
    return this.toolIdToThoughtSignature.get(toolUseId);
  }

  /**
   * Recursively sanitize schema for Gemini API compatibility.
   * Gemini requires all nested objects/arrays to have explicit 'type' fields.
   */
  private sanitizeSchemaForGemini(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const result: any = { ...schema };

    // Ensure type field exists
    if (!result.type) {
      if (result.properties) {
        result.type = SchemaType.OBJECT;
      } else if (result.items) {
        result.type = SchemaType.ARRAY;
      } else if (typeof result.enum !== 'undefined') {
        result.type = SchemaType.STRING;
      }
    }

    // Convert string type names to SchemaType enum values
    if (typeof result.type === 'string') {
      const typeMap: Record<string, SchemaType> = {
        'string': SchemaType.STRING,
        'number': SchemaType.NUMBER,
        'integer': SchemaType.INTEGER,
        'boolean': SchemaType.BOOLEAN,
        'array': SchemaType.ARRAY,
        'object': SchemaType.OBJECT,
      };
      result.type = typeMap[result.type.toLowerCase()] || result.type;
    }

    // Recursively process properties
    if (result.properties) {
      const sanitizedProperties: any = {};
      for (const [key, value] of Object.entries(result.properties)) {
        sanitizedProperties[key] = this.sanitizeSchemaForGemini(value);
      }
      result.properties = sanitizedProperties;
    }

    // Handle array types - ensure items exists and has a type
    if (result.type === SchemaType.ARRAY || result.type === 'array') {
      if (!result.items) {
        // Add default items if missing for array type
        result.items = { type: SchemaType.STRING };
      } else {
        result.items = this.sanitizeSchemaForGemini(result.items);
        // Ensure items has a type
        if (!result.items.type) {
          result.items.type = SchemaType.STRING;
        }
      }
    }

    return result;
  }

  private convertTools(tools: LLMTool[]): Tool[] {
    const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => {
      // Sanitize the entire parameters schema for Gemini compatibility
      const sanitizedProperties: any = {};
      if (tool.input_schema.properties) {
        for (const [key, value] of Object.entries(tool.input_schema.properties)) {
          sanitizedProperties[key] = this.sanitizeSchemaForGemini(value);
        }
      }

      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: sanitizedProperties,
          required: tool.input_schema.required || [],
        },
      };
    });

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
        // Capture thought signature if present (required for Gemini 3 models)
        if (part.thoughtSignature) {
          this.toolIdToThoughtSignature.set(toolUseId, part.thoughtSignature);
        }
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

  /**
   * Fetch available models from Gemini API
   */
  async getAvailableModels(): Promise<Array<{ name: string; displayName: string; description: string }>> {
    try {
      // Use the REST API to list models since the SDK doesn't expose listModels well
      const apiKey = (this.client as any).apiKey;
      const maskedKey = apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : 'undefined';
      console.log(`[Gemini] Fetching models with API key: ${maskedKey}`);

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[Gemini] Failed to fetch models - Status: ${response.status} ${response.statusText}`);
        console.error(`[Gemini] Error response body:`, errorBody);
        return this.getDefaultModels();
      }

      const data = await response.json() as { models?: any[] };

      // Patterns to exclude non-text models
      const excludePatterns = [
        /imagen/i,           // Image generation models
        /embedding/i,        // Embedding models
        /aqa/i,              // Attributed question answering
        /vision/i,           // Vision-only models
        /audio/i,            // Audio models
        /speech/i,           // Speech models
        /tts/i,              // Text-to-speech models
        /robot/i,            // Robotics models
        /learnlm/i,          // Learning models
        /thinking/i,         // Experimental thinking models
        /native-audio/i,     // Native audio models
        /live/i,             // Live/streaming models (not for text generation)
        /nano/i,             // Nano models (on-device/specialized)
        /banana/i,           // Image generation models (nano banana)
        /veo/i,              // Video generation models
        /diffusion/i,        // Diffusion models (image generation)
      ];

      const isTextModel = (modelName: string): boolean => {
        const name = modelName.toLowerCase();
        // Must be a gemini model
        if (!name.includes('gemini')) return false;
        // Exclude non-text models
        for (const pattern of excludePatterns) {
          if (pattern.test(name)) return false;
        }
        // Must be a pro, flash, ultra, or nano variant (text models)
        return name.includes('pro') || name.includes('flash') || name.includes('ultra');
      };

      const models = (data.models || [])
        .filter((model: any) =>
          model.supportedGenerationMethods?.includes('generateContent') &&
          isTextModel(model.name || '')
        )
        .map((model: any) => ({
          name: model.name?.replace('models/', '') || '',
          displayName: model.displayName || model.name?.replace('models/', '') || '',
          description: model.description || '',
        }))
        .filter((model: any) => model.name);

      // Sort models: newer versions first, pro before flash
      // Dynamically extract version numbers (e.g., "3.0", "2.5", "2.0", "1.5")
      const sortedModels = models.sort((a: any, b: any) => {
        const extractVersion = (name: string): number => {
          // Match patterns like "gemini-3.0", "gemini-2.5", "gemini-1.5-pro"
          const versionMatch = name.match(/gemini-?(\d+\.?\d*)/i);
          if (versionMatch) {
            return parseFloat(versionMatch[1]);
          }
          return 0;
        };
        const getTypeScore = (name: string): number => {
          if (name.includes('pro')) return 0.03;
          if (name.includes('flash-lite') || name.includes('lite')) return 0.01;
          if (name.includes('flash')) return 0.02;
          return 0;
        };
        // Combine version (major sort) + type (minor sort)
        const scoreA = extractVersion(a.name) + getTypeScore(a.name);
        const scoreB = extractVersion(b.name) + getTypeScore(b.name);
        return scoreB - scoreA;
      });

      return sortedModels.length > 0 ? sortedModels : this.getDefaultModels();
    } catch (error) {
      console.error('Failed to fetch Gemini models:', error);
      return this.getDefaultModels();
    }
  }

  /**
   * Get default models when API call fails
   */
  private getDefaultModels(): Array<{ name: string; displayName: string; description: string }> {
    return [
      { name: 'gemini-2.5-pro-preview-05-06', displayName: 'Gemini 2.5 Pro', description: 'Most capable model for complex tasks' },
      { name: 'gemini-2.5-flash-preview-05-20', displayName: 'Gemini 2.5 Flash', description: 'Fast and efficient for most tasks' },
      { name: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', description: 'Balanced speed and capability' },
      { name: 'gemini-2.0-flash-lite', displayName: 'Gemini 2.0 Flash Lite', description: 'Fastest and most cost-effective' },
      { name: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', description: 'Previous generation pro model' },
      { name: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', description: 'Previous generation flash model' },
    ];
  }
}
