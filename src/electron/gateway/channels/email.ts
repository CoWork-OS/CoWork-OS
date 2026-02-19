/**
 * Email Channel Adapter
 *
 * Implements the ChannelAdapter interface for email via IMAP/SMTP.
 * Provides a unified interface for email communication.
 *
 * Features:
 * - Real-time email receiving via IMAP
 * - Email sending via SMTP
 * - Reply threading support
 * - Subject filtering
 * - Sender allowlist
 *
 * Requirements:
 * - IMAP server credentials
 * - SMTP server credentials
 *
 * Limitations:
 * - No message editing (email doesn't support it)
 * - No message deletion (would move to trash, not delete)
 * - Attachments not implemented yet
 */

import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  EmailTransportClient,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  EmailConfig,
} from './types';
import { EmailClient, EmailMessage } from './email-client';
import { LoomEmailClient } from './loom-client';
import { assertSafeLoomBaseUrl, assertSafeLoomMailboxFolder, normalizeEmailProtocol } from '../../utils/loom';

export class EmailAdapter implements ChannelAdapter {
  readonly type = 'email' as const;

  private client: EmailTransportClient | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: EmailConfig;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 300000; // 5 minutes (longer for email)
  private readonly DEDUP_CACHE_MAX_SIZE = 500;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  // Reply context cache (for threading)
  private replyContext: Map<string, { messageId: string; references: string[] }> = new Map();

  // Auto-reconnect
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_BASE_DELAY = 10000; // 10 seconds (longer for email)
  private shouldReconnect = true;

