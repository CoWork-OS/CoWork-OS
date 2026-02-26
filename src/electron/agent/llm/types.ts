/**
 * LLM Provider abstraction types
 * Allows switching between Anthropic API and AWS Bedrock
 */

import type { LLMProviderType } from "../../../shared/types";

export type { LLMProviderType };

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
  // Gemini-specific
  geminiApiKey?: string;
  // OpenRouter-specific
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  // OpenAI-specific
  openaiApiKey?: string;
  openaiAccessToken?: string; // OAuth access token
  openaiRefreshToken?: string; // OAuth refresh token
  openaiTokenExpiresAt?: number; // OAuth token expiry timestamp
  // Azure OpenAI-specific
  azureApiKey?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  // Groq-specific
  groqApiKey?: string;
  groqBaseUrl?: string;
  // xAI-specific
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  // Kimi-specific
  kimiApiKey?: string;
  kimiBaseUrl?: string;
  // Pi-specific (uses pi-ai unified LLM API)
  piProvider?: string; // pi-ai KnownProvider (e.g. 'anthropic', 'openai', 'google')
  piApiKey?: string;
  // OpenAI-compatible endpoint
  openaiCompatibleApiKey?: string;
  openaiCompatibleBaseUrl?: string;
  // Generic provider support
  providerApiKey?: string;
  providerBaseUrl?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface LLMToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface LLMTextContent {
  type: "text";
  text: string;
}

/** Supported image MIME types across providers */
export type LLMImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface LLMImageContent {
  type: "image";
  /** Base64-encoded image data (no data URL prefix) */
  data: string;
  /** MIME type of the image */
  mimeType: LLMImageMimeType;
  /** Original byte size before any processing (for limit enforcement) */
  originalSizeBytes?: number;
}

export type LLMContent = LLMToolUse | LLMTextContent | LLMImageContent;

/** Per-provider image capability limits */
export interface LLMProviderImageCaps {
  supportsImages: boolean;
  maxImageBytes: number;
  supportedMimeTypes: LLMImageMimeType[];
}

