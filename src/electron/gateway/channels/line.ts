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
  ChannelConfig,
} from './types';
import { LineClient, LineMessage, LineUserProfile } from './line-client';

/**
 * LINE-specific configuration
 */
export interface LineConfig extends ChannelConfig {
  /** LINE Channel Access Token (long-lived) */
  channelAccessToken: string;
  /** LINE Channel Secret (for webhook signature verification) */
  channelSecret: string;
  /** Webhook port to listen on (default: 3100) */
  webhookPort?: number;
  /** Webhook path (default: /line/webhook) */
  webhookPath?: string;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Whether to use reply tokens (faster) or push messages */
  useReplyTokens?: boolean;
}

export class LineAdapter implements ChannelAdapter {
  readonly type = 'line' as const;

  private client: LineClient | null = null;
  private _status: ChannelStatus = 'disconnected';
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

  constructor(config: LineConfig) {
    this.config = {
      webhookPort: 3100,
      webhookPath: '/line/webhook',
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
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create LINE client
      this.client = new LineClient({
        channelAccessToken: this.config.channelAccessToken,
        channelSecret: this.config.channelSecret,
        webhookPort: this.config.webhookPort!,
        webhookPath: this.config.webhookPath!,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to LINE');
      }

      this._botId = check.botId;

      // Get bot info
      try {
        const botInfo = await this.client.getBotInfo();
        this._botUsername = botInfo.displayName;
      } catch {
        this._botUsername = 'LINE Bot';
      }

      // Set up event handlers
      this.client.on('message', (message: LineMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('LINE webhook server started');
      });

      this.client.on('disconnected', () => {
        console.log('LINE webhook server stopped');
        if (this._status === 'connected') {
          this.setStatus('disconnected');
        }
      });

      // Start webhook server
      await this.client.startReceiving();

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus('connected');
      console.log(`LINE adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from LINE
   */
  async disconnect(): Promise<void> {
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
    this.setStatus('disconnected');
  }

  /**
   * Send a message
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('LINE client is not connected');
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Try to use reply token if available and enabled
    if (this.config.useReplyTokens && message.replyTo) {
      const cachedToken = this.replyTokenCache.get(message.chatId);
      if (cachedToken && cachedToken.expires > Date.now()) {
        try {
          await this.client.replyMessage(cachedToken.token, [{ type: 'text', text }]);
          this.replyTokenCache.delete(message.chatId);
          return `reply-${Date.now()}`;
        } catch {
          // Reply token expired or invalid, fall through to push
        }
      }
    }

    // Use push message (uses quota)
    await this.client.pushMessage(message.chatId, [{ type: 'text', text }]);
    return `push-${Date.now()}`;
  }

  /**
   * Edit a message (not supported by LINE)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    throw new Error('LINE does not support message editing');
  }

  /**
   * Delete a message (limited support - can only unsend own messages)
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    throw new Error('LINE message deletion not implemented');
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('LINE file sending requires hosting - not implemented');
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('LINE image sending requires hosting - not implemented');
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
      type: 'line',
      status: this._status,
      botId: this._botId,
      botUsername: this._botUsername,
      botDisplayName: `LINE (${this._botUsername || 'Not connected'})`,
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
    if (!this.client || this._status !== 'connected') {
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
    if (!this.client || this._status !== 'connected') {
      throw new Error('LINE client is not connected');
    }
    await this.client.leaveGroup(groupId);
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('LINE client is not connected');
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
    if (lineMessage.type !== 'text' || !lineMessage.text) {
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
    let userName = lineMessage.source.userId || 'Unknown';
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
      lineMessage.source.groupId || lineMessage.source.roomId || lineMessage.source.userId || '';

    // Cache reply token for potential quick reply
    if (lineMessage.replyToken) {
      this.replyTokenCache.set(chatId, {
        token: lineMessage.replyToken,
        expires: Date.now() + 55000, // Reply tokens are valid for ~1 minute
      });
    }

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: lineMessage.id,
      channel: 'line',
      userId: lineMessage.source.userId || '',
      userName,
      chatId,
      text: lineMessage.text,
      timestamp: lineMessage.timestamp,
      raw: lineMessage,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in LINE message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
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
        console.error('Error in error handler:', e);
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
        console.error('Error in status handler:', e);
      }
    }
  }
}

/**
 * Create a LINE adapter from configuration
 */
export function createLineAdapter(config: LineConfig): LineAdapter {
  if (!config.channelAccessToken) {
    throw new Error('LINE channel access token is required');
  }
  if (!config.channelSecret) {
    throw new Error('LINE channel secret is required');
  }
  return new LineAdapter(config);
}
