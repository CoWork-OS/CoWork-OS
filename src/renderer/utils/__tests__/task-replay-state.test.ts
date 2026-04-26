import { describe, expect, it } from "vitest";

import type { Task, TaskEvent } from "../../../shared/types";
import { deriveSharedTaskEventUiState } from "../task-event-derived";
import { deriveReplayTaskSnapshot } from "../task-replay-state";

function makeTask(): Task {
  return {
    id: "task-1",
    title: "Build report",
    prompt: "Build report",
    status: "completed",
    workspaceId: "workspace-1",
    createdAt: 100,
    updatedAt: 500,
    completedAt: 500,
    terminalStatus: "ok",
    bestKnownOutcome: {
      outputSummary: {
        created: ["artifacts/final-report.md"],
        primaryOutputPath: "artifacts/final-report.md",
        outputCount: 1,
        folders: ["artifacts"],
      },
    },
  } as Task;
}

function makeEvent(type: TaskEvent["type"], timestamp: number, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${type}-${timestamp}`,
    taskId: "task-1",
    timestamp,
    schemaVersion: 2,
    type,
    payload,
  };
}

describe("deriveReplayTaskSnapshot", () => {
  it("hides final task state until the terminal event is replayed", () => {
    const task = makeTask();
    const replayTask = deriveReplayTaskSnapshot(task, [
      makeEvent("task_created", 110),
      makeEvent("plan_created", 130),
      makeEvent("file_created", 200, { path: "/workspace/artifacts/draft.md" }),
    ]);

    expect(replayTask?.status).toBe("executing");
    expect(replayTask?.completedAt).toBeUndefined();
    expect(replayTask?.terminalStatus).toBeUndefined();
    expect(replayTask?.bestKnownOutcome).toBeUndefined();
  });

  it("prevents final output summaries from leaking into early sidebar replay state", () => {
    const task = makeTask();
    const replayEvents = [
      makeEvent("task_created", 110),
      makeEvent("plan_created", 130),
    ];
    const replayTask = deriveReplayTaskSnapshot(task, replayEvents);
    const shared = deriveSharedTaskEventUiState({
      rawEvents: replayEvents,
      task: replayTask,
      workspace: { id: "workspace-1", name: "Workspace", path: "/workspace" } as Any,
      verboseSteps: false,
    });

    expect(shared.files).toEqual([]);
    expect(shared.outputSummary).toBeNull();
  });

  it("restores completed task metadata once the terminal event is replayed", () => {
    const task = makeTask();
    const replayTask = deriveReplayTaskSnapshot(task, [
      makeEvent("task_created", 110),
      makeEvent("task_completed", 500, {
        terminalStatus: "ok",
        outputSummary: {
          created: ["artifacts/final-report.md"],
          primaryOutputPath: "artifacts/final-report.md",
          outputCount: 1,
          folders: ["artifacts"],
        },
      }),
    ]);

    expect(replayTask?.status).toBe("completed");
    expect(replayTask?.completedAt).toBe(500);
    expect(replayTask?.terminalStatus).toBe("ok");
    expect(replayTask?.bestKnownOutcome?.outputSummary?.primaryOutputPath).toBe(
      "artifacts/final-report.md",
    );
  });
});
