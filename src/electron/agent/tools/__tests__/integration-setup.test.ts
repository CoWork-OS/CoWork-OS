import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "../../../../shared/types";

const mocks = vi.hoisted(() => {
  const mcpState: { servers: Array<Any>; statusByServerId: Record<string, string> } = {
    servers: [],
    statusByServerId: {},
  };
  const hooksState: Any = {
    enabled: false,
    token: "",
    path: "/hooks",
    maxBodyBytes: 256 * 1024,
    presets: [],
    mappings: [],
    resend: undefined,
  };

  const defaultEnvByEntryId: Record<string, Record<string, string>> = {
    resend: {
      RESEND_API_KEY: "",
      RESEND_BASE_URL: "https://api.resend.com",
    },
    slack: {
      SLACK_BOT_TOKEN: "",
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "",
      SLACK_ACCESS_TOKEN: "",
      SLACK_REFRESH_TOKEN: "",
    },
    gmail: {
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_ACCESS_TOKEN: "",
      GOOGLE_REFRESH_TOKEN: "",
    },
    "google-workspace": {
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_ACCESS_TOKEN: "",
      GOOGLE_REFRESH_TOKEN: "",
    },
    jira: {
      JIRA_BASE_URL: "",
      JIRA_ACCESS_TOKEN: "",
      JIRA_EMAIL: "",
      JIRA_API_TOKEN: "",
      JIRA_CLIENT_ID: "",
      JIRA_CLIENT_SECRET: "",
      JIRA_REFRESH_TOKEN: "",
    },
    linear: {
      LINEAR_API_KEY: "",
    },
    hubspot: {
      HUBSPOT_ACCESS_TOKEN: "",
      HUBSPOT_CLIENT_ID: "",
      HUBSPOT_CLIENT_SECRET: "",
      HUBSPOT_REFRESH_TOKEN: "",
      HUBSPOT_BASE_URL: "https://api.hubapi.com",
    },
  };

  const makeServer = (entryId: string) => ({
    id: `${entryId}-server`,
    name: entryId,
    description: `${entryId} connector`,
    enabled: false,
    transport: "stdio",
    command: process.execPath,
    args: [`/tmp/connectors/${entryId}-mcp/dist/index.js`],
    env: { ...defaultEnvByEntryId[entryId] },
  });

  const installServer = vi.fn(async (entryId: string) => {
    const existing = mcpState.servers.find((server) => server.name === entryId);
    if (existing) throw new Error(`Server ${entryId} is already installed`);
    const server = makeServer(entryId);
    mcpState.servers.push(server);
    mcpState.statusByServerId[server.id] = "disconnected";
    return server;
  });

  const connectServer = vi.fn(async (serverId: string) => {
    mcpState.statusByServerId[serverId] = "connected";
  });

  const getServerStatus = vi.fn().mockImplementation((serverId: string) => ({
    status: mcpState.statusByServerId[serverId] || "disconnected",
  }));

  const callTool = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
  });

  const startConnectorOAuth = vi.fn().mockImplementation(async (request: Any) => {
    if (request.provider === "hubspot") {
      return {
        provider: "hubspot",
        accessToken: "hubspot_oauth_access",
        refreshToken: "hubspot_oauth_refresh",
      };
    }
    if (request.provider === "jira") {
      return {
        provider: "jira",
        accessToken: "jira_oauth_access",
        refreshToken: "jira_oauth_refresh",
        resources: [{ id: "site-1", name: "Acme", url: "https://acme.atlassian.net" }],
      };
    }
    return {
      provider: request.provider,
      accessToken: "oauth_access",
      refreshToken: "oauth_refresh",
    };
  });

  const skillState: {
    workspaceDir: string;
    skills: Record<string, Any>;
  } = {
    workspaceDir: "",
    skills: {},
  };

  const setWorkspaceSkillsDir = vi.fn();
  // The task reads skills through a workspace view; the shared loader is never switched.
  const forWorkspace = vi.fn(function (this: unknown, workspacePath: string) {
    skillState.workspaceDir = path.join(workspacePath, "skills");
    return this;
  });

  const getSkill = vi.fn((skillId: string) => skillState.skills[skillId] || null);

  const createWorkspaceSkill = vi.fn(async (skill: Any) => {
    const materialized = {
      ...skill,
      source: "workspace",
      filePath: path.join(skillState.workspaceDir || "/tmp", `${skill.id}.json`),
    };
    skillState.skills[skill.id] = materialized;
    return materialized;
  });

  const updateSkill = vi.fn(async (skillId: string, updates: Any) => {
    if (!skillState.skills[skillId]) return null;
    skillState.skills[skillId] = {
      ...skillState.skills[skillId],
      ...updates,
    };
    return skillState.skills[skillId];
  });

  return {
    mcpState,
    hooksState,
    installServer,
    connectServer,
    getServerStatus,
    callTool,
    startConnectorOAuth,
    skillState,
    setWorkspaceSkillsDir,
    forWorkspace,
    getSkill,
    createWorkspaceSkill,
    updateSkill,
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockReturnValue({
      connectServer: mocks.connectServer,
      getServerStatus: mocks.getServerStatus,
      callTool: mocks.callTool,
      getAllTools: vi.fn().mockReturnValue([]),
    }),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockImplementation(() => ({
      servers: mocks.mcpState.servers,
      autoConnect: true,
      toolNamePrefix: "mcp_",
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      registryEnabled: true,
      registryUrl: "https://registry.modelcontextprotocol.io/servers.json",
      hostEnabled: false,
    })),
    updateServer: vi.fn().mockImplementation((id: string, updates: Any) => {
      const idx = mocks.mcpState.servers.findIndex((server) => server.id === id);
      if (idx === -1) return null;
      mocks.mcpState.servers[idx] = { ...mocks.mcpState.servers[idx], ...updates };
      return mocks.mcpState.servers[idx];
    }),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: {
    installServer: mocks.installServer,
  },
}));

