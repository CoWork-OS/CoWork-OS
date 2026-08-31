import type { LLMContent, LLMMessage, LLMToolResult, LLMToolUse } from "../llm/types";

export type TurnTranscriptIssueKind =
  | "orphan_tool_result"
  | "missing_tool_result"
  | "duplicate_tool_use"
  | "duplicate_tool_result"
  | "mixed_tool_result_user_message";

export interface TurnTranscriptIssue {
  kind: TurnTranscriptIssueKind;
  messageIndex: number;
  toolUseId?: string;
  detail?: string;
}

export interface NormalizedTurnTranscript {
  messages: LLMMessage[];
  issues: TurnTranscriptIssue[];
  modified: boolean;
}

function isToolUseBlock(block: unknown): block is LLMToolUse {
  return Boolean(
    block && typeof block === "object" && (block as { type?: string }).type === "tool_use",
  );
}

function isToolResultBlock(block: unknown): block is LLMToolResult {
  return Boolean(
    block && typeof block === "object" && (block as { type?: string }).type === "tool_result",
  );
}

function isToolResultOnlyUserMessage(message: LLMMessage | undefined): boolean {
  return Boolean(
    message &&
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => isToolResultBlock(block)),
  );
}

function cloneMessage(message: LLMMessage): LLMMessage {
  return {
    role: message.role,
    content: Array.isArray(message.content)
      ? ([...message.content] as LLMMessage["content"])
      : message.content,
  };
}

function collectAssistantToolUseIds(message: LLMMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content
    .filter((block): block is LLMToolUse => isToolUseBlock(block))
    .map((block) => String(block.id || "").trim())
    .filter(Boolean);
}

function splitUserToolResultMessage(message: LLMMessage): {
  toolResults: LLMToolResult[];
  trailingContent: LLMContent[];
} {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    return { toolResults: [], trailingContent: [] };
  }

  const toolResults: LLMToolResult[] = [];
  const trailingContent: LLMContent[] = [];
  for (const block of message.content) {
    if (isToolResultBlock(block)) {
      toolResults.push(block);
      continue;
    }
    trailingContent.push(block as LLMContent);
  }
  return { toolResults, trailingContent };
}

export function normalizeTurnTranscript(messages: LLMMessage[]): NormalizedTurnTranscript {
  const normalized: LLMMessage[] = [];
  const issues: TurnTranscriptIssue[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;

    const toolUseIds = collectAssistantToolUseIds(message);
    if (toolUseIds.length === 0) {
      if (isToolResultOnlyUserMessage(message)) {
        issues.push({
          kind: "orphan_tool_result",
          messageIndex: index,
          detail: "Standalone tool_result user message omitted from normalized transcript.",
        });
        continue;
      }

      normalized.push(cloneMessage(message));
      continue;
    }

    const expectedToolUseIds = new Set<string>();
    const seenToolUseIds = new Set<string>();
    const assistantMessage = cloneMessage(message);
    if (Array.isArray(assistantMessage.content)) {
      assistantMessage.content = assistantMessage.content.filter((block) => {
        if (!isToolUseBlock(block)) {
          return true;
        }
        const toolUseId = String(block.id || "").trim();
        if (!toolUseId) {
          issues.push({
            kind: "duplicate_tool_use",
            messageIndex: index,
            detail: "Tool use without an id was omitted from normalized transcript.",
          });
          return false;
        }
        if (seenToolUseIds.has(toolUseId)) {
          issues.push({
            kind: "duplicate_tool_use",
            messageIndex: index,
            toolUseId,
            detail: `Duplicate tool_use "${toolUseId}" omitted from normalized transcript.`,
          });
          return false;
        }
        seenToolUseIds.add(toolUseId);
        expectedToolUseIds.add(toolUseId);
        return true;
      }) as LLMMessage["content"];
    }

    const toolResultMessages: LLMMessage[] = [];
    const trailingUserMessages: LLMMessage[] = [];
    const coveredToolUseIds = new Set<string>();
    let cursor = index + 1;

    while (cursor < messages.length) {
      const nextMessage = messages[cursor];
      if (!nextMessage || nextMessage.role !== "user" || !Array.isArray(nextMessage.content)) {
        break;
      }

      const { toolResults, trailingContent } = splitUserToolResultMessage(nextMessage);
      if (toolResults.length === 0) {
        break;
      }

      if (trailingContent.length > 0) {
        issues.push({
          kind: "mixed_tool_result_user_message",
          messageIndex: cursor,
          detail: "Split user tool_result message from trailing user content.",
        });
      }

      const filteredToolResults: LLMToolResult[] = [];
      const seenResultIds = new Set<string>();
      for (const block of toolResults) {
        const toolUseId = String(block.tool_use_id || "").trim();
        if (!toolUseId || !expectedToolUseIds.has(toolUseId)) {
          issues.push({
            kind: "orphan_tool_result",
            messageIndex: cursor,
            toolUseId,
            detail: `Tool result "${toolUseId || "(missing id)"}" omitted from normalized transcript.`,
          });
          continue;
        }
        if (seenResultIds.has(toolUseId)) {
          issues.push({
            kind: "duplicate_tool_result",
            messageIndex: cursor,
            toolUseId,
            detail: `Duplicate tool_result "${toolUseId}" omitted from normalized transcript.`,
          });
          continue;
        }
        seenResultIds.add(toolUseId);
        coveredToolUseIds.add(toolUseId);
        filteredToolResults.push(block);
      }

      if (filteredToolResults.length > 0) {
        toolResultMessages.push({
          role: "user",
          content: filteredToolResults,
        });
      }

      if (trailingContent.length > 0) {
        trailingUserMessages.push({
          role: "user",
          content: trailingContent,
        });
      }

      cursor += 1;
      if (coveredToolUseIds.size >= expectedToolUseIds.size) {
        break;
      }
    }

    const missingIds = Array.from(expectedToolUseIds).filter(
      (toolUseId) => !coveredToolUseIds.has(toolUseId),
    );
    if (missingIds.length > 0) {
      for (const toolUseId of missingIds) {
        issues.push({
          kind: "missing_tool_result",
          messageIndex: index,
          toolUseId,
          detail: `Tool use "${toolUseId}" was missing a matching tool_result.`,
        });
      }
      index = cursor - 1;
      continue;
    }

    if (Array.isArray(assistantMessage.content) && assistantMessage.content.length > 0) {
      normalized.push(assistantMessage);
    }
    normalized.push(...toolResultMessages);
    normalized.push(...trailingUserMessages);
    index = cursor - 1;
  }

  const modified = issues.length > 0 || JSON.stringify(normalized) !== JSON.stringify(messages);

  return {
    messages: normalized,
    issues,
    modified,
  };
}

export function assertNormalizedTurnTranscript(
  messages: LLMMessage[],
  logger?: (message: string) => void,
): LLMMessage[] {
  const normalized = normalizeTurnTranscript(messages);
  if (normalized.issues.length > 0 && logger) {
    for (const issue of normalized.issues) {
      logger(
        `[turn-transcript] ${issue.kind} at message ${issue.messageIndex}` +
          (issue.toolUseId ? ` (${issue.toolUseId})` : "") +
          (issue.detail ? `: ${issue.detail}` : ""),
      );
    }
  }
  return normalized.messages;
}