  constructor(config: EmailConfig) {
    const protocol = normalizeEmailProtocol(config.protocol);

    this.config = {
      ...config,
      protocol,
      imapPort: config.imapPort ?? 993,
      imapSecure: config.imapSecure ?? true,
      smtpPort: config.smtpPort ?? 587,
      smtpSecure: config.smtpSecure ?? false,
      mailbox: config.mailbox ?? 'INBOX',
      pollInterval: config.pollInterval ?? 30000,
      markAsRead: config.markAsRead ?? true,
      deduplicationEnabled: config.deduplicationEnabled ?? true,
      loomMailboxFolder: config.loomMailboxFolder ?? 'INBOX',
      loomPollInterval: config.loomPollInterval ?? config.pollInterval ?? 30000,
    };
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to email servers
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    this.shouldReconnect = true;

    try {
      const protocol = normalizeEmailProtocol(this.config.protocol);
      if (protocol === 'loom') {
        const loomBaseUrl = this.config.loomBaseUrl;
        if (!loomBaseUrl) {
          throw new Error('LOOM base URL is required');
        }

        const getLoomAccessToken = () => this.config.loomAccessToken;
        if (!getLoomAccessToken()) {
          throw new Error('LOOM access token is required');
        }

        this.client = new LoomEmailClient({
          baseUrl: loomBaseUrl,
          accessTokenProvider: () => {
            const token = getLoomAccessToken();
            if (!token) {
              throw new Error('LOOM access token is required');
            }
            return token;
          },
          identity: this.config.loomIdentity,
          folder: assertSafeLoomMailboxFolder(this.config.loomMailboxFolder || 'INBOX'),
          pollInterval: this.config.loomPollInterval || this.config.pollInterval || 30000,
          stateFilePath: this.config.loomStatePath,
          verbose: process.env.NODE_ENV === 'development',
        });
      } else {
        const imapHost = this.config.imapHost;
        const smtpHost = this.config.smtpHost;
        const email = this.config.email;
        const password = this.config.password;
        if (!imapHost) throw new Error('IMAP host is required');
        if (!smtpHost) throw new Error('SMTP host is required');
        if (!email) throw new Error('Email address is required');
        if (!password) throw new Error('Email password is required');

        this.client = new EmailClient({
          imapHost,
          imapPort: this.config.imapPort ?? 993,
          imapSecure: this.config.imapSecure ?? true,
          smtpHost,
          smtpPort: this.config.smtpPort ?? 587,
          smtpSecure: this.config.smtpSecure ?? false,
          email,
          password,
          displayName: this.config.displayName,
          mailbox: this.config.mailbox || 'INBOX',
          pollInterval: this.config.pollInterval || 30000,
          verbose: process.env.NODE_ENV === 'development',
        });
      }

      // Check connection
      const check = await this.client.checkConnection();
      if (!check.success) {
        throw new Error(check.error || 'Failed to connect to email server');
      }

      this._botUsername =
        this.config.displayName || this.client.getEmail?.() || this.config.email || this.config.loomIdentity;

      // Set up event handlers
      this.client.on('message', (message: EmailMessage) => {
        this.handleIncomingMessage(message);
      });

      this.client.on('error', (error: Error) => {
        this.handleError(error, 'client');
      });

      this.client.on('connected', () => {
        console.log('Email client connected');
      });

      this.client.on('disconnected', () => {
        console.log('Email client disconnected');
        if (this._status === 'connected') {
          this.setStatus('disconnected');
          // Attempt to reconnect if not intentionally disconnected
          this.scheduleReconnect();
        }
      });

      // Start receiving emails
      await this.client.startReceiving();

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      this.setStatus('connected');
      console.log(`Email adapter connected as ${this._botUsername}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from email servers
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
    this.replyContext.clear();

    // Stop client
    if (this.client) {
      await this.client.stopReceiving();
      this.client = null;
    }

    this._botUsername = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.log(`Email: Not reconnecting (shouldReconnect=${this.shouldReconnect}, attempts=${this.reconnectAttempts})`);
      return;
    }

    const delay = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts);
    console.log(`Email: Scheduling reconnect attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      try {
        await this.connect();
        // Reset attempts on successful connection
        this.reconnectAttempts = 0;
        console.log('Email: Reconnected successfully');
      } catch (error) {
        console.error('Email: Reconnect failed:', error);
        // Schedule next attempt
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Send an email (reply or new)
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Email client is not connected');
    }

    // Add response prefix if configured
    let text = message.text;
    if (this.config.responsePrefix) {
      text = `${this.config.responsePrefix}\n\n${text}`;
    }

    // Determine subject
    let subject = 'Message from CoWork';
    let inReplyTo: string | undefined;
    let references: string[] = [];

    // Check for reply context
    const context = this.replyContext.get(message.chatId);
    if (context) {
      inReplyTo = context.messageId;
      references = [...context.references, context.messageId];
      // Assume original subject with Re: prefix
      subject = `Re: ${message.chatId.split('|')[1] || 'Message'}`;
    }

    // Send email
    const messageId = await this.client.sendEmail({
      to: message.chatId.split('|')[0], // chatId format: "email@address.com|subject"
      subject,
      text,
      inReplyTo,
      references,
    });

    return messageId;
  }

  /**
   * Edit a message (not supported by email)
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    throw new Error('Email does not support message editing');
  }

  /**
   * Delete a message (not supported)
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    throw new Error('Email message deletion not implemented');
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('Email attachment sending not implemented');
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    throw new Error('Email image sending not implemented');
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
      type: 'email',
      status: this._status,
      botId: this.config.email || this.config.loomIdentity || this.config.loomBaseUrl,
      botUsername: this._botUsername,
      botDisplayName: `Email (${this._botUsername || 'Not connected'})`,
      extra: {
        protocol: normalizeEmailProtocol(this.config.protocol),
        email: this.config.email,
        imapHost: this.config.imapHost,
        smtpHost: this.config.smtpHost,
        mailbox: this.config.mailbox,
        loomBaseUrl: this.config.loomBaseUrl,
        loomIdentity: this.config.loomIdentity,
        loomMailboxFolder: this.config.loomMailboxFolder,
      },
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle incoming email message
   */
  private async handleIncomingMessage(email: EmailMessage): Promise<void> {
    // Skip empty messages
    if (!email.text && !email.html) {
      return;
    }

    // Check for duplicates
    if (this.config.deduplicationEnabled && this.isMessageProcessed(email.messageId)) {
      console.log(`Skipping duplicate email ${email.messageId}`);
      return;
    }

    // Mark as processed
    if (this.config.deduplicationEnabled) {
      this.markMessageProcessed(email.messageId);
    }

    // Check sender allowlist if configured
    if (this.config.allowedSenders && this.config.allowedSenders.length > 0) {
      const senderAddress = email.from.address.toLowerCase();
      const isAllowed = this.config.allowedSenders.some(
        (allowed) => senderAddress.includes(allowed.toLowerCase())
      );
      if (!isAllowed) {
        console.log(`Email: Ignoring message from non-allowed sender: ${senderAddress}`);
        return;
      }
    }

    // Check subject filter if configured
    if (this.config.subjectFilter) {
      if (!email.subject.toLowerCase().includes(this.config.subjectFilter.toLowerCase())) {
        console.log(`Email: Ignoring message with non-matching subject: ${email.subject}`);
        return;
      }
    }

    // Create chat ID for threading (sender|subject)
    const chatId = `${email.from.address}|${email.subject.replace(/^(Re:\s*)+/i, '')}`;

    // Store reply context for threading
    this.replyContext.set(chatId, {
      messageId: email.messageId,
      references: email.references || [],
    });

    // Get text content (prefer plain text over HTML)
    let text = email.text || '';
    if (!text && email.html) {
      // Basic HTML to text conversion
      text = email.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
    }

    // Convert to IncomingMessage
    const message: IncomingMessage = {
      messageId: email.messageId,
      channel: 'email',
      userId: email.from.address,
      userName: email.from.name || email.from.address,
      chatId,
      text: `[${email.subject}]\n\n${text}`,
      timestamp: email.date,
      raw: email,
    };

    // Notify handlers
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in Email message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
      }
    }

    // Mark as read if configured
    if (this.config.markAsRead && this.client) {
      try {
        await this.client.markAsRead(email.uid);
      } catch {
        // Ignore mark-as-read errors
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
 * Create an Email adapter from configuration
 */
export function createEmailAdapter(config: EmailConfig): EmailAdapter {
  const protocol = normalizeEmailProtocol(config.protocol);

  if (protocol === 'loom') {
    if (!config.loomBaseUrl) {
      throw new Error('LOOM base URL is required');
    }
    if (!config.loomAccessToken) {
      throw new Error('LOOM access token is required');
    }
    assertSafeLoomBaseUrl(config.loomBaseUrl);
    const safeLoomMailboxFolder = assertSafeLoomMailboxFolder(config.loomMailboxFolder);
    return new EmailAdapter({
      ...config,
      protocol: 'loom',
      loomMailboxFolder: safeLoomMailboxFolder,
    });
  }

  if (!config.imapHost) {
    throw new Error('IMAP host is required');
  }
  if (!config.smtpHost) {
    throw new Error('SMTP host is required');
  }
  if (!config.email) {
    throw new Error('Email address is required');
  }
  if (!config.password) {
    throw new Error('Email password is required');
  }
  return new EmailAdapter({
    ...config,
    protocol: 'imap-smtp',
  });
}
