/**
 * LLM Provider abstraction types
 * Allows switching between Anthropic API and AWS Bedrock
 */

export type LLMProviderType = 'anthropic' | 'bedrock';

export interface LLMProviderConfig {
  type: LLMProviderType;
  model: string;
  // Anthropic-specific
  anthropicApiKey?: string;
  // Bedrock-specific
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  // Use AWS profile instead of explicit credentials
  awsProfile?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface LLMToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface LLMTextContent {
  type: 'text';
  text: string;
}

export type LLMContent = LLMToolUse | LLMTextContent;

export interface LLMToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContent[] | LLMToolResult[];
}

export interface LLMRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
}

export interface LLMResponse {
  content: LLMContent[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Abstract LLM Provider interface
 */
export interface LLMProvider {
  readonly type: LLMProviderType;

  /**
   * Send a message to the LLM and get a response
   */
  createMessage(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Test the provider connection
   */
  testConnection(): Promise<{ success: boolean; error?: string }>;
}

/**
 * Available AI models with their IDs for each provider
 * Note: Bedrock uses inference profile IDs (us. prefix) for newer models
 */
export const MODELS = {
  'opus-4-5': {
    anthropic: 'claude-opus-4-5-20251101',
    bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    displayName: 'Opus 4.5',
  },
  'sonnet-4-5': {
    anthropic: 'claude-sonnet-4-5-20250514',
    bedrock: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    displayName: 'Sonnet 4.5',
  },
  'haiku-4-5': {
    anthropic: 'claude-haiku-4-5-20250514',
    bedrock: 'us.anthropic.claude-haiku-4-5-20250514-v1:0',
    displayName: 'Haiku 4.5',
  },
  'sonnet-4': {
    anthropic: 'claude-sonnet-4-20250514',
    bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    displayName: 'Sonnet 4',
  },
  'sonnet-3-5': {
    anthropic: 'claude-3-5-sonnet-20241022',
    bedrock: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    displayName: 'Sonnet 3.5',
  },
  'haiku-3-5': {
    anthropic: 'claude-3-5-haiku-20241022',
    bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    displayName: 'Haiku 3.5',
  },
} as const;

export type ModelKey = keyof typeof MODELS;

export const DEFAULT_MODEL: ModelKey = 'opus-4-5';
