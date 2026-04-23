import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../types";
import {
  inferTimelineStageForLegacyType,
  inferTimelineSubStageLabel,
  normalizeTaskEventToTimelineV2,
  projectTimelineEventToLegacy,
} from "../timeline-v2";

describe("timeline v2 helpers", () => {
  it("normalizes legacy step events into timeline step lifecycle events", () => {
    const normalized = normalizeTaskEventToTimelineV2({
      taskId: "task-1",
      type: "step_completed",
      payload: {
        step: { id: "step-1", description: "Run verification" },
      },
      timestamp: 1_700_000_000_000,
      eventId: "event-1",
      seq: 12,
    });

    expect(normalized.type).toBe("timeline_step_finished");
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.status).toBe("completed");
    expect(normalized.stepId).toBe("step-1");
    expect(normalized.legacyType).toBe("step_completed");
  });

  it("projects timeline events back to legacy shape for compatibility consumers", () => {
    const projected = projectTimelineEventToLegacy({
      id: "event-2",
      taskId: "task-2",
      timestamp: 1_700_000_000_100,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        message: "Task completed successfully",
      },
      schemaVersion: 2,
      eventId: "event-2",
      seq: 22,
      ts: 1_700_000_000_100,
      status: "completed",
      stepId: "step:deliver",
      actor: "system",
    } as TaskEvent);

    expect(projected.type).toBe("task_completed");
    expect(projected.payload.message).toBe("Task completed successfully");
  });

  it("promotes legacy tool_error payload.error into timeline_error payload.message", () => {
    const normalized = normalizeTaskEventToTimelineV2({
      taskId: "task-tool-error",
      type: "tool_error",
      payload: {
        tool: "click",
        error: "ModuleNotFoundError: No module named 'Quartz'",
      },
      timestamp: 1_700_000_000_150,
      eventId: "event-tool-error",
      seq: 23,
    });

    expect(normalized.type).toBe("timeline_error");
    expect(normalized.status).toBe("failed");
    expect(normalized.legacyType).toBe("tool_error");
    expect(normalized.payload.message).toBe("ModuleNotFoundError: No module named 'Quartz'");
  });

  it("maps key legacy lifecycle events to timeline stages", () => {
    expect(inferTimelineStageForLegacyType("task_created")).toBe("DISCOVER");
    expect(inferTimelineStageForLegacyType("tool_call")).toBe("BUILD");
    expect(inferTimelineStageForLegacyType("verification_passed")).toBe("VERIFY");
    expect(inferTimelineStageForLegacyType("task_list_created")).toBe("BUILD");
    expect(inferTimelineStageForLegacyType("task_list_updated")).toBe("BUILD");
    expect(inferTimelineStageForLegacyType("task_list_verification_nudged")).toBe("VERIFY");
    expect(inferTimelineStageForLegacyType("step_failed")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("verification_mode_selected")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("verification_preflight_policy_applied")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("verification_text_checklist_evaluated")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("workspace_path_alias_normalized")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("workspace_path_alias_recovery_attempted")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("workspace_path_alias_recovery_failed")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("task_path_root_pinned")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("task_path_rewrite_applied")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("task_path_recovery_attempted")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("task_path_recovery_failed")).toBe("FIX");
    expect(
      inferTimelineStageForLegacyType("tool_disable_suppressed_recoverable_path_drift"),
    ).toBe("FIX");
    expect(inferTimelineStageForLegacyType("mutation_checkpoint_retry_applied")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("tool_protocol_violation")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("turn_window_soft_exhausted")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("safety_stop_triggered")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("turn_policy_selected")).toBeUndefined();
    expect(inferTimelineStageForLegacyType("task_completed")).toBe("DELIVER");
  });

  it("returns sub-stage labels for BUILD-stage file events", () => {
    expect(inferTimelineSubStageLabel("file_created")).toBe("Creating file");
    expect(inferTimelineSubStageLabel("file_modified")).toBe("Modifying file");
    expect(inferTimelineSubStageLabel("file_deleted")).toBe("Deleting file");
  });

  it("returns sub-stage labels for FIX-stage events", () => {
    expect(inferTimelineSubStageLabel("workspace_path_alias_normalized")).toBe("Preparing workspace");
    expect(inferTimelineSubStageLabel("task_path_root_pinned")).toBe("Preparing workspace");
    expect(inferTimelineSubStageLabel("task_list_created")).toBe("Updating checklist");
    expect(inferTimelineSubStageLabel("task_list_verification_nudged")).toBe("Preparing verification");
    expect(inferTimelineSubStageLabel("verification_preflight_policy_applied")).toBe(
      "Preparing verification",
    );
    expect(inferTimelineSubStageLabel("step_failed")).toBe("Applying fixes");
    expect(inferTimelineSubStageLabel("retry_started")).toBe("Retrying");
    expect(inferTimelineSubStageLabel("context_compaction_started")).toBe("Making room to continue");
    expect(inferTimelineSubStageLabel("verification_failed")).toBe("Verifying results");
    expect(inferTimelineSubStageLabel("plan_contract_conflict")).toBe("Adjusting approach");
    expect(inferTimelineSubStageLabel("task_created")).toBeUndefined();
    expect(inferTimelineSubStageLabel("tool_call")).toBeUndefined();
  });

  it("maps workflow_detected to a timeline group start event", () => {
    const normalized = normalizeTaskEventToTimelineV2({
      taskId: "task-wf",
      type: "workflow_detected",
      payload: {
        phaseCount: 3,
        phases: [
          { type: "research" },
          { type: "build" },
          { type: "verify" },
        ],
      },
      timestamp: 1_700_000_000_200,
      eventId: "event-workflow",
      seq: 33,
    });

    expect(normalized.type).toBe("timeline_group_started");
    expect(normalized.status).toBe("in_progress");
    expect(normalized.legacyType).toBe("workflow_detected");
  });
});
