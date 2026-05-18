import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import type { TaskOutputSummary } from "../../../shared/types";
import { PersonalityManager } from "../../settings/personality-manager";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.spyOn(PersonalityManager, "recordTaskCompleted").mockImplementation(() => {});

function createDaemonLike() {
  return Object.assign(Object.create(AgentDaemon.prototype), {
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
    approvalRepo: {
      update: vi.fn(),
    },
    clearRetryState: vi.fn(),
    activeTasks: new Map(),
    pendingApprovals: new Map(),
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
    failTask: AgentDaemon.prototype.failTask,
    runQuickQualityPass: vi.fn().mockReturnValue({
      passed: true,
      issues: [],
    }),
    runPostCompletionVerification: vi.fn().mockResolvedValue(undefined),
    runPostTaskEntropySweep: vi.fn().mockResolvedValue(undefined),
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
    releaseComputerUseSession: vi.fn(),
    finishQueueSlot: vi.fn(function (this: Any, taskId: string) {
      this.releaseComputerUseSession(taskId);
      this.queueManager.onTaskFinished(taskId);
    }),
  }) as Any;
}

describe("AgentDaemon.completeTask", () => {
  it("clears pending approvals before completing the task", () => {
    const daemonLike = createDaemonLike();
    const rejected = vi.fn();
    const timeoutHandle = setTimeout(() => undefined, 60_000);

    daemonLike.pendingApprovals.set("approval-1", {
      taskId: "task-1",
      approval: { id: "approval-1" },
      resolve: vi.fn(),
      reject: rejected,
      resolved: false,
      timeoutHandle,
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.pendingApprovals.size).toBe(0);
    expect(daemonLike.approvalRepo.update).toHaveBeenCalledWith("approval-1", "denied");
    expect(daemonLike.logEvent).toHaveBeenCalledWith("task-1", "approval_denied", {
      approvalId: "approval-1",
      reason: "task_ended",
    });
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task ended before the approval request was resolved.",
      }),
    );

    clearTimeout(timeoutHandle);
  });

  it("ignores late failures after the task is already completed", () => {
    const taskState: Any = {
      id: "task-1",
      title: "Task 1",
      status: "executing",
      workspaceId: "workspace-1",
      parentTaskId: "parent-task",
      agentType: "sub",
    };
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById = vi.fn(() => taskState);
    daemonLike.taskRepo.update = vi.fn((_taskId: string, updates: Record<string, unknown>) => {
      Object.assign(taskState, updates);
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");
    AgentDaemon.prototype.failTask.call(daemonLike, "task-1", "late failure");

    expect(taskState.status).toBe("completed");
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

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

  it("persists semanticSummary and verification metadata on completion when provided", () => {
    const daemonLike = createDaemonLike();

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      terminalStatus: "ok",
      semanticSummary: "Read auth config",
      verificationVerdict: "PASS",
      verificationReport: "Verifier confirmed the result.",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        semanticSummary: "Read auth config",
        verificationVerdict: "PASS",
        verificationReport: "Verifier confirmed the result.",
      }),
    );

    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_completed",
      expect.objectContaining({
        semanticSummary: "Read auth config",
        verificationVerdict: "PASS",
        verificationReport: "Verifier confirmed the result.",
      }),
    );
  });

  it("treats strategy-sourced chat as a normal completion path", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      status: "executing",
      workspaceId: "workspace-1",
      parentTaskId: "parent-task",
      agentType: "sub",
      agentConfig: {
        executionMode: "chat",
        executionModeSource: "strategy",
        conversationMode: "chat",
      },
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done");

    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_completed",
      expect.objectContaining({
        message: "Task completed successfully",
      }),
    );
    expect(daemonLike.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "task_status",
      expect.objectContaining({
        message: "Chat turn completed",
      }),
    );
    expect(daemonLike.queueManager.onTaskFinished).toHaveBeenCalledWith("task-1");
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

  it("ignores numbered section scaffolding when extracting key claims", () => {
    const daemonLike = createDaemonLike();

    const keyClaims = (AgentDaemon.prototype as Any).extractKeyClaimSentences.call(
      daemonLike,
      [
        "1. Fascinations",
        "- Missing owner, next action, and deadline in routine status reports",
        "2. Useful tools",
        "- Tight update template: decision, owner, due date, next action",
        "3. Signals to watch",
        "- More pushback on status updates",
        "4. Next experiment",
        "- Score updates for state change vs. activity log for 7 days",
      ].join("\n"),
    );

    expect(keyClaims).toEqual([]);
  });

  it("still extracts concrete dated or measured statements as key claims", () => {
    const daemonLike = createDaemonLike();

    const keyClaims = (AgentDaemon.prototype as Any).extractKeyClaimSentences.call(
      daemonLike,
      "The due date is 2026-04-13 and the exported file is 585 bytes.",
    );

    expect(keyClaims).toEqual([
      "The due date is 2026-04-13 and the exported file is 585 bytes.",
    ]);
  });

  it("treats successful structured verification evidence as satisfying the key-claim gate", () => {
    const daemonLike = createDaemonLike();

    const evidenceCheck = (AgentDaemon.prototype as Any).hasEvidenceForKeyClaims.call(
      daemonLike,
      "task-1",
      "The exported file is 585 bytes.",
      {
        entries: [{ kind: "file_exists", ok: true, detail: "deliverables/report.md exists", capturedAt: Date.now() }],
      },
    );

    expect(evidenceCheck).toEqual({
      passed: true,
      keyClaims: ["The exported file is 585 bytes."],
    });
  });

  it("accepts markdown-linked source notes as inline evidence for key claims", () => {
    const daemonLike = createDaemonLike();

    const evidenceCheck = (AgentDaemon.prototype as Any).hasEvidenceForKeyClaims.call(
      daemonLike,
      "task-1",
      [
        "The exported file is 585 bytes.",
        "Sources: [dev log](/Users/mesut/Downloads/app/cowork/logs/dev-latest.log:12)",
      ].join("\n"),
    );

    expect(evidenceCheck).toEqual({
      passed: true,
      keyClaims: ["The exported file is 585 bytes."],
    });
  });

  it("passes verification evidence through to the key-claim gate during completion", () => {
    const daemonLike = createDaemonLike();
    const verificationEvidenceBundle = {
      entries: [{ kind: "shell_command", ok: true, detail: "ok", capturedAt: Date.now() }],
    };

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "The exported file is 585 bytes.", {
      verificationEvidenceBundle,
    });

    expect(daemonLike.hasEvidenceForKeyClaims).toHaveBeenCalledWith(
      "task-1",
      "The exported file is 585 bytes.",
      verificationEvidenceBundle,
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

  it("auto-waives non-mutation failed steps for soft-deadline best-effort completion", () => {
    const daemonLike = createDaemonLike();
    daemonLike.failedPlanStepsByTask.set("task-1", new Set(["1"]));
    daemonLike.knownPlanStepIdsByTask.set("task-1", new Set(["1"]));
    daemonLike.normalizeStepIdForPlanTracking = AgentDaemon.prototype["normalizeStepIdForPlanTracking"];
    daemonLike.isSyntheticNonPlanStepId = AgentDaemon.prototype["isSyntheticNonPlanStepId"];
    daemonLike.isKnownPlanStepId = AgentDaemon.prototype["isKnownPlanStepId"];
    daemonLike.getUnresolvedFailedSteps = AgentDaemon.prototype["getUnresolvedFailedSteps"];

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "partial", {
      terminalStatus: "partial_success",
      failureClass: "optional_enrichment",
      terminalStatusReason: "Soft deadline reached during execution. Finalizing with best-effort answer.",
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
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("preserves explicit failed terminal metadata from executor finalization", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "Cannot verify required evidence.", {
      terminalStatus: "failed",
      terminalKind: "failed",
      failureClass: "required_verification",
      failedStepIds: ["step:verify"],
      terminalStatusReason: "Task missing required verification evidence.",
      outputSummary: {
        outputCount: 1,
        textOutputCount: 1,
      },
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "required_verification",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "ok",
      }),
    );
    const terminalPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_status",
    )?.[2];
    expect(terminalPayload).toEqual(
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        terminalKind: "failed",
        failureClass: "required_verification",
        failedStepIds: ["step:verify"],
        message: "Task failed",
      }),
    );
  });

  it("does not downgrade explicit failed terminal metadata when completion gates fail", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Verify required output evidence",
      status: "executing",
      workspaceId: "workspace-1",
      parentTaskId: "parent-task",
      agentType: "sub",
      agentConfig: {
        reviewPolicy: "strict",
      },
    });
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);
    daemonLike.runQuickQualityPass.mockReturnValue({
      passed: false,
      issues: ["strict_mode_requires_more_complete_summary"],
    });
    daemonLike.hasEvidenceForKeyClaims.mockReturnValue({
      passed: false,
      keyClaims: ["The required verification passed."],
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "Cannot verify required evidence.", {
      terminalStatus: "failed",
      terminalKind: "failed",
      failureClass: "required_verification",
      failedStepIds: ["step:verify"],
      terminalStatusReason: "Task missing required verification evidence.",
      outputSummary: {
        outputCount: 1,
        textOutputCount: 1,
      },
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "required_verification",
      }),
    );
    expect(daemonLike.taskRepo.update).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    const terminalPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_status",
    )?.[2];
    expect(terminalPayload).toEqual(
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        terminalKind: "failed",
        failureClass: "required_verification",
        failedStepIds: ["step:verify"],
        message: "Task failed",
      }),
    );
  });

  it("treats terminalKind failed as an explicit failed terminal outcome", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "Cannot verify required evidence.", {
      terminalStatus: "ok",
      terminalKind: "failed",
      failureClass: "required_verification",
    });

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "required_verification",
      }),
    );
    const terminalPayload = (daemonLike.logEvent as Any).mock.calls.find(
      (call: unknown[]) => call[1] === "task_status",
    )?.[2];
    expect(terminalPayload).toEqual(
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        message: "Task failed",
      }),
    );
  });

  it("does not run completion-only side effects for explicit failed terminal outcomes", async () => {
    const daemonLike = createDaemonLike();
    const onTaskCompleted = vi.fn().mockResolvedValue(undefined);
    daemonLike.comparisonService = { onTaskCompleted };
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Run tests, edit files, deploy production changes, verify security, and publish release",
      status: "executing",
      workspaceId: "workspace-1",
      agentType: "main",
      worktreeStatus: "active",
      worktreePath: "/tmp/task-1",
      comparisonSessionId: "comparison-1",
      agentConfig: {
        reviewPolicy: "strict",
        entropySweepPolicy: "strict",
      },
    });
    daemonLike.worktreeManager.getSettings.mockReturnValue({
      autoCommitOnComplete: true,
      commitMessagePrefix: "task: ",
    });
    daemonLike.getUnresolvedFailedSteps.mockReturnValue([]);
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "e1",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "tool_call",
        payload: { tool: "run_command", input: { command: "npm test" } },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "Cannot verify required evidence.", {
      terminalStatus: "failed",
      terminalKind: "failed",
      failureClass: "required_verification",
      failedStepIds: ["step:verify"],
      outputSummary: {
        outputCount: 1,
        textOutputCount: 1,
        created: ["artifacts/report.md"],
        primaryOutputPath: "artifacts/report.md",
      },
    });
    await Promise.resolve();

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        terminalStatus: "failed",
        failureClass: "required_verification",
      }),
    );
    expect(daemonLike.runPostCompletionVerification).not.toHaveBeenCalled();
    expect(daemonLike.runPostTaskEntropySweep).not.toHaveBeenCalled();
    expect(daemonLike.worktreeManager.commitTaskChanges).not.toHaveBeenCalled();
    expect(onTaskCompleted).not.toHaveBeenCalled();
    expect(PersonalityManager.recordTaskCompleted).not.toHaveBeenCalled();
    expect(daemonLike.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "verification_started",
      expect.anything(),
    );
    expect(daemonLike.logEvent).not.toHaveBeenCalledWith(
      "task-1",
      "entropy_sweep_started",
      expect.anything(),
    );
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

  it("auto-waives unresolved failures when partial_success already has substantive outputs", () => {
    const daemonLike = createDaemonLike();
    daemonLike.getUnresolvedFailedSteps.mockReturnValue(["step:build"]);
    daemonLike.eventRepo.findByTaskId.mockReturnValue([
      {
        id: "event-output-1",
        taskId: "task-1",
        timestamp: Date.now(),
        type: "timeline_step_finished",
        stepId: "step:build",
        status: "failed",
        legacyType: "step_failed",
        payload: {
          legacyType: "step_failed",
          step: {
            id: "step:build",
            description: "Write the remaining validation artifact",
            error:
              "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 7 reached without successful file/canvas mutation.",
          },
        },
      },
    ]);

    AgentDaemon.prototype.completeTask.call(
      daemonLike,
      "task-1",
      "Created the main deliverables and documented the remaining blocker for the unfinished validation artifact.",
      {
        terminalStatus: "partial_success",
        failureClass: "contract_unmet_write_required",
        failedMutationRequiredStepIds: ["step:build"],
        outputSummary: {
          created: ["artifacts/report.md"],
          primaryOutputPath: "artifacts/report.md",
          outputCount: 1,
          folders: ["artifacts"],
        },
      },
    );

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: "contract_unmet_write_required",
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
        metric: "completion_gate_auto_waive_evidence_backed_steps",
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

  it("passes verification evidence bundle into the quality gate and verifier", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Ship the verified endpoint change",
      status: "executing",
      workspaceId: "workspace-1",
      agentType: "main",
      agentConfig: {
        reviewPolicy: "strict",
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
    const verificationEvidenceBundle = {
      entries: [{ kind: "shell_command", ok: true, detail: "ok", capturedAt: Date.now() }],
    };

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      verificationEvidenceBundle,
    });

    expect(daemonLike.runQuickQualityPass).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationEvidenceBundle,
      }),
    );
    expect(daemonLike.runPostCompletionVerification).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "done",
      verificationEvidenceBundle,
    );
  });

  it("starts entropy sweep for top-level mutating tasks when policy allows it", () => {
    const daemonLike = createDaemonLike();
    daemonLike.taskRepo.findById.mockReturnValue({
      id: "task-1",
      title: "Task 1",
      prompt: "Update docs after code changes",
      status: "executing",
      workspaceId: "workspace-1",
      agentType: "main",
      agentConfig: {
        reviewPolicy: "strict",
      },
    });

    AgentDaemon.prototype.completeTask.call(daemonLike, "task-1", "done", {
      outputSummary: {
        created: ["docs/update.md"],
        modifiedFallback: ["README.md"],
        outputCount: 2,
      },
    });

    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "entropy_sweep_started",
      expect.objectContaining({
        source: "post_completion_entropy_sweep",
      }),
    );
    expect(daemonLike.runPostTaskEntropySweep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({
        parentSummary: "done",
      }),
    );
  });
});
