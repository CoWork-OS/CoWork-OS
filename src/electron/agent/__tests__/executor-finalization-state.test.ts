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
    coreOutcome:
      terminalStatus === "failed" ? "failed" : terminalStatus === "ok" ? "ok" : "partial",
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

/** Keep execute's routing and finalizers real; isolate provider, storage and runtime I/O. */
function createExecutorForEarlyCompletion(prompt: string) {
  const executor = createExecutorForFinalization({ plan: undefined });
  executor.task.prompt = prompt;
  executor.task.semanticSummary = "  Verified completion projection  ";
  executor.workspace = { id: "workspace-finalization", path: "/tmp" };
  executor.daemon.updateTaskStatus = vi.fn();
  executor.getContractPrompt = vi.fn(() => prompt);
  executor.getSessionRuntime = vi.fn(() => ({ resetVerificationState: vi.fn() }));
  executor.ensureVerificationOutcomeSets = vi.fn();
  executor.getBudgetConstrainedFailureStepIdSet = vi.fn(() => new Set());
  executor.buildIntegrationMentionEventPayload = vi.fn(() => ({}));
  executor.buildUserMessageAttachmentEventPayload = vi.fn(() => ({}));
  executor.shouldHandleInitialPromptAsCompanion = vi.fn(() => false);
  executor.isAcpxExternalRuntimeTask = vi.fn(() => false);
  executor.maybeHandleExplicitClaudeCodeDelegation = vi.fn().mockResolvedValue(false);
  executor.getEffectiveExecutionMode = vi.fn(() => "execute");
  executor.getFinalResponseGuardError = vi.fn(() => null);
  executor.buildCompletionContract = vi.fn(() => ({ requiresDirectAnswer: true }));
  executor.responseDirectlyAddressesPrompt = vi.fn(() => true);
  executor.getResolvedRecoveredFailureStepIds = vi.fn(() => []);
  executor.updateConversationHistory = vi.fn();
  executor.createPlan = vi.fn();
  executor.provider = { generate: vi.fn() };
  executor.toolRegistry = { cleanup: vi.fn().mockResolvedValue(undefined) };
  executor.applyRuntimeTaskProjectionToTask.mockReturnValue({ currentAttempt: 3 });
  // These projections and verification decisions must come from the real finalizer.
  delete executor.getCompletionProjectionFields;
  delete executor.applyVerificationOutcomeToTerminalStatus;
  return executor;
}

