import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

type Any = any;

function createDaemonLike(options?: {
  replayed?: boolean;
  status?: string;
  queued?: boolean;
  running?: boolean;
  startTask?: ReturnType<typeof vi.fn>;
}) {
  const task = {
    id: "admitted-task-1",
    title: "Workspace summary",
    prompt: "Routed prompt",
    workspaceId: "workspace-1",
    status: options?.status || "queued",
    sessionId: "admitted-task-1",
    resumeStrategy: "snapshot",
  };
  const derived = {
    route: { intent: "summarize", domain: "workspace", confidence: 0.9, signals: [] },
    strategy: { conversationMode: "task", executionMode: "execute" },
  };
  const input = {
    title: task.title,
    prompt: task.prompt,
    workspaceId: task.workspaceId,
    resumeStrategy: "snapshot",
  };
  const taskAdmissionService = {
    admit: vi.fn().mockResolvedValue({ task, replayed: options?.replayed ?? false }),
    findReplayByRequestIdentity: vi.fn().mockResolvedValue(undefined),
    getByOperationKey: vi.fn().mockResolvedValue({
      found: true,
      operationKey: "operation-1",
      taskId: task.id,
      createdAt: 1,
      task,
    }),
  };
  const startTask = options?.startTask || vi.fn().mockResolvedValue(undefined);
  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    prepareTaskCreation: vi.fn().mockReturnValue({ input, derived }),
    taskAdmissionService,
    taskRepo: { findById: vi.fn().mockReturnValue(task) },
    queueManager: {
      isQueued: vi.fn().mockReturnValue(options?.queued ?? false),
      isRunning: vi.fn().mockReturnValue(options?.running ?? false),
    },
    ensureTaskSessionProjections: vi.fn(),
    failTask: vi.fn(),
    logTaskIntentRouted: vi.fn(),
    startTask,
    shutdownRequested: false,
  });
  return { daemon, input, task, taskAdmissionService, startTask };
}

