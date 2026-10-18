import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { AgentTeamItemStore } from "../../agents/AgentTeamItemRepository";
import type { AgentTeamItem } from "../../../shared/types";

afterEach(() => vi.restoreAllMocks());

function makeDaemon(title: string) {
  const item: AgentTeamItem = {
    id: "item-1",
    teamRunId: "run-1",
    title,
    status: "failed",
    resultSummary: "Synthesis attempt failed and was retried with a compacted prompt.",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const update = vi.spyOn(AgentTeamItemStore.prototype, "update").mockImplementation((params) => ({
    ...item,
    status: params.status ?? item.status,
    sourceTaskId: params.sourceTaskId ?? item.sourceTaskId,
    resultSummary: params.resultSummary ?? item.resultSummary,
  }));
  vi.spyOn(AgentTeamItemStore.prototype, "findById").mockReturnValue(item);
  const fixture = {
    getOrchestrationGraphRepository: () => ({
      findNodeById: async () => ({ teamItemId: "item-1", teamRunId: "run-1", taskId: "task-1" }),
    }),
    dbManager: { getDatabase: () => ({}) },
    emitTeamRunEvent: vi.fn(),
    teamOrchestrator: { tickRun: vi.fn(async () => undefined) },
  };
  const daemon = Object.setPrototypeOf(fixture, AgentDaemon.prototype) as typeof fixture & {
    handleOrchestrationNodeNotification: AgentDaemon["handleOrchestrationNodeNotification"];
  };
  return { daemon, update };
}

describe("orchestration node notifications for synthesis attempts", () => {
  it("leaves a superseded synthesis attempt's status and retry note alone", async () => {
    const { daemon, update } = makeDaemon("Synthesis (failed)");
    await daemon.handleOrchestrationNodeNotification({
      runId: "run-1",
      nodeId: "node-1",
      status: "failed",
      summary: "Failed synthesis attempt",
      result: "full plan text",
      target: "native_child_task",
    });
    expect(update).not.toHaveBeenCalled();
    expect(daemon.teamOrchestrator.tickRun).not.toHaveBeenCalled();
  });

  it("still updates the current synthesis attempt", async () => {
    const { daemon, update } = makeDaemon("Synthesis");
    await daemon.handleOrchestrationNodeNotification({
      runId: "run-1",
      nodeId: "node-1",
      status: "completed",
      summary: "Completed synthesis attempt",
      result: "final plan",
      target: "native_child_task",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-1", status: "done", resultSummary: "final plan" }),
    );
    expect(daemon.teamOrchestrator.tickRun).toHaveBeenCalledWith(
      "run-1",
      "graph_node_notification",
    );
  });
});
