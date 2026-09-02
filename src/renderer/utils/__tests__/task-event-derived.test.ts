import { describe, expect, it } from "vitest";

import {
  taskSurfaceFailureStormEvents,
  taskSurfaceFailureStormTask,
} from "../../perf-fixtures/task-surface-failure-storm.fixture";
import { deriveSharedTaskEventUiState } from "../task-event-derived";

function makeEvent(
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Any {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
    ...overrides,
  };
}

describe("deriveSharedTaskEventUiState action blocks", () => {
  it("keeps only genuinely pending approvals in compact projection", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("resolved-request", 100, "approval_requested", {
          approval: { id: "approval-1", status: "pending" },
        }),
        makeEvent("resolved-grant", 110, "approval_granted", {
          approvalId: "approval-1",
        }),
        makeEvent("auto-request", 120, "approval_requested", {
          approval: { id: "approval-2", status: "approved" },
          autoApproved: true,
        }),
        makeEvent("pending-request", 130, "approval_requested", {
          approval: { id: "approval-3", status: "pending" },
        }),
      ],
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
    });

    expect(shared.filteredEvents.map((event) => event.id)).toEqual(["pending-request"]);
  });

  it("does not resurrect a resolved approval when the grant falls outside the live window", () => {
    const rawEvents = [
      makeEvent("request", 1, "approval_requested", {
        approval: { id: "approval-1", status: "pending" },
      }),
      makeEvent("grant", 2, "approval_granted", { approvalId: "approval-1" }),
      ...Array.from({ length: 200 }, (_, index) =>
        makeEvent(`progress-${index}`, index + 3, "progress_update", {
          message: `Progress ${index}`,
        }),
      ),
    ];
    const shared = deriveSharedTaskEventUiState({
      rawEvents,
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
      liveWindowSize: 20,
    });

    expect(shared.normalizedEvents.some((event) => event.id === "request")).toBe(true);
    expect(shared.filteredEvents.some((event) => event.id === "request")).toBe(false);
  });

  it("surfaces connector-only work as the compact activity instead of approval narration", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("request", 1, "approval_requested", {
          approval: { id: "approval-1", status: "approved" },
          autoApproved: true,
        }),
        makeEvent("call", 2, "tool_call", { tool: "gmail_send_email" }),
        makeEvent("result", 3, "tool_result", {
          tool: "gmail_send_email",
          result: { success: true },
        }),
        ...Array.from({ length: 200 }, (_, index) =>
          makeEvent(`progress-${index}`, index + 4, "progress_update", {
            message: `Progress ${index}`,
          }),
        ),
      ],
      task: { id: "task-1", status: "executing", updatedAt: 203 } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
    });

    expect(shared.filteredEvents).toEqual([]);
    expect(shared.activityGroups).toMatchObject([
      {
        id: "activity-fallback:task-1",
        latestActivityLabel: "Sent email",
      },
    ]);
    expect(shared.taskStatusStrip.phaseLabel).toBe("Sent email");
  });

  it("shows rename destinations instead of stale source paths", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("rename-1", 100, "file_modified", {
          action: "rename",
          from: "inbox/invoice_final_FINAL.txt",
          to: "inbox/Invoices/invoice.txt",
        }),
      ],
      task: { id: "task-1", status: "completed" } as Any,
      workspace: { path: "/workspace" } as Any,
      verboseSteps: true,
    });

    expect(shared.files.map((file) => file.path)).toEqual(["inbox/Invoices/invoice.txt"]);
  });

  it("coalesces a legacy final response that differs only by Markdown whitespace", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-final", 100, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "Finished draft.\n\nThank you,\nAlmarion\n\n```bash\n  npm test\n```",
        }),
        makeEvent("task-complete", 200, "timeline_step_finished", {
          legacyType: "task_completed",
          message: "Task completed with partial results",
          resultSummary:
            "Finished draft.\n\nThank you,  \nAlmarion\n\n  ```bash\n    npm test\n  ```",
        }),
      ],
      task: { id: "task-1", status: "completed" } as Any,
      workspace: null,
      verboseSteps: true,
    });

    expect(
      shared.baseTimelineItems
        .filter((item) => item.kind === "event")
        .map((item) => (item.kind === "event" ? item.event.id : "")),
    ).toEqual(["task-complete"]);
  });

  it("coalesces a final response when the completion has a separate semantic summary", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-final", 100, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "Final paragraph with the requested details.",
        }),
        makeEvent("task-complete", 200, "timeline_step_finished", {
          legacyType: "task_completed",
          message: "Task completed with partial results",
          resultSummary: "Final paragraph with the requested details.",
          semanticSummary: "Analyze Image .cowork/uploads/image.png",
        }),
      ],
      task: { id: "task-1", status: "completed" } as Any,
      workspace: null,
      verboseSteps: true,
    });

    expect(
      shared.baseTimelineItems
        .filter((item) => item.kind === "event")
        .map((item) => (item.kind === "event" ? item.event.id : "")),
    ).toEqual(["task-complete"]);
  });

  it("coalesces each assistant response against its own completion when a task has follow-ups", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-initial", 100, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "Initial result.",
        }),
        makeEvent("task-complete-initial", 200, "timeline_step_finished", {
          legacyType: "task_completed",
          resultSummary: "Initial result.",
        }),
        makeEvent("assistant-follow-up", 300, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "Approval was denied; no action was taken.",
        }),
        makeEvent("task-complete-follow-up", 400, "timeline_step_finished", {
          legacyType: "task_completed",
          resultSummary: "Approval was denied; no action was taken.",
        }),
      ],
      task: { id: "task-1", status: "completed" } as Any,
      workspace: null,
      verboseSteps: true,
    });

    expect(
      shared.baseTimelineItems
        .filter((item) => item.kind === "event")
        .map((item) => (item.kind === "event" ? item.event.id : "")),
    ).toEqual(["task-complete-initial", "task-complete-follow-up"]);
  });

  it("preserves a distinct assistant response before the completion", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-progress", 100, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "Here is an earlier draft.",
        }),
        makeEvent("task-complete", 200, "timeline_step_finished", {
          legacyType: "task_completed",
          resultSummary: "Here is the revised final draft.",
        }),
      ],
      task: { id: "task-1", status: "completed" } as Any,
      workspace: null,
      verboseSteps: true,
    });

    expect(
      shared.baseTimelineItems
        .filter((item) => item.kind === "event")
        .map((item) => (item.kind === "event" ? item.event.id : "")),
    ).toEqual(["assistant-progress", "task-complete"]);
  });

  it("keeps a persisted completion as the final Verbose timeline item", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("build-start", 100, "timeline_group_started", {
          stage: "BUILD",
          groupLabel: "BUILD",
          legacyType: "step_started",
        }),
        makeEvent("task-complete", 200, "timeline_step_finished", {
          legacyType: "task_completed",
          message: "Task completed successfully",
          resultSummary: "Final review with all findings.",
          terminalStatus: "ok",
        }),
        makeEvent("build-finished", 201, "timeline_group_finished", {
          stage: "BUILD",
          groupLabel: "BUILD",
          legacyType: "step_completed",
        }),
        makeEvent("deliver-start", 202, "timeline_group_started", {
          stage: "DELIVER",
          groupLabel: "DELIVER",
          legacyType: "step_started",
        }),
        makeEvent("deliver-finished", 203, "timeline_group_finished", {
          stage: "DELIVER",
          groupLabel: "DELIVER",
          legacyType: "step_completed",
        }),
      ],
      task: {
        id: "task-1",
        status: "completed",
      } as Any,
      workspace: null,
      verboseSteps: true,
    });

    const finalItem = shared.baseTimelineItems.at(-1);
    expect(finalItem?.kind).toBe("event");
    if (finalItem?.kind !== "event") {
      throw new Error("Expected a final completion event");
    }
    expect(finalItem.event.id).toBe("task-complete");
  });

  it("keeps a stable action-block id while the same block grows", () => {
    const baseEvents = [
      makeEvent("user-1", 100, "user_message", { message: "check steps" }),
      makeEvent("step-1", 200, "timeline_step_started", {
        legacyType: "step_started",
        message: "first",
      }),
      makeEvent("step-2", 300, "timeline_step_updated", {
        legacyType: "progress_update",
        message: "second",
      }),
    ];

    const initial = deriveSharedTaskEventUiState({
      rawEvents: baseEvents,
      task: null,
      workspace: null,
      verboseSteps: false,
    });
    const initialBlock = initial.baseTimelineItems.find((item) => item.kind === "action_block");

    const grown = deriveSharedTaskEventUiState({
      rawEvents: [
        ...baseEvents,
        makeEvent("step-3", 400, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "third",
        }),
      ],
      task: null,
      workspace: null,
      verboseSteps: false,
    });
    const grownBlock = grown.baseTimelineItems.find((item) => item.kind === "action_block");

    expect(initialBlock?.kind).toBe("action_block");
    expect(grownBlock?.kind).toBe("action_block");
    expect(initialBlock?.blockId).toBe("action-block:step-1");
    expect(grownBlock?.blockId).toBe(initialBlock?.blockId);
  });

  it("keeps internal assistant media directives visible and exposes them as files", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-preview", 200, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: true,
          message:
            'Rendered.\n\n::video{path="artifacts/hyperframes-demo.mp4" title="HyperFrames Demo" muted=true loop=true}',
        }),
        makeEvent("task-complete", 300, "task_completed", {
          resultSummary: "Completed without output summary metadata.",
        }),
      ],
      task: {
        id: "task-1",
        status: "completed",
      } as Any,
      workspace: {
        id: "workspace-1",
        path: "/workspace",
      } as Any,
      verboseSteps: false,
    });

    expect(shared.filteredEvents.map((event) => event.id)).toContain("assistant-preview");
    expect(shared.outputSummary?.primaryOutputPath).toBe("artifacts/hyperframes-demo.mp4");
    expect(shared.files.map((file) => file.path)).toContain("artifacts/hyperframes-demo.mp4");
  });

  it("bounds live projection while retaining required anchors", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: taskSurfaceFailureStormEvents,
      task: taskSurfaceFailureStormTask,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
      liveWindowSize: 160,
    });

    const ids = new Set(shared.normalizedEvents.map((event) => event.id));
    expect(shared.projectionMode).toBe("live");
    expect(shared.rawEventCount).toBeGreaterThan(600);
    expect(shared.normalizedEvents.length).toBeLessThanOrEqual(167);
    expect(ids.has("user-1")).toBe(true);
    expect(ids.has("assistant-2")).toBe(true);
    expect(ids.has("artifact-1")).toBe(true);
    expect(ids.has("terminal-1")).toBe(true);
  });

  it("coalesces identical provider failures in live projection", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("user-1", 100, "user_message", { message: "search" }),
        makeEvent("error-1", 1_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
        makeEvent("error-2", 5_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
        makeEvent("error-3", 13_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
      ],
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
    });

    expect(shared.filteredEvents.map((event) => event.id)).toEqual([
      "user-1",
      "error-1",
      "error-3",
    ]);
  });

  it("does not force internal assistant recovery text into the live feed", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("user-1", 100, "user_message", { message: "fetch" }),
        makeEvent("assistant-internal", 200, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: true,
          message: "200",
        }),
        makeEvent("assistant-visible", 300, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: false,
          message: "The fetch was blocked by policy, so no status was available.",
        }),
        makeEvent("failure", 400, "timeline_step_finished", {
          legacyType: "step_failed",
          message: "Network access is disabled.",
        }),
      ],
      task: { id: "task-1", status: "failed" } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
    });

    expect(shared.filteredEvents.map((event) => event.id)).toEqual([
      "user-1",
      "assistant-visible",
      "failure",
    ]);
  });

  it("deduplicates matching visible failed-step and timeline error events", () => {
    const reason =
      "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 5 reached without successful file/canvas mutation.";
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent(
          "step-failed",
          1_000,
          "timeline_step_finished",
          {
            legacyType: "step_failed",
            message: reason,
            reason,
            step: { id: "step-1", description: "Applying fixes", error: reason },
          },
          { status: "failed", stepId: "step-1" },
        ),
        makeEvent("hidden-progress", 1_001, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Internal progress",
        }),
        makeEvent("matching-error", 1_002, "timeline_error", { message: reason }),
      ],
      task: { id: "task-1", status: "failed" } as Any,
      workspace: null,
      verboseSteps: false,
    });

    expect(shared.filteredEvents.map((event) => event.id)).toEqual(["step-failed"]);
  });

  it("limits command output sessions when more sessions are running than the UI budget", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: Array.from({ length: 20 }, (_, index) =>
        makeEvent(`command-${index}`, 1_000 + index, "command_output", {
          type: "start",
          command: `node script-${index}.js`,
          output: `$ node script-${index}.js\n`,
        }),
      ),
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
    });

    expect(shared.commandOutputSessions).toHaveLength(12);
    expect(shared.commandOutputSessions.every((session) => session.isRunning)).toBe(true);
    expect(shared.commandOutputSessions[0].command).toBe("node script-8.js");
  });

  it("retains early plan and impact state outside the bounded live transcript", () => {
    const rawEvents = [
      makeEvent("plan", 1, "plan_created", {
        revision: 1,
        plan: {
          steps: [
            { id: "research", description: "Research", status: "in_progress" },
            { id: "write", description: "Write", status: "pending" },
          ],
        },
      }),
      makeEvent("impact", 2, "task_impact_updated", {
        replaceProvenance: "task_mutation_ledger",
        metrics: [
          {
            id: "task-1:mutation:files_changed",
            kind: "files_changed",
            value: 3,
            provenance: "task_mutation_ledger",
            sourceEventIds: ["file-1"],
            revision: 1,
            updatedAt: 2,
          },
        ],
      }),
      ...Array.from({ length: 200 }, (_, index) =>
        makeEvent(`tool-${index}`, index + 3, "tool_call", { tool: "read_file" }),
      ),
    ];
    const shared = deriveSharedTaskEventUiState({
      rawEvents,
      task: { id: "task-1", status: "executing", updatedAt: 203 } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
      liveWindowSize: 20,
    });

    expect(shared.normalizedEvents).toHaveLength(20);
    expect(shared.planSteps.map((step) => step.id)).toEqual(["research", "write"]);
    expect(shared.taskStatusStrip.primaryLabel).toBe("Step 1 / 2");
    expect(shared.outcomeMetrics).toEqual([
      expect.objectContaining({ kind: "files_changed", value: 3 }),
    ]);
  });
});
