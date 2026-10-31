import { describe, expect, it } from "vitest";
import {
  TaskProposalActionSchema,
  TaskProposalStartAllSchema,
  TaskProposalStartSchema,
} from "../validation";

const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const TASK_ID = "55555555-5555-4555-8555-555555555555";

describe("suggested task IPC validation", () => {
  it("accepts a start with the Options the card sends", () => {
    expect(
      TaskProposalStartSchema.parse({
        proposalId: PROPOSAL_ID,
        options: {
          worktreeMode: "worktree",
          providerType: "anthropic",
          modelKey: "opus-4-5",
          reasoningEffort: "high",
          accessProfileId: "ask-for-approval",
        },
      }),
    ).toMatchObject({ proposalId: PROPOSAL_ID, options: { worktreeMode: "worktree" } });
  });

  it("rejects fields the card never sends, such as a brief or prompt provenance", () => {
    expect(() =>
      TaskProposalStartSchema.parse({ proposalId: PROPOSAL_ID, brief: "do something else" }),
    ).toThrow();
    expect(() =>
      TaskProposalStartSchema.parse({
        proposalId: PROPOSAL_ID,
        options: { promptProvenance: "user_typed" },
      }),
    ).toThrow();
    expect(() => TaskProposalActionSchema.parse({ proposalId: "not-a-uuid" })).toThrow();
  });

  it("bounds Start all to the proposals one task can have waiting", () => {
    expect(() => TaskProposalStartAllSchema.parse({ taskId: TASK_ID, proposalIds: [] })).toThrow();
    expect(() =>
      TaskProposalStartAllSchema.parse({
        taskId: TASK_ID,
        proposalIds: Array.from({ length: 11 }, () => PROPOSAL_ID),
      }),
    ).toThrow();
  });
});
