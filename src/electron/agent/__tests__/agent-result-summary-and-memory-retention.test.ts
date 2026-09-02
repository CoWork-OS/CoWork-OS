import { describe, it, expect } from "vitest";

/**
 * Mirrors TaskExecutor.buildResultSummary selection logic.
 */
function buildResultSummary(
  lastNonVerificationOutput: string | null,
  lastAssistantOutput: string | null,
  lastAssistantText: string | null,
): string | undefined {
  const candidates = [lastNonVerificationOutput, lastAssistantText, lastAssistantOutput];

  const minLength = 20;
  const placeholders = new Set(
    [
      "I understand. Let me continue.",
      "Done.",
      "Task complete.",
      "Task completed.",
      "Task completed successfully.",
      "Complete.",
      "Completed.",
      "All set.",
      "Finished.",
    ].map((value) => value.toLowerCase()),
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (placeholders.has(trimmed.toLowerCase())) continue;
    if (trimmed.length < minLength) continue;
    return trimmed;
  }

  return undefined;
}

/**
 * Mirrors AgentDaemon.captureToMemory retention gating logic.
 */
function shouldRetainMemory(task: {
  parentTaskId?: string;
  agentType?: string;
  agentConfig?: { retainMemory?: boolean };
}): boolean {
  const isSubAgentTask = task.agentType === "sub" || !!task.parentTaskId;
  return task.agentConfig?.retainMemory ?? !isSubAgentTask;
}

describe("Result Summary Selection", () => {
  it("prefers lastNonVerificationOutput", () => {
    const summary = buildResultSummary(
      "final answer that is long enough to be useful",
      "fallback output that is also long enough",
      "assistant text that is long enough",
    );
    expect(summary).toBe("final answer that is long enough to be useful");
  });

  it("falls back to lastAssistantOutput", () => {
    const summary = buildResultSummary(
      null,
      "assistant output that is long enough to be useful",
      null,
    );
    expect(summary).toBe("assistant output that is long enough to be useful");
  });

  it("falls back to lastAssistantText", () => {
    const summary = buildResultSummary(
      null,
      null,
      "assistant text that is long enough to be useful",
    );
    expect(summary).toBe("assistant text that is long enough to be useful");
  });

  it("ignores placeholder-only text", () => {
    const summary = buildResultSummary(
      "I understand. Let me continue.",
      "I understand. Let me continue.",
      null,
    );
    expect(summary).toBeUndefined();
  });

  it("preserves long summaries without a presentation cap", () => {
    const long = "x".repeat(5000);
    const summary = buildResultSummary(long, null, null);
    expect(summary).toBe(long);
  });
});

describe("Memory Retention Gating", () => {
  it("retains memory for main tasks by default", () => {
    expect(shouldRetainMemory({ agentType: "main" })).toBe(true);
  });

  it("does not retain memory for sub-agent tasks by default", () => {
    expect(shouldRetainMemory({ agentType: "sub", parentTaskId: "parent-1" })).toBe(false);
  });

  it("does not retain memory for child tasks when agentType is missing", () => {
    expect(shouldRetainMemory({ parentTaskId: "parent-1" })).toBe(false);
  });

  it("allows explicit retainMemory override for sub-agents", () => {
    expect(
      shouldRetainMemory({
        agentType: "sub",
        parentTaskId: "parent-1",
        agentConfig: { retainMemory: true },
      }),
    ).toBe(true);
  });

  it("respects explicit retainMemory=false for main tasks", () => {
    expect(
      shouldRetainMemory({
        agentType: "main",
        agentConfig: { retainMemory: false },
      }),
    ).toBe(false);
  });
});
