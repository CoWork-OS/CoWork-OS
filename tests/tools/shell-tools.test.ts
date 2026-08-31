/**
 * Tests for ShellTools auto-approval of similar commands
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
  sandbox: {
    type: "macos" as const,
    execute: vi.fn(),
    executeCode: vi.fn(),
    cleanup: vi.fn(),
  },
  createSandbox: vi.fn(),
}));

vi.mock("../../src/electron/agent/sandbox/sandbox-factory", () => ({
  createSandbox: sandboxMocks.createSandbox,
}));

vi.mock("../../src/electron/admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      allowedSandboxTypes: ["macos", "docker"],
      requireSandboxForShell: true,
      allowUnsandboxedShell: false,
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
      autoReview: { enabled: true },
      telemetry: { enabled: false },
    },
  })),
}));

import { GuardrailManager } from "../../src/electron/guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../../src/electron/agent/tools/builtin-settings";
import { ShellSessionManager } from "../../src/electron/agent/tools/shell-session-manager";
import { ShellTools, _testUtils } from "../../src/electron/agent/tools/shell-tools";
import { loadPolicies } from "../../src/electron/admin/policies";
import type { AgentDaemon } from "../../src/electron/agent/daemon";
import type { Workspace } from "../../src/shared/types";

const mockDaemon = {
  requestApproval: vi.fn().mockResolvedValue(true),
  logEvent: vi.fn(),
} as unknown as AgentDaemon;

const mockWorkspace = {
  id: "test-workspace",
  name: "Test Workspace",
  path: process.cwd(),
  permissions: {
    shell: true,
    read: true,
    write: true,
    delete: true,
    network: true,
  },
} as Workspace;

const SAFE_CMD_1 = `"${process.execPath}" -e "process.stdout.write('ok1')"`;
const SAFE_CMD_2 = `"${process.execPath}" -v`;

describe("ShellTools auto-approval", () => {
  let shellTools: ShellTools;
  const mockShellSessionManager = {
    runCommand: vi.fn(),
    getSessionInfo: vi.fn().mockReturnValue(null),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.COWORK_ALLOW_UNSANDBOXED_SHELL;
    (mockDaemon.requestApproval as any).mockReset().mockResolvedValue(true);
    (mockDaemon.logEvent as any).mockReset();
    sandboxMocks.sandbox.execute.mockReset().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("apply_patch mention")
        ? "apply_patch mention\n"
        : command.includes(" -v")
          ? `${process.version}\n`
          : command.includes("ok1")
            ? "ok1"
            : "",
      stderr: "",
      killed: false,
      timedOut: false,
    }));
    sandboxMocks.sandbox.executeCode.mockReset();
    sandboxMocks.sandbox.cleanup.mockReset();
    sandboxMocks.createSandbox.mockReset().mockResolvedValue(sandboxMocks.sandbox);
    mockShellSessionManager.runCommand
      .mockReset()
      .mockImplementation(async ({ command }: { command: string }) => ({
        success: true,
        stdout: command.includes("apply_patch mention")
          ? "apply_patch mention\n"
          : command.includes(" -v")
            ? `${process.version}\n`
            : "",
        stderr: "",
        exitCode: 0,
        truncated: false,
        terminationReason: "normal",
        usedPersistentSession: true,
      }));
    mockShellSessionManager.getSessionInfo.mockReset().mockReturnValue(null);

    shellTools = new ShellTools(mockWorkspace, mockDaemon, "task-1");
    vi.spyOn(GuardrailManager, "isCommandBlocked").mockReturnValue({ blocked: false });
    vi.spyOn(GuardrailManager, "isCommandTrusted").mockReturnValue({ trusted: false });
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "per_command",
    );
    vi.spyOn(ShellSessionManager, "getInstance").mockReturnValue(mockShellSessionManager as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects shell execution before approval when workspace shell permission is disabled", async () => {
    const previousShellPermission = mockWorkspace.permissions.shell;
    mockWorkspace.permissions.shell = false;

    try {
      await expect(shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() })).rejects.toThrow(
        /active access profile.*command tools/i,
      );
      expect(mockDaemon.requestApproval).not.toHaveBeenCalled();
      expect(sandboxMocks.createSandbox).not.toHaveBeenCalled();
    } finally {
      mockWorkspace.permissions.shell = previousShellPermission;
    }
  });

  it("normalizes similar commands to the same signature", () => {
    const shellToolsAny = shellTools as any;
    const sigA = shellToolsAny.getCommandSignature(
      'sips --resampleWidth 1024 "/Users/almarion/Desktop/A.png" --out "/Users/almarion/Desktop/optimized/A.png"',
    );
    const sigB = shellToolsAny.getCommandSignature(
      'sips --resampleWidth 1024 "/Users/almarion/Desktop/B.png" --out "/Users/almarion/Desktop/optimized/B.png"',
    );
    expect(sigA).toBe(sigB);
    expect(sigA).toContain("<arg>");
  });

  it("normalizes near-identical commands with changing numbers and IDs", () => {
    const shellToolsAny = shellTools as any;
    const sigA = shellToolsAny.getCommandSignature(
      "solana airdrop 1 9GdH8UrHJYrwWB3JUck16MuPaAEmNCu3iBnq62Es3GRD --url https://api.devnet.solana.com",
    );
    const sigB = shellToolsAny.getCommandSignature(
      "solana airdrop 2 3KhuzM2PF6GWwWvUy1N5c5QARpGm13GsuPLNZveguqjg --url https://api.devnet.solana.com",
    );
    expect(sigA).toBe(sigB);
    expect(sigA).toContain("<num>");
    expect(sigA).toContain("<id>");
  });

  it("flags dangerous commands as unsafe for auto-approval", () => {
    const shellToolsAny = shellTools as any;
    expect(shellToolsAny.isAutoApprovalSafe('rm -rf "/Users/almarion/Desktop/tmp1"')).toBe(false);
    expect(
      shellToolsAny.isAutoApprovalSafe(
        'sips --resampleWidth 1024 "/Users/almarion/Desktop/A.png" --out "/Users/almarion/Desktop/optimized/A.png"',
      ),
    ).toBe(true);
  });

  it("redacts seed phrases from shell output", () => {
    const shellToolsAny = shellTools as any;
    const output = [
      "Generating a new keypair",
      "Save this seed phrase to recover your new keypair:",
      "winner castle crop major beauty crystal light guilt inmate hat fantasy chair",
      "Done",
    ].join("\n");
    const sanitized = shellToolsAny.sanitizeCommandOutput(output);
    expect(sanitized).toContain("[REDACTED_SEED_PHRASE]");
    expect(sanitized).not.toContain("winner castle crop");
  });

  it("uses a single approval bundle for safe command sequences when enabled", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "single_bundle",
    );
    (mockDaemon.requestApproval as any).mockResolvedValue(true);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    const second = await shellTools.runCommand(SAFE_CMD_2, { cwd: process.cwd() });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(1);
    expect((mockDaemon.requestApproval as any).mock.calls[0][2]).toMatch(/single approval bundle/i);
    expect(sandboxMocks.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("still requires explicit approval for unsafe commands even with bundle mode", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "single_bundle",
    );
    (mockDaemon.requestApproval as any).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    expect(first.success).toBe(true);

    await expect(shellTools.runCommand("sudo -n true")).rejects.toThrow(
      "User denied command execution",
    );
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(2);
    expect((mockDaemon.requestApproval as any).mock.calls[1][2]).toBe(
      "Review the shell command below before approving.",
    );
  });

  it("keeps per-command approvals when bundle mode is disabled", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getRunCommandApprovalMode").mockReturnValue(
      "per_command",
    );
    (mockDaemon.requestApproval as any).mockResolvedValue(true);

    const first = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });
    const second = await shellTools.runCommand(SAFE_CMD_2, { cwd: process.cwd() });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mockDaemon.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("rejects apply_patch invocation through run_command with remediation", async () => {
    await expect(
      shellTools.runCommand('apply_patch "*** Begin Patch\\n*** End Patch\\n"'),
    ).rejects.toThrow(/use the apply_patch tool directly/i);

    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_protocol_violation",
      expect.objectContaining({
        tool: "run_command",
        reason: "apply_patch_via_shell",
        remediation: "use_apply_patch_tool_directly",
      }),
    );
    expect(mockDaemon.requestApproval).not.toHaveBeenCalled();
  });

  it("rejects wrapped apply_patch invocation through shell -c commands", async () => {
    await expect(
      shellTools.runCommand(
        "bash -lc \"echo before && apply_patch '*** Begin Patch\\n*** End Patch\\n'\"",
      ),
    ).rejects.toThrow(/use the apply_patch tool directly/i);

    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_protocol_violation",
      expect.objectContaining({
        tool: "run_command",
        reason: "apply_patch_via_shell",
        remediation: "use_apply_patch_tool_directly",
      }),
    );
    expect(mockDaemon.requestApproval).not.toHaveBeenCalled();
  });

  it("does not treat apply_patch text in command arguments as a protocol violation", async () => {
    const result = await shellTools.runCommand("echo apply_patch mention", { cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("apply_patch mention");
    const violations = (mockDaemon.logEvent as any).mock.calls.filter(
      (call: any[]) => call[1] === "tool_protocol_violation",
    );
    expect(violations).toHaveLength(0);
  });

  it("disables shell sandbox networking by default even when workspace network is enabled", async () => {
    await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });

    expect(sandboxMocks.sandbox.execute).toHaveBeenCalledWith(
      SAFE_CMD_1,
      [],
      expect.objectContaining({
        allowNetwork: false,
      }),
    );
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "network_policy_decision",
      expect.objectContaining({
        action: "deny",
        toolName: "run_command",
        reason: "shell_network_requires_admin_coarse_allow",
      }),
    );
  });

  it("forces named restricted profiles through the OS sandbox", () => {
    expect(
      _testUtils.shouldSandboxShellCommand({
        persistentShellAllowed: true,
        requireSandboxForShell: false,
        accessSandboxMode: "workspace-write",
        accessApprovalPolicy: "on-request",
      }),
    ).toBe(true);
  });

  it("allows full access to use the direct shell path for complex commands", () => {
    expect(
      _testUtils.shouldSandboxShellCommand({
        persistentShellAllowed: false,
        requireSandboxForShell: false,
        accessSandboxMode: "danger-full-access",
        accessApprovalPolicy: "never",
      }),
    ).toBe(false);
  });

  it("keeps scoped full profiles on the sandboxed shell path", () => {
    expect(
      _testUtils.shouldSandboxShellCommand({
        persistentShellAllowed: true,
        requireSandboxForShell: false,
        accessSandboxMode: "danger-full-access",
        accessApprovalPolicy: "never",
        hasScopedAccessRules: true,
      }),
    ).toBe(true);
  });

  it("allows shell sandbox networking only with explicit coarse admin policy", async () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: true,
        allowUnsandboxedShell: false,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: true,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });

    await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });

    expect(sandboxMocks.sandbox.execute).toHaveBeenCalledWith(
      SAFE_CMD_1,
      [],
      expect.objectContaining({
        allowNetwork: true,
      }),
    );
  });

  it("wires sandbox process handles for stdin support and clears them after completion", async () => {
    const fakeProcess = {
      stdin: { write: vi.fn() },
      killed: false,
      pid: 12345,
    };
    sandboxMocks.sandbox.execute.mockImplementationOnce(
      async (_command: string, _args: string[], options: any) => {
        options.onProcess(fakeProcess);
        expect(shellTools.hasActiveProcess()).toBe(true);
        expect(shellTools.sendStdin("input\n")).toBe(true);
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          killed: false,
          timedOut: false,
        };
      },
    );

    const result = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });

    expect(result.success).toBe(true);
    expect(fakeProcess.stdin.write).toHaveBeenCalledWith("input\n");
    expect(shellTools.hasActiveProcess()).toBe(false);
  });

  it("treats sandbox abort stderr as failure even when the outer shell exits zero", async () => {
    sandboxMocks.sandbox.execute.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "later command returned ok",
      stderr:
        "/bin/sh: line 1: 12345 Abort trap: 6 sandbox-exec -f /tmp/cowork.sb /bin/sh -c mkdir -p out\n",
      killed: false,
      timedOut: false,
    });

    const result = await shellTools.runCommand("mkdir -p out; echo ok", { cwd: process.cwd() });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.terminationReason).toBe("error");
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_result",
      expect.objectContaining({
        tool: "run_command",
        success: false,
        error: expect.stringMatching(/sandbox-exec aborted/i),
      }),
    );
  });

  it("does not classify ordinary command permission errors as sandbox runtime failures", async () => {
    sandboxMocks.sandbox.execute.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "mkdir: /root/out: Operation not permitted\n",
      killed: false,
      timedOut: false,
    });

    const result = await shellTools.runCommand("mkdir /root/out", { cwd: process.cwd() });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.terminationReason).toBe("normal");
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_result",
      expect.objectContaining({
        tool: "run_command",
        success: false,
        error: "Command exited with code 1",
      }),
    );
  });

  it("maps workspace cwd to /workspace for Docker sandbox execution", async () => {
    sandboxMocks.createSandbox.mockResolvedValueOnce({
      ...sandboxMocks.sandbox,
      type: "docker",
      cleanup: vi.fn(),
    });

    const result = await shellTools.runCommand(SAFE_CMD_1, {
      cwd: `${mockWorkspace.path}/packages/app`,
    });

    expect(result.success).toBe(true);
    expect(sandboxMocks.sandbox.execute).toHaveBeenCalledWith(
      SAFE_CMD_1,
      [],
      expect.objectContaining({
        cwd: "/workspace/packages/app",
      }),
    );
  });

  it("fails closed when no OS sandbox is available", async () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: true,
        allowUnsandboxedShell: false,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });
    sandboxMocks.createSandbox.mockResolvedValueOnce({
      ...sandboxMocks.sandbox,
      type: "none",
      cleanup: vi.fn(),
    });

    await expect(shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() })).rejects.toThrow(
      /requires an OS-level sandbox/i,
    );
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "sandbox_denied",
      expect.objectContaining({
        tool: "run_command",
        reason: "no_os_sandbox_available",
      }),
    );
  });

  it("fails closed without the explicit unsandboxed shell environment override even when sandboxing is not required", async () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: false,
        allowUnsandboxedShell: true,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });
    sandboxMocks.createSandbox.mockResolvedValueOnce({
      ...sandboxMocks.sandbox,
      type: "none",
      cleanup: vi.fn(),
    });

    await expect(
      shellTools.runCommand(`${SAFE_CMD_1} | cat`, { cwd: process.cwd() }),
    ).rejects.toThrow(/requires an OS-level sandbox/i);
    expect(mockShellSessionManager.runCommand).not.toHaveBeenCalled();
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "sandbox_denied",
      expect.objectContaining({
        tool: "run_command",
        reason: "no_os_sandbox_available",
      }),
    );
  });

  it("does not allow policy-only override when sandboxing is required and env is absent", async () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: true,
        allowUnsandboxedShell: true,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });
    sandboxMocks.createSandbox.mockResolvedValueOnce({
      ...sandboxMocks.sandbox,
      type: "none",
      cleanup: vi.fn(),
    });

    await expect(shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() })).rejects.toThrow(
      /requires an OS-level sandbox/i,
    );
    expect(mockShellSessionManager.runCommand).not.toHaveBeenCalled();
  });

  it("allows explicit unsandboxed development fallback when requested", async () => {
    process.env.COWORK_ALLOW_UNSANDBOXED_SHELL = "1";
    vi.mocked(loadPolicies).mockReturnValueOnce({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: true,
        allowUnsandboxedShell: true,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });
    sandboxMocks.createSandbox.mockResolvedValueOnce({
      ...sandboxMocks.sandbox,
      type: "none",
      cleanup: vi.fn(),
    });

    const result = await shellTools.runCommand(SAFE_CMD_1, { cwd: process.cwd() });

    expect(result.success).toBe(true);
    expect(mockShellSessionManager.runCommand).toHaveBeenCalled();
    expect(mockDaemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "shell_sandbox_bypassed",
      expect.objectContaining({
        reason: "no_os_sandbox_available",
        overrideEnv: "COWORK_ALLOW_UNSANDBOXED_SHELL",
      }),
    );
  });
});
