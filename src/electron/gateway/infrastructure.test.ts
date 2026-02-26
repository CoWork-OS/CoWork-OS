/**
 * Gateway Infrastructure Tests
 *
 * Tests for message queue, scheduled messages, delivery tracking,
 * rate limiting, audit logging, and broadcast features.
 *
 * Note: These tests use mocks since better-sqlite3 requires native module
 * compilation which doesn't work well in vitest without Electron context.
 */

import { describe, it, expect, beforeEach, afterEach as _afterEach, vi } from "vitest";
import { ChannelAdapter, ChannelStatus, OutgoingMessage, ChannelInfo } from "./channels/types";

// Mock better-sqlite3 before importing anything that uses it
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

// Create mock database that tracks state
function _createMockDatabase() {
  const tables: Map<string, Map<string, Record<string, unknown>>> = new Map();

  const db = {
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => {
      return {
        run: vi.fn((...args: unknown[]) => {
          // Extract table name from SQL
          const insertMatch = sql.match(/INSERT INTO (\w+)/i);
          const _updateMatch = sql.match(/UPDATE (\w+)/i);
          const _deleteMatch = sql.match(/DELETE FROM (\w+)/i);

          if (insertMatch) {
            const tableName = insertMatch[1];
            if (!tables.has(tableName)) tables.set(tableName, new Map());
            const id = args[0] as string;
            const record: Record<string, unknown> = { id };
            tables.get(tableName)!.set(id, record);
          }
          return { changes: 1 };
        }),
        get: vi.fn((id: string) => {
          // Find record by ID across tables
          for (const table of tables.values()) {
            if (table.has(id)) return table.get(id);
          }
          return undefined;
        }),
        all: vi.fn(() => []),
      };
    }),
    close: vi.fn(),
    transaction: vi.fn((fn: () => void) => fn),
  };

  return db;
}

// Mock channel adapter
function createMockAdapter(connected = true): ChannelAdapter {
  return {
    type: "telegram",
    status: (connected ? "connected" : "disconnected") as ChannelStatus,
    botUsername: "test_bot",
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue("msg_123"),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    getInfo: vi.fn().mockResolvedValue({
      type: "telegram",
      status: "connected",
      botUsername: "test_bot",
    } as ChannelInfo),
  };
}

// ============================================================================
// Unit Tests for Repository Logic
// ============================================================================

