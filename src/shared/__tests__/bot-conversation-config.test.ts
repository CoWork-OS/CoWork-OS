import { describe, expect, it } from "vitest";
import { normalizeBotConversationAgentConfig } from "../bot-conversation-config";

describe("normalizeBotConversationAgentConfig", () => {
  it("repairs legacy chat-shaped bot configuration", () => {
    expect(
      normalizeBotConversationAgentConfig({
        botConversation: true,
        botTeamId: "team-1",
        conversationMode: "chat",
        executionMode: "chat",
        interactionMode: { mode: "chat" },
      }),
    ).toMatchObject({
      botConversation: true,
      botTeamId: "team-1",
      conversationMode: "hybrid",
      executionMode: "execute",
      executionModeSource: "strategy",
      interactionMode: { mode: "smart" },
    });
  });

  it("preserves a user-selected read-only mode while repairing the chat contract", () => {
    expect(
      normalizeBotConversationAgentConfig({
        botConversation: true,
        conversationMode: "chat",
        executionMode: "plan",
        executionModeSource: "user",
      }),
    ).toMatchObject({
      conversationMode: "hybrid",
      executionMode: "plan",
      executionModeSource: "user",
    });
  });

  it("does not mutate ordinary task configuration", () => {
    const config = { executionMode: "plan" as const, conversationMode: "chat" as const };
    expect(normalizeBotConversationAgentConfig(config)).toBe(config);
  });
});
