import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { PermissionSettingsManager } from "../../security/permission-settings-manager";

describe("AgentDaemon.createChildTask", () => {
  it("persists the original child prompt as rawPrompt", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Architect",
      prompt: "Build the public portal and constitution.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
    });

    expect(taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Build the public portal and constitution.",
        rawPrompt: "Build the public portal and constitution.",
      }),
    );
    expect(child.rawPrompt).toBe("Build the public portal and constitution.");
    expect(daemonLike.ensureCollaborativeRunForParentTask).toHaveBeenCalledWith("parent-1");
  });

  it("does not materialize an ad-hoc team run for orchestrator-owned team children", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Reviewer",
      prompt: "Review the patch.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
      teamRunId: "team-run-1",
      teamItemId: "team-item-1",
    });

    expect(daemonLike.ensureCollaborativeRunForParentTask).not.toHaveBeenCalled();
  });

  it("keeps read-only worker roles shell-capable while denying file mutation", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue(undefined),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Researcher",
      prompt: "Inventory untracked files.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
      workerRole: "researcher",
    });

    expect(child.agentConfig?.toolRestrictions).toContain("delete_file");
    expect(child.agentConfig?.toolRestrictions).toContain("group:write");
    expect(child.agentConfig?.toolRestrictions).not.toContain("group:destructive");
  });

  it("inherits full-access shell permission for child tasks", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "parent-1",
        agentConfig: {
          permissionMode: "bypass_permissions",
          shellAccess: true,
        },
      }),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Worker",
      prompt: "Run the delegated implementation.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
      agentConfig: {
        maxTurns: 20,
      },
    });

    expect(child.agentConfig).toEqual(
      expect.objectContaining({
        permissionMode: "bypass_permissions",
        shellAccess: true,
      }),
    );
  });

  it("does not let a legacy child permission mode bypass a parent ceiling", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "parent-1",
        agentConfig: { permissionMode: "default" },
      }),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const loadSettings = vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [],
      rules: [],
    });
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    try {
      const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
        title: "Restricted worker",
        prompt: "Inspect the repository.",
        workspaceId: "ws-1",
        parentTaskId: "parent-1",
        agentType: "sub",
        agentConfig: { permissionMode: "bypass_permissions" },
      });

      expect(child.agentConfig?.permissionMode).toBe("default");
    } finally {
      loadSettings.mockRestore();
    }
  });

  it("allows a child to select a strictly narrower profile than an explicit parent profile", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "parent-1",
        workspaceId: "ws-1",
        agentConfig: { accessProfileId: "ask_for_approval" },
      }),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const workspaceRepo = {
      findById: vi.fn().mockReturnValue({
        id: "ws-1",
        name: "Workspace",
        path: "/tmp/workspace",
        permissions: {
          read: true,
          write: true,
          delete: true,
          network: true,
          shell: true,
          sandboxType: "none",
          allowedPaths: [],
        },
      }),
    };
    const narrowProfile = {
      id: "read_only_local",
      label: "Read only local",
      description: "Read-only local worker",
      sandbox: "read-only",
      approval: "untrusted",
      reviewer: "user",
      network: "disabled",
      shellAccess: false,
    };
    const loadSettings = vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [narrowProfile],
      rules: [],
    });
    const daemonLike = {
      taskRepo,
      workspaceRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    try {
      const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
        title: "Read-only worker",
        prompt: "Inspect the repository.",
        workspaceId: "ws-1",
        parentTaskId: "parent-1",
        agentType: "sub",
        agentConfig: { accessProfileId: narrowProfile.id },
      });

      expect(child.agentConfig?.accessProfileId).toBe(narrowProfile.id);
      expect(child.agentConfig?.permissionMode).not.toBe("bypass_permissions");
    } finally {
      loadSettings.mockRestore();
    }
  });

  it("rejects a child custom profile that adds scope beyond an unscoped parent", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "parent-1",
        workspaceId: "ws-1",
        agentConfig: {},
      }),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const customProfile = {
      id: "shared_docs",
      label: "Shared docs",
      description: "Adds an external root.",
      sandbox: "workspace-write",
      approval: "on-request",
      reviewer: "user",
      network: "on-request",
      workspaceRoots: ["../shared-docs"],
    };
    const loadSettings = vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [customProfile],
      rules: [],
    });
    const daemonLike = {
      taskRepo,
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/workspace",
          permissions: {
            read: true,
            write: true,
            delete: true,
            network: true,
            shell: true,
            sandboxType: "none",
            allowedPaths: [],
          },
        }),
      },
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    try {
      const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
        title: "Scoped worker",
        prompt: "Read the shared docs.",
        workspaceId: "ws-1",
        parentTaskId: "parent-1",
        agentType: "sub",
        agentConfig: { accessProfileId: customProfile.id },
      });

      expect(child.agentConfig?.accessProfileId).toBeUndefined();
      expect(child.agentConfig?.permissionMode).toBe("default");
    } finally {
      loadSettings.mockRestore();
    }
  });

  it("maps inherited full access to approve-all for external runtime child tasks", async () => {
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "parent-1",
        agentConfig: {
          permissionMode: "bypass_permissions",
          shellAccess: true,
        },
      }),
      update: vi.fn(),
      create: vi.fn((task: Any) => ({
        id: "child-task-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...task,
      })),
    };
    const daemonLike = {
      taskRepo,
      startTask: vi.fn(),
      ensureCollaborativeRunForParentTask: vi.fn(),
    } as Any;

    const child = await AgentDaemon.prototype.createChildTask.call(daemonLike, {
      title: "Codex CLI Agent",
      prompt: "Run the delegated implementation.",
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
      agentType: "sub",
      agentConfig: {
        externalRuntime: {
          kind: "acpx",
          agent: "codex",
          sessionMode: "persistent",
          outputMode: "json",
          permissionMode: "approve-reads",
        },
      },
    });

    expect(child.agentConfig?.externalRuntime?.permissionMode).toBe("approve-all");
  });

  it("normalizes legacy read-only system role restrictions so shell permission can carry to subagents", () => {
    const daemonLike = {
      agentRoleRepo: {
        findById: vi.fn().mockReturnValue({
          id: "role-reviewer",
          name: "reviewer",
          displayName: "Code Reviewer",
          isSystem: true,
          toolRestrictions: { deniedTools: ["group:write", "group:destructive"] },
        }),
      },
    } as Any;

    const result = (AgentDaemon.prototype as Any).applyAgentRoleOverrides.call(daemonLike, {
      id: "task-1",
      assignedAgentRoleId: "role-reviewer",
      agentConfig: { toolRestrictions: ["group:destructive"] },
    });

    expect(result.changed).toBe(true);
    expect(result.task.agentConfig.toolRestrictions).toContain("group:write");
    expect(result.task.agentConfig.toolRestrictions).toContain("delete_file");
    expect(result.task.agentConfig.toolRestrictions).not.toContain("group:destructive");
  });

  it("keeps read-only helper child tasks shell-capable", async () => {
    const createChildTask = vi.fn().mockResolvedValue({ id: "child-task-1" });
    const daemonLike = {
      createChildTask,
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "child-task-1",
          status: "completed",
          resultSummary: "done",
        }),
      },
    } as Any;

    const result = await (AgentDaemon.prototype as Any).runReadOnlyChildTaskAndWait.call(
      daemonLike,
      {
        parentTask: { id: "parent-1", workspaceId: "ws-1", depth: 0 },
        title: "Read-only check",
        prompt: "Check git state.",
        timeoutMs: 10,
      },
    );

    expect(result.status).toBe("completed");
    expect(createChildTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          toolRestrictions: ["group:write", "delete_file", "group:image"],
        }),
      }),
    );
  });
});