vi.mock("../../../mcp/oauth/connector-oauth", () => ({
  startConnectorOAuth: mocks.startConnectorOAuth,
}));

vi.mock("../../../hooks/settings", () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockImplementation(() => ({ ...mocks.hooksState })),
    enableHooks: vi.fn().mockImplementation(() => {
      mocks.hooksState.enabled = true;
      if (!mocks.hooksState.token) mocks.hooksState.token = "hooks-token";
      return { ...mocks.hooksState };
    }),
    updateConfig: vi.fn().mockImplementation((updates: Any) => {
      Object.assign(mocks.hooksState, updates);
      return { ...mocks.hooksState };
    }),
  },
}));

vi.mock("../../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: vi.fn().mockReturnValue({}),
    saveSettings: vi.fn(),
    setUserName: vi.fn(),
    getUserName: vi.fn(),
    getAgentName: vi.fn().mockReturnValue("CoWork"),
    setActivePersona: vi.fn(),
    setResponseStyle: vi.fn(),
    setQuirks: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock("../../custom-skill-loader", () => ({
  getCustomSkillLoader: vi.fn().mockReturnValue({
    setWorkspaceSkillsDir: mocks.setWorkspaceSkillsDir,
    forWorkspace: mocks.forWorkspace,
    getWorkspaceSkillsDir: vi.fn(() => mocks.skillState.workspaceDir || null),
    getManagedSkillsDir: vi.fn(() => "/tmp/cowork-managed-skills"),
    getSkill: mocks.getSkill,
    createWorkspaceSkill: mocks.createWorkspaceSkill,
    updateSkill: mocks.updateSkill,
    listModelInvocableSkills: vi.fn().mockReturnValue([]),
    expandPrompt: vi.fn().mockReturnValue(""),
    getSkillDescriptionsForModel: vi.fn().mockReturnValue(""),
  }),
}));

vi.mock("../../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn().mockReturnValue(true),
}));

