import type { LLMProviderType } from "../../../shared/types";
import { estimateTotalTokens } from "../context-manager";
import type { ContextManager } from "../context-manager";
import type { LLMContent, LLMMessage } from "./types";

export type OutputTokenPolicyMode = "legacy" | "adaptive";
export type OutputBudgetRequestKind = "agentic_main" | "tool_followup" | "continuation";
export type OutputBudgetProviderFamily =
  | "anthropic"
  | "bedrock-claude"
  | "openai"
  | "azure-openai"
  | "gemini"
  | "openrouter"
  | "generic";
export type OutputTokenParamName = "max_tokens" | "max_completion_tokens" | "max_output_tokens";
export type OutputTruncationClassification = "visible_partial_output" | "reasoning_exhausted";

export interface OutputTokenPolicyInput {
  providerType: LLMProviderType | string;
  modelId: string;
  messages: LLMMessage[];
  system: string;
  contextManager?: ContextManager | null;
  taskMaxTokens?: number | null;
  requestKind: OutputBudgetRequestKind;
  phase: "initial" | "escalated";
}

export interface ResolvedOutputTokenBudget {
  mode: OutputTokenPolicyMode;
  providerFamily: OutputBudgetProviderFamily;
  routedFamily: Exclude<OutputBudgetProviderFamily, "openrouter"> | null;
  requestKind: OutputBudgetRequestKind;
  transport: {
    paramName: OutputTokenParamName;
    value: number;
  };
  requestedBudget: number;
  chosenBudget: number;
  contextLimit: number | null;
  taskLimit: number | null;
  envLimit: number | null;
  policyDefault: number;
  knownHardCap: number | null;
  capSource: "task" | "env" | "policy";
}

const DEFAULT_AGENTIC_INITIAL_MAX_TOKENS = 8_000;
const DEFAULT_AGENTIC_ESCALATED_MAX_TOKENS = 48_000;
const DEFAULT_TOOL_FOLLOW_UP_INITIAL_MAX_TOKENS = 16_000;
const DEFAULT_GENERIC_ESCALATED_MAX_TOKENS = 16_000;
const DEFAULT_ANTHROPIC_ESCALATED_MAX_TOKENS = 64_000;
const MAX_ENV_OUTPUT_TOKEN_OVERRIDE = 128_000;

const ANTHROPIC_OUTPUT_LIMITS: Array<{ pattern: RegExp; limit: number }> = [
  { pattern: /claude-opus-4-6/i, limit: 128_000 },
  { pattern: /claude-opus-4-5/i, limit: 128_000 },
  { pattern: /claude-opus-4/i, limit: 128_000 },
  { pattern: /claude-sonnet-4-6/i, limit: 64_000 },
  { pattern: /claude-sonnet-4-5/i, limit: 64_000 },
  { pattern: /claude-sonnet-4/i, limit: 64_000 },
  { pattern: /claude-haiku-4-5/i, limit: 64_000 },
  { pattern: /claude-3-5-sonnet/i, limit: 8_192 },
  { pattern: /claude-3-5-haiku/i, limit: 8_192 },
  { pattern: /claude-3-opus/i, limit: 4_096 },
  { pattern: /claude-3-sonnet/i, limit: 4_096 },
  { pattern: /claude-3-haiku/i, limit: 4_096 },
];

const BEDROCK_CLAUDE_OUTPUT_LIMITS: Array<{ pattern: RegExp; limit: number }> = [
  { pattern: /claude-3-5-sonnet/i, limit: 8_192 },
  { pattern: /claude-3-5-haiku/i, limit: 8_192 },
  { pattern: /claude-3-opus/i, limit: 4_096 },
  { pattern: /claude-3-sonnet/i, limit: 4_096 },
  { pattern: /claude-3-haiku/i, limit: 4_096 },
];

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function readEnvLimit(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const normalized = normalizePositiveInteger(Number(raw));
  if (normalized === null) {
    return null;
  }
  return Math.min(normalized, MAX_ENV_OUTPUT_TOKEN_OVERRIDE);
}

