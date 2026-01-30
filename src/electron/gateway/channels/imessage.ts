/**
 * iMessage Channel Adapter
 *
 * Implements the ChannelAdapter interface using the imsg CLI tool.
 * Based on 's implementation pattern.
 *
 * Features:
 * - JSON-RPC communication with imsg subprocess
 * - Real-time message watching via subscription
 * - Message deduplication
 * - Group and DM message handling
 * - Attachment support
 * - Auto-reconnection with exponential backoff
 */

import * as os from 'os';
import * as path from 'path';
import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  ImessageConfig,
} from './types';
import {
  ImessageRpcClient,
  ImessageRpcNotification,
  ImessagePayload,
  createImessageRpcClient,
  probeImsg,
  normalizeImessageHandle,
  formatImessageChatTarget,
} from './imessage-client';

/**
 * Exponential backoff configuration
 */
interface BackoffConfig {
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: number;
  maxAttempts: number;
}

export class ImessageAdapter implements ChannelAdapter {
  readonly type = 'imessage' as const;

  private client: ImessageRpcClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _selfHandle?: string;
  private subscriptionId: number | null = null;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: ImessageConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setTimeout>;

  // Connection state
  private isReconnecting = false;
  private backoffAttempt = 0;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private abortController: AbortController | null = null;

  private readonly DEFAULT_BACKOFF: BackoffConfig = {
    initialDelay: 2000,
    maxDelay: 30000,
    multiplier: 1.8,
    jitter: 0.25,
    maxAttempts: 10,
  };

  constructor(config: ImessageConfig) {
    this.config = {
      deduplicationEnabled: true,
      dmPolicy: 'pairing',
      groupPolicy: 'allowlist',
      service: 'auto',
      mediaMaxMb: 16,
      ...config,
    };
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._selfHandle;
  }

  /**
   * Connect to iMessage via imsg RPC
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    this.resetBackoff();
    this.abortController = new AbortController();

    try {
      // Check if imsg CLI is available
      const probe = await probeImsg(5000, {
        cliPath: this.config.cliPath,
        dbPath: this.config.dbPath,
      });

      if (!probe.ok) {
        throw new Error(probe.error || 'imsg CLI not available');
      }

      // Create RPC client
      this.client = await createImessageRpcClient({
        cliPath: this.config.cliPath,
        dbPath: this.config.dbPath || this.getDefaultDbPath(),
        onNotification: (msg) => this.handleNotification(msg),
        onError: (message) => console.error(message),
      });

      // Subscribe to message watching
      const result = await this.client.request<{ subscription?: number }>('watch.subscribe', {
        attachments: this.config.includeAttachments ?? false,
      });
      this.subscriptionId = result?.subscription ?? null;

      this.setStatus('connected');
      console.log('iMessage connected via imsg RPC');

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from iMessage
   */
  async disconnect(): Promise<void> {
    // Abort any pending operations
    this.abortController?.abort();
    this.abortController = null;

    // Clear backoff timer
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }

    // Stop dedup cleanup
    if (this.dedupCleanupTimer) {
      clearTimeout(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Unsubscribe from watch
    if (this.client && this.subscriptionId !== null) {
      try {
        await this.client.request('watch.unsubscribe', {
          subscription: this.subscriptionId,
        });
      } catch {
        // Ignore errors during disconnect
      }
      this.subscriptionId = null;
    }

    // Stop RPC client
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }

    this.isReconnecting = false;
    this.setStatus('disconnected');
    console.log('iMessage disconnected');
  }

