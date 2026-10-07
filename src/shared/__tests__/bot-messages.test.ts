import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../types";
import { BOT_MESSAGE_TEXT_MAX_CHARS, BotGreetingTracker, toBotMessage } from "../bot-messages";

function event(type: string, payload: Record<string, unknown>, legacyType?: string): TaskEvent {
  return {
    id: "e1",
    taskId: "t1",
    timestamp: 1_000,
    type,
    ...(legacyType ? { legacyType } : {}),
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

describe("toBotMessage", () => {
  it("reads user, bot and teammate messages, including timeline-v2 events", () => {
    expect(toBotMessage(event("user_message", { message: "hey" }))).toMatchObject({
      role: "user",
      text: "hey",
      conversationId: "t1",
    });
    expect(
      toBotMessage(event("timeline_step_updated", { message: "Hi!" }, "assistant_message")),
    ).toMatchObject({ role: "bot", text: "Hi!" });
    expect(
      toBotMessage(
        event("user_message", {
          message: "Draft ready",
          messageSource: "agent",
          senderLabel: "Scribe",
        }),
      ),
    ).toMatchObject({ role: "teammate", senderLabel: "Scribe" });
  });

  it("drops seeds, internal prompts, internal replies and delivery receipts", () => {
    expect(
      toBotMessage(event("user_message", { message: "Start chatting with Atlas." })),
    ).toBeNull();
    expect(
      toBotMessage(event("user_message", { message: "Resume the Atlas bot conversation." })),
    ).toBeNull();
    expect(toBotMessage(event("user_message", { message: "[RETRY CONTEXT]: again" }))).toBeNull();
    expect(toBotMessage(event("assistant_message", { message: "x", internal: true }))).toBeNull();
    expect(
      toBotMessage(
        event("assistant_message", {
          message: "success=true deliveryStatus=delivered message_id=abc",
        }),
      ),
    ).toBeNull();
    expect(toBotMessage(event("tool_call", { message: "ls" }))).toBeNull();
  });

  it("uses the completion summary and caps very long text", () => {
    expect(toBotMessage(event("task_completed", { resultSummary: "Shipped." }))?.text).toBe(
      "Shipped.",
    );
    const long = toBotMessage(
      event("assistant_message", { message: "a".repeat(BOT_MESSAGE_TEXT_MAX_CHARS + 10) }),
    );
    expect(long?.truncated).toBe(true);
    expect(long?.text.length).toBeLessThanOrEqual(BOT_MESSAGE_TEXT_MAX_CHARS + 1);
  });
});

describe("approval prompts and greetings", () => {
  it("drops approval prompts the bot posted as replies", () => {
    expect(
      toBotMessage(
        event("assistant_message", {
          message: "May I run this?",
          source: "assistant_approval_request",
        }),
      ),
    ).toBeNull();
    expect(
      toBotMessage(
        event("assistant_message", { message: "Timed out", source: "assistant_approval_timeout" }),
      ),
    ).toBeNull();
  });

  it("hides the reply to the opening seed until the user or a teammate writes", () => {
    const tracker = new BotGreetingTracker();
    const shown = (type: string, payload: Record<string, unknown>) => {
      const value = event(type, payload);
      return tracker.isShown(value, toBotMessage(value));
    };
    expect(shown("assistant_message", { message: "Earlier, no seed seen" })).toBe(true);
    expect(shown("user_message", { message: "Start chatting with Forge." })).toBe(true);
    expect(shown("assistant_message", { message: "Forge here, ready." })).toBe(false);
    expect(shown("task_completed", { resultSummary: "Ready." })).toBe(false);
    expect(shown("user_message", { message: "Check the build" })).toBe(true);
    expect(shown("assistant_message", { message: "Build passes." })).toBe(true);
  });
});
