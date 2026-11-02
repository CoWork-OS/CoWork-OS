import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../../shared/types";
import type { TaskProposal } from "../../../../shared/task-proposals";
import {
  collectTurnProposalGroups,
  getTaskProposalFromEvent,
  mergeTaskProposals,
} from "../turn-proposals";

function proposal(id: string, overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    id,
    taskId: "task-1",
    workspaceId: "ws",
    title: `Task ${id}`,
    summary: "Summary",
    brief: "Brief",
    suggestedWorktree: false,
    status: "pending",
    createdAt: 1,
    expiresAt: 10_000,
    ...overrides,
  };
}

let nextId = 0;
function event(type: string, payload: Record<string, unknown> = {}): TaskEvent {
  nextId += 1;
  return { id: `e${nextId}`, taskId: "task-1", type, payload, timestamp: nextId } as TaskEvent;
}

/** How live events arrive: a timeline envelope carrying the legacy type. */
function proposalEvent(type: string, value: TaskProposal): TaskEvent {
  return event("timeline_step_updated", { legacyType: type, proposal: value, status: "completed" });
}

describe("suggested tasks in the transcript", () => {
  it("reads the proposal from a timeline envelope and ignores other events", () => {
    const value = proposal("a");
    expect(getTaskProposalFromEvent(proposalEvent("task_proposal_created", value))).toEqual(value);
    expect(getTaskProposalFromEvent(event("assistant_message", { proposal: value }))).toBeNull();
    expect(
      getTaskProposalFromEvent(event("task_proposal_created", { proposal: { id: "x" } })),
    ).toBeNull();
  });

  it("groups each finished turn's proposals, even a turn that wrote no files", () => {
    const events = [
      event("user_message", { message: "start" }),
      proposalEvent("task_proposal_created", proposal("a")),
      proposalEvent("task_proposal_created", proposal("b")),
      proposalEvent("task_proposal_updated", proposal("a", { status: "dismissed" })),
      event("assistant_message", { message: "done" }),
      event("user_message", { message: "next" }),
      event("assistant_message", { message: "no proposals here" }),
      event("user_message", { message: "third" }),
      proposalEvent("task_proposal_created", proposal("c")),
    ];

    const finished = collectTurnProposalGroups(events, { isTaskWorking: false });
    expect(finished.map((group) => group.proposalIds)).toEqual([["a", "b"], ["c"]]);
    expect(finished[0]).toMatchObject({ key: events[0].id, startIndex: 0, endIndex: 4 });

    // The running turn has no card yet, so it never jumps while the agent works.
    const working = collectTurnProposalGroups(events, { isTaskWorking: true });
    expect(working.map((group) => group.proposalIds)).toEqual([["a", "b"]]);
  });

  it("never undoes a decision with an older pending copy", () => {
    const known = new Map([["a", proposal("a", { status: "started", decidedAt: 5 })]]);

    expect(mergeTaskProposals(known, [proposal("a")]).get("a")?.status).toBe("started");
    expect(
      mergeTaskProposals(known, [proposal("a", { status: "dismissed", decidedAt: 3 })]).get("a")
        ?.status,
    ).toBe("started");
    expect(
      mergeTaskProposals(new Map([["a", proposal("a")]]), [
        proposal("a", { status: "started", startedTaskId: "t", decidedAt: 2 }),
      ]).get("a"),
    ).toMatchObject({ status: "started", startedTaskId: "t" });
  });
});
