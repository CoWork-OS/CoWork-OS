import { describe, expect, it } from "vitest";
import { TASK_EVENT_STATUS_MAP } from "../../shared/task-event-status-map";

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
    expect(TASK_EVENT_STATUS_MAP.approval_denied).toBe("failed");
  });

  it("does not force terminal failure on intermediate execution failures", () => {
    expect(TASK_EVENT_STATUS_MAP.step_failed).toBeUndefined();
    expect(TASK_EVENT_STATUS_MAP.verification_failed).toBeUndefined();
  });
});
