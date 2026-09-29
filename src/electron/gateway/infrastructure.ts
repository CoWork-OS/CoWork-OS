/**
 * Gateway Infrastructure Service
 *
 * Provides cross-cutting infrastructure features for the channel gateway:
 * - Message queue with persistence and retry
 * - Scheduled messages
 * - Delivery tracking
 * - Rate limiting
 * - Audit logging
 * - Broadcast messaging
 */

import {
  AuditLogRepository,
  DeliveryTrackingRepository,
  MessageQueueRepository,
  RateLimitRepository,
  ScheduledMessageRepository,
} from "../database/repository-facades";
import type Database from "better-sqlite3";
import {
  QueuedMessage,
  ScheduledMessage as ScheduledMessageRecord,
  DeliveryRecord,
  AuditLogEntry,
} from "../database/repositories";
import {
  ChannelAdapter,
  OutgoingMessage,
  ChannelType,
  BroadcastConfig,
  BroadcastResult,
} from "./channels/types";

/**
 * Infrastructure service configuration
 */
export interface InfrastructureConfig {
  /** Message queue processing interval in ms (default: 1000) */
  queueProcessInterval?: number;
  /** Scheduled message check interval in ms (default: 5000) */
  scheduledCheckInterval?: number;
  /** Rate limit window in ms (default: 60000 = 1 minute) */
  rateLimitWindow?: number;
  /** Default messages per minute limit (default: 30) */
  defaultRateLimit?: number;
  /** Audit log retention in ms (default: 30 days) */
  auditLogRetention?: number;
  /** Delivery tracking retention in ms (default: 7 days) */
  deliveryTrackingRetention?: number;
  /** Message queue retention in ms (default: 24 hours) */
  messageQueueRetention?: number;
}

/**
 * Gateway Infrastructure Service
 */
export class GatewayInfrastructure {
  private queueRepo: MessageQueueRepository;
  private scheduledRepo: ScheduledMessageRepository;
  private deliveryRepo: DeliveryTrackingRepository;
  private rateLimitRepo: RateLimitRepository;
  private auditRepo: AuditLogRepository;

  private adapters: Map<ChannelType, ChannelAdapter> = new Map();
  private config: Required<InfrastructureConfig>;

  private queueInterval: ReturnType<typeof setInterval> | null = null;
  private scheduledInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor(db: Database.Database, config: InfrastructureConfig = {}) {
    this.queueRepo = new MessageQueueRepository(db);
    this.scheduledRepo = new ScheduledMessageRepository(db);
    this.deliveryRepo = new DeliveryTrackingRepository(db);
    this.rateLimitRepo = new RateLimitRepository(db);
    this.auditRepo = new AuditLogRepository(db);

    this.config = {
      queueProcessInterval: config.queueProcessInterval ?? 1000,
      scheduledCheckInterval: config.scheduledCheckInterval ?? 5000,
      rateLimitWindow: config.rateLimitWindow ?? 60000,
      defaultRateLimit: config.defaultRateLimit ?? 30,
      auditLogRetention: config.auditLogRetention ?? 30 * 24 * 60 * 60 * 1000, // 30 days
      deliveryTrackingRetention: config.deliveryTrackingRetention ?? 7 * 24 * 60 * 60 * 1000, // 7 days
      messageQueueRetention: config.messageQueueRetention ?? 24 * 60 * 60 * 1000, // 24 hours
    };
  }

  /**
   * Register a channel adapter for message sending
   */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Start the infrastructure services
   */
  async start(): Promise<void> {
    // Process message queue
    this.queueInterval = setInterval(() => {
      this.processQueue().catch((err) => console.error("Queue processing error:", err));
    }, this.config.queueProcessInterval);

    // Process scheduled messages
    this.scheduledInterval = setInterval(() => {
      this.processScheduled().catch((err) => console.error("Scheduled processing error:", err));
    }, this.config.scheduledCheckInterval);

    // Cleanup old records (every hour)
    this.cleanupInterval = setInterval(
      () => {
        this.cleanup().catch((err) => console.error("Cleanup error:", err));
      },
      60 * 60 * 1000,
    );

    await this.audit("infrastructure:started", { severity: "info" });
  }

