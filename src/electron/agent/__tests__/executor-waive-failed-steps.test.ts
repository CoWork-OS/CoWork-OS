import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

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
