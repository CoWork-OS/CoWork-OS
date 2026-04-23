import { describe, expect, it, vi } from "vitest";

import { TaskRepository } from "../repositories";

describe("TaskRepository.findAll", () => {
  it("uses latest-activity-first order by default", () => {
    const { repository, prepare, all } = createRepository();

    expect(repository.findAll(25, 50).map((task) => task.title)).toEqual(["Task"]);
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC"),
    );
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("COALESCE(is_pinned"));
    expect(all).toHaveBeenCalledWith(25, 50);
  });

  it("can prioritize pinned and active sessions for sidebar pagination", () => {
    const { repository, prepare, all } = createRepository();

    repository.findAll(100, 0, { prioritizeSidebar: true });

    const sql = prepare.mock.calls[0]?.[0] || "";
    expect(sql).toContain("COALESCE(is_pinned, 0) = 1");
    expect(sql).toContain("status IN ('executing', 'planning', 'interrupted', 'paused', 'blocked')");
    expect(sql).toContain("COALESCE(updated_at, created_at) DESC");
    expect(sql).toContain("created_at DESC");
    expect(all).toHaveBeenCalledWith(100, 0);
  });

  it("touches a task updated timestamp", () => {
    const beforeRow = {
      id: "task-1",
      title: "Task",
      prompt: "Task",
      status: "pending",
      workspace_id: "workspace-1",
      created_at: 1,
      updated_at: 1,
      is_pinned: 0,
    };
    const afterRow = { ...beforeRow, updated_at: 1234 };
    const get = vi.fn()
      .mockReturnValueOnce(beforeRow)
      .mockReturnValueOnce(afterRow);
    const run = vi.fn(() => ({ changes: 1 }));
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM tasks WHERE id = ?")) return { get };
      return { run };
    });
    const repository = new TaskRepository({ prepare } as unknown as ConstructorParameters<
      typeof TaskRepository
    >[0]);

    const touched = repository.touch("task-1", 1234);

    expect(run).toHaveBeenCalledWith(1234, "task-1");
    expect(touched?.updatedAt).toBe(1234);
  });
});

function createRepository() {
  const all = vi.fn(() => [
    {
      id: "task-1",
      title: "Task",
      prompt: "Task",
      status: "pending",
      workspace_id: "workspace-1",
      created_at: 1,
      updated_at: 1,
      is_pinned: 0,
    },
  ]);
  const prepare = vi.fn(() => ({ all }));
  const repository = new TaskRepository({ prepare } as unknown as ConstructorParameters<
    typeof TaskRepository
  >[0]);

  return { repository, prepare, all };
}
