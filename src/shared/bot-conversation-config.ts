import type { AgentConfig } from "./types";

/**
 * Normalize the collaboration contract for a persistent bot conversation.
 * User-selected read-only execution modes remain intact, but legacy chat-only
 * values cannot hide the team handoff capability from a bot runtime.
 */
export function normalizeBotConversationAgentConfig(
  config: AgentConfig | undefined,
): AgentConfig | undefined {
  if (!config?.botConversation) return config;

  const next = { ...config };
  if (next.interactionMode?.mode === "chat") {
    next.interactionMode = { mode: "smart" };
  }
  if (!next.conversationMode || next.conversationMode === "chat") {
    next.conversationMode = "hybrid";
  }
  if (!next.executionMode || next.executionMode === "chat") {
    next.executionMode = "execute";
    next.executionModeSource = "strategy";
  } else if (!next.executionModeSource && next.executionMode === "execute") {
    next.executionModeSource = "strategy";
  }

  return next;
}
