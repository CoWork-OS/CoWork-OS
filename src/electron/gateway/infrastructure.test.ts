/** Exercise the gateway service and its real repository facades on an isolated profile. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseManager } from "../database/schema";
import {
  DeliveryTrackingStore,
  MessageQueueStore,
  RateLimitStore,
  ScheduledMessageStore,
} from "../database/repositories";
import { GatewayInfrastructure } from "./infrastructure";
import type { ChannelAdapter, OutgoingMessage } from "./channels/types";

const message: OutgoingMessage = { chatId: "chat-1", text: "Hello" };

function createAdapter(connected = true): ChannelAdapter {
  return {
    type: "telegram",
    status: connected ? "connected" : "disconnected",
    botUsername: "test_bot",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue("message-1"),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    getInfo: vi.fn().mockResolvedValue({ type: "telegram", status: "connected" }),
  };
}

describe("GatewayInfrastructure", () => {
  let root: string;
  let manager: DatabaseManager;
  let service: GatewayInfrastructure;
  let queue: MessageQueueStore;
  let scheduled: ScheduledMessageStore;
  let delivery: DeliveryTrackingStore;
  let limits: RateLimitStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cowork-gateway-infrastructure-"));
    vi.stubEnv("COWORK_USER_DATA_DIR", root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    manager = new DatabaseManager({ dbPath: path.join(root, "cowork.db") });
    const db = manager.getDatabase();
    service = new GatewayInfrastructure(db, {
      queueProcessInterval: 10,
      scheduledCheckInterval: 20,
      defaultRateLimit: 5,
      rateLimitWindow: 60_000,
    });
    queue = new MessageQueueStore(db);
    scheduled = new ScheduledMessageStore(db);
    delivery = new DeliveryTrackingStore(db);
    limits = new RateLimitStore(db);
  });

  afterEach(async () => {
    await service?.stop();
    manager?.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists queue defaults and structured message content through the real repository", async () => {
    const item = await service.enqueue("telegram", "chat-1", message);
    expect(item).toMatchObject({
      channelType: "telegram",
      chatId: "chat-1",
      message,
      priority: 0,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    });
    expect(queue.findById(item.id)).toMatchObject(item);
    expect(await service.getQueueStatus()).toMatchObject({ pending: 1 });
  });

  it("selects pending queue rows by priority then creation time, excluding future schedules", async () => {
    const first = await service.enqueue("telegram", "chat-1", message);
    vi.setSystemTime(Date.now() + 1);
    const priority = await service.enqueue("telegram", "chat-1", message, { priority: 5 });
    const later = await service.enqueue("telegram", "chat-1", message);
    await service.enqueue("telegram", "chat-1", message, { scheduledAt: Date.now() + 1000 });
    const sent = await service.enqueue("telegram", "chat-1", message);
    queue.update(sent.id, { status: "sent" });

    expect(queue.findPending().map((item) => item.id)).toEqual([priority.id, first.id, later.id]);
  });

  it("processes connected adapters and persists sent status, attempts and delivery receipts", async () => {
    const adapter = createAdapter();
    service.registerAdapter(adapter);
    const item = await service.enqueue("telegram", "chat-1", message);
    await service.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(adapter.sendMessage).toHaveBeenCalledWith(message);
    expect(queue.findById(item.id)).toMatchObject({ status: "sent", attempts: 1 });
    expect(await service.getDeliveryStatus("message-1")).toMatchObject({
      channelType: "telegram",
      chatId: "chat-1",
      status: "sent",
    });
    expect(await service.searchAuditLogs({ action: "message:sent" })).toHaveLength(1);
  });

  it.each(["missing", "disconnected"])(
    "leaves queued messages pending for a %s adapter",
    async (kind) => {
      const adapter = createAdapter(false);
      if (kind === "disconnected") service.registerAdapter(adapter);
      const item = await service.enqueue("telegram", "chat-1", message);
      await service.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(queue.findById(item.id)).toMatchObject({ status: "pending", attempts: 0 });
    },
  );

  it("retries failed queue deliveries and stops at the configured attempt limit", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.sendMessage).mockRejectedValue(new Error("transport unavailable"));
    service.registerAdapter(adapter);
    const item = await service.enqueue("telegram", "chat-1", message, { maxAttempts: 2 });
    await service.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.findById(item.id)).toMatchObject({ status: "pending", attempts: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.findById(item.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "transport unavailable",
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not send a future queued item before its scheduled time", async () => {
    const adapter = createAdapter();
    service.registerAdapter(adapter);
    const item = await service.enqueue("telegram", "chat-1", message, {
      scheduledAt: Date.now() + 30,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.findById(item.id)?.status).toBe("sent");
  });

  it("stops processing queued messages when the service is stopped", async () => {
    const adapter = createAdapter();
    service.registerAdapter(adapter);
    await service.start();
    await service.stop();
    await service.enqueue("telegram", "chat-1", message);
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("finds due scheduled rows and excludes future, sent and cancelled messages", async () => {
    const due = await service.schedule("telegram", "chat-1", message, Date.now() - 1);
    const later = await service.schedule(
      "telegram",
      "chat-1",
      message,
      new Date(Date.now() + 1000),
    );
    const cancelled = await service.schedule("telegram", "chat-1", message, Date.now() - 1);
    expect(await service.cancelScheduled(cancelled.id)).toBe(true);
    const sent = await service.schedule("telegram", "chat-1", message, Date.now() - 1);
    scheduled.update(sent.id, { status: "sent" });

    expect(scheduled.findDue().map((item) => item.id)).toEqual([due.id]);
    expect(
      (await service.getScheduledMessages("telegram", "chat-1")).map((item) => item.id),
    ).toEqual([due.id, later.id]);
    expect(await service.cancelScheduled(cancelled.id)).toBe(false);
    expect(await service.cancelScheduled("unknown")).toBe(false);
  });

  it("sends due scheduled messages and records their message IDs", async () => {
    const adapter = createAdapter();
    service.registerAdapter(adapter);
    const item = await service.schedule("telegram", "chat-1", message, Date.now());
    await service.start();
    await vi.advanceTimersByTimeAsync(20);

    expect(adapter.sendMessage).toHaveBeenCalledWith(message);
    expect(scheduled.findById(item.id)).toMatchObject({
      status: "sent",
      sentMessageId: "message-1",
    });
  });

  it("records scheduled delivery failures without marking them sent", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.sendMessage).mockRejectedValue(new Error("scheduled failure"));
    service.registerAdapter(adapter);
    const item = await service.schedule("telegram", "chat-1", message, Date.now());
    await service.start();
    await vi.advanceTimersByTimeAsync(20);

    expect(scheduled.findById(item.id)).toMatchObject({
      status: "failed",
      error: "scheduled failure",
    });
  });

  it("tracks sent, delivered and read timestamps with the real delivery store", async () => {
    const record = await service.trackDelivery("telegram", "chat-1", "message-1");
    vi.setSystemTime(Date.now() + 1);
    await service.updateDeliveryStatus("message-1", "delivered");
    vi.setSystemTime(Date.now() + 1);
    await service.updateDeliveryStatus("message-1", "read");

    expect(delivery.findByMessageId("message-1")).toMatchObject({
      id: record.id,
      status: "read",
      sentAt: record.sentAt,
      deliveredAt: record.sentAt! + 1,
      readAt: record.sentAt! + 2,
    });
    expect(await service.getDeliveryHistory("telegram", "chat-1")).toHaveLength(1);
  });

  it("records delivery errors and ignores unknown receipts", async () => {
    await service.trackDelivery("telegram", "chat-1", "message-1");
    await service.updateDeliveryStatus("message-1", "failed", "rejected");
    await expect(service.updateDeliveryStatus("unknown", "read")).resolves.toBeUndefined();
    expect(await service.getDeliveryStatus("message-1")).toMatchObject({
      status: "failed",
      error: "rejected",
    });
  });

  it("allows the configured number of messages and rejects the next one", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await service.recordMessage("telegram", "user-1")).toBe(true);
    }
    expect(await service.checkRateLimit("telegram", "user-1")).toBe(false);
    expect(await service.recordMessage("telegram", "user-1")).toBe(false);
    expect(await service.getRateLimitStatus("telegram", "user-1")).toMatchObject({
      isLimited: true,
      remaining: 0,
    });
  });

  it("resets an expired rate-limit window and records the first new message", async () => {
    limits.getOrCreate("telegram", "user-1");
    limits.update("telegram", "user-1", {
      messageCount: 5,
      isLimited: true,
      limitExpiresAt: Date.now() + 60_000,
    });
    vi.setSystemTime(Date.now() + 60_001);

    expect(await service.recordMessage("telegram", "user-1")).toBe(true);
    expect(limits.getOrCreate("telegram", "user-1")).toMatchObject({
      messageCount: 1,
      isLimited: false,
    });
    expect(await service.getRateLimitStatus("telegram", "user-1")).toMatchObject({ remaining: 4 });
  });

  it("honors an explicit rate limit independently of the configured default", async () => {
    expect(await service.recordMessage("telegram", "user-1", 1)).toBe(true);
    expect(await service.recordMessage("telegram", "user-1", 1)).toBe(false);
    expect(await service.checkRateLimit("telegram", "another-user", 1)).toBe(true);
  });

  it("broadcasts to every chat and reports individual transport failures", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.sendMessage)
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("third");
    service.registerAdapter(adapter);
    const result = await service.broadcast({
      channel: "telegram",
      chatIds: ["a", "b", "c"],
      message: { ...message, text: "Notice" },
      delayBetweenSends: 0,
    });

    expect(result).toEqual({
      total: 3,
      sent: 2,
      failed: 1,
      results: [
        { chatId: "a", success: true, messageId: "first" },
        { chatId: "b", success: false, error: "offline" },
        { chatId: "c", success: true, messageId: "third" },
      ],
    });
    expect(vi.mocked(adapter.sendMessage).mock.calls.map(([item]) => item.chatId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("handles an empty broadcast without sending any messages", async () => {
    const adapter = createAdapter();
    service.registerAdapter(adapter);
    expect(
      await service.broadcast({
        channel: "telegram",
        chatIds: [],
        message: { ...message, text: "Notice" },
        delayBetweenSends: 0,
      }),
    ).toEqual({ total: 0, sent: 0, failed: 0, results: [] });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects broadcasts to a disconnected channel", async () => {
    service.registerAdapter(createAdapter(false));
    await expect(
      service.broadcast({
        channel: "telegram",
        chatIds: ["a"],
        message: { ...message, text: "Notice" },
      }),
    ).rejects.toThrow("not connected");
  });

  it("persists structured audit entries and applies combined search filters", async () => {
    const entry = await service.audit("message:test", {
      channelType: "telegram",
      userId: "user-1",
      chatId: "chat-1",
      details: { retry: 2 },
      severity: "warn",
    });
    await service.audit("message:test", { channelType: "discord", severity: "warn" });
    await service.audit("different", { channelType: "telegram", severity: "info" });

    expect(entry).toMatchObject({ timestamp: Date.now(), details: { retry: 2 }, severity: "warn" });
    expect(
      await service.searchAuditLogs({
        action: "message:test",
        channelType: "telegram",
        userId: "user-1",
        severity: "warn",
      }),
    ).toEqual([entry]);
  });
});
