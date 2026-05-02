import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Task, TaskEvent, Workspace } from "../../../shared/types";
import {
  collectLatestEndOfTaskArtifactCards,
  collectInlineRunCommandSessionIds,
  buildTaskAutomationCronJobCreate,
  buildTaskAutomationSchedule,
  composeMessageWithAttachments,
  deriveAgentReasoningPanelState,
  deriveTaskHeaderPresentation,
  estimateTaskFeedRowHeight,
  extractGeneratedArtifactPathsFromText,
  getInlinePreviewKindForGeneratedFile,
  getInlinePreviewKindForTaskEvent,
  getAutoScrollTargetTop,
  getBootstrapProgressTitle,
  getDefaultTranscriptMode,
  hasInactiveStringSetEntries,
  isTaskActivelyWorking,
  pruneStringSetToActiveIds,
  selectVisibleTaskFeedRows,
  shouldCreateFreshTaskForSend,
  shouldRenderOpenArtifactCardAtEvent,
  shouldShowBootstrapProgressRow,
  shouldScheduleAutoScrollWrite,
  TaskAutomationModal,
  TASK_AUTOMATION_TEMPLATES,
} from "../MainContent";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldCreateFreshTaskForSend", () => {
  it("forces a fresh task for deterministic app shortcut handling even when a task is selected", () => {
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "execute",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "execute",
        forceFreshTask: true,
      }),
    ).toBe(true);
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Test prompt",
    status: "executing",
    createdAt: 0,
    updatedAt: 0,
    executionMode: "execute",
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
  } as TaskEvent;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    path: "/workspace",
    createdAt: 1,
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    },
    ...overrides,
  };
}

