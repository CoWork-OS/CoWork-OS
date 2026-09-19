import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
  createBotConversationOptions,
  getConversationActionLabels,
  isBotConversation,
  matchesBotConversation,
} from "../bot-conversations";

describe("bot conversations", () => {
  const conversation = {
    workspaceId: "workspace-a",
    assignedAgentRoleId: "bot-a",
    agentConfig: { botConversation: true },
  } as Task;
  it("distinguishes a bot conversation from ordinary work assigned to the same role", () => {
    expect(isBotConversation(conversation)).toBe(true);
    expect(isBotConversation({ ...conversation, agentConfig: { executionMode: "execute" } })).toBe(
      false,
    );
    expect(isBotConversation(undefined)).toBe(false);
  });
  it("rejects cross-bot and cross-workspace history results from an older runtime", () => {
    expect(matchesBotConversation(conversation, "workspace-a", "bot-a")).toBe(true);
    expect(matchesBotConversation(conversation, "workspace-b", "bot-a")).toBe(false);
    expect(matchesBotConversation(conversation, "workspace-a", "bot-b")).toBe(false);
    expect(
      matchesBotConversation({ ...conversation, source: "side_chat" }, "workspace-a", "bot-a"),
    ).toBe(false);
    expect(
      matchesBotConversation({ ...conversation, agentConfig: {} }, "workspace-a", "bot-a"),
    ).toBe(false);
  });
  it("creates fresh dormant hybrid options without copying task permissions, history, or transient execution state", () => {
    const options = createBotConversationOptions("bot-a");
    expect(options.assignedAgentRoleId).toBe("bot-a");
    expect(options.agentConfig?.botConversation).toBe(true);
    expect(options.executionMode).toBe("execute");
    expect(options.agentConfig?.conversationMode).toBe("hybrid");
    expect(options.agentConfig?.executionMode).toBe("execute");
    expect(options.agentConfig?.executionModeSource).toBe("strategy");
    expect(options).not.toHaveProperty("permissionMode");
    expect(options).not.toHaveProperty("sessionId");
    expect(options.agentConfig).not.toHaveProperty("allowAllTools");
    const second = createBotConversationOptions("bot-a");
    expect(second.agentConfig).not.toBe(options.agentConfig);
  });
  it("keeps standard task actions and gives bot actions an unambiguous scope", () => {
    expect(getConversationActionLabels(false)).toMatchObject({
      menu: "Task actions",
      rename: "Rename task",
      archive: "Archive task",
      fork: "Fork session",
    });
    expect(getConversationActionLabels(true)).toMatchObject({
      menu: "Bot options",
      rename: "Rename conversation",
      archive: "Archive conversation",
      pin: "Pin conversation",
      fork: "Branch conversation",
      copyLink: "Copy conversation link",
    });
  });
});
