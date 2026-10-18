import { describe, expect, it } from "vitest";

import type { SessionProgressState } from "../../../shared/types";
import { canOfferSessionRecovery, sessionRecoveryDetail } from "../SessionProgressCard";

const EXPLANATION =
  "Approve this shell command and its potential network access for this invocation.";

function progress(overrides: Partial<SessionProgressState> = {}): SessionProgressState {
  return {
    schemaVersion: 1,
    taskId: "t1",
    status: "paused",
    phase: "waiting",
    headline: EXPLANATION,
    completedSteps: 2,
    totalSteps: 3,
    activeAgentCount: 0,
    pendingApprovals: [],
    pendingInputRequests: [],
    resumeFromEventId: "evt-1",
    connectionState: "connected",
    updatedAt: 1,
    ...overrides,
  };
}

describe("SessionProgressCard", () => {
  it("offers no recovery for a routine approval or question", () => {
    // The task pauses while the inline card waits; that is not a crashed session.
    for (const status of ["paused", "blocked"] as const) {
      expect(
        canOfferSessionRecovery(
          progress({
            status,
            waiting: { kind: "approval", reason: EXPLANATION, requestId: "a1" },
          }),
        ),
      ).toBe(false);
      expect(
        canOfferSessionRecovery(
          progress({
            status,
            waiting: { kind: "input", reason: "Which months?", requestId: "r1" },
          }),
        ),
      ).toBe(false);
    }
  });

  it("still offers recovery for an interrupted, paused or blocked session", () => {
    expect(
      canOfferSessionRecovery(
        progress({
          status: "interrupted",
          waiting: { kind: "reconnect", reason: "The session needs to reconnect." },
        }),
      ),
    ).toBe(true);
    expect(
      canOfferSessionRecovery(
        progress({ waiting: { kind: "paused", reason: "The session is paused." } }),
      ),
    ).toBe(true);
    expect(canOfferSessionRecovery(progress({ status: "blocked" }))).toBe(true);
    expect(canOfferSessionRecovery(progress({ status: "executing" }))).toBe(false);
    expect(canOfferSessionRecovery(undefined)).toBe(false);
  });

  it("does not repeat the headline as the waiting line", () => {
    const reason = "The session is blocked and needs your attention.";
    expect(
      sessionRecoveryDetail(
        progress({ status: "blocked", headline: reason, waiting: { kind: "blocked", reason } }),
      ),
    ).toBeUndefined();
    expect(
      sessionRecoveryDetail(
        progress({
          status: "blocked",
          headline: "Read the invoices",
          waiting: { kind: "blocked", reason },
        }),
      ),
    ).toBe(reason);
    expect(sessionRecoveryDetail(progress())).toBeUndefined();
  });
});
