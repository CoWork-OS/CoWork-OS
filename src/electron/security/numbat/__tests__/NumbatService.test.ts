import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SECURITY_POLICY } from "../../../../shared/agent-security";

const { getPoliciesFileVersionMock, loadPoliciesMock, resolveNumbatBinaryMock } = vi.hoisted(
  () => ({
    getPoliciesFileVersionMock: vi.fn(() => "v1"),
    loadPoliciesMock: vi.fn(),
    resolveNumbatBinaryMock: vi.fn(() => ({ path: "/trusted/numbat" })),
  }),
);

vi.mock("../../../admin/policies", () => ({
  getPoliciesFileVersion: getPoliciesFileVersionMock,
  loadPolicies: loadPoliciesMock,
  watchPolicies: vi.fn(() => vi.fn()),
}));
vi.mock("../NumbatBinaryResolver", () => ({
  resolveNumbatBinary: resolveNumbatBinaryMock,
  materializeStableNumbatBinary: vi.fn((binary) => binary),
}));

import { NumbatService } from "../NumbatService";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete process.env.COWORK_AGENT_SECURITY_DISABLED;
});

function policy(enabled: boolean) {
  return {
    ...DEFAULT_AGENT_SECURITY_POLICY,
    enabled,
    scheduledScan: { enabled: false, intervalHours: 24 },
  };
}

describe("NumbatService policy caching and maintenance", () => {
  it("returns immediately for disabled evaluations without reloading policy", async () => {
    const service = Object.create(NumbatService.prototype) as Any;
    service.cachedPolicy = policy(false);
    service.policyFileVersion = "v1";
    service.taskChains = new Map();

    const result = await service.evaluatePreTool({ taskId: "task-1" });

    expect(result).toEqual({ decision: "no_override", health: "disabled", durationMs: 0 });
    expect(loadPoliciesMock).not.toHaveBeenCalled();
  });

  it("keeps plain inventory reads free of external record ingestion", () => {
    const listInventory = vi.fn().mockReturnValue([{ agentId: "codex" }]);
    const ingestFile = vi.fn();
    const service = Object.create(NumbatService.prototype) as Any;
    service.repository = { listInventory };
    service.ingestor = { ingestFile };

    expect(service.listInventory()).toEqual([{ agentId: "codex" }]);
    expect(ingestFile).not.toHaveBeenCalled();
  });

  it("prunes retained records immediately and every day while enabled", () => {
    vi.useFakeTimers();
    loadPoliciesMock.mockReturnValue({ runtime: { agentSecurity: policy(true) } });
    const prune = vi.fn();
    const service = Object.create(NumbatService.prototype) as Any;
    service.repository = { prune, addDiagnostic: vi.fn(), listOpenFindingTaskIds: vi.fn(() => []) };
    service.pruneRuntimeArtifacts = vi.fn();
    service.cachedPolicy = policy(false);
    service.scheduledScanTimer = null;
    service.retentionTimer = null;
    service.scheduledScanRunning = false;

    service.configureScheduledScan();
    expect(prune).toHaveBeenCalledWith(30);

    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    expect(prune).toHaveBeenCalledTimes(2);

    service.shutdown();
  });

  it("continues retention pruning when live agent security is disabled", () => {
    vi.useFakeTimers();
    loadPoliciesMock.mockReturnValue({ runtime: { agentSecurity: policy(false) } });
    const prune = vi.fn();
    const service = Object.create(NumbatService.prototype) as Any;
    service.repository = { prune, addDiagnostic: vi.fn(), listOpenFindingTaskIds: vi.fn(() => []) };
    service.pruneRuntimeArtifacts = vi.fn();
    service.cachedPolicy = policy(false);
    service.scheduledScanTimer = null;
    service.retentionTimer = null;
    service.scheduledScanRunning = false;

    service.configureScheduledScan();

    expect(prune).toHaveBeenCalledWith(30);
    expect(service.scheduledScanTimer).toBeNull();
    service.shutdown();
  });

  it("refreshes a changed policy before reporting the enabled state", () => {
    const service = Object.create(NumbatService.prototype) as Any;
    service.cachedPolicy = policy(true);
    service.policyFileVersion = "v1";
    getPoliciesFileVersionMock.mockReturnValueOnce("v2");
    loadPoliciesMock.mockReturnValueOnce({ runtime: { agentSecurity: policy(false) } });

    expect(service.isEnabled()).toBe(false);
    expect(loadPoliciesMock).toHaveBeenCalledTimes(1);
  });

  it("applies deny_high_risk when Numbat reports degraded health", async () => {
    const service = Object.create(NumbatService.prototype) as Any;
    service.cachedPolicy = {
      ...policy(true),
      mode: "enforce",
      failurePolicy: "deny_high_risk",
    };
    service.policyFileVersion = "v1";
    service.taskChains = new Map();
    service.repository = { addDiagnostic: vi.fn() };
    service.ingestor = {
      ingestFile: vi.fn(() => ({ findings: [], decisions: [], diagnostics: [] })),
    };
    service.invoke = vi.fn().mockResolvedValue({ decision: "no_override", health: "degraded" });

    const result = await service.evaluatePreTool({
      taskId: "task-1",
      workspacePath: "/workspace",
      toolCallId: "tool-1",
      toolName: "run_command",
      toolInput: { command: "echo safe" },
      highRisk: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        decision: "deny",
        health: "degraded",
        failureCode: "pre_tool_evaluation_failed",
      }),
    );
  });
});
