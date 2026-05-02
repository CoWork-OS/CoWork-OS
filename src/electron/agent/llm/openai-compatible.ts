import {
  LLMContent,
  LLMImageContent,
  LLMMessage,
  LLMResponse,
  LLMSystemBlock,
  LLMTool,
  LLMToolResult,
} from "./types";
import { createHash } from "node:crypto";
import { imageToTextFallback } from "./image-utils";
import { createLogger } from "../../utils/logger";
import { assertNormalizedTurnTranscript } from "../runtime/turn-transcript-normalizer";
import {
  extractOpenAICompatibleCacheUsage,
  splitSystemBlocksForOpenAIPrefix,
} from "./prompt-cache";

const logger = createLogger("openai-compat");

export interface OpenAICompatibleMessageOptions {
  /** Set to false to replace image blocks with text fallback (default: false) */
  supportsImages?: boolean;
  systemBlocks?: LLMSystemBlock[];
  /** Provider-specific maximum for tool call IDs. Matching tool results are rewritten consistently. */
  maxToolCallIdLength?: number;
}

function hashToolCallId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export function createToolCallIdMapper(maxLength?: number): (id: string) => string {
  if (!maxLength || maxLength < 1) {
    return (id) => id;
  }

  const byOriginal = new Map<string, string>();
  const used = new Set<string>();

  return (id: string): string => {
    const existing = byOriginal.get(id);
    if (existing) return existing;

    if (id.length <= maxLength && !used.has(id)) {
      byOriginal.set(id, id);
      used.add(id);
      return id;
    }

    const prefix = "call_az_";
    const hash = hashToolCallId(id);
    const hashBudget = Math.max(1, maxLength - prefix.length);
    let mapped = `${prefix}${hash.slice(0, hashBudget)}`;
    let suffix = 1;

    while (used.has(mapped)) {
      const suffixText = `_${suffix++}`;
      const baseBudget = Math.max(1, maxLength - prefix.length - suffixText.length);
      mapped = `${prefix}${hash.slice(0, baseBudget)}${suffixText}`;
    }

    byOriginal.set(id, mapped);
    used.add(mapped);
    return mapped;
  };
}

export function sanitizeToolCallHistory(messages: LLMMessage[]): LLMMessage[] {
  return assertNormalizedTurnTranscript(messages, (message) => logger.warn(message));
}

export function buildOpenAICompatibleSystemMessages(
  system?: string,
  systemBlocks?: LLMSystemBlock[],
): Array<{ role: "system"; content: string }> {
  const { stableText, volatileText } = splitSystemBlocksForOpenAIPrefix(system || "", systemBlocks);
  const result: Array<{ role: "system"; content: string }> = [];
  if (stableText) {
    result.push({ role: "system", content: stableText });
  }
  if (volatileText) {
    result.push({ role: "system", content: volatileText });
  }
  return result;
}

