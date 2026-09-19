import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { buildTaskAutomationCronJobCreate, buildTaskRoutineCreate } from "../task-automation-utils";

const task = {
  id: "task-1",
  title: "Bot task",
  prompt: "Check status",
  workspaceId: "workspace-1",
  assignedAgentRoleId: "agent-1",
  createdAt: 1,
  updatedAt: 1,
  status: "completed",
} as Task;

describe("task automation role propagation", () => {
  it("keeps the source role in routine metadata and cron jobs", () => {
    const routine = buildTaskRoutineCreate({
      task,
      workspace: null,
      name: "Bot routine",
      prompt: "Check status",
      runMode: "chat",
      triggerPreset: "daily",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      deeplink: "",
    });
    const cron = buildTaskAutomationCronJobCreate({
      task,
      workspace: null,
      name: "Bot cron",
      prompt: "Check status",
      runMode: "chat",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      deeplink: "",
    });

    expect(routine.contextBindings.metadata.assignedAgentRoleId).toBe("agent-1");
    expect(cron.assignedAgentRoleId).toBe("agent-1");
  });
});
