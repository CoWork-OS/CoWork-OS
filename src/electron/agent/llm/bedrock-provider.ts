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
  private model: string;
  private region: string;
  private credentials?: any;
  private resolvedModelCache = new Map<string, string>();
  private inferenceProfileCache?: { fetchedAt: number; profiles: InferenceProfileCandidate[] };
  private static readonly CONTINUE_PLACEHOLDER_TEXT = 'I understand. Let me continue.';

  private static readonly toolNameRegex = /^[a-zA-Z0-9_-]+$/;

  constructor(config: LLMProviderConfig) {
    const clientConfig: BedrockRuntimeClientConfig = {
      region: config.awsRegion || 'us-east-1',
    };
    this.region = config.awsRegion || 'us-east-1';

    // Store the model for use in testConnection
    this.model = config.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0';

    // Use explicit credentials if provided
    if (config.awsAccessKeyId && config.awsSecretAccessKey) {
      this.credentials = {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
        ...(config.awsSessionToken && { sessionToken: config.awsSessionToken }),
      };
      clientConfig.credentials = this.credentials;
    } else if (config.awsProfile) {
      // Use fromIni to load credentials from a specific profile
      // This avoids mutating process.env which could affect other code
      this.credentials = fromIni({ profile: config.awsProfile });
      clientConfig.credentials = this.credentials;
    }
    // Otherwise, let the SDK use default credential chain
    // (environment variables, IAM role, etc.)

    this.client = new BedrockRuntimeClient(clientConfig);
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const toolNameMap = request.tools ? this.buildToolNameMap(request.tools) : undefined;
    const messages = this.convertMessages(this.ensureConversationEndsWithUserMessage(request.messages), toolNameMap);
    const system = this.convertSystem(request.system);
    const toolConfig = request.tools ? this.convertTools(request.tools, toolNameMap) : undefined;

    const resolvedModelId = await this.resolveModelId(request.model);
    const command = new ConverseCommand({
      modelId: resolvedModelId,
      messages,
      system,
      inferenceConfig: {
        maxTokens: request.maxTokens,
      },
      ...(toolConfig && { toolConfig }),
    });

    try {
      if (resolvedModelId !== request.model) {
        console.log(`[Bedrock] Resolved model: ${request.model} -> ${resolvedModelId}`);
      }
      console.log(`[Bedrock] Calling API with model: ${resolvedModelId}`);
      const response = await this.client.send(
        command,
        // Pass abort signal to allow cancellation
        request.signal ? { abortSignal: request.signal } : undefined
      );
      return this.convertResponse(response, toolNameMap);
    } catch (error: any) {
      // Handle abort errors gracefully
      if (error.name === 'AbortError' || error.message?.includes('aborted')) {
        console.log(`[Bedrock] Request aborted`);
        throw new Error('Request cancelled');
      }

      const rawMessage = String(error?.message || '');
      const lower = rawMessage.toLowerCase();

      // If Bedrock rejects the requested model for on-demand invocation, automatically
      // retry with an inference profile that the user has access to (when available).
      if (lower.includes('inference profile') || lower.includes('on-demand throughput')) {
        const fallback = await this.resolveInferenceProfileFallback(request.model);
        if (fallback && fallback !== resolvedModelId) {
          console.log(`[Bedrock] Retrying with inference profile: ${fallback}`);
          const retryResponse = await this.client.send(
            new ConverseCommand({
              modelId: fallback,
              messages,
              system,
              inferenceConfig: { maxTokens: request.maxTokens },
              ...(toolConfig && { toolConfig }),
            }),
            request.signal ? { abortSignal: request.signal } : undefined
          );
          // Cache for subsequent calls in this process.
          this.resolvedModelCache.set(request.model, fallback);
          return this.convertResponse(retryResponse, toolNameMap);
        }

        throw new Error(
          `Model ${request.model} requires an inference profile in AWS Bedrock, but none could be resolved automatically. ` +
          `Select an inference profile ID/ARN (often starts with "us.") in Settings.`
        );
      }

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
      // Send a minimal request to test the connection using the configured model
      console.log(`[Bedrock] Testing connection with model: ${this.model}`);
      const command = new ConverseCommand({
        modelId: await this.resolveModelId(this.model),
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
      // Provide helpful error message for common issues
      let errorMessage = error.message || 'Failed to connect to AWS Bedrock';

      // Check for inference profile requirement
      if (errorMessage.includes('inference profile') || errorMessage.toLowerCase().includes('on-demand throughput')) {
        const fallback = await this.resolveInferenceProfileFallback(this.model);
        if (fallback) {
          try {
            await this.client.send(
              new ConverseCommand({
                modelId: fallback,
                messages: [
                  {
                    role: 'user',
                    content: [{ text: 'Hi' }],
                  },
                ],
                inferenceConfig: { maxTokens: 10 },
              })
            );
            // Persist within this provider instance for subsequent tests.
            this.model = fallback;
            return { success: true };
          } catch (fallbackError: any) {
            errorMessage = fallbackError?.message || errorMessage;
          }
        }

        errorMessage = `Model ${this.model} requires an inference profile. ` +
          `Try selecting a different model or create/select an inference profile in AWS Console.`;
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async resolveModelId(requested: string): Promise<string> {
    const trimmed = (requested || '').trim();
    if (!trimmed) return trimmed;

    const cached = this.resolvedModelCache.get(trimmed);
    if (cached) return cached;

    // If it's already an inference profile ID/ARN, use as-is.
    if (trimmed.startsWith('us.') || trimmed.startsWith('arn:')) {
      this.resolvedModelCache.set(trimmed, trimmed);
      return trimmed;
    }

    // Attempt to map a foundation model ID to an accessible inference profile.
    if (this.isClaudeModelId(trimmed)) {
      const fallback = await this.resolveInferenceProfileFallback(trimmed);
      if (fallback) {
        this.resolvedModelCache.set(trimmed, fallback);
        return fallback;
      }
    }

    // No inference profile found; fall back to requested model (may still work for older on-demand models).
    this.resolvedModelCache.set(trimmed, trimmed);
    return trimmed;
  }

  private async resolveInferenceProfileFallback(requestedModel: string): Promise<string | null> {
    if (!this.isClaudeModelId(requestedModel)) return null;

    const profiles = await this.getClaudeInferenceProfiles();
    if (profiles.length === 0) return null;

    const token = this.extractModelToken(requestedModel);
    let best: { id: string; score: number } | null = null;

    for (const profile of profiles) {
      let score = 0;
      if (profile.id.startsWith('us.')) score += 5;
      if (profile.type === 'SYSTEM_DEFINED') score += 2;

      if (token) {
        for (const modelArn of profile.modelArns) {
          const arnToken = this.extractModelToken(modelArn);
          if (!arnToken) continue;
          if (arnToken === token) score += 100;
          else if (arnToken.includes(token) || token.includes(arnToken)) score += 30;
        }
      }

      if (!best || score > best.score) {
        best = { id: profile.id, score };
      }
    }

    // If we couldn't match by token, pick the first usable profile (stable order from AWS).
    if (!best || best.score === 0) {
      return profiles[0].id;
    }

    return best.id;
  }

  private async getClaudeInferenceProfiles(): Promise<InferenceProfileCandidate[]> {
    const now = Date.now();
    if (this.inferenceProfileCache && now - this.inferenceProfileCache.fetchedAt < 5 * 60 * 1000) {
      return this.inferenceProfileCache.profiles;
    }

    try {
      const { BedrockClient, ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock');
      const client = new BedrockClient({
        region: this.region,
        ...(this.credentials && { credentials: this.credentials }),
      } as any);

      const results: InferenceProfileCandidate[] = [];
      let nextToken: string | undefined;
      let pageCount = 0;

      do {
        pageCount++;
        const response = await client.send(
          new ListInferenceProfilesCommand({
            maxResults: 100,
            nextToken,
          })
        );

        const profiles = (response.inferenceProfileSummaries || []) as any[];
        for (const p of profiles) {
          if (p?.status && p.status !== 'ACTIVE') continue;

          const modelArns = Array.isArray(p?.models) ? p.models.map((m: any) => String(m?.modelArn || '')).filter(Boolean) : [];
          const hasClaude = modelArns.some((arn: string) => {
            const lower = arn.toLowerCase();
            return lower.includes('anthropic') && lower.includes('claude');
          });
          if (!hasClaude) continue;

          const id = String((p?.inferenceProfileId || p?.inferenceProfileArn || '')).trim();
          if (!id) continue;

          results.push({
            id,
            type: p?.type ? String(p.type) : undefined,
            modelArns,
          });
        }

        nextToken = response.nextToken;
      } while (nextToken && pageCount < 10);

      this.inferenceProfileCache = { fetchedAt: now, profiles: results };
      return results;
    } catch (err) {
      // If the caller doesn't have permissions to list inference profiles, we can't auto-resolve.
      this.inferenceProfileCache = { fetchedAt: now, profiles: [] };
      return [];
    }
  }

  private extractModelToken(input: string): string {
    let s = (input || '').toLowerCase().trim();
    if (!s) return '';

    // Support matching against ARNs like .../foundation-model/<modelId>
    if (s.startsWith('arn:')) {
      const idx = s.lastIndexOf('/');
      if (idx !== -1 && idx + 1 < s.length) {
        s = s.slice(idx + 1);
      }
    }

    if (s.startsWith('anthropic.')) s = s.slice('anthropic.'.length);

    // Drop trailing :N.
    s = s.replace(/:\\d+$/, '');

    // Drop trailing -vN.
    s = s.replace(/-v\\d+$/, '');

    // Drop trailing -YYYYMMDD (common in Bedrock model IDs).
    s = s.replace(/-20\\d{6,8}$/, '');

    return s;
  }

  private isClaudeModelId(modelId: string): boolean {
    const lower = (modelId || '').toLowerCase();
    return lower.includes('claude') || lower.includes('anthropic');
  }

  private convertSystem(system: string): SystemContentBlock[] {
    return [{ text: system }];
  }

  private ensureConversationEndsWithUserMessage(messages: LLMMessage[]): LLMMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages;
    }

    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return messages;

    if (!this.isSyntheticAssistantPlaceholder(last)) {
      return messages;
    }

    console.log(
      `[Bedrock] Rewriting terminal assistant message as user message to satisfy Converse user-terminal format`
    );

    return [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: last.content,
      },
    ];
  }

  private isSyntheticAssistantPlaceholder(message: LLMMessage): boolean {
    if (typeof message?.content === 'string') {
      return message.content.trim().length === 0;
    }

    if (!Array.isArray(message?.content)) return false;
    if (message.content.length === 0) return true;

    return (
      message.content.length === 1 &&
      message.content[0]?.type === 'text' &&
      message.content[0].text === BedrockProvider.CONTINUE_PLACEHOLDER_TEXT
    );
  }

  private convertMessages(messages: LLMMessage[], toolNameMap?: ToolNameMap): Message[] {
    return messages.map((msg) => {
      const content: ContentBlock[] = [];

      if (typeof msg.content === 'string') {
        content.push({ text: msg.content });
      } else {
        for (const item of msg.content) {
          if (item.type === 'text') {
            content.push({ text: item.text });
          } else if (item.type === 'tool_use') {
            const mappedName = toolNameMap?.toProvider.get(item.name) || item.name;
            content.push({
              toolUse: {
                toolUseId: item.id,
                name: mappedName,
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
          } else if (item.type === 'image') {
            content.push({
              image: {
                format: item.mimeType.split('/')[1] as 'jpeg' | 'png' | 'gif' | 'webp',
                source: {
                  bytes: new Uint8Array(Buffer.from(item.data, 'base64')),
                },
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

  private convertTools(tools: LLMTool[], toolNameMap?: ToolNameMap): ToolConfiguration {
    return {
      tools: tools.map((tool) => ({
        toolSpec: {
          name: toolNameMap?.toProvider.get(tool.name) || tool.name,
          description: tool.description,
          inputSchema: {
            json: tool.input_schema,
          } as ToolInputSchema,
        },
      })),
    };
  }

  private convertResponse(response: any, toolNameMap?: ToolNameMap): LLMResponse {
    const content: LLMContent[] = [];

    if (response.output?.message?.content) {
      for (const block of response.output.message.content) {
        if (block.text) {
          content.push({
            type: 'text',
            text: block.text,
          });
        } else if (block.toolUse) {
          const mappedName = toolNameMap?.fromProvider.get(block.toolUse.name) || block.toolUse.name;
          content.push({
            type: 'tool_use',
            id: block.toolUse.toolUseId,
            name: mappedName,
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

  private buildToolNameMap(tools: LLMTool[]): ToolNameMap {
    const toProvider = new Map<string, string>();
    const fromProvider = new Map<string, string>();
    const used = new Set<string>();

    for (const tool of tools) {
      let base = this.normalizeToolName(tool.name);
      if (!base) {
        base = `tool_${this.shortHash(tool.name)}`;
      }

      let candidate = base;
      if (used.has(candidate)) {
        const hashed = `${base}_${this.shortHash(tool.name)}`;
        candidate = hashed;
        let counter = 1;
        while (used.has(candidate)) {
          candidate = `${hashed}_${counter++}`;
        }
      }

      used.add(candidate);
      toProvider.set(tool.name, candidate);
      fromProvider.set(candidate, tool.name);
    }

    return { toProvider, fromProvider };
  }

  private normalizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return BedrockProvider.toolNameRegex.test(sanitized) ? sanitized : '';
  }

  private shortHash(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
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

interface ToolNameMap {
  toProvider: Map<string, string>;
  fromProvider: Map<string, string>;
}

interface InferenceProfileCandidate {
  id: string;
  type?: string;
  modelArns: string[];
}