vi.mock("../builtin-settings", () => ({
  BuiltinToolsSettingsManager: {
    loadSettings: vi.fn().mockReturnValue({
      categories: {},
      toolOverrides: {},
      toolTimeouts: {},
      toolAutoApprove: {},
      runCommandApprovalMode: "per_command",
    }),
    isToolEnabled: vi.fn().mockReturnValue(true),
    getToolCategory: vi.fn().mockReturnValue("meta"),
    getToolPriority: vi.fn().mockReturnValue("normal"),
  },
}));

vi.mock("../../search", () => ({
  SearchProviderFactory: {
    isAnyProviderConfigured: vi.fn().mockReturnValue(false),
    getAvailableProviders: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../mention-tools", () => ({
  MentionTools: class MockMentionTools {
    static getToolDefinitions() {
      return [];
    }
  },
}));

import { ToolRegistry } from "../registry";

function createWorkspace(workspacePath = "/tmp"): Workspace {
  return {
    id: "ws-1",
    name: "Test",
    path: workspacePath,
    createdAt: Date.now(),
    permissions: { read: true, write: true, delete: true, shell: false, network: true },
  };
}

describe("integration_setup tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mcpState.servers = [];
    mocks.mcpState.statusByServerId = {};
    mocks.hooksState.enabled = false;
    mocks.hooksState.token = "";
    mocks.hooksState.path = "/hooks";
    mocks.hooksState.maxBodyBytes = 256 * 1024;
    mocks.hooksState.presets = [];
    mocks.hooksState.mappings = [];
    mocks.hooksState.resend = undefined;
    mocks.skillState.workspaceDir = "";
    mocks.skillState.skills = {};
  });

  it("is exposed in tool list", () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");
    const tool = registry.getTools().find((t) => t.name === "integration_setup");
    expect(tool).toBeDefined();
  });

  it("lists Tier-1 integrations with status", async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");
    const result = await registry.executeTool("integration_setup", {
      action: "list",
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result.providers).toHaveLength(8);
    expect(result.providers.some((provider: Any) => provider.provider === "resend")).toBe(true);
    expect(result.providers.some((provider: Any) => provider.provider === "jira")).toBe(true);
    expect(result.providers.some((provider: Any) => provider.provider === "google-workspace")).toBe(
      true,
    );
  });

  it("inspect mode for Jira returns missing setup guidance and plan hash", async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");
    const result = await registry.executeTool("integration_setup", {
      action: "inspect",
      provider: "jira",
    });

    expect(result.success).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.configured).toBe(false);
    expect(typeof result.plan_hash).toBe("string");
    expect(result.missing_inputs.some((entry: Any) => entry.field === "JIRA_BASE_URL")).toBe(true);
  });

  it("configure fails safely on stale expected_plan_hash", async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");

    const result = await registry.executeTool("integration_setup", {
      action: "configure",
      provider: "resend",
      api_key: "re_test_key",
      expected_plan_hash: "stale-hash",
    });

    expect(result.success).toBe(false);
    expect(result.stale_plan).toBe(true);
    expect(mocks.installServer).not.toHaveBeenCalled();
  });

  it("configures HubSpot with OAuth", async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");

    const result = await registry.executeTool("integration_setup", {
      action: "configure",
      provider: "hubspot",
      auth_method: "oauth",
      oauth: {
        client_id: "hubspot_client",
        client_secret: "hubspot_secret",
      },
    });

    expect(result.success).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.connected).toBe(true);
    expect(mocks.startConnectorOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.installServer).toHaveBeenCalledWith("hubspot");

    const server = mocks.mcpState.servers.find((entry) => entry.name === "hubspot");
    expect(server).toBeDefined();
    expect(server.env.HUBSPOT_ACCESS_TOKEN).toBe("hubspot_oauth_access");
    expect(server.env.HUBSPOT_REFRESH_TOKEN).toBe("hubspot_oauth_refresh");
  });

  it("keeps Resend inbound setup flow", async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as Any, "task-1");

    const result = await registry.executeTool("integration_setup", {
      action: "configure",
      provider: "resend",
      api_key: "re_test_key",
      enable_inbound: true,
      webhook_secret: "whsec_test_secret",
    });

    expect(result.success).toBe(true);
    expect(result.email_sending_ready).toBe(true);
    expect(result.inbound.requested).toBe(true);
    expect(result.inbound.hooks_enabled).toBe(true);
    expect(result.inbound.preset_enabled).toBe(true);
    expect(result.inbound.signing_secret_configured).toBe(true);
    expect(mocks.callTool).toHaveBeenCalledWith("resend.health", {});
  });
});

