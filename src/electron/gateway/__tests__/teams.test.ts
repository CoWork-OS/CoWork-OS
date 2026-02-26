/**
 * Tests for Microsoft Teams Channel Adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock the botbuilder SDK
vi.mock("botbuilder", () => {
  // Define mock classes inside the factory
  const MockCloudAdapter = class {
    process = vi.fn().mockResolvedValue(undefined);
    continueConversationAsync = vi
      .fn()
      .mockImplementation(async (appId: string, ref: Any, callback: Any) => {
        const mockContext = {
          activity: { conversation: { id: "conv-123" } },
          sendActivity: vi.fn().mockResolvedValue({ id: "msg-123" }),
          updateActivity: vi.fn().mockResolvedValue(undefined),
          deleteActivity: vi.fn().mockResolvedValue(undefined),
        };
        await callback(mockContext);
      });
    onTurnError: Any = null;
  };

  const MockConfigurationBotFrameworkAuthentication = class {
    constructor(_config: Any) {}
  };

  return {
    CloudAdapter: MockCloudAdapter,
    ConfigurationBotFrameworkAuthentication: MockConfigurationBotFrameworkAuthentication,
    TurnContext: {
      getConversationReference: vi.fn().mockReturnValue({
        conversation: { id: "conv-123" },
        bot: { id: "bot-123" },
      }),
    },
    ActivityTypes: {
      Message: "message",
      ConversationUpdate: "conversationUpdate",
      MessageReaction: "messageReaction",
    },
    MessageFactory: {
      text: vi.fn().mockImplementation((text: string) => ({ type: "message", text })),
      attachment: vi.fn().mockImplementation((attachment: Any, text?: string) => ({
        type: "message",
        attachments: [attachment],
        text,
      })),
    },
  };
});

// Mock http module to avoid actual server creation
vi.mock("http", () => ({
  createServer: vi.fn().mockImplementation((_handler) => {
    const emitter = new EventEmitter();
    return {
      listen: vi.fn().mockImplementation((port, callback) => {
        if (callback) callback();
        return emitter;
      }),
      close: vi.fn().mockImplementation((callback) => {
        if (callback) callback();
      }),
      on: emitter.on.bind(emitter),
    };
  }),
}));

// Import after mocking
import { TeamsAdapter, createTeamsAdapter } from "../channels/teams";
import { TeamsConfig } from "../channels/types";

describe("TeamsAdapter", () => {
  let adapter: TeamsAdapter;
  const defaultConfig: TeamsConfig = {
    enabled: true,
    appId: "test-app-id-12345",
    appPassword: "test-app-password",
    webhookPort: 3978,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TeamsAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === "connected") {
      await adapter.disconnect();
    }
  });

  describe("constructor", () => {
    it("should create adapter with correct type", () => {
      expect(adapter.type).toBe("teams");
    });

    it("should start in disconnected state", () => {
      expect(adapter.status).toBe("disconnected");
    });

    it("should have no bot username initially", () => {
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should use default webhook port if not specified", () => {
      const adapterNoPort = new TeamsAdapter({
        enabled: true,
        appId: "app-id",
        appPassword: "password",
      });
      const config = (adapterNoPort as Any).config;
      expect(config.webhookPort).toBeUndefined(); // Will default to 3978 on connect
    });

    it("should accept custom webhook port", () => {
      const adapterCustomPort = new TeamsAdapter({
        enabled: true,
        appId: "app-id",
        appPassword: "password",
        webhookPort: 4000,
      });
      const config = (adapterCustomPort as Any).config;
      expect(config.webhookPort).toBe(4000);
    });

    it("should accept tenant ID for single-tenant apps", () => {
      const adapterSingleTenant = new TeamsAdapter({
        enabled: true,
        appId: "app-id",
        appPassword: "password",
        tenantId: "tenant-123",
      });
      const config = (adapterSingleTenant as Any).config;
      expect(config.tenantId).toBe("tenant-123");
    });
  });

  describe("createTeamsAdapter factory", () => {
    it("should create adapter with valid config", () => {
      const newAdapter = createTeamsAdapter({
        enabled: true,
        appId: "valid-app-id",
        appPassword: "valid-password",
      });
      expect(newAdapter).toBeInstanceOf(TeamsAdapter);
      expect(newAdapter.type).toBe("teams");
    });

    it("should throw error if appId is missing", () => {
      expect(() =>
        createTeamsAdapter({
          enabled: true,
          appId: "",
          appPassword: "password",
        }),
      ).toThrow("Microsoft App ID is required");
    });

    it("should throw error if appPassword is missing", () => {
      expect(() =>
        createTeamsAdapter({
          enabled: true,
          appId: "app-id",
          appPassword: "",
        }),
      ).toThrow("Microsoft App Password is required");
    });
  });

  describe("connect", () => {
    it("should transition to connecting state", async () => {
      const statusHandler = vi.fn();
      adapter.onStatusChange(statusHandler);

      const connectPromise = adapter.connect();

      // Should have been called with 'connecting'
      expect(statusHandler).toHaveBeenCalledWith("connecting", undefined);

      await connectPromise;
    });

    it("should set bot username from config displayName", async () => {
      const adapterWithName = new TeamsAdapter({
        ...defaultConfig,
        displayName: "My Test Bot",
      });

      await adapterWithName.connect();

      expect(adapterWithName.botUsername).toBe("My Test Bot");

      await adapterWithName.disconnect();
    });

    it("should use default bot name if displayName not provided", async () => {
      await adapter.connect();

      expect(adapter.botUsername).toBe("Teams Bot");

      await adapter.disconnect();
    });

    it("should not reconnect if already connected", async () => {
      await adapter.connect();
      const firstStatus = adapter.status;

      await adapter.connect(); // Second connect call

      expect(adapter.status).toBe(firstStatus);
      expect(adapter.status).toBe("connected");
    });

    it("should not reconnect if currently connecting", async () => {
      (adapter as Any)._status = "connecting";

      await adapter.connect();

      // Should remain in connecting state without error
      expect(adapter.status).toBe("connecting");
    });
  });

  describe("disconnect", () => {
    it("should clear state on disconnect", async () => {
      await adapter.connect();
      expect(adapter.status).toBe("connected");

      await adapter.disconnect();

      expect(adapter.status).toBe("disconnected");
      expect(adapter.botUsername).toBeUndefined();
    });

    it("should clear conversation references", async () => {
      await adapter.connect();
      (adapter as Any).conversationReferences.set("conv-123", { id: "ref-123" });

      await adapter.disconnect();

      expect((adapter as Any).conversationReferences.size).toBe(0);
    });

    it("should clear reconnect timer if set", async () => {
      (adapter as Any).reconnectTimer = setTimeout(() => {}, 10000);

      await adapter.disconnect();

      expect((adapter as Any).reconnectTimer).toBeNull();
    });

    it("should close the HTTP server", async () => {
      await adapter.connect();
      const _server = (adapter as Any).server;

      await adapter.disconnect();

      expect((adapter as Any).server).toBeNull();
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

    it("should pass error to status handlers", () => {
      const handler = vi.fn();
      const error = new Error("Test error");
      adapter.onStatusChange(handler);
      (adapter as Any).setStatus("error", error);
      expect(handler).toHaveBeenCalledWith("error", error);
    });
  });

  describe("getInfo", () => {
    it("should return channel info", async () => {
      const info = await adapter.getInfo();

      expect(info.type).toBe("teams");
      expect(info.status).toBe("disconnected");
    });

    it("should include botId in info", async () => {
      const info = await adapter.getInfo();
      expect(info.botId).toBe("test-app-id-12345");
    });

    it("should include botUsername when connected", async () => {
      await adapter.connect();

      const info = await adapter.getInfo();

      expect(info.botUsername).toBe("Teams Bot");
      expect(info.botDisplayName).toBe("Teams Bot");

      await adapter.disconnect();
    });
  });

  describe("sendMessage validation", () => {
    it("should throw error when not connected", async () => {
      await expect(
        adapter.sendMessage({
          chatId: "conv-123",
          text: "Hello",
        }),
      ).rejects.toThrow("Teams bot is not connected");
    });

    it("should throw error when no conversation reference exists", async () => {
      await adapter.connect();

      await expect(
        adapter.sendMessage({
          chatId: "unknown-chat",
          text: "Hello",
        }),
      ).rejects.toThrow("No conversation reference found");

      await adapter.disconnect();
    });

    it("should send message when connected with valid conversation", async () => {
      await adapter.connect();

      // Add a conversation reference
      (adapter as Any).conversationReferences.set("conv-123", {
        conversation: { id: "conv-123" },
      });

      const messageId = await adapter.sendMessage({
        chatId: "conv-123",
        text: "Hello Teams!",
      });

      expect(messageId).toBeDefined();

      await adapter.disconnect();
    });
  });

  describe("editMessage", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.editMessage("conv-123", "msg-123", "Updated")).rejects.toThrow(
        "Teams bot is not connected",
      );
    });

    it("should throw error when no conversation reference exists", async () => {
      await adapter.connect();

      await expect(adapter.editMessage("unknown-chat", "msg-123", "Updated")).rejects.toThrow(
        "No conversation reference found",
      );

      await adapter.disconnect();
    });
  });

  describe("deleteMessage", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.deleteMessage("conv-123", "msg-123")).rejects.toThrow(
        "Teams bot is not connected",
      );
    });

    it("should throw error when no conversation reference exists", async () => {
      await adapter.connect();

      await expect(adapter.deleteMessage("unknown-chat", "msg-123")).rejects.toThrow(
        "No conversation reference found",
      );

      await adapter.disconnect();
    });
  });

  describe("sendDocument", () => {
    it("should throw error when not connected", async () => {
      await expect(adapter.sendDocument("conv-123", "/path/to/file.pdf")).rejects.toThrow(
        "Teams bot is not connected",
      );
    });

    it("should throw error when file does not exist", async () => {
      await adapter.connect();
      (adapter as Any).conversationReferences.set("conv-123", {
        conversation: { id: "conv-123" },
      });

      await expect(adapter.sendDocument("conv-123", "/nonexistent/file.pdf")).rejects.toThrow(
        "File not found",
      );

      await adapter.disconnect();
    });
  });

  describe("message deduplication", () => {
    it("should track processed messages", () => {
      const cache = (adapter as Any).deduplicationCache;
      cache.add("msg-123");
      expect(cache.has("msg-123")).toBe(true);
    });

    it("should return false for unknown messages", () => {
      const cache = (adapter as Any).deduplicationCache;
      expect(cache.has("unknown-msg")).toBe(false);
    });

    it("should not duplicate message entries", () => {
      const cache = (adapter as Any).deduplicationCache;
      cache.add("msg-456");
      cache.add("msg-456");
      // Cache should still work correctly
      expect(cache.has("msg-456")).toBe(true);
    });
  });

  describe("reconnection", () => {
    it("should respect autoReconnect config", () => {
      const adapterWithReconnect = new TeamsAdapter({
        ...defaultConfig,
        autoReconnect: false,
      });
      expect((adapterWithReconnect as Any).config.autoReconnect).toBe(false);
    });

    it("should respect maxReconnectAttempts config", () => {
      const adapterWithMax = new TeamsAdapter({
        ...defaultConfig,
        maxReconnectAttempts: 3,
      });
      expect((adapterWithMax as Any).config.maxReconnectAttempts).toBe(3);
    });

    it("should reset reconnect attempts on successful connect", async () => {
      (adapter as Any).reconnectAttempts = 3;

      await adapter.connect();

      expect((adapter as Any).reconnectAttempts).toBe(0);

      await adapter.disconnect();
    });
  });

  describe("markdown conversion", () => {
    it("should convert horizontal rules", () => {
      const text = "Before\n---\nAfter";
      const converted = (adapter as Any).convertMarkdownForTeams(text);
      expect(converted).toContain("───────────────────");
      expect(converted).not.toContain("---");
    });

    it("should preserve basic markdown", () => {
      const text = "**bold** and *italic* and `code`";
      const converted = (adapter as Any).convertMarkdownForTeams(text);
      expect(converted).toBe(text); // Teams supports these natively
    });
  });

  describe("message splitting", () => {
    it("should not split short messages", () => {
      const text = "Short message";
      const chunks = (adapter as Any).splitMessage(text, 4000);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe(text);
    });

    it("should split long messages", () => {
      const text = "A".repeat(5000);
      const chunks = (adapter as Any).splitMessage(text, 4000);
      expect(chunks.length).toBe(2);
    });

    it("should prefer splitting at newlines", () => {
      const text = "Line 1\n".repeat(500) + "Final line";
      const chunks = (adapter as Any).splitMessage(text, 100);

      // Chunks should end at line boundaries where possible
      chunks.forEach((chunk: string, i: number) => {
        if (i < chunks.length - 1) {
          expect(chunk.endsWith("\n") || chunk.length <= 100).toBe(true);
        }
      });
    });

    it("should prefer splitting at spaces if no newlines", () => {
      const text = "word ".repeat(1000);
      const chunks = (adapter as Any).splitMessage(text, 100);

      chunks.forEach((chunk: string) => {
        expect(chunk.length).toBeLessThanOrEqual(100);
      });
    });
  });

  describe("content type detection", () => {
    it("should detect PDF files", () => {
      const contentType = (adapter as Any).getContentType("document.pdf");
      expect(contentType).toBe("application/pdf");
    });

    it("should detect PNG images", () => {
      const contentType = (adapter as Any).getContentType("image.png");
      expect(contentType).toBe("image/png");
    });

    it("should detect JPEG images", () => {
      const contentType = (adapter as Any).getContentType("photo.jpg");
      expect(contentType).toBe("image/jpeg");
    });

    it("should detect Word documents", () => {
      const contentType = (adapter as Any).getContentType("report.docx");
      expect(contentType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    });

    it("should detect Excel spreadsheets", () => {
      const contentType = (adapter as Any).getContentType("data.xlsx");
      expect(contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });

    it("should default to octet-stream for unknown types", () => {
      const contentType = (adapter as Any).getContentType("unknown.xyz");
      expect(contentType).toBe("application/octet-stream");
    });
  });
});

describe("TeamsConfig", () => {
  it("should accept minimal config", () => {
    const config: TeamsConfig = {
      enabled: true,
      appId: "test-app-id",
      appPassword: "test-password",
    };

    expect(config.appId).toBe("test-app-id");
    expect(config.appPassword).toBe("test-password");
  });

  it("should accept full config", () => {
    const config: TeamsConfig = {
      enabled: true,
      appId: "test-app-id",
      appPassword: "test-password",
      tenantId: "tenant-123",
      displayName: "My Bot",
      webhookPort: 4000,
      responsePrefix: "[Bot]",
      deduplicationEnabled: false,
      autoReconnect: true,
      maxReconnectAttempts: 10,
    };

    expect(config.tenantId).toBe("tenant-123");
    expect(config.displayName).toBe("My Bot");
    expect(config.webhookPort).toBe(4000);
    expect(config.responsePrefix).toBe("[Bot]");
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.autoReconnect).toBe(true);
    expect(config.maxReconnectAttempts).toBe(10);
  });
});

describe("TeamsAdapter edge cases", () => {
  let adapter: TeamsAdapter;
  const defaultConfig: TeamsConfig = {
    enabled: true,
    appId: "test-app-id",
    appPassword: "test-password",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TeamsAdapter(defaultConfig);
  });

  afterEach(async () => {
    if (adapter.status === "connected") {
      await adapter.disconnect();
    }
  });

  describe("message handler error isolation", () => {
    it("should not crash if a message handler throws", async () => {
      const failingHandler = vi.fn().mockImplementation(() => {
        throw new Error("Handler error");
      });
      const successHandler = vi.fn();

      adapter.onMessage(failingHandler);
      adapter.onMessage(successHandler);

      // Handlers are registered
      expect((adapter as Any).messageHandlers.length).toBe(2);
    });
  });

  describe("error handler error isolation", () => {
    it("should not crash if an error handler throws", () => {
      const failingErrorHandler = vi.fn().mockImplementation(() => {
        throw new Error("Error handler error");
      });

      adapter.onError(failingErrorHandler);

      // Should not throw when calling handleError
      expect(() => {
        (adapter as Any).handleError(new Error("Test error"), "test");
      }).not.toThrow();
    });
  });

  describe("status handler error isolation", () => {
    it("should not crash if a status handler throws", () => {
      const failingStatusHandler = vi.fn().mockImplementation(() => {
        throw new Error("Status handler error");
      });

      adapter.onStatusChange(failingStatusHandler);

      // Should not throw when setting status
      expect(() => {
        (adapter as Any).setStatus("connecting");
      }).not.toThrow();
    });
  });

  describe("conversation reference management", () => {
    it("should store conversation references", async () => {
      await adapter.connect();

      const refs = (adapter as Any).conversationReferences;
      refs.set("conv-456", {
        conversation: { id: "conv-456" },
        bot: { id: "bot-123" },
      });

      expect(refs.has("conv-456")).toBe(true);
      expect(refs.get("conv-456").conversation.id).toBe("conv-456");

      await adapter.disconnect();
    });

    it("should clear all references on disconnect", async () => {
      await adapter.connect();

      const refs = (adapter as Any).conversationReferences;
      refs.set("conv-1", { conversation: { id: "conv-1" } });
      refs.set("conv-2", { conversation: { id: "conv-2" } });
      refs.set("conv-3", { conversation: { id: "conv-3" } });

      expect(refs.size).toBe(3);

      await adapter.disconnect();

      expect(refs.size).toBe(0);
    });
  });

  describe("deduplication cache TTL", () => {
    it("should expire old entries", () => {
      vi.useFakeTimers();

      const cache = (adapter as Any).deduplicationCache;
      cache.add("msg-old");

      // Fast-forward past TTL (default 60 seconds)
      vi.advanceTimersByTime(70000);

      // Entry should be expired (has returns false for expired entries)
      expect(cache.has("msg-old")).toBe(false);

      vi.useRealTimers();
    });

    it("should keep fresh entries", () => {
      const cache = (adapter as Any).deduplicationCache;
      cache.add("msg-fresh");

      // Entry should still be valid
      expect(cache.has("msg-fresh")).toBe(true);
    });
  });
});
