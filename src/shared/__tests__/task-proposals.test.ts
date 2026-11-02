import { describe, expect, it } from "vitest";
import { effectiveTaskProposalStatus, normalizeTaskProposalTitle } from "../task-proposals";
import { getTaskEventStatus } from "../task-event-status-map";

describe("task proposals", () => {
  it("reads a pending proposal past its expiry as expired", () => {
    expect(effectiveTaskProposalStatus({ status: "pending", expiresAt: 10 }, 9)).toBe("pending");
    expect(effectiveTaskProposalStatus({ status: "pending", expiresAt: 10 }, 10)).toBe("expired");
    expect(effectiveTaskProposalStatus({ status: "started", expiresAt: 10 }, 99)).toBe("started");
  });

  it("compares titles without case, punctuation or spacing", () => {
    expect(normalizeTaskProposalTitle("  Lazy-load LLM SDK clients!")).toBe(
      normalizeTaskProposalTitle("lazy load llm sdk   clients"),
    );
  });

  it("never changes the proposing task's status", () => {
    for (const legacyType of ["task_proposal_created", "task_proposal_updated"]) {
      expect(getTaskEventStatus("timeline_step_updated", { legacyType })).toBeUndefined();
      expect(getTaskEventStatus(legacyType, {})).toBeUndefined();
    }
    expect(getTaskEventStatus("timeline_step_updated", { legacyType: "progress_update" })).toBe(
      "executing",
    );
  });
});
