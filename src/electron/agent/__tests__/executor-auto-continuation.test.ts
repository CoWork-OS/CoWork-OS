import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { GuardrailManager } from "../../guardrails/guardrail-manager";

function makeExecutor(overrides: Record<string, unknown> = {}): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-1",
    title: "Task",
    prompt: "Prompt",
    agentConfig: {},
  };
  executor.plan = {
    steps: [{ id: "s1", status: "pending" }],
  };
  executor.autoContinueOnTurnLimit = true;
  executor.continuationCount = 0;
  executor.continuationWindow = 1;
  executor.maxAutoContinuations = 3;
  executor.minProgressScoreForAutoContinue = 0.25;
  executor.continuationStrategy = "adaptive_progress";
  executor.lifetimeTurnCount = 12;
  executor.maxLifetimeTurns = 320;
  executor.assessContinuationWindow = vi.fn(() => ({
    progressScore: 0.5,
    loopRiskIndex: 0.2,
    repeatedFingerprintCount: 1,
    dominantFingerprint: "tool::input::error",
    windowSummary: {
      stepCompleted: 1,
      writeMutations: 1,
      resolvedErrorRecoveries: 0,
      repeatedErrorPenalty: 0,
      emptyNoOpTurns: 0,
    },
  }));
  executor.continueAfterBudgetExhaustedUnlocked = vi.fn(async () => undefined);
  executor.daemon = {
    updateTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    getTaskEvents: vi.fn(() => []),
  };
  executor.toolRegistry = {
    cleanup: vi.fn(async () => undefined),
  };
  executor.emitEvent = vi.fn();
  Object.assign(executor, overrides);
  return executor;
}

describe("TaskExecutor auto continuation decisions", () => {
  it("auto-continues to the next window when progress is sufficient", async () => {
    const executor = makeExecutor();
    const continueAfterBudgetExhausted = vi
      .spyOn(executor.runtime, "continueAfterBudgetExhausted")
      .mockResolvedValue(undefined);

    const continued = await executor.maybeAutoContinueAfterTurnLimit(
      new Error("Global turn limit exceeded: 60/60 turns."),
    );

    expect(continued).toBe(true);
    expect(executor.continuationCount).toBe(1);
    expect(executor.continuationWindow).toBe(2);
    expect(continueAfterBudgetExhausted).toHaveBeenCalledWith(
      "auto",
      expect.objectContaining({
        progressScore: 0.5,
      }),
      true,
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "auto_continuation_started",
      expect.objectContaining({
        continuationCount: 1,
        continuationWindow: 2,
      }),
    );
  });

  it("blocks when progress score is below threshold", async () => {
    const executor = makeExecutor({
      assessContinuationWindow: vi.fn(() => ({
        progressScore: 0.1,
        loopRiskIndex: 0.2,
        repeatedFingerprintCount: 1,
        dominantFingerprint: "tool::input::error",
        windowSummary: {
          stepCompleted: 0,
          writeMutations: 0,
          resolvedErrorRecoveries: 0,
          repeatedErrorPenalty: 0,
          emptyNoOpTurns: 1,
        },
      })),
    });

    const continued = await executor.maybeAutoContinueAfterTurnLimit(
      new Error("Global turn limit exceeded: 60/60 turns."),
    );

    expect(continued).toBe(false);
    expect(executor.continueAfterBudgetExhaustedUnlocked).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "auto_continuation_blocked",
      expect.objectContaining({
        reason: expect.stringContaining("below threshold"),
      }),
    );
  });

  it("blocks when loop risk is high from repeated identical failures", async () => {
    const executor = makeExecutor({
      assessContinuationWindow: vi.fn(() => ({
        progressScore: 0.8,
        loopRiskIndex: 0.75,
        repeatedFingerprintCount: 3,
        dominantFingerprint: "run_command::npm test::ENOENT",
        windowSummary: {
          stepCompleted: 1,
          writeMutations: 0,
          resolvedErrorRecoveries: 0,
          repeatedErrorPenalty: 1.6,
          emptyNoOpTurns: 0,
        },
      })),
    });

    const continued = await executor.maybeAutoContinueAfterTurnLimit(
      new Error("Global turn limit exceeded: 60/60 turns."),
    );

    expect(continued).toBe(false);
    expect(executor.continueAfterBudgetExhaustedUnlocked).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "auto_continuation_blocked",
      expect.objectContaining({
        reason: expect.stringContaining("Loop risk is high"),
      }),
    );
  });

  it("honors configured deep-work progress thresholds", async () => {
    const executor = makeExecutor({
      task: {
        id: "task-1",
        agentConfig: {
          deepWorkMode: true,
          minProgressScoreForAutoContinue: 0.7,
        },
      },
      minProgressScoreForAutoContinue: 0.7,
      assessContinuationWindow: vi.fn(() => ({
        progressScore: 0.4,
        loopRiskIndex: 0.2,
        repeatedFingerprintCount: 1,
        dominantFingerprint: "tool::input::error",
        windowSummary: {
          stepCompleted: 1,
          writeMutations: 0,
          resolvedErrorRecoveries: 0,
          repeatedErrorPenalty: 0,
          emptyNoOpTurns: 0,
        },
      })),
    });

    const continued = await executor.maybeAutoContinueAfterTurnLimit(
      new Error("Global turn limit exceeded: 250/250 turns."),
    );

    expect(continued).toBe(false);
    expect(executor.continueAfterBudgetExhaustedUnlocked).not.toHaveBeenCalled();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "auto_continuation_blocked",
      expect.objectContaining({
        reason: expect.stringContaining("below threshold"),
      }),
    );
  });
});

