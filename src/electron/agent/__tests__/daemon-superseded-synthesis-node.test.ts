import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { AgentTeamItemStore } from "../../agents/AgentTeamItemRepository";

type Any = Record<string, any>;

afterEach(() => vi.restoreAllMocks());

function makeDaemon(title: string) {
  const update = vi
    .spyOn(AgentTeamItemStore.prototype, "update")
    .mockImplementation((params: Any) => ({ id: params.id, title, ...params }) as Any);
  vi.spyOn(AgentTeamItemStore.prototype, "findById").mockReturnValue({
    id: "item-1",
    teamRunId: "run-1",
    title,
    status: "failed",
    resultSummary: "Synthesis attempt failed and was retried with a compacted prompt.",
  } as Any);
  const daemon: Any = Object.create(AgentDaemon.prototype);
  daemon.getOrchestrationGraphRepository = () => ({
    findNodeById: async () => ({ teamItemId: "item-1", teamRunId: "run-1", taskId: "task-1" }),
  });
  daemon.dbManager = { getDatabase: () => ({}) };
  daemon.emitTeamRunEvent = vi.fn();
  daemon.teamOrchestrator = { tickRun: vi.fn(async () => undefined) };
  return { daemon, update };
}

describe("orchestration node notifications for synthesis attempts", () => {
  it("leaves a superseded synthesis attempt's status and retry note alone", async () => {
    const { daemon, update } = makeDaemon("Synthesis (failed)");
    await daemon.handleOrchestrationNodeNotification({
      nodeId: "node-1",
      status: "failed",
      result: "full plan text",
    });
    expect(update).not.toHaveBeenCalled();
    expect(daemon.teamOrchestrator.tickRun).not.toHaveBeenCalled();
  });

  it("still updates the current synthesis attempt", async () => {
    const { daemon, update } = makeDaemon("Synthesis");
    await daemon.handleOrchestrationNodeNotification({
      nodeId: "node-1",
      status: "completed",
      result: "final plan",
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
