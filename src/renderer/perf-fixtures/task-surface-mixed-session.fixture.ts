import type { Task, TaskEvent } from "../../shared/types";

function makeEvent(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    eventId: id,
    taskId: "fixture-task-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

export const taskSurfacePerfFixtureTask: Task = {
  id: "fixture-task-1",
  title: "Renderer perf fixture",
  prompt: "Benchmark the selected task surface under mixed event churn.",
  status: "executing",
  workspaceId: "fixture-workspace-1",
  createdAt: 0,
  updatedAt: 0,
} as Task;

export const taskSurfacePerfFixtureEvents: TaskEvent[] = [
  makeEvent("plan-1", 100, "plan_created", {
    plan: {
      description: "Plan",
      steps: [
        { id: "step-1", description: "Inspect current state", status: "pending" },
        { id: "step-2", description: "Run command and write files", status: "pending" },
        { id: "step-3", description: "Summarize final result", status: "pending" },
      ],
    },
  }),
  makeEvent("step-start-1", 150, "timeline_step_started", {
    legacyType: "step_started",
    step: { id: "step-1", description: "Inspect current state" },
  }),
  makeEvent("progress-1", 220, "timeline_step_updated", {
    legacyType: "progress_update",
    message: "Reading project files and deriving a focused plan",
  }),
  makeEvent("tool-call-1", 260, "tool_call", {
    tool: "read_file",
    input: { path: "src/renderer/App.tsx" },
  }),
  makeEvent("tool-result-1", 280, "tool_result", {
    tool: "read_file",
    result: { path: "src/renderer/App.tsx", contentLength: 1800 },
  }),
  makeEvent("step-complete-1", 320, "timeline_step_finished", {
    legacyType: "step_completed",
    step: { id: "step-1", description: "Inspect current state" },
  }),
  makeEvent("step-start-2", 360, "timeline_step_started", {
    legacyType: "step_started",
    step: { id: "step-2", description: "Run command and write files" },
  }),
  makeEvent("budget-1", 380, "timeline_step_updated", {
    legacyType: "llm_output_budget",
    message: "Budget remaining: 78%",
  }),
  makeEvent("tool-call-2", 420, "tool_call", {
    tool: "run_command",
    input: { command: "npm run type-check" },
  }),
  makeEvent("cmd-out-1", 430, "command_output", {
    sessionId: "cmd-1",
    chunk: "tsc --noEmit\n",
    isRunning: true,
  }),
  makeEvent("file-mod-1", 470, "file_modified", {
    path: "src/renderer/components/MainContent.tsx",
  }),
  makeEvent("tool-result-2", 520, "tool_result", {
    tool: "run_command",
    result: { exitCode: 0 },
  }),
  makeEvent("assistant-1", 580, "assistant_message", {
    message: "The task surface render path is now isolated from unrelated app-shell updates.",
  }),
  makeEvent("step-complete-2", 640, "timeline_step_finished", {
    legacyType: "step_completed",
    step: { id: "step-2", description: "Run command and write files" },
  }),
  makeEvent("step-start-3", 700, "timeline_step_started", {
    legacyType: "step_started",
    step: { id: "step-3", description: "Summarize final result" },
  }),
  makeEvent("approval-1", 760, "approval_requested", {
    message: "Allow opening the generated artifact?",
  }),
  makeEvent("task-complete-1", 860, "task_completed", {
    resultSummary:
      "Completed successfully with a stable live transcript and bounded sidebar churn.",
  }),
];

export const taskSurfacePerfFixtureBatches: string[][] = [
  ["plan-1", "step-start-1", "progress-1"],
  ["tool-call-1", "tool-result-1", "step-complete-1"],
  ["step-start-2", "budget-1", "tool-call-2", "cmd-out-1"],
  ["file-mod-1", "tool-result-2", "assistant-1"],
  ["step-complete-2", "step-start-3", "approval-1", "task-complete-1"],
];
