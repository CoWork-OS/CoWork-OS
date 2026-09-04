import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotsPane, filterBots, getBotHandle, getBotPreview, getBotRelativeTime } from "../BotsPane";

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
  it("derives a stable handle and prefers the latest result preview", () => {
    expect(getBotHandle(bot)).toBe("research-desk");
    expect(getBotPreview(task as Any)).toBe("Onboarding findings are ready");
  });

  it("formats bot activity with compact relative units", () => {
    expect(getBotRelativeTime(10_000, 10_000 + 2 * 60 * 60 * 1000)).toBe("2h");
  });

  it("matches bots by identity, description, or recent task text", () => {
    expect(filterBots([bot], [task as Any], "onboarding")).toEqual([bot]);
    expect(filterBots([bot], [task as Any], "billing")).toEqual([]);
  });

  it("renders the roster row with its handle, preview, and timestamp", () => {
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
    expect(markup).toContain("@research-desk");
    expect(markup).toContain("Onboarding findings are ready");
    expect(markup).toMatch(/class="sidebar-bot-row selected\b/);
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
