import { describe, expect, it } from "vitest";

import {
  applyBuilderSelectionRequirement,
  buildDraftFromAgent,
  buildDraftFromBuilderPlan,
  buildDraftFromWorkflowBrief,
  buildDraftFromTemplate,
  getEffectiveApprovalPreview,
  getManagedSessionEventText,
  getUnresolvedBuilderSelectionRequirements,
  getApprovalRuntimeMatrix,
  getMissionControlActiveAgentRoles,
  getSlackDeploymentHealth,
  makeBlankDraft,
  normalizeSlackDeploymentHealth,
  sortRuntimeToolCatalogEntries,
  suggestTemplateFromWorkflowBrief,
} from "../AgentsHubPanel";
import { BUILTIN_AGENT_TEMPLATES } from "../../../electron/managed/agent-templates";

describe("AgentsHubPanel draft helpers", () => {
  it("renders managed-session content arrays as chat text", () => {
    expect(
      getManagedSessionEventText({
        id: "event-1",
        sessionId: "session-1",
        seq: 1,
        timestamp: 123,
        type: "user.message",
        payload: {
          content: [
            { type: "text", text: "Summarize the latest inbox" },
            { type: "file", artifactId: "artifact-1" },
          ],
        },
      }),
    ).toBe("Summarize the latest inbox\nAttached file artifact-1");
  });

  it("keeps active Mission Control personas visible without double-counting managed mirrors", () => {
    const roles = [
      {
        id: "active-persona",
        displayName: "Research Operator",
        isActive: true,
        heartbeatEnabled: true,
        soul: undefined,
      },
      {
        id: "inactive-persona",
        displayName: "Inactive Operator",
        isActive: false,
        heartbeatEnabled: true,
      },
      {
        id: "manual-persona",
        displayName: "Manual Persona",
        isActive: true,
        heartbeatEnabled: false,
      },
      {
        id: "managed-mirror",
        displayName: "Managed Mirror",
        isActive: true,
        heartbeatEnabled: true,
        soul: JSON.stringify({ managedAgentId: "managed-1" }),
      },
      {
        id: "policy-enabled",
        displayName: "Policy Enabled",
        isActive: true,
        heartbeatEnabled: false,
        heartbeatPolicy: { enabled: true },
      },
    ] as Any;

    expect(getMissionControlActiveAgentRoles(roles).map((role) => role.id)).toEqual([
      "active-persona",
      "policy-enabled",
    ]);
  });

  it("builds a template-backed studio draft with seeded schedule, tools, and memory", () => {
    const draft = buildDraftFromTemplate(
      {
        id: "team-chat-qna",
        name: "Team Chat Q&A",
        description: "Answer questions from team chat.",
        icon: "💬",
        color: "#0ea5e9",
        category: "communication",
        systemPrompt: "Answer grounded questions.",
        executionMode: "solo",
        skills: ["slack-faq"],
        mcpServers: ["slack", "drive"],
        studio: {
          apps: {
            allowedToolFamilies: ["communication", "search"],
            mcpServers: ["slack", "drive"],
          },
          memoryConfig: {
            mode: "focused",
            sources: ["workspace", "docs"],
          },
          scheduleConfig: {
            enabled: true,
            mode: "routine",
            cadenceMinutes: 60,
            label: "Hourly",
          },
          audioSummaryConfig: {
            enabled: true,
            style: "executive-briefing",
          },
        },
        environmentConfig: {
          enableShell: false,
          enableBrowser: true,
          enableComputerUse: false,
        },
      } as Any,
      [{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any,
    );

    expect(draft.templateId).toBe("team-chat-qna");
    expect(draft.workspaceId).toBe("ws-1");
    expect(draft.selectedSkills).toEqual(["slack-faq"]);
    expect(draft.selectedMcpServers).toEqual(["slack", "drive"]);
    expect(draft.selectedToolFamilies).toEqual(["communication", "search"]);
    expect(draft.memoryConfig).toEqual({ mode: "focused", sources: ["workspace", "docs"] });
    expect(draft.scheduleConfig.enabled).toBe(true);
    expect(draft.audioSummaryEnabled).toBe(true);
    expect(draft.enableBrowser).toBe(true);
    expect(draft.workflowBrief).toBe("Answer questions from team chat.");
    expect(draft.sharing.visibility).toBe("team");
    expect(draft.deployment.surfaces).toEqual(["chatgpt"]);
  });

  it("lists all finance templates and carries template metadata into drafts", () => {
    const financeTemplates = BUILTIN_AGENT_TEMPLATES.filter(
      (template) => template.category === "finance",
    );
    expect(financeTemplates.map((template) => template.name)).toEqual([
      "Pitch Agent",
      "Meeting Prep Agent",
      "Market Researcher",
      "Earnings Reviewer",
      "Model Builder",
      "Valuation Reviewer",
      "GL Reconciler",
      "Month-End Closer",
      "Statement Auditor",
      "KYC Screener",
    ]);

    const pitchDraft = buildDraftFromTemplate(financeTemplates[0], [
      { id: "ws-1", name: "Workspace", path: "/workspace" },
    ] as Any);

    expect(pitchDraft.templateRequiredPackIds).toContain("finance-core-pack");
    expect(pitchDraft.templateRequiredConnectorIds).toContain("factset");
    expect(pitchDraft.expectedArtifacts).toEqual(["pptx", "xlsx", "json"]);
    expect(pitchDraft.executionMode).toBe("team");
    expect(pitchDraft.selectedSkills).toContain("finance-source-ledger");
    expect(pitchDraft.selectedMcpServers).toContain("pitchbook");
    expect(pitchDraft.teamRoleNames).toContain("finance-lead");
  });

  it("rehydrates an existing managed agent draft from studio metadata and environment settings", () => {
    const draft = buildDraftFromAgent(
      {
        id: "agent-1",
        name: "Chief of Staff",
        description: "Executive briefings and follow-through.",
        status: "active",
      } as Any,
      {
        systemPrompt: "Prepare a weekly executive brief.",
        executionMode: "solo",
        skills: ["calendar", "email"],
        mcpServers: ["slack"],
        metadata: {
          studio: {
            templateId: "chief-of-staff",
            instructions: {
              operatingNotes: "Escalate blockers quickly.",
            },
            skills: ["calendar", "email"],
            apps: {
              mcpServers: ["slack"],
              allowedToolFamilies: ["communication", "documents"],
            },
            fileRefs: [{ id: "file-1", path: "/docs/brief.md", name: "brief.md" }],
            memoryConfig: { mode: "default", sources: ["workspace"] },
            channelTargets: [
              {
                id: "channel-1",
                channelType: "slack",
                channelId: "slack-channel",
                channelName: "#ops",
                enabled: true,
              },
            ],
            scheduleConfig: {
              enabled: true,
              mode: "recurring",
              cadenceMinutes: 120,
            },
            audioSummaryConfig: {
              enabled: true,
              style: "public-radio",
            },
            imageGenProfileId: "profile-1",
            workflowBrief:
              "Prepare weekly executive briefs, escalate blockers, and share decisions.",
            approvalPolicy: {
              autoApproveReadOnly: true,
              requireApprovalFor: ["send email"],
            },
            sharing: {
              visibility: "workspace",
              ownerLabel: "Founder Office",
            },
            deployment: {
              surfaces: ["chatgpt", "slack"],
            },
            defaultEnvironmentId: "env-1",
          },
        },
      } as Any,
      [
        {
          id: "env-1",
          config: {
            workspaceId: "ws-1",
            enableShell: true,
            enableBrowser: false,
            enableComputerUse: true,
          },
        },
      ] as Any,
      [{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any,
      [
        {
          id: "routine-1",
          name: "Morning brief",
          enabled: true,
          trigger: { type: "schedule", cadenceMinutes: 120 },
        },
      ] as Any,
    );

    expect(draft.agentId).toBe("agent-1");
    expect(draft.status).toBe("active");
    expect(draft.templateId).toBe("chief-of-staff");
    expect(draft.operatingNotes).toBe("Escalate blockers quickly.");
    expect(draft.selectedToolFamilies).toEqual(["communication", "documents"]);
    expect(draft.fileRefs).toHaveLength(1);
    expect(draft.channelTargets).toHaveLength(1);
    expect(draft.audioSummaryStyle).toBe("public-radio");
    expect(draft.imageGenProfileId).toBe("profile-1");
    expect(draft.workflowBrief).toContain("Prepare weekly executive briefs");
    expect(draft.approvalPolicy.requireApprovalFor).toEqual(["send email"]);
    expect(draft.sharing.ownerLabel).toBe("Founder Office");
    expect(draft.deployment.surfaces).toEqual(["chatgpt", "slack"]);
    expect(draft.workspaceId).toBe("ws-1");
    expect(draft.enableShell).toBe(true);
    expect(draft.enableBrowser).toBe(false);
    expect(draft.enableComputerUse).toBe(true);
    expect(draft.routines).toHaveLength(1);
    expect(draft.routines[0]?.trigger.type).toBe("schedule");
  });

  it("turns a generated builder plan into an editable private studio draft", () => {
    const draft = buildDraftFromBuilderPlan(
      {
        id: "plan-1",
        sourcePrompt: "Summarize Slack and draft follow-ups",
        name: "Follow Up Agent",
        subtitle: "Private in CoWork OS",
        description: "Summarize Slack and draft follow-ups.",
        icon: "Bot",
        color: "#1570ef",
        workflowBrief: "Summarize Slack and draft follow-ups.",
        capabilities: ["Summarize context"],
        selectedToolFamilies: ["communication", "search"],
        selectedMcpServers: ["slack"],
        connectedMcpServers: ["slack"],
        recommendedMissingIntegrations: [
          {
            id: "slack-channel",
            kind: "channel",
            label: "Slack channel",
            status: "missing",
            reason: "Choose a channel.",
          },
        ],
        missingConnections: [
          {
            id: "slack-channel",
            kind: "channel",
            label: "Slack channel",
            status: "missing",
            reason: "Choose a channel.",
          },
        ],
        selectedSkills: ["briefing"],
        selectionRequirements: [],
        instructions: "You are a private agent.",
        operatingNotes: "Ask before posting.",
        starterPrompts: [
          {
            id: "run-now",
            title: "Run this now",
            prompt: "Run the brief.",
          },
        ],
        scheduleConfig: { enabled: false, mode: "manual" },
        routines: [
          {
            name: "Manual run",
            enabled: true,
            trigger: { type: "manual", enabled: true },
          },
          {
            name: "Unsafe schedule",
            enabled: true,
            trigger: { type: "schedule", enabled: true, cadenceMinutes: 1440 },
          },
        ],
        memoryConfig: { mode: "default", sources: ["workspace"] },
        approvalPolicy: { autoApproveReadOnly: true, requireApprovalFor: ["post message"] },
        sharing: { visibility: "private", ownerLabel: "You" },
        deployment: { surfaces: ["chatgpt"] },
        enableShell: false,
        enableBrowser: true,
        enableComputerUse: false,
        rationale: ["Matched Slack workflow."],
        checklist: ["Connect Slack channel"],
        generatedAt: 123,
      },
      [{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any,
    );

    expect(draft.name).toBe("Follow Up Agent");
    expect(draft.sharing).toEqual({ visibility: "private", ownerLabel: "You" });
    expect(draft.selectedMcpServers).toEqual(["slack"]);
    expect(draft.starterPrompts[0]?.title).toBe("Run this now");
    expect(draft.missingConnections[0]?.label).toBe("Slack channel");
    expect(draft.routines.map((routine) => routine.trigger.type)).toEqual(["manual"]);
  });

  it("applies required builder choices before create is available", () => {
    const plan = {
      id: "plan-choice",
      sourcePrompt: "Summarize my emails",
      name: "Email Agent",
      subtitle: "Private in CoWork OS",
      description: "Summarize email.",
      icon: "Bot",
      color: "#1570ef",
      workflowBrief: "Summarize email.",
      capabilities: ["Summarize context"],
      selectedToolFamilies: ["search"],
      selectedMcpServers: [],
      connectedMcpServers: [],
      recommendedMissingIntegrations: [],
      missingConnections: [
        {
          id: "email",
          kind: "connector",
          label: "Email integration",
          status: "needs_auth",
          reason: "Email needs to be connected.",
        },
      ],
      selectedSkills: [],
      selectionRequirements: [
        {
          id: "email-choice",
          kind: "integration",
          title: "Choose email source",
          reason: "More than one email source is available.",
          required: true,
          options: [
            {
              id: "gmail",
              label: "Gmail",
              status: "available",
              selectedMcpServers: ["gmail"],
              selectedToolFamilies: ["communication", "search"],
            },
            {
              id: "email-summary",
              label: "Email Summary",
              status: "available",
              selectedSkills: ["email-summary"],
            },
          ],
        },
      ],
      instructions: "Summarize email.",
      operatingNotes: "Ask before sending.",
      starterPrompts: [],
      scheduleConfig: { enabled: false, mode: "manual" },
      routines: [],
      memoryConfig: { mode: "default", sources: ["workspace"] },
      approvalPolicy: { autoApproveReadOnly: true, requireApprovalFor: ["send email"] },
      sharing: { visibility: "private", ownerLabel: "You" },
      deployment: { surfaces: ["chatgpt"] },
      enableShell: false,
      enableBrowser: true,
      enableComputerUse: false,
      rationale: [],
      checklist: [],
      generatedAt: 123,
    } as Any;

    expect(getUnresolvedBuilderSelectionRequirements(plan)).toHaveLength(1);

    const selected = applyBuilderSelectionRequirement(plan, "email-choice", "gmail");

    expect(getUnresolvedBuilderSelectionRequirements(selected)).toHaveLength(0);
    expect(selected.selectedMcpServers).toEqual(["gmail"]);
    expect(selected.selectedToolFamilies).toEqual(["communication", "search"]);
    expect(selected.missingConnections).toEqual(plan.missingConnections);
  });

  it("creates a sane blank draft baseline", () => {
    const draft = makeBlankDraft([{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any);

    expect(draft.name).toBe("New Agent");
    expect(draft.workspaceId).toBe("ws-1");
    expect(draft.selectedToolFamilies).toEqual(["communication", "search", "files"]);
    expect(draft.scheduleConfig).toEqual({ enabled: false, mode: "manual" });
    expect(draft.sharing.visibility).toBe("team");
    expect(draft.approvalPolicy.autoApproveReadOnly).toBe(true);
    expect(draft.enableBrowser).toBe(true);
    expect(draft.enableShell).toBe(false);
    expect(draft.routines[0]?.trigger.type).toBe("manual");
  });

  it("suggests a template and seeds a workflow-first draft from the brief", () => {
    const templates = [
      {
        id: "weekly-metrics",
        name: "Weekly Metrics Reporter",
        description: "Pulls weekly data, generates charts, and writes a report.",
        icon: "📈",
        color: "#2563eb",
        category: "operations",
        systemPrompt: "Produce a metrics report.",
        executionMode: "solo",
      },
      {
        id: "lead-outreach",
        name: "Lead Outreach Agent",
        description: "Qualifies leads and drafts follow-up emails.",
        icon: "✉️",
        color: "#10b981",
        category: "support",
        systemPrompt: "Work inbound leads.",
        executionMode: "solo",
      },
    ] as Any;

    expect(
      suggestTemplateFromWorkflowBrief(
        "Pull Friday metrics, generate charts, and write the weekly narrative.",
        templates,
      )?.id,
    ).toBe("weekly-metrics");

    const draft = buildDraftFromWorkflowBrief(
      "Pull Friday metrics, generate charts, and write the weekly narrative.",
      templates,
      [{ id: "ws-1", name: "Workspace", path: "/workspace" }] as Any,
    );

    expect(draft.templateId).toBe("weekly-metrics");
    expect(draft.workflowBrief).toContain("Pull Friday metrics");
    expect(draft.name).toBe("Pull Friday Metrics Generate Charts");
    expect(draft.systemPrompt).toContain("Primary workflow");
  });

  it("describes the effective approval posture for CoWork OS and Slack", () => {
    const preview = getEffectiveApprovalPreview(
      {
        autoApproveReadOnly: true,
        requireApprovalFor: ["send email", "edit spreadsheet"],
        escalationChannel: "#ops-approvals",
      },
      { surfaces: ["chatgpt", "slack"] },
    );

    expect(preview.autoApproved).toEqual(["read-only web and knowledge lookups"]);
    expect(preview.gatedActions).toEqual(["send email", "edit spreadsheet"]);
    expect(preview.chatgptSummary).toContain("can research and gather context");
    expect(preview.slackSummary).toContain("sensitive follow-through still pauses for approval");
  });

  it("maps semantic approval actions to exact runtime approval classes", () => {
    const matrix = getApprovalRuntimeMatrix({
      autoApproveReadOnly: true,
      requireApprovalFor: ["send email", "edit spreadsheet"],
    });

    expect(matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticAction: "Read-only research and documentation lookup",
          runtimeType: "network_access",
          behavior: "auto_approve",
        }),
        expect.objectContaining({
          semanticAction: "send email",
          runtimeType: "external_service",
          behavior: "require_approval",
        }),
        expect.objectContaining({
          semanticAction: "edit spreadsheet",
          runtimeType: "data_export",
          behavior: "require_approval",
        }),
        expect.objectContaining({
          semanticAction: "file external ticket",
          runtimeType: "external_service",
          behavior: "auto_approve",
        }),
      ]),
    );
  });

  it("sorts live runtime tool entries by approval severity before name", () => {
    const sorted = sortRuntimeToolCatalogEntries([
      {
        name: "web_fetch",
        description: "Fetches a URL",
        approvalBehavior: "auto_approve",
        approvalKind: "none",
        sideEffectLevel: "none",
        resultKind: "read",
        capabilityTags: ["research"],
        exposure: "always",
        readOnly: true,
      },
      {
        name: "send_email_action",
        description: "Sends an email",
        approvalBehavior: "require_approval",
        approvalKind: "external_service",
        approvalType: "external_service",
        sideEffectLevel: "high",
        resultKind: "integration",
        capabilityTags: ["integration"],
        exposure: "conditional",
        readOnly: false,
      },
      {
        name: "write_file",
        description: "Writes a file",
        approvalBehavior: "workspace_policy",
        approvalKind: "workspace_policy",
        sideEffectLevel: "low",
        resultKind: "mutation",
        capabilityTags: ["code"],
        exposure: "always",
        readOnly: false,
      },
    ] as Any);

    expect(sorted.map((entry) => entry.name)).toEqual([
      "send_email_action",
      "write_file",
      "web_fetch",
    ]);
  });

  it("normalizes Slack deployment health without targets", () => {
    const fallback = getSlackDeploymentHealth(
      {
        channelTargets: [
          {
            id: "target-1",
            channelType: "slack",
            channelId: "channel-1",
            channelName: "#ops",
            enabled: true,
          },
        ],
      } as Any,
      [{ id: "channel-1", name: "#ops", type: "slack", status: "connected" }] as Any,
      "agent-1",
    );

    const normalized = normalizeSlackDeploymentHealth(
      {
        agentId: "agent-1",
        connectedCount: 0,
        misconfiguredCount: 0,
        updatedAt: 123,
      } as Any,
      fallback,
    );

    expect(normalized.targets).toHaveLength(1);
    expect(normalized.targets[0]?.channelName).toBe("#ops");
  });
});
