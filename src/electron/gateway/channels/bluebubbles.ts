/**
 * BlueBubbles Channel Adapter
 *
 * Implements the ChannelAdapter interface for iMessage via BlueBubbles.
 * BlueBubbles is a server that runs on a Mac and exposes iMessage via API.
 *
 * Features:
 * - Send and receive iMessage/SMS
 * - Attachment support
 * - Group chat support
 * - Read receipts and typing indicators
 *
 * Requirements:
 * - BlueBubbles server running on a Mac (https://bluebubbles.app/)
 * - Server URL and password
 * - Network access to the BlueBubbles server
 *
 * Limitations:
 * - Requires a Mac running BlueBubbles server 24/7
 * - No message editing (iMessage doesn't support it)
 * - No message deletion (iMessage unsend is time-limited)
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
import { BlueBubblesClient, BlueBubblesMessage, BlueBubblesChat } from './bluebubbles-client';

/**
 * BlueBubbles-specific configuration
 */
export interface BlueBubblesConfig extends ChannelConfig {
  /** BlueBubbles server URL (e.g., http://192.168.1.100:1234) */
  serverUrl: string;
  /** BlueBubbles server password */
  password: string;
  /** Enable webhook notifications (default: true) */
  enableWebhook?: boolean;
  /** Webhook port to listen on (default: 3101) */
  webhookPort?: number;
  /** Webhook path (default: /bluebubbles/webhook) */
  webhookPath?: string;
  /** Poll interval in ms if webhooks not available (default: 5000) */
  pollInterval?: number;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Allowed contacts (phone numbers or emails) */
  allowedContacts?: string[];
}

export class BlueBubblesAdapter implements ChannelAdapter {
  readonly type = 'bluebubbles' as const;

  private client: BlueBubblesClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: BlueBubblesConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Chat cache
  private chatCache: Map<string, BlueBubblesChat> = new Map();

  constructor(config: BlueBubblesConfig) {
    this.config = {
      enableWebhook: true,
      webhookPort: 3101,
      webhookPath: '/bluebubbles/webhook',
      pollInterval: 5000,
      deduplicationEnabled: true,
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
   * Connect to BlueBubbles
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create BlueBubbles client
      this.client = new BlueBubblesClient({
        serverUrl: this.config.serverUrl,
        password: this.config.password,
        webhookPort: this.config.enableWebhook ? this.config.webhookPort : undefined,
        webhookPath: this.config.webhookPath,
        pollInterval: this.config.pollInterval,
        verbose: process.env.NODE_ENV === 'development',
      });

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to BlueBubbles server');
      }

      this._botUsername = `BlueBubbles (${check.serverVersion || 'Connected'})`;

      // Set up event handlers
      this.client.on('message', (message: BlueBubblesMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('BlueBubbles client connected');
      });

      this.client.on('disconnected', () => {
        console.log('BlueBubbles client disconnected');
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
      console.log(`BlueBubbles adapter connected to ${this.config.serverUrl}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from BlueBubbles
   */
  async disconnect(): Promise<void> {
    // Stop dedup cleanup
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear caches
    this.processedMessages.clear();
    this.chatCache.clear();

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
      throw new Error('BlueBubbles client is not connected');
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix} ${text}`;
    }

    // chatId is the chat GUID
    const result = await this.client.sendMessage(message.chatId, text);
    return result.guid;
  }

  /**
   * Edit a message (not supported by iMessage)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    throw new Error('iMessage does not support message editing');
  }

  /**
   * Delete a message (not supported - iMessage unsend is time-limited)
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    throw new Error('iMessage message deletion not supported via BlueBubbles');
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('BlueBubbles file sending not implemented');
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('BlueBubbles image sending not implemented');
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
      type: 'bluebubbles',
      status: this._status,
      botUsername: this._botUsername,
      botDisplayName: `BlueBubbles (${this._botUsername || 'Not connected'})`,
      extra: {
        serverUrl: this.config.serverUrl,
        webhookEnabled: this.config.enableWebhook,
        webhookPort: this.config.webhookPort,
      },
    };
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Get recent chats
   */
  async getChats(limit = 25): Promise<BlueBubblesChat[]> {
    if (!this.client || this._status !== 'connected') {
      return [];
    }
    return this.client.getChats({ limit });
  }

  /**
   * Send message to a phone number or email (creates new chat if needed)
   */
  async sendToAddress(
    address: string,
    text: string,
    service: 'iMessage' | 'SMS' = 'iMessage'
  ): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('BlueBubbles client is not connected');
    }

    // Add response prefix if configured
    let messageText = text;
    if (this.config.responsePrefix) {
      messageText = `${this.config.responsePrefix} ${messageText}`;
    }

    const result = await this.client.sendMessageToAddress(address, messageText, service);
    return result.guid;
  }

  /**
   * Mark chat as read
   */
  async markAsRead(chatGuid: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      return;
    }
    await this.client.markChatRead(chatGuid);
  }

  /**
   * Send typing indicator
   */
  async sendTyping(chatGuid: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      return;
    }
    await this.client.sendTypingIndicator(chatGuid);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming BlueBubbles message
   */
  private async handleIncomingMessage(bbMessage: BlueBubblesMessage): Promise<void> {
    // Skip empty messages
    if (!bbMessage.text) {
      return;
    }

    // Skip own messages
    if (bbMessage.isFromMe) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(bbMessage.guid)) {
      console.log(`Skipping duplicate BlueBubbles message ${bbMessage.guid}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(bbMessage.guid);
    }

    // Check allowlist if configured
    if (this.config.allowedContacts && this.config.allowedContacts.length > 0) {
      const senderAddress = bbMessage.handle?.address || '';
      const isAllowed = this.config.allowedContacts.some((allowed) => {
        const normalizedAllowed = allowed.replace(/[^0-9+@.]/g, '');
        const normalizedSender = senderAddress.replace(/[^0-9+@.]/g, '');
        return normalizedSender.includes(normalizedAllowed) ||
               normalizedAllowed.includes(normalizedSender);
      });
      if (!isAllowed) {
        console.log(`BlueBubbles: Ignoring message from non-allowed contact: ${senderAddress}`);
        return;
      }
    }

    // Get user display name
    let userName = bbMessage.handle?.address || 'Unknown';
    // Try to get from cached chat info
    const chat = this.chatCache.get(bbMessage.chatGuid);
    if (chat?.displayName) {
      userName = chat.displayName;
    }

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: bbMessage.guid,
      channel: 'bluebubbles',
      userId: bbMessage.handle?.address || String(bbMessage.handleId),
      userName,
      chatId: bbMessage.chatGuid,
      text: bbMessage.text,
      timestamp: new Date(bbMessage.dateCreated),
      raw: bbMessage,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in BlueBubbles message handler:', error);
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
 * Create a BlueBubbles adapter from configuration
 */
export function createBlueBubblesAdapter(config: BlueBubblesConfig): BlueBubblesAdapter {
  if (!config.serverUrl) {
    throw new Error('BlueBubbles server URL is required');
  }
  if (!config.password) {
    throw new Error('BlueBubbles server password is required');
  }
  return new BlueBubblesAdapter(config);
}