function isOpenAIReasoningModel(modelId: string): boolean {
  const normalized = String(modelId || "")
    .toLowerCase()
    .trim();
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

function inferOpenRouterRoutedFamily(
  modelId: string,
): Exclude<OutputBudgetProviderFamily, "openrouter"> | null {
  const normalized = String(modelId || "")
    .toLowerCase()
    .trim();
  if (!normalized) return null;
  if (normalized.startsWith("anthropic/")) return "anthropic";
  if (normalized.startsWith("openai/")) return "openai";
  if (normalized.startsWith("google/") || normalized.startsWith("gemini/")) return "gemini";
  return null;
}

function resolvePolicyFamily(opts: { providerType: LLMProviderType | string; modelId: string }): {
  providerFamily: OutputBudgetProviderFamily;
  routedFamily: Exclude<OutputBudgetProviderFamily, "openrouter"> | null;
} {
  const providerType = String(opts.providerType || "")
    .toLowerCase()
    .trim();
  const modelId = String(opts.modelId || "")
    .toLowerCase()
    .trim();

  if (providerType === "anthropic") {
    return { providerFamily: "anthropic", routedFamily: "anthropic" };
  }
  if (providerType === "bedrock" && (modelId.includes("claude") || modelId.includes("anthropic"))) {
    return { providerFamily: "bedrock-claude", routedFamily: "anthropic" };
  }
  if (providerType === "openai") {
    return { providerFamily: "openai", routedFamily: "openai" };
  }
  if (providerType === "azure") {
    return { providerFamily: "azure-openai", routedFamily: "openai" };
  }
  if (providerType === "gemini") {
    return { providerFamily: "gemini", routedFamily: "gemini" };
  }
  if (providerType === "openrouter") {
    return {
      providerFamily: "openrouter",
      routedFamily: inferOpenRouterRoutedFamily(modelId),
    };
  }

  return { providerFamily: "generic", routedFamily: null };
}

function estimateContextLimit(
  contextManager: ContextManager | null | undefined,
  messages: LLMMessage[],
  system: string,
): number | null {
  const manager = contextManager as Any;
  if (manager && typeof manager.estimateMaxOutputTokens === "function") {
    const estimated = normalizePositiveInteger(manager.estimateMaxOutputTokens(messages, system));
    if (estimated !== null) return estimated;
  }

  const modelLimit = normalizePositiveInteger(
    manager && typeof manager.getModelTokenLimit === "function"
      ? manager.getModelTokenLimit()
      : null,
  );
  if (modelLimit === null) return null;

  const remaining = modelLimit - estimateTotalTokens(messages, system);
  return Math.max(1, remaining);
}

function getKnownHardCap(
  providerFamily: OutputBudgetProviderFamily,
  routedFamily: Exclude<OutputBudgetProviderFamily, "openrouter"> | null,
  modelId: string,
): number | null {
  const normalized = String(modelId || "").toLowerCase();
  const patterns =
    providerFamily === "bedrock-claude"
      ? BEDROCK_CLAUDE_OUTPUT_LIMITS
      : routedFamily === "anthropic" || providerFamily === "anthropic"
        ? ANTHROPIC_OUTPUT_LIMITS
        : [];

  for (const entry of patterns) {
    if (entry.pattern.test(normalized)) {
      return entry.limit;
    }
  }

  return null;
}

function getPolicyDefault(
  requestKind: OutputBudgetRequestKind,
  providerFamily: OutputBudgetProviderFamily,
  routedFamily: Exclude<OutputBudgetProviderFamily, "openrouter"> | null,
  phase: "initial" | "escalated",
): number {
  const initialOverride = readEnvLimit("COWORK_LLM_AGENTIC_INITIAL_MAX_TOKENS");
  const escalatedOverride = readEnvLimit("COWORK_LLM_AGENTIC_ESCALATED_MAX_TOKENS");
  const effectiveFamily = routedFamily ?? providerFamily;

  if (phase === "escalated") {
    if (escalatedOverride !== null) return escalatedOverride;
    if (effectiveFamily === "anthropic") return DEFAULT_ANTHROPIC_ESCALATED_MAX_TOKENS;
    if (effectiveFamily === "generic") return DEFAULT_GENERIC_ESCALATED_MAX_TOKENS;
    return DEFAULT_AGENTIC_ESCALATED_MAX_TOKENS;
  }

  if (requestKind === "tool_followup" || requestKind === "continuation") {
    if (initialOverride !== null) return initialOverride;
    return DEFAULT_TOOL_FOLLOW_UP_INITIAL_MAX_TOKENS;
  }

  if (initialOverride !== null) return initialOverride;
  return DEFAULT_AGENTIC_INITIAL_MAX_TOKENS;
}

function stripThinkingBlocks(text: string): string {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .trim();
}

export function getOutputTokenPolicyMode(): OutputTokenPolicyMode {
  const normalized = String(process.env.COWORK_LLM_OUTPUT_POLICY || "legacy")
    .trim()
    .toLowerCase();
  return normalized === "adaptive" ? "adaptive" : "legacy";
}

export function isAdaptiveOutputTokenPolicyEnabled(): boolean {
  return getOutputTokenPolicyMode() === "adaptive";
}

export function inferOutputBudgetRequestKind(messages: LLMMessage[]): OutputBudgetRequestKind {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((item: Any) => item?.type === "tool_result")) {
      return "tool_followup";
    }
  }
  return "agentic_main";
}

