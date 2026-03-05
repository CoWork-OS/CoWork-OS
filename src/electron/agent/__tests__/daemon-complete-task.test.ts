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
    activeTimelineStageByTask: new Map(),
    failedPlanStepsByTask: new Map(),
    timelineErrorsByTask: new Map(),
    knownPlanStepIdsByTask: new Map(),
    evidenceRefsByTask: new Map(),
    getUnresolvedFailedSteps: vi.fn().mockReturnValue([]),
    getTaskEventsForReplay: vi.fn(function getTaskEventsForReplayStub(this: Any, taskId: string) {
      return this.eventRepo.findByTaskId(taskId);
    }),
    computeTimelineTelemetryFromEvents: vi.fn().mockReturnValue({
      timeline_event_drop_rate: 0,
      timeline_order_violation_rate: 0,
      step_state_mismatch_rate: 0,
      completion_gate_block_count: 0,
      evidence_gate_fail_count: 0,
    }),
    hasEvidenceForKeyClaims: vi.fn().mockReturnValue({ passed: true, keyClaims: [] }),
    clearTimelineTaskState: vi.fn(),
    timelineMetrics: {
      totalEvents: 0,
      droppedEvents: 0,
      orderViolations: 0,
      stepStateMismatches: 0,
      completionGateBlocks: 0,
      evidenceGateFails: 0,
    },
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

  it("emits key-claim evidence attachment event when evidence refs exist", () => {
    const daemonLike = createDaemonLike();
    daemonLike.hasEvidenceForKeyClaims.mockReturnValue({
      passed: true,
      keyClaims: ["Median compensation is higher than the current offer."],
    });
    daemonLike.evidenceRefsByTask.set(
      "task-1",
      new Map([
        [
          "evidence-1",
          {
            evidenceId: "evidence-1",
            sourceType: "url",
            sourceUrlOrPath: "https://example.com/comp-survey",
            snippet: "Median total compensation is $500k.",
            capturedAt: Date.now(),
          },
        ],
      ]),
    );

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "timeline_evidence_attached",
      expect.objectContaining({
        gate: "key_claim_evidence_gate",
        keyClaims: ["Median compensation is higher than the current offer."],
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

  it("blocks completion when non-waived failed steps remain", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["step:verify", "step:build"]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      waiveFailedStepIds: ["step:verify"],
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("step:build"),
      }),
    );
    const timelineErrorPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "timeline_error",
    )?.[2];
    expect(timelineErrorPayload.unresolvedFailedSteps).toEqual(["step:build"]);
    expect(timelineErrorPayload.waivedFailedStepIds).toEqual(["step:verify"]);
  });

  it("allows completion when all unresolved failed steps are waived", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["step:verify"]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failureClass: "contract_error",
      waiveFailedStepIds: ["step:verify"],
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("does not block completion for failed tool-lane steps", () => {
    const daemonLike = createDaemonLike();
    daemonLike.failedPlanStepsByTask.set("task-1", new Set(["tool_lane:step:use-1"]));
    daemonLike.knownPlanStepIdsByTask.set("task-1", new Set(["tool_lane:step:use-1"]));
    daemonLike.normalizeStepIdForPlanTracking = AgentDaemon.prototype["normalizeStepIdForPlanTracking"];
    daemonLike.isSyntheticNonPlanStepId = AgentDaemon.prototype["isSyntheticNonPlanStepId"];
    daemonLike.isKnownPlanStepId = AgentDaemon.prototype["isKnownPlanStepId"];
    daemonLike.getUnresolvedFailedSteps = AgentDaemon.prototype["getUnresolvedFailedSteps"];

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failureClass: "contract_error",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("blocks completion when mutation-required failures are reported by executor metadata", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failedMutationRequiredStepIds: ["step:build"],
      terminalStatusReason: "contract_unmet_write_required",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "contract_unmet_write_required",
      }),
    );
    const timelineErrorPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "timeline_error",
    )?.[2];
    expect(timelineErrorPayload.failedMutationRequiredStepIds).toEqual(["step:build"]);
  });

  it("keeps timeline_error step IDs out of unresolved plan-step gate", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);
    daemonLike.timelineErrorsByTask.set("task-1", new Set(["tool:search_files"]));

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
      }),
    );
    const taskCompletedPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_completed",
    )?.[2];
    expect(taskCompletedPayload.timelineErrorStepIds).toEqual(["tool:search_files"]);
  });

  it("auto-waives verification-only unresolved failures for partial_success completion", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["6"]);
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "event-1",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "timeline_step_finished",
        stepId: "6",
        status: "failed",
        legacyType: "step_failed",
        payload: {
          legacyType: "step_failed",
          step: {
            id: "6",
            description:
              "Verify: run through at least one full test attempt to confirm scoring and results rendering",
          },
        },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failureClass: "contract_error",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        metric: "completion_gate_blocked_partial_success",
        blocked: false,
      }),
    );
  });

  it("auto-waives budget-constrained unresolved failures for partial_success budget exhaustion", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["4"]);
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "event-budget-1",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "timeline_step_finished",
        stepId: "4",
        status: "failed",
        legacyType: "step_failed",
        payload: {
          legacyType: "step_failed",
          reason: "web_search budget exhausted: 8/8.",
          step: {
            id: "4",
            description: "Collect tech-news signals from major outlets",
            error: "web_search budget exhausted: 8/8.",
          },
        },
      },
      {
        id: "event-budget-2",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "log",
        payload: {
          metric: "web_search_budget_hit",
          stepId: "4",
          used: 8,
          limit: 8,
        },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failureClass: "budget_exhausted",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: "budget_exhausted",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        metric: "completion_gate_auto_waive_budget_steps",
        blocked: false,
      }),
    );
  });

  it("does not auto-waive when latest failure for the step is non-budget", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["4"]);
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "event-budget-old",
        taskId: "task-1",
        timestamp: Date.now() - 5000,
        type: "log",
        payload: {
          metric: "web_search_budget_hit",
          stepId: "4",
          used: 8,
          limit: 8,
        },
      },
      {
        id: "event-failure-new",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "timeline_step_finished",
        stepId: "4",
        status: "failed",
        legacyType: "step_failed",
        payload: {
          legacyType: "step_failed",
          reason: "Tool run_command failed: command not found",
          step: {
            id: "4",
            description: "Collect tech-news signals from major outlets",
            error: "Tool run_command failed: command not found",
          },
        },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "partial_success",
      failureClass: "budget_exhausted",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("unresolved failed step"),
      }),
    );
    expect(daemonLike.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "log",
      expect.objectContaining({
        metric: "completion_gate_auto_waive_budget_steps",
      }),
    );
  });

  it("completes as needs_user_action when only non-blocking verification failures remain", () => {
    const daemonLike = createDaemonLike();
    daemonLike.verificationOutcomeV2Enabled = true;
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["step:verify"]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      nonBlockingFailedStepIds: ["step:verify"],
      verificationOutcome: "pending_user_action",
      verificationScope: "normal",
      verificationEvidenceMode: "time_blocked",
      pendingChecklist: ["Run final full mock 48-72 hours before the real test."],
      verificationMessage: "Pending user action: final timed mock not yet recorded.",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "needs_user_action",
        failureClass: undefined,
      }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "verification_pending_user_action",
      expect.objectContaining({
        nonBlockingFailedStepIds: ["step:verify"],
      }),
    );
  });
});