describe("TaskExecutor terminal error dedupe", () => {
  it("suppresses duplicate terminal failures inside dedupe window", () => {
    const executor = makeExecutor({
      terminalFailureDedupWindowMs: 5000,
      lastTerminalFailureFingerprint: "",
      lastTerminalFailureAt: 0,
    });

    const emittedFirst = executor.emitTerminalFailureOnce({
      message: "Global turn limit exceeded: 60/60 turns.",
      errorCode: "TURN_LIMIT_EXCEEDED",
    });
    const emittedSecond = executor.emitTerminalFailureOnce({
      message: "Global turn limit exceeded: 60/60 turns.",
      errorCode: "TURN_LIMIT_EXCEEDED",
    });
    const emittedThird = executor.emitTerminalFailureOnce({
      message: "Different error",
      errorCode: "TURN_LIMIT_EXCEEDED",
    });

    expect(emittedFirst).toBe(true);
    expect(emittedSecond).toBe(false);
    expect(emittedThird).toBe(true);
    expect(executor.emitEvent).toHaveBeenCalledTimes(2);
  });
});

describe("TaskExecutor continuation budgets", () => {
  it("uses the tighter of window and lifetime turn budgets", () => {
    const executor = makeExecutor({
      globalTurnCount: 10,
      maxGlobalTurns: 60,
      lifetimeTurnCount: 10,
      maxLifetimeTurns: 14,
    });

    expect(executor.getRemainingTurnBudget()).toBe(4);
  });

  it("allows lifetime caps below window caps and enforces them", () => {
    vi.spyOn(GuardrailManager, "isIterationLimitExceeded").mockReturnValue({
      exceeded: false,
      iterations: 0,
      limit: 50,
    });
    vi.spyOn(GuardrailManager, "isTokenBudgetExceeded").mockReturnValue({
      exceeded: false,
      used: 0,
      limit: 100000,
    });
    vi.spyOn(GuardrailManager, "isCostBudgetExceeded").mockReturnValue({
      exceeded: false,
      cost: 0,
      limit: 1,
    });

    const executor = makeExecutor({
      globalTurnCount: 5,
      maxGlobalTurns: 60,
      lifetimeTurnCount: 6,
      maxLifetimeTurns: 6,
    });

    expect(() => executor.checkBudgets()).toThrow(/Lifetime turn limit exceeded/i);
    vi.restoreAllMocks();
  });

  it("does not hard-fail on window exhaustion in adaptive_unbounded mode", () => {
    vi.spyOn(GuardrailManager, "isIterationLimitExceeded").mockReturnValue({
      exceeded: false,
      iterations: 0,
      limit: 50,
    });
    vi.spyOn(GuardrailManager, "isTokenBudgetExceeded").mockReturnValue({
      exceeded: false,
      used: 0,
      limit: 100000,
    });
    vi.spyOn(GuardrailManager, "isCostBudgetExceeded").mockReturnValue({
      exceeded: false,
      cost: 0,
      limit: 1,
    });

    const executor = makeExecutor({
      globalTurnCount: 60,
      maxGlobalTurns: 60,
      lifetimeTurnCount: 100,
      maxLifetimeTurns: 3000,
      turnBudgetPolicy: "adaptive_unbounded",
      turnlessExecutionV4Enabled: true,
      turnWindowSoftExhaustedNotified: false,
    });

    expect(() => executor.checkBudgets()).not.toThrow();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "turn_window_soft_exhausted",
      expect.objectContaining({
        policy: "adaptive_unbounded",
        turnsUsed: 60,
        windowTurnCap: 60,
      }),
    );

    vi.restoreAllMocks();
  });

  it("does not enforce a global window when no explicit cap is configured", () => {
    vi.spyOn(GuardrailManager, "isIterationLimitExceeded").mockReturnValue({
      exceeded: false,
      iterations: 0,
      limit: 50,
    });
    vi.spyOn(GuardrailManager, "isTokenBudgetExceeded").mockReturnValue({
      exceeded: false,
      used: 0,
      limit: 100000,
    });
    vi.spyOn(GuardrailManager, "isCostBudgetExceeded").mockReturnValue({
      exceeded: false,
      cost: 0,
      limit: 1,
    });

    const executor = makeExecutor({
      globalTurnCount: 150,
      maxGlobalTurns: null,
      lifetimeTurnCount: 150,
      maxLifetimeTurns: 3000,
      turnBudgetPolicy: "adaptive_unbounded",
      turnlessExecutionV4Enabled: true,
      turnWindowSoftExhaustedNotified: false,
    });

    expect(() => executor.checkBudgets()).not.toThrow();
    expect(executor.emitEvent).not.toHaveBeenCalledWith(
      "turn_window_soft_exhausted",
      expect.anything(),
    );

    vi.restoreAllMocks();
  });

  it("still enforces hard window policy when explicitly configured", () => {
    vi.spyOn(GuardrailManager, "isIterationLimitExceeded").mockReturnValue({
      exceeded: false,
      iterations: 0,
      limit: 50,
    });
    vi.spyOn(GuardrailManager, "isTokenBudgetExceeded").mockReturnValue({
      exceeded: false,
      used: 0,
      limit: 100000,
    });
    vi.spyOn(GuardrailManager, "isCostBudgetExceeded").mockReturnValue({
      exceeded: false,
      cost: 0,
      limit: 1,
    });

    const executor = makeExecutor({
      globalTurnCount: 60,
      maxGlobalTurns: 60,
      lifetimeTurnCount: 100,
      maxLifetimeTurns: 3000,
      turnBudgetPolicy: "hard_window",
      turnlessExecutionV4Enabled: true,
    });

    expect(() => executor.checkBudgets()).toThrow(/Global turn limit exceeded/i);

    vi.restoreAllMocks();
  });

  it("evaluates token budget using cumulative usage across continuation windows", () => {
    const tokenBudgetSpy = vi.spyOn(GuardrailManager, "isTokenBudgetExceeded").mockReturnValue({
      exceeded: true,
      used: 2100,
      limit: 2000,
    });
    vi.spyOn(GuardrailManager, "isIterationLimitExceeded").mockReturnValue({
      exceeded: false,
      iterations: 0,
      limit: 50,
    });
    vi.spyOn(GuardrailManager, "isCostBudgetExceeded").mockReturnValue({
      exceeded: false,
      cost: 0,
      limit: 5,
    });

    const executor = makeExecutor({
      globalTurnCount: 1,
      maxGlobalTurns: 60,
      lifetimeTurnCount: 10,
      maxLifetimeTurns: 320,
      usageOffsetInputTokens: 1500,
      usageOffsetOutputTokens: 500,
      totalInputTokens: 70,
      totalOutputTokens: 30,
      usageOffsetCost: 0.9,
      totalCost: 0.1,
      iterationCount: 1,
    });

    expect(() => executor.checkBudgets()).toThrow(/Token budget exceeded/i);
    expect(tokenBudgetSpy).toHaveBeenCalledWith(2100);

    vi.restoreAllMocks();
  });

  it("manual continuation still works when auto continuation is disabled", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const executor = makeExecutor({
        autoContinueOnTurnLimit: false,
        continuationCount: 0,
        continuationWindow: 1,
        usageOffsetInputTokens: 0,
        usageOffsetOutputTokens: 0,
        usageOffsetCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        globalTurnCount: 60,
        iterationCount: 5,
        taskCompleted: false,
        cancelled: false,
        cancelReason: null,
        waitingForUserInput: false,
        task: {
          id: "task-1",
          agentConfig: {},
        },
        daemon: {
          updateTask: vi.fn(),
          updateTaskStatus: vi.fn(),
          getTaskEvents: vi.fn(() => []),
        },
        appendConversationHistory: vi.fn(),
        executePlan: vi.fn(async () => undefined),
        finalizeTask: vi.fn(),
        buildResultSummary: vi.fn(() => "done"),
        toolRegistry: {
          cleanup: vi.fn(async () => undefined),
        },
        continueAfterBudgetExhaustedUnlocked: (TaskExecutor.prototype as Any)
          .continueAfterBudgetExhaustedUnlocked,
      });

      await executor.continueAfterBudgetExhaustedUnlocked({ mode: "manual" });

      expect(executor.continuationCount).toBe(1);
      expect(executor.continuationWindow).toBe(2);
      expect(executor.executePlan).toHaveBeenCalledTimes(1);
      expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith("task-1", "executing");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
