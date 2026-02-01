/**
 * Signal Channel Adapter
 *
 * Implements the ChannelAdapter interface for Signal messaging.
 * Uses signal-cli under the hood for communication.
 *
 * Features:
 * - End-to-end encrypted messaging
 * - Message deduplication
 * - Read receipts and typing indicators
 * - Group messaging support
 * - Attachment support
 * - Reaction support
 *
 * Requirements:
 * - signal-cli installed and configured
 * - Phone number registered with Signal
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
  SignalConfig,
  MessageAttachment,
  CallbackQuery,
  CallbackQueryHandler,
} from './types';
import {
  SignalClient,
  SignalMessage,
  SignalDataMessage,
  SignalAttachment,
} from './signal-client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Signal adapter configuration with defaults
 */
interface SignalAdapterConfig extends SignalConfig {
  /** Poll interval for receiving messages in ms (default: 1000) */
  pollInterval?: number;
}

export class SignalAdapter implements ChannelAdapter {
  readonly type = 'signal' as const;

  private client: SignalClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];
  private config: SignalAdapterConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Attachments directory
  private attachmentsDir: string;

  constructor(config: SignalAdapterConfig) {
    this.config = {
      deduplicationEnabled: true,
      sendReadReceipts: true,
      sendTypingIndicators: true,
      maxAttachmentMb: 100,
      pollInterval: 1000,
      trustMode: 'on-first-use',
      ...config,
    };

    // Set up attachments directory
    this.attachmentsDir = path.join(os.tmpdir(), 'cowork-signal-attachments');
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
   * Connect to Signal
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create Signal client
      this.client = new SignalClient({
        phoneNumber: this.config.phoneNumber,
        cliPath: this.config.cliPath,
        dataDir: this.config.dataDir,
        mode: this.config.mode,
        socketPath: this.config.socketPath,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check installation
      const installCheck = await this.client.checkInstallation();
      if (!installCheck.installed) {
        throw new Error(installCheck.error || 'signal-cli not installed');
      }
      console.log(`signal-cli version: ${installCheck.version}`);

      // Check registration
      const regCheck = await this.client.checkRegistration();
      if (!regCheck.registered) {
        throw new Error(regCheck.error || 'Phone number not registered');
      }

      // Set up event handlers
      this.client.on('message', (message: SignalMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('Signal client connected');
      });

      this.client.on('disconnected', () => {
        console.log('Signal client disconnected');
        if (this._status === 'connected') {
          this.setStatus('disconnected');
        }
      });

      // Start receiving messages
      await this.client.startReceiving();

      // Set bot username to phone number
      this._botUsername = this.config.phoneNumber;

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus('connected');
      console.log(`Signal adapter connected for ${this.config.phoneNumber}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from Signal
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
      throw new Error('Signal client is not connected');
    }

    // Prepare attachments
    const attachmentPaths: string[] = [];
    if (message.attachments) {
      for (const attachment of message.attachments) {
        const filePath = await this.prepareAttachment(attachment);
        if (filePath) {
          attachmentPaths.push(filePath);
        }
      }
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // Send the message
    const result = await this.client.sendMessage(message.chatId, text, {
      attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      quote: message.replyTo ? {
        timestamp: parseInt(message.replyTo, 10),
        author: message.chatId,
      } : undefined,
    });

    return result.timestamp.toString();
  }

  /**
   * Prepare an attachment for sending
   */
  private async prepareAttachment(attachment: MessageAttachment): Promise<string | null> {
    if (attachment.url && fs.existsSync(attachment.url)) {
      return attachment.url;
    }

    if (attachment.data) {
      const fileName = attachment.fileName || `attachment_${Date.now()}`;
      const filePath = path.join(this.attachmentsDir, fileName);
      fs.writeFileSync(filePath, attachment.data);
      return filePath;
    }

    return null;
  }

  /**
   * Edit a message (not supported by Signal)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    throw new Error('Signal does not support message editing');
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    // Signal supports remote delete but it's complex
    // For now, just log a warning
    console.warn('Signal message deletion not fully implemented');
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    const text = caption || path.basename(filePath);
    const result = await this.client.sendMessage(chatId, text, {
      attachments: [filePath],
    });

    return result.timestamp.toString();
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
   * Register a callback query handler (not supported by Signal)
   */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /**
   * Answer callback query (not supported by Signal)
   */
  async answerCallbackQuery(queryId: string, text?: string, showAlert?: boolean): Promise<void> {
    // Signal doesn't have inline keyboards
    console.warn('Signal does not support callback queries');
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
      type: 'signal',
      status: this._status,
      botId: this.config.phoneNumber,
      botUsername: this.config.phoneNumber,
      botDisplayName: `Signal (${this.config.phoneNumber})`,
      extra: {
        mode: this.config.mode,
        trustMode: this.config.trustMode,
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
      await this.client.sendTyping(chatId);
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
      await this.client.sendTyping(chatId, true);
    } catch (error) {
      // Ignore typing indicator errors
    }
  }

  /**
   * Add reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    await this.client.sendReaction(
      chatId,
      emoji,
      chatId, // targetAuthor
      parseInt(messageId, 10)
    );
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    await this.client.sendReaction(
      chatId,
      emoji,
      chatId, // targetAuthor
      parseInt(messageId, 10),
      true // remove
    );
  }

  /**
   * Send read receipt
   */
  async sendReadReceipt(sender: string, messageTimestamp: number): Promise<void> {
    if (!this.client || !this.config.sendReadReceipts) {
      return;
    }

    try {
      await this.client.sendReadReceipt(sender, [messageTimestamp]);
    } catch (error) {
      // Ignore read receipt errors
    }
  }

  /**
   * Get contacts
   */
  async getContacts(): Promise<Array<{ number: string; name?: string }>> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    return this.client.getContacts();
  }

  /**
   * Get groups
   */
  async getGroups(): Promise<Array<{ id: string; name: string; members: string[] }>> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    return this.client.getGroups();
  }

  /**
   * Trust a contact's identity
   */
  async trustIdentity(phoneNumber: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Signal client is not connected');
    }

    await this.client.trustIdentity(phoneNumber, this.config.trustMode === 'always');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming Signal message
   */
  private async handleIncomingMessage(signalMessage: SignalMessage): Promise<void> {
    const envelope = signalMessage.envelope;
    const dataMessage = envelope.dataMessage;

    // Skip non-data messages
    if (!dataMessage?.message) {
      return;
    }

    // Generate message ID from timestamp
    const messageId = envelope.timestamp.toString();

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(messageId)) {
      console.log(`Skipping duplicate Signal message ${messageId}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(messageId);
    }

    // Check access policy
    if (!this.isAllowedSender(envelope.source)) {
      console.log(`Ignoring message from unauthorized sender: ${envelope.source}`);
      return;
    }

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId,
      channel: 'signal',
      userId: envelope.source,
      userName: envelope.source, // Signal doesn't provide names in messages
      chatId: dataMessage.groupInfo?.groupId || envelope.source,
      text: dataMessage.message,
      timestamp: new Date(envelope.timestamp),
      replyTo: dataMessage.quote?.id?.toString(),
      attachments: this.convertAttachments(dataMessage.attachments),
      raw: signalMessage,
    };

    // Send read receipt
    if (this.config.sendReadReceipts) {
      await this.sendReadReceipt(envelope.source, envelope.timestamp);
    }

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in Signal message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
      }
    }
  }

  /**
   * Convert Signal attachments to MessageAttachment format
   */
  private convertAttachments(attachments?: SignalAttachment[]): MessageAttachment[] | undefined {
    if (!attachments || attachments.length === 0) {
      return undefined;
    }

    return attachments.map(att => {
      let type: MessageAttachment['type'] = 'file';

      if (att.contentType.startsWith('image/')) {
        type = 'image';
      } else if (att.contentType.startsWith('audio/')) {
        type = 'audio';
      } else if (att.contentType.startsWith('video/')) {
        type = 'video';
      }

      return {
        type,
        url: att.localPath,
        mimeType: att.contentType,
        fileName: att.filename,
        size: att.size,
      };
    });
  }

  /**
   * Check if sender is allowed
   */
  private isAllowedSender(sender: string): boolean {
    // Skip messages from self
    if (sender === this.config.phoneNumber) {
      return false;
    }

    // Check allowlist if configured
    if (this.config.allowedNumbers && this.config.allowedNumbers.length > 0) {
      // Normalize phone numbers for comparison
      const normalizedSender = sender.replace(/[^+\d]/g, '');
      return this.config.allowedNumbers.some(num => {
        const normalizedNum = num.replace(/[^+\d]/g, '');
        return normalizedSender === normalizedNum || normalizedSender.endsWith(normalizedNum);
      });
    }

    // Check DM policy
    switch (this.config.dmPolicy) {
      case 'disabled':
        return false;
      case 'allowlist':
        return false; // No allowlist configured
      case 'pairing':
        // TODO: Implement pairing code system
        return true;
      case 'open':
      default:
        return true;
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
 * Create a Signal adapter from configuration
 */
export function createSignalAdapter(config: SignalConfig): SignalAdapter {
  if (!config.phoneNumber) {
    throw new Error('Signal phone number is required');
  }
  return new SignalAdapter(config);
}
