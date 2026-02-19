import { LLMMessage, LLMContent, LLMToolResult } from "./llm";
import { estimateImageTokens } from "./llm/image-utils";

/**
 * Context Manager handles conversation history to prevent "input too long" errors
 * Manages context through compaction and truncation
 */

// Approximate token limits for different models
const MODEL_LIMITS: Record<string, number> = {
  "opus-4-5": 200000,
  "sonnet-4-5": 200000,
  "haiku-4-5": 200000,
  "sonnet-4": 200000,
  "sonnet-3-5": 200000,
  "haiku-3-5": 200000,
  // Common OpenAI model ids (conservative; underestimating is safer than overrunning).
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 128000,
  "gpt-4.1-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-3.5-turbo": 16000,
  default: 100000,
};

function inferModelLimit(modelKey: string): number | null {
  const key = modelKey.toLowerCase().trim();
  if (!key) return null;

  // Anthropic raw ids: e.g. "claude-3-5-sonnet-latest"
  if (
    key.startsWith("claude-") ||
    key.includes("sonnet") ||
    key.includes("opus") ||
    key.includes("haiku")
  ) {
    return 200000;
  }

  // Try to parse "8k", "16k", "32k", "128k" patterns.
  const match = key.match(/(^|[^0-9])(\d{1,3})k([^0-9]|$)/);
  if (match) {
    const k = Number(match[2]);
    if (Number.isFinite(k) && k > 0) {
      return k * 1000;
    }
  }

  return null;
}

// Reserve tokens for system prompt and response
const RESERVED_TOKENS = 8000;

// Maximum tokens for a single tool result
const MAX_TOOL_RESULT_TOKENS = 10000;

// Maximum characters per tool result (rough estimate: 4 chars ≈ 1 token)
const MAX_TOOL_RESULT_CHARS = MAX_TOOL_RESULT_TOKENS * 4;

// Messages that begin with one of these tags are treated as "pinned" and should
// survive compaction. (They are system-generated context blocks, not normal chat turns.)
const PINNED_MESSAGE_TAG_PREFIXES = [
  "<cowork_memory_recall>",
  "<cowork_compaction_summary>",
  "<cowork_shared_context>",
] as const;

function messageTextForPinnedCheck(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  // Prefer the first text block if present.
  for (const block of message.content as any[]) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function isPinnedMessage(message: LLMMessage): boolean {
  const text = messageTextForPinnedCheck(message).trimStart();
  if (!text) return false;
  return PINNED_MESSAGE_TAG_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function messageHasToolUse(message: LLMMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block: any) => block?.type === "tool_use");
}

function messageHasToolResult(message: LLMMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block: any) => block?.type === "tool_result");
}

/**
 * Estimate token count from text (rough approximation)
 * LLMs use ~4 characters per token on average for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a message
 */
export function estimateMessageTokens(message: LLMMessage): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content) + 10; // Add overhead for role, etc.
  }

  let tokens = 10; // Base overhead
  for (const content of message.content) {
    if (content.type === "text") {
      tokens += estimateTokens(content.text);
    } else if (content.type === "tool_use") {
      tokens += estimateTokens(content.name) + estimateTokens(JSON.stringify(content.input));
    } else if (content.type === "tool_result") {
      tokens += estimateTokens(content.content);
    } else if (content.type === "image") {
      tokens += estimateImageTokens(content);
    }
  }
  return tokens;
}

/**
 * Estimate total tokens for all messages
 */
export function estimateTotalTokens(messages: LLMMessage[], systemPrompt?: string): number {
  let total = systemPrompt ? estimateTokens(systemPrompt) : 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Truncate a string to fit within token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars - 100);
  return truncated + "\n\n[... content truncated due to length ...]";
}

/**
 * Safely parse JSON, returning null if parsing fails
 */
