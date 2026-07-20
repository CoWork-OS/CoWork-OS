import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon follow-up permission overrides", () => {
  it("applies full-access follow-up overrides before queueing work on an active executor", async () => {
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
      { permissionMode: "bypass_permissions", shellAccess: true },
    );

    expect(result).toEqual({ queued: true });
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

    expect(result).toEqual({ queued: true });
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
    );
  });
});
