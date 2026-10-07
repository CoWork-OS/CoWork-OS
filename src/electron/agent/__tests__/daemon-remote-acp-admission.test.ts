import { promises as dns } from "dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GUARDRAIL_SETTINGS } from "../../../shared/guardrail-defaults";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { AgentDaemon } from "../daemon";
import type { RemoteAcpDispatchRequest } from "../orchestration/remote-acp-admission";

vi.mock("../../admin/policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../admin/policies")>();
  return {
    ...actual,
    loadPolicies: vi.fn(() => ({
      ...actual.loadPolicies(),
      runtime: {
        ...actual.loadPolicies().runtime,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowedInternalHosts: [],
          allowShellNetwork: false,
        },
      },
    })),
  };
});

const request: RemoteAcpDispatchRequest = {
  runId: "run-1",
  nodeId: "node-1",
  rootTaskId: "parent-task",
  workspaceId: "workspace-1",
  agent: {
    id: "remote-agent-1",
    name: "Remote agent",
    description: "Remote worker",
    version: "1.0.0",
    capabilities: [],
    endpoint: "https://agent.example.com/acp",
    origin: "remote",
    registeredAt: 0,
    lastActiveAt: 0,
    status: "available",
  },
  title: "Summarize findings",
  prompt: "Summarize the findings with [REDACTED_SECRET]",
  redactedSecretCount: 1,
};

const rootTask = {
  id: "parent-task",
  title: "Parent",
  prompt: "Parent prompt",
  status: "executing",
  workspaceId: "workspace-1",
  createdAt: 0,
  updatedAt: 0,
};

function makeDaemon(options: { rootTask?: typeof rootTask; network?: boolean } = {}) {
  const workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "/nonexistent/cowork-remote-acp-workspace",
    createdAt: 0,
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: options.network ?? true,
    },
  };
  return Object.assign(Object.create(AgentDaemon.prototype), {
    taskRepo: { findById: vi.fn(() => options.rootTask) },
    workspaceRepo: { findById: vi.fn(() => workspace) },
    getEffectiveWorkspaceForTask: vi.fn(() => workspace),
    getEffectiveAccessProfile: vi.fn(() => ({
      networkEnabled: true,
      definition: { network: "enabled", domainRules: [] },
    })),
    authorizeToolAction: vi.fn(async () => true),
    logEvent: vi.fn(),
  }) as Any;
}

describe("AgentDaemon remote ACP admission wiring", () => {
  beforeEach(() => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({ ...DEFAULT_GUARDRAIL_SETTINGS });
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as Any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requires approval for a permitted remote dispatch and logs the decision", async () => {
    const daemon = makeDaemon({ rootTask });

    const decision = await daemon.evaluateRemoteAcpAdmission(request);

    expect(decision).toEqual({
      decision: "require_approval",
      reason: "Remote ACP/A2A agent invocations require approval",
    });
    expect(daemon.logEvent).toHaveBeenCalledWith(
      rootTask.id,
      "log",
      expect.objectContaining({ tool: "acp_remote", decision: "require_approval" }),
    );
  });

  it("denies when the run's workspace has network access disabled", async () => {
    const daemon = makeDaemon({ rootTask, network: false });

    const decision = await daemon.evaluateRemoteAcpAdmission(request);

    expect(decision).toEqual({
      decision: "deny",
      reason: "network policy: workspace_network_disabled",
    });
  });

  it("routes approval through the explicit-consent tool authorization flow", async () => {
    const daemon = makeDaemon({ rootTask });

    const approved = await daemon.requestRemoteAcpApproval(request, "needs consent");

    expect(approved).toEqual({ approved: true });
    expect(daemon.authorizeToolAction).toHaveBeenCalledWith(
      rootTask.id,
      expect.objectContaining({
        toolName: "acp_remote",
        approvalType: "external_service",
        requireExplicitApproval: true,
        details: expect.objectContaining({
          acpAgentId: "remote-agent-1",
          host: "agent.example.com",
          policyReason: "needs consent",
          promptPreview: request.prompt,
          redactedSecretCount: 1,
        }),
      }),
    );
  });

  it("reports a declined approval as not approved", async () => {
    const daemon = makeDaemon({ rootTask });
    daemon.authorizeToolAction.mockResolvedValue(false);

    const approved = await daemon.requestRemoteAcpApproval(request, "needs consent");

    expect(approved.approved).toBe(false);
    expect(approved.reason).toMatch(/denied/);
  });

  it("fails closed when the run has no task to carry the approval", async () => {
    const daemon = makeDaemon({ rootTask: undefined });

    const approved = await daemon.requestRemoteAcpApproval(
      { ...request, rootTaskId: "acp:task-1" },
      "needs consent",
    );

    expect(approved).toEqual({
      approved: false,
      reason: "needs consent; this run has no task to request approval on",
    });
    expect(daemon.authorizeToolAction).not.toHaveBeenCalled();
  });
});
