import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotsPane,
  filterBots,
  getBotConversationReadiness,
  getBotConversationReadinessLabel,
  getBotHandle,
  getBotLatestTask,
  getBotPreview,
  getBotRelativeTime,
  stripMarkdownForBotPreview,
} from "../BotsPane";

const bot = {
  id: "research-role",
  name: "research desk",
  displayName: "Research Desk",
  description: "Finds and summarizes source material",
  icon: "Search",
  color: "#0ea5e9",
};

const task = {
  id: "task-1",
  title: "Research the onboarding flow",
  prompt: "Research the onboarding flow",
  sidebarPromptPreview: "Review the latest onboarding findings",
  resultSummary: "Onboarding findings are ready",
  status: "completed",
  assignedAgentRoleId: "research-role",
  agentConfig: { botConversation: true },
  workspaceId: "ws-1",
  createdAt: 1_000,
  updatedAt: 2_000,
};

describe("BotsPane", () => {
  it("separates persistent conversation readiness from the last run status", () => {
    expect(getBotConversationReadiness({ status: "completed" } as Any)).toBe("ready");
    expect(getBotConversationReadiness({ status: "executing" } as Any)).toBe("working");
    expect(getBotConversationReadiness({ status: "completed" } as Any, { state: "waiting" })).toBe(
      "waiting",
    );
    expect(getBotConversationReadiness({ status: "blocked" } as Any, { state: "completed" })).toBe(
      "ready",
    );
    expect(
      getBotConversationReadiness({
        status: "blocked",
        error: "Waiting for Atlas to reply before finishing this conversation.",
      } as Any),
    ).toBe("waiting");
    expect(getBotConversationReadiness({ status: "blocked" } as Any)).toBe("attention");
    expect(getBotConversationReadiness({ status: "interrupted" } as Any)).toBe("attention");
    expect(getBotConversationReadiness({ status: "failed" } as Any)).toBe("unavailable");
    expect(getBotConversationReadinessLabel("ready")).toBe("Ready for another message");
    expect(getBotConversationReadinessLabel("waiting")).toBe("Waiting on a teammate");
  });

  it("derives a stable handle and prefers the latest result preview", () => {
    expect(getBotHandle(bot)).toBe("research-desk");
    expect(getBotPreview(task as Any)).toBe("Onboarding findings are ready");
  });

  it("does not show a stale success result for an unavailable conversation", () => {
    expect(
      getBotPreview({
        ...task,
        status: "failed",
        resultSummary: "Verified package.json successfully",
        error: undefined,
      } as Any),
    ).toBe("Conversation unavailable — reopen to retry");
  });

  it("shows the failure reason for an unavailable conversation", () => {
    expect(
      getBotPreview({
        ...task,
        status: "failed",
        resultSummary: "Verified package.json successfully",
        error: "The provider timed out before the teammate reply arrived.",
      } as Any),
    ).toBe("Failed: The provider timed out before the teammate reply arrived.");
  });

  it("uses the pending teammate reply as the waiting-row preview", () => {
    expect(
      getBotPreview({
        ...task,
        status: "blocked",
        resultSummary: "Verified and reported to Atlas",
        error: "Waiting for Atlas to reply before finishing this conversation.",
      } as Any),
    ).toBe("Waiting for Atlas to reply");
  });

  it("shows Markdown previews as plain text without formatting syntax", () => {
    expect(
      getBotPreview({
        ...task,
        resultSummary: "**Focus:** Turn `CoWork OS` forward.",
      } as Any),
    ).toBe("Focus: Turn CoWork OS forward.");
    expect(
      stripMarkdownForBotPreview(
        "**Focus:** Turn `CoWork OS` forward. See [the plan](https://example.com).",
      ),
    ).toBe("Focus: Turn CoWork OS forward. See the plan.");
    expect(stripMarkdownForBotPreview("## Exchange summary ## Key decisions")).toBe(
      "Exchange summary Key decisions",
    );
    expect(stripMarkdownForBotPreview("> **One** result\n- Ship it\n1. Verify it")).toBe(
      "One result Ship it Verify it",
    );
  });

  it("turns a raw agent-message receipt into a human-facing preview", () => {
    expect(
      getBotPreview({
        ...task,
        resultSummary: '{"success":true,"deliveryStatus":"queued","message_id":"message-3"}',
      } as Any),
    ).toBe("Queued for the next turn");
  });

  it("formats bot activity with compact relative units", () => {
    expect(getBotRelativeTime(10_000, 10_000 + 2 * 60 * 60 * 1000)).toBe("2h");
  });

  it("matches bots by identity, description, or recent task text", () => {
    expect(filterBots([bot], [task as Any], "onboarding")).toEqual([bot]);
    expect(filterBots([bot], [task as Any], "billing")).toEqual([]);
  });

  it("renders the roster row with its name, preview, and timestamp", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [bot],
        tasks: [task as Any],
        selectedTaskId: "task-1",
        onSelectTask: () => {},
      }),
    );

    expect(markup).toContain("sidebar-bots-pane");
    expect(markup).toContain("Search bots...");
    expect(markup).toContain("Research Desk");
    expect(markup).not.toContain("sidebar-bot-handle");
    expect(markup).not.toContain("@research-desk");
    expect(markup).toContain('aria-label="Edit Research Desk"');
    expect(markup).toContain("Onboarding findings are ready");
    expect(markup).toMatch(/class="sidebar-bot-row selected\b/);
  });

  it("uses the selected conversation projection for a stale completed roster row", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [bot],
        tasks: [task as Any],
        selectedTaskId: task.id,
        selectedConversationProjection: { state: "waiting" },
        onSelectTask: () => {},
      }),
    );

    expect(markup).toContain("Waiting on a teammate");
    expect(markup).not.toContain("Ready for another message");
  });

  it("uses a durable projection for a non-selected stale completed roster row", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [bot],
        tasks: [task as Any],
        selectedTaskId: null,
        conversationProjections: {
          [bot.id]: { state: "waiting" },
        },
        onSelectTask: () => {},
      }),
    );

    expect(markup).toContain("Waiting on a teammate");
    expect(markup).not.toContain("Ready for another message");
  });

  it("keeps a bot selected for an older bot conversation but ignores normal role tasks", () => {
    const olderConversation = { ...task, id: "older-conversation", updatedAt: 1_500 };
    const newerConversation = { ...task, id: "newer-conversation", updatedAt: 2_500 };
    const normalRoleTask = {
      ...task,
      id: "normal-role-task",
      agentConfig: { botConversation: false },
      updatedAt: 3_500,
    };
    const olderMarkup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [bot],
        tasks: [olderConversation as Any, newerConversation as Any],
        selectedTaskId: "older-conversation",
        onSelectTask: () => {},
      }),
    );
    expect(olderMarkup).toMatch(/class="sidebar-bot-row selected\b/);

    const normalMarkup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [bot],
        tasks: [normalRoleTask as Any],
        selectedTaskId: "normal-role-task",
        onSelectTask: () => {},
      }),
    );
    expect(normalMarkup).not.toMatch(/class="sidebar-bot-row selected\b/);
  });

  it("does not use side chat forks as a bot transcript preview", () => {
    const sideChatTask = {
      ...task,
      id: "side-chat-fork",
      source: "side_chat",
      resultSummary: "Side chat should stay private",
      updatedAt: 9_000,
    };
    expect(getBotPreview(getBotLatestTask([task as Any, sideChatTask as Any], bot.id))).toBe(
      "Onboarding findings are ready",
    );
  });

  it("does not resume an archived bot conversation from the roster", () => {
    const archived = { ...task, id: "archived", updatedAt: 9_000, sessionArchived: true };
    const active = { ...task, id: "active", updatedAt: 2_500, resultSummary: "Active preview" };
    expect(getBotLatestTask([archived as Any, active as Any], bot.id)?.id).toBe("active");
  });

  it("prefers a prior transcript over a newer empty temp-workspace placeholder", () => {
    const priorTranscript = {
      ...task,
      id: "prior-transcript",
      workspaceId: "old-temp-workspace",
      updatedAt: 1_500,
      sidebarPromptPreview: "A real teammate observation",
      resultSummary: undefined,
    };
    const emptyPlaceholder = {
      ...task,
      id: "new-placeholder",
      workspaceId: "new-temp-workspace",
      updatedAt: 9_000,
      sidebarPromptPreview: "Start a conversation with Research Desk.",
      resultSummary: undefined,
      userPrompt: "Start chatting with Research Desk.",
    };
    expect(getBotLatestTask([emptyPlaceholder as Any, priorTranscript as Any], bot.id)?.id).toBe(
      "prior-transcript",
    );
  });

  it("does not expose the dormant bot seed prompt as a conversation preview", () => {
    expect(
      getBotPreview({
        ...task,
        resultSummary: undefined,
        sidebarPromptPreview: "Start a conversation with Research Desk.",
        userPrompt: "Start chatting with Research Desk.",
      } as Any),
    ).toBe("No messages yet");
  });

  it("shows a useful empty state when no bot roles exist", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotsPane, {
        roles: [],
        tasks: [],
        selectedTaskId: null,
        onSelectTask: () => {},
        onBotCreated: () => {},
      }),
    );

    expect(markup).toContain("No bots yet");
    expect(markup).toContain("Create bot");
  });
});
