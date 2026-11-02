import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import { isAutomatedTaskLike, isSpeculativeTask } from "../../shared/automated-task-detection";
import { isAutomatedSession } from "../components/Sidebar";

const task = (overrides: Partial<Task>): Task => ({
  id: "task-1",
  title: "Speculative fix: export crashes",
  prompt: "Reproduce first",
  status: "executing",
  workspaceId: "workspace-1",
  createdAt: 1,
  updatedAt: 1,
  source: "hook",
  ...overrides,
});

describe("speculative fix sessions in the sidebar", () => {
  it("files a speculative worker with automated sessions, not the user's", () => {
    const speculative = task({ agentConfig: { speculative: true, speculativeRunId: "run-1" } });
    expect(isSpeculativeTask(speculative)).toBe(true);
    expect(isAutomatedSession(speculative)).toBe(true);
    expect(isAutomatedSession(task({}))).toBe(false);
  });

  it("does not make the worker an automated task, so its new test files stay in place", () => {
    expect(isAutomatedTaskLike(task({ agentConfig: { speculative: true } }))).toBe(false);
  });
});
