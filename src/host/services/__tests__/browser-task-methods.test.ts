import { describe, expect, it, vi } from "vitest";
import type { Task, Workspace } from "../../../shared/types";
import { TaskAdmissionConflictError } from "../../../electron/control-plane/task-admission-service";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../../shared/access-profiles";
import { createBrowserTaskMethods, type BrowserTaskCommands } from "../browser-task-methods";

const task = {
  id: "task-1",
  title: "Analyze data",
  status: "queued",
  workspaceId: "workspace-1",
  prompt: "private prompt",
} as Task;
const workspace = { id: "workspace-1", isTemp: false } as Workspace;
const context = {
  audience: "control-plane",
  identity: {
    installationId: "installation",
    profileId: "profile",
    generation: "generation",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "1.0.0",
  },
  sessionId: "session",
  operationKey: "request-12345678",
};

function commands(): BrowserTaskCommands {
  return {
    createTaskIdempotent: vi.fn().mockResolvedValue({ task, replayed: false }),
    startAdmittedTask: vi.fn().mockResolvedValue(undefined),
    getTaskAdmission: vi.fn().mockResolvedValue({ found: false }),
  };
}

describe("browser task methods", () => {
  it("admits and wakes one scoped task without returning its private prompt", async () => {
    const taskCommands = commands();
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
    });
    const params = methods["task.create"].validateParams!({
      title: " Analyze data ",
      prompt: " private prompt ",
      workspaceId: "workspace-1",
    });
    const result = await methods["task.create"].handler(context, params);

    expect(taskCommands.createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: "web:control-plane:request-12345678",
        title: "Analyze data",
        prompt: "private prompt",
        agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval },
        autoStart: false,
      }),
    );
    expect(taskCommands.startAdmittedTask).toHaveBeenCalledWith(
      "web:control-plane:request-12345678",
      "task-1",
    );
    expect(result).toMatchObject({ taskId: "task-1", replayed: false });
    expect(JSON.stringify(result)).not.toContain("private prompt");
  });

  it("keeps supported composer options in the durable identity and assigned role override", async () => {
    const taskCommands = commands();
    const roleId = "d8b316ab-ade0-4d7a-94a8-ea1ea8d798ab";
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
      isActiveAgentRole: async (id) => id === roleId,
    });
    const request = {
      title: "Plan the migration",
      prompt: "Review the schema and propose steps",
      workspaceId: "workspace-1",
      assignedAgentRoleId: roleId,
      agentConfig: {
        interactionMode: { mode: "smart", executionOverride: "plan" },
        taskDomain: "code",
        chronicleMode: "enabled",
        providerType: "openai",
        modelKey: "gpt-4.1",
        llmProfile: "strong",
        accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      },
    };
    const parsed = methods["task.create"].validateParams!(request);
    await methods["task.create"].handler(context, parsed);

    expect(taskCommands.createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: request.agentConfig,
        taskOverrides: { assignedAgentRoleId: roleId },
        requestIdentity: expect.objectContaining({
          assignedAgentRoleId: roleId,
          agentConfig: request.agentConfig,
        }),
      }),
    );
  });

  it("rejects unsafe task fields, unknown access profiles, and unavailable assigned roles", async () => {
    const methods = createBrowserTaskMethods({
      commands: commands(),
      getWorkspace: async () => workspace,
      isActiveAgentRole: async () => false,
    });
    const base = { title: "Task", prompt: "Do work", workspaceId: "workspace-1" };

    expect(() =>
      methods["task.create"].validateParams!({
        ...base,
        agentConfig: { bypassQueue: true },
      }),
    ).toThrowError();
    expect(() =>
      methods["task.create"].validateParams!({
        ...base,
        agentConfig: { accessProfileId: "missing_profile" },
      }),
    ).toThrowError();

    const roleRequest = methods["task.create"].validateParams!({
      ...base,
      assignedAgentRoleId: "d8b316ab-ade0-4d7a-94a8-ea1ea8d798ab",
    });
    await expect(methods["task.create"].handler(context, roleRequest)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("accepts desktop task controls while retaining the default access profile", async () => {
    const taskCommands = commands();
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
    });
    const config = {
      autonomousMode: true,
      humanInputPolicy: "hard_blockers",
      multitaskMode: true,
      multitaskLaneCount: 3,
      permissionMode: "default",
      shellAccess: false,
    };
    const request = methods["task.create"].validateParams!({
      title: "Task",
      prompt: "Do work",
      workspaceId: workspace.id,
      agentConfig: config,
    });
    await methods["task.create"].handler(context, request);
    expect(taskCommands.createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: { ...config, accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval },
      }),
    );
    expect(() =>
      methods["task.create"].validateParams!({
        title: "Task",
        prompt: "Do work",
        workspaceId: workspace.id,
        agentConfig: { multitaskLaneCount: 99 },
      }),
    ).toThrow();
  });

  it("always defaults task access to Ask for approval", async () => {
    const taskCommands = commands();
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
    });
    const params = methods["task.create"].validateParams!({
      title: "Task",
      prompt: "Do work",
      workspaceId: "workspace-1",
      agentConfig: { taskDomain: "research" },
    });
    await methods["task.create"].handler(context, params);

    expect(taskCommands.createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: {
          taskDomain: "research",
          accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
        },
      }),
    );
  });

  it("preserves the admitted task identity when waking fails, for same-key reconciliation", async () => {
    const taskCommands = commands();
    vi.mocked(taskCommands.startAdmittedTask).mockRejectedValueOnce(new Error("queue unavailable"));
    vi.mocked(taskCommands.getTaskAdmission).mockResolvedValueOnce({
      found: true,
      operationKey: "web:control-plane:request-12345678",
      taskId: "task-1",
      task,
      createdAt: 1,
    });
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
    });
    await expect(
      methods["task.create"].handler(
        context,
        methods["task.create"].validateParams!({
          title: "Analyze data",
          prompt: "private prompt",
          workspaceId: "workspace-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: true });
    const status = await methods["task.admission.get"].handler(
      context,
      methods["task.admission.get"].validateParams!({ operationKey: "request-12345678" }),
    );
    expect(status).toMatchObject({ found: true, taskId: "task-1" });
    expect(JSON.stringify(status)).not.toContain("private prompt");
  });

  it("rejects missing workspaces and translates same-key conflicts", async () => {
    const taskCommands = commands();
    const unavailable = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => null,
    });
    const params = unavailable["task.create"].validateParams!({
      title: "Task",
      prompt: "Do work",
      workspaceId: "missing",
    });
    await expect(unavailable["task.create"].handler(context, params)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(taskCommands.createTaskIdempotent).not.toHaveBeenCalled();

    vi.mocked(taskCommands.createTaskIdempotent).mockRejectedValueOnce(
      new TaskAdmissionConflictError("request-12345678", "task-elsewhere"),
    );
    const methods = createBrowserTaskMethods({
      commands: taskCommands,
      getWorkspace: async () => workspace,
    });
    await expect(methods["task.create"].handler(context, params)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
