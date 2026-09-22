import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BotConversationHistory,
  getBotConversationTitle,
  getBotConversationHistoryStatusLabel,
} from "../BotConversationHistory";

const roleId = "research-role";

function conversation(id: string, updatedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Conversation ${id}`,
    prompt: "Start chatting with Research Desk.",
    status: "completed",
    workspaceId: "workspace-a",
    assignedAgentRoleId: roleId,
    agentConfig: { botConversation: true },
    createdAt: updatedAt - 1,
    updatedAt,
    ...overrides,
  } as Any;
}

describe("BotConversationHistory", () => {
  it("uses real prompts for generic bot titles and preserves recovery context", () => {
    expect(
      getBotConversationTitle(
        conversation("prompt", 3_000, {
          title: "Research Desk",
          userPrompt: "Inspect the package metadata and report the version.",
        }),
        0,
        "Research Desk",
      ),
    ).toBe("Inspect the package metadata and report the version.");
    expect(
      getBotConversationTitle(
        conversation("custom", 2_000, {
          title: "Release verification",
          userPrompt: "Inspect the package metadata.",
        }),
        1,
        "Research Desk",
      ),
    ).toBe("Release verification");
    expect(
      getBotConversationTitle(
        conversation("recovery", 1_000, {
          title: "Research Desk",
          prompt: "Resume the Research Desk bot conversation. Internal recovery context follows.",
          branchLabel: "Reopened bot conversation",
        }),
        2,
        "Research Desk",
      ),
    ).toBe("Reopened conversation");
  });

  it("uses human-readable readiness labels for non-terminal conversation states", () => {
    expect(getBotConversationHistoryStatusLabel({ status: "pending", error: null })).toBe(
      "Ready for another message",
    );
    expect(
      getBotConversationHistoryStatusLabel({
        status: "blocked",
        error: "Waiting for Scribe to reply before finishing this conversation.",
      }),
    ).toBe("Waiting on a teammate");
    expect(getBotConversationHistoryStatusLabel({ status: "cancelled", error: null })).toBe(
      "Unavailable — reopen to retry",
    );
    expect(
      getBotConversationHistoryStatusLabel(
        { status: "completed", error: null },
        {
          state: "waiting",
        },
      ),
    ).toBe("Waiting on a teammate");
  });

  it("renders current, archived, and unrelated conversations in one bot screen", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotConversationHistory, {
        botName: "Research Desk",
        botRoleId: roleId,
        selectedConversationId: "current",
        conversations: [
          conversation("archived", 3_000, { sessionArchived: true }),
          conversation("current", 2_000),
          conversation("other-bot", 4_000, { assignedAgentRoleId: "other-role" }),
        ],
        onSelectConversation: () => {},
        onNewConversation: () => {},
      }),
    );

    // The heading no longer repeats the bot name — the header directly above
    // the card already shows it — so the bot is identified by the label.
    expect(markup).toContain('aria-label="Research Desk conversation history"');
    expect(markup).toContain("Conversation history");
    expect(markup).toContain("Archived");
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("bot-conversation-new-button");
    // Only the two conversations for this bot are counted.
    expect(markup).toContain('class="bot-conversation-history-count">2<');
    expect(markup).not.toContain("other-bot");
  });

  it("uses the selected durable projection for the current history row", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotConversationHistory, {
        botName: "Research Desk",
        botRoleId: roleId,
        selectedConversationId: "current",
        selectedConversationProjection: { state: "waiting" },
        conversations: [conversation("current", 2_000)],
      }),
    );

    expect(markup).toContain("Waiting on a teammate");
    expect(markup).not.toContain(">Completed<");
  });
});