  /**
   * Stop the infrastructure services
   */
  async stop(): Promise<void> {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
    if (this.scheduledInterval) {
      clearInterval(this.scheduledInterval);
      this.scheduledInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    await this.audit("infrastructure:stopped", { severity: "info" });
  }

  // ============================================================================
  // Message Queue
  // ============================================================================

  /**
   * Enqueue a message for reliable delivery
   */
  async enqueue(
    channelType: ChannelType,
    chatId: string,
    message: OutgoingMessage,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: number } = {},
  ): Promise<QueuedMessage> {
    const item = await this.queueRepo.enqueue({
      channelType,
      chatId,
      message: message as unknown as Record<string, unknown>,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      scheduledAt: options.scheduledAt,
    });

    await this.audit("message:queued", {
      channelType,
      chatId,
      details: { queueId: item.id, priority: item.priority },
      severity: "debug",
    });

    return item;
  }

  /**
   * Process pending messages in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pending = await this.queueRepo.findPending(10);

      for (const item of pending) {
        const adapter = this.adapters.get(item.channelType as ChannelType);
        if (!adapter || adapter.status !== "connected") {
          continue;
        }

        // Mark as processing
        await this.queueRepo.update(item.id, {
          status: "processing",
          attempts: item.attempts + 1,
          lastAttemptAt: Date.now(),
        });

        try {
          const message = item.message as unknown as OutgoingMessage;
          const messageId = await adapter.sendMessage(message);

          // Mark as sent
          await this.queueRepo.update(item.id, { status: "sent" });

          // Track delivery
          await this.trackDelivery(item.channelType as ChannelType, item.chatId, messageId);

          await this.audit("message:sent", {
            channelType: item.channelType,
            chatId: item.chatId,
            details: { queueId: item.id, messageId },
            severity: "debug",
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (item.attempts + 1 >= item.maxAttempts) {
            // Mark as failed
            await this.queueRepo.update(item.id, {
              status: "failed",
              error: errorMessage,
            });

            await this.audit("message:failed", {
              channelType: item.channelType,
              chatId: item.chatId,
              details: { queueId: item.id, error: errorMessage, attempts: item.attempts + 1 },
              severity: "error",
            });
          } else {
            // Reset to pending for retry
            await this.queueRepo.update(item.id, {
              status: "pending",
              error: errorMessage,
            });
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(): Promise<{
    pending: number;
    processing: number;
    sent: number;
    failed: number;
  }> {
    const pending = await this.queueRepo.findPending(1000);
    // This is a simplified status - in production you'd have separate count queries
    return {
      pending: pending.length,
      processing: 0, // Would need separate query
      sent: 0, // Would need separate query
      failed: 0, // Would need separate query
    };
  }

  // ============================================================================
  // Scheduled Messages
  // ============================================================================

  /**
   * Schedule a message for future delivery
   */
  async schedule(
    channelType: ChannelType,
    chatId: string,
    message: OutgoingMessage,
    scheduledAt: Date | number,
  ): Promise<ScheduledMessageRecord> {
    const timestamp = scheduledAt instanceof Date ? scheduledAt.getTime() : scheduledAt;

    const item = await this.scheduledRepo.create({
      channelType,
      chatId,
      message: message as unknown as Record<string, unknown>,
      scheduledAt: timestamp,
    });

    await this.audit("message:scheduled", {
      channelType,
      chatId,
      details: { scheduleId: item.id, scheduledAt: new Date(timestamp).toISOString() },
      severity: "info",
    });

    return item;
  }

  /**
   * Cancel a scheduled message
   */
  async cancelScheduled(id: string): Promise<boolean> {
    const item = await this.scheduledRepo.findById(id);
    if (!item || item.status !== "pending") {
      return false;
    }

    await this.scheduledRepo.cancel(id);

    await this.audit("message:schedule_cancelled", {
      channelType: item.channelType,
      chatId: item.chatId,
      details: { scheduleId: id },
      severity: "info",
    });

    return true;
  }

  /**
   * Get scheduled messages for a chat
   */
  async getScheduledMessages(
    channelType: ChannelType,
    chatId: string,
  ): Promise<ScheduledMessageRecord[]> {
    return this.scheduledRepo.findByChatId(channelType, chatId);
  }