describe("AgentDaemon idempotent task admission", () => {
  it("commits admission and repairs session projections before waking the queued task", async () => {
    const order: string[] = [];
    const startTask = vi.fn(async () => {
      order.push("wake");
    });
    const { daemon, task, input, taskAdmissionService } = createDaemonLike({ startTask });
    (daemon as Any).ensureTaskSessionProjections = vi.fn(() => order.push("projections"));

    const result = await AgentDaemon.prototype.createTaskIdempotent.call(daemon, {
      operationKey: " operation-1 ",
      title: "Workspace summary",
      prompt: "summarize the workspace",
      workspaceId: "workspace-1",
      requestIdentity: { title: "Workspace summary", prompt: "summarize the workspace" },
    });

    expect(result).toEqual({ task, replayed: false });
    expect(taskAdmissionService.admit).toHaveBeenCalledWith(" operation-1 ", input, {
      title: "Workspace summary",
      prompt: "summarize the workspace",
    });
    expect(order).toEqual(["projections", "wake"]);
    expect((daemon as Any).logTaskIntentRouted).toHaveBeenCalledWith(task.id, expect.any(Object));
  });

  it("does not duplicate a replay already present in the in-memory queue or running set", async () => {
    const { daemon, task, startTask } = createDaemonLike({ replayed: true, running: true });

    await AgentDaemon.prototype.createTaskIdempotent.call(daemon, {
      operationKey: "operation-1",
      title: task.title,
      prompt: "same caller request",
      workspaceId: task.workspaceId,
      requestIdentity: { title: task.title, prompt: "same caller request" },
    });

    expect(startTask).not.toHaveBeenCalled();
    expect((daemon as Any).logTaskIntentRouted).not.toHaveBeenCalled();
    expect((daemon as Any).ensureTaskSessionProjections).toHaveBeenCalledWith(task);
  });

  it("returns a matching receipt before mutable task preparation runs", async () => {
    const { daemon, task, taskAdmissionService } = createDaemonLike({ replayed: true });
    const replay = { task, replayed: true };
    taskAdmissionService.findReplayByRequestIdentity.mockResolvedValue(replay);
    (daemon as Any).prepareTaskCreation.mockImplementation(() => {
      throw new Error("memory service unavailable");
    });

    await expect(
      AgentDaemon.prototype.createTaskIdempotent.call(daemon, {
        operationKey: "operation-1",
        title: task.title,
        prompt: "same caller request",
        workspaceId: task.workspaceId,
        requestIdentity: { title: task.title, prompt: "same caller request" },
        autoStart: false,
      }),
    ).resolves.toEqual(replay);

    expect((daemon as Any).prepareTaskCreation).not.toHaveBeenCalled();
    expect(taskAdmissionService.admit).not.toHaveBeenCalled();
    expect((daemon as Any).ensureTaskSessionProjections).toHaveBeenCalledWith(task);
  });

  it("leaves a durable queued admission eligible for retry when the wake fails", async () => {
    const startTask = vi.fn().mockRejectedValue(new Error("daemon shutting down"));
    const { daemon, task } = createDaemonLike({ startTask });

    await expect(
      AgentDaemon.prototype.createTaskIdempotent.call(daemon, {
        operationKey: "operation-1",
        title: task.title,
        prompt: "same caller request",
        workspaceId: task.workspaceId,
        requestIdentity: { title: task.title, prompt: "same caller request" },
      }),
    ).rejects.toThrow("daemon shutting down");

    expect((daemon as Any).taskAdmissionService.admit).toHaveBeenCalledTimes(1);
    expect((daemon as Any).taskRepo.findById).toHaveBeenCalledWith(task.id);
    expect((daemon as Any).failTask).not.toHaveBeenCalled();
  });

  it("retries a failed wake with the same operation key and admitted task id", async () => {
    const startTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary queue wake failure"))
      .mockResolvedValueOnce(undefined);
    const { daemon, task, taskAdmissionService } = createDaemonLike({ startTask });
    taskAdmissionService.admit
      .mockResolvedValueOnce({ task, replayed: false })
      .mockResolvedValueOnce({ task, replayed: true });
    const request = {
      operationKey: "operation-1",
      title: task.title,
      prompt: "same caller request",
      workspaceId: task.workspaceId,
      requestIdentity: { title: task.title, prompt: "same caller request" },
    };

    await expect(AgentDaemon.prototype.createTaskIdempotent.call(daemon, request)).rejects.toThrow(
      "temporary queue wake failure",
    );
    await expect(
      AgentDaemon.prototype.createTaskIdempotent.call(daemon, request),
    ).resolves.toMatchObject({
      task: { id: task.id },
      replayed: true,
    });

    expect(taskAdmissionService.admit).toHaveBeenCalledTimes(2);
    expect(taskAdmissionService.admit.mock.calls.map(([key]) => key)).toEqual([
      "operation-1",
      "operation-1",
    ]);
    expect(startTask).toHaveBeenNthCalledWith(1, task);
    expect(startTask).toHaveBeenNthCalledWith(2, task);
  });

  it("requires the matching durable receipt before waking a deferred admission", async () => {
    const { daemon, task, taskAdmissionService, startTask } = createDaemonLike();

    await AgentDaemon.prototype.startAdmittedTask.call(daemon, "operation-1", task.id);
    expect(taskAdmissionService.getByOperationKey).toHaveBeenCalledWith("operation-1");
    expect(startTask).toHaveBeenCalledWith(task);

    taskAdmissionService.getByOperationKey.mockResolvedValueOnce({ found: false });
    await expect(
      AgentDaemon.prototype.startAdmittedTask.call(daemon, "unknown-operation", task.id),
    ).rejects.toThrow("Task admission receipt does not match");
  });

  it("repairs work-session projections for every queued task before startup recovery", () => {
    const first = { id: "queued-1", status: "queued" };
    const second = { id: "queued-2", status: "queued" };
    const ensureTaskSessionProjections = vi.fn();
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      ensureTaskSessionProjections,
    });

    (AgentDaemon.prototype as Any).ensureQueuedTaskSessionProjections.call(daemon, [first, second]);

    expect(ensureTaskSessionProjections).toHaveBeenNthCalledWith(1, first);
    expect(ensureTaskSessionProjections).toHaveBeenNthCalledWith(2, second);
  });
});
