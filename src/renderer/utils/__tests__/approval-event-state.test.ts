import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  deriveApprovalEventState,
  markSessionAutoResolvingApproval,
} from "../approval-event-state";

function event(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
  };
}

describe("approval event state", () => {
  it("keeps concurrent requests pending until their matching IDs resolve", () => {
    const state = deriveApprovalEventState([
      event("request-a", 1_000, "approval_requested", {
        approval: { id: "approval-a", status: "pending" },
      }),
      event("request-b", 1_100, "approval_requested", {
        approval: { id: "approval-b", status: "pending" },
      }),
      event("grant-a", 1_200, "approval_granted", { approvalId: "approval-a" }),
    ]);

    expect(state.pendingRequests.map((request) => request.id)).toEqual(["request-b"]);
    expect(state.resolvedRequestEventIds).toEqual(new Set(["request-a"]));
  });

  it("uses event sequence to resolve out-of-order packets", () => {
    const request = { ...event("request", 2_000, "approval_requested"), seq: 10 };
    request.payload = { approval: { id: "approval-1", status: "pending" } };
    const grant = {
      ...event("grant", 1_000, "approval_granted", { approvalId: "approval-1" }),
      seq: 11,
    };

    expect(deriveApprovalEventState([grant, request]).pendingRequests).toEqual([]);
  });

  it("marks session auto-approval locally without changing canonical autoApproved", () => {
    const request = event("request", 1_000, "approval_requested", {
      approval: { id: "approval-1", status: "pending" },
    });

    const marked = markSessionAutoResolvingApproval(request, true);

    expect(marked.payload).toMatchObject({ autoResolving: true });
    expect(marked.payload?.autoApproved).toBeUndefined();
    expect(request.payload).not.toHaveProperty("autoResolving");
  });
});
