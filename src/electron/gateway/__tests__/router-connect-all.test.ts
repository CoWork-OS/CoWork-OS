import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("MessageRouter connectAll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not block other channels when one adapter connect times out", async () => {
    vi.useFakeTimers();
    const router = new MessageRouter(createMockDb(), {}, undefined);
    const slowAdapter = {
      type: "whatsapp",
      status: "disconnected",
      connect: vi.fn(() => new Promise<void>(() => {})),
    };
    const fastAdapter = {
      type: "discord",
      status: "disconnected",
      connect: vi.fn(async () => {
        fastAdapter.status = "connected";
      }),
    };

    (router as Any).channelRepo.findEnabled = vi.fn().mockReturnValue([
      { id: "whatsapp-1", type: "whatsapp" },
      { id: "discord-1", type: "discord" },
    ]);
    (router as Any).adaptersByChannelId.set("whatsapp-1", slowAdapter);
    (router as Any).adaptersByChannelId.set("discord-1", fastAdapter);
    (router as Any).sessionRepo.findActiveByChannelId = vi.fn().mockReturnValue([]);

    const connectPromise = router.connectAll({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await connectPromise;

    expect(slowAdapter.connect).toHaveBeenCalledOnce();
    expect(fastAdapter.connect).toHaveBeenCalledOnce();
    expect(fastAdapter.status).toBe("connected");
  });
});
