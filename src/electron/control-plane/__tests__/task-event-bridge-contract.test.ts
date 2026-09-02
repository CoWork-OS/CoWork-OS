import { describe, expect, it } from "vitest";
import { TASK_EVENT_BRIDGE_ALLOWLIST } from "../task-event-bridge-contract";

describe("TASK_EVENT_BRIDGE_ALLOWLIST", () => {
  it("contains the canonical timeline v2 bridge events", () => {
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("approval_requested");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("approval_granted");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("approval_denied");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("input_request_created");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("input_request_resolved");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("input_request_dismissed");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_group_started");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_group_finished");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_step_started");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_step_updated");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_step_finished");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_evidence_attached");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_artifact_emitted");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_command_output");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("timeline_error");
    expect(TASK_EVENT_BRIDGE_ALLOWLIST).toContain("task_impact_updated");
  });

  it("does not contain duplicate event names", () => {
    const unique = new Set(TASK_EVENT_BRIDGE_ALLOWLIST);
    expect(unique.size).toBe(TASK_EVENT_BRIDGE_ALLOWLIST.length);
  });
});