export const PROVIDER_IMAGE_CAPS: Record<string, LLMProviderImageCaps> = {
  anthropic: {
    supportsImages: true,
    maxImageBytes: 5 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  bedrock: {
    supportsImages: true,
    maxImageBytes: 5 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  openai: {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  gemini: {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  azure: {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  ollama: {
    supportsImages: true,
    maxImageBytes: 10 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png"],
  },
  openrouter: {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  xai: {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  "openai-compatible": {
    supportsImages: true,
    maxImageBytes: 20 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
  "anthropic-compatible": {
    supportsImages: true,
    maxImageBytes: 5 * 1024 * 1024,
    supportedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  groq: { supportsImages: false, maxImageBytes: 0, supportedMimeTypes: [] },
  kimi: { supportsImages: false, maxImageBytes: 0, supportedMimeTypes: [] },
  pi: { supportsImages: false, maxImageBytes: 0, supportedMimeTypes: [] },
};

export interface LLMToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContent[] | LLMToolResult[];
}

/** Progress info emitted periodically during streaming LLM responses. */
export interface StreamProgress {
  inputTokens: number;
  outputTokens: number;
  outputChars: number;
  elapsedMs: number;
  /** `true` while still streaming; `false` on the final event. */
  streaming: boolean;
}

export type StreamProgressCallback = (progress: StreamProgress) => void;

export interface LLMRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** Optional abort signal to cancel the request */
  signal?: AbortSignal;
  /** Optional callback for streaming progress (token counts, elapsed time). */
  onStreamProgress?: StreamProgressCallback;
  /** Opaque call ID injected by the logging wrapper for log correlation. */
  _callId?: number;
}

export interface LLMResponse {
  content: LLMContent[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
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
 * Note: Bedrock models are kept in provider ID form first, then resolved via Bedrock provider mapping when needed.
 * Note: Ollama models are dynamic and fetched from the server
 */
export const MODELS = {
  "opus-4-5": {
    anthropic: "claude-opus-4-5-20251101",
    bedrock: "anthropic.claude-opus-4-5-20251101",
    displayName: "Opus 4.5",
  },
  "sonnet-4-6": {
    anthropic: "claude-sonnet-4-6",
    bedrock: "anthropic.claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
  },
  "sonnet-4-5": {
    anthropic: "claude-sonnet-4-5-20250514",
    bedrock: "anthropic.claude-sonnet-4-5-20250514",
    displayName: "Sonnet 4.5",
  },
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5-20250514",
    bedrock: "anthropic.claude-haiku-4-5-20250514",
    displayName: "Haiku 4.5",
  },
  "sonnet-4": {
    anthropic: "claude-sonnet-4-20250514",
    bedrock: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    displayName: "Sonnet 4",
  },
  "sonnet-3-5": {
    anthropic: "claude-3-5-sonnet-20241022",
    bedrock: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    displayName: "Sonnet 3.5",
  },
  "haiku-3-5": {
    anthropic: "claude-3-5-haiku-20241022",
    bedrock: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    displayName: "Haiku 3.5",
  },
} as const;

/**
 * Available Gemini models from Google AI Studio
 */
export const GEMINI_MODELS = {
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro-preview-05-06",
    displayName: "Gemini 2.5 Pro",
    description: "Most capable model for complex tasks",
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash-preview-05-20",
    displayName: "Gemini 2.5 Flash",
    description: "Fast and efficient for most tasks",
  },
  "gemini-2.0-flash": {
    id: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    description: "Balanced speed and capability",
  },
  "gemini-2.0-flash-lite": {
    id: "gemini-2.0-flash-lite",
    displayName: "Gemini 2.0 Flash Lite",
    description: "Fastest and most cost-effective",
  },
  "gemini-1.5-pro": {
    id: "gemini-1.5-pro",
    displayName: "Gemini 1.5 Pro",
    description: "Previous generation pro model",
  },
  "gemini-1.5-flash": {
    id: "gemini-1.5-flash",
    displayName: "Gemini 1.5 Flash",
    description: "Previous generation flash model",
  },
} as const;

export type GeminiModelKey = keyof typeof GEMINI_MODELS;

/**
 * Popular OpenRouter models
 * OpenRouter provides access to many models from different providers
 */
export const OPENROUTER_MODELS = {
  "anthropic/claude-3.5-sonnet": {
    id: "anthropic/claude-3.5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    description: "Anthropic's balanced model",
  },
  "anthropic/claude-3-opus": {
    id: "anthropic/claude-3-opus",
    displayName: "Claude 3 Opus",
    description: "Anthropic's most capable model",
  },
  "openai/gpt-4o": {
    id: "openai/gpt-4o",
    displayName: "GPT-4o",
    description: "OpenAI's flagship model",
  },
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    displayName: "GPT-4o Mini",
    description: "OpenAI's fast and affordable model",
  },
  "google/gemini-pro-1.5": {
    id: "google/gemini-pro-1.5",
    displayName: "Gemini Pro 1.5",
    description: "Google's advanced model",
  },
  "meta-llama/llama-3.1-405b-instruct": {
    id: "meta-llama/llama-3.1-405b-instruct",
    displayName: "Llama 3.1 405B",
    description: "Meta's largest open model",
  },
  "mistralai/mistral-large": {
    id: "mistralai/mistral-large",
    displayName: "Mistral Large",
    description: "Mistral's flagship model",
  },
  "deepseek/deepseek-chat": {
    id: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "DeepSeek's conversational model",
  },
} as const;

export type OpenRouterModelKey = keyof typeof OPENROUTER_MODELS;

/**
 * Available OpenAI models
 * Users with ChatGPT Plus/Team/Enterprise subscriptions can use these models
 */
export const OPENAI_MODELS = {
  "gpt-4o": {
    id: "gpt-4o",
    displayName: "GPT-4o",
    description: "Most capable model for complex tasks",
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    description: "Fast and affordable for most tasks",
  },
  "gpt-4-turbo": {
    id: "gpt-4-turbo",
    displayName: "GPT-4 Turbo",
    description: "Previous generation flagship",
  },
  "gpt-3.5-turbo": {
    id: "gpt-3.5-turbo",
    displayName: "GPT-3.5 Turbo",
    description: "Fast and cost-effective",
  },
  o1: {
    id: "o1",
    displayName: "o1",
    description: "Advanced reasoning model",
  },
  "o1-mini": {
    id: "o1-mini",
    displayName: "o1 Mini",
    description: "Fast reasoning model",
  },
} as const;

export type OpenAIModelKey = keyof typeof OPENAI_MODELS;

/**
 * Popular Groq models
 */
export const GROQ_MODELS = {
  "llama-3.1-8b-instant": {
    id: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant",
    description: "Fast, cost-efficient Groq model",
  },
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B Versatile",
    description: "Higher capability Groq model",
  },
} as const;

export type GroqModelKey = keyof typeof GROQ_MODELS;

/**
 * Popular xAI (Grok) models
 */
export const XAI_MODELS = {
  "grok-4": {
    id: "grok-4",
    displayName: "Grok 4",
    description: "Flagship model",
  },
  "grok-4-fast-non-reasoning": {
    id: "grok-4-fast-non-reasoning",
    displayName: "Grok 4 Fast (Non-Reasoning)",
    description: "Fast responses without explicit reasoning",
  },
  "grok-4-fast-reasoning": {
    id: "grok-4-fast-reasoning",
    displayName: "Grok 4 Fast (Reasoning)",
    description: "Faster model with reasoning support",
  },
} as const;

export type XAIModelKey = keyof typeof XAI_MODELS;

/**
 * Kimi (Moonshot) models
 */
export const KIMI_MODELS = {
  "kimi-k2.5": {
    id: "kimi-k2.5",
    displayName: "Kimi K2.5",
    description: "Latest Kimi K2.5 model",
  },
  "kimi-k2-0905-preview": {
    id: "kimi-k2-0905-preview",
    displayName: "Kimi K2.5 Preview",
    description: "Preview K2.5 model",
  },
  "kimi-k2-turbo-preview": {
    id: "kimi-k2-turbo-preview",
    displayName: "Kimi K2 Turbo (Preview)",
    description: "Faster K2 preview model",
  },
  "kimi-k2-thinking": {
    id: "kimi-k2-thinking",
    displayName: "Kimi K2 Thinking",
    description: "Reasoning-focused K2 model",
  },
  "kimi-k2-thinking-turbo": {
    id: "kimi-k2-thinking-turbo",
    displayName: "Kimi K2 Thinking Turbo",
    description: "Faster reasoning K2 model",
  },
} as const;

export type KimiModelKey = keyof typeof KIMI_MODELS;

/**
 * Pi provider backends
 * These map to pi-ai KnownProvider types
 */
export const PI_PROVIDERS = {
  anthropic: { displayName: "Anthropic" },
  openai: { displayName: "OpenAI" },
  google: { displayName: "Google" },
  xai: { displayName: "xAI" },
  groq: { displayName: "Groq" },
  cerebras: { displayName: "Cerebras" },
  openrouter: { displayName: "OpenRouter" },
  mistral: { displayName: "Mistral" },
  "amazon-bedrock": { displayName: "Amazon Bedrock" },
  "openai-codex": { displayName: "OpenAI Codex (OAuth)" },
  "github-copilot": { displayName: "GitHub Copilot" },
  "azure-openai-responses": { displayName: "Azure OpenAI" },
  minimax: { displayName: "MiniMax" },
  huggingface: { displayName: "HuggingFace" },
  "kimi-coding": { displayName: "Kimi Coding" },
} as const;

export type PiProviderKey = keyof typeof PI_PROVIDERS;

/** Default model used when no Pi model is explicitly configured */
export const DEFAULT_PI_MODEL = "claude-sonnet-4-5-20250514";

/**
 * Popular Ollama models with their details
 * Users can use any model available on their Ollama server
 */
export const OLLAMA_MODELS = {
  "llama3.2": { displayName: "Llama 3.2", size: "3B" },
  "llama3.1": { displayName: "Llama 3.1", size: "8B" },
  "llama3.1:70b": { displayName: "Llama 3.1 70B", size: "70B" },
  mistral: { displayName: "Mistral", size: "7B" },
  mixtral: { displayName: "Mixtral", size: "47B" },
  codellama: { displayName: "Code Llama", size: "7B" },
  "deepseek-coder": { displayName: "DeepSeek Coder", size: "6.7B" },
  "qwen2.5": { displayName: "Qwen 2.5", size: "7B" },
  phi3: { displayName: "Phi-3", size: "3.8B" },
  gemma2: { displayName: "Gemma 2", size: "9B" },
} as const;

export type OllamaModelKey = keyof typeof OLLAMA_MODELS;

export type ModelKey = keyof typeof MODELS;

export const DEFAULT_MODEL: ModelKey = "opus-4-5";
