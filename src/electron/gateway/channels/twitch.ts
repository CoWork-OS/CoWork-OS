/**
 * Twitch Channel Adapter
 *
 * Implements the ChannelAdapter interface for Twitch chat messaging.
 * Uses IRC over WebSocket for real-time communication.
 *
 * Features:
 * - Real-time chat message receiving
 * - Message sending with rate limiting
 * - Reply/thread support
 * - User badge and role detection
 * - Emote support
 * - Multi-channel support
 *
 * Requirements:
 * - Twitch username
 * - OAuth token (with chat:read and chat:edit scopes)
 * - Channel name(s) to join
 *
 * Limitations:
 * - No file attachments (Twitch chat doesn't support them)
 * - Rate limited to 20 messages per 30 seconds
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
  TwitchConfig,
} from './types';
import { TwitchClient, TwitchMessage } from './twitch-client';

export class TwitchAdapter implements ChannelAdapter {
  readonly type = 'twitch' as const;

  private client: TwitchClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: TwitchConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: TwitchConfig) {
    this.config = {
      deduplicationEnabled: true,
      allowWhispers: false,
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
   * Connect to Twitch
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create Twitch client
      this.client = new TwitchClient({
        username: this.config.username,
        oauthToken: this.config.oauthToken,
        channels: this.config.channels,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to Twitch');
      }

      this._botUsername = check.username;

      // Set up event handlers
      this.client.on('message', (message: TwitchMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on('whisper', (message: TwitchMessage) => {
        if (this.config.allowWhispers) {
          this.handleIncomingMessage(message);
        }
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('Twitch client connected');
      });

      this.client.on('disconnected', () => {
        console.log('Twitch client disconnected');
        if (this._status === 'connected') {
          this.setStatus('disconnected');
        }
      });

      this.client.on('join', (channel: string) => {
        console.log(`Joined Twitch channel: ${channel}`);
      });

      // Start receiving messages
      await this.client.startReceiving();

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus('connected');
      console.log(`Twitch adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from Twitch
   */
  async disconnect(): Promise<void> {
    // Stop dedup cleanup
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear caches
    this.processedMessages.clear();

    // Stop client
    if (this.client) {
      await this.client.stopReceiving();
      this.client = null;
    }

    this._botUsername = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Send a message
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Twitch client is not connected');
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Twitch has a 500 character limit per message
    // Split long messages
    const chunks = this.splitMessage(text, 450); // Leave room for prefix/reply

    let lastMessageId = '';
    for (const chunk of chunks) {
      await this.client.sendMessage(message.chatId, chunk, message.replyTo);
      // Generate a pseudo message ID since Twitch IRC doesn't return one
      lastMessageId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    }

    return lastMessageId;
  }

  /**
   * Split long message into chunks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (space, newline)
      let breakPoint = remaining.lastIndexOf(' ', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }

  /**
   * Edit a message (not supported by Twitch)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    throw new Error('Twitch does not support message editing');
  }

  /**
   * Delete a message (would require moderator commands)
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    // Could implement /delete command for moderators
    console.warn('Twitch message deletion requires moderator privileges');
    throw new Error('Twitch message deletion not implemented');
  }

  /**
   * Send a document/file (not supported by Twitch)
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('Twitch does not support file attachments');
  }

  /**
   * Send a photo/image (not supported by Twitch)
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('Twitch does not support image attachments');
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
      type: 'twitch',
      status: this._status,
      botId: this.config.username,
      botUsername: this._botUsername,
      botDisplayName: `Twitch (${this._botUsername})`,
      extra: {
        channels: this.config.channels,
        joinedChannels: this.client?.getJoinedChannels() || [],
      },
    };
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Join a channel
   */
  joinChannel(channel: string): void {
    if (this.client && this._status === 'connected') {
      this.client.joinChannel(channel);
    }
  }

  /**
   * Leave a channel
   */
  leaveChannel(channel: string): void {
    if (this.client && this._status === 'connected') {
      this.client.leaveChannel(channel);
    }
  }

  /**
   * Send a whisper (DM)
   */
  async sendWhisper(username: string, message: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Twitch client is not connected');
    }

    await this.client.sendWhisper(username, message);
  }

  /**
   * Get joined channels
   */
  getJoinedChannels(): string[] {
    return this.client?.getJoinedChannels() || [];
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming Twitch message
   */
  private async handleIncomingMessage(twitchMessage: TwitchMessage): Promise<void> {
    // Skip empty messages
    if (!twitchMessage.message) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(twitchMessage.id)) {
      console.log(`Skipping duplicate Twitch message ${twitchMessage.id}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(twitchMessage.id);
    }

    // Convert to IncomingMessage
    // For Twitch, chatId is the channel name (without #)
    const isGroup = !twitchMessage.isWhisper;
    const message: IncomingMessage = {
      messageId: twitchMessage.id,
      channel: 'twitch',
      userId: twitchMessage.userId,
      userName: twitchMessage.displayName || twitchMessage.username,
      chatId: twitchMessage.channel || twitchMessage.username, // Use username for whispers
      isGroup,
      text: twitchMessage.message,
      timestamp: twitchMessage.timestamp,
      replyTo: twitchMessage.replyTo?.messageId,
      raw: twitchMessage,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in Twitch message handler:', error);
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
 * Create a Twitch adapter from configuration
 */
export function createTwitchAdapter(config: TwitchConfig): TwitchAdapter {
  if (!config.username) {
    throw new Error('Twitch username is required');
  }
  if (!config.oauthToken) {
    throw new Error('Twitch OAuth token is required');
  }
  if (!config.channels || config.channels.length === 0) {
    throw new Error('At least one Twitch channel is required');
  }
  return new TwitchAdapter(config);
}
