import { LLMMessage, LLMContent, LLMToolResult } from './llm';

/**
 * Context Manager handles conversation history to prevent "input too long" errors
 * Manages context through compaction and truncation
 */

// Approximate token limits for different models
const MODEL_LIMITS: Record<string, number> = {
  'opus-4-5': 200000,
  'sonnet-4': 200000,
  'sonnet-3-5': 200000,
  'haiku-3-5': 200000,
  default: 100000,
};

// Reserve tokens for system prompt and response
const RESERVED_TOKENS = 8000;

// Maximum tokens for a single tool result
const MAX_TOOL_RESULT_TOKENS = 10000;

// Maximum characters per tool result (rough estimate: 4 chars ≈ 1 token)
const MAX_TOOL_RESULT_CHARS = MAX_TOOL_RESULT_TOKENS * 4;

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
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + 10; // Add overhead for role, etc.
  }

  let tokens = 10; // Base overhead
  for (const content of message.content) {
    if (content.type === 'text') {
      tokens += estimateTokens(content.text);
    } else if (content.type === 'tool_use') {
      tokens += estimateTokens(content.name) + estimateTokens(JSON.stringify(content.input));
    } else if (content.type === 'tool_result') {
      tokens += estimateTokens(content.content);
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
  return truncated + '\n\n[... content truncated due to length ...]';
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
    if (parsed.content && typeof parsed.content === 'string') {
      parsed.content = truncateToTokens(parsed.content, MAX_TOOL_RESULT_TOKENS / 2);
      return JSON.stringify(parsed, null, 2);
    }
  }

  // Plain text truncation
  return truncateToTokens(result, MAX_TOOL_RESULT_TOKENS);
}

/**
 * Context Manager class
 */
export class ContextManager {
  private modelKey: string;
  private maxTokens: number;

  constructor(modelKey: string = 'default') {
    this.modelKey = modelKey;
    this.maxTokens = MODEL_LIMITS[modelKey] || MODEL_LIMITS.default;
  }

  /**
   * Get available tokens for messages (after reserving for system and response)
   */
  getAvailableTokens(systemPromptTokens: number = 0): number {
    return this.maxTokens - RESERVED_TOKENS - systemPromptTokens;
  }

  /**
   * Compact messages to fit within token limit
   * Preserves recent messages and summarizes older ones
   */
  compactMessages(
    messages: LLMMessage[],
    systemPromptTokens: number = 0
  ): LLMMessage[] {
    const availableTokens = this.getAvailableTokens(systemPromptTokens);
    let currentTokens = estimateTotalTokens(messages);

    // If we're within limits, return as-is
    if (currentTokens <= availableTokens) {
      return messages;
    }

    console.log(`Context too large (${currentTokens} tokens), compacting...`);

    // Strategy 1: Truncate large tool results
    const truncatedMessages = this.truncateLargeResults(messages);
    currentTokens = estimateTotalTokens(truncatedMessages);

    if (currentTokens <= availableTokens) {
      console.log(`After truncating tool results: ${currentTokens} tokens`);
      return truncatedMessages;
    }

    // Strategy 2: Remove older message pairs (keep first and recent)
    const compactedMessages = this.removeOlderMessages(truncatedMessages, availableTokens);
    currentTokens = estimateTotalTokens(compactedMessages);

    console.log(`After compaction: ${currentTokens} tokens, ${compactedMessages.length} messages`);
    return compactedMessages;
  }

  /**
   * Truncate large tool results in messages
   */
  private truncateLargeResults(messages: LLMMessage[]): LLMMessage[] {
    return messages.map(msg => {
      if (typeof msg.content === 'string') return msg;

      // Check if this message has tool results
      const hasToolResults = msg.content.some(c => c.type === 'tool_result');
      if (!hasToolResults) return msg;

      // Truncate tool results
      const newContent = msg.content.map(content => {
        if (content.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: content.tool_use_id,
            content: truncateToolResult(content.content),
            ...(content.is_error ? { is_error: content.is_error } : {}),
          };
        }
        return content;
      }) as LLMMessage['content'];

      return { ...msg, content: newContent };
    });
  }

  /**
   * Remove older messages while preserving conversation flow
   */
  private removeOlderMessages(messages: LLMMessage[], targetTokens: number): LLMMessage[] {
    if (messages.length <= 2) return messages;

    // Keep first message (task context) and work backwards from end
    const result: LLMMessage[] = [];
    let currentTokens = 0;

    // Always keep the first message (original task)
    const firstMsg = messages[0];
    const firstMsgTokens = estimateMessageTokens(firstMsg);
    result.push(firstMsg);
    currentTokens += firstMsgTokens;

    // Add messages from the end until we hit the limit
    const recentMessages: LLMMessage[] = [];
    for (let i = messages.length - 1; i > 0; i--) {
      const msg = messages[i];
      const msgTokens = estimateMessageTokens(msg);

      if (currentTokens + msgTokens > targetTokens) {
        break;
      }

      recentMessages.unshift(msg);
      currentTokens += msgTokens;
    }

    // If we removed messages, add a summary placeholder
    const removedCount = messages.length - 1 - recentMessages.length;
    if (removedCount > 0) {
      result.push({
        role: 'user',
        content: `[Previous ${removedCount} conversation turns summarized: The assistant has been working on the task, executing tools and making progress. Continue from where we left off.]`,
      });
    }

    result.push(...recentMessages);
    return result;
  }

  /**
   * Check if adding a message would exceed limits
   */
  wouldExceedLimit(
    currentMessages: LLMMessage[],
    newMessage: LLMMessage,
    systemPromptTokens: number = 0
  ): boolean {
    const currentTokens = estimateTotalTokens(currentMessages);
    const newTokens = estimateMessageTokens(newMessage);
    const availableTokens = this.getAvailableTokens(systemPromptTokens);

    return currentTokens + newTokens > availableTokens;
  }
}
