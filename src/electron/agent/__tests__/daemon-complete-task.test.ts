import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import type { TaskOutputSummary } from "../../../shared/types";

function createDaemonLike() {
  return {
    taskRepo: {
      findById: vi.fn().mockReturnValue({
        id: "task-1",
        title: "Task 1",
        status: "executing",
        workspaceId: "workspace-1",
        // Mark as non top-level so relationship memory side-effects are skipped.
        parentTaskId: "parent-task",
        agentType: "sub",
      }),
      update: vi.fn(),
    },
    eventRepo: {
      findByTaskId: vi.fn().mockReturnValue([]),
    },
    clearRetryState: vi.fn(),
    activeTasks: new Map(),
    logEvent: vi.fn(),
    runQuickQualityPass: vi.fn().mockReturnValue({
      passed: true,
      issues: [],
    }),
    runPostCompletionVerification: vi.fn(),
    worktreeManager: {
      getSettings: vi.fn().mockReturnValue({
        autoCommitOnComplete: false,
        commitMessagePrefix: "task: ",
      }),
      commitTaskChanges: vi.fn(),
    },
    comparisonService: null,
    workspaceRepo: {
      findById: vi.fn(),
    },
    teamOrchestrator: null,
    queueManager: {
      onTaskFinished: vi.fn(),
    },
  } as Any;
}

describe("AgentDaemon.completeTask", () => {
  it("emits task_completed with optional outputSummary when provided", () => {
    const daemonLike = createDaemonLike();
    const outputSummary: TaskOutputSummary = {
      created: ["artifacts/report.md"],
      modifiedFallback: ["README.md"],
      primaryOutputPath: "artifacts/report.md",
      outputCount: 1,
      folders: ["artifacts"],
    };

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "ok",
      outputSummary,
    });

    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_completed",
      expect.objectContaining({
        outputSummary,
      }),
    );
  });

  it("keeps outputSummary absent when metadata is not provided", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    const payload = (daemonLike.logEvent as Any).mock.calls[0]?.[2] || {};
    expect(payload.outputSummary).toBeUndefined();
  });

  it("stores computed risk level and emits review gate metadata for balanced policy", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Run tests and apply code changes",
      status: "executing",
      workspaceId: "workspace-1",
      parentTaskId: "parent-task",
      agentType: "sub",
      agentConfig: {
        reviewPolicy: "balanced",
      },
    });
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "e1",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "tool_call",
        payload: {
          tool: "run_command",
          input: { command: "npm install" },
        },
      },
      {
        id: "e2",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "tool_error",
        payload: { tool: "run_command", error: "failed" },
      },
      {
        id: "e3",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "tool_error",
        payload: { tool: "run_command", error: "failed" },
      },
      {
        id: "e4",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "tool_error",
        payload: { tool: "run_command", error: "failed" },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        riskLevel: "medium",
      }),
    );

    const taskCompletedPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_completed",
    )?.[2];
    expect(taskCompletedPayload.reviewPolicy).toBe("balanced");
    expect(taskCompletedPayload.reviewGate).toEqual(
      expect.objectContaining({
        tier: "medium",
      }),
    );
  });

  it("emits final downgraded terminal status after strict quality gate failure", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Summarize the current task state",
      status: "executing",
      workspaceId: "workspace-1",
      parentTaskId: "parent-task",
      agentType: "sub",
      agentConfig: {
        reviewPolicy: "strict",
      },
    });
    daemonLike.runQuickQualityPass.mockReturnValue({
      passed: false,
      issues: ["strict_mode_requires_more_complete_summary"],
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );

    const taskCompletedPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_completed",
    )?.[2];
    expect(taskCompletedPayload.terminalStatus).toBe("partial_success");
    expect(taskCompletedPayload.failureClass).toBe("contract_error");
    expect(taskCompletedPayload.message).toContain("partial results");
  });
});
