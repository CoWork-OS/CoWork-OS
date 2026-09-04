import { describe, expect, it } from "vitest";
import type { WorkSessionItem } from "../../../shared/types";
import {
  createDeterministicWorkSessionReplayFixtures,
  evaluateDeterministicReplayFixtures,
  evaluateIsolatedReplay,
} from "../WorkSessionReplayEvaluationService";
import { WorkSessionRolloutService } from "../WorkSessionRolloutService";
import Database from "better-sqlite3";

describe("WorkSession Phase 5 replay and rollout", () => {
  it("evaluates deterministic crash, compaction, approval, credential, revocation, and child fixtures in isolation", () => {
    const fixtures = createDeterministicWorkSessionReplayFixtures();
    const results = evaluateDeterministicReplayFixtures();
    expect(results).toHaveLength(fixtures.length);
    expect(
      results.every((result) => result.isolated && result.projectionsMatch && result.passed),
    ).toBe(true);
    expect(results.map((result) => result.findings)).toEqual(fixtures.map(() => []));
  });

  it("flags false success, credential leakage, duplicate side effects, and policy bypass", () => {
    const item = (
      sequence: number,
      kind: WorkSessionItem["kind"],
      eventType: string,
      payload: Record<string, unknown> = {},
    ): WorkSessionItem => ({
      id: `risk-${sequence}`,
      sessionId: "risk-session",
      turnId: "risk-turn",
      sequence,
      kind,
      actor: "agent",
      payload: { eventType, payload },
      redactionClass: "standard",
      createdAt: sequence,
    });
    const result = evaluateIsolatedReplay([
      item(1, "approval", "approval_requested", { requestId: "a1" }),
      item(2, "tool_call", "side_effect", {
        sideEffect: true,
        sideEffectKey: "write:1",
        authorization: "sk-live-secret-123456",
      }),
      item(3, "tool_call", "side_effect", { sideEffect: true, sideEffectKey: "write:1" }),
      item(4, "status", "task_completed"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        "credential_leak",
        "duplicate_side_effect:write:1",
        "authorization_bypass:write:1",
        "false_success:pending_wait",
      ]),
    );
  });

  it("represents user-action blockers as waiting and grades their assertion", () => {
    const result = evaluateIsolatedReplay(
      [
        {
          id: "waiting-blocker",
          sessionId: "waiting-session",
          turnId: "waiting-turn",
          sequence: 1,
          kind: "error",
          actor: "agent",
          payload: {
            eventType: "safety_stop_triggered",
            payload: { reason: "The safety budget was exhausted" },
          },
          redactionClass: "standard",
          createdAt: 1,
        },
      ],
      {
        fixtureId: "waiting-blocker",
        assertions: { expectedTerminalStatus: "needs_user_action" },
      },
    );

    expect(result.replayStatus).toBe("waiting");
    expect(result.pendingWaitCount).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("does not mistake policy authorization markers for credentials", () => {
    const result = evaluateIsolatedReplay([
      {
        id: "safe-policy-1",
        sessionId: "safe-policy",
        turnId: "safe-policy-turn",
        sequence: 1,
        kind: "tool_call",
        actor: "agent",
        payload: {
          eventType: "side_effect",
          payload: { sideEffect: true, sideEffectKey: "write:1", authorization: "allow" },
        },
        redactionClass: "standard",
        createdAt: 1,
      },
    ]);
    expect(result.findings).not.toContain("credential_leak");
  });

  it("correlates nested approval request objects with direct grants", () => {
    const item = (
      sequence: number,
      kind: WorkSessionItem["kind"],
      eventType: string,
      payload: Record<string, unknown> = {},
    ): WorkSessionItem => ({
      id: `nested-approval-${sequence}`,
      sessionId: "nested-approval-session",
      turnId: "nested-approval-turn",
      sequence,
      kind,
      actor: "agent",
      payload: { eventType, payload },
      redactionClass: "standard",
      createdAt: sequence,
    });
    const result = evaluateIsolatedReplay([
      item(1, "approval", "approval_requested", { approval: { id: "approval-nested" } }),
      item(2, "approval", "approval_granted", { approvalId: "approval-nested" }),
      item(3, "tool_call", "side_effect", {
        requestId: "approval-nested",
        sideEffect: true,
        sideEffectKey: "write:nested",
      }),
      item(4, "status", "task_completed"),
    ]);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("recognizes orchestration and pipeline terminal events", () => {
    const make = (type: string): WorkSessionItem => ({
      id: `terminal-${type}`,
      sessionId: "terminal-session",
      turnId: "terminal-turn",
      sequence: 1,
      kind: "status",
      actor: "agent",
      payload: { eventType: type, payload: {} },
      redactionClass: "standard",
      createdAt: 1,
    });
    expect(evaluateIsolatedReplay([make("orchestration_run_completed")]).replayStatus).toBe(
      "completed",
    );
    expect(evaluateIsolatedReplay([make("pipeline_failed")]).replayStatus).toBe("failed");
    expect(evaluateIsolatedReplay([make("turn.completed")]).replayStatus).toBe("completed");
  });

  it("assigns stable cohorts and immediately falls back to legacy reads", () => {
    const db = new Database(":memory:");
    const rollout = new WorkSessionRolloutService(db, () => 123);
    rollout.updateConfig({ enabled: true, cohortPercent: 100, salt: "test-salt" });
    const target = { workspaceId: "workspace-1", sessionId: "session-1" };
    expect(rollout.readMode(target)).toBe("vnext");
    expect(rollout.cohortBucket(target)).toBe(rollout.cohortBucket(target));
    rollout.setLegacyReadRollback(true);
    expect(rollout.readMode(target)).toBe("legacy");
    expect(
      rollout.choose(
        target,
        () => "canonical",
        () => "legacy",
      ),
    ).toBe("legacy");
    db.close();
  });
});
