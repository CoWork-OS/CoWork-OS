import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotConversationProjection } from "../../../shared/bot-lifecycle";
import { BotCollaborationHeader } from "../BotCollaborationHeader";

describe("BotCollaborationHeader", () => {
  it("renders a calm teammate status and keeps details progressive", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "executing",
          error: null,
          resultSummary: undefined,
        },
        botName: "Atlas",
        events: [
          {
            id: "message-1",
            taskId: "atlas-task",
            timestamp: 1_000,
            type: "agent_message",
            schemaVersion: 2,
            payload: {
              messageId: "message-1",
              senderLabel: "Atlas",
              recipientLabel: "Forge",
              message: "Investigate the handoff.",
              deliveryStatus: "delivered",
            },
          },
        ],
      }),
    );

    expect(markup).toContain('data-testid="bot-collaboration-header"');
    expect(markup).toContain('data-bot-state="waiting"');
    expect(markup).toContain("Waiting on a teammate");
    expect(markup).toContain("Messages from");
    expect(markup).toContain("Message delivered to Forge");
    expect(markup).toContain("1 handoff");
    expect(markup).not.toContain("Investigate the handoff.");
    expect(markup).not.toContain("send_agent_message");
  });

  it("surfaces a blocked bot as an actionable attention state", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "blocked",
          error: null,
          resultSummary: undefined,
        },
        botName: "Scribe",
      }),
    );

    expect(markup).toContain("Needs your input");
    expect(markup).toContain("The team is waiting for you");
    expect(markup).toContain('data-testid="bot-collaboration-attention"');
  });

  it("uses the shared waiting projection when the task row is already blocked", () => {
    const conversationProjection: BotConversationProjection = {
      state: "waiting",
      stateLabel: "Waiting on a teammate",
      stateDetail: "A teammate is still working on the delegated brief.",
      activityLabel: "Waiting for Scribe to reply",
      lastActivityAt: 1_000,
      collaborators: ["Scribe"],
      teammates: [],
      collaborationSummary: "Scribe is working",
      handoffs: [],
      attention: null,
      outcome: null,
    };
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "blocked",
          error: null,
          resultSummary: undefined,
        },
        botName: "Atlas",
        conversationProjection,
      }),
    );

    expect(markup).toContain('data-bot-state="waiting"');
    expect(markup).toContain("Waiting on a teammate");
    expect(markup).toContain("Waiting for Scribe to reply");
    expect(markup).not.toContain("Needs your input");
  });

  it("does not list the current bot as one of its collaborators", () => {
    const conversationProjection: BotConversationProjection = {
      state: "working",
      stateLabel: "Working with the team",
      stateDetail: "Working on the latest request",
      activityLabel: "Message delivered to Scribe",
      lastActivityAt: 1_000,
      collaborators: ["Atlas", "Scribe"],
      teammates: [],
      collaborationSummary: "No teammates involved",
      handoffs: [],
      attention: null,
      outcome: null,
    };
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "executing",
          error: null,
          resultSummary: undefined,
        },
        botName: "Atlas",
        conversationProjection,
      }),
    );

    expect(markup).toContain("Messages from");
    expect(markup).toContain(">Scribe</span>");
    expect(markup).not.toContain(">Atlas · Scribe</span>");
  });

  it("offers a direct conversation link for a known teammate", () => {
    const conversationProjection: BotConversationProjection = {
      state: "waiting",
      stateLabel: "Waiting on a teammate",
      stateDetail: "A teammate is still working on the delegated brief.",
      activityLabel: "Waiting for Atlas to reply",
      lastActivityAt: 1_000,
      collaborators: ["Atlas"],
      teammates: [],
      collaborationSummary: "Atlas is working",
      handoffs: [],
      attention: null,
      outcome: null,
    };
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "blocked",
          error: null,
          resultSummary: undefined,
        },
        botName: "Forge",
        conversationProjection,
        botConversations: [{ id: "atlas-conversation", title: "Atlas" }],
        onOpenBotConversation: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Open Atlas conversation"');
    expect(markup).toContain('class="bot-collaboration-team-link"');
  });

  it("shows a partial-result state instead of claiming the team is still waiting", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotCollaborationHeader, {
        task: {
          status: "completed",
          error: null,
          resultSummary: "Partial repository inspection is available.",
        },
        botName: "Atlas",
        events: [
          {
            id: "message-timeout",
            taskId: "atlas-task",
            timestamp: 1_000,
            type: "agent_message",
            schemaVersion: 2,
            payload: {
              messageId: "message-timeout",
              senderLabel: "Atlas",
              recipientLabel: "Forge",
              message: "Inspect the repository.",
              deliveryStatus: "delivered",
              replyStatus: "timed_out",
            },
          },
        ],
      }),
    );

    expect(markup).toContain('data-bot-state="completed"');
    expect(markup).toContain("No reply from Forge; partial result available");
    expect(markup).not.toContain("Waiting on a teammate");
  });
});
