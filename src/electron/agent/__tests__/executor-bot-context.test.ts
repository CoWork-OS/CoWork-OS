import { describe, expect, it, vi, type Mock } from "vitest";
import type { AgentConfig, AgentRole } from "../../../shared/types";
import type { BotTeamPromptContext } from "../../agents/bot-team";
import { TaskExecutor } from "../executor";

interface ExecutorProbe {
  task: { id: string; assignedAgentRoleId: string; prompt: string; agentConfig: AgentConfig };
  workspace: { path: string };
  daemon: {
    getAgentRoleById: Mock<() => Partial<AgentRole>>;
    getBotTeamPromptContext: Mock<() => BotTeamPromptContext | undefined>;
  };
  getRoleContextPrompt(): string;
  hasExplicitBotTeamDelegationRequest(context: string): boolean;
}

function executor(teamContext?: BotTeamPromptContext): ExecutorProbe {
  const result = Object.create(TaskExecutor.prototype) as ExecutorProbe;
  result.task = {
    id: "conversation",
    assignedAgentRoleId: "custom-role",
    prompt: "Chat",
    agentConfig: { botConversation: true, botTeamId: "stale-team" },
  };
  result.workspace = { path: "/tmp" };
  result.daemon = {
    getAgentRoleById: vi.fn(() => ({
      id: "custom-role",
      name: "arbitrary-role",
      displayName: "My bot",
      capabilities: [],
      systemPrompt: "My unchanged instructions",
    })),
    getBotTeamPromptContext: vi.fn(() => teamContext),
  };
  return result;
}

describe("bot role prompt authorization", () => {
  it("does not infer membership from a saved team marker", () => {
    const instance = executor();
    const prompt = instance.getRoleContextPrompt();
    expect(prompt).toContain("My unchanged instructions");
    expect(prompt).not.toContain("PERSISTENT BOT TEAM");
    expect(instance.daemon.getBotTeamPromptContext).toHaveBeenCalledWith("conversation");
  });

  it("uses only the daemon's verified members and leadership", () => {
    const instance = executor({
      teamName: "Explicit team",
      isLead: false,
      peers: [{ id: "peer-stable-id", name: "chosen-reviewer", displayName: "Chosen reviewer" }],
    });
    const prompt = instance.getRoleContextPrompt();
    expect(prompt).toContain('bot="peer-stable-id"');
    expect(prompt).not.toContain("As the configured team lead");
    expect(instance.hasExplicitBotTeamDelegationRequest("Ask Chosen reviewer for evidence")).toBe(
      true,
    );
    expect(
      instance.hasExplicitBotTeamDelegationRequest("Ask an unknown colleague for evidence"),
    ).toBe(false);
  });

  it("does not attach team guidance to ordinary role-assigned work", () => {
    const instance = executor({ teamName: "Explicit team", isLead: true, peers: [] });
    instance.task.agentConfig = {};
    expect(instance.getRoleContextPrompt()).not.toContain("PERSISTENT BOT TEAM");
    expect(instance.daemon.getBotTeamPromptContext).not.toHaveBeenCalled();
  });
});