describe("TaskExecutor terminal finalization state", () => {
  it("persists the substantive response candidate validated by the completion guard", () => {
    const answer =
      "Shared team inbox ranked first with 42 votes; total feature votes were 132. Active teams rose from 128 to 149, a change of 21 or 16.4% based on the observed baseline and latest week.";
    const executor = createExecutorForFinalization();
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
    executor.getFinalResponseGuardError = vi.fn().mockReturnValue(null);
    executor.getBestFinalResponseCandidate = vi.fn().mockReturnValue(answer);
    executor.buildCompletionContract = vi.fn().mockReturnValue({ requiresDirectAnswer: true });
    executor.responseDirectlyAddressesPrompt = vi.fn().mockReturnValue(true);
    executor.getResolvedRecoveredFailureStepIds = vi.fn().mockReturnValue([]);
    executor.capturePlaybookOutcome = vi.fn();
    executor.autoGenerateReport = vi.fn().mockResolvedValue(undefined);
    executor.closeAcpxRuntimeSession = vi.fn().mockResolvedValue(undefined);

    (TaskExecutor as Any).prototype.finalizeTask.call(
      executor,
      "Read-only and no-memory constraints preserved.",
    );

    expect(executor.task.resultSummary).toBe(answer);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-terminal-state",
      answer,
      expect.objectContaining({ terminalStatus: "ok" }),
    );
  });

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
      expect.stringMatching(/^Partial result gathered before stop\.\n\nCompletion notes:\n/),
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "budget_exhausted",
        terminalKind: "timed_out",
        terminalStatusReason:
          "Soft deadline reached during execution. Finalizing with best-effort answer.",
        failedStepIds: ["step-1"],
      }),
    );
    const summary = executor.daemon.completeTask.mock.calls[0][1];
    expect(summary).toContain(
      '- Step "Collect evidence" failed: Step soft-deadline reached after 54s',
    );
    expect(summary).toContain('- Not finished: "Finish remaining work".');
  });

  it("forwards recovered failed step IDs so the daemon completion gate can resolve them", () => {
    const executor = createExecutorForFinalization({
      recoveredFailureStepIds: new Set(["step-1"]),
      plan: {
        description: "Plan",
        steps: [
          {
            id: "step-1",
            description: "Collect evidence",
            status: "failed",
            error: "Original attempt failed",
            completedAt: Date.now(),
            kind: "primary",
          },
          {
            id: "recovery-1",
            description: "Try an alternative toolchain",
            status: "completed",
            completedAt: Date.now(),
            kind: "recovery",
          },
        ],
      },
    });

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Recovered result.",
      "Recovery completed.",
      createTerminalState("partial_success", {
        reason: "Recovery completed.",
        failureClass: "contract_error",
        failedStepIds: ["step-1"],
      }),
    );

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-terminal-state",
      expect.stringMatching(/^Recovered result\./),
      expect.objectContaining({
        recoveredFailedStepIds: ["step-1"],
      }),
    );
    expect(executor.daemon.completeTask.mock.calls[0][1]).not.toContain("Original attempt failed");
  });

  it("does not waive a recovery that was planned but never completed", () => {
    const executor = createExecutorForFinalization({
      recoveredFailureStepIds: new Set(["step-1"]),
    });

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Partial result.",
      "Recovery stopped before completion.",
      createTerminalState("partial_success", {
        reason: "Recovery stopped before completion.",
        failureClass: "contract_error",
        failedStepIds: ["step-1"],
      }),
    );

    expect(executor.daemon.completeTask).not.toHaveBeenCalledWith(
      "task-terminal-state",
      "Partial result.",
      expect.objectContaining({
        recoveredFailedStepIds: expect.anything(),
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

  it.each([
    { verificationOutcome: undefined, terminalStatus: "ok", failureClass: undefined },
    {
      verificationOutcome: "warn_non_blocking",
      terminalStatus: "partial_success",
      failureClass: "contract_error",
    },
    {
      verificationOutcome: "pending_user_action",
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    },
  ])(
    "finalizes external ACP completion with $terminalStatus and retains verification/projections",
    async ({ verificationOutcome, terminalStatus, failureClass }) => {
      const prompt = "Summarize the inspected runtime evidence.";
      const answer = "The runtime evidence confirms all three inspected services are healthy.";
      const executor = createExecutorForEarlyCompletion(prompt);
      executor.verificationOutcomeV2Enabled = true;
      executor.isAcpxExternalRuntimeTask.mockReturnValue(true);
      executor.getAcpxRuntimeAgentDisplayName = vi.fn(() => "Codex");
      const verificationMetadata = verificationOutcome
        ? {
            verificationOutcome,
            verificationScope: "normal",
            verificationEvidenceMode: "agent_observable",
            pendingChecklist: ["Review external verification evidence."],
            verificationMessage: "External verification needs review.",
          }
        : undefined;
      const runner = {
        createSession: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn(async () => {
          // execute() resets old verification state before the runtime starts.
          executor.completionVerificationMetadata = verificationMetadata;
          return { assistantText: `  ${answer}  `, stopReason: "end_turn", changedPaths: [] };
        }),
      };
      executor.getAcpxRuntimeRunner = vi.fn(() => runner);

      await executor.execute();

      expect(runner.createSession).toHaveBeenCalledOnce();
      expect(runner.prompt).toHaveBeenCalledWith(prompt);
      expect(executor.taskCompleted).toBe(true);
      expect(executor.task).toMatchObject({ status: "completed", terminalStatus });
      expect(executor.task.failureClass).toBe(failureClass);
      expect(executor.task.completedAt).toEqual(expect.any(Number));
      expect(executor.lastNonVerificationOutput).toBe(answer);
      expect(executor.daemon.completeTask).toHaveBeenCalledOnce();
      expect(executor.daemon.completeTask).toHaveBeenCalledWith(
        "task-terminal-state",
        expect.stringContaining(answer),
        expect.objectContaining({
          terminalStatus,
          failureClass,
          terminalStatusReason: "acpx runtime completed",
          currentAttempt: 3,
          semanticSummary: "Verified completion projection",
          ...verificationMetadata,
        }),
      );
      expect(executor.task.resultSummary).toBe(executor.daemon.completeTask.mock.calls[0][1]);
      expect(executor.capturePlaybookOutcome).not.toHaveBeenCalled();
      expect(executor.stopProgressJournal).toHaveBeenCalledOnce();
      expect(executor.saveConversationSnapshot).toHaveBeenCalledOnce();
      expect(executor.closeAcpxRuntimeSession).toHaveBeenCalledWith("best-effort completion");
      expect(executor.createPlan).not.toHaveBeenCalled();
      expect(executor.provider.generate).not.toHaveBeenCalled();
      expect(executor.toolRegistry.cleanup).toHaveBeenCalledOnce();
      expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    },
  );

  it.each(["/onboard", "/start", "/begin"])(
    "routes %s through deterministic completion with the substantive answer and projections",
    async (command) => {
      const executor = createExecutorForEarlyCompletion(command);

      await executor.execute();

      const answer =
        `${command} opens the onboarding flow in the desktop UI.\n\n` +
        "Use it from the main composer or Settings > Appearance > Run onboarding again. " +
        "That flow updates your assistant profile, priorities, tools, response style, and workspace kit notes.";
      expect(executor.updateConversationHistory).toHaveBeenCalledWith([
        { role: "user", content: [{ type: "text", text: command }] },
        { role: "assistant", content: [{ type: "text", text: answer }] },
      ]);
      expect(executor.emitEvent).toHaveBeenCalledWith("assistant_message", { message: answer });
      expect(executor.taskCompleted).toBe(true);
      expect(executor.task).toMatchObject({
        status: "completed",
        terminalStatus: "ok",
        resultSummary: answer,
        completedAt: expect.any(Number),
      });
      expect(executor.daemon.completeTask).toHaveBeenCalledOnce();
      expect(executor.daemon.completeTask).toHaveBeenCalledWith(
        "task-terminal-state",
        answer,
        expect.objectContaining({
          terminalStatus: "ok",
          terminalStatusReason: "executor_terminal_ok",
          currentAttempt: 3,
          semanticSummary: "Verified completion projection",
        }),
      );
      expect(executor.capturePlaybookOutcome).toHaveBeenCalledWith("success");
      expect(executor.stopProgressJournal).toHaveBeenCalledOnce();
      expect(executor.saveConversationSnapshot).toHaveBeenCalledOnce();
      expect(executor.closeAcpxRuntimeSession).toHaveBeenCalledWith("completion");
      expect(executor.createPlan).not.toHaveBeenCalled();
      expect(executor.provider.generate).not.toHaveBeenCalled();
      expect(executor.toolRegistry.cleanup).toHaveBeenCalledOnce();
      expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    },
  );
});
