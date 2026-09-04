import { CUSTOM_PROVIDER_MAP } from "./llm-provider-catalog";
import type { LLMProviderType } from "./types";

export type ModelAccessKind =
  | "account"
  | "api"
  | "gateway"
  | "cloud"
  | "local"
  | "mixed"
  | "orchestration";

export type ModelAccessGroup = "accounts" | "apis" | "gateways" | "local" | "orchestration";

export type ModelAccessReleaseStatus = "stable" | "experimental";

export interface ModelAccessDescriptor {
  providerType: LLMProviderType;
  name: string;
  kind: ModelAccessKind;
  group: ModelAccessGroup;
  label: string;
  billingNotice: string;
  releaseStatus: ModelAccessReleaseStatus;
}

const BUILTIN_PROVIDER_NAMES: Partial<Record<LLMProviderType, string>> = {
  anthropic: "Claude",
  bedrock: "AWS Bedrock",
  ollama: "Ollama",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  azure: "Azure OpenAI",
  "azure-anthropic": "Azure Anthropic",
  groq: "Groq",
  xai: "xAI",
  "xai-oauth": "Grok OAuth",
  kimi: "Kimi",
  pi: "Pi",
  "openai-compatible": "OpenAI-Compatible",
  moa: "Mixture of Agents",
};

const ACCESS_KIND_OVERRIDES: Partial<Record<LLMProviderType, ModelAccessKind>> = {
  anthropic: "mixed",
  openai: "mixed",
  xai: "mixed",
  "xai-oauth": "account",
  "opencode-go": "mixed",
  "github-copilot": "account",
  bedrock: "cloud",
  azure: "cloud",
  "azure-anthropic": "cloud",
  "google-vertex": "cloud",
  "google-antigravity": "gateway",
  "google-gemini-cli": "gateway",
  "vercel-ai-gateway": "gateway",
  "openai-compatible": "gateway",
  "anthropic-compatible": "gateway",
  pi: "gateway",
  ollama: "local",
  "hf-agents": "local",
  mlx: "local",
  moa: "orchestration",
};

const EXPERIMENTAL_PROVIDERS = new Set<LLMProviderType>(["xai-oauth", "github-copilot"]);

const ACCESS_LABELS: Record<ModelAccessKind, string> = {
  account: "Account",
  api: "API",
  gateway: "Gateway",
  cloud: "Cloud",
  local: "Local",
  mixed: "Account or API",
  orchestration: "Model orchestration",
};

const ACCESS_GROUPS: Record<ModelAccessKind, ModelAccessGroup> = {
  account: "accounts",
  api: "apis",
  gateway: "gateways",
  cloud: "gateways",
  local: "local",
  mixed: "accounts",
  orchestration: "orchestration",
};

const BILLING_NOTICES: Record<ModelAccessKind, string> = {
  account: "Provider eligibility, plan limits, and usage terms apply.",
  api: "Usage is billed directly by the configured provider.",
  gateway: "Usage and routing are controlled by the configured gateway or upstream provider.",
  cloud: "Usage is billed through the configured cloud account.",
  local: "Local inference has no CoWork charge; local compute and hosting costs still apply.",
  mixed: "The selected account or API route controls eligibility, limits, and billing.",
  orchestration: "Each model route in the orchestration bills according to its provider.",
};

export const MODEL_ACCESS_GROUP_LABELS: Record<ModelAccessGroup, string> = {
  accounts: "Subscriptions and sign-ins",
  apis: "Provider APIs",
  gateways: "Gateways and cloud credentials",
  local: "Local models",
  orchestration: "Model orchestration",
};

export const MODEL_ACCESS_GROUP_ORDER: ModelAccessGroup[] = [
  "accounts",
  "apis",
  "gateways",
  "local",
  "orchestration",
];

export function getModelAccessDescriptor(providerType: LLMProviderType): ModelAccessDescriptor {
  const kind = ACCESS_KIND_OVERRIDES[providerType] || "api";
  const customEntry = CUSTOM_PROVIDER_MAP.get(providerType);

  return {
    providerType,
    name: customEntry?.name || BUILTIN_PROVIDER_NAMES[providerType] || providerType,
    kind,
    group: ACCESS_GROUPS[kind],
    label: ACCESS_LABELS[kind],
    billingNotice: BILLING_NOTICES[kind],
    releaseStatus: EXPERIMENTAL_PROVIDERS.has(providerType) ? "experimental" : "stable",
  };
}

export function groupProvidersByModelAccess<T extends { type: LLMProviderType }>(
  providers: T[],
): Record<ModelAccessGroup, T[]> {
  const groups: Record<ModelAccessGroup, T[]> = {
    accounts: [],
    apis: [],
    gateways: [],
    local: [],
    orchestration: [],
  };

  for (const provider of providers) {
    groups[getModelAccessDescriptor(provider.type).group].push(provider);
  }

  return groups;
}
