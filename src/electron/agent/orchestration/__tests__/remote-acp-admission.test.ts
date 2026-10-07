import { promises as dns } from "dns";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { DEFAULT_GUARDRAIL_SETTINGS } from "../../../../shared/guardrail-defaults";
import { GuardrailManager } from "../../../guardrails/guardrail-manager";
import { evaluateRemoteAcpPolicy, REMOTE_ACP_INVOCATION_TOOL } from "../remote-acp-admission";

vi.mock("../../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowedInternalHosts: [],
        allowShellNetwork: false,
      },
    },
  })),
}));

let workspaceDir: string;

function makeWorkspace(permissions: Partial<Workspace["permissions"]> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: workspaceDir,
    createdAt: 0,
    permissions: {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: true,
      ...permissions,
    },
  } as Workspace;
}

const agent = {
  id: "remote-agent-1",
  name: "Remote agent",
  endpoint: "https://agent.example.com/acp",
};

describe("evaluateRemoteAcpPolicy", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-remote-acp-"));
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as Any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("requires approval for a permitted endpoint under the remote invocation rule", async () => {
    const result = await evaluateRemoteAcpPolicy({
      workspace: makeWorkspace(),
      guardrails: DEFAULT_GUARDRAIL_SETTINGS,
      agent,
    });

    expect(result).toMatchObject({
      decision: "require_approval",
      reason: "Remote ACP/A2A agent invocations require approval",
    });
    expect(result.networkDecision).toMatchObject({
      action: "allow",
      toolName: REMOTE_ACP_INVOCATION_TOOL,
    });
  });

  it.each([
    [{ networkEnabled: false }, "network policy: workspace_network_disabled"],
    [{ accessNetworkMode: "disabled" as const }, "network policy: profile_network_disabled"],
    [
      { profileDomainRules: [{ pattern: "*.example.com", access: "deny" as const }] },
      "network policy: profile_domain_denied",
    ],
  ])("denies when the network policy refuses the endpoint (%o)", async (network, reason) => {
    const result = await evaluateRemoteAcpPolicy({
      workspace: makeWorkspace(),
      guardrails: DEFAULT_GUARDRAIL_SETTINGS,
      agent,
      ...network,
    });

    expect(result).toMatchObject({ decision: "deny", reason });
  });

  it("lets the workspace tools.monty policy deny remote invocation", async () => {
    const policyDir = path.join(workspaceDir, ".cowork", "policy");
    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      path.join(policyDir, "tools.monty"),
      [
        'out = {"decision": "pass"}',
        `if input["tool"] == "${REMOTE_ACP_INVOCATION_TOOL}":`,
        '  out = {"decision": "deny", "reason": "remote agents disabled"}',
        "out",
      ].join("\n"),
      "utf8",
    );

    const result = await evaluateRemoteAcpPolicy({
      workspace: makeWorkspace(),
      guardrails: DEFAULT_GUARDRAIL_SETTINGS,
      agent,
    });

    expect(result).toEqual({
      decision: "deny",
      reason: "workspace tool policy: remote agents disabled",
    });
  });

  it("denies an endpoint hostname that resolves to a private address", async () => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as Any);

    const result = await evaluateRemoteAcpPolicy({
      workspace: makeWorkspace(),
      guardrails: DEFAULT_GUARDRAIL_SETTINGS,
      agent: { ...agent, endpoint: "https://rebound.example.com/acp" },
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/^endpoint destination refused: .*internal/);
  });

  it.each(["https://[fd00::1]/acp", "https://10.0.0.1/acp", "ftp://agent.example.com/acp"])(
    "denies the invalid or private endpoint %s",
    async (endpoint) => {
      const result = await evaluateRemoteAcpPolicy({
        workspace: makeWorkspace(),
        guardrails: DEFAULT_GUARDRAIL_SETTINGS,
        agent: { ...agent, endpoint },
      });

      expect(result.decision).toBe("deny");
      expect(dns.lookup).not.toHaveBeenCalled();
    },
  );

  it("denies when the run's workspace cannot be found", async () => {
    const result = await evaluateRemoteAcpPolicy({
      workspace: undefined,
      guardrails: DEFAULT_GUARDRAIL_SETTINGS,
      agent,
    });

    expect(result).toEqual({
      decision: "deny",
      reason: "workspace for the orchestration run is unavailable",
    });
  });
});
