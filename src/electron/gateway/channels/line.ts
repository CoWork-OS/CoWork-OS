/**
 * LINE Channel Adapter
 *
 * Implements the ChannelAdapter interface for LINE messaging.
 * Uses webhooks for receiving and REST API for sending.
 *
 * Features:
 * - Real-time message receiving via webhooks
 * - Text, image, video, audio message support
 * - Reply and push message modes
 * - User profile fetching
 * - Group and room support
 *
 * Requirements:
 * - LINE Channel Access Token (from LINE Developers Console)
 * - LINE Channel Secret (for webhook verification)
 * - Public webhook URL (use ngrok/cloudflare tunnel for development)
 *
 * Limitations:
 * - Push messages use monthly quota (reply messages are free)
 * - No message editing support
 * - No message deletion support (can unsend own messages via API v3)
 */

import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  LineConfig,
} from "./types";
import { LineClient, LineMessage, LineUserProfile } from "./line-client";

export class LineAdapter implements ChannelAdapter {
  readonly type = "line" as const;

  private client: LineClient | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private _botId?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: LineConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Reply token cache for quick replies
  private replyTokenCache: Map<string, { token: string; expires: number }> = new Map();

  // Auto-reconnect
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_BASE_DELAY = 5000; // 5 seconds
  private shouldReconnect = true;

  // LINE message limits
  private readonly MAX_MESSAGE_LENGTH = 5000;

