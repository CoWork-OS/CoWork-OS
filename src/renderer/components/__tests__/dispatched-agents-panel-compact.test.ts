import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Task, TaskEvent } from "../../../shared/types";
import { DispatchedAgentsPanel } from "../DispatchedAgentsPanel";

const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "child-1",
    parentTaskId: "parent-1",
    title: "@researcher: Researcher",
    prompt: "Investigate issue",
    status: "executing",
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

describe("DispatchedAgentsPanel compact stream rows", () => {
  it("renders compact inline time rows for step and progress events", () => {
    const childTasks = [makeTask()];
    const childEvents = [
      makeEvent("step_started", 1740840900000, { description: "collect requirements" }),
      makeEvent("progress_update", 1740840960000, {
        message: "reviewing workspace notes for edge cases",
      }),
      makeEvent("step_completed", 1740841020000, { description: "collect requirements" }),
    ];

    const markup = render(
      React.createElement(DispatchedAgentsPanel, {
        parentTaskId: "parent-1",
        childTasks,
        childEvents,
      }),
    );

    expect(markup).toContain("stream-event-row");
    expect(markup).toContain("stream-event-time thought-time");
    expect(markup).toContain("step-progress");
    expect(markup).not.toContain("thought-footer");
    expect(markup).toMatchSnapshot();
  });

  it("keeps assistant messages on legacy bubble footer layout", () => {
    const childTasks = [makeTask()];
    const childEvents = [
      makeEvent("assistant_message", 1740840900000, {
        message: "Drafting summary and preparing next actions.",
      }),
    ];

    const markup = render(
      React.createElement(DispatchedAgentsPanel, {
        parentTaskId: "parent-1",
        childTasks,
        childEvents,
      }),
    );

    expect(markup).toContain("thought-footer");
    expect(markup).not.toContain("stream-event-row");
    expect(markup).toMatchSnapshot();
  });

  it("marks agent chips as sidebar-openable when a sidebar handler is provided", () => {
    const markup = render(
      React.createElement(DispatchedAgentsPanel, {
        parentTaskId: "parent-1",
        childTasks: [makeTask()],
        childEvents: [],
        onOpenChildAgentSidebar: () => undefined,
      }),
    );

    expect(markup).toContain("cursor:pointer");
    expect(markup).toContain("Click to view agent");
  });
});
