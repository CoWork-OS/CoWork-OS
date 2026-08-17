import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES,
  filterAdjacentDuplicateTimelineFailures,
  filterVerboseTimelineNoise,
  IMPORTANT_EVENT_TYPES,
  isImportantTaskEvent,
  isLlmRequestCancelledEvent,
  shouldShowTaskEventInStepFeed,
  shouldShowTaskEventInSummaryMode,
} from "../task-event-visibility";

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

describe("task event visibility helpers", () => {
  it("includes artifact_created as an important summary event", () => {
    expect(IMPORTANT_EVENT_TYPES).toContain("artifact_created");
    expect(
      isImportantTaskEvent(makeEvent("artifact_created", { path: "artifacts/report.md" })),
    ).toBe(true);
  });

  it("keeps schedule_task tool_result visible in summary mode", () => {
    expect(isImportantTaskEvent(makeEvent("tool_result", { tool: "schedule_task" }))).toBe(true);
    expect(isImportantTaskEvent(makeEvent("tool_result", { tool: "run_command" }))).toBe(false);
  });

  it("hides timeline tool-call noise in summary mode", () => {
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", { legacyType: "tool_call", tool: "run_command" }),
      ),
    ).toBe(false);
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", { legacyType: "tool_result", tool: "run_command" }),
      ),
    ).toBe(false);
  });

  it("hides implementation-only browser action audit events from the step feed", () => {
    const browserAction = makeEvent(
      "log",
      { action: "snapshot", url: "http://localhost:5173" },
      { type: "browser_action" as TaskEvent["type"] },
    );

    expect(isImportantTaskEvent(browserAction)).toBe(false);
    expect(shouldShowTaskEventInStepFeed(browserAction, { verboseSteps: true })).toBe(false);
  });

  it("keeps canonical browser tool calls visible in the verbose step feed", () => {
    const browserToolCall = makeEvent("tool_call", {
      tool: "browser_snapshot",
      input: { session_id: "default" },
    });

    expect(shouldShowTaskEventInStepFeed(browserToolCall, { verboseSteps: true })).toBe(true);
  });

  it("keeps timeline assistant messages visible in summary mode", () => {
    expect(
      isImportantTaskEvent(
        makeEvent("timeline_step_updated", {
          legacyType: "assistant_message",
          message: "High-level summary",
        }),
      ),
    ).toBe(true);
  });

  it("keeps artifact/task completion events visible in technical timeline when steps are hidden", () => {
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("artifact_created")).toBe(true);
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("task_completed")).toBe(true);
  });

  it("keeps checklist events visible in summary and technical views", () => {
    expect(IMPORTANT_EVENT_TYPES).toContain("task_list_created");
    expect(ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has("task_list_verification_nudged")).toBe(true);
    expect(isImportantTaskEvent(makeEvent("task_list_updated", { checklist: { items: [] } }))).toBe(
      true,
    );
  });

  it("hides completed task stage-boundary group start events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "DELIVER" }),
        "completed",
      ),
    ).toBe(false);
  });

  it("hides completed task stage-boundary group finish events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", { stage: "DISCOVER" }),
        "completed",
      ),
    ).toBe(false);
  });

  it("keeps task_completed visible in summary mode for completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("task_completed", { message: "All set." }),
        "completed",
      ),
    ).toBe(true);
  });

  it("keeps follow_up_completed visible in summary mode for completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("follow_up_completed", { message: "Follow-up message processed" }),
        "completed",
      ),
    ).toBe(true);
  });

  it("hides generic stage progress in summary mode for non-completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "BUILD" }),
        "executing",
      ),
    ).toBe(false);
  });

  it("keeps sub-stage progress visible in summary mode for non-completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "FIX", groupLabel: "Preparing workspace" }),
        "executing",
      ),
    ).toBe(true);
  });

  it("hides stage completion churn in summary mode while task is running", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", { stage: "BUILD" }),
        "executing",
      ),
    ).toBe(false);
  });

  it("hides generic stage-boundary cards in the step feed", () => {
    expect(
      shouldShowTaskEventInStepFeed(makeEvent("timeline_group_started", { stage: "DISCOVER" })),
    ).toBe(false);
    expect(
      shouldShowTaskEventInStepFeed(makeEvent("timeline_group_finished", { stage: "BUILD" })),
    ).toBe(false);
  });

  it("keeps generic stage-start cards in the verbose step feed", () => {
    expect(
      shouldShowTaskEventInStepFeed(makeEvent("timeline_group_started", { stage: "DISCOVER" }), {
        verboseSteps: true,
      }),
    ).toBe(true);
    expect(
      shouldShowTaskEventInStepFeed(makeEvent("timeline_group_started", { stage: "BUILD" }), {
        verboseSteps: true,
      }),
    ).toBe(true);
  });

  it("keeps sub-stage and custom group cards in the step feed", () => {
    expect(
      shouldShowTaskEventInStepFeed(
        makeEvent("timeline_group_started", { stage: "FIX", groupLabel: "Preparing workspace" }),
      ),
    ).toBe(true);
    expect(
      shouldShowTaskEventInStepFeed(
        makeEvent("timeline_group_started", { stage: "CUSTOM", groupId: "custom:group" }),
      ),
    ).toBe(true);
  });

  it("hides tool batch lane events in summary mode", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", {
          groupLabel: "Tool batch (8)",
          groupId: "tools:step:build:123",
        }),
        "executing",
      ),
    ).toBe(false);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", {
          groupLabel: "Follow-up tool batch",
          groupId: "tools:follow_up:build:124",
        }),
        "executing",
      ),
    ).toBe(false);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_step_started", {
          groupId: "tools:step:build:123",
          step: { id: "tool_lane:step:use-1", description: "Running web_search" },
        }),
        "executing",
      ),
    ).toBe(false);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent(
          "tool_result",
          {
            groupId: "tools:step:build:123",
            tool: "web_search",
            toolUseId: "use-1",
            toolCallIndex: 1,
          },
          { groupId: "tools:step:build:123" },
        ),
        "executing",
      ),
    ).toBe(false);
  });

  it("keeps non-internal assistant timeline_step_updated events in verbose mode", () => {
    const t0 = 1_000_000;
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_step_updated",
        { legacyType: "user_message", message: "Follow-up: please keep going." },
        { id: "user-visible", timestamp: t0 },
      ),
      makeEvent(
        "timeline_step_updated",
        { message: "Progress update" },
        { id: "a", timestamp: t0 },
      ),
      makeEvent(
        "timeline_step_updated",
        { message: "Tackling: Do the real work" },
        { id: "b", timestamp: t0 + 500 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "log", message: "Execution strategy active" },
        { id: "c", timestamp: t0 + 1000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "tool_call", tool: "web_search" },
        { id: "d", timestamp: t0 + 2000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "tool_result", tool: "web_search" },
        { id: "e", timestamp: t0 + 3000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "llm_routing_changed" },
        { id: "f", timestamp: t0 + 4000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "llm_usage" },
        { id: "g", timestamp: t0 + 5000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "plan_created" },
        { id: "h", timestamp: t0 + 6000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "task_analysis" },
        { id: "i", timestamp: t0 + 7000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "progress_update", message: "Starting execution" },
        { id: "j", timestamp: t0 + 8000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "assistant_message", message: "Here is the actual response." },
        { id: "assistant-visible", timestamp: t0 + 9000 },
      ),
      makeEvent(
        "timeline_step_updated",
        {
          legacyType: "assistant_message",
          message: '::video{path="artifacts/hyperframes-demo.mp4" title="HyperFrames Demo"}',
          internal: true,
        },
        { id: "assistant-preview", timestamp: t0 + 9500 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "assistant_message", message: "OK", internal: true },
        { id: "assistant-internal", timestamp: t0 + 10000 },
      ),
    ]);
    expect(filtered.map((e) => e.id)).toEqual([
      "user-visible",
      "assistant-visible",
      "assistant-preview",
    ]);
  });

  it("keeps internal assistant frame directives visible in verbose mode", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_step_updated",
        {
          legacyType: "assistant_message",
          message: '::frame{path="artifacts/sync-status.html" title="Sync status" kind="progress"}',
          internal: true,
        },
        { id: "assistant-frame", timestamp: 1_000 },
      ),
      makeEvent(
        "timeline_step_updated",
        { legacyType: "assistant_message", message: "OK", internal: true },
        { id: "assistant-internal", timestamp: 2_000 },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["assistant-frame"]);
  });

  it("hides timeline_step_finished events but keeps task cancellation", () => {
    const t0 = 1_000_000;
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_step_finished",
        { legacyType: "step_completed", message: "glob completed" },
        { id: "a", timestamp: t0 },
      ),
      makeEvent(
        "timeline_step_finished",
        { legacyType: "step_completed", message: "list_directory completed" },
        { id: "b", timestamp: t0 + 1000 },
      ),
      makeEvent(
        "timeline_step_finished",
        { legacyType: "task_cancelled", message: "Task was stopped by user" },
        { id: "c", timestamp: t0 + 2000 },
      ),
      makeEvent(
        "timeline_step_finished",
        { message: "Step finished" },
        { id: "d", timestamp: t0 + 3000 },
      ),
    ]);
    expect(filtered.map((e) => e.id)).toEqual(["c"]);
  });

  it("keeps the completed result and hides stage chatter emitted after it", () => {
    const t0 = 1_000_000;
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_step_finished",
        {
          legacyType: "task_completed",
          message: "Task completed successfully",
          resultSummary: "Final review with all findings.",
          terminalStatus: "ok",
        },
        { id: "task-complete", timestamp: t0 },
      ),
      makeEvent(
        "timeline_group_finished",
        { stage: "BUILD", groupLabel: "BUILD", message: "Completed BUILD" },
        { id: "build-finished", timestamp: t0 + 1, groupId: "stage:build" },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "DELIVER", groupLabel: "DELIVER", message: "Starting DELIVER" },
        { id: "deliver-start", timestamp: t0 + 2, groupId: "stage:deliver" },
      ),
      makeEvent(
        "timeline_group_finished",
        { stage: "DELIVER", groupLabel: "DELIVER", message: "Completed DELIVER" },
        { id: "deliver-finished", timestamp: t0 + 3, groupId: "stage:deliver" },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["task-complete"]);
  });

  it("restores stage boundaries after a completed task receives a follow-up run", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent("task_completed", {}, { id: "completed", timestamp: 1_000 }),
      makeEvent(
        "timeline_group_finished",
        { stage: "DELIVER" },
        { id: "trailing-deliver", timestamp: 1_001 },
      ),
      makeEvent("user_message", {}, { id: "follow-up", timestamp: 2_000 }),
      makeEvent(
        "timeline_group_started",
        { stage: "BUILD" },
        { id: "resumed-build", timestamp: 2_001 },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["completed", "follow-up", "resumed-build"]);
  });

  it("keeps stage starts in verbose mode so running activity does not disappear after pause", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_group_started",
        { stage: "DISCOVER", groupLabel: "DISCOVER", message: "Starting DISCOVER" },
        { id: "discover-start" },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "BUILD", groupLabel: "BUILD", message: "Starting BUILD" },
        { id: "build-start" },
      ),
      makeEvent(
        "timeline_group_finished",
        { stage: "BUILD", groupLabel: "BUILD", message: "Completed BUILD" },
        { id: "build-finished" },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["discover-start", "build-start"]);
  });

  it("hides stage starts emitted after a blocking verbose failure", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_group_started",
        { stage: "DISCOVER", groupLabel: "DISCOVER", message: "Starting DISCOVER" },
        { id: "discover-start", timestamp: 1000 },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "BUILD", groupLabel: "BUILD", message: "Starting BUILD" },
        { id: "build-start", timestamp: 1100 },
      ),
      makeEvent(
        "timeline_error",
        {
          legacyType: "tool_error",
          tool: "get_current_location",
          error:
            "Native desktop geolocation timed out. Do not retry get_current_location in this task; ask the user for a typed address, venue, or nearby landmark.",
        },
        { id: "location-timeout", timestamp: 1200 },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "FIX", groupLabel: "Applying fixes", message: "Starting Applying fixes" },
        { id: "post-failure-fix-start", timestamp: 1300, groupId: "stage:fix" },
      ),
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom follow-up" },
        { id: "custom-after-failure", timestamp: 1400, groupId: "custom:follow-up" },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual([
      "discover-start",
      "build-start",
      "location-timeout",
      "custom-after-failure",
    ]);
  });

  it("hides request-cancelled llm errors for cancelled tasks", () => {
    const llmError = makeEvent(
      "timeline_error",
      { legacyType: "llm_error", message: "LLM API error: Request cancelled" },
      { id: "llm-cancelled" },
    );
    const taskCancelled = makeEvent(
      "timeline_step_finished",
      { legacyType: "task_cancelled", message: "Task was stopped by user" },
      { id: "task-cancelled" },
    );

    expect(isLlmRequestCancelledEvent(llmError)).toBe(true);
    expect(shouldShowTaskEventInSummaryMode(llmError, "cancelled")).toBe(false);
    expect(filterVerboseTimelineNoise([llmError, taskCancelled]).map((event) => event.id)).toEqual([
      "task-cancelled",
    ]);
  });

  it("hides low-value internal lifecycle chatter in verbose mode", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "log",
        { message: "[planning] Using strong model profile for execution plan creation" },
        { id: "plan-log" },
      ),
      makeEvent(
        "progress_update",
        { message: "Starting execution of 5 steps" },
        { id: "start-exec" },
      ),
      makeEvent(
        "progress_update",
        { message: "Completed step 2: Review repository activity" },
        { id: "done-step" },
      ),
      makeEvent(
        "timeline_group_finished",
        { stage: "BUILD", message: "Completed BUILD" },
        { id: "build-finished" },
      ),
      makeEvent(
        "progress_update",
        { message: "Tackling: Review repository activity" },
        { id: "useful" },
      ),
    ]);
    expect(filtered).toEqual([]);
  });

  it("hides pause and heartbeat progress updates in verbose mode", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "progress_update",
        {
          phase: "tool_execution",
          message: "Still running http_request (12s elapsed)",
          heartbeat: true,
        },
        { id: "heartbeat" },
      ),
      makeEvent(
        "progress_update",
        { phase: "execution", message: "Paused - awaiting user input" },
        { id: "pause" },
      ),
    ]);
    expect(filtered).toEqual([]);
  });

  it("deduplicates exact repeated event ids in verbose mode", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom group" },
        { id: "dup", timestamp: 1000, groupId: "custom:group" },
      ),
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom group" },
        { id: "dup", timestamp: 1001, groupId: "custom:group" },
      ),
    ]);
    expect(filtered.map((e) => e.id)).toEqual(["dup"]);
  });

  it("deduplicates mirrored semantic events in verbose mode", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom group" },
        { id: "a", timestamp: 1000, groupId: "custom:group" },
      ),
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom group" },
        { id: "b", timestamp: 1005, groupId: "custom:group" },
      ),
      makeEvent(
        "tool_result",
        { tool: "http_request", toolUseId: "use-1", result: { url: "https://api.github.com/a" } },
        { id: "c", timestamp: 1010 },
      ),
      makeEvent(
        "tool_result",
        { tool: "http_request", toolUseId: "use-1", result: { url: "https://api.github.com/a" } },
        { id: "d", timestamp: 1011 },
      ),
      makeEvent(
        "tool_result",
        { tool: "http_request", toolUseId: "use-2", result: { url: "https://api.github.com/b" } },
        { id: "e", timestamp: 1012 },
      ),
    ]);
    expect(filtered.map((e) => e.id)).toEqual(["a", "c", "e"]);
  });

  it("deduplicates adjacent timeline_error events that repeat a failed step reason", () => {
    const reason =
      "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 5 reached without successful file/canvas mutation.";
    const filtered = filterAdjacentDuplicateTimelineFailures([
      makeEvent(
        "timeline_step_finished",
        {
          legacyType: "step_failed",
          message: reason,
          reason,
          step: { id: "step-1", description: "Applying fixes", error: reason },
        },
        { id: "step-failed", timestamp: 1000, status: "failed", stepId: "step-1" },
      ),
      makeEvent(
        "timeline_error",
        { message: reason.replace(/\.$/, "") },
        { id: "matching-error", timestamp: 1001 },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["step-failed"]);
  });

  it("keeps the failed step when an adjacent duplicate timeline_error arrives first", () => {
    const reason =
      "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 5 reached without successful file/canvas mutation.";
    const filtered = filterAdjacentDuplicateTimelineFailures([
      makeEvent("timeline_error", { message: reason }, { id: "matching-error", timestamp: 1000 }),
      makeEvent(
        "timeline_step_finished",
        {
          legacyType: "step_failed",
          message: reason,
          reason,
          step: { id: "step-1", description: "Applying fixes", error: reason },
        },
        { id: "step-failed", timestamp: 1001, status: "failed", stepId: "step-1" },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["step-failed"]);
  });

  it("keeps adjacent timeline_error events with different failure text", () => {
    const filtered = filterAdjacentDuplicateTimelineFailures([
      makeEvent(
        "timeline_step_finished",
        {
          legacyType: "step_failed",
          message: "Step contract failure: missing artifact write",
          reason: "Step contract failure: missing artifact write",
          step: { id: "step-1", description: "Applying fixes" },
        },
        { id: "step-failed", timestamp: 1000, status: "failed", stepId: "step-1" },
      ),
      makeEvent(
        "timeline_error",
        { message: "Completion blocked: unresolved failed step(s): step-1" },
        { id: "completion-error", timestamp: 1001 },
      ),
    ]);

    expect(filtered.map((event) => event.id)).toEqual(["step-failed", "completion-error"]);
  });

  it("keeps stage-boundary group starts in verbose mode along with custom groups", () => {
    const filtered = filterVerboseTimelineNoise([
      makeEvent(
        "timeline_group_started",
        { stage: "FIX", groupLabel: "Adjusting the plan" },
        { id: "fix-start", timestamp: 1000, groupId: "stage:fix" },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "BUILD", message: "Starting BUILD" },
        { id: "build-start", timestamp: 1100, groupId: "stage:build" },
      ),
      makeEvent(
        "timeline_group_started",
        { stage: "DELIVER", message: "Starting DELIVER" },
        { id: "deliver-start", timestamp: 1200, groupId: "stage:deliver" },
      ),
      makeEvent(
        "timeline_group_started",
        { groupLabel: "Custom group" },
        { id: "custom-start", timestamp: 1300, groupId: "custom:group" },
      ),
    ]);
    expect(filtered.map((e) => e.id)).toEqual([
      "fix-start",
      "build-start",
      "deliver-start",
      "custom-start",
    ]);
  });

  it("does not hide custom non-stage group events for completed tasks", () => {
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_started", { stage: "CUSTOM", groupId: "custom:group" }),
        "completed",
      ),
    ).toBe(true);
    expect(
      shouldShowTaskEventInSummaryMode(
        makeEvent("timeline_group_finished", {}, { groupId: "stage:custom" }),
        "completed",
      ),
    ).toBe(true);
  });
});