  constructor(config: LineConfig) {
    this.config = {
      webhookPort: 3100,
      webhookPath: "/line/webhook",
      deduplicationEnabled: true,
      useReplyTokens: true,
      ...config,
    };
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to LINE
   */
  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");
    this.shouldReconnect = true;

    try {
      // Create LINE client
      this.client = new LineClient({
        channelAccessToken: this.config.channelAccessToken,
        channelSecret: this.config.channelSecret,
        webhookPort: this.config.webhookPort!,
        webhookPath: this.config.webhookPath!,
        verbose: process.env.NODE_ENV === "development",
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || "Failed to connect to LINE");
      }

      this._botId = check.botId;

      // Get bot info
      try {
        const botInfo = await this.client.getBotInfo();
        this._botUsername = botInfo.displayName;
      } catch {
        this._botUsername = "LINE Bot";
      }

      // Set up event handlers
      this.client.on("message", (message: LineMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on("error", (error: Error) => {
        this.handleError(error, "client");
      });

      this.client.on("connected", () => {
        console.log("LINE webhook server started");
      });

      this.client.on("disconnected", () => {
        console.log("LINE webhook server stopped");
        if (this._status === "connected") {
          this.setStatus("disconnected");
          // Attempt to reconnect if not intentionally disconnected
          this.scheduleReconnect();
        }
      });

      // Start webhook server
      await this.client.startReceiving();

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus("connected");
      console.log(`LINE adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("error", err);
      throw err;
    }
  }

  /**
   * Disconnect from LINE
   */
  async disconnect(): Promise<void> {
    // Prevent auto-reconnect
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;

    // Stop dedup cleanup
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear caches
    this.processedMessages.clear();
    this.replyTokenCache.clear();

    // Stop client
    if (this.client) {
      await this.client.stopReceiving();
      this.client.clearUserCache();
      this.client = null;
    }

    this._botUsername = undefined;
    this._botId = undefined;
    this.setStatus("disconnected");
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.log(
        `LINE: Not reconnecting (shouldReconnect=${this.shouldReconnect}, attempts=${this.reconnectAttempts})`,
      );
      return;
    }

    const delay = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts);
    console.log(
      `LINE: Scheduling reconnect attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      try {
        await this.connect();
        // Reset attempts on successful connection
        this.reconnectAttempts = 0;
        console.log("LINE: Reconnected successfully");
      } catch (error) {
        console.error("LINE: Reconnect failed:", error);
        // Schedule next attempt
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Split a long message into chunks that fit LINE's message limit
   */
  private splitMessage(text: string): string[] {
    if (text.length <= this.MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= this.MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline or space
      let splitIndex = remaining.lastIndexOf("\n", this.MAX_MESSAGE_LENGTH);
      if (splitIndex === -1 || splitIndex < this.MAX_MESSAGE_LENGTH * 0.5) {
        splitIndex = remaining.lastIndexOf(" ", this.MAX_MESSAGE_LENGTH);
      }
      if (splitIndex === -1 || splitIndex < this.MAX_MESSAGE_LENGTH * 0.5) {
        splitIndex = this.MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.substring(0, splitIndex).trim());
      remaining = remaining.substring(splitIndex).trim();
    }

    return chunks;
  }

  /**
   * Send a message
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("LINE client is not connected");
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Split long messages
    const chunks = this.splitMessage(text);
    const messageIds: string[] = [];

    for (const chunk of chunks) {
      // Try to use reply token if available and enabled
      // Only use tokens with at least 10 seconds remaining (safety buffer)
      const REPLY_TOKEN_SAFETY_BUFFER = 10000; // 10 seconds
      if (this.config.useReplyTokens && message.replyTo && messageIds.length === 0) {
        const cachedToken = this.replyTokenCache.get(message.chatId);
        if (cachedToken && cachedToken.expires > Date.now() + REPLY_TOKEN_SAFETY_BUFFER) {
          try {
            await this.client.replyMessage(cachedToken.token, [{ type: "text", text: chunk }]);
            this.replyTokenCache.delete(message.chatId);
            messageIds.push(`reply-${Date.now()}`);
            continue;
          } catch {
            // Reply token expired or invalid, fall through to push
            console.log("LINE: Reply token failed, falling back to push message");
          }
        }
      }

      // Use push message (uses quota)
      await this.client.pushMessage(message.chatId, [{ type: "text", text: chunk }]);
      messageIds.push(`push-${Date.now()}`);
    }

    return messageIds.join(",");
  }

  /**
   * Edit a message (not supported by LINE)
   */
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    throw new Error("LINE does not support message editing");
  }

  /**
   * Delete a message (limited support - can only unsend own messages)
   */
  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {
    throw new Error("LINE message deletion not implemented");
  }

  /**
   * Send a document/file
   */
  async sendDocument(_chatId: string, _filePath: string, _caption?: string): Promise<string> {
    throw new Error("LINE file sending requires hosting - not implemented");
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(_chatId: string, _filePath: string, _caption?: string): Promise<string> {
    throw new Error("LINE image sending requires hosting - not implemented");
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register an error handler
   */
  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Register a status change handler
   */
  onStatusChange(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  /**
   * Get channel info
   */
  async getInfo(): Promise<ChannelInfo> {
    return {
      type: "line",
      status: this._status,
      botId: this._botId,
      botUsername: this._botUsername,
      botDisplayName: `LINE (${this._botUsername || "Not connected"})`,
      extra: {
        webhookPort: this.config.webhookPort,
        webhookPath: this.config.webhookPath,
      },
    };
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Get user profile
   */
  async getUserProfile(userId: string): Promise<LineUserProfile | null> {
    if (!this.client || this._status !== "connected") {
      return null;
    }

    try {
      return await this.client.getUserProfile(userId);
    } catch {
      return null;
    }
  }

  /**
   * Leave a group
   */
  async leaveGroup(groupId: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("LINE client is not connected");
    }
    await this.client.leaveGroup(groupId);
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("LINE client is not connected");
    }
    await this.client.leaveRoom(roomId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming LINE message
   */
  private async handleIncomingMessage(lineMessage: LineMessage): Promise<void> {
    // Skip non-text messages for now
    if (lineMessage.type !== "text" || !lineMessage.text) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(lineMessage.id)) {
      console.log(`Skipping duplicate LINE message ${lineMessage.id}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(lineMessage.id);
    }

    // Get user profile for display name
    let userName = lineMessage.source.userId || "Unknown";
    if (this.client && lineMessage.source.userId) {
      try {
        const profile = await this.client.getUserProfile(lineMessage.source.userId);
        userName = profile.displayName;
      } catch {
        // Keep default
      }
    }

    // Determine chat ID
    const chatId =
      lineMessage.source.groupId || lineMessage.source.roomId || lineMessage.source.userId || "";

    // Cache reply token for potential quick reply
    if (lineMessage.replyToken) {
      this.replyTokenCache.set(chatId, {
        token: lineMessage.replyToken,
        expires: Date.now() + 55000, // Reply tokens are valid for ~1 minute
      });
    }

    const isGroup = lineMessage.source.type !== "user";

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: lineMessage.id,
      channel: "line",
      userId: lineMessage.source.userId || "",
      userName,
      chatId,
      isGroup,
      text: lineMessage.text,
      timestamp: lineMessage.timestamp,
      raw: lineMessage,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error("Error in LINE message handler:", error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          "messageHandler",
        );
      }
    }
  }

  /**
   * Check if message was already processed
   */
  private isMessageProcessed(messageId: string): boolean {
    return this.processedMessages.has(messageId);
  }

  /**
   * Mark message as processed
   */
  private markMessageProcessed(messageId: string): void {
    this.processedMessages.set(messageId, Date.now());

    // Prevent unbounded growth
    if (this.processedMessages.size > this.DEDUP_CACHE_MAX_SIZE) {
      this.cleanupDedupCache();
    }
  }

  /**
   * Start periodic dedup cache cleanup
   */
  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      this.cleanupDedupCache();
    }, this.DEDUP_CACHE_TTL);
  }

  /**
   * Clean up old entries from dedup cache
   */
  private cleanupDedupCache(): void {
    const now = Date.now();
    for (const [messageId, timestamp] of this.processedMessages) {
      if (now - timestamp > this.DEDUP_CACHE_TTL) {
        this.processedMessages.delete(messageId);
      }
    }
  }

  /**
   * Handle errors
   */
  private handleError(error: Error, context?: string): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error, context);
      } catch (e) {
        console.error("Error in error handler:", e);
      }
    }
  }

  /**
   * Set status and notify handlers
   */
  private setStatus(status: ChannelStatus, error?: Error): void {
    this._status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status, error);
      } catch (e) {
        console.error("Error in status handler:", e);
      }
    }
  }
}

/**
 * Create a LINE adapter from configuration
 */
export function createLineAdapter(config: LineConfig): LineAdapter {
  if (!config.channelAccessToken) {
    throw new Error("LINE channel access token is required");
  }
  if (!config.channelSecret) {
    throw new Error("LINE channel secret is required");
  }
  return new LineAdapter(config);
}
