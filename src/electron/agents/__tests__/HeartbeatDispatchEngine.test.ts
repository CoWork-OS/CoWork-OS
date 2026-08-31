import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HeartbeatDispatchEngine,
  type HeartbeatDispatchDeps,
  type DispatchExecutionInput,
} from "../HeartbeatDispatchEngine";
import type { AgentRole, Task } from "../../../shared/types";

function makeAgent(overrides: Partial<AgentRole> = {}): AgentRole {
  return {
    id: "agent-1",
    name: "test",
    displayName: "Test Agent",
    description: "",
    icon: "A",
    color: "#000",
    capabilities: [],
    isSystem: false,
    isActive: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    heartbeatProfile: "dispatcher",
    ...overrides,
  } as AgentRole;
}

function makeTask(id = "task-1"): Task {
  return { id, title: "Test task" } as Task;
}

function makeDeps(overrides: Partial<HeartbeatDispatchDeps> = {}): HeartbeatDispatchDeps {
  return {
    createTask: vi.fn().mockResolvedValue(makeTask()),
    updateTask: vi.fn(),
    createCompanionSuggestion: vi.fn().mockResolvedValue({ id: "sug-1" }),
    addNotification: vi.fn().mockResolvedValue(undefined),
    recordActivity: vi.fn(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<DispatchExecutionInput> = {}): DispatchExecutionInput {
  return {
    agent: makeAgent(),
    heartbeatRunId: "run-1",
    workspaceId: "ws-1",
    reason: "Test reason",
    signalSummaries: [],
    evidenceRefs: [],
    dueChecklistItems: [],
    dueProactiveTasks: [],
    dispatchKind: "task",
    ...overrides,
  };
}

describe("HeartbeatDispatchEngine.execute", () => {
  let deps: HeartbeatDispatchDeps;
  let engine: HeartbeatDispatchEngine;

  beforeEach(() => {
    deps = makeDeps();
    engine = new HeartbeatDispatchEngine(deps);
  });

  it("creates a task when dispatchKind is 'task'", async () => {
    const result = await engine.execute(makeInput({ dispatchKind: "task" }));
    expect(deps.createTask).toHaveBeenCalledOnce();
    expect(result.status).toBe("work_done");
    expect(result.taskCreated).toBe("task-1");
    expect(result.dispatchKind).toBe("task");
  });

  it("sets assignedAgentRoleId on the created task", async () => {
    await engine.execute(makeInput({ dispatchKind: "task" }));
    const taskOverrides = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][4]
      .taskOverrides;
    expect(taskOverrides.assignedAgentRoleId).toBe("agent-1");
    expect(taskOverrides.heartbeatRunId).toBe("run-1");
  });

  it("records activity when dispatching a task", async () => {
    await engine.execute(makeInput({ dispatchKind: "task" }));
    expect(deps.recordActivity).toHaveBeenCalledOnce();
  });

  it("creates a suggestion when dispatchKind is 'suggestion'", async () => {
    const result = await engine.execute(makeInput({ dispatchKind: "suggestion" }));
    expect(deps.createCompanionSuggestion).toHaveBeenCalledOnce();
    // suggestion is the default/fallthrough case — status is "ok"
    expect(result.status).toBe("ok");
    expect(result.dispatchKind).toBe("suggestion");
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("handles runbook dispatch without creating a task or suggestion", async () => {
    const result = await engine.execute(
      makeInput({
        dispatchKind: "runbook",
        dueChecklistItems: [{ id: "c1", title: "Check something" } as Any],
      }),
    );
    expect(result.status).toBe("work_done");
    expect(result.dispatchKind).toBe("runbook");
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("includes signal summaries in the task prompt", async () => {
    await engine.execute(
      makeInput({
        dispatchKind: "task",
        signalSummaries: ["awareness_signal via manual: important update"],
      }),
    );
    const promptArg = (deps.createTask as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(promptArg).toContain("awareness_signal via manual");
  });

  it("carries evidenceRefs through to the result", async () => {
    const result = await engine.execute(
      makeInput({ dispatchKind: "task", evidenceRefs: ["ref-a", "ref-b"] }),
    );
    expect(result.evidenceRefsV3).toEqual(["ref-a", "ref-b"]);
  });

  it("gracefully handles missing optional deps (no updateTask, no recordActivity)", async () => {
    const minimalDeps: HeartbeatDispatchDeps = {
      createTask: vi.fn().mockResolvedValue(makeTask()),
    };
    const minimalEngine = new HeartbeatDispatchEngine(minimalDeps);
    await expect(minimalEngine.execute(makeInput({ dispatchKind: "task" }))).resolves.not.toThrow();
  });
});
