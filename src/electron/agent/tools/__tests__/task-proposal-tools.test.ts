import { describe, expect, it, vi } from "vitest";
import { TASK_PROPOSAL_TOOL_NAMES, TaskProposalTools } from "../task-proposal-tools";
import type { TaskProposalService } from "../../../task-proposals/TaskProposalService";

function makeTools(propose = vi.fn()) {
  const service = { propose, withdraw: vi.fn() } as unknown as TaskProposalService;
  return { tools: new TaskProposalTools(service, "task-1"), propose };
}

describe("TaskProposalTools", () => {
  it("defines propose_task and withdraw_task_proposal with when-to-use descriptions", () => {
    const definitions = TaskProposalTools.getToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual([...TASK_PROPOSAL_TOOL_NAMES]);
    const propose = definitions[0];
    expect(propose.description).toMatch(/outside the user's current request/);
    expect(propose.description).toMatch(/Nothing runs until they choose/);
    expect(propose.input_schema.required).toEqual(["title", "summary", "brief"]);
  });

  it("counts proposals per turn and starts the count afresh on a new turn", async () => {
    const { tools, propose } = makeTools(
      vi.fn(async () => ({ ok: true, proposal: { id: "p-1" } })),
    );

    expect(await tools.proposeTask({ title: "A", summary: "s", brief: "b" })).toMatchObject({
      success: true,
      proposed: true,
      proposal_id: "p-1",
    });
    await tools.proposeTask({ title: "B", summary: "s", brief: "b" });
    expect(propose.mock.calls.map((call) => call[2])).toEqual([
      { proposalsThisTurn: 0 },
      { proposalsThisTurn: 1 },
    ]);

    tools.beginTurn();
    await tools.proposeTask({ title: "C", summary: "s", brief: "b" });
    expect(propose.mock.calls[2][2]).toEqual({ proposalsThisTurn: 0 });
  });

  it("returns a refusal as a note, never as a failed call that would fail the step", async () => {
    const { tools, propose } = makeTools(
      vi.fn(async () => ({ ok: false, error: "title is required." })),
    );

    expect(await tools.proposeTask({})).toEqual({
      success: true,
      proposed: false,
      note: "title is required.",
    });
    await tools.proposeTask({});
    expect(propose.mock.calls[1][2]).toEqual({ proposalsThisTurn: 0 });
  });
});