  /**
   * Process due scheduled messages
   */
  private async processScheduled(): Promise<void> {
    const due = await this.scheduledRepo.findDue(10);

    for (const item of due) {
      const adapter = this.adapters.get(item.channelType as ChannelType);
      if (!adapter || adapter.status !== "connected") {
        continue;
      }

      try {
        const message = item.message as unknown as OutgoingMessage;
        const messageId = await adapter.sendMessage(message);

        await this.scheduledRepo.update(item.id, {
          status: "sent",
          sentMessageId: messageId,
        });

        await this.audit("message:scheduled_sent", {
          channelType: item.channelType,
          chatId: item.chatId,
          details: { scheduleId: item.id, messageId },
          severity: "info",
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        await this.scheduledRepo.update(item.id, {
          status: "failed",
          error: errorMessage,
        });

        await this.audit("message:scheduled_failed", {
          channelType: item.channelType,
          chatId: item.chatId,
          details: { scheduleId: item.id, error: errorMessage },
          severity: "error",
        });
      }
    }
  }

  // ============================================================================
  // Delivery Tracking
  // ============================================================================

  /**
   * Track a message delivery
   */
  async trackDelivery(
    channelType: ChannelType,
    chatId: string,
    messageId: string,
  ): Promise<DeliveryRecord> {
    return this.deliveryRepo.create({
      channelType,
      chatId,
      messageId,
      status: "sent",
      sentAt: Date.now(),
    });
  }

  /**
   * Update delivery status
   */
  async updateDeliveryStatus(
    messageId: string,
    status: "delivered" | "read" | "failed",
    error?: string,
  ): Promise<void> {
    const record = await this.deliveryRepo.findByMessageId(messageId);
    if (!record) return;

    const updates: Partial<DeliveryRecord> = { status };

    if (status === "delivered") {
      updates.deliveredAt = Date.now();
    } else if (status === "read") {
      updates.readAt = Date.now();
    } else if (status === "failed") {
      updates.error = error;
    }

    await this.deliveryRepo.update(record.id, updates);
  }

  /**
   * Get delivery status for a message
   */
  async getDeliveryStatus(messageId: string): Promise<DeliveryRecord | undefined> {
    return this.deliveryRepo.findByMessageId(messageId);
  }

  /**
   * Get delivery history for a chat
   */
  async getDeliveryHistory(
    channelType: ChannelType,
    chatId: string,
    limit = 50,
  ): Promise<DeliveryRecord[]> {
    return this.deliveryRepo.findByChatId(channelType, chatId, limit);
  }

  // ============================================================================
  // Rate Limiting
  // ============================================================================

  /**
   * Check if a user is rate limited
   * Returns true if the user CAN send (not limited), false if limited
   */
  async checkRateLimit(channelType: ChannelType, userId: string, limit?: number): Promise<boolean> {
    const effectiveLimit = limit ?? this.config.defaultRateLimit;
    const record = await this.rateLimitRepo.getOrCreate(channelType, userId);
    const now = Date.now();

    // Check if limit has expired
    if (record.isLimited && record.limitExpiresAt && now >= record.limitExpiresAt) {
      await this.rateLimitRepo.resetWindow(channelType, userId);
      return true;
    }

    // If already limited, deny
    if (record.isLimited) {
      return false;
    }

    // Check if window has expired
    if (now - record.windowStart >= this.config.rateLimitWindow) {
      await this.rateLimitRepo.resetWindow(channelType, userId);
      return true;
    }

    // Check message count
    return record.messageCount < effectiveLimit;
  }

  /**
   * Record a message for rate limiting
   * Returns true if message is allowed, false if rate limited
   */
  async recordMessage(channelType: ChannelType, userId: string, limit?: number): Promise<boolean> {
    const effectiveLimit = limit ?? this.config.defaultRateLimit;
    const record = await this.rateLimitRepo.getOrCreate(channelType, userId);
    const now = Date.now();

    // Check if window has expired
    if (now - record.windowStart >= this.config.rateLimitWindow) {
      await this.rateLimitRepo.resetWindow(channelType, userId);
      await this.rateLimitRepo.update(channelType, userId, { messageCount: 1 });
      return true;
    }

    // Check if limit has expired
    if (record.isLimited && record.limitExpiresAt && now >= record.limitExpiresAt) {
      await this.rateLimitRepo.resetWindow(channelType, userId);
      await this.rateLimitRepo.update(channelType, userId, { messageCount: 1 });
      return true;
    }

    // If already limited, deny
    if (record.isLimited) {
      await this.audit("rate_limit:blocked", {
        channelType,
        userId,
        details: { messageCount: record.messageCount },
        severity: "warn",
      });
      return false;
    }

    // Increment count
    const newCount = record.messageCount + 1;
    await this.rateLimitRepo.update(channelType, userId, { messageCount: newCount });

    // Check if now over limit
    if (newCount >= effectiveLimit) {
      const limitExpiresAt = record.windowStart + this.config.rateLimitWindow;
      await this.rateLimitRepo.update(channelType, userId, {
        isLimited: true,
        limitExpiresAt,
      });

      await this.audit("rate_limit:applied", {
        channelType,
        userId,
        details: { messageCount: newCount, expiresAt: new Date(limitExpiresAt).toISOString() },
        severity: "warn",
      });

      return false;
    }

    return true;
  }

  /**
   * Get rate limit status for a user
   */
  async getRateLimitStatus(
    channelType: ChannelType,
    userId: string,
  ): Promise<{ isLimited: boolean; remaining: number; resetsAt?: Date }> {
    const record = await this.rateLimitRepo.getOrCreate(channelType, userId);
    const now = Date.now();

    // Check if window has expired
    if (now - record.windowStart >= this.config.rateLimitWindow) {
      return {
        isLimited: false,
        remaining: this.config.defaultRateLimit,
        resetsAt: new Date(now + this.config.rateLimitWindow),
      };
    }

    return {
      isLimited: record.isLimited,
      remaining: Math.max(0, this.config.defaultRateLimit - record.messageCount),
      resetsAt: new Date(record.windowStart + this.config.rateLimitWindow),
    };
  }

  // ============================================================================
  // Broadcast
  // ============================================================================

  /**
   * Broadcast a message to multiple chats
   */
  async broadcast(config: BroadcastConfig): Promise<BroadcastResult> {
    const adapter = this.adapters.get(config.channel);
    if (!adapter || adapter.status !== "connected") {
      throw new Error(`Channel ${config.channel} is not connected`);
    }

    const results: BroadcastResult["results"] = [];
    const delay = config.delayBetweenSends ?? 100;

    await this.audit("broadcast:started", {
      channelType: config.channel,
      details: { chatCount: config.chatIds.length },
      severity: "info",
    });

    for (const chatId of config.chatIds) {
      try {
        const messageId = await adapter.sendMessage({
          ...config.message,
          chatId,
        });
        results.push({ chatId, success: true, messageId });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({ chatId, success: false, error: errorMessage });
      }

      // Delay between sends to avoid rate limiting
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const sent = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    await this.audit("broadcast:completed", {
      channelType: config.channel,
      details: { total: config.chatIds.length, sent, failed },
      severity: failed > 0 ? "warn" : "info",
    });

    return {
      total: config.chatIds.length,
      sent,
      failed,
      results,
    };
  }

  // ============================================================================
  // Audit Logging
  // ============================================================================

  /**
   * Log an audit entry
   */
  async audit(
    action: string,
    options: {
      channelType?: ChannelType | string;
      userId?: string;
      chatId?: string;
      details?: Record<string, unknown>;
      severity?: AuditLogEntry["severity"];
    } = {},
  ): Promise<AuditLogEntry> {
    return this.auditRepo.log({
      action,
      channelType: options.channelType,
      userId: options.userId,
      chatId: options.chatId,
      details: options.details,
      severity: options.severity ?? "info",
    });
  }

  /**
   * Search audit logs
   */
  async searchAuditLogs(options: {
    action?: string;
    channelType?: string;
    userId?: string;
    chatId?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    severity?: AuditLogEntry["severity"];
    limit?: number;
    offset?: number;
  }): Promise<AuditLogEntry[]> {
    return this.auditRepo.find(options);
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clean up old records
   */
  private async cleanup(): Promise<void> {
    const queueDeleted = await this.queueRepo.deleteOld(this.config.messageQueueRetention);
    const deliveryDeleted = await this.deliveryRepo.deleteOld(
      this.config.deliveryTrackingRetention,
    );
    const auditDeleted = await this.auditRepo.deleteOld(this.config.auditLogRetention);

    if (queueDeleted > 0 || deliveryDeleted > 0 || auditDeleted > 0) {
      console.log(
        `Cleanup: queue=${queueDeleted}, delivery=${deliveryDeleted}, audit=${auditDeleted}`,
      );
    }
  }
}
