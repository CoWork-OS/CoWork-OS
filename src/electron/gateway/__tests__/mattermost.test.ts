/**
 * Tests for Mattermost Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock the MattermostClient class
vi.mock("../channels/mattermost-client", () => ({
  MattermostClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      getServerUrl: () => config.serverUrl,
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        userId: "test-user-id",
        username: "testbot",
      }),
      getCurrentUser: vi.fn().mockResolvedValue({
        id: "test-user-id",
        username: "testbot",
        nickname: "Test Bot",
        first_name: "Test",
        last_name: "Bot",
      }),
      getUser: vi.fn().mockImplementation((userId: string) =>
        Promise.resolve({
          id: userId,
          username: "otheruser",
          nickname: "Other User",
        }),
      ),
      isConnected: vi.fn().mockReturnValue(false),
      startWebSocket: vi.fn().mockResolvedValue(undefined),
      stopWebSocket: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ id: "post-123" }),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import {
  MattermostAdapter,
  createMattermostAdapter,
  MattermostConfig,
} from "../channels/mattermost";
import { MattermostClient as _MattermostClient } from "../channels/mattermost-client";

describe("MattermostAdapter", () => {
  let adapter: MattermostAdapter;
  const defaultConfig: MattermostConfig = {
    enabled: true,
    serverUrl: "https://mattermost.example.com",
    token: "test-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MattermostAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === "connected") {
      await adapter.disconnect();
    }
  });

  describe("constructor", () => {
    it("should create adapter with correct type", () => {
      expect(adapter.type).toBe("mattermost");
    });

    it("should start in disconnected state", () => {
      expect(adapter.status).toBe("disconnected");
    });

    it("should have no bot username initially", () => {
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should enable deduplication by default", () => {
      const adapterWithDefaults = new MattermostAdapter({
        enabled: true,
        serverUrl: "https://test.com",
        token: "token",
      });
      expect(adapterWithDefaults).toBeDefined();
    });
  });

  describe("createMattermostAdapter factory", () => {
    it("should create adapter with valid config", () => {
      const newAdapter = createMattermostAdapter({
        enabled: true,
        serverUrl: "https://test.mattermost.com",
        token: "test-token",
      });
      expect(newAdapter).toBeInstanceOf(MattermostAdapter);
      expect(newAdapter.type).toBe("mattermost");
    });

    it("should throw error if serverUrl is missing", () => {
      expect(() =>
        createMattermostAdapter({
          enabled: true,
          serverUrl: "",
          token: "token",
        }),
      ).toThrow("Mattermost server URL is required");
    });

    it("should throw error if token is missing", () => {
      expect(() =>
        createMattermostAdapter({
          enabled: true,
          serverUrl: "https://test.com",
          token: "",
        }),
      ).toThrow("Mattermost access token is required");
    });
  });

  describe("onMessage", () => {
    it("should register message handlers", () => {
      const handler = vi.fn();
      adapter.onMessage(handler);
      // Handler should be registered (internal state)
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

      // Trigger internal status change
      (adapter as Any).setStatus("connecting");

      expect(handler).toHaveBeenCalledWith("connecting", undefined);
    });
  });

  describe("getInfo", () => {
    it("should return channel info", async () => {
      const info = await adapter.getInfo();

      expect(info.type).toBe("mattermost");
      expect(info.status).toBe("disconnected");
      expect(info.extra?.serverUrl).toBe("https://mattermost.example.com");
    });
  });

  describe("disconnect", () => {
    it("should clear state on disconnect", async () => {
      // Set some internal state
      (adapter as Any)._status = "connected";
      (adapter as Any)._botUsername = "testbot";

      await adapter.disconnect();

      expect(adapter.status).toBe("disconnected");
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should stop deduplication cleanup timer", async () => {
      // Create a timer
      (adapter as Any).dedupCleanupTimer = setInterval(() => {}, 60000);

      await adapter.disconnect();

      expect((adapter as Any).dedupCleanupTimer).toBeUndefined();
    });
  });

  describe("message deduplication", () => {
    it("should track processed messages", () => {
      (adapter as Any).markMessageProcessed("msg-123");
      expect((adapter as Any).isMessageProcessed("msg-123")).toBe(true);
    });

    it("should not mark duplicate messages as unprocessed", () => {
      (adapter as Any).markMessageProcessed("msg-456");
      (adapter as Any).markMessageProcessed("msg-456");
      expect((adapter as Any).processedMessages.size).toBe(1);
    });

    it("should cleanup old messages from cache", () => {
      const oldTime = Date.now() - 120000; // 2 minutes ago
      (adapter as Any).processedMessages.set("old-msg", oldTime);
      (adapter as Any).processedMessages.set("new-msg", Date.now());

      (adapter as Any).cleanupDedupCache();

      expect((adapter as Any).processedMessages.has("old-msg")).toBe(false);
      expect((adapter as Any).processedMessages.has("new-msg")).toBe(true);
    });
  });

  describe("sendMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(
        adapter.sendMessage({
          chatId: "channel-123",
          text: "Hello",
        }),
      ).rejects.toThrow("Mattermost client is not connected");
    });
  });

  describe("editMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.editMessage("channel-123", "msg-123", "Updated")).rejects.toThrow(
        "Mattermost client is not connected",
      );
    });
  });

  describe("deleteMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.deleteMessage("channel-123", "msg-123")).rejects.toThrow(
        "Mattermost client is not connected",
      );
    });
  });
});

describe("MattermostConfig", () => {
  it("should accept minimal config", () => {
    const config: MattermostConfig = {
      enabled: true,
      serverUrl: "https://mattermost.example.com",
      token: "test-token",
    };

    expect(config.serverUrl).toBe("https://mattermost.example.com");
    expect(config.token).toBe("test-token");
  });

  it("should accept full config", () => {
    const config: MattermostConfig = {
      enabled: true,
      serverUrl: "https://mattermost.example.com",
      token: "test-token",
      teamId: "team-123",
      responsePrefix: "🤖",
      deduplicationEnabled: false,
    };

    expect(config.teamId).toBe("team-123");
    expect(config.responsePrefix).toBe("🤖");
    expect(config.deduplicationEnabled).toBe(false);
  });
});
