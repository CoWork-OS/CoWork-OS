import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES,
  IMPORTANT_EVENT_TYPES,
  isImportantTaskEvent,
  shouldShowTaskEventInSummaryMode,
} from "../task-event-visibility";

function makeEvent(
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id: `event-${type}`,
    taskId: "task-1",
    timestamp: Date.now(),
    schemaVersion: 2,
    type,
    payload,
    ...overrides,
  };
}

describe("task event visibility helpers", () => {
  it("includes artifact_created as an important summary event", () => {
    expect(IMPORTANT_EVENT_TYPES).toContain("artifact_created");
    expect(isImportantTaskEvent(makeEvent("artifact_created", { path: "artifacts/report.md" }))).toBe(
      true,
    );
  });

  it("keeps schedule_task tool_result visible in summary mode", () => {
    expect(isImportantTaskEvent(makeEvent("tool_result", { tool: "schedule_task" }))).toBe(true);
    expect(isImportantTaskEvent(makeEvent("tool_result", { tool: "run_command" }))).toBe(false);
  });

  it("hides timeline tool-call noise in summary mode", () => {
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", { legacyType: "tool_call", tool: "run_command" }),
      ),
    ).toBe(false);
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", { legacyType: "tool_result", tool: "run_command" }),
      ),
    ).toBe(false);
  });

  it("keeps timeline assistant messages visible in summary mode", () => {
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", {
          legacyType: "assistant_message",
          message: "High-level summary",
        }),
      ),
    ).toBe(true);
  });

  it("keeps artifact/task completion events visible in technical timeline when steps are hidden", () => {
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("artifact_created")).toBe(true);
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("task_completed")).toBe(true);
  });

  it("hides completed task stage-boundary group start events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "DELIVER" }),
        "completed",
      ),
    ).toBe(false);
  });

  it("hides completed task stage-boundary group finish events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", { stage: "DISCOVER" }),
        "completed",
      ),
    ).toBe(false);
  });

  it("keeps task_completed visible in summary mode for completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(makeEvent("task_completed", { message: "All set." }), "completed"),
    ).toBe(true);
  });

  it("keeps stage progress visible in summary mode for non-completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "BUILD" }),
        "executing",
      ),
    ).toBe(true);
  });

  it("hides stage completion churn in summary mode while task is running", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", { stage: "BUILD" }),
        "executing",
      ),
    ).toBe(false);
  });

  it("hides tool batch lane events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", {
          groupLabel: "Tool batch (8)",
          groupId: "tools:step:build:123",
        }),
        "executing",
      ),
    ).toBe(false);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", {
          groupLabel: "Follow-up tool batch",
          groupId: "tools:follow_up:build:124",
        }),
        "executing",
      ),
    ).toBe(false);
  });

  it("does not hide custom non-stage group events for completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "CUSTOM", groupId: "custom:group" }),
        "completed",
      ),
    ).toBe(true);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", {}, { groupId: "stage:custom" }),
        "completed",
      ),
    ).toBe(true);
  });
});