function safeJsonParse(jsonString: string): any | null {
  try {
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}

/**
 * Truncate tool result content if too large
 */
export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;

  // For JSON results, try to preserve structure
  const parsed = safeJsonParse(result);
  if (parsed !== null) {
    // If it's an array, limit items
    if (Array.isArray(parsed)) {
      const limited = parsed.slice(0, 50);
      const truncatedJson = JSON.stringify(limited, null, 2);
      if (truncatedJson.length <= MAX_TOOL_RESULT_CHARS) {
        return truncatedJson + `\n\n[... showing ${limited.length} of ${parsed.length} items ...]`;
      }
    }

    // If it's an object with content field (like file content), truncate the content
    if (parsed.content && typeof parsed.content === "string") {
      parsed.content = truncateToTokens(parsed.content, MAX_TOOL_RESULT_TOKENS / 2);
      return JSON.stringify(parsed, null, 2);
    }
  }

  // Plain text truncation
  return truncateToTokens(result, MAX_TOOL_RESULT_TOKENS);
}

export type CompactionKind = "none" | "tool_truncation_only" | "message_removal";

export type CompactionMeta = {
  availableTokens: number;
  originalTokens: number;
  truncatedToolResults: {
    didTruncate: boolean;
    count: number;
    tokensAfter: number;
  };
  removedMessages: {
    didRemove: boolean;
    count: number;
    tokensAfter: number;
    messages: LLMMessage[];
  };
  kind: CompactionKind;
};

export type CompactionResult = {
  messages: LLMMessage[];
  meta: CompactionMeta;
};

/**
 * Context Manager class
 */
export class ContextManager {
  private modelKey: string;
  private maxTokens: number;

  constructor(modelKey: string = "default") {
    this.modelKey = modelKey;
    this.maxTokens = MODEL_LIMITS[modelKey] || inferModelLimit(modelKey) || MODEL_LIMITS.default;
  }

  /**
   * Get available tokens for messages (after reserving for system and response)
   */
  getAvailableTokens(systemPromptTokens: number = 0): number {
    return this.maxTokens - RESERVED_TOKENS - systemPromptTokens;
  }

  /**
   * Get the model's estimated total context window.
   */
  getModelTokenLimit(): number {
    return this.maxTokens;
  }

  /**
   * Estimate how many output tokens remain for a request, given current input.
   */
  estimateMaxOutputTokens(messages: LLMMessage[], systemPrompt: string = ""): number {
    const inputTokens = estimateTotalTokens(messages, systemPrompt);
    return Math.max(1, this.maxTokens - inputTokens);
  }

  /**
   * Compact messages to fit within token limit
   * Preserves recent messages and summarizes older ones
   */
  compactMessages(messages: LLMMessage[], systemPromptTokens: number = 0): LLMMessage[] {
    return this.compactMessagesWithMeta(messages, systemPromptTokens).messages;
  }

  compactMessagesWithMeta(
    messages: LLMMessage[],
    systemPromptTokens: number = 0,
  ): CompactionResult {
    const availableTokens = this.getAvailableTokens(systemPromptTokens);
    let currentTokens = estimateTotalTokens(messages);

    // If we're within limits, return as-is
    if (currentTokens <= availableTokens) {
      return {
        messages,
        meta: {
          availableTokens,
          originalTokens: currentTokens,
          truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: currentTokens },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "none",
        },
      };
    }

    console.log(`Context too large (${currentTokens} tokens), compacting...`);

    // Strategy 1: Truncate large tool results
    const truncated = this.truncateLargeResultsWithMeta(messages);
    currentTokens = estimateTotalTokens(truncated.messages);

    if (currentTokens <= availableTokens) {
      console.log(`After truncating tool results: ${currentTokens} tokens`);
      return {
        messages: truncated.messages,
        meta: {
          availableTokens,
          originalTokens: estimateTotalTokens(messages),
          truncatedToolResults: {
            didTruncate: truncated.count > 0,
            count: truncated.count,
            tokensAfter: currentTokens,
          },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "tool_truncation_only",
        },
      };
    }

    // Strategy 2: Remove older message pairs (keep first and recent)
    const removed = this.removeOlderMessagesWithMeta(truncated.messages, availableTokens);
    currentTokens = estimateTotalTokens(removed.messages);

