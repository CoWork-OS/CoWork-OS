import { describe, expect, it } from "vitest";
import type { InputRequest } from "../../../shared/types";
import { reconcilePendingInputRequests } from "../pending-input-requests";

const request = (id: string, requestedAt: number): InputRequest =>
  ({ id, taskId: "task-1", status: "pending", requestedAt, questions: [] }) as InputRequest;

describe("reconcilePendingInputRequests", () => {
  it("restores a request whose live event was missed and drops one answered elsewhere", () => {
    const current = new Map([["answered", request("answered", 100)]]);
    const next = reconcilePendingInputRequests([request("missed", 150)], current, 200);
    expect([...next.keys()]).toEqual(["missed"]);
  });

  it("keeps a request that arrived while the list was loading", () => {
    const current = new Map([["fresh", request("fresh", 210)]]);
    const next = reconcilePendingInputRequests([], current, 200);
    expect([...next.keys()]).toEqual(["fresh"]);
  });
});
