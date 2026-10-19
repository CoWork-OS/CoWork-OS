import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { PermissionSettingsManager } from "../../security/permission-settings-manager";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { fileResource, ResourceConflictError } from "../resource-claims";

function daemonWith(
  claim: (input: Any) => Promise<Any>,
  tasks: Record<string, Any> = {
    "task-b": { id: "task-b", title: "Rename invoices", workspaceId: "ws-1" },
  },
) {
  const daemon = Object.create(AgentDaemon.prototype) as Any;
  Object.assign(daemon, {
    taskRepo: { findById: (id: string) => tasks[id] },
    workspaceRepo: { findById: () => ({ id: "ws-1", path: "/repo" }) },
    resourceClaimRepository: { claim: vi.fn(claim) },
    openResourceConflicts: new Set<string>(),
    workSessionContractService: { beginWait: vi.fn(), resolveWait: vi.fn() },
    logEvent: vi.fn(),
    taskMutationLedger: undefined,
  });
  return daemon;
}

const busy = {
  claimed: false,
  others: [{ taskId: "task-a", title: "Fix totals", isolated: false, status: "executing" }],
};

describe("claims before a write (shared-change coordination)", () => {
  it("keys a file by its path relative to the checkout, and nothing outside it", () => {
    expect(fileResource("/repo", "/repo/src/app.ts")).toEqual({
      key: "file:src/app.ts",
      label: "src/app.ts",
    });
    expect(fileResource("/repo/.cowork-worktrees/ab12", "src/app.ts")?.key).toBe("file:src/app.ts");
    expect(fileResource("/repo", "/elsewhere/app.ts")).toBeUndefined();
    expect(fileResource("/repo", "/repo")).toBeUndefined();
  });

  it("refuses a same-folder collision with a conflict wait, then resolves it when the write goes ahead", async () => {
    let next: Any = busy;
    const daemon = daemonWith(async () => next);

    const refused = await daemon
      .captureTaskMutationBaseline("task-b", "/repo/src/app.ts")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResourceConflictError);
    expect((refused as Error).message).toContain(
      'src/app.ts is being changed by another task in this folder ("Fix totals")',
    );
    expect(daemon.workSessionContractService.beginWait).toHaveBeenCalledWith("task-b", {
      kind: "external",
      requestId: "resource_conflict:file:src/app.ts",
      reason: 'src/app.ts is being changed by "Fix totals" in the same folder',
      payload: { conflict: true, resource: "src/app.ts", otherTaskId: "task-a" },
    });
    expect(daemon.logEvent).toHaveBeenCalledWith("task-b", "resource_conflict", {
      path: "src/app.ts",
      otherTaskId: "task-a",
      otherTaskTitle: "Fix totals",
    });

    next = { claimed: true, others: [] };
    await daemon.captureTaskMutationBaseline("task-b", "src/app.ts");
    await daemon.captureTaskMutationBaseline("task-b", "src/app.ts");
    expect(daemon.workSessionContractService.resolveWait).toHaveBeenCalledTimes(1);
    expect(daemon.workSessionContractService.resolveWait).toHaveBeenCalledWith(
      "task-b",
      "external",
      "resource_conflict:file:src/app.ts",
      "resolved",
      { reason: "write_went_ahead" },
    );
  });

  it("claims with the task's tree, so a lead task and its sub-agents share files", async () => {
    const tasks = {
      lead: { id: "lead", title: "Lead", workspaceId: "ws-1" },
      child: { id: "child", title: "Child", workspaceId: "ws-1", parentTaskId: "lead" },
      variant: {
        id: "variant",
        title: "Variant",
        workspaceId: "ws-1",
        worktreePath: "/repo/.cowork-worktrees/v1",
        agentConfig: { compareGroupId: "group-1" },
      },
    };
    const daemon = daemonWith(async () => ({ claimed: true, others: [] }), tasks);
    await daemon.captureTaskMutationBaseline("child", "/repo/a.txt");
    await daemon.captureTaskMutationBaseline("variant", "/repo/.cowork-worktrees/v1/a.txt");
    const calls = daemon.resourceClaimRepository.claim.mock.calls.map((call: Any[]) => call[0]);
    expect(calls[0]).toMatchObject({
      familyRoot: "lead",
      isolated: false,
      resourceKey: "file:a.txt",
    });
    expect(calls[1]).toMatchObject({
      familyRoot: "compare:group-1",
      isolated: true,
      resourceKey: "file:a.txt",
    });
  });

  it("never blocks a write when the claim cannot be recorded", async () => {
    const daemon = daemonWith(async () => {
      throw new Error("database is busy");
    });
    await expect(
      daemon.captureTaskMutationBaseline("task-b", "/repo/src/app.ts"),
    ).resolves.toBeUndefined();
    expect(daemon.workSessionContractService.beginWait).not.toHaveBeenCalled();
  });

  afterEach(() => vi.restoreAllMocks());

  it("gives every Build Compare variant the shared check as its success criteria", () => {
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({} as Any);
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      transcriptStoreEnabled: true,
    } as Any);
    const daemon = Object.create(AgentDaemon.prototype) as Any;
    daemon.deriveTaskStrategy = (params: Any) => ({
      prompt: params.prompt,
      agentConfig: params.agentConfig,
      route: {},
    });
    const prepare = (agentConfig: Record<string, unknown>) =>
      daemon.prepareTaskCreation({
        title: "Dashboard",
        prompt: "Build a dashboard",
        workspaceId: "ws-1",
        agentConfig,
      }).input;

    expect(
      prepare({ compareGroupId: "group-0001", compareCheckCommand: " npm test " }).successCriteria,
    ).toEqual({ type: "shell_command", command: "npm test" });
    // Outside a Compare group the field does nothing.
    expect(prepare({ compareCheckCommand: "npm test" }).successCriteria).toBeUndefined();
  });
});
