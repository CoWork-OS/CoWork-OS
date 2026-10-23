import { describe, expect, it } from "vitest";
import {
  BOT_CONTAINED_ACCESS_CEILING,
  botWorkspaceId,
  isBotWorkspaceId,
  normalizeBotFileAccess,
  shouldContainBotRun,
} from "../bot-containment";
import {
  accessCeilingsOf,
  inheritableAccessCeilings,
  resolveAccessProfileDefinitionWithStatus,
} from "../access-profiles";

const botTask = { assignedAgentRoleId: "bot-1" };

describe("which bot runs move into the bot's own folder", () => {
  it("contains a run nobody typed: heartbeat, schedule, hook, bot-to-bot", () => {
    expect(shouldContainBotRun([botTask], "own_folder")).toBe(true);
  });

  it("leaves a run the person typed in the app where they started it", () => {
    expect(
      shouldContainBotRun([{ ...botTask, promptProvenance: "user_typed" }], "own_folder"),
    ).toBe(false);
  });

  it("follows the person's choice through the tasks it started", () => {
    expect(
      shouldContainBotRun(
        [botTask, { assignedAgentRoleId: "lead-bot" }, { promptProvenance: "user_typed" }],
        "own_folder",
      ),
    ).toBe(false);
  });

  it("contains an owner's message from Slack or another channel", () => {
    for (const agentConfig of [{ gatewayContext: "private" }, { originChannel: "slack" }]) {
      expect(
        shouldContainBotRun(
          [{ ...botTask, promptProvenance: "user_typed", agentConfig }],
          "own_folder",
        ),
      ).toBe(true);
    }
  });

  it("leaves bot chats and team peers in the project they were opened in", () => {
    expect(
      shouldContainBotRun([{ ...botTask, agentConfig: { botConversation: true } }], "own_folder"),
    ).toBe(false);
  });

  it("leaves tasks without their own bot, and bots set to Your workspace", () => {
    expect(shouldContainBotRun([{}], "own_folder")).toBe(false);
    expect(shouldContainBotRun([botTask], "workspace")).toBe(false);
  });

  it("treats a missing or unknown setting as its own folder", () => {
    expect(normalizeBotFileAccess(undefined)).toBe("own_folder");
    expect(normalizeBotFileAccess("anything")).toBe("own_folder");
    expect(normalizeBotFileAccess("workspace")).toBe("workspace");
  });

  it("names bot folder workspaces apart from every other id", () => {
    expect(isBotWorkspaceId(botWorkspaceId("bot-1"))).toBe(true);
    expect(isBotWorkspaceId("__temp_workspace__:ui-1")).toBe(false);
    expect(isBotWorkspaceId(undefined)).toBe(false);
  });
});

describe("the bot's-own-folder access limit", () => {
  it("applies to contained tasks and is inherited by the tasks they start", () => {
    expect(accessCeilingsOf({ botContained: true })).toEqual([BOT_CONTAINED_ACCESS_CEILING.id]);
    expect(inheritableAccessCeilings({ botContained: true })).toEqual([
      BOT_CONTAINED_ACCESS_CEILING.id,
    ]);
    expect(accessCeilingsOf({})).toEqual([]);
  });

  it("resolves by id like a built-in profile", () => {
    const resolved = resolveAccessProfileDefinitionWithStatus(BOT_CONTAINED_ACCESS_CEILING.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.definition?.sandbox).toBe("workspace-write");
  });
});
