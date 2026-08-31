import { createHash } from "crypto";

import type { LLMProviderType, PromptCachingSettings } from "../../../shared/types";
import { CUSTOM_PROVIDER_MAP } from "../../../shared/llm-provider-catalog";
import type {
  LLMMessage,
  LLMPromptCacheConfig,
  LLMSystemBlock,
  LLMTool,
  PromptCacheProviderFamily,
} from "./types";

const DEFAULT_PROMPT_CACHING_SETTINGS: Required<
  Pick<PromptCachingSettings, "mode" | "ttl" | "openRouterClaudeStrategy" | "strictStablePrefix">
> & {
  surfaceCoverage: {
    executor: boolean;
    followUps: boolean;
    chatMode: boolean;
    sideCalls: boolean;
  };
} = {
  mode: "auto",
  ttl: "5m",
  openRouterClaudeStrategy: "explicit_system_and_3",
  strictStablePrefix: true,
  surfaceCoverage: {
    executor: true,
    followUps: true,
    chatMode: true,
    sideCalls: false,
  },
};

export function normalizePromptCachingSettings(
  settings?: PromptCachingSettings | null,
): typeof DEFAULT_PROMPT_CACHING_SETTINGS {
  return {
    mode: settings?.mode || DEFAULT_PROMPT_CACHING_SETTINGS.mode,
    ttl: settings?.ttl || DEFAULT_PROMPT_CACHING_SETTINGS.ttl,
    openRouterClaudeStrategy:
      settings?.openRouterClaudeStrategy ||
      DEFAULT_PROMPT_CACHING_SETTINGS.openRouterClaudeStrategy,
    strictStablePrefix:
      settings?.strictStablePrefix ?? DEFAULT_PROMPT_CACHING_SETTINGS.strictStablePrefix,
    surfaceCoverage: {
      executor:
        settings?.surfaceCoverage?.executor ??
        DEFAULT_PROMPT_CACHING_SETTINGS.surfaceCoverage.executor,
      followUps:
        settings?.surfaceCoverage?.followUps ??
        DEFAULT_PROMPT_CACHING_SETTINGS.surfaceCoverage.followUps,
      chatMode:
        settings?.surfaceCoverage?.chatMode ??
        DEFAULT_PROMPT_CACHING_SETTINGS.surfaceCoverage.chatMode,
      sideCalls:
        settings?.surfaceCoverage?.sideCalls ??
        DEFAULT_PROMPT_CACHING_SETTINGS.surfaceCoverage.sideCalls,
    },
  };
}

export function hashPromptCacheValue(value: unknown): string {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex");
}

export function buildSystemBlock(
  stableKey: string,
  text: string,
  scope: LLMSystemBlock["scope"],
  cacheable = scope === "session",
): LLMSystemBlock {
  return {
    text: String(text || "").trim(),
    scope,
    cacheable,
    stableKey,
  };
}

