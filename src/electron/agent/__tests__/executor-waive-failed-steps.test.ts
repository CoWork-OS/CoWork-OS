import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { FileMutationVerifier } from "../file-mutation-verifier";

function getWaivableStepIds(
  steps: Array<{ id: string; description: string; status: string; kind?: string }>,
  opts?: {
    budgetConstrainedFailedStepIds?: string[];
    blockingVerificationFailedStepIds?: string[];
    nonBlockingVerificationFailedStepIds?: string[];
    planCompletedEffectively?: boolean;
  },
): string[] {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.plan = { description: "Plan", steps };
  executor.budgetConstrainedFailedStepIds = new Set(opts?.budgetConstrainedFailedStepIds || []);
  executor.blockingVerificationFailedStepIds = new Set(
    opts?.blockingVerificationFailedStepIds || [],
  );
  executor.nonBlockingVerificationFailedStepIds = new Set(
    opts?.nonBlockingVerificationFailedStepIds || [],
  );
  executor.planCompletedEffectively = !!opts?.planCompletedEffectively;
  return (TaskExecutor as Any).prototype.getWaivableFailedStepIdsAtCompletion.call(executor);
}

describe("TaskExecutor getWaivableFailedStepIdsAtCompletion", () => {
  it("returns failed verification step ids when they are marked non-blocking", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Write response", status: "completed", kind: "primary" },
        {
          id: "2",
          description: "Verify: check final response",
          status: "failed",
          kind: "verification",
        },
      ],
      {
        nonBlockingVerificationFailedStepIds: ["2"],
      },
    );

    expect(result).toEqual(["2"]);
  });

  it("returns empty when a non-verification step failed", () => {
    const result = getWaivableStepIds([
      { id: "1", description: "Write response", status: "failed", kind: "primary" },
      {
        id: "2",
        description: "Verify: check final response",
        status: "failed",
        kind: "verification",
      },
    ]);

    expect(result).toEqual([]);
  });

  it("returns empty when non-verification steps are not all completed", () => {
    const result = getWaivableStepIds([
      { id: "1", description: "Write response", status: "pending", kind: "primary" },
      {
        id: "2",
        description: "Verify: check final response",
        status: "failed",
        kind: "verification",
      },
    ]);

    expect(result).toEqual([]);
  });

  it("returns empty when there are no failed steps", () => {
    const result = getWaivableStepIds([
      { id: "1", description: "Write response", status: "completed", kind: "primary" },
    ]);

    expect(result).toEqual([]);
  });

  it("falls back to heuristic verification detection when step kind is missing", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Write response", status: "completed" },
        { id: "2", description: "Verify: check final response", status: "failed" },
      ],
      {
        nonBlockingVerificationFailedStepIds: ["2"],
      },
    );

    expect(result).toEqual(["2"]);
  });

  it("treats verify-described steps as waivable even when planner kind is primary", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Write response", status: "completed", kind: "primary" },
        { id: "2", description: "Verify: run final checks", status: "failed", kind: "primary" },
      ],
      {
        nonBlockingVerificationFailedStepIds: ["2"],
      },
    );

    expect(result).toEqual(["2"]);
  });

  it("waives budget-constrained failed steps when completion evidence is sufficient", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Collect latest sources", status: "failed", kind: "primary" },
        { id: "2", description: "Draft summary", status: "completed", kind: "primary" },
        { id: "3", description: "Finalize output", status: "completed", kind: "primary" },
      ],
      {
        budgetConstrainedFailedStepIds: ["1"],
      },
    );

    expect(result).toEqual(["1"]);
  });

  it("does not waive non-budget functional failures", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Collect latest sources", status: "failed", kind: "primary" },
        { id: "2", description: "Draft summary", status: "completed", kind: "primary" },
        { id: "3", description: "Finalize output", status: "completed", kind: "primary" },
      ],
      {
        budgetConstrainedFailedStepIds: [],
      },
    );

    expect(result).toEqual([]);
  });

  it("waives only the budget-constrained non-mutation failure in mixed-failure plans", () => {
    const result = getWaivableStepIds(
      [
        { id: "1", description: "Collect Reddit findings", status: "failed", kind: "primary" },
        { id: "2", description: "Collect X findings", status: "completed", kind: "primary" },
        { id: "3", description: "Draft report", status: "completed", kind: "primary" },
        {
          id: "5",
          description: "Collect tech news findings",
          status: "completed",
          kind: "primary",
        },
        {
          id: "4",
          description: "Verify completeness and accuracy before marking complete",
          status: "failed",
          kind: "verification",
        },
      ],
      {
        budgetConstrainedFailedStepIds: ["1"],
        nonBlockingVerificationFailedStepIds: ["4"],
      },
    );

    expect(result).toEqual(["1"]);
  });

  it("does not waive mutation-required failures even in completion-with-warnings mode", () => {
    const result = getWaivableStepIds(
      [
        {
          id: "1",
          description: "Create findings.md with full sections and citations",
          status: "failed",
          kind: "primary",
        },
        { id: "2", description: "Normalize findings", status: "completed", kind: "primary" },
        { id: "3", description: "Finalize answer", status: "completed", kind: "primary" },
      ],
      {
        planCompletedEffectively: true,
      },
    );

    expect(result).toEqual([]);
  });

  it("does not downgrade completion for failed steps reconciled by later artifact evidence", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "prepare-report",
          description: "Prepare report.md",
          status: "failed",
        },
        {
          id: "write-report",
          description: "Write report.md with the verified figures",
          status: "completed",
        },
      ],
    };
    executor.getResolvedRecoveredFailureStepIds = vi.fn(() => ["prepare-report"]);
    executor.getVerificationState = vi.fn(() => ({ blockingVerificationFailedStepIds: new Set() }));
    executor.ensureVerificationOutcomeSets = vi.fn();
    executor.getBudgetConstrainedFailureStepIdSet = vi.fn(() => new Set());
    executor.buildResultSummary = vi.fn(
      () => "The requested report was written and read back with all verified figures.",
    );
    executor.getContentFallback = vi.fn(() => "");
    executor.isBoundedDocumentAnalysisTask = vi.fn(() => false);
    executor.responseLooksOperationalOnly = vi.fn(() => false);
    executor.shouldPreferBestEffortCompletion = vi.fn(() => true);
    executor.hasExecutionEvidence = vi.fn(() => true);
    executor.buildTaskOutputSummary = vi.fn(() => ({ outputCount: 1 }));
    executor.bestKnownOutcome = { outputSummary: { outputCount: 1 } };
    executor.isMutationRequiredStepForCompletion = vi.fn(() => false);

    const result = (TaskExecutor as Any).prototype.getWaivableFailedStepIdsAtCompletion.call(
      executor,
    );

    expect(result).toEqual([]);
  });
});

