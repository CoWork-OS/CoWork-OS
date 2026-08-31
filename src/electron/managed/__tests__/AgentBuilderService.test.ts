import { describe, expect, it } from "vitest";

import {
  AgentBuilderService,
  buildFallbackAgentPlan,
  compressAgentBuilderInventory,
  extractFirstJsonObject,
  inferExplicitSchedule,
  type AgentBuilderInventory,
} from "../AgentBuilderService";

const baseInventory: AgentBuilderInventory = {
  templates: [
    {
      id: "research-analyst",
      name: "Research Analyst",
      description: "Research current market context and write a concise brief.",
      icon: "search",
      color: "#1570ef",
      category: "research",
      systemPrompt: "Research and summarize.",
      executionMode: "solo",
      studio: {
        apps: {
          allowedToolFamilies: ["search", "documents"],
        },
      },
    },
  ] as Any,
  skills: [
    {
      id: "market-brief",
      name: "Market Brief",
      description: "Writes market research briefs.",
      icon: "file",
      prompt: "Research.",
      enabled: true,
    },
    {
      id: "disabled-skill",
      name: "Disabled Skill",
      description: "Should not be selected.",
      icon: "x",
      prompt: "Disabled.",
      enabled: false,
    },
  ] as Any,
  pluginPacks: [
    {
      manifest: {
        name: "research-pack",
        displayName: "Research Pack",
        version: "1.0.0",
        description: "Research pack",
        type: "pack",
        recommendedConnectors: ["slack"],
        bestFitWorkflows: ["support_ops"],
        skills: [{ id: "market-brief" }],
      },
    },
  ] as Any,
  mcpServers: [
    {
      id: "slack",
      name: "Slack",
      enabled: true,
      transport: "stdio",
      tools: [{ name: "slack_search", inputSchema: { type: "object" } }],
    },
    {
      id: "gmail",
      name: "Gmail",
      enabled: false,
      transport: "stdio",
    },
  ] as Any,
  channels: [
    {
      id: "channel-1",
      type: "slack",
      name: "#ops",
      enabled: true,
      status: "connected",
      securityMode: "pairing",
      createdAt: 1,
    },
  ] as Any,
  workspaces: [{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any,
  agentRoles: [
    {
      id: "role-1",
      displayName: "Research Operator",
      capabilities: ["research"],
    },
  ] as Any,
};

describe("AgentBuilderService helpers", () => {
  it("compresses inventory without secrets or disabled detail overload", () => {
    const compressed = compressAgentBuilderInventory(baseInventory);

    expect(compressed.templates[0]?.id).toBe("research-analyst");
    expect(compressed.skills.map((skill) => skill.id)).toContain("market-brief");
    expect(compressed.mcpServers[0]).toMatchObject({
      id: "slack",
      enabled: true,
      tools: ["slack_search"],
    });
    expect(compressed.pluginPacks[0]?.recommendedConnectors).toEqual(["slack"]);
  });

  it("extracts strict JSON from fenced or chatty LLM output", () => {
    expect(extractFirstJsonObject('prefix {"name":"Agent","nested":{"ok":true}} suffix')).toEqual({
      name: "Agent",
      nested: { ok: true },
    });
    expect(extractFirstJsonObject('```json\n{"name":"Agent"}\n```')).toEqual({
      name: "Agent",
    });
  });

  it("keeps vague morning wording manual but enables explicit recurrence", () => {
    expect(inferExplicitSchedule("Summarize my priorities in the morning")).toEqual({
      enabled: false,
      mode: "manual",
    });
    expect(inferExplicitSchedule("Send me a brief every morning")).toMatchObject({
      enabled: true,
      mode: "recurring",
      cadenceMinutes: 1440,
    });
  });

  it("builds fallback plans with connected tools enabled and missing auth as checklist items", () => {
    const plan = buildFallbackAgentPlan(
      {
        prompt:
          "Research market updates, summarize Slack discussions, and draft email follow-ups every morning",
        workspaceId: "ws-1",
      },
      baseInventory,
      { now: () => 123, randomId: () => "plan-1" },
    );

    expect(plan.id).toBe("plan-1");
    expect(plan.selectedMcpServers).toContain("slack");
    expect(plan.selectedMcpServers).not.toContain("gmail");
    expect(plan.missingConnections.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["email", "slack-channel"]),
    );
    expect(plan.scheduleConfig.enabled).toBe(true);
    expect(plan.approvalPolicy.autoApproveReadOnly).toBe(true);
    expect(plan.approvalPolicy.requireApprovalFor).toContain("send email");
    expect(plan.accessProfileId).toBe("ask_for_approval");
    expect(plan.enableShell).toBe(false);
    expect(plan.selectedToolFamilies).not.toContain("shell");
    expect(plan.sharing).toEqual({ visibility: "private", ownerLabel: "You" });
  });

  it("selects explicitly named Gmail only when it is enabled and otherwise marks it missing", () => {
    const enabledInventory: AgentBuilderInventory = {
      ...baseInventory,
      mcpServers: baseInventory.mcpServers.map((server) =>
        server.id === "gmail" ? ({ ...server, enabled: true, name: "Gmail" } as Any) : server,
      ) as Any,
    };

    const enabledPlan = buildFallbackAgentPlan(
      { prompt: "Summarize my gmail emails", workspaceId: "ws-1" },
      enabledInventory,
      { now: () => 123, randomId: () => "plan-gmail" },
    );
    expect(enabledPlan.selectedMcpServers).toContain("gmail");
    expect(enabledPlan.missingConnections.map((entry) => entry.id)).not.toContain("gmail");

    const missingPlan = buildFallbackAgentPlan(
      { prompt: "Summarize my gmail emails", workspaceId: "ws-1" },
      baseInventory,
      { now: () => 123, randomId: () => "plan-gmail-missing" },
    );
    expect(missingPlan.selectedMcpServers).not.toContain("gmail");
    expect(missingPlan.missingConnections.map((entry) => entry.id)).toContain("gmail");
  });

  it("auto-selects one enabled generic email source but asks when multiple are available", () => {
    const oneEmailInventory: AgentBuilderInventory = {
      ...baseInventory,
      mcpServers: baseInventory.mcpServers.map((server) =>
        server.id === "gmail" ? ({ ...server, enabled: true, name: "Gmail" } as Any) : server,
      ) as Any,
    };
    const oneEmailPlan = buildFallbackAgentPlan(
      { prompt: "Summarize my emails", workspaceId: "ws-1" },
      oneEmailInventory,
      { now: () => 123, randomId: () => "plan-one-email" },
    );
    expect(oneEmailPlan.selectedMcpServers).toContain("gmail");
    expect(oneEmailPlan.selectionRequirements).toHaveLength(0);

    const multipleEmailInventory: AgentBuilderInventory = {
      ...oneEmailInventory,
      mcpServers: [
        ...oneEmailInventory.mcpServers,
        {
          id: "outlook-email",
          name: "Outlook Email",
          enabled: true,
          transport: "stdio",
        } as Any,
      ] as Any,
    };
    const multipleEmailPlan = buildFallbackAgentPlan(
      { prompt: "Summarize my emails", workspaceId: "ws-1" },
      multipleEmailInventory,
      { now: () => 123, randomId: () => "plan-multiple-email" },
    );
    expect(multipleEmailPlan.selectedMcpServers).not.toContain("gmail");
    expect(multipleEmailPlan.selectedMcpServers).not.toContain("outlook-email");
    expect(multipleEmailPlan.selectionRequirements[0]).toMatchObject({
      kind: "integration",
      required: true,
    });
    expect(multipleEmailPlan.selectionRequirements[0]?.options.map((option) => option.id)).toEqual([
      "gmail",
      "outlook-email",
    ]);
  });

  it("normalizes over-eager LLM Gmail selection into a required choice for generic email prompts", async () => {
    const inventory: AgentBuilderInventory = {
      ...baseInventory,
      mcpServers: [
        { id: "gmail", name: "Gmail", enabled: true, transport: "stdio" } as Any,
        { id: "outlook-email", name: "Outlook Email", enabled: true, transport: "stdio" } as Any,
      ],
    };
    const service = new AgentBuilderService({
      now: () => 123,
      randomId: () => "llm-plan",
      getSelectedModel: () => "test-model",
      createProvider: () =>
        ({
          createMessage: async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: "Email Agent",
                  description: "Summarize emails.",
                  selectedMcpServers: ["gmail"],
                  selectedSkills: [],
                  selectedToolFamilies: ["communication", "search"],
                  missingConnections: [],
                }),
              },
            ],
          }),
        }) as Any,
    });

    const plan = await service.generatePlan({ prompt: "Summarize my emails" }, inventory);

    expect(plan.selectedMcpServers).not.toContain("gmail");
    expect(plan.selectionRequirements[0]?.options.map((option) => option.id)).toEqual([
      "gmail",
      "outlook-email",
    ]);
  });

  it("asks for a skill when multiple enabled skills match and selects exact skill names directly", () => {
    const inventory: AgentBuilderInventory = {
      ...baseInventory,
      skills: [
        {
          id: "email-summary-a",
          name: "Email Summary A",
          description: "Summarize email context.",
          icon: "mail",
          prompt: "Summarize email.",
          enabled: true,
        },
        {
          id: "email-summary-b",
          name: "Email Summary B",
          description: "Summarize email context.",
          icon: "mail",
          prompt: "Summarize email.",
          enabled: true,
        },
      ] as Any,
    };

    const ambiguousPlan = buildFallbackAgentPlan(
      { prompt: "Summarize email", workspaceId: "ws-1" },
      inventory,
      { now: () => 123, randomId: () => "skill-choice-plan" },
    );
    expect(ambiguousPlan.selectedSkills).toEqual([]);
    expect(ambiguousPlan.selectionRequirements.some((entry) => entry.kind === "skill")).toBe(true);

    const exactPlan = buildFallbackAgentPlan(
      { prompt: "Use Email Summary A", workspaceId: "ws-1" },
      inventory,
      { now: () => 123, randomId: () => "skill-exact-plan" },
    );
    expect(exactPlan.selectedSkills).toEqual(["email-summary-a"]);
    expect(exactPlan.selectionRequirements.some((entry) => entry.kind === "skill")).toBe(false);
  });
});
