/**
 * Matrix Channel Adapter
 *
 * Implements the ChannelAdapter interface for Matrix messaging.
 * Uses the Matrix Client-Server API for communication.
 *
 * Features:
 * - Real-time message receiving via sync
 * - Room-based messaging
 * - End-to-end encryption support (room-level)
 * - File attachment support
 * - Message reactions
 * - Typing indicators
 * - Read receipts
 *
 * Requirements:
 * - Matrix homeserver URL
 * - Access token
 * - User ID
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
  MatrixConfig,
  MessageAttachment,
} from './types';
import { MatrixClient, MatrixRoomEvent, MatrixUser } from './matrix-client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class MatrixAdapter implements ChannelAdapter {
  readonly type = 'matrix' as const;

  private client: MatrixClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: MatrixConfig;

  // User cache
  private userCache: Map<string, MatrixUser> = new Map();

  // Direct (1:1) rooms cache
  private directRooms: Set<string> | null = null;
  private directRoomsLoadedAt = 0;
  private readonly DIRECT_ROOMS_TTL_MS = 5 * 60 * 1000;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Attachments directory
  private attachmentsDir: string;

  constructor(config: MatrixConfig) {
    this.config = {
      deduplicationEnabled: true,
      sendTypingIndicators: true,
      sendReadReceipts: true,
      ...config,
    };

    // Set up attachments directory
    this.attachmentsDir = path.join(os.tmpdir(), 'cowork-matrix-attachments');
    if (!fs.existsSync(this.attachmentsDir)) {
      fs.mkdirSync(this.attachmentsDir, { recursive: true });
    }
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to Matrix
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create Matrix client
      this.client = new MatrixClient({
        homeserver: this.config.homeserver,
        userId: this.config.userId,
        accessToken: this.config.accessToken,
        deviceId: this.config.deviceId,
        roomIds: this.config.roomIds,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to Matrix');
      }

      // Get bot user profile
      const profile = await this.client.getUserProfile();
      this._botUsername = profile.displayname || this.config.userId;

      // Set up event handlers
      this.client.on('message', (event: MatrixRoomEvent) => {
        this.handleIncomingEvent(event);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('Matrix client connected');
      });

      this.client.on('disconnected', () => {
        console.log('Matrix client disconnected');
        if (this._status === 'connected') {
          this.setStatus('disconnected');
        }
      });

      // Start receiving messages
      await this.client.startReceiving();

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus('connected');
      console.log(`Matrix adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from Matrix
   */
  async disconnect(): Promise<void> {
    // Stop dedup cleanup
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear caches
    this.processedMessages.clear();
    this.userCache.clear();

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
      throw new Error('Matrix client is not connected');
    }

    // Handle attachments first
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        await this.sendAttachment(message.chatId, attachment);
      }
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Prepare formatted content for markdown
    let formattedBody: string | undefined;
    if (message.parseMode === 'markdown' || message.parseMode === 'html') {
      formattedBody = text; // Matrix supports HTML; markdown would need conversion
    }

    // Send the message
    const eventId = await this.client.sendMessage(message.chatId, text, {
      formattedBody,
      format: formattedBody ? 'org.matrix.custom.html' : undefined,
      replyTo: message.replyTo,
    });

    return eventId;
  }

  /**
   * Send an attachment
   */
  private async sendAttachment(
    roomId: string,
    attachment: MessageAttachment
  ): Promise<string | null> {
    if (!this.client) return null;

    let filePath: string;

    if (attachment.url && fs.existsSync(attachment.url)) {
      filePath = attachment.url;
    } else if (attachment.data) {
      const fileName = attachment.fileName || `attachment_${Date.now()}`;
      filePath = path.join(this.attachmentsDir, fileName);
      fs.writeFileSync(filePath, attachment.data);
    } else {
      return null;
    }

    try {
      // Upload media
      const uploadResult = await this.client.uploadMedia(filePath, attachment.mimeType);
      const mxcUrl = uploadResult.content_uri;
      const fileName = attachment.fileName || path.basename(filePath);

      // Send based on type
      if (attachment.type === 'image') {
        return await this.client.sendImage(roomId, mxcUrl, fileName, {
          mimetype: attachment.mimeType,
          size: attachment.size,
        });
      } else {
        return await this.client.sendFile(roomId, mxcUrl, fileName, {
          mimetype: attachment.mimeType,
          size: attachment.size,
        });
      }
    } catch (error) {
      console.error('Failed to send attachment:', error);
      return null;
    }
  }

  /**
   * Edit a message (Matrix uses redaction + new message)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    // Matrix doesn't have native edit - we'd need to use m.replace relation
    // For simplicity, we'll throw an error indicating this limitation
    console.warn('Matrix message editing requires m.replace relation - not fully implemented');
    throw new Error('Matrix message editing not fully supported');
  }

  /**
   * Delete a message (redact)
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    await this.client.redactMessage(chatId, messageId);
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    const uploadResult = await this.client.uploadMedia(filePath);
    const mxcUrl = uploadResult.content_uri;
    const fileName = path.basename(filePath);
    const stats = fs.statSync(filePath);

    // Send the file
    const eventId = await this.client.sendFile(chatId, mxcUrl, caption || fileName, {
      size: stats.size,
    });

    return eventId;
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    const uploadResult = await this.client.uploadMedia(filePath);
    const mxcUrl = uploadResult.content_uri;
    const fileName = path.basename(filePath);
    const stats = fs.statSync(filePath);

    // Send the image
    const eventId = await this.client.sendImage(chatId, mxcUrl, caption || fileName, {
      size: stats.size,
    });

    return eventId;
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
      type: 'matrix',
      status: this._status,
      botId: this.config.userId,
      botUsername: this._botUsername,
      botDisplayName: `Matrix (${this._botUsername})`,
      extra: {
        homeserver: this.config.homeserver,
        userId: this.config.userId,
      },
    };
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Send typing indicator
   */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.client || !this.config.sendTypingIndicators) {
      return;
    }

    try {
      await this.client.sendTyping(chatId, true);
    } catch (error) {
      // Ignore typing indicator errors
    }
  }

  /**
   * Stop typing indicator
   */
  async stopTyping(chatId: string): Promise<void> {
    if (!this.client || !this.config.sendTypingIndicators) {
      return;
    }

    try {
      await this.client.sendTyping(chatId, false);
    } catch (error) {
      // Ignore typing indicator errors
    }
  }

  /**
   * Add reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    await this.client.sendReaction(chatId, messageId, emoji);
  }

  /**
   * Send read receipt
   */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    if (!this.client || !this.config.sendReadReceipts) {
      return;
    }

    try {
      await this.client.sendReadReceipt(roomId, eventId);
    } catch (error) {
      // Ignore read receipt errors
    }
  }

  /**
   * Join a room
   */
  async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    return this.client.joinRoom(roomIdOrAlias);
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Matrix client is not connected');
    }

    await this.client.leaveRoom(roomId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming Matrix event
   */
  private async handleIncomingEvent(event: MatrixRoomEvent): Promise<void> {
    // Get message body
    const body = event.content.body;
    if (!body) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(event.event_id)) {
      console.log(`Skipping duplicate Matrix message ${event.event_id}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(event.event_id);
    }

    // Get user info
    let userName = event.sender;
    try {
      const user = await this.getCachedUser(event.sender);
      userName = user.displayname || event.sender;
    } catch (error) {
      console.error('Failed to get user info:', error);
    }

    // Convert attachments
    const attachments = this.convertAttachments(event);

    // Get reply-to
    const replyTo = event.content['m.relates_to']?.['m.in_reply_to']?.event_id;

    const directRooms = await this.getDirectRooms();
    const isGroup = directRooms ? !directRooms.has(event.room_id) : undefined;

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: event.event_id,
      channel: 'matrix',
      userId: event.sender,
      userName,
      chatId: event.room_id,
      isGroup,
      text: body,
      timestamp: new Date(event.origin_server_ts),
      replyTo,
      attachments,
      raw: event,
    };

    // Send read receipt
    if (this.config.sendReadReceipts) {
      await this.sendReadReceipt(event.room_id, event.event_id);
    }

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in Matrix message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
      }
    }
  }

  /**
   * Convert Matrix media content to MessageAttachment format
   */
  private convertAttachments(event: MatrixRoomEvent): MessageAttachment[] | undefined {
    const msgtype = event.content.msgtype;
    const url = event.content.url;

    if (!url || !msgtype) {
      return undefined;
    }

    // Only handle media message types
    if (!['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype)) {
      return undefined;
    }

    let type: MessageAttachment['type'] = 'file';
    switch (msgtype) {
      case 'm.image':
        type = 'image';
        break;
      case 'm.audio':
        type = 'audio';
        break;
      case 'm.video':
        type = 'video';
        break;
    }

    return [
      {
        type,
        url: this.client?.getMediaUrl(url),
        mimeType: event.content.info?.mimetype,
        fileName: event.content.body,
        size: event.content.info?.size,
      },
    ];
  }

  private async getDirectRooms(): Promise<Set<string> | null> {
    if (!this.client) {
      return this.directRooms;
    }

    const now = Date.now();
    if (this.directRooms && now - this.directRoomsLoadedAt < this.DIRECT_ROOMS_TTL_MS) {
      return this.directRooms;
    }

    try {
      const rooms = await this.client.getDirectRooms();
      this.directRooms = new Set(rooms);
      this.directRoomsLoadedAt = now;
      return this.directRooms;
    } catch (error) {
      console.warn('Failed to load Matrix direct rooms:', error);
      this.directRoomsLoadedAt = now;
      return null;
    }
  }

  /**
   * Get user info with caching
   */
  private async getCachedUser(userId: string): Promise<MatrixUser> {
    const cached = this.userCache.get(userId);
    if (cached) {
      return cached;
    }

    if (!this.client) {
      throw new Error('Client not connected');
    }

    const user = await this.client.getUserProfile(userId);
    this.userCache.set(userId, user);
    return user;
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
 * Create a Matrix adapter from configuration
 */
export function createMatrixAdapter(config: MatrixConfig): MatrixAdapter {
  if (!config.homeserver) {
    throw new Error('Matrix homeserver URL is required');
  }
  if (!config.userId) {
    throw new Error('Matrix user ID is required');
  }
  if (!config.accessToken) {
    throw new Error('Matrix access token is required');
  }
  return new MatrixAdapter(config);
}
