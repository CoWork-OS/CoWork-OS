import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../llm";
import {
  computeToolFailureDecision,
  handleMaxTokensRecovery,
  maybeInjectLowProgressNudge,
  maybeInjectStopReasonNudge,
  recordPackagingFailureFingerprint,
  shouldRetryEmptyFollowUpEndTurn,
  shouldAllowBotMessagingDuringFollowUpToolLock,
  shouldForceStopAfterSkippedToolOnlyTurns,
  shouldLockFollowUpToolCalls,
  type ToolLoopCall,
  updateSkippedToolOnlyTurnStreak,
} from "../executor-loop-utils";

describe("executor-loop-utils guardrails", () => {
  it("skips max_tokens retry when turn budget is nearly exhausted", () => {
    const messages: LLMMessage[] = [];
    const result = handleMaxTokensRecovery({
      response: {
        stopReason: "max_tokens",
        content: [{ type: "text", text: "partial output" }],
      },
      messages,
      recoveryCount: 0,
      maxRecoveries: 3,
      remainingTurns: 1,
      minTurnsRequiredForRetry: 1,
      log: vi.fn(),
      emitMaxTokensRecovery: vi.fn(),
    });

    expect(result.action).toBe("exhausted");
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("retries max_tokens when enough turn budget remains", () => {
    const messages: LLMMessage[] = [];
    const result = handleMaxTokensRecovery({
      response: {
        stopReason: "max_tokens",
        content: [{ type: "text", text: "partial output" }],
      },
      messages,
      recoveryCount: 0,
      maxRecoveries: 3,
      remainingTurns: 3,
      minTurnsRequiredForRetry: 1,
      log: vi.fn(),
      emitMaxTokensRecovery: vi.fn(),
    });

    expect(result.action).toBe("retry");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[1].role).toBe("user");
  });

  it("treats unavailable tools with explicit alternatives as recoverable", () => {
    const decision = computeToolFailureDecision({
      toolResults: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: JSON.stringify({
            error: 'Tool "create_document" is not available.',
            unavailable: true,
            alternatives: ["write_file"],
          }),
          is_error: true,
        },
      ] as Any,
      hasDisabledToolAttempt: false,
      hasDuplicateToolAttempt: false,
      hasUnavailableToolAttempt: true,
      hasHardToolFailureAttempt: false,
      toolRecoveryHintInjected: false,
      iterationCount: 1,
      maxIterations: 6,
      allowRecoveryHint: true,
    });

    expect(decision.shouldStopFromFailures).toBe(false);
    expect(decision.shouldStopFromHardFailure).toBe(false);
    expect(decision.shouldInjectRecoveryHint).toBe(true);
  });

  it("skips continuation retries when adaptive output handling disallows it", () => {
    const messages: LLMMessage[] = [];
    const result = handleMaxTokensRecovery({
      response: {
        stopReason: "max_tokens",
        content: [{ type: "text", text: "partial output" }],
      },
      messages,
      recoveryCount: 0,
      maxRecoveries: 3,
      remainingTurns: 3,
      minTurnsRequiredForRetry: 1,
      allowRetry: false,
      log: vi.fn(),
      emitMaxTokensRecovery: vi.fn(),
    });

    expect(result.action).toBe("exhausted");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("injects low-progress nudge for repeated mixed-tool probing on same target", () => {
    const calls: ToolLoopCall[] = [
      { tool: "read", target: "/tmp/a.html:1-200", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:200-400", baseTarget: "/tmp/a.html" },
      { tool: "browser_navigate", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:400-600", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:600-800", baseTarget: "/tmp/a.html" },
    ];
    const messages: LLMMessage[] = [];

    const injected = maybeInjectLowProgressNudge({
      recentToolCalls: calls,
      messages,
      lowProgressNudgeInjected: false,
      phaseLabel: "step",
      log: vi.fn(),
    });

    expect(injected).toBe(true);
    expect(messages.length).toBe(1);
    const text = String((messages[0].content as Any[])[0]?.text || "");
    expect(text).toContain("repeatedly probing the same target");
  });

  it("does not inject low-progress nudge for diverse targets", () => {
    const calls: ToolLoopCall[] = [
      { tool: "read", target: "/tmp/a.html:1-200", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/b.html", baseTarget: "/tmp/b.html" },
      { tool: "read", target: "/tmp/c.html:1-200", baseTarget: "/tmp/c.html" },
      { tool: "search", target: "/tmp/d.html", baseTarget: "/tmp/d.html" },
      { tool: "read", target: "/tmp/e.html:1-200", baseTarget: "/tmp/e.html" },
      { tool: "search", target: "/tmp/f.html", baseTarget: "/tmp/f.html" },
      { tool: "read", target: "/tmp/g.html:1-200", baseTarget: "/tmp/g.html" },
      { tool: "search", target: "/tmp/h.html", baseTarget: "/tmp/h.html" },
    ];
    const messages: LLMMessage[] = [];

    const injected = maybeInjectLowProgressNudge({
      recentToolCalls: calls,
      messages,
      lowProgressNudgeInjected: false,
      phaseLabel: "step",
      log: vi.fn(),
    });

    expect(injected).toBe(false);
    expect(messages.length).toBe(0);
  });

  it("injects an escalation nudge when low-progress looping continues after the first nudge", () => {
    const calls: ToolLoopCall[] = [
      { tool: "read", target: "/tmp/a.html:1-200", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:200-400", baseTarget: "/tmp/a.html" },
      { tool: "browser_navigate", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:400-600", baseTarget: "/tmp/a.html" },
      { tool: "search", target: "/tmp/a.html", baseTarget: "/tmp/a.html" },
      { tool: "read", target: "/tmp/a.html:600-800", baseTarget: "/tmp/a.html" },
    ];
    const messages: LLMMessage[] = [];

    const injected = maybeInjectLowProgressNudge({
      recentToolCalls: calls,
      messages,
      lowProgressNudgeInjected: true,
      phaseLabel: "step",
      log: vi.fn(),
    });

    expect(injected).toBe(true);
    expect(messages.length).toBe(1);
    const text = String((messages[0].content as Any[])[0]?.text || "");
    expect(text).toContain("[LOW_PROGRESS_ESCALATION]");
  });

  it("injects stop-reason nudge on repeated tool_use stops", () => {
    const messages: LLMMessage[] = [];
    const injected = maybeInjectStopReasonNudge({
      stopReason: "tool_use",
      consecutiveToolUseStops: 6,
      consecutiveMaxTokenStops: 0,
      remainingTurns: 4,
      messages,
      phaseLabel: "follow-up",
      stopReasonNudgeInjected: false,
      log: vi.fn(),
    });

    expect(injected).toBe(true);
    expect(messages.length).toBe(1);
    expect(String((messages[0].content as Any[])[0]?.text || "")).toContain("repeated tool-use");
  });

  it("injects required-write nudge instead of stop-tools when suppressed", () => {
    const messages: LLMMessage[] = [];
    const injected = maybeInjectStopReasonNudge({
      stopReason: "tool_use",
      consecutiveToolUseStops: 6,
      consecutiveMaxTokenStops: 0,
      remainingTurns: 4,
      messages,
      phaseLabel: "step",
      stopReasonNudgeInjected: false,
      suppressToolUseStopNudge: true,
      requiredToolNames: ["create_document"],
      log: vi.fn(),
    });

    expect(injected).toBe(true);
    expect(messages.length).toBe(1);
    expect(String((messages[0].content as Any[])[0]?.text || "")).toContain(
      "requires an artifact mutation",
    );
    expect(String((messages[0].content as Any[])[0]?.text || "")).toContain("create_document");
  });

  it("locks follow-up tool calls after persistent tool_use streak", () => {
    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 10,
      followUpToolCallCount: 12,
      stopReasonNudgeInjected: true,
    });
    expect(shouldLock).toBe(true);
  });

  it("only preserves authorized bot messaging during follow-up tool locking", () => {
    expect(
      shouldAllowBotMessagingDuringFollowUpToolLock({
        toolName: "send_agent_message",
        botConversation: true,
        botMessagingAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldAllowBotMessagingDuringFollowUpToolLock({
        toolName: "web_search",
        botConversation: true,
        botMessagingAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldAllowBotMessagingDuringFollowUpToolLock({
        toolName: "send_agent_message",
        botConversation: true,
        botMessagingAuthorized: false,
      }),
    ).toBe(false);
  });

  it("does not lock follow-up tool calls before nudge/streak threshold", () => {
    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 7,
      followUpToolCallCount: 12,
      stopReasonNudgeInjected: false,
    });
    expect(shouldLock).toBe(false);
  });

  it("locks follow-up tool calls immediately when remaining turn budget is critically low", () => {
    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 1,
      followUpToolCallCount: 1,
      stopReasonNudgeInjected: false,
      remainingTurns: 2,
      immediateTurnBudgetThreshold: 2,
    });
    expect(shouldLock).toBe(true);
  });

  it("does not lock on low remaining turn budget when immediate budget locking is disabled", () => {
    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 1,
      followUpToolCallCount: 1,
      stopReasonNudgeInjected: false,
      remainingTurns: 2,
      immediateTurnBudgetThreshold: 2,
      allowImmediateTurnBudgetLock: false,
    });
    expect(shouldLock).toBe(false);
  });

  it("locks follow-up tool calls after repeated identical packaging failures", () => {
    const counts = new Map<string, number>();
    const first = recordPackagingFailureFingerprint({
      toolName: "run_command",
      input: { command: "python3 make_pdf.py --output book.pdf" },
      error: "Command exited with code 1",
      counts,
    });
    const second = recordPackagingFailureFingerprint({
      toolName: "run_command",
      input: { command: "python3 make_pdf.py --output book.pdf" },
      error: "Command exited with code 1",
      counts,
    });

    expect(first.isPackagingFailure).toBe(true);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.thresholdReached).toBe(true);

    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 1,
      followUpToolCallCount: 2,
      stopReasonNudgeInjected: false,
      repeatedPackagingFailureCount: second.count,
    });
    expect(shouldLock).toBe(true);
  });

  it("ignores non-packaging failures for early follow-up locking", () => {
    const counts = new Map<string, number>();
    const result = recordPackagingFailureFingerprint({
      toolName: "read_file",
      input: { path: "notes.txt" },
      error: "ENOENT",
      counts,
    });

    expect(result.isPackagingFailure).toBe(false);
    expect(result.count).toBe(0);
    expect(counts.size).toBe(0);
  });

  it("tracks skipped-tool-only streak and forces stop after threshold", () => {
    let streak = updateSkippedToolOnlyTurnStreak({
      skippedToolCalls: 2,
      hasTextInThisResponse: false,
      previousStreak: 0,
    });
    expect(streak).toBe(1);
    expect(shouldForceStopAfterSkippedToolOnlyTurns(streak, 2)).toBe(false);

    streak = updateSkippedToolOnlyTurnStreak({
      skippedToolCalls: 1,
      hasTextInThisResponse: false,
      previousStreak: streak,
    });
    expect(streak).toBe(2);
    expect(shouldForceStopAfterSkippedToolOnlyTurns(streak, 2)).toBe(true);

    streak = updateSkippedToolOnlyTurnStreak({
      skippedToolCalls: 1,
      hasTextInThisResponse: true,
      previousStreak: streak,
    });
    expect(streak).toBe(0);
  });

  it("does not hard-stop on duplicate-only tool failures and injects one recovery hint", () => {
    const decision = computeToolFailureDecision({
      toolResults: [{ type: "tool_result", tool_use_id: "x", content: "{}", is_error: true }],
      hasDisabledToolAttempt: false,
      hasDuplicateToolAttempt: true,
      hasUnavailableToolAttempt: false,
      hasHardToolFailureAttempt: false,
      toolRecoveryHintInjected: false,
      iterationCount: 1,
      maxIterations: 10,
      allowRecoveryHint: true,
    });

    expect(decision.allToolsFailed).toBe(true);
    expect(decision.shouldStopFromFailures).toBe(false);
    expect(decision.shouldInjectRecoveryHint).toBe(true);
  });

  it("retries empty follow-up end_turn responses instead of silently finalizing", () => {
    expect(
      shouldRetryEmptyFollowUpEndTurn({
        wantsToEnd: true,
        hasTextInThisResponse: false,
        hasProvidedTextResponse: false,
        hadToolCalls: false,
      }),
    ).toBe(true);

    expect(
      shouldRetryEmptyFollowUpEndTurn({
        wantsToEnd: true,
        hasTextInThisResponse: true,
        hasProvidedTextResponse: true,
        hadToolCalls: false,
      }),
    ).toBe(false);
  });
});
