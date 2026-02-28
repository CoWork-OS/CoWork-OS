/**
 * MessageRouter sendTaskUpdate logging tests
 *
 * These ensure assistant streaming/debounced updates are persisted via sendMessage,
 * so transcript-based commands like /digest can see assistant replies.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock better-sqlite3 (native module) before importing MessageRouter
vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
      close: vi.fn(),
    })),
  };
});

// Mock electron APIs used by gateway modules
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
  },
}));

import { MessageRouter } from "../router";

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Any) => fn),
  } as Any;
}

describe("MessageRouter.sendTaskUpdate logging", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists debounced streaming updates via sendMessage", async () => {
    vi.useFakeTimers();

    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);

    const adapter = {
      type: "discord",
      status: "connected",
      botUsername: "test-bot",
      onMessage: vi.fn(),
      onError: vi.fn(),
      onStatusChange: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue("m1"),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as Any;

    // Register adapter by type so router.sendMessage() can resolve it.
    (router as Any).adapters.set("discord", adapter);

    // Stub repos so logging doesn't need a real DB.
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "c1" });
    (router as Any).messageRepo.create = vi.fn();

    // Route a task to our adapter.
    (router as Any).pendingTaskResponses.set("t1", {
      adapter,
      chatId: "chat1",
      sessionId: "s1",
    });

    const sendMessageSpy = vi.spyOn(router, "sendMessage");

    await router.sendTaskUpdate("t1", "Hello", true);

    // Don't run all timers globally: the router and imported modules may register long-lived
    // intervals. We only need to advance enough to flush the debounced update.
    await vi.advanceTimersByTimeAsync(2000);
    // Let any promise continuations run.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessageSpy).toHaveBeenCalled();
    expect((router as Any).messageRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "c1",
        chatId: "chat1",
        direction: "outgoing",
        content: "Hello",
      }),
    );
  });

  it("scopes idempotency dedupe to destination chat", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);

    const adapter = {
      type: "discord",
      status: "connected",
      botUsername: "test-bot",
      onMessage: vi.fn(),
      onError: vi.fn(),
      onStatusChange: vi.fn(),
      sendMessage: vi.fn().mockResolvedValueOnce("m1").mockResolvedValueOnce("m2"),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as Any;

    (router as Any).adapters.set("discord", adapter);
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "c1" });
    (router as Any).messageRepo.create = vi.fn();

    const first = await router.sendMessage("discord", {
      chatId: "chat1",
      text: "first",
      idempotencyKey: "same-key",
    });
    const second = await router.sendMessage("discord", {
      chatId: "chat2",
      text: "second",
      idempotencyKey: "same-key",
    });

    expect(first).toBe("m1");
    expect(second).toBe("m2");
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });
});
