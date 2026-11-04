import { describe, expect, it } from "vitest";

import { isStartedTaskStatusEvent } from "../SuggestedTasksCard";

describe("isStartedTaskStatusEvent", () => {
  it("recognizes a started task finishing from its live timeline event", () => {
    expect(
      isStartedTaskStatusEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        status: "completed",
        payload: { legacyType: "task_completed", message: "Task completed successfully" },
      }),
    ).toBe(true);
  });

  it("recognizes live failures and cancellations", () => {
    expect(isStartedTaskStatusEvent({ taskId: "t1", type: "timeline_error", payload: {} })).toBe(
      true,
    );
    expect(
      isStartedTaskStatusEvent({
        taskId: "t1",
        type: "timeline_step_finished",
        status: "cancelled",
      }),
    ).toBe(true);
  });

  it("ignores ordinary progress", () => {
    expect(
      isStartedTaskStatusEvent({
        taskId: "t1",
        type: "timeline_step_updated",
        payload: { legacyType: "progress_update" },
      }),
    ).toBe(false);
    expect(isStartedTaskStatusEvent(null)).toBe(false);
  });

  it("still accepts raw status events", () => {
    expect(isStartedTaskStatusEvent({ taskId: "t1", type: "task_completed" })).toBe(true);
  });
});
