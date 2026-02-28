import { describe, expect, it } from "vitest";

import { deriveReviewGateDecision, scoreTaskRisk } from "../risk";
import type { TaskEvent } from "../../../shared/types";

function toolCallEvent(tool: string, input: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${tool}-${Math.random()}`,
    taskId: "task-1",
    timestamp: Date.now(),
    type: "tool_call",
    payload: {
      tool,
      input,
    },
  } as TaskEvent;
}

function toolErrorEvent(tool: string): TaskEvent {
  return {
    id: `${tool}-error-${Math.random()}`,
    taskId: "task-1",
    timestamp: Date.now(),
    type: "tool_error",
    payload: {
      tool,
      error: "boom",
    },
  } as TaskEvent;
}

function fileEvent(type: "file_created" | "file_modified" | "file_deleted", path: string): TaskEvent {
  return {
    id: `${type}-${path}`,
    taskId: "task-1",
    timestamp: Date.now(),
    type,
    payload: {
      path,
    },
  } as TaskEvent;
}

describe("scoreTaskRisk", () => {
  it("returns low risk when no risk signals are present", () => {
    const result = scoreTaskRisk(
      {
        title: "Document summary",
        prompt: "Summarize this document",
      },
      [],
    );

    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
  });

  it("returns medium risk at score 3", () => {
    const events: TaskEvent[] = [
      toolCallEvent("run_command", { command: "git commit -m \"test\"" }),
      toolErrorEvent("web_fetch"),
      toolErrorEvent("web_fetch"),
      toolErrorEvent("web_fetch"),
    ];

    const result = scoreTaskRisk(
      {
        title: "Apply patch",
        prompt: "Fix bug and commit changes",
      },
      events,
    );

    expect(result.score).toBe(3);
    expect(result.level).toBe("medium");
    expect(result.reasons).toContain("shell_or_git_mutation");
    expect(result.reasons).toContain("repeated_tool_failures");
  });

  it("returns high risk when cumulative score reaches 6+", () => {
    const events: TaskEvent[] = [
      toolCallEvent("run_command", { command: "npm install" }),
      fileEvent("file_modified", "a.ts"),
      fileEvent("file_modified", "b.ts"),
      fileEvent("file_modified", "c.ts"),
      fileEvent("file_modified", "d.ts"),
      fileEvent("file_modified", "e.ts"),
      fileEvent("file_modified", "f.ts"),
      toolErrorEvent("run_command"),
      toolErrorEvent("run_command"),
      toolErrorEvent("run_command"),
    ];

    const result = scoreTaskRisk(
      {
        title: "Implement feature",
        prompt: "Implement feature and run tests before finishing",
      },
      events,
    );

    expect(result.score).toBe(7);
    expect(result.level).toBe("high");
    expect(result.reasons).toContain("tests_expected_without_evidence");
    expect(result.reasons).toContain("more_than_five_files_changed");
  });
});

describe("deriveReviewGateDecision", () => {
  it("keeps review off when policy is off", () => {
    const decision = deriveReviewGateDecision({
      policy: "off",
      riskLevel: "high",
      isMutatingTask: true,
    });

    expect(decision.runQualityPass).toBe(false);
    expect(decision.strictCompletionContract).toBe(false);
    expect(decision.runVerificationAgent).toBe(false);
  });

  it("applies balanced policy escalation by risk", () => {
    const low = deriveReviewGateDecision({
      policy: "balanced",
      riskLevel: "low",
      isMutatingTask: true,
    });
    const medium = deriveReviewGateDecision({
      policy: "balanced",
      riskLevel: "medium",
      isMutatingTask: true,
    });
    const high = deriveReviewGateDecision({
      policy: "balanced",
      riskLevel: "high",
      isMutatingTask: true,
    });

    expect(low.runQualityPass).toBe(true);
    expect(low.strictCompletionContract).toBe(false);
    expect(low.runVerificationAgent).toBe(false);

    expect(medium.strictCompletionContract).toBe(true);
    expect(medium.runVerificationAgent).toBe(false);

    expect(high.strictCompletionContract).toBe(true);
    expect(high.runVerificationAgent).toBe(true);
    expect(high.explicitEvidenceRequired).toBe(true);
  });

  it("applies strict policy for medium/high risk regardless of mutation", () => {
    const decision = deriveReviewGateDecision({
      policy: "strict",
      riskLevel: "medium",
      isMutatingTask: false,
    });

    expect(decision.runQualityPass).toBe(true);
    expect(decision.strictCompletionContract).toBe(true);
    expect(decision.runVerificationAgent).toBe(true);
    expect(decision.explicitEvidenceRequired).toBe(true);
  });
});