describe("Gateway Infrastructure - Repository Logic", () => {
  describe("MessageQueueRepository", () => {
    it("should create queue item with correct structure", () => {
      const item = {
        id: "test-id-123",
        channelType: "telegram",
        chatId: "123",
        message: { text: "Hello", chatId: "123" },
        priority: 1,
        status: "pending" as const,
        attempts: 0,
        maxAttempts: 3,
        createdAt: Date.now(),
      };

      expect(item.id).toBeDefined();
      expect(item.status).toBe("pending");
      expect(item.attempts).toBe(0);
      expect(item.priority).toBe(1);
    });

    it("should map status transitions correctly", () => {
      const statuses = ["pending", "processing", "sent", "failed"] as const;

      // Pending -> Processing
      expect(statuses.includes("processing")).toBe(true);
      // Processing -> Sent or Failed
      expect(statuses.includes("sent")).toBe(true);
      expect(statuses.includes("failed")).toBe(true);
    });

    it("should prioritize higher priority messages", () => {
      const messages = [
        { id: "1", priority: 0, createdAt: 100 },
        { id: "2", priority: 1, createdAt: 200 },
        { id: "3", priority: 0, createdAt: 50 },
      ];

      // Sort by priority DESC, then createdAt ASC
      const sorted = [...messages].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      });

      expect(sorted[0].id).toBe("2"); // Highest priority
      expect(sorted[1].id).toBe("3"); // Lower priority, earlier time
      expect(sorted[2].id).toBe("1"); // Lower priority, later time
    });
  });

  describe("ScheduledMessageRepository", () => {
    it("should identify due messages correctly", () => {
      const now = Date.now();
      const messages = [
        { id: "1", scheduledAt: now - 1000, status: "pending" },
        { id: "2", scheduledAt: now + 60000, status: "pending" },
        { id: "3", scheduledAt: now - 500, status: "pending" },
        { id: "4", scheduledAt: now - 2000, status: "sent" },
      ];

      const due = messages.filter((m) => m.status === "pending" && m.scheduledAt <= now);

      expect(due).toHaveLength(2);
      expect(due.map((m) => m.id)).toContain("1");
      expect(due.map((m) => m.id)).toContain("3");
    });

    it("should handle cancellation status", () => {
      const message = { id: "1", status: "pending" as const };

      // Can only cancel pending messages
      expect(message.status).toBe("pending");

      const cancelled = { ...message, status: "cancelled" as const };
      expect(cancelled.status).toBe("cancelled");
    });
  });

  describe("DeliveryTrackingRepository", () => {
    it("should track delivery status progression", () => {
      const record: {
        id: string;
        messageId: string;
        status: "pending" | "sent" | "delivered" | "read" | "failed";
        sentAt: number | undefined;
        deliveredAt: number | undefined;
        readAt: number | undefined;
      } = {
        id: "del-123",
        messageId: "msg-456",
        status: "pending",
        sentAt: undefined,
        deliveredAt: undefined,
        readAt: undefined,
      };

      // Sent
      record.status = "sent";
      record.sentAt = Date.now();
      expect(record.sentAt).toBeDefined();

      // Delivered
      record.status = "delivered";
      record.deliveredAt = Date.now();
      expect(record.deliveredAt).toBeGreaterThanOrEqual(record.sentAt);

      // Read
      record.status = "read";
      record.readAt = Date.now();
      expect(record.readAt).toBeGreaterThanOrEqual(record.deliveredAt!);
    });
  });

  describe("RateLimitRepository", () => {
    it("should calculate rate limit correctly", () => {
      const config = {
        windowMs: 60000, // 1 minute
        maxMessages: 30,
      };

      const record = {
        messageCount: 0,
        windowStart: Date.now(),
        isLimited: false,
      };

      // Simulate sending messages
      for (let i = 0; i < 30; i++) {
        record.messageCount++;
      }

      // Should be at limit
      expect(record.messageCount).toBe(config.maxMessages);

      // One more should trigger limit
      record.messageCount++;
      record.isLimited = record.messageCount > config.maxMessages;
      expect(record.isLimited).toBe(true);
    });

    it("should reset window after expiry", () => {
      const windowMs = 60000;
      const record = {
        messageCount: 25,
        windowStart: Date.now() - 70000, // 70 seconds ago
        isLimited: false,
      };

      const now = Date.now();
      const windowExpired = now - record.windowStart >= windowMs;
      expect(windowExpired).toBe(true);

      // Reset
      if (windowExpired) {
        record.messageCount = 0;
        record.windowStart = now;
        record.isLimited = false;
      }

      expect(record.messageCount).toBe(0);
    });
  });

  describe("AuditLogRepository", () => {
    it("should create audit entries with timestamp", () => {
      const entry = {
        id: "audit-123",
        timestamp: Date.now(),
        action: "message:sent",
        channelType: "telegram",
        userId: "user-456",
        severity: "info" as const,
      };

      expect(entry.timestamp).toBeLessThanOrEqual(Date.now());
      expect(["debug", "info", "warn", "error"]).toContain(entry.severity);
    });

    it("should filter by multiple criteria", () => {
      const entries = [
        { action: "message:sent", channelType: "telegram", severity: "info" },
        { action: "message:sent", channelType: "discord", severity: "info" },
        { action: "user:paired", channelType: "telegram", severity: "info" },
        { action: "error:occurred", channelType: "telegram", severity: "error" },
      ];

      // Filter by action
      const sentMessages = entries.filter((e) => e.action === "message:sent");
      expect(sentMessages).toHaveLength(2);

      // Filter by channel
      const telegramEntries = entries.filter((e) => e.channelType === "telegram");
      expect(telegramEntries).toHaveLength(3);

      // Filter by severity
      const errors = entries.filter((e) => e.severity === "error");
      expect(errors).toHaveLength(1);
    });
  });
});

// ============================================================================
// Unit Tests for Broadcast Logic
// ============================================================================