describe("skill_proposal tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.skillState.workspaceDir = "";
    mocks.skillState.skills = {};
  });

  const jiraProposal = {
    action: "create",
    problem_statement: "Need a reusable Jira triage flow.",
    evidence: ["Jira not configured in runtime"],
    required_tools: [],
    risk_note: "No side effects",
    draft_skill: {
      id: "jira-triage-playbook",
      name: "Jira Triage Playbook",
      description: "Triage Jira issues",
      prompt: "Triage issues and summarize priorities.",
    },
  } as const;

  function createRegistry(daemon: Record<string, unknown>) {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-proposal-approve-"));
    return new ToolRegistry(
      createWorkspace(workspacePath),
      { logEvent: vi.fn(), ...daemon } as Any,
      "task-1",
    );
  }

  it("create stores a proposal without mutating skills", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-proposal-create-"));
    const registry = new ToolRegistry(
      createWorkspace(workspacePath),
      { logEvent: vi.fn() } as Any,
      "task-1",
    );

    const created = await registry.executeTool("skill_proposal", {
      action: "create",
      problem_statement: "Repeated connector setup retries need a reusable checklist skill.",
      evidence: ["Tool unavailable in context", "Missing credential retries"],
      required_tools: ["integration_setup"],
      risk_note: "Low risk: read-only guidance workflow",
      draft_skill: {
        id: "connector-setup-checklist",
        name: "Connector Setup Checklist",
        description: "Guided connector setup checklist",
        prompt: "Run a checklist for connector setup.",
      },
    });

    expect(created.success).toBe(true);
    expect(created.proposal.id).toBeDefined();
    expect(mocks.createWorkspaceSkill).not.toHaveBeenCalled();
  });

  it("approve asks the user and materializes the workspace skill after a yes", async () => {
    const requestApproval = vi.fn().mockResolvedValue(true);
    const registry = createRegistry({ requestApproval });

    const created = await registry.executeTool("skill_proposal", jiraProposal);
    const approved = await registry.executeTool("skill_proposal", {
      action: "approve",
      proposal_id: created.proposal.id,
    });

    expect(approved.success).toBe(true);
    expect(approved.skill.id).toBe("jira-triage-playbook");
    expect(mocks.createWorkspaceSkill).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      "task-1",
      "risk_gate",
      expect.stringContaining("Jira Triage Playbook"),
      expect.objectContaining({
        tool: "skill_proposal",
        params: { action: "approve", proposal_id: created.proposal.id },
        skillId: "jira-triage-playbook",
        approvalPreview: expect.objectContaining({
          text: expect.stringContaining("Triage issues and summarize priorities."),
        }),
      }),
      expect.objectContaining({
        allowAutoApprove: false,
        requireExplicitApproval: true,
        noStandingApproval: true,
      }),
    );
    // The skill is saved only once the user said yes, into this task's workspace folder,
    // without pointing the shared loader (and so every other task) at that workspace.
    expect(mocks.createWorkspaceSkill.mock.invocationCallOrder[0]).toBeGreaterThan(
      requestApproval.mock.invocationCallOrder[0],
    );
    expect(approved.skill.filePath).toBe(
      path.join(mocks.skillState.workspaceDir, "jira-triage-playbook.json"),
    );
    expect(mocks.setWorkspaceSkillsDir).not.toHaveBeenCalled();
  });

  it("a declined approval saves nothing and leaves the proposal pending", async () => {
    const requestApproval = vi.fn().mockResolvedValue(false);
    const registry = createRegistry({ requestApproval });

    const created = await registry.executeTool("skill_proposal", jiraProposal);
    const declined = await registry.executeTool("skill_proposal", {
      action: "approve",
      proposal_id: created.proposal.id,
    });

    expect(declined).toMatchObject({ success: false, approval_denied: true });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceSkill).not.toHaveBeenCalled();
    expect(mocks.updateSkill).not.toHaveBeenCalled();
    expect(mocks.setWorkspaceSkillsDir).not.toHaveBeenCalled();
    const pending = await registry.executeTool("skill_proposal", { action: "list" });
    expect(pending.proposals.map((proposal: Any) => proposal.id)).toContain(created.proposal.id);
  });

  it("fails closed when no approval channel exists", async () => {
    const registry = createRegistry({});

    const created = await registry.executeTool("skill_proposal", jiraProposal);
    const result = await registry.executeTool("skill_proposal", {
      action: "approve",
      proposal_id: created.proposal.id,
    });

    expect(result).toMatchObject({ success: false, approval_denied: true });
    expect(mocks.createWorkspaceSkill).not.toHaveBeenCalled();
  });

  it("does not ask about a proposal that cannot be applied", async () => {
    const requestApproval = vi.fn().mockResolvedValue(true);
    const registry = createRegistry({ requestApproval });

    const missing = await registry.executeTool("skill_proposal", {
      action: "approve",
      proposal_id: "does-not-exist",
    });

    expect(missing.success).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("passes the workspace skill file a skill tool would change to the permission check", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-update-target-"));
    const skillFile = path.join(workspacePath, "skills", "existing.json");
    mocks.skillState.skills.existing = {
      id: "existing",
      name: "Existing",
      source: "workspace",
      filePath: skillFile,
    };
    const evaluateToolPermission = vi.fn().mockResolvedValue({
      decision: "deny",
      reason: { type: "other", summary: "stopped by the test" },
    });
    const registry = new ToolRegistry(
      createWorkspace(workspacePath),
      { logEvent: vi.fn(), evaluateToolPermission } as Any,
      "task-1",
    );

    await expect(
      registry.executeTool("skill_update", { skill_id: "existing", prompt: "Planted rule." }),
    ).rejects.toThrow(/blocked by policy/);
    expect(evaluateToolPermission).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        toolName: "skill_update",
        details: expect.objectContaining({ path: skillFile }),
      }),
    );
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });

  it("advertises explicit consent for approve only", () => {
    const registry = createRegistry({});
    expect(registry.getApprovalType("skill_proposal", { action: "approve" })).toBe("risk_gate");
    for (const action of ["create", "list", "eval", "reject"]) {
      expect(registry.getApprovalType("skill_proposal", { action })).toBeNull();
    }
  });

  it("reject enforces duplicate cooldown for same proposal signature", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-proposal-reject-"));
    const registry = new ToolRegistry(
      createWorkspace(workspacePath),
      { logEvent: vi.fn() } as Any,
      "task-1",
    );

    const payload = {
      action: "create",
      problem_statement: "Need a reusable connector diagnosis flow.",
      evidence: ["Integration missing", "Credential mismatch"],
      required_tools: ["integration_setup"],
      risk_note: "Safe and review-oriented",
      draft_skill: {
        id: "connector-diagnose",
        name: "Connector Diagnose",
        description: "Diagnose connector readiness",
        prompt: "Diagnose connector readiness and output next actions.",
      },
    } as const;

    const created = await registry.executeTool("skill_proposal", payload);
    const rejected = await registry.executeTool("skill_proposal", {
      action: "reject",
      proposal_id: created.proposal.id,
      rejection_reason: "Need tighter scope before approval",
    });
    expect(rejected.success).toBe(true);

    const duplicate = await registry.executeTool("skill_proposal", payload);
    expect(duplicate.success).toBe(false);
    expect(typeof duplicate.cooldown_until).toBe("number");
    expect(duplicate.duplicate_of).toBe(created.proposal.id);
  });
});
