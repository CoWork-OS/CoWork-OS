/**
 * Tests for Twitch Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock the TwitchClient class
vi.mock("../channels/twitch-client", () => ({
  TwitchClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      getUsername: () => config.username,
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        username: config.username,
      }),
      isConnected: vi.fn().mockReturnValue(false),
      getJoinedChannels: vi.fn().mockReturnValue([]),
      startReceiving: vi.fn().mockResolvedValue(undefined),
      stopReceiving: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendWhisper: vi.fn().mockResolvedValue(undefined),
      joinChannel: vi.fn(),
      leaveChannel: vi.fn(),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import { TwitchAdapter, createTwitchAdapter, TwitchConfig } from "../channels/twitch";
import { TwitchClient as _TwitchClient } from "../channels/twitch-client";

describe("TwitchAdapter", () => {
  let adapter: TwitchAdapter;
  const defaultConfig: TwitchConfig = {
    enabled: true,
    username: "testbot",
    oauthToken: "oauth:testtoken123",
    channels: ["testchannel"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TwitchAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === "connected") {
      await adapter.disconnect();
    }
  });

  describe("constructor", () => {
    it("should create adapter with correct type", () => {
      expect(adapter.type).toBe("twitch");
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

    it("should disable whispers by default", () => {
      const adapterConfig = adapter as Any;
      expect(adapterConfig.config.allowWhispers).toBe(false);
    });
  });

  describe("createTwitchAdapter factory", () => {
    it("should create adapter with valid config", () => {
      const newAdapter = createTwitchAdapter({
        enabled: true,
        username: "mybot",
        oauthToken: "oauth:token",
        channels: ["mychannel"],
      });
      expect(newAdapter).toBeInstanceOf(TwitchAdapter);
      expect(newAdapter.type).toBe("twitch");
    });

    it("should throw error if username is missing", () => {
      expect(() =>
        createTwitchAdapter({
          enabled: true,
          username: "",
          oauthToken: "oauth:token",
          channels: ["channel"],
        }),
      ).toThrow("Twitch username is required");
    });

    it("should throw error if oauthToken is missing", () => {
      expect(() =>
        createTwitchAdapter({
          enabled: true,
          username: "user",
          oauthToken: "",
          channels: ["channel"],
        }),
      ).toThrow("Twitch OAuth token is required");
    });

    it("should throw error if channels is empty", () => {
      expect(() =>
        createTwitchAdapter({
          enabled: true,
          username: "user",
          oauthToken: "oauth:token",
          channels: [],
        }),
      ).toThrow("At least one Twitch channel is required");
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

      expect(info.type).toBe("twitch");
      expect(info.status).toBe("disconnected");
      expect(info.botId).toBe("testbot");
      expect(info.extra?.channels).toEqual(["testchannel"]);
    });
  });

  describe("disconnect", () => {
    it("should clear state on disconnect", async () => {
      (adapter as Any)._status = "connected";
      (adapter as Any)._botUsername = "TestBot";

      await adapter.disconnect();

      expect(adapter.status).toBe("disconnected");
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should stop deduplication cleanup timer", async () => {
      (adapter as Any).dedupCleanupTimer = setInterval(() => {}, 60000);

      await adapter.disconnect();

      expect((adapter as Any).dedupCleanupTimer).toBeUndefined();
    });

    it("should clear processed messages cache", async () => {
      (adapter as Any).processedMessages.set("msg-123", Date.now());

      await adapter.disconnect();

      expect((adapter as Any).processedMessages.size).toBe(0);
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
      const oldTime = Date.now() - 120000;
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
          chatId: "testchannel",
          text: "Hello",
        }),
      ).rejects.toThrow("Twitch client is not connected");
    });
  });

  describe("editMessage", () => {
    it("should throw error as Twitch does not support editing", async () => {
      await expect(adapter.editMessage("testchannel", "msg-123", "Updated")).rejects.toThrow(
        "Twitch does not support message editing",
      );
    });
  });

  describe("deleteMessage validation", () => {
    it("should throw error as deletion is not implemented", async () => {
      await expect(adapter.deleteMessage("testchannel", "msg-123")).rejects.toThrow(
        "Twitch message deletion not implemented",
      );
    });
  });

  describe("sendDocument validation", () => {
    it("should throw error as Twitch does not support files", async () => {
      await expect(adapter.sendDocument("testchannel", "/path/to/file.pdf")).rejects.toThrow(
        "Twitch does not support file attachments",
      );
    });
  });

  describe("sendPhoto validation", () => {
    it("should throw error as Twitch does not support images", async () => {
      await expect(adapter.sendPhoto("testchannel", "/path/to/image.png")).rejects.toThrow(
        "Twitch does not support image attachments",
      );
    });
  });

  describe("message splitting", () => {
    it("should not split short messages", () => {
      const splitMessage = (adapter as Any).splitMessage.bind(adapter);
      const chunks = splitMessage("Hello world", 450);
      expect(chunks).toEqual(["Hello world"]);
    });

    it("should split long messages", () => {
      const splitMessage = (adapter as Any).splitMessage.bind(adapter);
      const longMessage = "A".repeat(500);
      const chunks = splitMessage(longMessage, 100);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c: string) => c.length <= 100)).toBe(true);
    });

    it("should break at spaces when possible", () => {
      const splitMessage = (adapter as Any).splitMessage.bind(adapter);
      const message = "Hello world this is a test message with multiple words";
      const chunks = splitMessage(message, 20);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("channel management", () => {
    it("should not join channel when not connected", () => {
      adapter.joinChannel("newchannel");
      // Should not throw, just silently fail
    });

    it("should not leave channel when not connected", () => {
      adapter.leaveChannel("oldchannel");
      // Should not throw, just silently fail
    });

    it("should return empty joined channels when not connected", () => {
      expect(adapter.getJoinedChannels()).toEqual([]);
    });
  });

  describe("sendWhisper validation", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.sendWhisper("targetuser", "Hello")).rejects.toThrow(
        "Twitch client is not connected",
      );
    });
  });
});

describe("TwitchConfig", () => {
  it("should accept minimal config", () => {
    const config: TwitchConfig = {
      enabled: true,
      username: "mybot",
      oauthToken: "oauth:token123",
      channels: ["mychannel"],
    };

    expect(config.username).toBe("mybot");
    expect(config.oauthToken).toBe("oauth:token123");
    expect(config.channels).toEqual(["mychannel"]);
  });

  it("should accept full config", () => {
    const config: TwitchConfig = {
      enabled: true,
      username: "mybot",
      oauthToken: "oauth:token123",
      channels: ["channel1", "channel2"],
      responsePrefix: "[Bot]",
      deduplicationEnabled: false,
      allowWhispers: true,
    };

    expect(config.responsePrefix).toBe("[Bot]");
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.allowWhispers).toBe(true);
    expect(config.channels).toHaveLength(2);
  });
});