    console.log(`After compaction: ${currentTokens} tokens, ${removed.messages.length} messages`);
    return {
      messages: removed.messages,
      meta: {
        availableTokens,
        originalTokens: estimateTotalTokens(messages),
        truncatedToolResults: {
          didTruncate: truncated.count > 0,
          count: truncated.count,
          tokensAfter: estimateTotalTokens(truncated.messages),
        },
        removedMessages: {
          didRemove: removed.removedMessages.length > 0,
          count: removed.removedMessages.length,
          tokensAfter: currentTokens,
          messages: removed.removedMessages,
        },
        kind: removed.removedMessages.length > 0 ? "message_removal" : "tool_truncation_only",
      },
    };
  }

  /**
   * Truncate large tool results in messages
   */
  private truncateLargeResultsWithMeta(messages: LLMMessage[]): {
    messages: LLMMessage[];
    count: number;
  } {
    let truncatedCount = 0;
    const out = messages.map((msg) => {
      if (typeof msg.content === "string") return msg;

      // Check if this message has tool results
      const hasToolResults = msg.content.some((c) => c.type === "tool_result");
      if (!hasToolResults) return msg;

      // Truncate tool results
      const newContent = msg.content.map((content) => {
        if (content.type === "tool_result") {
          const next = truncateToolResult(content.content);
          if (next !== content.content) truncatedCount += 1;
          return {
            type: "tool_result" as const,
            tool_use_id: content.tool_use_id,
            content: next,
            ...(content.is_error ? { is_error: content.is_error } : {}),
          };
        }
        return content;
      }) as LLMMessage["content"];

      return { ...msg, content: newContent };
    });
    return { messages: out, count: truncatedCount };
  }

  /**
   * Remove older messages while preserving conversation flow
   */
  private removeOlderMessagesWithMeta(
    messages: LLMMessage[],
    targetTokens: number,
  ): { messages: LLMMessage[]; removedMessages: LLMMessage[] } {
    if (messages.length <= 2) return { messages, removedMessages: [] };

    // Keep first message (task context) and work backwards from end
    let currentTokens = 0;
    const keep = new Set<number>();

    // Always keep the first message (original task)
    const firstMsg = messages[0];
    const firstMsgTokens = estimateMessageTokens(firstMsg);
    keep.add(0);
    currentTokens += firstMsgTokens;

    // Always keep pinned messages (system-generated context blocks).
    for (let i = 1; i < messages.length; i++) {
      if (!isPinnedMessage(messages[i])) continue;
      keep.add(i);
      currentTokens += estimateMessageTokens(messages[i]);
    }

    // Add messages from the end until we hit the limit (preserve recency).
    for (let i = messages.length - 1; i > 0; i--) {
      if (keep.has(i)) continue;
      const msg = messages[i];
      const msgTokens = estimateMessageTokens(msg);

      const prevIdx = i - 1;
      const preserveAdjacentToolPair =
        msg.role === "user" &&
        messageHasToolResult(msg) &&
        prevIdx >= 0 &&
        !keep.has(prevIdx) &&
        messages[prevIdx]?.role === "assistant" &&
        messageHasToolUse(messages[prevIdx]);

      if (preserveAdjacentToolPair) {
        const prevTokens = estimateMessageTokens(messages[prevIdx]);
        if (currentTokens + msgTokens + prevTokens > targetTokens) {
          break;
        }
        keep.add(prevIdx);
        keep.add(i);
        currentTokens += msgTokens + prevTokens;
        i = prevIdx;
        continue;
      }

      if (currentTokens + msgTokens > targetTokens) {
        break;
      }

      keep.add(i);
      currentTokens += msgTokens;
    }

    const keptIndices = Array.from(keep).sort((a, b) => a - b);
    const compacted = keptIndices.map((i) => messages[i]);

    const removedMessages: LLMMessage[] = [];
    for (let i = 1; i < messages.length; i++) {
      if (!keep.has(i)) removedMessages.push(messages[i]);
    }

    return { messages: compacted, removedMessages };
  }

  /**
   * Check if adding a message would exceed limits
   */
  wouldExceedLimit(
    currentMessages: LLMMessage[],
    newMessage: LLMMessage,
    systemPromptTokens: number = 0,
  ): boolean {
    const currentTokens = estimateTotalTokens(currentMessages);
    const newTokens = estimateMessageTokens(newMessage);
    const availableTokens = this.getAvailableTokens(systemPromptTokens);

    return currentTokens + newTokens > availableTokens;
  }
}
