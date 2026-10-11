import { describe, expect, it } from "vitest";
import { getTaskEventStatus, TASK_EVENT_STATUS_MAP } from "../../shared/task-event-status-map";

describe("TASK_EVENT_STATUS_MAP", () => {
  it("maps the core lifecycle events used by renderer task status tracking", () => {
    expect(TASK_EVENT_STATUS_MAP.task_created).toBe("pending");
    expect(TASK_EVENT_STATUS_MAP.task_queued).toBe("queued");
    expect(TASK_EVENT_STATUS_MAP.task_dequeued).toBe("planning");
    expect(TASK_EVENT_STATUS_MAP.executing).toBe("executing");
    expect(TASK_EVENT_STATUS_MAP.artifact_created).toBe("executing");
    expect(TASK_EVENT_STATUS_MAP.task_paused).toBe("paused");
    expect(TASK_EVENT_STATUS_MAP.task_completed).toBe("completed");
    expect(TASK_EVENT_STATUS_MAP.error).toBe("failed");
    expect(TASK_EVENT_STATUS_MAP.task_cancelled).toBe("cancelled");
    expect(TASK_EVENT_STATUS_MAP.task_interrupted).toBe("interrupted");
  });

  it("keeps approval event semantics stable", () => {
    expect(TASK_EVENT_STATUS_MAP.approval_requested).toBe("blocked");
    expect(TASK_EVENT_STATUS_MAP.approval_granted).toBe("executing");
    expect(TASK_EVENT_STATUS_MAP.approval_denied).toBe("paused");
  });

  it("tracks structured input-request lifecycle semantics", () => {
    expect(TASK_EVENT_STATUS_MAP.input_request_created).toBe("paused");
    expect(TASK_EVENT_STATUS_MAP.input_request_resolved).toBe("executing");
    expect(TASK_EVENT_STATUS_MAP.input_request_dismissed).toBe("paused");
  });

  it("does not force terminal failure on intermediate execution failures", () => {
    expect(TASK_EVENT_STATUS_MAP.auto_continuation_blocked).toBe("paused");
    expect(TASK_EVENT_STATUS_MAP.no_progress_circuit_breaker).toBe("paused");
    expect(TASK_EVENT_STATUS_MAP.step_failed).toBeUndefined();
    expect(TASK_EVENT_STATUS_MAP.verification_failed).toBeUndefined();
    expect(TASK_EVENT_STATUS_MAP.timeline_error).toBeUndefined();
  });
});

describe("getTaskEventStatus", () => {
  it("keeps an approval dismissal paused through its final progress update", () => {
    const sequence = [
      { type: "input_request_dismissed", payload: {} },
      { type: "tool_error", payload: { error: "User denied command execution" } },
      { type: "task_paused", payload: {} },
      {
        type: "progress_update",
        payload: { phase: "execution", message: "Paused - awaiting user input" },
      },
    ];
    expect(sequence.map((event) => getTaskEventStatus(event.type, event.payload)).at(-1)).toBe(
      "paused",
    );
  });

  it("keeps a live timeline envelope of the pause progress update paused", () => {
    expect(
      getTaskEventStatus("timeline_step_updated", {
        legacyType: "progress_update",
        message: "Paused - awaiting user input",
      }),
    ).toBe("paused");
  });

  it("keeps ordinary progress active and allows explicit resumption", () => {
    expect(getTaskEventStatus("progress_update", { message: "Running a command" })).toBe(
      "executing",
    );
    expect(getTaskEventStatus("task_resumed", {})).toBe("executing");
    expect(getTaskEventStatus("task_status", { status: "cancelled" })).toBe("cancelled");
  });
});
