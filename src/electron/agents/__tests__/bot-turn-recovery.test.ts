import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import {
  findUnfinishedBotUserTurn,
  findUnfinishedUserFollowUp,
  unfinishedTurnContainsMessage,
} from "../bot-turn-recovery";

const event = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as TaskEvent;
const user = event("user_message", {
  message: "Read my context",
  messageSource: "user",
  messageId: "turn-1",
});

describe("bot user-turn recovery", () => {
  it("leaves an empty or assistant-only timeline without a recoverable user turn", () => {
    expect(findUnfinishedBotUserTurn([])).toBeUndefined();
    expect(
      findUnfinishedBotUserTurn([event("assistant_message", { message: "Commentary" })]),
    ).toBeUndefined();
  });

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

  it("finds the latest user turn without mutating timeline order", () => {
    const timeline = [
      user,
      event("user_message", { message: "Latest request", messageSource: "user" }),
      event("assistant_message", { message: "Working" }),
    ];
    const original = [...timeline];
    Object.freeze(timeline);
    expect(findUnfinishedBotUserTurn(timeline)?.message).toBe("Latest request");
    expect(timeline).toEqual(original);
  });
  it.each([
    { message: "Start chatting with Coordinator." },
    { message: "Read context", messageSource: "agent" },
    { message: "Read context", providerDispatchStatus: "completed" },
  ])("does not replay synthetic, agent, or dispatch-completed turns: %j", (payload) => {
    expect(findUnfinishedBotUserTurn([event("user_message", payload)])).toBeUndefined();
  });
});

describe("unanswered follow-up recovery", () => {
  const prompt = event("user_message", { message: "Summarize the report" });
  const chatTurnEnd = event("task_status", { status: "completed", message: "Chat turn completed" });
  const followUp = event("user_message", {
    message: "Now list the risks",
    messageSource: "user",
    messageId: "follow-up",
  });

  it("recovers a follow-up sent after a finished chat turn", () => {
    expect(
      findUnfinishedUserFollowUp([
        prompt,
        event("assistant_message", { message: "Here is the summary." }),
        chatTurnEnd,
        event("task_resumed", { message: "Processing follow-up message" }),
        followUp,
      ]),
    ).toEqual({ message: "Now list the risks", messageSource: "user", messageId: "follow-up" });
  });

  it.each(["task_completed", "follow_up_completed", "follow_up_failed"])(
    "counts %s as the end of the earlier turn",
    (type) => {
      expect(findUnfinishedUserFollowUp([prompt, event(type, {}), followUp])?.message).toBe(
        "Now list the risks",
      );
    },
  );

  it("leaves a crash in the first turn to the task's own recovery", () => {
    expect(
      findUnfinishedUserFollowUp([prompt, event("assistant_message", { message: "Working" })]),
    ).toBeUndefined();
  });

  it("does not replay a follow-up that finished or already has its own plan", () => {
    expect(
      findUnfinishedUserFollowUp([prompt, chatTurnEnd, followUp, chatTurnEnd]),
    ).toBeUndefined();
    expect(
      findUnfinishedUserFollowUp([prompt, chatTurnEnd, followUp, event("plan_created", {})]),
    ).toBeUndefined();
  });

  it("does not replay an agent's message", () => {
    expect(
      findUnfinishedUserFollowUp([
        prompt,
        chatTurnEnd,
        event("user_message", { message: "Handoff", messageSource: "agent" }),
      ]),
    ).toBeUndefined();
  });
});

describe("unfinished turn transcript check", () => {
  const answered = [
    { role: "user" as const, content: "continue" },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] },
  ];

  it("finds the message in the turn after the last final reply", () => {
    expect(
      unfinishedTurnContainsMessage([...answered, { role: "user", content: "next" }], "next"),
    ).toBe(true);
  });

  it("ignores the same words in an answered turn", () => {
    expect(unfinishedTurnContainsMessage(answered, "continue")).toBe(false);
  });

  it("looks past tool calls and results inside the unfinished turn", () => {
    expect(
      unfinishedTurnContainsMessage(
        [
          ...answered,
          { role: "user", content: "next" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
        ],
        "next",
      ),
    ).toBe(true);
  });
});
