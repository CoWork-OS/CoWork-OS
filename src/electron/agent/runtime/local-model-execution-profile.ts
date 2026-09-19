import { createHash } from "node:crypto";
import { estimateMessageTokens, estimateTokens } from "../context-manager";
import type { LLMMessage, LLMTool } from "../llm/types";

export const LOCAL_MODEL_EXECUTION_PROFILE_ID = "local-balanced-v1" as const;
export const LOCAL_MODEL_EXECUTION_PROFILE_VERSION = 1 as const;

export interface LocalModelExecutionProfile {
  id: typeof LOCAL_MODEL_EXECUTION_PROFILE_ID;
  version: typeof LOCAL_MODEL_EXECUTION_PROFILE_VERSION;
  actionOutputTokens: number;
  toolFollowUpOutputTokens: number;
  finalOutputTokens: number;
  typicalToolResultTokens: number;
  injectedToolEvidenceTokens: number;
  memoryTokens: number;
  maxVisibleTools: number;
  maxActiveGenerations: 1;
  safeReadParallelism: number;
  safetyMarginTokens: number;
}

export interface LocalModelExecutionProfileTrace {
  id: typeof LOCAL_MODEL_EXECUTION_PROFILE_ID;
  version: typeof LOCAL_MODEL_EXECUTION_PROFILE_VERSION;
  providerType: string;
  modelId: string;
  resolvedAt: number;
  traceKey: string;
}

export interface LocalModelExecutionProfileResolution {
  profile: LocalModelExecutionProfile | null;
  trace: LocalModelExecutionProfileTrace | null;
}

export const LOCAL_BALANCED_PROFILE: LocalModelExecutionProfile = Object.freeze({
  id: LOCAL_MODEL_EXECUTION_PROFILE_ID,
  version: LOCAL_MODEL_EXECUTION_PROFILE_VERSION,
  actionOutputTokens: 1_536,
  toolFollowUpOutputTokens: 2_048,
  finalOutputTokens: 3_072,
  typicalToolResultTokens: 1_024,
  injectedToolEvidenceTokens: 4_096,
  memoryTokens: 768,
  maxVisibleTools: 10,
  maxActiveGenerations: 1,
  safeReadParallelism: 3,
  safetyMarginTokens: 256,
});

const LOCAL_PROVIDER_TYPES = new Set(["atomic-chat", "ollama", "mlx", "hf-agents"]);

export function isLocalInferenceProvider(providerType: string, baseUrl?: string): boolean {
  const normalizedType = String(providerType || "")
    .trim()
    .toLowerCase();
  try {
    const url = new URL(String(baseUrl || ""));
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]";
    if (LOCAL_PROVIDER_TYPES.has(normalizedType)) return isLoopback;
    if (normalizedType !== "openai-compatible") return false;
    return isLoopback;
  } catch {
    return LOCAL_PROVIDER_TYPES.has(normalizedType) && !baseUrl;
  }
}

function resolveRequestedProfile(requestedProfile?: string): string | undefined {
  const requested = requestedProfile ?? process.env.COWORK_LOCAL_MODEL_PROFILE;
  const normalized = String(requested || "").trim();
  return normalized || undefined;
}

export function resolveLocalModelExecutionProfile(input: {
  providerType: string;
  modelId: string;
  baseUrl?: string;
  requestedProfile?: string;
  now?: number;
}): LocalModelExecutionProfileResolution {
  const requested = resolveRequestedProfile(input.requestedProfile);
  if (
    requested !== LOCAL_MODEL_EXECUTION_PROFILE_ID ||
    !isLocalInferenceProvider(input.providerType, input.baseUrl)
  ) {
    return { profile: null, trace: null };
  }

  const providerType = String(input.providerType || "").trim();
  const modelId = String(input.modelId || "").trim();
  const trace: LocalModelExecutionProfileTrace = {
    id: LOCAL_MODEL_EXECUTION_PROFILE_ID,
    version: LOCAL_MODEL_EXECUTION_PROFILE_VERSION,
    providerType,
    modelId,
    resolvedAt: input.now ?? Date.now(),
    traceKey: `${LOCAL_MODEL_EXECUTION_PROFILE_ID}:${LOCAL_MODEL_EXECUTION_PROFILE_VERSION}:${providerType}:${modelId}`,
  };
  return { profile: LOCAL_BALANCED_PROFILE, trace };
}

