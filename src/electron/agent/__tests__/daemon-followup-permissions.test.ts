import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon follow-up permission overrides", () => {
  it.each(["idle", "busy", "durable-requeue"])(
    "keeps researcher follow-up overrides read-only through %s",
    async (route) => {
      const busy = route !== "idle";
      const task = {
        id: "750e8400-e29b-41d4-a716-446655440000",
        title: "Saved researcher",
        workspaceId: "workspace-1",
        workerRole: "researcher",
        agentConfig: {
          permissionMode: "bypass_permissions",
          shellAccess: true,
          externalRuntime: { kind: "acpx", agent: "codex", permissionMode: "approve-all" },
        },
      };
      const workspace = {
        id: "workspace-1",
        name: "Workspace",
        path: "/tmp/workspace",
        permissions: { read: true, write: true, delete: true, network: true, shell: true },
        createdAt: Date.now(),
      };
      const executor = {
        isRunning: busy,
        updateTaskAgentConfig: vi.fn(),
        updateWorkspace: vi.fn(),
        queueFollowUp: vi.fn(),
        runtime: { requeueFollowUpAtTurnBoundary: vi.fn() },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        activeTasks: new Map([[task.id, { executor, lastAccessed: 0, status: "active" }]]),
        taskRepo: { findById: vi.fn().mockReturnValue(task), update: vi.fn(), touch: vi.fn() },
        workspaceRepo: { findById: vi.fn().mockReturnValue(workspace) },
        annotationRepo: { listOpenByTask: vi.fn().mockReturnValue([]) },
        setTransientTaskAgentConfig: vi.fn(),
        clearTransientTaskAgentConfig: vi.fn(),
        getEffectiveWorkspaceForTask: vi.fn().mockReturnValue(workspace),
        processOrphanedFollowUps: vi.fn(),
        logEvent: vi.fn(),
      });
      const override = {
        permissionMode: "bypass_permissions",
        readOnlyExecution: false,
        shellAccess: true,
        externalRuntime: { kind: "acpx", agent: "claude", permissionMode: "approve-all" },
        modelKey: "turn-only-model",
        toolRestrictions: [],
      };
      const queuedFollowUp = {
        message: "Continue inspecting",
        messageId: "durable-researcher-message",
        deliveryMode: "message",
        agentConfigOverride: override,
      };
      await AgentDaemon.prototype.sendMessage.call(
        daemon,
        task.id,
        "Continue inspecting",
        undefined,
        undefined,
        {
          agentConfigOverride: override,
          ...(route === "durable-requeue" ? { queuedFollowUp } : {}),
        } as Any,
      );
      const forwarded =
        route === "durable-requeue"
          ? executor.runtime.requeueFollowUpAtTurnBoundary.mock.calls[0][0].agentConfigOverride
          : busy
            ? executor.queueFollowUp.mock.calls[0][4]
            : executor.sendMessage.mock.calls[0][3].agentConfigOverride;
      expect(forwarded.readOnlyExecution).toBe(true);
      expect(forwarded.permissionMode).toBe("plan");
      expect(forwarded.shellAccess).toBe(false);
      expect(forwarded.externalRuntime).toBeUndefined();
      expect(forwarded.modelKey).toBe("turn-only-model");
      expect(override.readOnlyExecution).toBe(false);
      if (route === "durable-requeue") {
        expect(executor.queueFollowUp).not.toHaveBeenCalled();
        expect(executor.runtime.requeueFollowUpAtTurnBoundary).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId: queuedFollowUp.messageId,
            deliveryMode: "message",
          }),
        );
      }
      if (!busy)
        expect(daemon.setTransientTaskAgentConfig).toHaveBeenCalledWith(task.id, forwarded);
      for (const [, update] of daemon.taskRepo.update.mock.calls) {
        expect(update.agentConfig?.externalRuntime).toBeUndefined();
        expect(update.agentConfig?.modelKey).toBeUndefined();
      }
    },
  );

  it("keeps later messages queued until the preceding mode turn completes", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const queue = [
      { message: "Discuss", interactionMode: { mode: "chat" } },
      { message: "Implement", interactionMode: { mode: "smart" } },
    ];
    const executor = {
      isRunning: false,
      takeNextFollowUpAtTurnBoundary: () => queue.shift(),
      suppressNextUserMessageEvent: vi.fn(),
    };
    const daemon = Object.create(AgentDaemon.prototype) as Any;
    daemon.drainingFollowUps = new Set();
    daemon.logEvent = vi.fn();
    daemon.sendMessage = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ queued: false });
    daemon.processOrphanedFollowUps("task", executor);
    daemon.processOrphanedFollowUps("task", executor);
    expect(queue).toHaveLength(1);
    expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
    finishFirst();
    await vi.waitFor(() => expect(daemon.sendMessage).toHaveBeenCalledTimes(2));
    expect(daemon.sendMessage.mock.calls[1][4].interactionMode).toEqual({ mode: "smart" });
  });
  it("applies permission changes immediately but queues mode changes without changing the active mode", async () => {
    const task = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Existing task",
      workspaceId: "workspace-1",
      agentConfig: {
        permissionMode: "default",
      },
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: false,
      },
      createdAt: Date.now(),
    };
    const executor = {
      isRunning: true,
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
      queueFollowUp: vi.fn(),
    };
    const daemonLike = {
      activeTasks: new Map([
        [
          task.id,
          {
            executor,
            lastAccessed: 0,
            status: "active",
          },
        ],
      ]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        update: vi.fn(),
        touch: vi.fn(),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue(workspace),
      },
      annotationRepo: {
        listOpenByTask: vi.fn().mockReturnValue([]),
      },
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const result = await AgentDaemon.prototype.sendMessage.call(
      daemonLike,
      task.id,
      "Continue with full access",
      undefined,
      undefined,
      {
        permissionMode: "bypass_permissions",
        shellAccess: true,
        interactionMode: { mode: "chat" },
      },
    );

    expect(result).toEqual({
      queued: true,
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
      acceptedAt: expect.any(Number),
      queuedAt: expect.any(Number),
    });
    expect(result.queuedAt).toBe(result.acceptedAt);
    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(task.id, {
      agentConfig: {
        permissionMode: "bypass_permissions",
        shellAccess: true,
      },
    });
    expect(executor.updateTaskAgentConfig).toHaveBeenCalledWith({
      permissionMode: "bypass_permissions",
      shellAccess: true,
    });
    expect(executor.updateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({
          shell: true,
        }),
      }),
    );
    expect(executor.queueFollowUp).toHaveBeenCalledWith(
      "Continue with full access",
      undefined,
      undefined,
      undefined,
      undefined,
      { mode: "chat" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("applies automation agent config overrides without persisting them to the task", async () => {
    const task = {
      id: "650e8400-e29b-41d4-a716-446655440000",
      title: "Existing task",
      workspaceId: "workspace-1",
      agentConfig: {
        permissionMode: "default",
      },
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      permissions: {
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: false,
      },
      createdAt: Date.now(),
    };
    const executor = {
      isRunning: true,
      updateTaskAgentConfig: vi.fn(),
      updateWorkspace: vi.fn(),
      queueFollowUp: vi.fn(),
    };
    const daemonLike = {
      activeTasks: new Map([
        [
          task.id,
          {
            executor,
            lastAccessed: 0,
            status: "active",
          },
        ],
      ]),
      taskRepo: {
        findById: vi.fn().mockReturnValue(task),
        update: vi.fn(),
        touch: vi.fn(),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue(workspace),
      },
      annotationRepo: {
        listOpenByTask: vi.fn().mockReturnValue([]),
      },
      logEvent: vi.fn(),
    } as Any;
    Object.setPrototypeOf(daemonLike, AgentDaemon.prototype);

    const agentConfigOverride = {
      toolRestrictions: ["run_command"],
      allowUserInput: false,
    };
    const result = await AgentDaemon.prototype.sendMessage.call(
      daemonLike,
      task.id,
      "Scheduled wake",
      undefined,
      undefined,
      { agentConfigOverride },
    );

    expect(result).toEqual({
      queued: true,
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
      acceptedAt: expect.any(Number),
      queuedAt: expect.any(Number),
    });
    expect(result.queuedAt).toBe(result.acceptedAt);
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalled();
    expect(executor.updateTaskAgentConfig).toHaveBeenCalledWith({
      permissionMode: "default",
      toolRestrictions: ["run_command"],
      allowUserInput: false,
    });
    expect(executor.queueFollowUp).toHaveBeenCalledWith(
      "Scheduled wake",
      undefined,
      undefined,
      undefined,
      agentConfigOverride,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
