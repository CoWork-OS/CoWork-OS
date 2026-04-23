import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { getEffectiveTaskEventType, getTimelineErrorText } from "../task-event-compat";

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

describe("getEffectiveTaskEventType", () => {
  it("keeps timeline_error distinct from terminal error events", () => {
    expect(
      getEffectiveTaskEventType({
        type: "timeline_error",
        status: "failed",
        payload: {
          message: "Completion blocked by unresolved failed step",
          legacyType: "error",
        },
      }),
    ).toBe("timeline_error");
  });

  it("prefers explicit legacyType on timeline events", () => {
    expect(
      getEffectiveTaskEventType(
        makeEvent(
          "timeline_step_finished",
          { message: "Task completed successfully" },
          { legacyType: "task_completed" },
        ),
      ),
    ).toBe("task_completed");
  });

  it("infers task_completed for timeline_step_finished with completion payload", () => {
    expect(
      getEffectiveTaskEventType(
        makeEvent("timeline_step_finished", {
          message: "Task completed successfully",
          resultSummary: "Done",
          terminalStatus: "ok",
        }),
      ),
    ).toBe("task_completed");
  });

  it("infers task_completed when semantic or verification summaries are present", () => {
    expect(
      getEffectiveTaskEventType(
        makeEvent("timeline_step_finished", {
          semanticSummary: "Read auth config",
          verificationVerdict: "PASS",
        }),
      ),
    ).toBe("task_completed");
  });

  it("keeps regular step completion as step_completed", () => {
    expect(
      getEffectiveTaskEventType(
        makeEvent("timeline_step_finished", {
          message: "Completed step 2",
          stepId: "step-2",
        }),
      ),
    ).toBe("step_completed");
  });
});

describe("getTimelineErrorText", () => {
  it("falls back to payload.error for timeline_error events", () => {
    expect(
      getTimelineErrorText(
        makeEvent("timeline_error", {
          legacyType: "tool_error",
          error: "The controlled window \"Calculator\" is no longer available.",
        }),
      ),
    ).toBe('The controlled window "Calculator" is no longer available.');
  });
});
