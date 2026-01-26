import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  ConverseCommand,
  ContentBlock,
  Message,
  SystemContentBlock,
  ToolConfiguration,
  ToolInputSchema,
  StopReason,
} from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-provider-ini';
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
 * AWS Bedrock provider implementation
 * Uses the Converse API for AI models
 */
export class BedrockProvider implements LLMProvider {
  readonly type = 'bedrock' as const;
  private client: BedrockRuntimeClient;

  constructor(config: LLMProviderConfig) {
    const clientConfig: BedrockRuntimeClientConfig = {
      region: config.awsRegion || 'us-east-1',
    };

    // Use explicit credentials if provided
    if (config.awsAccessKeyId && config.awsSecretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
        ...(config.awsSessionToken && { sessionToken: config.awsSessionToken }),
      };
    } else if (config.awsProfile) {
      // Use fromIni to load credentials from a specific profile
      // This avoids mutating process.env which could affect other code
      clientConfig.credentials = fromIni({ profile: config.awsProfile });
    }
    // Otherwise, let the SDK use default credential chain
    // (environment variables, IAM role, etc.)

    this.client = new BedrockRuntimeClient(clientConfig);
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);
    const system = this.convertSystem(request.system);
    const toolConfig = request.tools ? this.convertTools(request.tools) : undefined;

    const command = new ConverseCommand({
      modelId: request.model,
      messages,
      system,
      inferenceConfig: {
        maxTokens: request.maxTokens,
      },
      ...(toolConfig && { toolConfig }),
    });

    try {
      console.log(`[Bedrock] Calling API with model: ${request.model}`);
      const response = await this.client.send(command);
      return this.convertResponse(response);
    } catch (error: any) {
      console.error(`[Bedrock] API error:`, {
        name: error.name,
        message: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
      });
      throw error;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // Send a minimal request to test the connection
      const command = new ConverseCommand({
        modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hi' }],
          },
        ],
        inferenceConfig: {
          maxTokens: 10,
        },
      });

      await this.client.send(command);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to AWS Bedrock',
      };
    }
  }

  private convertSystem(system: string): SystemContentBlock[] {
    return [{ text: system }];
  }

  private convertMessages(messages: LLMMessage[]): Message[] {
    return messages.map((msg) => {
      const content: ContentBlock[] = [];

      if (typeof msg.content === 'string') {
        content.push({ text: msg.content });
      } else {
        for (const item of msg.content) {
          if (item.type === 'text') {
            content.push({ text: item.text });
          } else if (item.type === 'tool_use') {
            content.push({
              toolUse: {
                toolUseId: item.id,
                name: item.name,
                input: item.input,
              },
            });
          } else if (item.type === 'tool_result') {
            content.push({
              toolResult: {
                toolUseId: item.tool_use_id,
                content: [{ text: item.content }],
                status: item.is_error ? 'error' : 'success',
              },
            });
          }
        }
      }

      return {
        role: msg.role,
        content,
      };
    });
  }

  private convertTools(tools: LLMTool[]): ToolConfiguration {
    return {
      tools: tools.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            json: tool.input_schema,
          } as ToolInputSchema,
        },
      })),
    };
  }

  private convertResponse(response: any): LLMResponse {
    const content: LLMContent[] = [];

    if (response.output?.message?.content) {
      for (const block of response.output.message.content) {
        if (block.text) {
          content.push({
            type: 'text',
            text: block.text,
          });
        } else if (block.toolUse) {
          content.push({
            type: 'tool_use',
            id: block.toolUse.toolUseId,
            name: block.toolUse.name,
            input: block.toolUse.input,
          });
        }
      }
    }

    return {
      content,
      stopReason: this.mapStopReason(response.stopReason),
      usage: response.usage
        ? {
            inputTokens: response.usage.inputTokens || 0,
            outputTokens: response.usage.outputTokens || 0,
          }
        : undefined,
    };
  }

  private mapStopReason(reason: StopReason | undefined): LLMResponse['stopReason'] {
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
