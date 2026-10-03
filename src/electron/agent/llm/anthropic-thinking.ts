import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_EFFORT_ORDER,
  clampAnthropicEffort,
  getAnthropicModelCapabilities,
  type AnthropicEffort,
} from "../../../shared/anthropic-model-capabilities";
import { withReasoningOutputHeadroom } from "./output-token-policy";
import type { LLMMessage, LLMReasoningItem } from "./types";

/**
 * Anthropic extended thinking: request parameters per model, and replay of the
 * thinking blocks a response returned.
 *
 * Thinking blocks travel on the assistant message's `reasoning` items (format
 * "anthropic"), never in `content`, so transcript layers, the UI and other
 * providers never see them. Each item records the block verbatim, its position
 * in the response, the producing provider and model, and two hashes: the request
 * prefix it was produced from (system, tools and every earlier message as sent)
 * and the response's own visible content. A block is replayed only to the same
 * provider and model and only while both hashes still match, which is the check
 * the API applies to thinking blocks ("preserved thinking"): an edited,
 * compacted or truncated history drops the blocks after the edit instead of
 * failing the request. Removing a whole turn before a block also changes its
 * prefix, so blocks are never sent against a history they were not produced in.
 */

export const ANTHROPIC_REASONING_FORMAT = "anthropic" as const;

export type AnthropicThinkingBlockParam =
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam;

export interface AnthropicReasoningData {
  /** Provider type that produced the block (anthropic, azure-anthropic, ...). */
  provider: string;
  block: AnthropicThinkingBlockParam;
  /** Index of the block among the response's thinking, text and tool_use blocks. */
  position: number;
  /** Hash of the request prefix (system, tools, messages) the response answered. */
  prefixHash: string;
  /** Hash of the response's visible content as it is sent back. */
  contentHash: string;
}

// ---- Request parameters -------------------------------------------------------------

export interface AnthropicThinkingPlan {
  thinking?: Anthropic.ThinkingConfigParam;
  outputConfig?: { effort: AnthropicEffort };
  maxTokens: number;
}

/** Thinking budget per effort level for budget-mode models (Claude 4 before 4.6). */
const BUDGET_TOKENS_BY_EFFORT: Record<AnthropicEffort, number> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};
const MIN_THINKING_BUDGET_TOKENS = 1_024;
/** Visible-output room kept next to a thinking budget. */
const MIN_VISIBLE_OUTPUT_TOKENS = 4_096;

function normalizeRequestedEffort(effort: string | undefined | null): string | undefined {
  const normalized = String(effort || "")
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function effortLevel(effort: string): AnthropicEffort | undefined {
  const aliased =
    effort === "ultra" || effort === "extra_high" ? "max" : effort === "minimal" ? "low" : effort;
  return ANTHROPIC_EFFORT_ORDER.includes(aliased as AnthropicEffort)
    ? (aliased as AnthropicEffort)
    : undefined;
}

/**
 * Thinking and effort parameters for one request.
 *
 * - Adaptive models get `thinking: {type: "adaptive"}` explicitly (Opus 4.6-4.8 and
 *   Sonnet 4.6 do not think when it is omitted) unless the user picked "none".
 *   Models that always think reject `{type: "disabled"}`, so "none" omits
 *   `thinking` and sends their lowest effort instead.
 * - Budget-mode models think only when an effort is chosen; the budget follows
 *   the effort, stays below max_tokens, and max_tokens grows by the budget
 *   within the model's output cap.
 * - Effort is sent only at levels the model accepts (clamped down otherwise).
 * - max_tokens includes thinking; small caps get headroom so thinking cannot
 *   consume the whole budget. No sampling parameters or forced tool_choice are
 *   ever sent alongside.
 */
export function planAnthropicThinking(opts: {
  model: string;
  maxTokens: number;
  effort?: string | null;
}): AnthropicThinkingPlan {
  const capabilities = getAnthropicModelCapabilities(opts.model);
  const maxTokens = opts.maxTokens;
  if (!capabilities || capabilities.thinkingMode === "none") return { maxTokens };

  const requested = normalizeRequestedEffort(opts.effort);
  const cap = capabilities.maxOutputTokens;
  const withHeadroom = (effort: string | undefined) =>
    Math.min(cap, Math.max(maxTokens, withReasoningOutputHeadroom(maxTokens, effort)));

  if (capabilities.thinkingMode === "adaptive") {
    if (requested === "none") {
      if (!capabilities.adaptiveDefaultOn) return { maxTokens };
      const lowest = capabilities.efforts[0];
      return {
        ...(lowest ? { outputConfig: { effort: lowest } } : {}),
        maxTokens: withHeadroom(lowest),
      };
    }
    const effort = clampAnthropicEffort(capabilities, requested);
    return {
      thinking: { type: "adaptive" },
      ...(effort ? { outputConfig: { effort } } : {}),
      maxTokens: withHeadroom(effort ?? capabilities.defaultEffort),
    };
  }

  // Budget mode.
  const level = requested && requested !== "none" ? effortLevel(requested) : undefined;
  if (!level) return { maxTokens };
  const effort = clampAnthropicEffort(capabilities, level);
  const outputConfig = effort ? { outputConfig: { effort } } : {};
  const total = Math.min(cap, maxTokens + BUDGET_TOKENS_BY_EFFORT[level]);
  const budget = Math.min(
    BUDGET_TOKENS_BY_EFFORT[level],
    total - Math.min(maxTokens, MIN_VISIBLE_OUTPUT_TOKENS),
  );
  if (budget < MIN_THINKING_BUDGET_TOKENS || budget >= total) {
    return { ...outputConfig, maxTokens };
  }
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    ...outputConfig,
    maxTokens: total,
  };
}