describe("task automation creation", () => {
  it("renders the modal with task-derived defaults", () => {
    const task = makeTask({
      id: "task-123",
      title: "Task menu automation",
      prompt: "Turn this task into a recurring check",
      workspaceId: "workspace-1",
    });
    const html = renderToStaticMarkup(
      React.createElement(TaskAutomationModal, {
        task,
        workspace: makeWorkspace(),
        defaultName: "Task menu automation",
        defaultPrompt: "Turn this task into a recurring check",
        deeplink: "cowork://tasks/task-123",
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain("Add automation");
    expect(html).toContain("Task menu automation");
    expect(html).toContain("Turn this task into a recurring check");
    expect(html).toContain("Every 30m");
  });

  it("builds the default Every 30m scheduled job payload from a task", () => {
    const before = Date.now();
    const task = makeTask({
      id: "task-123",
      title: "Review recent failures",
      prompt: "Look at the failing tests",
      workspaceId: "workspace-1",
    });
    const schedule = buildTaskAutomationSchedule("every30m", "");

    expect(schedule).toMatchObject({
      kind: "every",
      everyMs: 30 * 60 * 1000,
    });
    expect(schedule?.kind === "every" ? schedule.anchorMs : null).toBeGreaterThanOrEqual(before);
    expect(
      buildTaskAutomationCronJobCreate({
        task,
        workspace: makeWorkspace(),
        name: "Review recent failures",
        prompt: "Look at the failing tests",
        runMode: "chat",
        schedule: schedule!,
        deeplink: "cowork://tasks/task-123",
      }),
    ).toMatchObject({
      name: "Review recent failures",
      description: "Created from task task-123 (cowork://tasks/task-123)",
      enabled: true,
      shellAccess: false,
      allowUserInput: false,
      deleteAfterRun: false,
      schedule,
      workspaceId: "workspace-1",
      taskTitle: "Review recent failures",
    });
  });

  it("enables shell access for Local run mode", () => {
    const task = makeTask({ workspaceId: "workspace-1" });
    const schedule = buildTaskAutomationSchedule("hourly", "")!;
    const job = buildTaskAutomationCronJobCreate({
      task,
      workspace: makeWorkspace(),
      name: "Local check",
      prompt: "Run the local health check",
      runMode: "local",
      schedule,
      deeplink: "cowork://tasks/task-1",
    });

    expect(job.shellAccess).toBe(true);
  });

  it("templates provide prompt, name, and schedule defaults", () => {
    const template = TASK_AUTOMATION_TEMPLATES.find((item) => item.id === "ci-failures");

    expect(template).toMatchObject({
      name: "CI failure summary",
      schedulePreset: "hourly",
    });
    expect(template?.prompt).toContain("CI failures");
  });
});

describe("isTaskActivelyWorking", () => {
  it("composes uploaded PDF prompts with path and parse_document guidance", async () => {
    const readFileForViewer = vi.fn().mockResolvedValue({
      success: true,
      data: {
        path: "/workspace/.cowork/uploads/123/report.pdf",
        fileName: "report.pdf",
        fileType: "pdf",
        content: null,
        size: 1024,
        pdfReviewSummary: {
          pageCount: 4,
          nativeTextPages: 4,
          ocrPages: 0,
          scannedPages: 0,
          truncatedPages: false,
          extractionMode: "native",
          pages: [
            {
              pageIndex: 0,
              text: "This contract renews annually unless cancelled.",
              usedOcr: false,
              truncated: false,
            },
          ],
        },
      },
    });
    vi.stubGlobal("window", {
      electronAPI: {
        readFileForViewer,
      },
    });

    const result = await composeMessageWithAttachments("/workspace", "Summarize this PDF", [
      {
        relativePath: ".cowork/uploads/123/report.pdf",
        fileName: "report.pdf",
        size: 1024,
        mimeType: "application/pdf",
      },
    ]);

    expect(readFileForViewer).toHaveBeenCalledWith(
      ".cowork/uploads/123/report.pdf",
      "/workspace",
      expect.objectContaining({ imageOcrMaxChars: 6000 }),
    );
    expect(result.extractionWarnings).toEqual([]);
    expect(result.message).toContain("- report.pdf (.cowork/uploads/123/report.pdf)");
    expect(result.message).toContain("PDF attachment: report.pdf");
    expect(result.message).toContain("Path: .cowork/uploads/123/report.pdf");
    expect(result.message).toContain("call parse_document with the Path above");
    expect(result.message).toContain("Untrusted PDF content follows");
  });

  it("classifies generated html outputs as live html previews", () => {
    expect(
      getInlinePreviewKindForGeneratedFile({
        path: "artifacts/demo-animation.html",
        mimeType: "text/html",
      }),
    ).toBe("html");
  });

  it("classifies generated pptx outputs as presentation previews", () => {
    expect(
      getInlinePreviewKindForGeneratedFile({
        path: "artifacts/output.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toBe("presentation");
  });

  it("extracts generated office artifact paths from assistant text", () => {
    expect(
      extractGeneratedArtifactPathsFromText(
        "Validated:\n- File: `artifacts/sample_presentation.pptx`\n- Also saved reports/summary.docx and sample.xlsx.",
      ),
    ).toEqual(["artifacts/sample_presentation.pptx", "reports/summary.docx", "sample.xlsx"]);
  });

  it("does not promote remote office links as local artifact cards", () => {
    expect(
      extractGeneratedArtifactPathsFromText(
        "Reference: https://example.com/artifacts/sample_presentation.pptx and local/output.pptx",
      ),
    ).toEqual(["local/output.pptx"]);
  });

  it("treats file lifecycle html events as previewable", () => {
    expect(
      getInlinePreviewKindForTaskEvent(
        makeEvent("html-created", 100, "file_created", {
          path: "artifacts/preview.html",
          mimeType: "text/html",
        }),
      ),
    ).toBe("html");
    expect(
      getInlinePreviewKindForTaskEvent(
        makeEvent("html-artifact", 100, "artifact_created", {
          path: "artifacts/preview.html",
          mimeType: "text/html",
        }),
      ),
    ).toBe("html");
  });

  it("only renders repeated office artifact cards at the last reference", () => {
    const created = makeEvent("created", 100, "file_created", {
      path: "artifacts/sample_presentation.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const emitted = makeEvent("artifact", 200, "artifact_created", {
      path: "artifacts/sample_presentation.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const completed = makeEvent("completed", 300, "task_completed", {
      outputSummary: {
        created: ["artifacts/sample_presentation.pptx"],
        primaryOutputPath: "artifacts/sample_presentation.pptx",
        outputCount: 1,
      },
    });
    const eventStream = [created, emitted, completed];

    expect(
      shouldRenderOpenArtifactCardAtEvent({
        path: "artifacts/sample_presentation.pptx",
        event: created,
        eventStream,
      }),
    ).toBe(false);
    expect(
      shouldRenderOpenArtifactCardAtEvent({
        path: "artifacts/sample_presentation.pptx",
        event: emitted,
        eventStream,
      }),
    ).toBe(false);
    expect(
      shouldRenderOpenArtifactCardAtEvent({
        path: "artifacts/sample_presentation.pptx",
        event: completed,
        eventStream,
      }),
    ).toBe(true);
  });

  it("collects the latest office artifact cards for bottom rendering", () => {
    const created = makeEvent("created", 100, "file_created", {
      path: "artifacts/sample.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const assistant = makeEvent("assistant", 200, "assistant_message", {
      message: "Done: artifacts/sample.xlsx",
    });
    const laterUser = makeEvent("user", 300, "user_message", {
      message: "change Lisbon to Porto",
    });

    expect(collectLatestEndOfTaskArtifactCards([created, assistant, laterUser])).toEqual([
      {
        path: "artifacts/sample.xlsx",
        kind: "spreadsheet",
        eventId: "assistant",
        lastReferenceIndex: 1,
        lastReferenceTimestamp: 200,
      },
    ]);
  });

  it("collapses matching artifact filenames to one bottom card", () => {
    const relative = makeEvent("relative", 100, "artifact_created", {
      path: "cowork-os-presentation.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const absolute = makeEvent("absolute", 200, "assistant_message", {
      message:
        "Updated /Users/mesut/Downloads/app/cowork/cowork-os-presentation.pptx and verified the deck.",
    });

    expect(collectLatestEndOfTaskArtifactCards([relative, absolute])).toEqual([
      {
        path: "/Users/mesut/Downloads/app/cowork/cowork-os-presentation.pptx",
        kind: "presentation",
        eventId: "absolute",
        lastReferenceIndex: 1,
        lastReferenceTimestamp: 200,
      },
    ]);
  });

  it("continues to render image artifact cards inline", () => {
    const created = makeEvent("image", 100, "file_created", {
      path: "artifacts/screenshot.png",
      mimeType: "image/png",
    });
    const completed = makeEvent("completed", 200, "task_completed", {
      outputSummary: {
        created: ["artifacts/screenshot.png"],
        primaryOutputPath: "artifacts/screenshot.png",
        outputCount: 1,
      },
    });

    expect(
      shouldRenderOpenArtifactCardAtEvent({
        path: "artifacts/screenshot.png",
        event: created,
        eventStream: [created, completed],
      }),
    ).toBe(true);
  });

  it("hides the header title when it only repeats the initial prompt", () => {
    const presentation = deriveTaskHeaderPresentation({
      title: "run command 'echo hello world'",
      prompt: "run command 'echo hello world'",
    });

    expect(presentation.showHeaderTitle).toBe(false);
    expect(presentation.trimmedPrompt).toBe("run command 'echo hello world'");
  });

  it("keeps the header title when it adds distinct context beyond the prompt", () => {
    const presentation = deriveTaskHeaderPresentation({
      title: "Shell reproduction",
      prompt: "run command 'echo hello world'",
    });

    expect(presentation.showHeaderTitle).toBe(true);
    expect(presentation.headerTitle).toBe("Shell reproduction");
  });

  it("keeps executing tasks active when newer progress follows an older completed follow-up", () => {
    const task = makeTask();
    const events = [
      makeEvent("follow-up-done", 1_000, "follow_up_completed"),
      makeEvent("step-progress", 2_000, "timeline_step_updated", {
        legacyType: "progress_update",
        message: "Working on your request",
      }),
    ];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });

  it("marks executing tasks idle when the latest relevant event is a completed follow-up", () => {
    const task = makeTask();
    const events = [makeEvent("follow-up-done", 2_000, "follow_up_completed")];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(false);
  });

  it("does not treat generic error events as terminal while the task is still executing", () => {
    const task = makeTask();
    const events = [makeEvent("tool-side-error", 2_000, "error", { error: "Image generation failed" })];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });

  it("computes the correct bottom-scroll target", () => {
    expect(getAutoScrollTargetTop(1200, 400)).toBe(800);
    expect(getAutoScrollTargetTop(300, 400)).toBe(0);
  });

  it("skips auto-scroll writes when already pinned to the same bottom target", () => {
    expect(
      shouldScheduleAutoScrollWrite({
        scrollTop: 800,
        scrollHeight: 1200,
        clientHeight: 400,
        lastTargetTop: 800,
      }),
    ).toBe(false);
  });

  it("schedules auto-scroll writes when the bottom target materially changes", () => {
    expect(
      shouldScheduleAutoScrollWrite({
        scrollTop: 800,
        scrollHeight: 1400,
        clientHeight: 400,
        lastTargetTop: 800,
      }),
    ).toBe(true);
  });

  it("defaults transcript mode to live only while a non-chat task is actively working", () => {
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: true,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: false,
      }),
    ).toBe("live");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: false,
      }),
    ).toBe("inspect");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: false,
        taskStatus: "completed",
      }),
    ).toBe("delivery");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: false,
        verboseSteps: true,
        isChatTask: false,
        taskStatus: "completed",
      }),
    ).toBe("inspect");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: true,
        verboseSteps: false,
        isChatTask: false,
        taskStatus: "completed",
      }),
    ).toBe("inspect");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: true,
        taskStatus: "completed",
      }),
    ).toBe("inspect");
  });

  it("shows a bootstrap progress row while an active non-chat task has no visible feed rows", () => {
    expect(
      shouldShowBootstrapProgressRow({
        isTaskWorking: true,
        visibleRenderableFeedRowsLength: 0,
        isChatTask: false,
      }),
    ).toBe(true);
    expect(
      shouldShowBootstrapProgressRow({
        isTaskWorking: true,
        visibleRenderableFeedRowsLength: 1,
        isChatTask: false,
      }),
    ).toBe(false);
    expect(
      shouldShowBootstrapProgressRow({
        isTaskWorking: true,
        visibleRenderableFeedRowsLength: 0,
        isChatTask: true,
      }),
    ).toBe(false);
  });

  it("uses task status to label bootstrap progress", () => {
    expect(getBootstrapProgressTitle(makeTask({ status: "planning" }))).toBe("Planning the approach");
    expect(getBootstrapProgressTitle(makeTask({ status: "executing" }))).toBe("Thinking");
    expect(getBootstrapProgressTitle(makeTask({ status: "interrupted" }))).toBe("Resuming work");
  });

  it("surfaces the latest active reasoning stream text for the live panel", () => {
    const state = deriveAgentReasoningPanelState({
      events: [
        makeEvent("progress-1", 100, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Executing step 1/2: Inspect repository",
        }),
        makeEvent("stream-1", 200, "timeline_step_updated", {
          legacyType: "llm_streaming",
          text: "I'm checking the repo and runtime state first.",
          streaming: true,
        }),
      ],
      taskId: "task-1",
      isTaskWorking: true,
    });

    expect(state.activeStreamText).toBe("I'm checking the repo and runtime state first.");
    expect(state.isStreaming).toBe(true);
    expect(state.recentUpdates).toEqual(["Inspecting repository"]);
  });

  it("falls back to recent user-facing progress updates when no reasoning stream is active", () => {
    const state = deriveAgentReasoningPanelState({
      events: [
        makeEvent("progress-hidden", 100, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Thinking...",
        }),
        makeEvent("progress-1", 200, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Analyzing task requirements...",
        }),
        makeEvent("progress-2", 300, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Executing step 1/2: Inspect repository",
        }),
        makeEvent("step-1", 400, "timeline_step_started", {
          step: { id: "step-1", description: "Inspect repository" },
        }),
      ],
      taskId: "task-1",
      isTaskWorking: true,
    });

    expect(state.activeStreamText).toBe("");
    expect(state.isStreaming).toBe(false);
    expect(state.recentUpdates).toEqual([
      "Understanding the request",
      "Inspecting repository",
    ]);
  });

  it("includes assistant messages in the reasoning fallback window", () => {
    const state = deriveAgentReasoningPanelState({
      events: [
        makeEvent("progress-1", 100, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "Executing step 1/2: Inspect repository",
        }),
        makeEvent("assistant-1", 200, "timeline_step_updated", {
          legacyType: "assistant_message",
          message: "I’m checking the scaffolded Kami slide project first.",
        }),
        makeEvent("assistant-internal", 300, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: true,
          message: "OK",
        }),
      ],
      taskId: "task-1",
      isTaskWorking: true,
    });

    expect(state.activeStreamText).toBe("");
    expect(state.isStreaming).toBe(false);
    expect(state.recentUpdates).toEqual([
      "Inspecting repository",
      "I’m checking the scaffolded Kami slide project first.",
    ]);
  });

  it("detects when action block state contains stale ids", () => {
    expect(
      hasInactiveStringSetEntries(new Set(["block-1", "block-2"]), new Set(["block-2", "block-3"])),
    ).toBe(true);
    expect(hasInactiveStringSetEntries(new Set(["block-2"]), new Set(["block-2", "block-3"]))).toBe(
      false,
    );
  });

  it("prunes action block state down to active ids", () => {
    expect(
      [...pruneStringSetToActiveIds(new Set(["block-1", "block-2"]), new Set(["block-2", "block-3"]))],
    ).toEqual(["block-2"]);
  });

  it("projects a bounded live transcript row set while preserving hidden count", () => {
    const rows = [
      {
        kind: "timeline",
        key: "user-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "user-1",
        revision: "user-1",
        item: { kind: "event", event: makeEvent("user-1", 100, "user_message", { message: "User" }) },
      },
      {
        kind: "timeline",
        key: "assistant-1",
        estimatedHeight: 100,
        timelineIndex: 1,
        visiblePerfEventId: "assistant-1",
        revision: "assistant-1",
        item: {
          kind: "event",
          event: makeEvent("assistant-1", 200, "assistant_message", { message: "First answer" }),
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: "timeline",
        key: `progress-${index}`,
        estimatedHeight: 100,
        timelineIndex: index + 2,
        visiblePerfEventId: `progress-${index}`,
        revision: `progress-${index}`,
        item: {
          kind: "event",
          event: makeEvent(`progress-${index}`, 300 + index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Progress ${index}`,
          }),
        },
      })),
      {
        kind: "timeline",
        key: "action-block-1",
        estimatedHeight: 180,
        timelineIndex: 20,
        visiblePerfEventId: "step-2",
        revision: "action-block-1",
        item: {
          kind: "action_block",
          blockId: "action-block-1",
          events: [
            makeEvent("step-1", 500, "timeline_step_started", {
              legacyType: "step_started",
            }),
            makeEvent("step-2", 600, "timeline_step_updated", {
              legacyType: "progress_update",
              message: "Final meaningful step",
            }),
          ],
        },
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "live");

    expect(result.visibleFeedRows.length).toBeLessThan(rows.length);
    expect(result.hiddenLiveFeedRowCount).toBe(rows.length - result.visibleFeedRows.length);
    expect(result.visibleFeedRows.some((row) => row.key === "action-block-1")).toBe(true);
    expect(result.visibleFeedRows.some((row) => row.key === "assistant-1")).toBe(true);
  });

  it("keeps the full transcript visible in inspect mode", () => {
    const rows = [
      {
        kind: "timeline",
        key: "budget-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "budget-1",
        revision: "budget-1",
        item: {
          kind: "event",
          event: makeEvent("budget-1", 100, "timeline_step_updated", {
            legacyType: "llm_output_budget",
            message: "Budget remaining: 82%",
          }),
        },
      },
      {
        kind: "timeline",
        key: "assistant-1",
        estimatedHeight: 100,
        timelineIndex: 1,
        visiblePerfEventId: "assistant-1",
        revision: "assistant-1",
        item: {
          kind: "event",
          event: makeEvent("assistant-1", 200, "assistant_message", { message: "Answer" }),
        },
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "inspect");

    expect(result.visibleFeedRows).toHaveLength(rows.length);
    expect(result.hiddenLiveFeedRowCount).toBe(0);
    expect(result.visibleFeedRows[0]?.key).toBe("budget-1");
  });

  it("projects completed delivery mode to final output rows", () => {
    const rows = [
      {
        kind: "timeline",
        key: "user-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "user-1",
        revision: "user-1",
        item: { kind: "event", event: makeEvent("user-1", 100, "user_message", { message: "User" }) },
      },
      {
        kind: "timeline",
        key: "action-block-1",
        estimatedHeight: 180,
        timelineIndex: 1,
        visiblePerfEventId: "complete-1",
        revision: "action-block-1",
        item: {
          kind: "action_block",
          blockId: "action-block-1",
          eventIndices: [1, 2],
          events: [
            makeEvent("step-1", 200, "timeline_step_updated", {
              legacyType: "progress_update",
              message: "Working",
            }),
            makeEvent("complete-1", 300, "task_completed", {
              outputSummary: {
                created: ["sample.xlsx"],
                primaryOutputPath: "sample.xlsx",
                outputCount: 1,
                folders: ["."],
              },
            }),
          ],
        },
      },
      {
        kind: "timeline",
        key: "assistant-1",
        estimatedHeight: 100,
        timelineIndex: 2,
        visiblePerfEventId: "assistant-1",
        revision: "assistant-1",
        item: {
          kind: "event",
          event: makeEvent("assistant-1", 400, "assistant_message", { message: "Created sample.xlsx" }),
        },
      },
      {
        kind: "artifact-stack",
        key: "end-artifact-stack",
        estimatedHeight: 114,
        artifacts: [
          {
            path: "sample.xlsx",
            kind: "spreadsheet",
            eventId: "assistant-1",
            lastReferenceIndex: 2,
            lastReferenceTimestamp: 400,
          },
        ],
        revision: "sample.xlsx:spreadsheet:assistant-1",
        visiblePerfEventId: null,
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "delivery");

    expect(result.visibleFeedRows.map((row) => row.key)).toEqual([
      "delivery-event:complete-1:2",
      "assistant-1",
      "end-artifact-stack",
    ]);
    const completionRow = result.visibleFeedRows[0];
    expect(completionRow?.kind).toBe("timeline");
    if (completionRow?.kind !== "timeline") {
      throw new Error("Expected completion row to be a timeline event");
    }
    expect(completionRow.item.kind).toBe("event");
    expect(completionRow.item.event.id).toBe("complete-1");
    expect(result.hiddenLiveFeedRowCount).toBe(1);
  });

  it("keeps action-required and critical terminal rows in delivery mode", () => {
    const rows = [
      {
        kind: "timeline",
        key: "step-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "step-1",
        revision: "step-1",
        item: {
          kind: "event",
          event: makeEvent("step-1", 100, "timeline_step_updated", {
            legacyType: "progress_update",
            message: "Working",
          }),
        },
      },
      {
        kind: "timeline",
        key: "needs-action",
        estimatedHeight: 100,
        timelineIndex: 1,
        visiblePerfEventId: "needs-action",
        revision: "needs-action",
        item: {
          kind: "event",
          event: makeEvent("needs-action", 200, "task_completed", {
            terminalStatus: "needs_user_action",
            pendingChecklist: ["Open the generated file"],
          }),
        },
      },
      {
        kind: "timeline",
        key: "error-1",
        estimatedHeight: 100,
        timelineIndex: 2,
        visiblePerfEventId: "error-1",
        revision: "error-1",
        item: {
          kind: "event",
          event: makeEvent("error-1", 300, "error", { message: "Verification failed" }),
        },
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "delivery");

    expect(result.visibleFeedRows.map((row) => row.key)).toEqual(["needs-action", "error-1"]);
  });

  it("keeps collapsed action block estimates compact for virtualized history views", () => {
    const height = estimateTaskFeedRowHeight(
      {
        kind: "action_block",
        blockId: "action-block-1",
        events: Array.from({ length: 40 }, (_, index) =>
          makeEvent(`step-${index}`, index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Step ${index}`,
          }),
        ),
      },
      { expanded: false, visibleEventCount: 0, hasVisibilityToggle: false },
    );

    expect(height).toBe(34);
  });

  it("bases expanded action block estimates on visible rows instead of raw hidden events", () => {
    const height = estimateTaskFeedRowHeight(
      {
        kind: "action_block",
        blockId: "action-block-1",
        events: Array.from({ length: 40 }, (_, index) =>
          makeEvent(`step-${index}`, index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Step ${index}`,
          }),
        ),
      },
      { expanded: true, visibleEventCount: 7, hasVisibilityToggle: true },
    );

    expect(height).toBeLessThan(520);
    expect(height).toBe(362);
  });

  it("keeps file and artifact event estimates close to compact step rows", () => {
    const fileModifiedHeight = estimateTaskFeedRowHeight({
      kind: "event",
      event: makeEvent("file-modified", 100, "file_modified", {
        path: "delivery_ops_unification_manager_deck.md",
        type: "edit",
        oldPreview: "- old",
        newPreview: "+ new",
      }),
    });
    const artifactHeight = estimateTaskFeedRowHeight({
      kind: "event",
      event: makeEvent("artifact", 200, "artifact_created", {
        path: "delivery_ops_unification_manager_deck.md",
        type: "markdown",
      }),
    });

    expect(fileModifiedHeight).toBe(58);
    expect(artifactHeight).toBe(42);
  });

  it("only suppresses run_command terminals for visible expanded rows", () => {
    const hiddenRunCommand = makeEvent("tool-call-hidden", 100, "timeline_step_updated", {
      legacyType: "tool_call",
      tool: "run_command",
    });
    const visibleRead = makeEvent("tool-call-visible", 200, "timeline_step_updated", {
      legacyType: "tool_call",
      tool: "read_file",
    });

    const sessionsByIndex = new Map([
      [0, [{ id: "cmd-hidden", command: "npm test", output: "ok", isRunning: false, exitCode: 0, startTimestamp: 100 }]],
      [1, [{ id: "cmd-visible", command: "cat file", output: "ok", isRunning: false, exitCode: 0, startTimestamp: 200 }]],
    ]);

    const hiddenIds = collectInlineRunCommandSessionIds({
      events: [visibleRead],
      eventIndices: [1],
      commandOutputSessionsByInsertIndex: sessionsByIndex as Any,
      isEventExpanded: (event) => event.id === "tool-call-hidden",
    });

    expect(hiddenIds.has("cmd-hidden")).toBe(false);
    expect(hiddenIds.has("cmd-visible")).toBe(false);

    const visibleIds = collectInlineRunCommandSessionIds({
      events: [hiddenRunCommand],
      eventIndices: [0],
      commandOutputSessionsByInsertIndex: sessionsByIndex as Any,
      isEventExpanded: (event) => event.id === "tool-call-hidden",
    });

    expect(visibleIds.has("cmd-hidden")).toBe(true);
  });
});
