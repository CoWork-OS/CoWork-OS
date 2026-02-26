/**
 * Tests for Matrix Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock the MatrixClient class
vi.mock("../channels/matrix-client", () => ({
  MatrixClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      getUserId: () => config.userId,
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        userId: config.userId,
      }),
      getUserProfile: vi.fn().mockImplementation((userId?: string) =>
        Promise.resolve({
          user_id: userId || config.userId,
          displayname: "Test Bot",
          avatar_url: null,
        }),
      ),
      getJoinedRooms: vi.fn().mockResolvedValue(["!room1:matrix.org", "!room2:matrix.org"]),
      isConnected: vi.fn().mockReturnValue(false),
      getMediaUrl: vi.fn().mockImplementation((mxcUrl: string) => {
        if (mxcUrl.startsWith("mxc://")) {
          const [server, mediaId] = mxcUrl.replace("mxc://", "").split("/");
          return `${config.homeserver}/_matrix/media/v3/download/${server}/${mediaId}`;
        }
        return mxcUrl;
      }),
      startSync: vi.fn().mockResolvedValue(undefined),
      stopSync: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ event_id: "$event123" }),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import { MatrixAdapter, createMatrixAdapter, MatrixConfig } from "../channels/matrix";
import { MatrixClient as _MatrixClient } from "../channels/matrix-client";

describe("MatrixAdapter", () => {
  let adapter: MatrixAdapter;
  const defaultConfig: MatrixConfig = {
    enabled: true,
    homeserver: "https://matrix.org",
    userId: "@testbot:matrix.org",
    accessToken: "test-access-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MatrixAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === "connected") {
      await adapter.disconnect();
    }
  });

  describe("constructor", () => {
    it("should create adapter with correct type", () => {
      expect(adapter.type).toBe("matrix");
    });

    it("should start in disconnected state", () => {
      expect(adapter.status).toBe("disconnected");
    });

    it("should have no bot username initially", () => {
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should enable deduplication by default", () => {
      const adapterConfig = adapter as Any;
      expect(adapterConfig.config.deduplicationEnabled).toBe(true);
    });

    it("should enable typing indicators by default", () => {
      const adapterConfig = adapter as Any;
      expect(adapterConfig.config.sendTypingIndicators).toBe(true);
    });

    it("should enable read receipts by default", () => {
      const adapterConfig = adapter as Any;
      expect(adapterConfig.config.sendReadReceipts).toBe(true);
    });
  });

  describe("createMatrixAdapter factory", () => {
    it("should create adapter with valid config", () => {
      const newAdapter = createMatrixAdapter({
        enabled: true,
        homeserver: "https://matrix.org",
        userId: "@user:matrix.org",
        accessToken: "token",
      });
      expect(newAdapter).toBeInstanceOf(MatrixAdapter);
      expect(newAdapter.type).toBe("matrix");
    });

    it("should throw error if homeserver is missing", () => {
      expect(() =>
        createMatrixAdapter({
          enabled: true,
          homeserver: "",
          userId: "@user:matrix.org",
          accessToken: "token",
        }),
      ).toThrow("Matrix homeserver URL is required");
    });

    it("should throw error if userId is missing", () => {
      expect(() =>
        createMatrixAdapter({
          enabled: true,
          homeserver: "https://matrix.org",
          userId: "",
          accessToken: "token",
        }),
      ).toThrow("Matrix user ID is required");
    });

    it("should throw error if accessToken is missing", () => {
      expect(() =>
        createMatrixAdapter({
          enabled: true,
          homeserver: "https://matrix.org",
          userId: "@user:matrix.org",
          accessToken: "",
        }),
      ).toThrow("Matrix access token is required");
    });
  });

  describe("onMessage", () => {
    it("should register message handlers", () => {
      const handler = vi.fn();
      adapter.onMessage(handler);
      expect((adapter as Any).messageHandlers).toContain(handler);
    });

    it("should support multiple handlers", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);
      expect((adapter as Any).messageHandlers.length).toBe(2);
    });
  });

  describe("onError", () => {
    it("should register error handlers", () => {
      const handler = vi.fn();
      adapter.onError(handler);
      expect((adapter as Any).errorHandlers).toContain(handler);
    });
  });

  describe("onStatusChange", () => {
    it("should register status handlers", () => {
      const handler = vi.fn();
      adapter.onStatusChange(handler);
      expect((adapter as Any).statusHandlers).toContain(handler);
    });

    it("should call status handlers on status change", () => {
      const handler = vi.fn();
      adapter.onStatusChange(handler);
      (adapter as Any).setStatus("connecting");
      expect(handler).toHaveBeenCalledWith("connecting", undefined);
    });
  });

  describe("getInfo", () => {
    it("should return channel info", async () => {
      const info = await adapter.getInfo();

      expect(info.type).toBe("matrix");
      expect(info.status).toBe("disconnected");
      expect(info.extra?.homeserver).toBe("https://matrix.org");
      expect(info.extra?.userId).toBe("@testbot:matrix.org");
    });
  });

  describe("disconnect", () => {
    it("should clear state on disconnect", async () => {
      (adapter as Any)._status = "connected";
      (adapter as Any)._botUsername = "Test Bot";

      await adapter.disconnect();

      expect(adapter.status).toBe("disconnected");
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should stop deduplication cleanup timer", async () => {
      (adapter as Any).dedupCleanupTimer = setInterval(() => {}, 60000);

      await adapter.disconnect();

      expect((adapter as Any).dedupCleanupTimer).toBeUndefined();
    });

    it("should clear user cache", async () => {
      (adapter as Any).userCache.set("@user:matrix.org", { user_id: "@user:matrix.org" });

      await adapter.disconnect();

      expect((adapter as Any).userCache.size).toBe(0);
    });
  });

  describe("message deduplication", () => {
    it("should track processed messages", () => {
      (adapter as Any).markMessageProcessed("$event123");
      expect((adapter as Any).isMessageProcessed("$event123")).toBe(true);
    });

    it("should not mark duplicate messages as unprocessed", () => {
      (adapter as Any).markMessageProcessed("$event456");
      (adapter as Any).markMessageProcessed("$event456");
      expect((adapter as Any).processedMessages.size).toBe(1);
    });

    it("should cleanup old messages from cache", () => {
      const oldTime = Date.now() - 120000;
      (adapter as Any).processedMessages.set("$old-event", oldTime);
      (adapter as Any).processedMessages.set("$new-event", Date.now());

      (adapter as Any).cleanupDedupCache();

      expect((adapter as Any).processedMessages.has("$old-event")).toBe(false);
      expect((adapter as Any).processedMessages.has("$new-event")).toBe(true);
    });
  });

  describe("sendMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(
        adapter.sendMessage({
          chatId: "!room:matrix.org",
          text: "Hello",
        }),
      ).rejects.toThrow("Matrix client is not connected");
    });
  });

  describe("editMessage", () => {
    it("should warn that editing is not fully supported", async () => {
      await expect(adapter.editMessage("!room:matrix.org", "$event123", "Updated")).rejects.toThrow(
        "Matrix message editing not fully supported",
      );
    });
  });

  describe("deleteMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.deleteMessage("!room:matrix.org", "$event123")).rejects.toThrow(
        "Matrix client is not connected",
      );
    });
  });

  describe("sendDocument validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.sendDocument("!room:matrix.org", "/path/to/file.pdf")).rejects.toThrow(
        "Matrix client is not connected",
      );
    });
  });

  describe("sendPhoto validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.sendPhoto("!room:matrix.org", "/path/to/image.png")).rejects.toThrow(
        "Matrix client is not connected",
      );
    });
  });
});

describe("MatrixConfig", () => {
  it("should accept minimal config", () => {
    const config: MatrixConfig = {
      enabled: true,
      homeserver: "https://matrix.org",
      userId: "@user:matrix.org",
      accessToken: "token",
    };

    expect(config.homeserver).toBe("https://matrix.org");
    expect(config.userId).toBe("@user:matrix.org");
    expect(config.accessToken).toBe("token");
  });

  it("should accept full config", () => {
    const config: MatrixConfig = {
      enabled: true,
      homeserver: "https://matrix.org",
      userId: "@user:matrix.org",
      accessToken: "token",
      deviceId: "DEVICE123",
      roomIds: ["!room1:matrix.org", "!room2:matrix.org"],
      responsePrefix: "🤖",
      sendTypingIndicators: false,
      sendReadReceipts: false,
      deduplicationEnabled: false,
    };

    expect(config.deviceId).toBe("DEVICE123");
    expect(config.roomIds).toHaveLength(2);
    expect(config.responsePrefix).toBe("🤖");
    expect(config.sendTypingIndicators).toBe(false);
    expect(config.sendReadReceipts).toBe(false);
  });
});
