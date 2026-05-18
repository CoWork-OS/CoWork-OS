import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { decideTaskOutcome } from "../outcome-policy";
import { createTerminalState } from "../runtime/TerminalState";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

function createExecutorForFinalization(overrides: Partial<Any> = {}): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-terminal-state",
    title: "Terminal state task",
    prompt: "Do the work",
    status: "executing",
    createdAt: Date.now(),
    agentConfig: { executionMode: "execute" },
  };
  executor.daemon = { completeTask: vi.fn(), updateTask: vi.fn() };
  executor.plan = {
    description: "Plan",
    steps: [
      {
        id: "step-1",
        description: "Collect evidence",
        status: "failed",
        error: "Step soft-deadline reached after 54s",
        completedAt: Date.now(),
        kind: "primary",
      },
      {
        id: "step-2",
        description: "Finish remaining work",
        status: "pending",
        kind: "primary",
      },
    ],
  };
  executor.verificationOutcomeV2Enabled = false;
  executor.softDeadlineTriggered = false;
  executor.wrapUpRequested = false;
  executor.terminalStatus = "ok";
  executor.failureClass = undefined;
  executor.taskFailureDomains = new Set();
  executor.stepStopReasons = new Set();
  executor.stopProgressJournal = vi.fn();
  executor.saveConversationSnapshot = vi.fn();
  executor.endDebugRuntimeSessionIfNeeded = vi.fn();
  executor.getWaivableFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
  executor.getNonBlockingFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
  executor.getFailedMutationRequiredStepIdsAtCompletion = vi.fn().mockReturnValue([]);
  executor.getVerificationStepIds = vi.fn().mockReturnValue([]);
  executor.applyRuntimeTaskProjectionToTask = vi.fn().mockReturnValue({});
  executor.applyVerificationOutcomeToTerminalStatus = vi
    .fn()
    .mockImplementation((terminalStatus: string, failureClass?: string) => ({
      terminalStatus,
      failureClass,
    }));
  executor.computeReliabilityOutcomes = vi.fn().mockImplementation((terminalStatus: string) => ({
    coreOutcome: terminalStatus === "failed" ? "failed" : terminalStatus === "ok" ? "ok" : "partial",
    dependencyOutcome: "healthy",
    failureDomains: [],
    stopReasons: [],
  }));
  executor.buildTaskOutputSummary = vi.fn().mockReturnValue({
    outputCount: 1,
    textOutputCount: 1,
  });
  executor.persistBestKnownOutcome = vi.fn();
  executor.applyGoalTerminalState = vi.fn().mockReturnValue(undefined);
  executor.emitEvent = vi.fn();
  executor.emitRunSummary = vi.fn();
  executor.closeAcpxRuntimeSession = vi.fn().mockResolvedValue(undefined);
  executor.getCompletionProjectionFields = vi.fn().mockReturnValue({});
  executor.getVerificationState = vi.fn().mockReturnValue({ verificationEvidenceEntries: [] });
  executor.buildResultSummary = vi.fn().mockReturnValue("Partial result gathered before stop.");
  executor.getContentFallback = vi.fn().mockReturnValue("");
  executor.hasSubstantivePartialSuccessEvidence = vi.fn().mockReturnValue(true);
  executor.classifyFailure = vi.fn().mockReturnValue("contract_error");
  executor.isBudgetExhaustionError = vi.fn().mockReturnValue(false);
  executor.isSourceValidationGuardError = vi.fn().mockReturnValue(false);
  executor.emitRunSummary = vi.fn();
  executor.capturePlaybookOutcome = vi.fn();
  executor.autoGenerateReport = vi.fn().mockResolvedValue(undefined);

  return Object.assign(executor, overrides);
}

describe("TaskExecutor terminal finalization state", () => {
  it("preserves explicit failed terminal status through completed daemon outcome normalization", () => {
    const outcome = decideTaskOutcome({
      requestedStatus: "completed",
      terminalStatus: "failed",
      failureClass: "required_verification",
      resultSummary: "Cannot verify required evidence.",
      outputSummary: {
        outputCount: 1,
        textOutputCount: 1,
      },
    });

    expect(outcome).toEqual({
      status: "failed",
      terminalStatus: "failed",
      failureClass: "required_verification",
    });
  });

  it("maps soft timeout to partial timed_out terminal state instead of ordinary ok completion", () => {
    const executor = createExecutorForFinalization({
      softDeadlineTriggered: true,
      stepStopReasons: new Set(["max_turns"]),
    });
    const terminalState = createTerminalState("timed_out", {
      reason: "Soft deadline reached during execution. Finalizing with best-effort answer.",
      failedStepIds: ["step-1"],
    });

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Partial result gathered before stop.",
      terminalState.reason,
      terminalState,
    );

    expect(executor.task.terminalStatus).toBe("partial_success");
    expect(executor.task.failureClass).toBe("budget_exhausted");
    expect(executor.task.coreOutcome).toBe("partial");
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-terminal-state",
      "Partial result gathered before stop.",
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "budget_exhausted",
        terminalKind: "timed_out",
        terminalStatusReason:
          "Soft deadline reached during execution. Finalizing with best-effort answer.",
        failedStepIds: ["step-1"],
      }),
    );
  });

  it("maps user input pause to needs_user_action terminal state", () => {
    const executor = createExecutorForFinalization();
    const terminalState = createTerminalState("needs_user_action", {
      reason: "Task paused pending user approval or input.",
    });

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Current answer is blocked on approval.",
      terminalState.reason,
      terminalState,
    );

    expect(executor.task.terminalStatus).toBe("needs_user_action");
    expect(executor.task.failureClass).toBeUndefined();
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-terminal-state",
      "Current answer is blocked on approval.",
      expect.objectContaining({
        terminalKind: "needs_user_action",
        terminalStatus: "needs_user_action",
        failureClass: undefined,
      }),
    );
  });

  it("maps failed required evidence to failed rather than best-effort completed", () => {
    const executor = createExecutorForFinalization();
    const terminalState = createTerminalState("failed", {
      reason: "Task missing required verification evidence.",
      failureClass: "required_verification",
      failedStepIds: ["step-1"],
    });

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Cannot verify required evidence.",
      terminalState.reason,
      terminalState,
    );

    expect(executor.task.terminalStatus).toBe("failed");
    expect(executor.task.failureClass).toBe("required_verification");
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-terminal-state",
      "Cannot verify required evidence.",
      expect.objectContaining({
        terminalKind: "failed",
        terminalStatus: "failed",
        failureClass: "required_verification",
        failedStepIds: ["step-1"],
      }),
    );
  });

  it.todo(
    "covers ACP external completion once an executor-local ACP completion harness exists; current ACP tests exercise runtime routing, not finalizer projection.",
  );

  it.todo(
    "covers deterministic handled completion once deterministic slash-command finalization is exposed without running full execute().",
  );
});
