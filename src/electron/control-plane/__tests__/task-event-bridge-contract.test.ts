import { describe, expect, it } from "vitest";
import { TASK_EVENT_BRIDGE_ALLOWLIST } from "../task-event-bridge-contract";

describe("TASK_EVENT_BRIDGE_ALLOWLIST", () => {
  it("contains the required task lifecycle and follow-up related bridge events", () => {
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_created");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_queued");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_dequeued");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_paused");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_resumed");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_cancelled");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_completed");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("assistant_message");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("user_message");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("progress_update");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("step_started");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("step_completed");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("step_failed");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("error");
  });

  it("does not contain duplicate event names", () => {
    const unique = new Set(TASK_EVENT_BRIDGE_ALLOWLIST);
    expect(unique.size).toBe(TASK_EVENT_BRIDGE_ALLOWLIST.length);
  });
});
