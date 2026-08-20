import { describe, expect, it } from "vitest";
import type { ManagedSessionEvent } from "../../../../shared/types";
import {
  cleanBotUserMessage,
  latestBotConversationFailure,
  projectBotConversation,
} from "../bot-conversation-projection";

function event(
  id: string,
  type: ManagedSessionEvent["type"],
  payload: Record<string, unknown>,
): ManagedSessionEvent {
  return { id, sessionId: "session-1", seq: Number(id), timestamp: Number(id), type, payload };
}

describe("bot conversation projection", () => {
  it("removes the bot transport header from canonical user messages", () => {
    expect(cleanBotUserMessage("Message from the user (correlation=abc):\n\nHello bot")).toBe(
      "Hello bot",
    );
  });

  it("shows canonical user turns and bridged assistant replies while hiding runtime internals", () => {
    const messages = projectBotConversation([
      event("1", "user.message", {
        content: [{ type: "text", text: "Message from the user:\n\nWhat needs attention?" }],
      }),
      event("2", "task.event.bridge", {
        legacyType: "log",
        message: "Routing initial prompt through companion mode before planning.",
      }),
      event("3", "task.event.bridge", {
        legacyType: "user_message",
        message: "System policy and expanded user request",
      }),
      event("4", "task.event.bridge", {
        legacyType: "assistant_message",
        message: "Two items need attention.",
      }),
      event("5", "task.event.bridge", {
        legacyType: "task_status",
        message: "Chat turn completed",
      }),
    ]);

    expect(messages).toEqual([
      { id: "1", role: "user", text: "What needs attention?", timestamp: 1 },
      { id: "4", role: "assistant", text: "Two items need attention.", timestamp: 4 },
    ]);
  });

  it("deduplicates repeated adjacent message events", () => {
    expect(
      projectBotConversation([
        event("1", "assistant.message", { message: "Done" }),
        event("2", "task.event.bridge", { legacyType: "assistant_message", message: "Done" }),
      ]),
    ).toHaveLength(1);
  });

  it("retains the latest terminal failure for an inline error state", () => {
    expect(
      latestBotConversationFailure([
        event("1", "session.failed", { error: "First failure" }),
        event("2", "session.failed", { message: "Latest failure" }),
      ]),
    ).toBe("Latest failure");
  });
});
