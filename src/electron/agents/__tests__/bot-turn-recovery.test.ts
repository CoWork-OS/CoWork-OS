import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { findUnfinishedBotUserTurn } from "../bot-turn-recovery";

const event = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as TaskEvent;
const user = event("user_message", {
  message: "Read my context",
  messageSource: "user",
  messageId: "turn-1",
});

describe("bot user-turn recovery", () => {
  it("recovers the latest user request after commentary and tool results", () => {
    expect(
      findUnfinishedBotUserTurn([
        user,
        event("assistant_message", { message: "I will read it" }),
        event("tool_result", { tool: "read_file", result: { success: true } }),
      ]),
    ).toEqual({ message: "Read my context", messageSource: "user", messageId: "turn-1" });
  });
  it("does not replay a completed turn", () => {
    expect(
      findUnfinishedBotUserTurn([
        user,
        event("follow_up_completed", { followUpMessage: "Read my context" }),
      ]),
    ).toBeUndefined();
  });
  it("does not mistake completion of an older turn for completion of a new request", () => {
    expect(
      findUnfinishedBotUserTurn([
        user,
        event("follow_up_completed", { followUpMessage: "Read my context" }),
        event("user_message", { message: "Read newer context", messageSource: "user" }),
      ])?.message,
    ).toBe("Read newer context");
  });
  it.each([
    { message: "Start chatting with Coordinator." },
    { message: "Read context", messageSource: "agent" },
    { message: "Read context", providerDispatchStatus: "completed" },
  ])("does not replay synthetic, agent, or dispatch-completed turns: %j", (payload) => {
    expect(findUnfinishedBotUserTurn([event("user_message", payload)])).toBeUndefined();
  });
});
