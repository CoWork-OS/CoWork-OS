import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentTeamRun, Task, TaskEvent } from "../../../shared/types";
import { CollaborativeAgentLines, hasLiveAgentLine } from "../CollaborativeAgentLines";

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

// The strip only renders while some agent is still active, so terminal-label
// tests keep one running sibling next to the agent under test.
const runningSibling = (): Task =>
  makeTask({ id: "sibling", title: "Still running", status: "executing", createdAt: 9 });

function renderLines(childTask: Task, childEvents: TaskEvent[]): string {
  return render(
    React.createElement(CollaborativeAgentLines, {
      collaborativeRun: makeRun(),
      childTasks: [childTask, runningSibling()],
      childEvents,
      onOpenAgent: () => undefined,
      mainTaskCompleted: true,
    }),
  );
}

describe("CollaborativeAgentLines", () => {
  it("labels a failed synthesis attempt recovered by a retry and does not count it as failed", () => {
    const markup = render(
      React.createElement(CollaborativeAgentLines, {
        collaborativeRun: makeRun({ status: "completed" }),
        childTasks: [
          makeTask({ id: "lane", title: "Operations", status: "completed", createdAt: 1 }),
          makeTask({ id: "first", title: "Synthesis", status: "failed", createdAt: 2 }),
          makeTask({ id: "retry", title: "Synthesis", status: "completed", createdAt: 3 }),
          runningSibling(),
        ],
        childEvents: [],
        onOpenAgent: () => undefined,
        mainTaskCompleted: true,
      }),
    );
    expect(markup).toContain("Retried");
    expect(markup).toContain("2 done");
    expect(markup).not.toContain("failed");
  });

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
          runningSibling(),
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

  it("hides the strip once every agent has settled", () => {
    const markup = render(
      React.createElement(CollaborativeAgentLines, {
        collaborativeRun: makeRun({ status: "completed" }),
        childTasks: [
          makeTask({ id: "done", status: "completed", completedAt: 1740841080000 }),
          makeTask({ id: "broken", status: "failed", error: "Command failed" }),
        ],
        childEvents: [],
        onOpenAgent: () => undefined,
        mainTaskCompleted: true,
      }),
    );

    expect(markup).toBe("");
  });

  it("stops counting a never-spawned team item as live once the main task finishes", () => {
    const placeholder = { statusKind: "pending" as const, task: null };
    const failed = { statusKind: "failed" as const, task: makeTask({ status: "failed" }) };
    expect(hasLiveAgentLine([failed, placeholder], false)).toBe(true);
    expect(hasLiveAgentLine([failed, placeholder], true)).toBe(false);
    const queued = { statusKind: "pending" as const, task: makeTask({ status: "pending" }) };
    expect(hasLiveAgentLine([failed, queued], true)).toBe(true);
    expect(hasLiveAgentLine([{ statusKind: "running" as const, task: null }], true)).toBe(true);
  });

  it("renders ordinary delegated children without a collaborative run", () => {
    const markup = render(
      React.createElement(CollaborativeAgentLines, {
        childTasks: [makeTask({ title: "Backend worker" })],
        childEvents: [],
        onOpenAgent: () => undefined,
        mainTaskCompleted: false,
      }),
    );

    expect(markup).toContain("1 background agents");
    expect(markup).toContain("Backend worker");
    expect(markup).toContain("Running");
    expect(markup).not.toContain("Wrap Up");
  });

  it("collapses large worker sets behind a show-all action", () => {
    const markup = render(
      React.createElement(CollaborativeAgentLines, {
        childTasks: Array.from({ length: 6 }, (_, index) =>
          makeTask({ id: `child-${index + 1}`, title: `Worker ${index + 1}` }),
        ),
        childEvents: [],
        onOpenAgent: () => undefined,
        onShowAllAgents: () => undefined,
      }),
    );

    expect(markup).toContain("Worker 1");
    expect(markup).toContain("Worker 4");
    expect(markup).not.toContain("Worker 5");
    expect(markup).toContain("Show all agents (2 more)");
  });
});
