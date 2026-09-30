import { describe, expect, it } from "vitest";
import type { Task, Workspace } from "../../../shared/types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../../shared/access-profiles";
import { WebApplicationError } from "../../web/WebApplication";
import { createBrowserDesktopReadMethods } from "../browser-desktop-read-methods";

const allowedWorkspace: Workspace = {
  id: "work-1",
  name: "Allowed",
  path: "/private/work",
  createdAt: 1,
  permissions: { read: true, write: false, delete: false, network: false, shell: false },
};
const deniedWorkspace: Workspace = {
  ...allowedWorkspace,
  id: "work-2",
  name: "Denied",
  path: "/private/denied",
  permissions: { ...allowedWorkspace.permissions, read: false },
};
const task: Task = {
  id: "task-1",
  title: "Inspect data",
  prompt: "Summarize the CSV",
  status: "completed",
  workspaceId: allowedWorkspace.id,
  createdAt: 2,
  updatedAt: 3,
};

describe("shared renderer browser reads", () => {
  it("returns only readable workspace paths with effective permission bits", async () => {
    const methods = createBrowserDesktopReadMethods({
      listWorkspaces: async () => [allowedWorkspace, deniedWorkspace],
      resolveWorkspace: async (id) =>
        id === allowedWorkspace.id ? allowedWorkspace : deniedWorkspace,
      getTask: async () => null,
    });
    const result = await methods["desktop.workspace.list"].handler(null as never, {});
    expect(result).toEqual({ workspaces: [allowedWorkspace] });
  });

  it("refuses task detail after workspace read access is revoked", async () => {
    const methods = createBrowserDesktopReadMethods({
      listWorkspaces: async () => [allowedWorkspace],
      resolveWorkspace: async () => deniedWorkspace,
      getTask: async () => task,
    });
    await expect(
      methods["desktop.task.get"].handler(null as never, { taskId: task.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    } satisfies Partial<WebApplicationError>);
  });

  it("returns the selected task's real access profile without its full configuration", async () => {
    const methods = createBrowserDesktopReadMethods({
      listWorkspaces: async () => [allowedWorkspace],
      resolveWorkspace: async () => allowedWorkspace,
      getTask: async () => ({
        ...task,
        agentConfig: {
          accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
          modelKey: "internal-model-selection",
        },
      }),
    });
    const result = await methods["desktop.task.get"].handler(null as never, {
      taskId: task.id,
    });
    expect(result).toMatchObject({
      task: { agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.fullAccess } },
    });
    expect(JSON.stringify(result)).not.toContain("internal-model-selection");
  });
});
