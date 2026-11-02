import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/test-cowork" },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { MessageRouter } from "../router";
import type { GatewayEvent, IncomingMessage } from "../channels/types";

function createMockDb() {
  const statement = { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
  return {
    prepare: () => statement,
    transaction: (fn: Any) => Object.assign(fn, { deferred: fn, immediate: fn }),
  } as Any;
}

/** Runs one message through `handleMessage` and returns the gateway events it emitted. */
async function emittedEvents(message: Partial<IncomingMessage>): Promise<GatewayEvent[]> {
  const router = new MessageRouter(createMockDb(), {}, undefined);
  (router as Any).getChannelForAdapter = vi
    .fn()
    .mockResolvedValue({ id: "channel-db-1", type: "slack", config: {} });
  (router as Any).securityManager.checkAccess = vi.fn().mockResolvedValue({ allowed: true });
  (router as Any).messageRepo.create = vi.fn();
  const events: GatewayEvent[] = [];
  router.onEvent((event) => events.push(event));
  await (router as Any).handleMessage({ type: "slack" }, {
    messageId: "msg-1",
    channel: "slack",
    userId: "U123",
    userName: "Ada Lovelace",
    chatId: "C456",
    text: "",
    timestamp: new Date(1_700_000_000_000),
    // Ingest-only stops right after the event, before any agent routing.
    ingestOnly: true,
    ...message,
  } satisfies IncomingMessage);
  return events;
}

describe("MessageRouter message:received event", () => {
  it("carries the full message text and the sender's display name", async () => {
    const text = `please deploy the release ${"x".repeat(150)} now`;
    const events = await emittedEvents({ text });

    const received = events.filter((event) => event.type === "message:received");
    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe("slack");
    expect(received[0].data).toEqual({
      channelId: "channel-db-1",
      messageId: "msg-1",
      chatId: "C456",
      userId: "U123",
      senderName: "Ada Lovelace",
      text,
      preview: text.slice(0, 100),
    });
  });

  it("falls back to the user id when the channel gives no display name", async () => {
    const events = await emittedEvents({ text: "hello", userName: "  " });

    expect(events[0].data).toMatchObject({ senderName: "U123", text: "hello" });
  });
});