describe("TaskExecutor verification terminal status mapping", () => {
  it("maps pending_user_action verification outcomes to needs_user_action", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.verificationOutcomeV2Enabled = true;
    executor.completionVerificationMetadata = {
      verificationOutcome: "pending_user_action",
      verificationScope: "normal",
      verificationEvidenceMode: "time_blocked",
      pendingChecklist: ["Record final timed mock evidence."],
      verificationMessage: "Pending user action.",
    };

    const result = (TaskExecutor as Any).prototype.applyVerificationOutcomeToTerminalStatus.call(
      executor,
      "ok",
      undefined,
    );

    expect(result).toEqual({
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    });
  });

  it("maps warn_non_blocking verification outcomes to partial_success from ok", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.verificationOutcomeV2Enabled = true;
    executor.completionVerificationMetadata = {
      verificationOutcome: "warn_non_blocking",
      verificationScope: "normal",
      verificationEvidenceMode: "agent_observable",
      pendingChecklist: [],
      verificationMessage: "Verification warning.",
    };

    const result = (TaskExecutor as Any).prototype.applyVerificationOutcomeToTerminalStatus.call(
      executor,
      "ok",
      undefined,
    );

    expect(result).toEqual({
      terminalStatus: "partial_success",
      failureClass: "contract_error",
    });
  });

  it("uses budget_exhausted when partial_success comes from budget-constrained waivers", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-1",
      title: "Task",
      prompt: "Prompt",
      status: "executing",
      createdAt: Date.now(),
    };
    executor.daemon = { completeTask: vi.fn() };
    executor.verificationOutcomeV2Enabled = false;
    executor.budgetConstrainedFailedStepIds = new Set(["step-budget"]);
    executor.stopProgressJournal = vi.fn();
    executor.saveConversationSnapshot = vi.fn();
    executor.getWaivableFailedStepIdsAtCompletion = vi.fn().mockReturnValue(["step-budget"]);
    executor.getNonBlockingFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
    executor.buildResultSummary = vi.fn().mockReturnValue("Budget constrained summary");
    executor.buildTaskOutputSummary = vi.fn().mockReturnValue(undefined);
    executor.getBudgetUsage = vi.fn().mockReturnValue({
      turns: 1,
      lifetimeTurns: 1,
      toolCalls: 2,
      webSearchCalls: 2,
      duplicatesBlocked: 0,
    });
    executor.emitEvent = vi.fn();
    executor.emitRunSummary = vi.fn();
    executor.continuationCount = 0;
    executor.continuationWindow = 1;
    executor.lifetimeTurnCount = 1;
    executor.terminalStatus = "ok";
    executor.failureClass = undefined;

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "Budget constrained summary",
    );

    expect(executor.task.terminalStatus).toBe("partial_success");
    expect(executor.task.failureClass).toBe("budget_exhausted");
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "Budget constrained summary",
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "budget_exhausted",
      }),
    );
  });

  it("uses contract_error when waivers mix budget and non-budget failures", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-1",
      title: "Task",
      prompt: "Prompt",
      status: "executing",
      createdAt: Date.now(),
    };
    executor.daemon = { completeTask: vi.fn() };
    executor.verificationOutcomeV2Enabled = false;
    executor.budgetConstrainedFailedStepIds = new Set(["step-budget"]);
    executor.stopProgressJournal = vi.fn();
    executor.saveConversationSnapshot = vi.fn();
    executor.getWaivableFailedStepIdsAtCompletion = vi
      .fn()
      .mockReturnValue(["step-budget", "step-verify"]);
    executor.getNonBlockingFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
    executor.buildResultSummary = vi.fn().mockReturnValue("Mixed waiver summary");
    executor.buildTaskOutputSummary = vi.fn().mockReturnValue(undefined);
    executor.getBudgetUsage = vi.fn().mockReturnValue({
      turns: 1,
      lifetimeTurns: 1,
      toolCalls: 2,
      webSearchCalls: 1,
      duplicatesBlocked: 0,
    });
    executor.emitEvent = vi.fn();
    executor.emitRunSummary = vi.fn();
    executor.continuationCount = 0;
    executor.continuationWindow = 1;
    executor.lifetimeTurnCount = 1;
    executor.terminalStatus = "ok";
    executor.failureClass = undefined;

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(executor, "Mixed waiver summary");

    expect(executor.task.terminalStatus).toBe("partial_success");
    expect(executor.task.failureClass).toBe("optional_enrichment");
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "Mixed waiver summary",
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "optional_enrichment",
      }),
    );
  });
});

