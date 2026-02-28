import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES,
  IMPORTANT_EVENT_TYPES,
  isImportantTaskEvent,
} from "../task-event-visibility";

function makeEvent(type: TaskEvent["type"], payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `event-${type}`,
    taskId: "task-1",
    timestamp: Date.now(),
    type,
    payload,
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

  it("keeps artifact/task completion events visible in technical timeline when steps are hidden", () => {
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("artifact_created")).toBe(true);
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("task_completed")).toBe(true);
  });
});
