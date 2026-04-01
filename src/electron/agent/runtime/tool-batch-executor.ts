import type { LLMMessage, LLMToolResult } from "../llm/types";
import { assertNormalizedTurnTranscript } from "./turn-transcript-normalizer";

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

    messages.push({
      role: "user",
      content: toolResults,
    });

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