// ---- Replay -------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isThinkingBlock(block: unknown): block is AnthropicThinkingBlockParam {
  const type = (block as { type?: unknown } | null)?.type;
  return type === "thinking" || type === "redacted_thinking";
}

/** The block as the API expects it back: only its own fields, unchanged. */
function toThinkingBlockParam(block: Any): AnthropicThinkingBlockParam | null {
  if (block?.type === "thinking" && typeof block.signature === "string") {
    return {
      type: "thinking",
      thinking: typeof block.thinking === "string" ? block.thinking : "",
      signature: block.signature,
    };
  }
  if (block?.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data };
  }
  return null;
}

/**
 * Seed for the prefix hash: the system prompt and tools as sent, without cache
 * markers. Tool order counts, so a reordered tool list drops earlier blocks
 * rather than risking a rejected request.
 */
export function anthropicThinkingPrefixSeed(
  systemTexts: readonly string[],
  tools: readonly unknown[] | undefined,
): string {
  return sha256(JSON.stringify({ v: 1, system: systemTexts, tools: tools || [] }));
}

function contentHash(content: unknown): string {
  return sha256(JSON.stringify(content ?? null));
}

function anthropicItems(message: LLMMessage, provider: string, model: string) {
  if (message.role !== "assistant" || !Array.isArray(message.reasoning)) return [];
  return message.reasoning.filter((item) => {
    if (item?.format !== ANTHROPIC_REASONING_FORMAT || item.model !== model) return false;
    const data = item.data as Partial<AnthropicReasoningData> | undefined;
    return data?.provider === provider && isThinkingBlock(data.block);
  });
}

export interface AnthropicThinkingReplayResult<T> {
  messages: T[];
  /** Prefix hash after every message, recorded on the response's thinking items. */
  prefixHash: string;
  replayedBlocks: number;
  droppedBlocks: number;
}

/**
 * Insert replayable thinking blocks into converted Anthropic messages.
 * `converted[i]` must be the API form of `messages[i]` (without cache markers).
 */
export function applyAnthropicThinkingReplay<T extends { role: string; content: Any }>(opts: {
  messages: LLMMessage[];
  converted: T[];
  model: string;
  provider: string;
  seed: string;
  replay: boolean;
}): AnthropicThinkingReplayResult<T> {
  let hash = opts.seed;
  let replayedBlocks = 0;
  let droppedBlocks = 0;
  const out: T[] = [];

  opts.converted.forEach((converted, index) => {
    let next = converted;
    const source = opts.messages[index];
    const items = source ? anthropicItems(source, opts.provider, opts.model) : [];
    if (items.length > 0 && Array.isArray(converted.content)) {
      const data = items.map((item) => item.data as AnthropicReasoningData);
      const visibleHash = contentHash(converted.content);
      const valid =
        opts.replay &&
        data.every((entry) => entry.prefixHash === hash && entry.contentHash === visibleHash);
      if (valid) {
        const content = [...converted.content];
        for (const entry of [...data].sort((a, b) => a.position - b.position)) {
          content.splice(Math.min(Math.max(0, entry.position), content.length), 0, entry.block);
        }
        next = { ...converted, content };
        replayedBlocks += data.length;
      } else {
        droppedBlocks += data.length;
      }
    }
    out.push(next);
    hash = sha256(`${hash}\n${JSON.stringify(next)}`);
  });

  return { messages: out, prefixHash: hash, replayedBlocks, droppedBlocks };
}

/**
 * Thinking blocks of a response as reasoning items for the assistant message.
 * `visibleContent` is the API form of the response content the executor stores
 * (text and tool_use blocks), the same form the replay hashes.
 */
export function anthropicReasoningFromResponse(opts: {
  content: readonly unknown[] | undefined;
  visibleContent: unknown;
  model: string;
  provider: string;
  prefixHash: string;
}): LLMReasoningItem[] {
  if (!Array.isArray(opts.content)) return [];
  const visibleHash = contentHash(opts.visibleContent);
  const items: LLMReasoningItem[] = [];
  let position = 0;
  for (const block of opts.content as Any[]) {
    const type = block?.type;
    if (type === "text" || type === "tool_use") {
      position += 1;
      continue;
    }
    const param = toThinkingBlockParam(block);
    if (!param) continue;
    const data: AnthropicReasoningData = {
      provider: opts.provider,
      block: param,
      position,
      prefixHash: opts.prefixHash,
      contentHash: visibleHash,
    };
    items.push({ format: ANTHROPIC_REASONING_FORMAT, model: opts.model, data });
    position += 1;
  }
  return items;
}

/**
 * Budget-mode thinking requires the assistant message answered by the trailing
 * tool results to start with a thinking block. When its blocks could not be
 * replayed (another model, edited history), the request must go without thinking.
 */
export function trailingToolTurnStartsWithThinking(
  messages: ReadonlyArray<{ role: string; content: Any }>,
): boolean {
  const last = messages[messages.length - 1];
  const lastIsToolResults =
    last?.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((block: Any) => block?.type === "tool_result");
  if (!lastIsToolResults) return true;
  const assistant = messages[messages.length - 2];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return true;
  return isThinkingBlock(assistant.content[0]);
}

/**
 * A 400 caused by thinking: "replay" when a replayed block was rejected,
 * "config" when the thinking/effort parameters were. Retrying without both
 * recovers either way.
 */
export function classifyAnthropicThinkingRejection(
  status: number | undefined,
  message: string,
): "replay" | "config" | null {
  if (status !== 400) return null;
  const text = String(message || "");
  if (/signature|redacted_thinking|thinking` block|different conversation/i.test(text)) {
    return "replay";
  }
  if (/thinking|budget_tokens|output_config|effort/i.test(text)) return "config";
  return null;
}