export interface LocalRequestTokenBudgetInput {
  systemText?: string;
  tools?: LLMTool[];
  history?: LLMMessage[];
  evidenceTokens?: number;
  attachmentTokens?: number;
  memoryTokens?: number;
  outputTokens?: number;
  safetyMarginTokens?: number;
}

export interface LocalRequestTokenBudget {
  inputTokens: number;
  outputTokens: number;
  safetyMarginTokens: number;
  totalReservedTokens: number;
  components: {
    systemTokens: number;
    toolTokens: number;
    historyTokens: number;
    evidenceTokens: number;
    attachmentTokens: number;
    memoryTokens: number;
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value || 0) < 0) return fallback;
  return Math.floor(value || 0);
}

export function estimateLocalRequestTokenBudget(
  input: LocalRequestTokenBudgetInput,
  profile: LocalModelExecutionProfile = LOCAL_BALANCED_PROFILE,
): LocalRequestTokenBudget {
  const systemTokens = estimateTokens(input.systemText || "");
  const toolTokens = (input.tools || []).reduce(
    (sum, tool) =>
      sum +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.input_schema || {})),
    0,
  );
  const historyTokens = (input.history || []).reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
  const components = {
    systemTokens,
    toolTokens,
    historyTokens,
    evidenceTokens: positiveInteger(input.evidenceTokens, 0),
    attachmentTokens: positiveInteger(input.attachmentTokens, 0),
    memoryTokens: positiveInteger(input.memoryTokens, profile.memoryTokens),
  };
  const inputTokens = Object.values(components).reduce((sum, value) => sum + value, 0);
  const outputTokens = positiveInteger(input.outputTokens, profile.finalOutputTokens);
  const safetyMarginTokens = positiveInteger(input.safetyMarginTokens, profile.safetyMarginTokens);

  return {
    inputTokens,
    outputTokens,
    safetyMarginTokens,
    totalReservedTokens: inputTokens + outputTokens + safetyMarginTokens,
    components,
  };
}

export interface LocalToolSelectionResult {
  tools: LLMTool[];
  toolSetVersion: string;
  droppedToolNames: string[];
}

/**
 * Selects from an already permission-filtered tool list. This helper never
 * grants a tool; callers must provide the visible/allowed set from the normal
 * permission engine first.
 */
export function selectLocalToolSet(input: {
  visibleTools: LLMTool[];
  phase?: string;
  taskDomain?: string;
  requiredToolNames?: string[];
  maxTools?: number;
}): LocalToolSelectionResult {
  const maxTools = Math.max(
    1,
    Math.floor(input.maxTools || LOCAL_BALANCED_PROFILE.maxVisibleTools),
  );
  const required = new Set(input.requiredToolNames || []);
  const phase = String(input.phase || "").toLowerCase();
  const domain = String(input.taskDomain || "").toLowerCase();
  const scored = input.visibleTools.map((tool, index) => {
    const name = tool.name.toLowerCase();
    let score = required.has(tool.name) ? 10_000 : 0;
    if (phase.includes("plan") && /search|list|read|inspect|stat|glob/.test(name)) score += 100;
    if (phase.includes("execute") && /write|edit|move|copy|delete|run|shell/.test(name))
      score += 100;
    if (domain.includes("web") && /browser|web|search|http/.test(name)) score += 50;
    if (domain.includes("code") && /file|shell|git|test|lint/.test(name)) score += 50;
    return { tool, index, score };
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = scored.slice(0, maxTools).sort((left, right) => left.index - right.index);
  const selectedNames = new Set(selected.map((entry) => entry.tool.name));
  const tools = selected.map((entry) => entry.tool);
  const droppedToolNames = input.visibleTools
    .filter((tool) => !selectedNames.has(tool.name))
    .map((tool) => tool.name);
  const schema = tools.map((tool) => ({ name: tool.name, input_schema: tool.input_schema }));
  const toolSetVersion = createHash("sha256")
    .update(JSON.stringify(schema))
    .digest("hex")
    .slice(0, 16);
  return { tools, toolSetVersion, droppedToolNames };
}
