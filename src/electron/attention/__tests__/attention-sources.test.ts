import { describe, expect, it, vi } from "vitest";
import type {
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
} from "../../../shared/routine-workflow";
import type { ProactiveSuggestion, Workspace } from "../../../shared/types";
import type { MemoryCurationChange } from "../../../shared/memory-review-types";
import {
  MEMORY_CHANGE_WINDOW_MS,
  listMemoryChangesAcross,
  listSuggestionsAcross,
  listWaitingFlowSteps,
} from "../attention-sources";

function run(id: string, status: string, routineId = "r1"): RoutineWorkflowRunRecord {
  return {
    id,
    routineId,
    workflowVersionId: "v1",
    status,
    triggerNodeId: "trigger",
    context: {},
    createdAt: 1,
    updatedAt: 2,
  } as RoutineWorkflowRunRecord;
}

function step(
  id: string,
  runId: string,
  status: string,
  error?: string,
): RoutineWorkflowStepRecord {
  return {
    id,
    runId,
    routineId: "r1",
    nodeId: id,
    operation: "send_email",
    status,
    attemptCount: 0,
    createdAt: 1,
    updatedAt: 5,
    ...(error ? { error } : {}),
  } as RoutineWorkflowStepRecord;
}

describe("listWaitingFlowSteps", () => {
  it("returns nothing without the routine service", async () => {
    expect(await listWaitingFlowSteps(null)).toEqual([]);
  });

  it("lists each step waiting for approval in runs that wait", async () => {
    const listWorkflowRunSteps = vi.fn(async (runId: string) =>
      runId === "run1"
        ? [
            step("s1", "run1", "waiting_for_approval", "Send to leadership"),
            step("s2", "run1", "completed"),
          ]
        : [],
    );
    const get = vi.fn(async () => ({ name: "Weekly report" }));
    const waiting = await listWaitingFlowSteps({
      listWorkflowRuns: () => [run("run1", "waiting_for_approval"), run("run2", "completed")],
      listWorkflowRunSteps,
      get,
    });
    expect(waiting).toEqual([
      {
        routineId: "r1",
        routineName: "Weekly report",
        runId: "run1",
        stepId: "s1",
        message: "Send to leadership",
        waitingSince: 5,
      },
    ]);
    expect(listWorkflowRunSteps).toHaveBeenCalledTimes(1);
  });
});

describe("listSuggestionsAcross", () => {
  it("reads saved workspaces only, in one call", async () => {
    const listActive = vi.fn(async () => [
      { id: "s1", workspaceId: "b" } as ProactiveSuggestion,
      { id: "s2" } as ProactiveSuggestion,
    ]);
    const result = await listSuggestionsAcross(
      [
        { id: "a" } as Workspace,
        { id: "tmp", isTemp: true } as Workspace,
        { id: "__temp_workspace__x" } as Workspace,
        { id: "b" } as Workspace,
      ],
      listActive,
    );
    // A queue read is not a showing: no "surfaced" (and later "ignored") telemetry.
    expect(listActive).toHaveBeenCalledWith("a", { recordSurface: false }, ["a", "b"]);
    expect(result.map((entry) => [entry.suggestion.id, entry.workspaceId])).toEqual([
      ["s1", "b"],
      ["s2", "a"],
    ]);
  });

  it("skips the read when there are no saved workspaces", async () => {
    const listActive = vi.fn();
    expect(
      await listSuggestionsAcross([{ id: "t", isTemp: true } as Workspace], listActive),
    ).toEqual([]);
    expect(listActive).not.toHaveBeenCalled();
  });
});

describe("listMemoryChangesAcross", () => {
  const change = (id: string, appliedAt: number) => ({ id, appliedAt }) as MemoryCurationChange;
  const NOW = 10 * MEMORY_CHANGE_WINDOW_MS;

  it("reads recent expiries in each saved workspace, newest first", async () => {
    const recentSince = vi.fn(async (workspaceId: string) =>
      workspaceId === "a" ? [change("c1", NOW - 10)] : [change("c2", NOW - 5)],
    );
    const result = await listMemoryChangesAcross(
      [
        { id: "a" } as Workspace,
        { id: "tmp", isTemp: true } as Workspace,
        { id: "b" } as Workspace,
      ],
      recentSince,
      NOW,
    );
    expect(recentSince.mock.calls).toEqual([
      ["a", NOW - MEMORY_CHANGE_WINDOW_MS],
      ["b", NOW - MEMORY_CHANGE_WINDOW_MS],
    ]);
    expect(result.map((entry) => [entry.change.id, entry.workspaceId])).toEqual([
      ["c2", "b"],
      ["c1", "a"],
    ]);
  });

  it("skips a workspace it cannot read, and fails only when it can read none", async () => {
    const partly = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "a") throw new Error("locked");
      return [change("c2", NOW)];
    });
    expect(
      (await listMemoryChangesAcross([{ id: "a" }, { id: "b" }] as Workspace[], partly, NOW)).map(
        (entry) => entry.change.id,
      ),
    ).toEqual(["c2"]);
    const never = vi.fn(async () => {
      throw new Error("engine not running");
    });
    await expect(listMemoryChangesAcross([{ id: "a" }] as Workspace[], never, NOW)).rejects.toThrow(
      "engine not running",
    );
    expect(await listMemoryChangesAcross([], never, NOW)).toEqual([]);
  });
});
