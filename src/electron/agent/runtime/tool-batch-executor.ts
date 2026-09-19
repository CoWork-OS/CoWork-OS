import type { LLMMessage, LLMToolResult } from "../llm/types";
import { assertNormalizedTurnTranscript } from "./turn-transcript-normalizer";

function getLatestAssistantToolUseIds(messages: LLMMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    const ids = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => (block.type === "tool_use" ? String(block.id || "").trim() : ""))
      .filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return [];
}

function orderToolResultsByToolUseIds(
  toolUseIds: readonly string[],
  toolResults: readonly LLMToolResult[],
): LLMToolResult[] {
  if (toolResults.length < 2 || toolUseIds.length === 0) return [...toolResults];

  const orderByToolUseId = new Map<string, number>();
  for (let index = 0; index < toolUseIds.length; index += 1) {
    const toolUseId = String(toolUseIds[index] || "").trim();
    if (toolUseId && !orderByToolUseId.has(toolUseId)) {
      orderByToolUseId.set(toolUseId, index);
    }
  }

  return toolResults
    .map((toolResult, originalIndex) => ({
      toolResult,
      originalIndex,
      order: orderByToolUseId.get(String(toolResult.tool_use_id || "").trim()),
    }))
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
      const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
      return leftOrder - rightOrder || left.originalIndex - right.originalIndex;
    })
    .map(({ toolResult }) => toolResult);
}

export interface ToolBatchExecutionResult {
  mode: "none" | "parallel" | "serial";
  toolResults: LLMToolResult[];
  skippedToolCallsByPolicy: number;
  metadata?: Record<string, unknown>;
}

export interface ToolBatchExecutorParams {
  tryParallel: () => Promise<ToolBatchExecutionResult | null>;
  runSerial: () => Promise<ToolBatchExecutionResult>;
}

export class ToolBatchExecutor {
  async execute(params: ToolBatchExecutorParams): Promise<ToolBatchExecutionResult> {
    const parallelResult = await params.tryParallel();
    if (parallelResult) {
      return parallelResult;
    }
    return params.runSerial();
  }

  appendOrderedToolResults(
    messages: LLMMessage[],
    toolResults: LLMToolResult[],
    trailingUserMessage?: string,
  ): LLMMessage[] {
    if (!Array.isArray(toolResults) || toolResults.length === 0) {
      return messages;
    }

    const orderedToolResults = orderToolResultsByToolUseIds(
      getLatestAssistantToolUseIds(messages),
      toolResults,
    );

    messages.push({
      role: "user",
      content: orderedToolResults,
    });

    const latestCompanionContent =
      [...orderedToolResults]
        .reverse()
        .find(
          (toolResult) =>
            Array.isArray(toolResult.companion_user_content) &&
            toolResult.companion_user_content.length > 0,
        )?.companion_user_content || null;

    if (latestCompanionContent) {
      messages.push({
        role: "user",
        content: latestCompanionContent,
      });
    }

    if (typeof trailingUserMessage === "string" && trailingUserMessage.trim().length > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: trailingUserMessage.trim() }],
      });
    }

    const normalizedMessages = assertNormalizedTurnTranscript(messages);
    if (normalizedMessages !== messages) {
      messages.splice(0, messages.length, ...normalizedMessages);
    }
    return messages;
  }
}
