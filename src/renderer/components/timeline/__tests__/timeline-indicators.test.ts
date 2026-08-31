import { describe, expect, it } from "vitest";
import {
  AlertTriangle,
  Check,
  Circle,
  FileOutput,
  Loader2,
  Package,
  RotateCcw,
  Search,
  Shield,
  Terminal,
} from "lucide-react";

import type { TaskEvent } from "../../../../shared/types";
import { resolveTimelineIndicator, shouldShowTimelineBranchStub } from "../timeline-indicators";

function makeEvent(
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id: `evt-${type}`,
    taskId: "task-1",
    timestamp: 1,
    type,
    payload,
    schemaVersion: 2,
    ...overrides,
  };
}

describe("timeline indicators", () => {
  it("maps DISCOVER stage starts to Search active icon", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_group_started", { stage: "DISCOVER" }),
    );
    expect(indicator.icon).toBe(Search);
    expect(indicator.tone).toBe("active");
    expect(indicator.spin).toBeUndefined();
  });

  it("maps BUILD stage starts to Terminal active icon", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_group_started", { stage: "BUILD" }),
    );
    expect(indicator.icon).toBe(Terminal);
    expect(indicator.tone).toBe("active");
  });

  it("uses sub-stage groupLabel for FIX stage when present", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_group_started", { stage: "FIX", groupLabel: "Preparing workspace" }),
    );
    expect(indicator.label).toBe("Preparing workspace");
  });

  it("falls back to generic label when FIX stage has no sub-stage groupLabel", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_group_started", { stage: "FIX", groupLabel: "FIX" }),
    );
    expect(indicator.label).toBe("Fix stage started");
  });

  it("maps progress updates to spinning Loader2 active icon", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_step_updated", { message: "Working" }),
    );
    expect(indicator.icon).toBe(Loader2);
    expect(indicator.tone).toBe("active");
    expect(indicator.spin).toBe(true);
  });

  it("shows Check (no spin) for progress updates when task is completed", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_step_updated", { message: "Working" }),
      { isTaskCompleted: true },
    );
    expect(indicator.icon).toBe(Check);
    expect(indicator.tone).toBe("success");
    expect(indicator.spin).toBeUndefined();
  });

  it("maps failed steps to AlertTriangle error icon", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_step_finished", {}, { status: "failed" }),
    );
    expect(indicator.icon).toBe(AlertTriangle);
    expect(indicator.tone).toBe("error");
  });

  it("keeps cancelled groups and steps distinct from successful completion", () => {
    const group = resolveTimelineIndicator(
      makeEvent("timeline_group_finished", { status: "cancelled" }),
    );
    expect(group.icon).toBe(AlertTriangle);
    expect(group.tone).toBe("error");
    expect(group.label).toBe("Group cancelled");

    const step = resolveTimelineIndicator(
      makeEvent("timeline_step_finished", {}, { status: "cancelled" }),
    );
    expect(step.icon).toBe(AlertTriangle);
    expect(step.tone).toBe("error");
    expect(step.label).toBe("Step cancelled");
  });

  it("maps artifacts to FileOutput success icon", () => {
    const indicator = resolveTimelineIndicator(
      makeEvent("timeline_artifact_emitted", { path: "docs/report.md" }),
    );
    expect(indicator.icon).toBe(FileOutput);
    expect(indicator.tone).toBe("success");
  });

  it("maps verification failures to Shield warning icon", () => {
    const indicator = resolveTimelineIndicator(makeEvent("verification_failed", { attempt: 1 }));
    expect(indicator.icon).toBe(Shield);
    expect(indicator.tone).toBe("warning");
  });

  it("maps retry starts to RotateCcw active icon", () => {
    const indicator = resolveTimelineIndicator(makeEvent("retry_started", { attempt: 2 }));
    expect(indicator.icon).toBe(RotateCcw);
    expect(indicator.tone).toBe("active");
  });

  it("maps skill reads to Package icon", () => {
    const reading = resolveTimelineIndicator(
      makeEvent("tool_call", {
        tool: "read_file",
        input: { path: "/Users/test/.codex/skills/test/SKILL.md" },
      }),
    );
    expect(reading.icon).toBe(Package);
    expect(reading.tone).toBe("active");

    const read = resolveTimelineIndicator(
      makeEvent("tool_result", {
        tool: "skill",
        result: { skill_name: "Test" },
      }),
    );
    expect(read.icon).toBe(Package);
    expect(read.tone).toBe("success");
  });

  it("falls back to Circle neutral icon for unknown event types", () => {
    const indicator = resolveTimelineIndicator(makeEvent("log", { message: "debug" }));
    expect(indicator.icon).toBe(Circle);
    expect(indicator.tone).toBe("neutral");
  });

  it("shows branch stub for non-stage group ids", () => {
    const event = makeEvent("timeline_step_started", { groupId: "tools:parallel" });
    expect(shouldShowTimelineBranchStub(event)).toBe(true);
  });

  it("hides branch stub for stage group ids", () => {
    const event = makeEvent("timeline_step_started", { groupId: "stage:build" });
    expect(shouldShowTimelineBranchStub(event)).toBe(false);
  });
});