  /**
   * Send a message
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('iMessage not connected');
    }

    const { chatId, text } = message;
    if (!text?.trim()) {
      throw new Error('Message text is required');
    }

    // Add response prefix if configured
    const finalText = this.config.responsePrefix
      ? `${this.config.responsePrefix} ${text}`
      : text;

    // Build request params
    const params: Record<string, unknown> = {
      text: finalText,
      service: this.config.service || 'auto',
    };

    // Parse chat target - could be chat_id:123 or imessage:handle or just a handle
    const chatIdMatch = chatId.match(/^chat_id:(\d+)$/);
    if (chatIdMatch) {
      params.chat_id = parseInt(chatIdMatch[1], 10);
    } else {
      // Strip imessage: prefix if present
      const handle = chatId.startsWith('imessage:') ? chatId.slice(9) : chatId;
      params.to = handle;
    }

    try {
      const result = await this.client.request<{
        messageId?: string;
        message_id?: string;
        id?: string;
        guid?: string;
        ok?: boolean;
      }>('send', params);

      const messageId =
        result?.messageId ||
        result?.message_id ||
        result?.id ||
        result?.guid ||
        (result?.ok ? 'ok' : 'unknown');

      return String(messageId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleError(err, 'sendMessage');
      throw err;
    }
  }

  /**
   * Send typing indicator (not supported by iMessage)
   */
  async sendTyping(_chatId: string): Promise<void> {
    // iMessage doesn't support typing indicators via imsg
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
      type: 'imessage',
      status: this._status,
      botUsername: this._selfHandle,
      extra: {
        platform: 'macOS',
        cliPath: this.config.cliPath || 'imsg',
        dbPath: this.config.dbPath || this.getDefaultDbPath(),
      },
    };
  }

  /**
   * Handle JSON-RPC notifications from imsg
   */
  private handleNotification(notification: ImessageRpcNotification): void {
    if (notification.method === 'message') {
      const params = notification.params as { message?: ImessagePayload | null };
      const message = params?.message;
      if (message) {
        this.processInboundMessage(message).catch((err) => {
          console.error('Error processing iMessage:', err);
          this.handleError(
            err instanceof Error ? err : new Error(String(err)),
            'messageProcessing'
          );
        });
      }
    } else if (notification.method === 'error') {
      console.error('imsg watch error:', notification.params);
    }
  }

  /**
   * Process an inbound message
   */
  private async processInboundMessage(payload: ImessagePayload): Promise<void> {
    // Skip messages from self
    if (payload.is_from_me) {
      return;
    }

    const sender = payload.sender?.trim();
    if (!sender) {
      return;
    }

    const messageId = payload.id ? String(payload.id) : undefined;
    const text = payload.text?.trim() || '';
    const chatId = payload.chat_id;

    // Skip empty messages (unless they have attachments)
    if (!text && (!payload.attachments || payload.attachments.length === 0)) {
      return;
    }

    // Check for duplicate messages
    if (this.config.deduplicationEnabled && messageId) {
      if (this.isMessageProcessed(messageId)) {
        return;
      }
      this.markMessageProcessed(messageId);
    }

    // Normalize sender handle
    const normalizedSender = normalizeImessageHandle(sender);

    // Build chat target
    const chatTarget = chatId !== undefined && chatId !== null
      ? formatImessageChatTarget(chatId) || `imessage:${normalizedSender}`
      : `imessage:${normalizedSender}`;

    // Create incoming message
    const incomingMessage: IncomingMessage = {
      messageId: messageId || `imessage-${Date.now()}`,
      channel: 'imessage',
      userId: normalizedSender,
      userName: normalizedSender,
      chatId: chatTarget,
      text: text || '<attachment>',
      timestamp: payload.created_at ? new Date(payload.created_at) : new Date(),
      raw: payload,
    };

    // Add reply context if present
    if (payload.reply_to_id) {
      incomingMessage.replyTo = String(payload.reply_to_id);
    }

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(incomingMessage);
      } catch (error) {
        console.error('Error in iMessage handler:', error);
      }
    }
  }

  /**
   * Get default Messages database path
   */
  private getDefaultDbPath(): string {
    return path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
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

  /**
   * Handle errors and notify handlers
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
   * Reset backoff state
   */
  private resetBackoff(): void {
    this.backoffAttempt = 0;
    this.isReconnecting = false;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /**
   * Attempt reconnection with exponential backoff
   */
  private attemptReconnection(): void {
    if (this.isReconnecting) return;
    if (this.backoffAttempt >= this.DEFAULT_BACKOFF.maxAttempts) {
      console.error('iMessage: max reconnection attempts reached');
      this.setStatus('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.isReconnecting = true;
    const delay = this.calculateBackoffDelay();
    this.backoffAttempt++;

    console.log(`iMessage: reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.backoffAttempt})`);

    this.backoffTimer = setTimeout(async () => {
      this.isReconnecting = false;
      try {
        await this.connect();
      } catch (error) {
        console.error('iMessage reconnection failed:', error);
        this.attemptReconnection();
      }
    }, delay);
  }

  /**
   * Calculate backoff delay with jitter
   */
  private calculateBackoffDelay(): number {
    const { initialDelay, maxDelay, multiplier, jitter } = this.DEFAULT_BACKOFF;
    const baseDelay = initialDelay * Math.pow(multiplier, this.backoffAttempt);
    const delay = Math.min(baseDelay, maxDelay);
    const jitterAmount = delay * jitter * (Math.random() * 2 - 1);
    return Math.max(initialDelay, delay + jitterAmount);
  }

  /**
   * Check if a message has been processed (deduplication)
   */
  private isMessageProcessed(messageId: string): boolean {
    const timestamp = this.processedMessages.get(messageId);
    if (!timestamp) return false;
    if (Date.now() - timestamp > this.DEDUP_CACHE_TTL) {
      this.processedMessages.delete(messageId);
      return false;
    }
    return true;
  }

  /**
   * Mark a message as processed
   */
  private markMessageProcessed(messageId: string): void {
    // Enforce cache size limit
    if (this.processedMessages.size >= this.DEDUP_CACHE_MAX_SIZE) {
      // Remove oldest entries
      const entries = [...this.processedMessages.entries()];
      entries.sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, Math.floor(this.DEDUP_CACHE_MAX_SIZE / 4));
      for (const [key] of toRemove) {
        this.processedMessages.delete(key);
      }
    }
    this.processedMessages.set(messageId, Date.now());
  }

  /**
   * Start periodic deduplication cache cleanup
   */
  private startDedupCleanup(): void {
    if (this.dedupCleanupTimer) return;

    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [messageId, timestamp] of this.processedMessages.entries()) {
        if (now - timestamp > this.DEDUP_CACHE_TTL) {
          this.processedMessages.delete(messageId);
        }
      }
    }, this.DEDUP_CACHE_TTL / 2);
  }
}

/**
 * Factory function to create an iMessage adapter
 */
export function createImessageAdapter(config: ImessageConfig): ImessageAdapter {
  return new ImessageAdapter(config);
}
