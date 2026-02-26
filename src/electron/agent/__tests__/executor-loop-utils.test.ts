import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../llm";
import {
  handleMaxTokensRecovery,
  maybeInjectLowProgressNudge,
  maybeInjectStopReasonNudge,
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
    const text = String((messages[0].content as any[])[0]?.text || "");
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
    const text = String((messages[0].content as any[])[0]?.text || "");
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
    expect(String((messages[0].content as any[])[0]?.text || "")).toContain("repeated tool-use");
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

  it("does not lock follow-up tool calls before nudge/streak threshold", () => {
    const shouldLock = shouldLockFollowUpToolCalls({
      stopReason: "tool_use",
      consecutiveToolUseStops: 7,
      followUpToolCallCount: 12,
      stopReasonNudgeInjected: false,
    });
    expect(shouldLock).toBe(false);
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
});