describe("TaskExecutor completion notes for partial outcomes", () => {
  function createBestEffortExecutor(): Any {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-1",
      title: "Compare vendor pricing",
      prompt: "Compare vendor pricing",
      status: "executing",
      createdAt: Date.now(),
    };
    executor.daemon = { completeTask: vi.fn() };
    executor.verificationOutcomeV2Enabled = false;
    executor.budgetConstrainedFailedStepIds = new Set();
    executor.stopProgressJournal = vi.fn();
    executor.saveConversationSnapshot = vi.fn();
    executor.getWaivableFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
    executor.getNonBlockingFailedStepIdsAtCompletion = vi.fn().mockReturnValue([]);
    executor.buildTaskOutputSummary = vi.fn().mockReturnValue(undefined);
    executor.getBudgetUsage = vi.fn().mockReturnValue({
      turns: 1,
      lifetimeTurns: 1,
      toolCalls: 2,
      webSearchCalls: 0,
      duplicatesBlocked: 0,
    });
    executor.emitEvent = vi.fn();
    executor.emitRunSummary = vi.fn();
    executor.continuationCount = 0;
    executor.continuationWindow = 1;
    executor.lifetimeTurnCount = 1;
    executor.terminalStatus = "ok";
    executor.failureClass = undefined;
    executor.plan = {
      description: "Plan",
      steps: [
        { id: "collect", description: "Collect pricing from vendor sites", status: "completed" },
        { id: "compare", description: "Compare plans across vendors", status: "pending" },
      ],
    };
    return executor;
  }

  it("states why a timed-out run stopped and which writes failed", () => {
    const executor = createBestEffortExecutor();
    const answer = "Vendor A Pro is $49/month; Vendor B pricing was not collected.";
    executor.buildResultSummary = vi.fn().mockReturnValue(answer);
    executor.fileMutationVerifier = new FileMutationVerifier();
    executor.fileMutationVerifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "comparison.md" },
      succeeded: false,
      error: "ENOSPC: no space left on device",
    });
    const reason = "Soft deadline reached during execution. Finalizing with best-effort answer.";

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(executor, answer, reason, {
      terminalKind: "timed_out",
      reason,
      failureClass: "budget_exhausted",
      incompleteStepIds: ["compare"],
    });

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    const [, summary, metadata] = executor.daemon.completeTask.mock.calls[0];
    expect(metadata).toMatchObject({ terminalStatus: "partial_success", terminalKind: "timed_out" });
    expect(summary.startsWith(answer)).toBe(true);
    expect(summary).toContain("Completion notes:");
    expect(summary).toContain("Soft deadline reached during execution.");
    expect(summary).toContain('"Compare plans across vendors"');
    expect(summary).toContain('write_file("comparison.md"): ENOSPC: no space left on device');
    expect(executor.task.resultSummary).toBe(summary);
  });

  it("names the error behind a partial-success finalization", () => {
    const executor = createBestEffortExecutor();
    const partialText = "Collected 3 of 5 vendor price lists: A $49, B $39, C $59 per month.";
    executor.buildResultSummary = vi.fn().mockReturnValue(partialText);
    executor.shouldFinalizeAsPartialSuccess = vi.fn(() => true);
    executor.getPartialSuccessSummary = vi.fn(() => partialText);
    executor.classifyPartialSuccessFailureClass = vi.fn(() => "tool_error");

    const finalized = (TaskExecutor as Any).prototype.maybeFinalizeAsPartialSuccess.call(
      executor,
      new Error("web_fetch failed: 403 Forbidden for https://vendor-d.example/pricing"),
    );

    expect(finalized).toBe(true);
    const [, summary, metadata] = executor.daemon.completeTask.mock.calls[0];
    expect(metadata).toMatchObject({
      terminalStatus: "partial_success",
      failureClass: "tool_error",
      terminalStatusReason: "Execution completed with partial results.",
    });
    expect(summary.startsWith(partialText)).toBe(true);
    expect(summary).toContain("Completion notes:");
    expect(summary).toContain(
      "web_fetch failed: 403 Forbidden for https://vendor-d.example/pricing",
    );
  });

  it("leaves a clean completion summary unchanged", () => {
    const executor = createBestEffortExecutor();
    executor.plan.steps[1].status = "completed";
    executor.buildResultSummary = vi.fn().mockReturnValue("All vendors compared.");

    (TaskExecutor as Any).prototype.finalizeTaskBestEffort.call(
      executor,
      "All vendors compared.",
      "Simple non-execute prompt answered directly via answer-first short-circuit.",
    );

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "All vendors compared.",
      expect.objectContaining({ terminalStatus: "ok" }),
    );
  });
});
