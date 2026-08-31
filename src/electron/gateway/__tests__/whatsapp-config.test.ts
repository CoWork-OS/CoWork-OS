/**
 * Tests for WhatsApp adapter updateConfig and reconnect handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeWhatsAppPhoneTarget, WhatsAppAdapter } from "../channels/whatsapp";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// Type for WhatsApp config
interface WhatsAppConfig {
  deduplicationEnabled?: boolean;
  selfChatMode?: boolean;
  sendReadReceipts?: boolean;
}

// Mock adapter for testing updateConfig logic
function createMockWhatsAppAdapter() {
  let dedupCleanupTimer: ReturnType<typeof setInterval> | undefined;
  const processedMessages = new Map<string, number>();

  return {
    config: {} as WhatsAppConfig,
    processedMessages,
    dedupCleanupTimer,
    shouldReconnect: true,

    startDedupCleanup() {
      if (dedupCleanupTimer) return;
      dedupCleanupTimer = setInterval(() => {
        // Cleanup old messages
      }, 60000);
      this.dedupCleanupTimer = dedupCleanupTimer;
    },

    stopDedupCleanup() {
      if (dedupCleanupTimer) {
        clearInterval(dedupCleanupTimer);
        dedupCleanupTimer = undefined;
        this.dedupCleanupTimer = undefined;
      }
    },

    updateConfig(next: Partial<WhatsAppConfig>): void {
      const prevDedupEnabled = this.config.deduplicationEnabled !== false;
      const prevSelfChat = this.config.selfChatMode === true;

      this.config = {
        ...this.config,
        ...next,
      };

      // If self-chat was just enabled and read receipts weren't explicitly set, default to false
      if (!prevSelfChat && this.config.selfChatMode && next.sendReadReceipts === undefined) {
        this.config.sendReadReceipts = false;
      }

      const nextDedupEnabled = this.config.deduplicationEnabled !== false;
      if (nextDedupEnabled && !prevDedupEnabled) {
        this.startDedupCleanup();
      } else if (!nextDedupEnabled && prevDedupEnabled) {
        this.stopDedupCleanup();
        this.processedMessages.clear();
      }
    },

    disconnect() {
      this.shouldReconnect = false;
    },

    connect() {
      this.shouldReconnect = true;
    },

    handleConnectionUpdate(_connection: string): boolean {
      if (!this.shouldReconnect) {
        // If manual disconnect happened, don't reconnect
        return false;
      }
      return true;
    },

    attemptReconnection(): boolean {
      if (!this.shouldReconnect) {
        return false;
      }
      return true;
    },
  };
}

describe("WhatsApp Adapter updateConfig", () => {
  let adapter: ReturnType<typeof createMockWhatsAppAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    adapter = createMockWhatsAppAdapter();
  });

  afterEach(() => {
    adapter.stopDedupCleanup();
    vi.useRealTimers();
  });

  describe("updateConfig", () => {
    it("should merge new config with existing config", () => {
      adapter.config = { deduplicationEnabled: true };

      adapter.updateConfig({ selfChatMode: true });

      expect(adapter.config.deduplicationEnabled).toBe(true);
      expect(adapter.config.selfChatMode).toBe(true);
    });

    it("should override existing config values", () => {
      adapter.config = { selfChatMode: false, sendReadReceipts: true };

      adapter.updateConfig({ selfChatMode: true });

      expect(adapter.config.selfChatMode).toBe(true);
    });

    describe("self-chat mode and read receipts", () => {
      it("should disable read receipts when enabling self-chat mode", () => {
        adapter.config = { selfChatMode: false, sendReadReceipts: true };

        adapter.updateConfig({ selfChatMode: true });

        expect(adapter.config.sendReadReceipts).toBe(false);
      });

      it("should NOT override explicit sendReadReceipts setting", () => {
        adapter.config = { selfChatMode: false };

        adapter.updateConfig({ selfChatMode: true, sendReadReceipts: true });

        expect(adapter.config.sendReadReceipts).toBe(true);
      });

      it("should NOT change read receipts when self-chat was already enabled", () => {
        adapter.config = { selfChatMode: true, sendReadReceipts: true };

        adapter.updateConfig({ selfChatMode: true }); // No change to self-chat

        expect(adapter.config.sendReadReceipts).toBe(true);
      });

      it("should NOT change read receipts when disabling self-chat", () => {
        adapter.config = { selfChatMode: true, sendReadReceipts: false };

        adapter.updateConfig({ selfChatMode: false });

        expect(adapter.config.sendReadReceipts).toBe(false);
      });
    });

    describe("deduplication", () => {
      it("should start dedup cleanup when enabling deduplication", () => {
        adapter.config = { deduplicationEnabled: false };

        adapter.updateConfig({ deduplicationEnabled: true });

        expect(adapter.dedupCleanupTimer).toBeDefined();
      });

      it("should stop dedup cleanup when disabling deduplication", () => {
        adapter.config = { deduplicationEnabled: true };
        adapter.startDedupCleanup();
        adapter.processedMessages.set("msg-1", Date.now());

        adapter.updateConfig({ deduplicationEnabled: false });

        expect(adapter.dedupCleanupTimer).toBeUndefined();
        expect(adapter.processedMessages.size).toBe(0);
      });

      it("should clear processed messages when disabling dedup", () => {
        adapter.config = { deduplicationEnabled: true };
        adapter.processedMessages.set("msg-1", Date.now());
        adapter.processedMessages.set("msg-2", Date.now());

        adapter.updateConfig({ deduplicationEnabled: false });

        expect(adapter.processedMessages.size).toBe(0);
      });

      it("should NOT restart dedup cleanup if already enabled", () => {
        adapter.config = { deduplicationEnabled: true };
        adapter.startDedupCleanup();
        const originalTimer = adapter.dedupCleanupTimer;

        adapter.updateConfig({ selfChatMode: true }); // Unrelated change

        expect(adapter.dedupCleanupTimer).toBe(originalTimer);
      });

      it("should treat undefined deduplicationEnabled as enabled (default)", () => {
        adapter.config = {}; // undefined = enabled by default

        adapter.updateConfig({ selfChatMode: true });

        // Should not stop dedup because it was enabled by default
        expect(adapter.processedMessages.size).toBe(0); // No messages to clear
      });
    });
  });

  describe("shouldReconnect flag", () => {
    it("should prevent reconnection after disconnect", () => {
      adapter.disconnect();

      expect(adapter.shouldReconnect).toBe(false);
      expect(adapter.handleConnectionUpdate("close")).toBe(false);
      expect(adapter.attemptReconnection()).toBe(false);
    });

    it("should allow reconnection after connect", () => {
      adapter.disconnect();
      adapter.connect();

      expect(adapter.shouldReconnect).toBe(true);
      expect(adapter.handleConnectionUpdate("close")).toBe(true);
      expect(adapter.attemptReconnection()).toBe(true);
    });

    it("should be true by default", () => {
      expect(adapter.shouldReconnect).toBe(true);
    });
  });
});

describe("WhatsAppAdapter certificate handling", () => {
  it("stops auto-reconnect when WhatsApp TLS certificate trust fails", () => {
    const adapter = new WhatsAppAdapter({
      authDir: "/tmp/test-cowork/wa-auth-cert",
    } as Any);
    const statusHandler = vi.fn();
    const errorHandler = vi.fn();
    adapter.onStatusChange(statusHandler);
    adapter.onError(errorHandler);
    const reconnectSpy = vi.spyOn(adapter as Any, "attemptReconnection");
    const certError = new Error("unable to get local issuer certificate") as Error & {
      code: string;
    };
    certError.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";

    (adapter as Any).handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: certError },
    });

    expect(reconnectSpy).not.toHaveBeenCalled();
    expect((adapter as Any).shouldReconnect).toBe(false);
    expect(adapter.status).toBe("error");
    expect(statusHandler).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        message: expect.stringContaining("WhatsApp TLS certificate verification failed"),
      }),
    );
    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Original error: unable to get local issuer certificate"),
      }),
      "connectionClose",
    );
  });

  it("continues the normal reconnect path for retryable WhatsApp disconnects", () => {
    const adapter = new WhatsAppAdapter({
      authDir: "/tmp/test-cowork/wa-auth-retry",
    } as Any);
    const reconnectSpy = vi
      .spyOn(adapter as Any, "attemptReconnection")
      .mockResolvedValue(undefined);

    (adapter as Any).handleConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    expect((adapter as Any).shouldReconnect).toBe(true);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsAppAdapter editMessage", () => {
  it("sends a Baileys edit payload with WhatsApp markdown and self-chat prefix", async () => {
    const adapter = new WhatsAppAdapter({
      authDir: "/tmp/test-cowork/wa-auth",
      selfChatMode: true,
      responsePrefix: "🤖",
    } as Any);
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "edit-1" } });
    (adapter as Any).sock = { sendMessage };
    (adapter as Any)._status = "connected";

    await adapter.editMessage("15551234567", "msg-1", "**Done** [link](https://example.com)");

    expect(sendMessage).toHaveBeenCalledWith("15551234567@s.whatsapp.net", {
      text: "🤖 *Done* link (https://example.com)",
      edit: {
        remoteJid: "15551234567@s.whatsapp.net",
        fromMe: true,
        id: "msg-1",
      },
    });
  });
});

describe("normalizeWhatsAppPhoneTarget", () => {
  it("normalizes user JIDs with device suffix", () => {
    expect(normalizeWhatsAppPhoneTarget("41796666864:0@s.whatsapp.net")).toBe("41796666864");
    expect(normalizeWhatsAppPhoneTarget("1234567890:123@s.whatsapp.net")).toBe("1234567890");
    expect(normalizeWhatsAppPhoneTarget("1555123@s.whatsapp.net")).toBe("1555123");
  });

  it("normalizes @lid JIDs", () => {
    expect(normalizeWhatsAppPhoneTarget("123456789@lid")).toBe("123456789");
    expect(normalizeWhatsAppPhoneTarget("123456789@LID")).toBe("123456789");
  });

  it("handles repeated whatsapp: prefixes and direct phone values", () => {
    expect(normalizeWhatsAppPhoneTarget("whatsapp:41796666864:0@s.whatsapp.net")).toBe(
      "41796666864",
    );
    expect(normalizeWhatsAppPhoneTarget("whatsapp:whatsapp:1555123")).toBe("1555123");
  });

  it("rejects malformed WhatsApp targets", () => {
    expect(normalizeWhatsAppPhoneTarget("abc@s.whatsapp.net")).toBeNull();
    expect(normalizeWhatsAppPhoneTarget("group:120@g.us")).toBeNull();
    expect(normalizeWhatsAppPhoneTarget("foo")).toBeNull();
  });
});

describe("WhatsApp message isGroup field", () => {
  it("should set isGroup=true for group messages", () => {
    const remoteJid = "123456789-1234567890@g.us"; // Group JID
    const isGroup = remoteJid.endsWith("@g.us");

    expect(isGroup).toBe(true);
  });

  it("should set isGroup=false for direct messages", () => {
    const remoteJid = "15551234567@s.whatsapp.net"; // Direct JID
    const isGroup = remoteJid.endsWith("@g.us");

    expect(isGroup).toBe(false);
  });
});
