import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../../shared/types";
import { getStepMessageEventIds } from "../task-feed-logic";

function event(id: string, type: string): { kind: "event"; event: TaskEvent } {
  return {
    kind: "event",
    event: { id, taskId: "t", type, timestamp: 1, payload: { message: id } } as TaskEvent,
  };
}

const block = { kind: "action_block" };

describe("getStepMessageEventIds", () => {
  it("marks narration followed by agent activity, not the reply that ends the turn", () => {
    const items = [
      event("u1", "user_message"),
      event("a1", "assistant_message"),
      block,
      event("a2", "assistant_message"),
      { kind: "dispatched-agents" },
      event("a3", "assistant_message"),
      event("u2", "user_message"),
    ];
    expect([...getStepMessageEventIds(items, false)]).toEqual(["a1", "a2"]);
  });

  it("treats the latest message as a step only while the task runs", () => {
    const items = [event("u1", "user_message"), block, event("a1", "assistant_message")];
    expect(getStepMessageEventIds(items, true).has("a1")).toBe(true);
    expect(getStepMessageEventIds(items, false).has("a1")).toBe(false);
  });
});
