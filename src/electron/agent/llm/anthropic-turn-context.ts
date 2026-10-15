import { modelIdCandidates } from "../../../shared/model-metadata";
import {
  advanceAnthropicPrefixHash,
  anthropicContentHash,
  anthropicThinkingPrefixSeed,
  applyAnthropicThinkingReplay,
} from "./anthropic-thinking";
import { flattenSystemBlocks, normalizeSystemBlocks } from "./prompt-cache";
import type { LLMMessage, LLMProviderContext, LLMRequest } from "./types";

export const ANTHROPIC_TURN_CONTEXT_BETA = "mid-conversation-system-clear-at-2026-08-21";

// Exact documented families, not a version >= check: Sonnet 5 lacks this feature.
// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
const SUPPORTED_MODELS = new Set([
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

export function supportsAnthropicTurnContext(model: string): boolean {
  return modelIdCandidates(model).some((candidate) => SUPPORTED_MODELS.has(candidate));
}

/** Optional feature failures only; never retry auth, capacity, or unrelated errors. */
export function isAnthropicTurnContextUnsupported(
  status: number | undefined,
  message: string,
): boolean {
  if (![400, 404, 422, 501].includes(status || 0)) return false;
  return /clear_at|mid-conversation[-_ ]system|mid-conversation-system-clear-at-2026-08-21|(?:role|roles)[^\n]{0,100}(?:system|user.*assistant)|system[^\n]{0,100}(?:role|messages array)/i.test(
    message,
  );
}

interface TransportMessage {
  role: string;
  content: Any;
  clear_at?: "next_user_message";
}
type PendingContext = Omit<LLMProviderContext, "contentHash">;

function systemMessage(text: string): TransportMessage {
  return { role: "system", clear_at: "next_user_message", content: [{ type: "text", text }] };
}

/**
 * Keep stable instructions above history; append current operator context after
 * the user/tool results. Store each snapshot on its response, then restore it
 * verbatim before thinking replay. Cleared snapshots must remain in the array:
 * deleting or refreshing them breaks both cache prefixes and signed thinking.
 * Prefix/content guards discard stale snapshots after edits or compaction.
 */
export function prepareAnthropicConversation(opts: {
  request: LLMRequest;
  messages: LLMMessage[];
  converted: TransportMessage[];
  tools: readonly unknown[] | undefined;
  model: string;
  provider: string;
  replay: boolean;
  enableTurnContext: boolean;
}) {
  const blocks = normalizeSystemBlocks(opts.request.system, opts.request.systemBlocks);
  const stable = blocks.filter((block) => block.scope === "session" && block.cacheable);
  const volatile = blocks.filter((block) => !(block.scope === "session" && block.cacheable));
  const enabled =
    opts.enableTurnContext &&
    supportsAnthropicTurnContext(opts.model) &&
    stable.length > 0 &&
    opts.converted.at(-1)?.role === "user";
  const systemRequest = enabled
    ? { system: flattenSystemBlocks(stable), systemBlocks: stable }
    : { system: opts.request.system, systemBlocks: opts.request.systemBlocks };
  const systemTexts = enabled
    ? stable.map((block) => block.text)
    : blocks.map((block) => block.text);
  let usesTurnContext = false;
  const replay = applyAnthropicThinkingReplay({
    messages: opts.messages,
    converted: opts.converted,
    model: opts.model,
    provider: opts.provider,
    seed: anthropicThinkingPrefixSeed(
      systemTexts.length ? systemTexts : [opts.request.system],
      opts.tools,
    ),
    replay: opts.replay,
    beforeMessage: enabled
      ? (source, converted, prefixHash, index) => {
          const context = source.providerContext;
          if (
            source.role !== "assistant" ||
            opts.converted[index - 1]?.role !== "user" ||
            context?.format !== "anthropic-turn-context-v1" ||
            context.provider !== opts.provider ||
            context.model !== opts.model ||
            context.prefixHash !== prefixHash ||
            context.contentHash !== anthropicContentHash(converted.content) ||
            typeof context.text !== "string" ||
            !context.text
          )
            return undefined;
          usesTurnContext = true;
          return systemMessage(context.text);
        }
      : undefined,
  });
  let pendingContext: PendingContext | undefined;
  const currentText = enabled ? flattenSystemBlocks(volatile) : "";
  if (currentText) {
    pendingContext = {
      format: "anthropic-turn-context-v1",
      provider: opts.provider,
      model: opts.model,
      prefixHash: replay.prefixHash,
      text: currentText,
    };
    const context = systemMessage(currentText);
    replay.messages.push(context);
    replay.prefixHash = advanceAnthropicPrefixHash(replay.prefixHash, context);
    usesTurnContext = true;
  }
  return { ...replay, systemRequest, pendingContext, usesTurnContext };
}

export function anthropicContextFromResponse(
  pending: PendingContext | undefined,
  visibleContent: unknown,
): LLMProviderContext | undefined {
  return pending ? { ...pending, contentHash: anthropicContentHash(visibleContent) } : undefined;
}
