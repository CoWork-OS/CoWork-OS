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

  it("can exclude archived sessions from task queries", () => {
    const { repository, prepare, all } = createRepository();

    repository.findAll(25, 0, { includeArchivedSessions: false });

    const sql = prepare.mock.calls[0]?.[0] || "";
    expect(sql).toContain("task_session_metadata");
    expect(sql).toContain("archived_at IS NOT NULL");
    expect(sql).toContain("COALESCE(NULLIF(tasks.session_id, ''), tasks.id)");
    expect(all).toHaveBeenCalledWith(25, 0);
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

  it("maps agent and board fields when updating tasks", () => {
    const row = {
      id: "task-1",
      title: "Task",
      prompt: "Task",
      status: "pending",
      workspace_id: "workspace-1",
      created_at: 1,
      updated_at: 1,
      is_pinned: 0,
    };
    const get = vi.fn(() => row);
    const run = vi.fn(() => ({ changes: 1 }));
    const prepare = vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM tasks WHERE id = ?")) return { get };
      return { run };
    });
    const repository = new TaskRepository({ prepare } as unknown as ConstructorParameters<
      typeof TaskRepository
    >[0]);

    repository.update("task-1", {
      assignedAgentRoleId: "agent-1",
      workerRole: "reviewer",
      boardColumn: "doing",
      priority: 7,
      dueDate: 123,
      estimatedMinutes: 45,
      actualMinutes: 30,
      awaitingUserInputReasonCode: "skill_parameters",
    });

    const updateSql = prepare.mock.calls.find(([sql]) => sql.startsWith("UPDATE tasks SET"))?.[0];
    expect(updateSql).toContain("assigned_agent_role_id = ?");
    expect(updateSql).toContain("worker_role = ?");
    expect(updateSql).toContain("board_column = ?");
    expect(updateSql).toContain("priority = ?");
    expect(updateSql).toContain("due_date = ?");
    expect(updateSql).toContain("estimated_minutes = ?");
    expect(updateSql).toContain("actual_minutes = ?");
    expect(updateSql).toContain("awaiting_user_input_reason_code = ?");
    expect(run).toHaveBeenCalledWith(
      "agent-1",
      "reviewer",
      "doing",
      7,
      123,
      45,
      30,
      "skill_parameters",
      expect.any(Number),
      "task-1",
    );
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