export function toOpenAICompatibleMessages(
  messages: LLMMessage[],
  system?: string,
  options?: OpenAICompatibleMessageOptions,
): Array<{ role: string; content: Any; tool_call_id?: string; tool_calls?: Any[] }> {
  const sanitizedMessages = sanitizeToolCallHistory(messages);
  const result: Array<{ role: string; content: Any; tool_call_id?: string; tool_calls?: Any[] }> =
    [];
  const supportsImages = options?.supportsImages === true;
  const mapToolCallId = createToolCallIdMapper(options?.maxToolCallIdLength);

  result.push(...buildOpenAICompatibleSystemMessages(system, options?.systemBlocks));

  for (const msg of sanitizedMessages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      continue;
    }

    const imageBlocks: LLMImageContent[] = [];
    const textParts: string[] = [];
    const toolCalls: Any[] = [];
    const shouldInlineImages = supportsImages && msg.role === "user";

    for (const item of msg.content) {
      if (item.type === "tool_result") {
        // OpenAI/Azure require: tool messages must follow an assistant message with tool_calls.
        // After compaction, we can end up with orphaned tool_result (e.g. pinned message
        // between assistant and user, or compaction edge case). Skip orphaned tool results
        // to avoid "messages with role 'tool' must be a response to a preceding message
        // with 'tool_calls'" API errors.
        const last = result[result.length - 1];
        const lastHasToolCalls =
          last?.role === "assistant" && Array.isArray((last as Any).tool_calls);
        const lastIsTool = last?.role === "tool";
        if (lastHasToolCalls || lastIsTool) {
          result.push({
            role: "tool",
            content: item.content,
            tool_call_id: mapToolCallId(item.tool_use_id),
          });
        }
      } else if (item.type === "tool_use") {
        toolCalls.push({
          id: mapToolCallId(item.id),
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        });
      } else if (item.type === "text") {
        textParts.push(item.text);
      } else if (item.type === "image") {
        if (shouldInlineImages) {
          imageBlocks.push(item);
        } else {
          textParts.push(imageToTextFallback(item));
        }
      }
    }

    if (msg.role === "assistant" && toolCalls.length > 0) {
      const assistantContent = textParts.length > 0 ? textParts.join("\n") : null;
      result.push({
        role: msg.role,
        content: assistantContent,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (imageBlocks.length > 0) {
      const contentParts: Any[] = [];
      if (textParts.length > 0) {
        contentParts.push({ type: "text", text: textParts.join("\n") });
      }
      for (const img of imageBlocks) {
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        });
      }
      result.push({ role: msg.role, content: contentParts });
      continue;
    }

    if (textParts.length > 0) {
      result.push({ role: msg.role, content: textParts.join("\n") });
    }
  }

  // Post-processing: remove assistant messages with tool_calls that don't have complete
  // tool responses. This prevents the Azure error: "An assistant message with 'tool_calls'
  // must be followed by tool messages responding to each 'tool_call_id'."
  const cleaned: typeof result = [];
  let i = 0;
  while (i < result.length) {
    const msg = result[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const toolCallIds: string[] = msg.tool_calls.map((tc: Any) => tc.id);
      // Collect all immediately following tool messages
      const toolMessages: typeof result = [];
      let j = i + 1;
      while (j < result.length && result[j].role === "tool") {
        toolMessages.push(result[j]);
        j++;
      }
      const expectedIds = new Set(toolCallIds);
      const matchedToolMessages = toolMessages.filter(
        (tm) => tm.tool_call_id != null && expectedIds.has(tm.tool_call_id),
      );
      const unexpectedToolMessages = toolMessages.filter(
        (tm) => tm.tool_call_id == null || !expectedIds.has(tm.tool_call_id),
      );
      const coveredIds = new Set(matchedToolMessages.map((tm) => tm.tool_call_id));
      const allCovered = toolCallIds.every((id) => coveredIds.has(id));
      if (allCovered) {
        if (unexpectedToolMessages.length > 0) {
          logger.warn(
            `Dropping orphaned tool messages with unexpected tool_call_ids: ${unexpectedToolMessages
              .map((tm) => String(tm.tool_call_id || ""))
              .join(", ")}`,
          );
        }
        cleaned.push(msg, ...matchedToolMessages);
      } else {
        const missing = toolCallIds.filter((id) => !coveredIds.has(id));
        logger.warn(
          `Dropping assistant tool_calls message with uncovered tool_call_ids: ${missing.join(", ")}`,
        );
      }
      i = j;
    } else if (msg.role === "tool") {
      logger.warn(
        `Dropping standalone orphaned tool message with tool_call_id: ${String(
          msg.tool_call_id || "",
        )}`,
      );
      i++;
    } else {
      cleaned.push(msg);
      i++;
    }
  }

  return cleaned;
}

export function toOpenAICompatibleTools(tools: LLMTool[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Any;
  };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export function fromOpenAICompatibleResponse(response: Any): LLMResponse {
  const content: LLMContent[] = [];
  const choice = response.choices?.[0];

  if (!choice) {
    return {
      content: [{ type: "text", text: "" }],
      stopReason: "end_turn",
    };
  }

  const message = choice.message;

  if (message?.content) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type === "function") {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || "{}"),
        });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    content,
    stopReason: mapStopReason(choice.finish_reason),
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens || 0,
          outputTokens: response.usage.completion_tokens || 0,
          ...extractOpenAICompatibleCacheUsage(response.usage),
        }
      : undefined,
  };
}

export function mapStopReason(finishReason?: string): LLMResponse["stopReason"] {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
