import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
  createBotConversationOptions,
  getConversationActionLabels,
  isBotConversation,
  isBotRecoveryBranch,
  matchesBotConversation,
  selectLatestBotConversation,
  shouldAdoptBotConversation,
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
  it("adopts cross-workspace history only for temporary workspaces", () => {
    expect(shouldAdoptBotConversation(conversation, "__temp_workspace__:session-1")).toBe(true);
    expect(shouldAdoptBotConversation(conversation, "workspace-a")).toBe(false);
    expect(shouldAdoptBotConversation(conversation, "workspace-b")).toBe(false);
  });
  it("recognizes only labeled bot recovery branches", () => {
    expect(
      isBotRecoveryBranch({
        branchFromTaskId: "source-task",
        branchLabel: "Reopened bot conversation",
      }),
    ).toBe(true);
    expect(
      isBotRecoveryBranch({
        branchFromTaskId: "source-task",
        branchLabel: "Repaired bot conversation",
      }),
    ).toBe(true);
    expect(
      isBotRecoveryBranch({ branchFromTaskId: "source-task", branchLabel: "User branch" }),
    ).toBe(false);
    expect(isBotRecoveryBranch({ branchLabel: "Reopened bot conversation" })).toBe(false);
  });
  it("prefers a recovery branch over the preserved source transcript", () => {
    const source = {
      ...conversation,
      id: "source-task",
      createdAt: 100,
      updatedAt: 500,
      resultSummary: "The original bot transcript",
    } as Task;
    const recovery = {
      ...conversation,
      id: "recovery-task",
      createdAt: 200,
      updatedAt: 200,
      branchFromTaskId: source.id,
      branchLabel: "Reopened bot conversation",
      userPrompt: "Resume the Atlas bot conversation.",
    } as Task;

    expect(selectLatestBotConversation([source, recovery], "bot-a")?.id).toBe("recovery-task");
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