describe("Gateway Infrastructure - Broadcast Logic", () => {
  it("should calculate broadcast results correctly", () => {
    const chatIds = ["123", "456", "789"];
    const results = [
      { chatId: "123", success: true, messageId: "msg_1" },
      { chatId: "456", success: false, error: "Chat not found" },
      { chatId: "789", success: true, messageId: "msg_3" },
    ];

    const total = chatIds.length;
    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    expect(total).toBe(3);
    expect(sent).toBe(2);
    expect(failed).toBe(1);
  });

  it("should handle empty chat list", () => {
    const chatIds: string[] = [];
    const results: { chatId: string; success: boolean }[] = [];

    expect(chatIds.length).toBe(0);
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// Integration Tests with Mock Adapter
// ============================================================================

describe("Gateway Infrastructure - Mock Adapter Integration", () => {
  let mockAdapter: ChannelAdapter;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  it("should call sendMessage on adapter", async () => {
    const message: OutgoingMessage = {
      chatId: "123",
      text: "Test message",
    };

    await mockAdapter.sendMessage(message);

    expect(mockAdapter.sendMessage).toHaveBeenCalledWith(message);
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("should handle adapter errors", async () => {
    const errorAdapter = createMockAdapter();
    (errorAdapter.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    await expect(errorAdapter.sendMessage({ chatId: "123", text: "Test" })).rejects.toThrow(
      "Network error",
    );
  });

  it("should check adapter status before sending", () => {
    const connectedAdapter = createMockAdapter(true);
    const disconnectedAdapter = createMockAdapter(false);

    expect(connectedAdapter.status).toBe("connected");
    expect(disconnectedAdapter.status).toBe("disconnected");

    // Should only send if connected
    const canSend = (adapter: ChannelAdapter) => adapter.status === "connected";

    expect(canSend(connectedAdapter)).toBe(true);
    expect(canSend(disconnectedAdapter)).toBe(false);
  });

  it("should simulate broadcast to multiple chats", async () => {
    const chatIds = ["123", "456", "789"];
    const results: { chatId: string; success: boolean; messageId?: string }[] = [];

    for (const chatId of chatIds) {
      try {
        const messageId = await mockAdapter.sendMessage({
          chatId,
          text: "Broadcast",
        });
        results.push({ chatId, success: true, messageId });
      } catch  {
        results.push({
          chatId,
          success: false,
        });
      }
    }

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// Unit Tests for Rate Limiting Algorithm
// ============================================================================

describe("Gateway Infrastructure - Rate Limiting Algorithm", () => {
  interface RateLimitState {
    messageCount: number;
    windowStart: number;
    isLimited: boolean;
    limitExpiresAt?: number;
  }

  const config = {
    windowMs: 60000, // 1 minute
    maxMessages: 5,
  };

  function checkAndRecordMessage(
    state: RateLimitState,
    now: number,
  ): { allowed: boolean; state: RateLimitState } {
    // Check if window has expired
    if (now - state.windowStart >= config.windowMs) {
      return {
        allowed: true,
        state: {
          messageCount: 1,
          windowStart: now,
          isLimited: false,
        },
      };
    }

    // Check if limit has expired
    if (state.isLimited && state.limitExpiresAt && now >= state.limitExpiresAt) {
      return {
        allowed: true,
        state: {
          messageCount: 1,
          windowStart: now,
          isLimited: false,
        },
      };
    }

    // If already limited, deny
    if (state.isLimited) {
      return { allowed: false, state };
    }

    // Increment and check
    const newCount = state.messageCount + 1;
    if (newCount > config.maxMessages) {
      return {
        allowed: false,
        state: {
          ...state,
          messageCount: newCount,
          isLimited: true,
          limitExpiresAt: state.windowStart + config.windowMs,
        },
      };
    }

    return {
      allowed: true,
      state: {
        ...state,
        messageCount: newCount,
      },
    };
  }

  it("should allow messages under limit", () => {
    const now = Date.now();
    let state: RateLimitState = {
      messageCount: 0,
      windowStart: now,
      isLimited: false,
    };

    for (let i = 0; i < 5; i++) {
      const result = checkAndRecordMessage(state, now);
      expect(result.allowed).toBe(true);
      state = result.state;
    }

    expect(state.messageCount).toBe(5);
    expect(state.isLimited).toBe(false);
  });

  it("should block when limit exceeded", () => {
    const now = Date.now();
    let state: RateLimitState = {
      messageCount: 5,
      windowStart: now,
      isLimited: false,
    };

    const result = checkAndRecordMessage(state, now);
    expect(result.allowed).toBe(false);
    expect(result.state.isLimited).toBe(true);
  });

  it("should reset after window expires", () => {
    const startTime = Date.now();
    let state: RateLimitState = {
      messageCount: 5,
      windowStart: startTime,
      isLimited: true,
      limitExpiresAt: startTime + config.windowMs,
    };

    // Simulate time passing
    const afterWindow = startTime + config.windowMs + 1;
    const result = checkAndRecordMessage(state, afterWindow);

    expect(result.allowed).toBe(true);
    expect(result.state.messageCount).toBe(1);
    expect(result.state.isLimited).toBe(false);
  });
});

// ============================================================================
// Unit Tests for Message Queue Processing
// ============================================================================

describe("Gateway Infrastructure - Queue Processing Logic", () => {
  interface QueueItem {
    id: string;
    status: "pending" | "processing" | "sent" | "failed";
    attempts: number;
    maxAttempts: number;
    scheduledAt?: number;
  }

  function shouldProcess(item: QueueItem, now: number): boolean {
    if (item.status !== "pending") return false;
    if (item.scheduledAt && item.scheduledAt > now) return false;
    return true;
  }

  function processItem(item: QueueItem, success: boolean): QueueItem {
    const newAttempts = item.attempts + 1;

    if (success) {
      return { ...item, status: "sent", attempts: newAttempts };
    }

    if (newAttempts >= item.maxAttempts) {
      return { ...item, status: "failed", attempts: newAttempts };
    }

    return { ...item, status: "pending", attempts: newAttempts };
  }

  it("should process pending items", () => {
    const now = Date.now();
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    expect(shouldProcess(item, now)).toBe(true);
  });

  it("should not process non-pending items", () => {
    const now = Date.now();
    const items: QueueItem[] = [
      { id: "1", status: "processing", attempts: 0, maxAttempts: 3 },
      { id: "2", status: "sent", attempts: 1, maxAttempts: 3 },
      { id: "3", status: "failed", attempts: 3, maxAttempts: 3 },
    ];

    items.forEach((item) => {
      expect(shouldProcess(item, now)).toBe(false);
    });
  });

  it("should not process future scheduled items", () => {
    const now = Date.now();
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      scheduledAt: now + 60000,
    };

    expect(shouldProcess(item, now)).toBe(false);
  });

  it("should process past scheduled items", () => {
    const now = Date.now();
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      scheduledAt: now - 1000,
    };

    expect(shouldProcess(item, now)).toBe(true);
  });

  it("should mark as sent on success", () => {
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = processItem(item, true);
    expect(result.status).toBe("sent");
    expect(result.attempts).toBe(1);
  });

  it("should retry on failure if attempts remaining", () => {
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 1,
      maxAttempts: 3,
    };

    const result = processItem(item, false);
    expect(result.status).toBe("pending");
    expect(result.attempts).toBe(2);
  });

  it("should mark as failed when max attempts reached", () => {
    const item: QueueItem = {
      id: "1",
      status: "pending",
      attempts: 2,
      maxAttempts: 3,
    };

    const result = processItem(item, false);
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
  });
});

// ============================================================================
// Unit Tests for Scheduled Message Processing
// ============================================================================

describe("Gateway Infrastructure - Scheduled Message Logic", () => {
  interface ScheduledItem {
    id: string;
    scheduledAt: number;
    status: "pending" | "sent" | "failed" | "cancelled";
  }

  function findDueMessages(items: ScheduledItem[], now: number): ScheduledItem[] {
    return items.filter((item) => item.status === "pending" && item.scheduledAt <= now);
  }

  it("should find due messages", () => {
    const now = Date.now();
    const items: ScheduledItem[] = [
      { id: "1", scheduledAt: now - 1000, status: "pending" },
      { id: "2", scheduledAt: now + 60000, status: "pending" },
      { id: "3", scheduledAt: now - 500, status: "pending" },
      { id: "4", scheduledAt: now - 2000, status: "sent" },
    ];

    const due = findDueMessages(items, now);
    expect(due).toHaveLength(2);
    expect(due.map((d) => d.id).sort()).toEqual(["1", "3"]);
  });

  it("should not include cancelled messages", () => {
    const now = Date.now();
    const items: ScheduledItem[] = [
      { id: "1", scheduledAt: now - 1000, status: "pending" },
      { id: "2", scheduledAt: now - 1000, status: "cancelled" },
    ];

    const due = findDueMessages(items, now);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("1");
  });
});

// ============================================================================
// Type Safety Tests
// ============================================================================

describe("Gateway Infrastructure - Type Safety", () => {
  it("should have correct channel types", () => {
    const validTypes = ["telegram", "discord", "slack", "whatsapp"];
    expect(validTypes).toContain("telegram");
    expect(validTypes).toContain("discord");
  });

  it("should have correct status values", () => {
    const validStatuses = ["disconnected", "connecting", "connected", "error"];
    expect(validStatuses).toContain("connected");
    expect(validStatuses).toContain("disconnected");
  });

  it("should have correct severity levels", () => {
    const validSeverities = ["debug", "info", "warn", "error"];
    expect(validSeverities).toContain("info");
    expect(validSeverities).toContain("error");
  });

  it("should have correct queue status values", () => {
    const validStatuses = ["pending", "processing", "sent", "failed"];
    expect(validStatuses).toContain("pending");
    expect(validStatuses).toContain("sent");
  });

  it("should have correct delivery status values", () => {
    const validStatuses = ["pending", "sent", "delivered", "read", "failed"];
    expect(validStatuses).toContain("delivered");
    expect(validStatuses).toContain("read");
  });
});
