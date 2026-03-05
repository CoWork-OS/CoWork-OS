import { describe, expect, it, vi } from "vitest";

import { createTimelineEmitter } from "../timeline-emitter";

describe("TimelineEmitter", () => {
  it("emits grouped tool-lane start events with maxParallel metadata", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.startGroupLane("tools:step-1:batch-1", {
      label: "Tool batch (3)",
      maxParallel: 3,
      actor: "tool",
    });

    expect(emit).toHaveBeenCalledWith(
      "timeline_group_started",
      expect.objectContaining({
        groupId: "tools:step-1:batch-1",
        groupLabel: "Tool batch (3)",
        maxParallel: 3,
        actor: "tool",
        status: "in_progress",
      }),
    );
  });

  it("emits grouped tool-lane finish events with failed status when requested", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.finishGroupLane("tools:step-1:batch-1", {
      label: "Tool batch",
      status: "failed",
      actor: "tool",
    });

    expect(emit).toHaveBeenCalledWith(
      "timeline_group_finished",
      expect.objectContaining({
        groupId: "tools:step-1:batch-1",
        groupLabel: "Tool batch",
        status: "failed",
        legacyType: "step_failed",
      }),
    );
  });

  it("emits lane step start with explicit group id", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.startStep(
      {
        id: "tool_lane:step:use-1",
        description: "Running web_search",
      },
      {
        groupId: "tools:step:build:1",
        actor: "tool",
      },
    );

    expect(emit).toHaveBeenCalledWith(
      "timeline_step_started",
      expect.objectContaining({
        stepId: "tool_lane:step:use-1",
        groupId: "tools:step:build:1",
        status: "in_progress",
        actor: "tool",
      }),
    );
  });

  it("emits lane step finish with final status and group id", () => {
    const emit = vi.fn();
    const timeline = createTimelineEmitter("task-1", emit);

    timeline.finishStep(
      {
        id: "tool_lane:follow_up:use-2",
        description: "Running web_fetch",
      },
      {
        groupId: "tools:follow_up:build:2",
        actor: "tool",
        status: "failed",
      },
    );

    expect(emit).toHaveBeenCalledWith(
      "timeline_step_finished",
      expect.objectContaining({
        stepId: "tool_lane:follow_up:use-2",
        groupId: "tools:follow_up:build:2",
        status: "failed",
        actor: "tool",
      }),
    );
  });
});