export function flattenSystemBlocks(blocks?: LLMSystemBlock[]): string {
  return (blocks || [])
    .map((block) => String(block?.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function areSystemBlocksEquivalent(
  left: LLMSystemBlock[] | undefined,
  right: LLMSystemBlock[] | undefined,
): boolean {
  const lhs = Array.isArray(left) ? left : [];
  const rhs = Array.isArray(right) ? right : [];
  if (lhs.length !== rhs.length) return false;
  for (let i = 0; i < lhs.length; i += 1) {
    if (
      lhs[i]?.stableKey !== rhs[i]?.stableKey ||
      lhs[i]?.text !== rhs[i]?.text ||
      lhs[i]?.scope !== rhs[i]?.scope ||
      lhs[i]?.cacheable !== rhs[i]?.cacheable
    ) {
      return false;
    }
  }
  return true;
}

export function mergeStableSystemBlocks(
  blocks: LLMSystemBlock[],
  stableBlocks: LLMSystemBlock[],
): LLMSystemBlock[] {
  const merged: LLMSystemBlock[] = [];
  let stableIndex = 0;
  for (const block of blocks) {
    if (block.scope === "session" && block.cacheable && stableIndex < stableBlocks.length) {
      merged.push(stableBlocks[stableIndex]);
      stableIndex += 1;
      continue;
    }
    merged.push(block);
  }
  return merged;
}

export function computeToolSchemaHash(
  tools: Pick<LLMTool, "name" | "description" | "input_schema">[],
): string {
  const normalized = [...tools]
    .map((tool) => ({
      name: String(tool?.name || ""),
      description: String(tool?.description || ""),
      input_schema: tool?.input_schema || {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function computeStablePrefixHash(params: {
  providerFamily: PromptCacheProviderFamily;
  modelId: string;
  toolSchemaHash: string;
  executionMode: string;
  taskDomain: string;
  systemBlocks: LLMSystemBlock[];
}): string {
  const modelScope =
    params.providerFamily === "openai" ||
    params.providerFamily === "azure-openai" ||
    params.providerFamily === "openrouter-openai"
      ? "__shared_openai_family__"
      : String(params.modelId || "").trim();

  return createHash("sha256")
    .update(
      JSON.stringify({
        providerFamily: params.providerFamily,
        modelScope,
        toolSchemaHash: params.toolSchemaHash,
        executionMode: params.executionMode,
        taskDomain: params.taskDomain,
        systemBlocks: params.systemBlocks.map((block) => ({
          stableKey: block.stableKey,
          text: block.text,
          scope: block.scope,
          cacheable: block.cacheable,
        })),
      }),
    )
    .digest("hex");
}

export function computePromptCacheKey(params: {
  providerFamily: PromptCacheProviderFamily;
  modelId: string;
  toolSchemaHash: string;
  executionMode: string;
  taskDomain: string;
  systemBlocks: LLMSystemBlock[];
}): string {
  const isOpenAIFamily =
    params.providerFamily === "openai" ||
    params.providerFamily === "azure-openai" ||
    params.providerFamily === "openrouter-openai";

  return createHash("sha256")
    .update(
      JSON.stringify({
        providerFamily: params.providerFamily,
        ...(isOpenAIFamily ? {} : { modelId: String(params.modelId || "").trim() }),
        ...(isOpenAIFamily ? {} : { toolSchemaHash: params.toolSchemaHash }),
        executionMode: params.executionMode,
        taskDomain: params.taskDomain,
        systemBlocks: params.systemBlocks.map((block) => ({
          stableKey: block.stableKey,
          text: block.text,
          scope: block.scope,
          cacheable: block.cacheable,
        })),
      }),
    )
    .digest("hex");
}

function isLikelyOpenAIModelId(modelId: string): boolean {
  const trimmed = String(modelId || "")
    .trim()
    .toLowerCase();
  if (!trimmed) return false;

  const parts = trimmed.split("/");
  const suffix = parts.length > 1 ? parts[parts.length - 1] || trimmed : trimmed;
  return (
    trimmed.startsWith("openai/") ||
    suffix.startsWith("gpt-") ||
    suffix.startsWith("chatgpt-") ||
    suffix.startsWith("codex-") ||
    /^o[1345](?:$|[-_.])/.test(suffix)
  );
}

export function resolvePromptCacheProviderFamily(
  providerType: LLMProviderType,
  modelId: string,
): PromptCacheProviderFamily {
  if (providerType === "openai") return "openai";
  if (providerType === "azure") return "azure-openai";
  if (providerType === "anthropic") return "anthropic";
  if (providerType === "azure-anthropic") return "azure-anthropic";
  if (providerType === "anthropic-compatible") return "anthropic-compatible";
  if (providerType === "openrouter") {
    if (/(?:^|\/)claude|anthropic\/claude/i.test(String(modelId || ""))) {
      return "openrouter-claude";
    }
    return isLikelyOpenAIModelId(modelId) ? "openrouter-openai" : "unsupported";
  }

  const customProvider = CUSTOM_PROVIDER_MAP.get(providerType);
  if (customProvider?.compatibility === "anthropic") {
    return "anthropic-compatible";
  }

  return "unsupported";
}

export function buildAnthropicCacheMarker(ttl: LLMPromptCacheConfig["ttl"]): {
  type: "ephemeral";
  ttl?: "1h";
} {
  if (ttl === "1h") {
    return { type: "ephemeral", ttl: "1h" };
  }
  return { type: "ephemeral" };
}

export function applyAnthropicCacheMarker(
  message: Record<string, Any>,
  cacheMarker: Record<string, Any>,
  nativeAnthropic = false,
): void {
  const role = String(message?.role || "");
  const content = message?.content;

  if (role === "tool") {
    if (nativeAnthropic) {
      message.cache_control = cacheMarker;
    }
    return;
  }

  if (content == null || content === "") {
    message.cache_control = cacheMarker;
    return;
  }

  if (typeof content === "string") {
    message.content = [{ type: "text", text: content, cache_control: cacheMarker }];
    return;
  }

  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (last && typeof last === "object") {
      (last as Record<string, Any>).cache_control = cacheMarker;
    }
  }
}

export function applyAnthropicExplicitCacheControl<T extends Record<string, Any>>(
  apiMessages: T[],
  opts: {
    ttl: LLMPromptCacheConfig["ttl"];
    nativeAnthropic?: boolean;
    includeSystem?: boolean;
    maxBreakpoints?: number;
  },
): T[] {
  const messages = JSON.parse(JSON.stringify(apiMessages || [])) as T[];
  if (messages.length === 0) return messages;

  const marker = buildAnthropicCacheMarker(opts.ttl);
  const includeSystem = opts.includeSystem !== false;
  const maxBreakpoints = Math.max(0, opts.maxBreakpoints ?? 4);
  let used = 0;

  if (includeSystem && messages[0]?.role === "system" && used < maxBreakpoints) {
    applyAnthropicCacheMarker(
      messages[0] as Record<string, Any>,
      marker,
      opts.nativeAnthropic === true,
    );
    used += 1;
  }

  const remaining = Math.max(0, maxBreakpoints - used);
  if (remaining === 0) return messages;

  const nonSystemIndexes = messages
    .map((message, index) => ({ role: String(message?.role || ""), index }))
    .filter((entry) => entry.role !== "system")
    .map((entry) => entry.index);

  for (const index of nonSystemIndexes.slice(-remaining)) {
    applyAnthropicCacheMarker(
      messages[index] as Record<string, Any>,
      marker,
      opts.nativeAnthropic === true,
    );
  }

  return messages;
}

export function extractAnthropicUsage(
  usage: Any,
):
  | { inputTokens: number; outputTokens: number; cachedTokens?: number; cacheWriteTokens?: number }
  | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cachedTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? 0);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    ...(Number.isFinite(cachedTokens) && cachedTokens > 0 ? { cachedTokens } : {}),
    ...(Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

export function extractOpenAICompatibleCacheUsage(usage: Any): {
  cachedTokens?: number;
  cacheWriteTokens?: number;
} {
  if (!usage || typeof usage !== "object") return {};

  const cachedTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      0,
  );
  const cacheWriteTokens = Number(
    usage.prompt_tokens_details?.cache_creation_input_tokens ??
      usage.input_tokens_details?.cache_creation_input_tokens ??
      usage.cache_creation_input_tokens ??
      0,
  );

  return {
    ...(Number.isFinite(cachedTokens) && cachedTokens > 0 ? { cachedTokens } : {}),
    ...(Number.isFinite(cacheWriteTokens) && cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

export function mapPromptCacheTtlToOpenAIRetention(
  ttl: LLMPromptCacheConfig["ttl"],
): LLMPromptCacheConfig["retention"] | undefined {
  return ttl === "1h" ? "24h" : undefined;
}

export function buildOpenAIPromptCacheFields(promptCache?: LLMPromptCacheConfig): {
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
} {
  if (!promptCache || promptCache.mode !== "openai_key") {
    return {};
  }

  const promptCacheKey = String(promptCache.cacheKey || "").trim();
  if (!promptCacheKey) {
    return {};
  }

  return {
    prompt_cache_key: promptCacheKey,
    ...(promptCache.retention ? { prompt_cache_retention: promptCache.retention } : {}),
  };
}

export function buildLegacySystemBlocks(system: string): LLMSystemBlock[] {
  const text = String(system || "").trim();
  if (!text) return [];
  return [buildSystemBlock(`legacy_system:${hashPromptCacheValue(text)}`, text, "session", true)];
}

export function normalizeSystemBlocks(
  system: string,
  systemBlocks?: LLMSystemBlock[],
): LLMSystemBlock[] {
  if (Array.isArray(systemBlocks) && systemBlocks.length > 0) {
    return systemBlocks
      .map((block) => ({
        ...block,
        text: String(block?.text || "").trim(),
      }))
      .filter((block) => block.text.length > 0);
  }
  return buildLegacySystemBlocks(system);
}

export function splitSystemBlocksForOpenAIPrefix(
  system: string,
  systemBlocks?: LLMSystemBlock[],
): {
  allBlocks: LLMSystemBlock[];
  stableText: string;
  volatileText: string;
} {
  const allBlocks = normalizeSystemBlocks(system, systemBlocks);
  const stableBlocks = allBlocks.filter((block) => block.scope === "session" && block.cacheable);
  const volatileBlocks = allBlocks.filter(
    (block) => !(block.scope === "session" && block.cacheable),
  );

  return {
    allBlocks,
    stableText: flattenSystemBlocks(stableBlocks),
    volatileText: flattenSystemBlocks(volatileBlocks),
  };
}

export function convertSystemBlocksToTextParts(
  system: string,
  systemBlocks?: LLMSystemBlock[],
): Array<{
  type: "text";
  text: string;
  cache_control?: ReturnType<typeof buildAnthropicCacheMarker>;
}> {
  return normalizeSystemBlocks(system, systemBlocks).map((block) => ({
    type: "text",
    text: block.text,
  }));
}

export function applyExplicitSystemBlockMarker(
  textParts: Array<{
    type: "text";
    text: string;
    cache_control?: ReturnType<typeof buildAnthropicCacheMarker>;
  }>,
  systemBlocks: LLMSystemBlock[],
  ttl: LLMPromptCacheConfig["ttl"],
): void {
  if (!Array.isArray(textParts) || textParts.length === 0) return;
  const cacheableIndexes = systemBlocks
    .map((block, index) => (block.cacheable ? index : -1))
    .filter((index) => index >= 0);
  const targetIndex =
    cacheableIndexes.length > 0 ? cacheableIndexes[cacheableIndexes.length - 1] : -1;
  if (targetIndex < 0 || !textParts[targetIndex]) return;
  textParts[targetIndex].cache_control = buildAnthropicCacheMarker(ttl);
}

export function isPromptCacheAutoUnsupportedError(
  status: number | undefined,
  message: string,
): boolean {
  const normalizedStatus = Number(status || 0);
  const lower = String(message || "").toLowerCase();
  if (!lower) return false;
  if (!/cache[_\s-]?control|prompt cach|automatic cach|cache breakpoint|ephemeral/.test(lower)) {
    return false;
  }
  return (
    normalizedStatus === 400 ||
    normalizedStatus === 404 ||
    normalizedStatus === 422 ||
    normalizedStatus === 501
  );
}

export function countCacheBreakpoints(messages: LLMMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!message) continue;
    const content = message.content as Any;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "cache_control" in block) {
          count += 1;
        }
      }
    } else if (content && typeof content === "object" && "cache_control" in content) {
      count += 1;
    }
    if ((message as Any).cache_control) count += 1;
  }
  return count;
}
