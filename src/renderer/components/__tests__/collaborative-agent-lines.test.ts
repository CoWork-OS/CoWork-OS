import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentTeamRun, Task, TaskEvent } from "../../../shared/types";
import { CollaborativeAgentLines } from "../CollaborativeAgentLines";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function makeRun(overrides: Partial<AgentTeamRun> = {}): AgentTeamRun {
  return {
    id: "run-1",
    rootTaskId: "parent-1",
    status: "running",
    createdAt: 1740840900000,
    updatedAt: 1740840900000,
    ...overrides,
  } as AgentTeamRun;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "child-1",
    parentTaskId: "parent-1",
    title: "Context and Scope",
    prompt: "Investigate issue",
    status: "executing",
    workspaceId: "workspace-1",
    createdAt: 1740840900000,
    updatedAt: 1740840900000,
    ...overrides,
  } as Task;
}

function makeEvent(
  type: TaskEvent["type"],
  timestamp: number,
  payload: Record<string, unknown>,
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    taskId: "child-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
    ...overrides,
  } as TaskEvent;
}

function renderLines(childTask: Task, childEvents: TaskEvent[]): string {
  return render(
    React.createElement(CollaborativeAgentLines, {
      collaborativeRun: makeRun(),
      childTasks: [childTask],
      childEvents,
      onOpenAgent: () => undefined,
      mainTaskCompleted: true,
    }),
  );
}

describe("CollaborativeAgentLines", () => {
  it("shows completed for a finished subagent instead of a later DELIVER stage start", () => {
    const markup = renderLines(makeTask({ status: "completed", completedAt: 1740841080000 }), [
      makeEvent("step_completed", 1740841020000, { description: "Collect evidence" }),
      makeEvent(
        "timeline_group_started",
        1740841080000,
        { stage: "DELIVER", message: "Starting DELIVER" },
        { groupId: "stage:deliver" },
      ),
    ]);

    expect(markup).toContain("Completed");
    expect(markup).not.toContain("Starting DELIVER");
  });

  it("surfaces failed terminal subagent status with the latest failure label", () => {
    const markup = renderLines(makeTask({ status: "failed", error: "Network lookup failed" }), [
      makeEvent("step_failed", 1740841020000, { description: "Fetch upstream release" }),
      makeEvent(
        "timeline_group_started",
        1740841080000,
        { stage: "DELIVER", message: "Starting DELIVER" },
        { groupId: "stage:deliver" },
      ),
    ]);

    expect(markup).toContain("Failed: Fetch upstream release");
    expect(markup).not.toContain("Starting DELIVER");
  });

  it("shows warnings for partial-success subagents", () => {
    const markup = renderLines(
      makeTask({
        status: "completed",
        terminalStatus: "partial_success",
        completedAt: 1740841080000,
      }),
      [
        makeEvent("step_failed", 1740841020000, { description: "Optional changelog lookup" }),
        makeEvent("task_completed", 1740841080000, { terminalStatus: "partial_success" }),
      ],
    );

    expect(markup).toContain("Needs review");
  });

  it("shows per-agent terminal chips and aggregate counts", () => {
    const markup = render(
      React.createElement(CollaborativeAgentLines, {
        collaborativeRun: makeRun(),
        childTasks: [
          makeTask({
            id: "child-1",
            title: "Finished lane",
            status: "completed",
            completedAt: 1740841080000,
          }),
          makeTask({
            id: "child-2",
            title: "Broken lane",
            status: "failed",
            error: "Command failed",
          }),
        ],
        childEvents: [
          makeEvent(
            "step_failed",
            1740841020000,
            { description: "Run verification" },
            { taskId: "child-2" },
          ),
        ],
        onOpenAgent: () => undefined,
        onWrapUp: () => undefined,
        mainTaskCompleted: false,
      }),
    );

    expect(markup).toContain("1 done · 1 failed");
    expect(markup).toContain("Done");
    expect(markup).toContain("Failed");
    expect(markup).not.toContain("failures need review");
    expect(markup).toContain("Wrap Up");
  });
});