export function resolveOutputTokenParamName(opts: {
  providerType: LLMProviderType | string;
  modelId: string;
  apiMode?: "chat_completions" | "responses";
}): OutputTokenParamName {
  const providerType = String(opts.providerType || "")
    .toLowerCase()
    .trim();
  const modelId = String(opts.modelId || "")
    .toLowerCase()
    .trim();
  const apiMode = opts.apiMode;

  if (providerType === "gemini") return "max_output_tokens";
  if (providerType === "azure" && apiMode === "responses") return "max_output_tokens";
  if ((providerType === "openai" || providerType === "azure") && apiMode !== "responses") {
    return isOpenAIReasoningModel(modelId) ? "max_completion_tokens" : "max_tokens";
  }
  return "max_tokens";
}

export function resolveOutputTokenBudget(input: OutputTokenPolicyInput): ResolvedOutputTokenBudget {
  const mode = getOutputTokenPolicyMode();
  const { providerFamily, routedFamily } = resolvePolicyFamily({
    providerType: input.providerType,
    modelId: input.modelId,
  });
  const contextLimit = estimateContextLimit(input.contextManager, input.messages, input.system);
  const taskLimit = normalizePositiveInteger(input.taskMaxTokens);
  const envLimit = readEnvLimit("COWORK_LLM_MAX_OUTPUT_TOKENS");
  const policyDefault = getPolicyDefault(
    input.requestKind,
    providerFamily,
    routedFamily,
    input.phase,
  );
  const knownHardCap = getKnownHardCap(providerFamily, routedFamily, input.modelId);

  let requestedBudget = policyDefault;
  let capSource: ResolvedOutputTokenBudget["capSource"] = "policy";
  if (taskLimit !== null) {
    requestedBudget = taskLimit;
    capSource = "task";
  } else if (envLimit !== null) {
    requestedBudget = envLimit;
    capSource = "env";
  }

  let chosenBudget = requestedBudget;
  if (knownHardCap !== null) {
    chosenBudget = Math.min(chosenBudget, knownHardCap);
  }
  if (contextLimit !== null) {
    chosenBudget = Math.min(chosenBudget, contextLimit);
  }

  const finalBudget = Math.max(1, chosenBudget);

  return {
    mode,
    providerFamily,
    routedFamily,
    requestKind: input.requestKind,
    transport: {
      paramName: resolveOutputTokenParamName({
        providerType: input.providerType,
        modelId: input.modelId,
      }),
      value: finalBudget,
    },
    requestedBudget,
    chosenBudget: finalBudget,
    contextLimit,
    taskLimit,
    envLimit,
    policyDefault,
    knownHardCap,
    capSource,
  };
}

export function classifyOutputTruncation(
  content: LLMContent[] | undefined,
): OutputTruncationClassification {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((block: Any) => block?.type === "text" && typeof block?.text === "string")
    .map((block: Any) => String(block.text))
    .join("\n");

  if (!text.trim()) {
    return "reasoning_exhausted";
  }

  return stripThinkingBlocks(text).length > 0 ? "visible_partial_output" : "reasoning_exhausted";
}

export function responseHasToolUse(content: LLMContent[] | undefined): boolean {
  return Array.isArray(content) && content.some((block: Any) => block?.type === "tool_use");
}

export function buildReasoningExhaustedGuidance(): string {
  return (
    "The model spent its output budget on internal reasoning and produced no usable answer. " +
    "Retry with a higher output budget or lower reasoning intensity."
  );
}
