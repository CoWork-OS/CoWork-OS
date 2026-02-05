/**
 * Mattermost Channel Adapter
 *
 * Implements the ChannelAdapter interface for Mattermost messaging.
 * Supports both self-hosted and cloud Mattermost instances.
 *
 * Features:
 * - Real-time message receiving via WebSocket
 * - Message sending with markdown support
 * - File attachment support
 * - Message editing and deletion
 * - Reaction support
 * - Thread (reply) support
 *
 * Requirements:
 * - Mattermost server URL
 * - Personal access token
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
  MattermostConfig,
  MessageAttachment,
} from './types';
import { MattermostClient, MattermostPost, MattermostUser } from './mattermost-client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class MattermostAdapter implements ChannelAdapter {
  readonly type = 'mattermost' as const;

  private client: MattermostClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: MattermostConfig;

  // User cache
  private userCache: Map<string, MattermostUser> = new Map();

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Attachments directory
  private attachmentsDir: string;

  constructor(config: MattermostConfig) {
    this.config = {
      deduplicationEnabled: true,
      ...config,
    };

    // Set up attachments directory
    this.attachmentsDir = path.join(os.tmpdir(), 'cowork-mattermost-attachments');
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
   * Connect to Mattermost
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create Mattermost client
      this.client = new MattermostClient({
        serverUrl: this.config.serverUrl,
        token: this.config.token,
        teamId: this.config.teamId,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to Mattermost');
      }

      // Get bot user info
      const user = await this.client.getCurrentUser();
      this._botUsername = user.username;

      // Set up event handlers
      this.client.on('post', (post: MattermostPost, channelType: string) => {
        this.handleIncomingPost(post, channelType);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('Mattermost client connected');
      });

      this.client.on('disconnected', () => {
        console.log('Mattermost client disconnected');
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
      console.log(`Mattermost adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from Mattermost
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
      throw new Error('Mattermost client is not connected');
    }

    // Prepare file attachments
    const fileIds: string[] = [];
    if (message.attachments) {
      for (const attachment of message.attachments) {
        const fileId = await this.uploadAttachment(message.chatId, attachment);
        if (fileId) {
          fileIds.push(fileId);
        }
      }
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Send the message
    const post = await this.client.sendMessage(message.chatId, text, {
      rootId: message.replyTo,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
    });

    return post.id;
  }

  /**
   * Upload an attachment
   */
  private async uploadAttachment(
    channelId: string,
    attachment: MessageAttachment
  ): Promise<string | null> {
    if (!this.client) return null;

    let filePath: string;
    let fileName: string;

    if (attachment.url && fs.existsSync(attachment.url)) {
      filePath = attachment.url;
      fileName = attachment.fileName || path.basename(attachment.url);
    } else if (attachment.data) {
      fileName = attachment.fileName || `attachment_${Date.now()}`;
      filePath = path.join(this.attachmentsDir, fileName);
      fs.writeFileSync(filePath, attachment.data);
    } else {
      return null;
    }

    try {
      const result = await this.client.uploadFile(channelId, filePath, fileName);
      if (result.file_infos && result.file_infos.length > 0) {
        return result.file_infos[0].id;
      }
    } catch (error) {
      console.error('Failed to upload attachment:', error);
    }

    return null;
  }

  /**
   * Edit a message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Mattermost client is not connected');
    }

    await this.client.updateMessage(messageId, text);
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Mattermost client is not connected');
    }

    await this.client.deleteMessage(messageId);
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Mattermost client is not connected');
    }

    const fileName = path.basename(filePath);
    const result = await this.client.uploadFile(chatId, filePath, fileName);

    if (result.file_infos && result.file_infos.length > 0) {
      const fileId = result.file_infos[0].id;
      const post = await this.client.sendMessage(chatId, caption || fileName, {
        fileIds: [fileId],
      });
      return post.id;
    }

    throw new Error('Failed to upload file');
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    return this.sendDocument(chatId, filePath, caption);
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
      type: 'mattermost',
      status: this._status,
      botId: this.client?.getCurrentUserId(),
      botUsername: this._botUsername,
      botDisplayName: `Mattermost (${this._botUsername})`,
      extra: {
        serverUrl: this.config.serverUrl,
      },
    };
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Add reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Mattermost client is not connected');
    }

    // Mattermost uses emoji names without colons (e.g., "thumbsup" not ":thumbsup:")
    const emojiName = emoji.replace(/:/g, '');
    await this.client.addReaction(messageId, emojiName);
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Mattermost client is not connected');
    }

    const emojiName = emoji.replace(/:/g, '');
    await this.client.removeReaction(messageId, emojiName);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming Mattermost post
   */
  private async handleIncomingPost(
    post: MattermostPost,
    channelType: string
  ): Promise<void> {
    // Skip empty messages
    if (!post.message) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(post.id)) {
      console.log(`Skipping duplicate Mattermost message ${post.id}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(post.id);
    }

    // Get user info
    let userName = 'Unknown';
    try {
      const user = await this.getCachedUser(post.user_id);
      userName = user.username || user.first_name || 'Unknown';
    } catch (error) {
      console.error('Failed to get user info:', error);
    }

    // Convert attachments
    const attachments = this.convertAttachments(post);

    const isGroup = channelType !== 'D';

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: post.id,
      channel: 'mattermost',
      userId: post.user_id,
      userName,
      chatId: post.channel_id,
      isGroup,
      text: post.message,
      timestamp: new Date(post.create_at),
      replyTo: post.root_id || undefined,
      attachments,
      raw: post,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in Mattermost message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
      }
    }
  }

  /**
   * Convert Mattermost file attachments to MessageAttachment format
   */
  private convertAttachments(post: MattermostPost): MessageAttachment[] | undefined {
    if (!post.metadata?.files || post.metadata.files.length === 0) {
      return undefined;
    }

    return post.metadata.files.map((file) => {
      let type: MessageAttachment['type'] = 'file';

      if (file.mime_type.startsWith('image/')) {
        type = 'image';
      } else if (file.mime_type.startsWith('audio/')) {
        type = 'audio';
      } else if (file.mime_type.startsWith('video/')) {
        type = 'video';
      }

      return {
        type,
        url: this.client?.getFileUrl(file.id),
        mimeType: file.mime_type,
        fileName: file.name,
        size: file.size,
      };
    });
  }

  /**
   * Get user info with caching
   */
  private async getCachedUser(userId: string): Promise<MattermostUser> {
    const cached = this.userCache.get(userId);
    if (cached) {
      return cached;
    }

    if (!this.client) {
      throw new Error('Client not connected');
    }

    const user = await this.client.getUser(userId);
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
 * Create a Mattermost adapter from configuration
 */
export function createMattermostAdapter(config: MattermostConfig): MattermostAdapter {
  if (!config.serverUrl) {
    throw new Error('Mattermost server URL is required');
  }
  if (!config.token) {
    throw new Error('Mattermost access token is required');
  }
  return new MattermostAdapter(config);
}
