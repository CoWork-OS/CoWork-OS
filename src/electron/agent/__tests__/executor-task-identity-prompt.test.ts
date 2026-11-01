import * as os from "os";
import { describe, expect, it } from "vitest";

import { TaskExecutor } from "../executor";

function executorFor(task: Record<string, unknown>): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = task;
  executor.workspace = {
    id: "ws-1",
    path: os.tmpdir(),
    permissions: { read: true, write: true, delete: false, network: false, shell: false },
  };
  return executor;
}

describe("task identity in the system prompt", () => {
  it("states the task's own ID and the IDs it came from in one line", () => {
    const prompt: string = executorFor({
      id: "task-7",
      parentTaskId: "task-3",
      agentConfig: {
        originRefs: { triggerEventId: "gateway-message-v1:abc", threadKey: "slack:C123" },
      },
    }).buildExecutionWorkspaceContextPrompt();

    const line = prompt.split("\n").find((entry) => entry.startsWith("Task references:"));
    expect(line).toContain("task_id=task-7");
    expect(line).toContain("parent_task_id=task-3");
    expect(line).toContain("trigger_event_id=gateway-message-v1:abc");
    expect(line).toContain("thread_key=slack:C123");
    expect(prompt.startsWith(`Workspace: ${os.tmpdir()}`)).toBe(true);
  });
});
