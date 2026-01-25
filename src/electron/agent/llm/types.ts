/**
 * LLM Provider abstraction types
 * Allows switching between Anthropic API and AWS Bedrock
 */

export type LLMProviderType = 'anthropic' | 'bedrock' | 'ollama';

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
  // Ollama-specific
  ollamaBaseUrl?: string;
  ollamaApiKey?: string; // Optional API key for remote Ollama servers
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
 * Note: Ollama models are dynamic and fetched from the server
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

/**
 * Popular Ollama models with their details
 * Users can use any model available on their Ollama server
 */
export const OLLAMA_MODELS = {
  'llama3.2': { displayName: 'Llama 3.2', size: '3B' },
  'llama3.1': { displayName: 'Llama 3.1', size: '8B' },
  'llama3.1:70b': { displayName: 'Llama 3.1 70B', size: '70B' },
  'mistral': { displayName: 'Mistral', size: '7B' },
  'mixtral': { displayName: 'Mixtral', size: '47B' },
  'codellama': { displayName: 'Code Llama', size: '7B' },
  'deepseek-coder': { displayName: 'DeepSeek Coder', size: '6.7B' },
  'qwen2.5': { displayName: 'Qwen 2.5', size: '7B' },
  'phi3': { displayName: 'Phi-3', size: '3.8B' },
  'gemma2': { displayName: 'Gemma 2', size: '9B' },
} as const;

export type OllamaModelKey = keyof typeof OLLAMA_MODELS;

export type ModelKey = keyof typeof MODELS;

export const DEFAULT_MODEL: ModelKey = 'opus-4-5';
