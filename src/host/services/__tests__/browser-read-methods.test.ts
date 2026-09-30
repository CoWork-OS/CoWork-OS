import { describe, expect, it } from "vitest";
import { createBrowserReadMethods } from "../browser-read-methods";

const context = {
  audience: "test",
  identity: {
    installationId: "installation",
    profileId: "default",
    generation: "generation",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "test",
  },
  sessionId: "session",
};

describe("browser read methods", () => {
  it("returns task and workspace summaries without local paths or private prompt content", async () => {
    const methods = createBrowserReadMethods({
      listWorkspaces: async () => [
        { id: "workspace", name: "Work", path: "/private/host/path", createdAt: 1 },
        { id: "temp-workspace", name: "Temp", isTemp: true, path: "/private/temp" },
      ],
      listTasks: async () => [
        {
          id: "task",
          title: "Task",
          workspaceId: "workspace",
          status: "running",
          updatedAt: 2,
          prompt: "secret",
          cwd: "/private/host/path",
        },
      ],
      getTask: async () => ({ id: "task", title: "Task", status: "running", prompt: "secret" }),
    });

    const workspaces = await methods["workspace.list"].handler(context, {});
    const taskList = await methods["task.list"].handler(
      context,
      methods["task.list"].validateParams!({}),
    );
    const task = await methods["task.get"].handler(
      context,
      methods["task.get"].validateParams!({ taskId: "task" }),
    );

    expect(workspaces).toEqual({ workspaces: [{ id: "workspace", name: "Work", createdAt: 1 }] });
    expect(JSON.stringify(taskList)).not.toMatch(/secret|\/private/);
    expect(JSON.stringify(task)).not.toMatch(/secret|\/private/);
    expect(taskList).toMatchObject({ hasMore: false, tasks: [{ id: "task", title: "Task" }] });
  });

  it("rejects unbounded pagination and malformed task IDs", () => {
    const methods = createBrowserReadMethods({
      listWorkspaces: async () => [],
      listTasks: async () => [],
      getTask: async () => null,
    });
    expect(() => methods["task.list"].validateParams!({ limit: 1000 })).toThrow(
      "Invalid browser read parameters",
    );
    expect(() => methods["task.get"].validateParams!({ taskId: "" })).toThrow(
      "Invalid browser read parameters",
    );
  });

  it("passes pagination to the source and reports another page without materializing all tasks", async () => {
    let received: unknown;
    const methods = createBrowserReadMethods({
      listWorkspaces: async () => [],
      listTasks: async (params) => {
        received = params;
        return [
          { id: "one", title: "One" },
          { id: "two", title: "Two" },
          { id: "three", title: "Three" },
        ];
      },
      getTask: async () => null,
    });
    const result = await methods["task.list"].handler(
      context,
      methods["task.list"].validateParams!({ limit: 2, offset: 10, workspaceId: "workspace" }),
    );
    expect(received).toEqual({ limit: 2, offset: 10, workspaceId: "workspace" });
    expect(result).toMatchObject({
      tasks: [{ id: "one" }, { id: "two" }],
      hasMore: true,
      limit: 2,
      offset: 10,
    });
  });
});
