import type { LLMProviderType } from "./types";

export type ProviderCompatibility = "openai" | "anthropic";

export interface ProviderCatalogEntry {
  id: LLMProviderType;
  name: string;
  compatibility: ProviderCompatibility;
  baseUrl?: string;
  defaultModel: string;
  apiKeyLabel: string;
  apiKeyPlaceholder?: string;
  apiKeyUrl?: string;
  requiresBaseUrl?: boolean;
  apiKeyOptional?: boolean;
  description?: string;
}

export const CUSTOM_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    compatibility: "openai",
    defaultModel: "",
    apiKeyLabel: "API Key / Token",
    apiKeyPlaceholder: "Enter token",
    requiresBaseUrl: true,
    description: "OpenAI-compatible endpoint required.",
  },
  {
    id: "google-vertex",
    name: "Google Vertex",
    compatibility: "openai",
    defaultModel: "gemini-2.0-flash",
    apiKeyLabel: "Access Token",
    apiKeyPlaceholder: "ya29...",
    requiresBaseUrl: true,
    description: "Requires a compatible gateway endpoint.",
  },
  {
    id: "google-antigravity",
    name: "Google Antigravity",
    compatibility: "openai",
    defaultModel: "gemini-2.0-flash",
    apiKeyLabel: "Access Token",
    apiKeyPlaceholder: "ya29...",
    requiresBaseUrl: true,
    description: "Requires a compatible gateway endpoint.",
  },
  {
    id: "google-gemini-cli",
    name: "Google Gemini CLI",
    compatibility: "openai",
    defaultModel: "gemini-2.0-flash",
    apiKeyLabel: "Access Token",
    apiKeyPlaceholder: "ya29...",
    requiresBaseUrl: true,
    description: "Requires a compatible gateway endpoint.",
  },
  {
    id: "zai",
    name: "Z.AI",
    compatibility: "openai",
    defaultModel: "glm-4.7",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "zai-...",
    requiresBaseUrl: true,
    description: "OpenAI-compatible endpoint required.",
  },
  {
    id: "glm",
    name: "GLM",
    compatibility: "openai",
    defaultModel: "glm-4-plus",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "glm-...",
    requiresBaseUrl: true,
    description: "OpenAI-compatible endpoint required.",
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    compatibility: "anthropic",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModel: "claude-sonnet-4-6",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "vgw_...",
    apiKeyUrl: "https://vercel.com/docs/ai-gateway",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    compatibility: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.5",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "sk-...",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    compatibility: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama3.1-8b",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "csk_...",
    apiKeyUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "mistral",
    name: "Mistral",
    compatibility: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "mistral-...",
    apiKeyUrl: "https://console.mistral.ai/",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    compatibility: "openai",
    defaultModel: "gpt-4o",
    apiKeyLabel: "GitHub Token",
    apiKeyPlaceholder: "ghp_...",
  },
  {
    id: "qwen-portal",
    name: "Qwen",
    compatibility: "anthropic",
    baseUrl: "https://portal.qwen.ai/v1",
    defaultModel: "coder-model",
    apiKeyLabel: "API Key / Token",
    apiKeyPlaceholder: "qwen-...",
  },
  {
    id: "minimax",
    name: "MiniMax",
    compatibility: "openai",
    baseUrl: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-M2.1",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "minimax-...",
  },
  {
    id: "minimax-portal",
    name: "MiniMax Portal",
    compatibility: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
    defaultModel: "MiniMax-M2.1",
    apiKeyLabel: "API Key / Token",
    apiKeyPlaceholder: "minimax-...",
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    compatibility: "anthropic",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    defaultModel: "mimo-v2-flash",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "mimo-...",
  },
  {
    id: "venice",
    name: "Venice AI",
    compatibility: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    defaultModel: "llama-3.3-70b",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "venice-...",
  },
  {
    id: "synthetic",
    name: "Synthetic",
    compatibility: "anthropic",
    baseUrl: "https://api.synthetic.new/anthropic",
    defaultModel: "hf:MiniMaxAI/MiniMax-M2.1",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "syn_...",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    compatibility: "openai",
    baseUrl: "https://api.kimi.com/coding/v1",
    defaultModel: "kimi-for-coding",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "sk-...",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-Compatible (Custom)",
    compatibility: "openai",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "gpt-4o-mini",
    apiKeyLabel: "API Key (Optional)",
    apiKeyPlaceholder: "sk-...",
    requiresBaseUrl: true,
    apiKeyOptional: true,
  },
  {
    id: "anthropic-compatible",
    name: "Anthropic-Compatible (Custom)",
    compatibility: "anthropic",
    baseUrl: "http://localhost:4000",
    defaultModel: "claude-sonnet-4-6",
    apiKeyLabel: "API Key",
    apiKeyPlaceholder: "sk-...",
    requiresBaseUrl: true,
  },
];

export const CUSTOM_PROVIDER_MAP = new Map(
  CUSTOM_PROVIDER_CATALOG.map((provider) => [provider.id, provider]),
);

export const CUSTOM_PROVIDER_IDS = new Set(CUSTOM_PROVIDER_CATALOG.map((provider) => provider.id));
