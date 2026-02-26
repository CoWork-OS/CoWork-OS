/**
 * Tests for Signal channel adapter
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../channels/signal-client", () => {
  type Handler = (...args: Any[]) => void;

  class MockSignalClient {
    private handlers = new Map<string, Set<Handler>>();

    checkInstallation = vi.fn().mockResolvedValue({ installed: true, version: "signal-cli 0.0.0" });
    checkRegistration = vi.fn().mockResolvedValue({ registered: true });
    startReceiving = vi.fn().mockResolvedValue(undefined);
    stopReceiving = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockResolvedValue({ timestamp: 123 });
    sendReadReceipt = vi.fn().mockResolvedValue(undefined);
    getContacts = vi.fn().mockResolvedValue([]);
    getGroups = vi.fn().mockResolvedValue([]);
    trustIdentity = vi.fn().mockResolvedValue(undefined);
    sendTyping = vi.fn().mockResolvedValue(undefined);
    sendReaction = vi.fn().mockResolvedValue(undefined);

    constructor(_options: Any) {
      (globalThis as Any).__signalClientLastInstance = this;
    }

    on(event: string, handler: Handler): this {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set());
      }
      this.handlers.get(event)!.add(handler);
      return this;
    }

    emit(event: string, ...args: Any[]): boolean {
      const handlers = this.handlers.get(event);
      if (!handlers) {
        return false;
      }
      for (const handler of handlers) {
        handler(...args);
      }
      return true;
    }
  }

  return {
    SignalClient: MockSignalClient,
  };
});

import { createSignalAdapter } from "../channels/signal";

const getLastClient = (): Any => (globalThis as Any).__signalClientLastInstance;

describe("SignalAdapter", () => {
  it("should throw if phoneNumber is missing", () => {
    expect(() => createSignalAdapter({ enabled: true } as Any)).toThrow(
      "Signal phone number is required",
    );
  });

  it("should connect and disconnect cleanly", async () => {
    const adapter = createSignalAdapter({
      enabled: true,
      phoneNumber: "+10000000000",
    });

    expect(adapter.status).toBe("disconnected");

    await adapter.connect();

    const client = getLastClient();
    expect(adapter.status).toBe("connected");
    expect(adapter.botUsername).toBe("+10000000000");
    expect(client.checkInstallation).toHaveBeenCalled();
    expect(client.checkRegistration).toHaveBeenCalled();
    expect(client.startReceiving).toHaveBeenCalled();

    await adapter.disconnect();
    expect(adapter.status).toBe("disconnected");
    expect(client.stopReceiving).toHaveBeenCalled();
  });

  it("should deliver incoming messages to handlers and send read receipts", async () => {
    const adapter = createSignalAdapter({
      enabled: true,
      phoneNumber: "+10000000000",
    });

    const onMessage = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(onMessage);

    await adapter.connect();
    const client = getLastClient();

    const ts = 1700000000000;
    const signalMessage = {
      envelope: {
        source: "+12223334444",
        timestamp: ts,
        dataMessage: {
          timestamp: ts,
          message: "hello",
        },
      },
      account: "+10000000000",
    };

    await (adapter as Any).handleIncomingMessage(signalMessage);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(client.sendReadReceipt).toHaveBeenCalledWith("+12223334444", [ts]);

    await adapter.disconnect();
  });

  it("should deduplicate messages by timestamp", async () => {
    const adapter = createSignalAdapter({
      enabled: true,
      phoneNumber: "+10000000000",
    });

    const onMessage = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(onMessage);

    await adapter.connect();

    const ts = 1700000000000;
    const signalMessage = {
      envelope: {
        source: "+12223334444",
        timestamp: ts,
        dataMessage: {
          timestamp: ts,
          message: "hello",
        },
      },
      account: "+10000000000",
    };

    await (adapter as Any).handleIncomingMessage(signalMessage);
    await (adapter as Any).handleIncomingMessage(signalMessage);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
  });

  it("should ignore messages from self", async () => {
    const adapter = createSignalAdapter({
      enabled: true,
      phoneNumber: "+10000000000",
    });

    const onMessage = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(onMessage);

    await adapter.connect();

    const ts = 1700000000000;
    const signalMessage = {
      envelope: {
        source: "+10000000000",
        timestamp: ts,
        dataMessage: {
          timestamp: ts,
          message: "hello from self",
        },
      },
      account: "+10000000000",
    };

    await (adapter as Any).handleIncomingMessage(signalMessage);

    expect(onMessage).not.toHaveBeenCalled();

    await adapter.disconnect();
  });
});
