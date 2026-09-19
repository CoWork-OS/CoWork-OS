import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon follow-up permission overrides", () => {
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
