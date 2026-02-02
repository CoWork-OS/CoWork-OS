/**
 * WhatsApp Channel Adapter
 *
 * Implements the ChannelAdapter interface using Baileys for WhatsApp Web API.
 *
 * Features:
 * - QR code authentication for WhatsApp Web
 * - Multi-file auth state persistence
 * - Message deduplication
 * - Group and DM message handling
 * - Media message support (images, documents, audio, video)
 * - Typing indicators (composing presence)
 * - Message reactions
 * - Auto-reconnection with exponential backoff
 * - Read receipts
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidGroup,
  downloadContentFromMessage,
  type WASocket,
  type WAMessage,
  type AnyMessageContent,
  type ConnectionState,
  type proto,
  type DownloadableMessage,
} from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  MessageAttachment,
  CallbackQueryHandler,
  WhatsAppConfig,
} from './types';

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

/**
 * QR code event handler
 */
export type QrCodeHandler = (qr: string) => void;

/**
 * WhatsApp inbound message
 */
interface WhatsAppInboundMessage {
  id?: string;
  from: string;
  to: string;
  body: string;
  timestamp?: number;
  chatType: 'direct' | 'group';
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  groupSubject?: string;
  mediaPath?: string;
  mediaType?: string;
  replyToId?: string;
  replyToBody?: string;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = 'whatsapp' as const;

  private sock: WASocket | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _selfJid?: string;
  private _selfE164?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private qrCodeHandlers: QrCodeHandler[] = [];
  private config: WhatsAppConfig;
  private authDir: string;

  // Message deduplication
  private processedMessages: Map<string, number> = new Map();
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setTimeout>;

  // Connection state
  private connectedAtMs: number = 0;
  private isReconnecting = false;
  private backoffAttempt = 0;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private currentQr?: string;

  private readonly DEFAULT_BACKOFF: BackoffConfig = {
    initialDelay: 2000,
    maxDelay: 30000,
    multiplier: 1.8,
    jitter: 0.25,
    maxAttempts: 10,
  };

  // Group metadata cache
  private groupMetaCache: Map<string, { subject?: string; expires: number }> = new Map();
  private readonly GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: WhatsAppConfig) {
    this.config = {
      deduplicationEnabled: true,
      sendReadReceipts: true,
      printQrToTerminal: false,
      selfChatMode: true, // Default to self-chat mode since most users use their own number
      responsePrefix: '🤖', // Default prefix for bot responses
      ...config,
    };

    // In self-chat mode, disable read receipts by default
    if (this.config.selfChatMode && config.sendReadReceipts === undefined) {
      this.config.sendReadReceipts = false;
    }

    // Set auth directory
    this.authDir = config.authDir || path.join(app.getPath('userData'), 'whatsapp-auth');
  }

  /**
   * Check if self-chat mode is enabled
   */
  get isSelfChatMode(): boolean {
    return this.config.selfChatMode === true;
  }

  /**
   * Get the response prefix for bot messages
   */
  get responsePrefix(): string {
    return this.config.responsePrefix || '🤖';
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._selfE164;
  }

  /**
   * Get the current QR code (if in login state)
   */
  get qrCode(): string | undefined {
    return this.currentQr;
  }

  /**
   * Check if WhatsApp auth credentials exist
   */
  async hasCredentials(): Promise<boolean> {
    const credsPath = path.join(this.authDir, 'creds.json');
    return fs.existsSync(credsPath);
  }

  /**
   * Connect to WhatsApp Web
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');
    this.resetBackoff();

    try {
      // Ensure auth directory exists
      await this.ensureDir(this.authDir);

      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      // Get latest Baileys version
      const { version } = await fetchLatestBaileysVersion();

      // Create silent logger to suppress Baileys logs
      const logger = {
        level: 'silent' as const,
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => logger,
      };

      // Create WhatsApp socket
      this.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger as any),
        },
        version,
        logger: logger as any,
        // Note: printQRInTerminal is deprecated - QR codes are handled via connection.update event
        browser: ['CoWork-OS', 'Desktop', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      // Handle credential updates
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      this.sock.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(update);
      });

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', (upsert) => {
        this.handleMessagesUpsert(upsert);
      });

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
   * Handle connection state updates
   */
  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR code for authentication
    if (qr) {
      this.currentQr = qr;
      console.log('WhatsApp QR code received - scan with WhatsApp mobile app');

      // Notify QR handlers
      for (const handler of this.qrCodeHandlers) {
        try {
          handler(qr);
        } catch (e) {
          console.error('Error in QR code handler:', e);
        }
      }
    }

    // Handle connection open
    if (connection === 'open') {
      this.currentQr = undefined;
      this.connectedAtMs = Date.now();
      this._selfJid = this.sock?.user?.id;
      this._selfE164 = this._selfJid ? this.jidToE164(this._selfJid) ?? undefined : undefined;

      console.log(`WhatsApp connected as ${this._selfE164 || this._selfJid}`);
      this.setStatus('connected');
      this.resetBackoff();

      // Send available presence
      this.sock?.sendPresenceUpdate('available').catch(() => {});
    }

    // Handle connection close
    if (connection === 'close') {
      this.currentQr = undefined;
      const statusCode = this.getStatusCode(lastDisconnect?.error);

      if (statusCode === DisconnectReason.loggedOut) {
        console.error('WhatsApp session logged out');
        this.setStatus('error', new Error('WhatsApp session logged out. Please re-authenticate.'));
        // Clear credentials on logout
        this.clearCredentials().catch(() => {});
      } else if (statusCode === DisconnectReason.restartRequired) {
        console.log('WhatsApp restart required, reconnecting...');
        this.attemptReconnection();
      } else {
        console.log(`WhatsApp connection closed (status: ${statusCode}), attempting reconnection...`);
        this.attemptReconnection();
      }
    }
  }

  /**
   * Handle incoming messages
   */
  private async handleMessagesUpsert(upsert: { type?: string; messages?: WAMessage[] }): Promise<void> {
    if (upsert.type !== 'notify' && upsert.type !== 'append') return;

    for (const msg of upsert.messages ?? []) {
      try {
        await this.processInboundMessage(msg, upsert.type);
      } catch (error) {
        console.error('Error processing WhatsApp message:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageProcessing'
        );
      }
    }
  }

  /**
   * Process a single inbound message
   */
  private async processInboundMessage(msg: WAMessage, upsertType: string): Promise<void> {
    const id = msg.key?.id;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;

    // Skip status and broadcast messages
    if (remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast')) return;

    // CRITICAL: In self-chat mode, ONLY process messages from self-chat
    // This prevents the bot from responding to messages sent to other people
    if (this.isSelfChatMode && this._selfJid) {
      // Normalize JIDs by removing device suffix (e.g., "123:5@s.whatsapp.net" -> "123@s.whatsapp.net")
      const normalizeJid = (jid: string) => jid.replace(/:[\d]+@/, '@');
      const selfJidNormalized = normalizeJid(this._selfJid);
      const remoteJidNormalized = normalizeJid(remoteJid);

      if (remoteJidNormalized !== selfJidNormalized) {
        // Message is NOT in self-chat, silently ignore it
        return;
      }
    }

    // Deduplication
    if (id && this.config.deduplicationEnabled) {
      const dedupeKey = `${remoteJid}:${id}`;
      if (this.processedMessages.has(dedupeKey)) return;
      this.processedMessages.set(dedupeKey, Date.now());

      // Cleanup if cache is too large
      if (this.processedMessages.size > this.DEDUP_CACHE_MAX_SIZE) {
        this.cleanupDedupCache();
      }
    }

    const isGroup = isJidGroup(remoteJid) === true;
    const participantJid = msg.key?.participant;
    const from = isGroup ? remoteJid : this.jidToE164(remoteJid) || remoteJid;
    const senderE164 = isGroup
      ? participantJid ? this.jidToE164(participantJid) : null
      : from;

    // Check access control
    if (this.config.allowedNumbers && this.config.allowedNumbers.length > 0) {
      const senderNumber = senderE164?.replace(/[^0-9]/g, '');
      if (senderNumber && !this.config.allowedNumbers.includes(senderNumber)) {
        console.log(`WhatsApp: Ignoring message from unauthorized number: ${senderNumber}`);
        return;
      }
    }

    // Get group metadata if applicable
    let groupSubject: string | undefined;
    if (isGroup && this.sock) {
      const meta = await this.getGroupMeta(remoteJid);
      groupSubject = meta.subject;
    }

    // Extract message text
    const body = this.extractText(msg.message);
    if (!body) {
      // Check for media placeholder
      const mediaPlaceholder = this.extractMediaPlaceholder(msg.message);
      if (!mediaPlaceholder) return;
    }

    // Send read receipt
    if (id && this.config.sendReadReceipts && upsertType === 'notify') {
      try {
        await this.sock?.readMessages([{
          remoteJid,
          id,
          participant: participantJid,
          fromMe: false,
        }]);
      } catch {
        // Ignore read receipt errors
      }
    }

    // Skip history/offline catch-up messages
    if (upsertType === 'append') return;

    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    // Download audio attachment if present
    const attachments: MessageAttachment[] = [];
    if (msg.message?.audioMessage) {
      const audioAttachment = await this.downloadAudioAttachment(msg.message);
      if (audioAttachment) {
        attachments.push(audioAttachment);
      }
    }

    // Create incoming message
    const incomingMessage: IncomingMessage = {
      messageId: id || `wa-${Date.now()}`,
      channel: 'whatsapp',
      userId: senderE164 || participantJid || remoteJid,
      userName: msg.pushName || senderE164 || 'Unknown',
      chatId: remoteJid,
      text: body || (attachments.length === 0 ? this.extractMediaPlaceholder(msg.message) : '') || '',
      timestamp: messageTimestampMs ? new Date(messageTimestampMs) : new Date(),
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: msg,
    };

    // Notify message handlers
    await this.handleIncomingMessage(incomingMessage);
  }

  /**
   * Disconnect from WhatsApp
   */
  async disconnect(): Promise<void> {
    this.resetBackoff();

    // Clear timers
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear caches
    this.processedMessages.clear();
    this.groupMetaCache.clear();
    this.currentQr = undefined;

    if (this.sock) {
      try {
        this.sock.ws?.close();
      } catch {
        // Ignore close errors
      }
      this.sock = null;
    }

    this._selfJid = undefined;
    this._selfE164 = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Convert standard Markdown to WhatsApp-compatible formatting
   * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
   */
  private convertMarkdownToWhatsApp(text: string): string {
    let result = text;

    // Convert headers (### Header) to bold text
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Convert **bold** to *bold* (WhatsApp style)
    result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Convert __bold__ to *bold*
    result = result.replace(/__(.+?)__/g, '*$1*');

    // Convert _italic_ - already WhatsApp compatible, but handle markdown style
    // Note: Single underscores are already WhatsApp italic

    // Convert ~~strikethrough~~ to ~strikethrough~
    result = result.replace(/~~(.+?)~~/g, '~$1~');

    // Convert inline code `code` to monospace (WhatsApp uses triple backticks but single works in some clients)
    // Keep as-is since WhatsApp renders `code` reasonably

    // Convert code blocks ```code``` - already WhatsApp compatible

    // Convert [link text](url) to "link text (url)" since WhatsApp auto-links URLs
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Convert horizontal rules (---, ***, ___) to a line
    result = result.replace(/^[-*_]{3,}$/gm, '───────────');

    // Clean up excessive newlines
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
  }

  /**
   * Send a message to a WhatsApp chat
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.sock || this._status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const jid = this.toWhatsAppJid(message.chatId);
    let messageId = '';

    // Convert markdown to WhatsApp formatting and apply response prefix
    let textToSend = message.text ? this.convertMarkdownToWhatsApp(message.text) : message.text;
    if (this.isSelfChatMode && textToSend && textToSend.trim()) {
      const prefix = this.responsePrefix;
      // Only add prefix if not already present
      if (!textToSend.startsWith(prefix)) {
        textToSend = `${prefix} ${textToSend}`;
      }
    }

    // Send media attachments first
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        const result = await this.sendMediaAttachment(jid, attachment, textToSend);
        messageId = result;
        // Clear text after first media with caption
        if (textToSend) {
          textToSend = '';
        }
      }
    }

    // Send text message if no media or text remains
    if (textToSend && textToSend.trim()) {
      // Send composing presence
      await this.sendComposingTo(jid);

      const result = await this.sock.sendMessage(jid, { text: textToSend });
      messageId = result?.key?.id || `wa-${Date.now()}`;
    }

    return messageId;
  }

  /**
   * Send a media attachment
   */
  private async sendMediaAttachment(
    jid: string,
    attachment: MessageAttachment,
    caption?: string
  ): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp is not connected');

    let content: AnyMessageContent;

    if (attachment.type === 'image' && attachment.url) {
      const buffer = fs.readFileSync(attachment.url);
      content = {
        image: buffer,
        caption,
        mimetype: attachment.mimeType || 'image/jpeg',
      };
    } else if (attachment.type === 'document' && attachment.url) {
      const buffer = fs.readFileSync(attachment.url);
      content = {
        document: buffer,
        fileName: attachment.fileName || path.basename(attachment.url),
        mimetype: attachment.mimeType || 'application/octet-stream',
        caption,
      };
    } else if (attachment.type === 'audio' && attachment.url) {
      const buffer = fs.readFileSync(attachment.url);
      content = {
        audio: buffer,
        mimetype: attachment.mimeType || 'audio/mpeg',
        ptt: true, // Voice note
      };
    } else if (attachment.type === 'video' && attachment.url) {
      const buffer = fs.readFileSync(attachment.url);
      content = {
        video: buffer,
        caption,
        mimetype: attachment.mimeType || 'video/mp4',
      };
    } else {
      throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }

    const result = await this.sock.sendMessage(jid, content);
    return result?.key?.id || `wa-${Date.now()}`;
  }

  /**
   * Send composing (typing) indicator
   */
  async sendComposingTo(chatId: string): Promise<void> {
    if (!this.sock) return;

    const jid = this.toWhatsAppJid(chatId);
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch {
      // Ignore presence errors
    }
  }

  /**
   * Send typing indicator (alias for sendComposingTo)
   */
  async sendTyping(chatId: string): Promise<void> {
    await this.sendComposingTo(chatId);
  }

  /**
   * Edit an existing message (not supported by WhatsApp Web API)
   */
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<void> {
    throw new Error('WhatsApp does not support message editing');
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp is not connected');

    const jid = this.toWhatsAppJid(chatId);
    await this.sock.sendMessage(jid, {
      delete: {
        remoteJid: jid,
        fromMe: true,
        id: messageId,
      },
    });
  }

  /**
   * Send a document/file
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp is not connected');

    const jid = this.toWhatsAppJid(chatId);
    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const result = await this.sock.sendMessage(jid, {
      document: buffer,
      fileName,
      mimetype: 'application/octet-stream',
      caption,
    });

    return result?.key?.id || `wa-${Date.now()}`;
  }

  /**
   * Send a photo/image
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp is not connected');

    const jid = this.toWhatsAppJid(chatId);
    const buffer = fs.readFileSync(filePath);

    const result = await this.sock.sendMessage(jid, {
      image: buffer,
      caption,
    });

    return result?.key?.id || `wa-${Date.now()}`;
  }

  /**
   * Add a reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp is not connected');

    const jid = this.toWhatsAppJid(chatId);
    await this.sock.sendMessage(jid, {
      react: {
        text: emoji,
        key: {
          remoteJid: jid,
          id: messageId,
          fromMe: false,
        },
      },
    });
  }

  /**
   * Remove a reaction from a message
   */
  async removeReaction(chatId: string, messageId: string): Promise<void> {
    await this.addReaction(chatId, messageId, ''); // Empty string removes reaction
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a callback query handler (not supported by WhatsApp)
   */
  onCallbackQuery(_handler: CallbackQueryHandler): void {
    // WhatsApp doesn't support inline keyboards/callback queries
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
   * Register a QR code handler
   */
  onQrCode(handler: QrCodeHandler): void {
    this.qrCodeHandlers.push(handler);
  }

  /**
   * Get channel info
   */
  async getInfo(): Promise<ChannelInfo> {
    return {
      type: 'whatsapp',
      status: this._status,
      botId: this._selfJid,
      botUsername: this._selfE164,
      botDisplayName: this._selfE164,
      extra: {
        qrCode: this.currentQr,
        hasCredentials: await this.hasCredentials(),
      },
    };
  }

  /**
   * Logout and clear credentials
   */
  async logout(): Promise<void> {
    await this.disconnect();
    await this.clearCredentials();
  }

  /**
   * Clear stored credentials
   */
  private async clearCredentials(): Promise<void> {
    try {
      if (fs.existsSync(this.authDir)) {
        const files = fs.readdirSync(this.authDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.authDir, file));
        }
      }
    } catch (error) {
      console.error('Error clearing WhatsApp credentials:', error);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Handle incoming message notification
   */
  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in WhatsApp message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
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

  /**
   * Attempt reconnection with exponential backoff
   */
  private async attemptReconnection(): Promise<void> {
    if (this.isReconnecting) return;

    const config = this.DEFAULT_BACKOFF;

    if (this.backoffAttempt >= config.maxAttempts) {
      console.error(`WhatsApp: Max reconnection attempts (${config.maxAttempts}) reached`);
      this.setStatus('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.isReconnecting = true;
    this.backoffAttempt++;

    const delay = this.calculateBackoffDelay(config);
    console.log(`WhatsApp: Reconnection attempt ${this.backoffAttempt}/${config.maxAttempts} in ${delay}ms`);

    this.backoffTimer = setTimeout(async () => {
      try {
        this.sock = null;
        this.isReconnecting = false;
        this.setStatus('disconnected');
        await this.connect();
      } catch (error) {
        this.isReconnecting = false;
        console.error('WhatsApp reconnection attempt failed:', error);
        await this.attemptReconnection();
      }
    }, delay);
  }

  /**
   * Calculate backoff delay with jitter
   */
  private calculateBackoffDelay(config: BackoffConfig): number {
    let delay = config.initialDelay * Math.pow(config.multiplier, this.backoffAttempt - 1);
    delay = Math.min(delay, config.maxDelay);

    const jitterAmount = delay * config.jitter;
    const jitter = (Math.random() * 2 - 1) * jitterAmount;
    delay = Math.round(delay + jitter);

    return Math.max(1000, delay);
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
   * Start deduplication cache cleanup
   */
  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      this.cleanupDedupCache();
    }, this.DEDUP_CACHE_TTL);
  }

  /**
   * Clean up old dedup cache entries
   */
  private cleanupDedupCache(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.processedMessages) {
      if (now - timestamp > this.DEDUP_CACHE_TTL) {
        this.processedMessages.delete(key);
      }
    }
  }

  /**
   * Get group metadata with caching
   */
  private async getGroupMeta(jid: string): Promise<{ subject?: string }> {
    const cached = this.groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }

    try {
      const meta = await this.sock?.groupMetadata(jid);
      const entry = {
        subject: meta?.subject,
        expires: Date.now() + this.GROUP_META_TTL_MS,
      };
      this.groupMetaCache.set(jid, entry);
      return entry;
    } catch {
      return { subject: undefined };
    }
  }

  /**
   * Convert JID to E.164 phone number format
   */
  private jidToE164(jid: string | null | undefined): string | null {
    if (!jid) return null;

    // Remove @s.whatsapp.net or @c.us suffix
    const match = jid.match(/^(\d+)@/);
    if (!match) return null;

    return match[1];
  }

  /**
   * Convert phone number/chat ID to WhatsApp JID
   */
  private toWhatsAppJid(chatId: string): string {
    // Already a JID
    if (chatId.includes('@')) return chatId;

    // Group ID
    if (chatId.includes('-')) {
      return `${chatId}@g.us`;
    }

    // Phone number - remove any non-numeric characters
    const cleaned = chatId.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  /**
   * Extract text from WhatsApp message
   */
  private extractText(message: proto.IMessage | null | undefined): string | undefined {
    if (!message) return undefined;

    // Direct text message
    if (message.conversation) {
      return message.conversation.trim();
    }

    // Extended text message
    if (message.extendedTextMessage?.text) {
      return message.extendedTextMessage.text.trim();
    }

    // Image/video/document caption
    const caption =
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.caption;

    if (caption) return caption.trim();

    return undefined;
  }

  /**
   * Extract media placeholder from message
   */
  private extractMediaPlaceholder(message: proto.IMessage | null | undefined): string | undefined {
    if (!message) return undefined;

    if (message.imageMessage) return '<media:image>';
    if (message.videoMessage) return '<media:video>';
    if (message.audioMessage) return '<media:audio>';
    if (message.documentMessage) return '<media:document>';
    if (message.stickerMessage) return '<media:sticker>';
    if (message.contactMessage) return '<contact>';
    if (message.locationMessage) return '<location>';

    return undefined;
  }

  /**
   * Download audio from a WhatsApp message and return as attachment
   */
  private async downloadAudioAttachment(message: proto.IMessage): Promise<MessageAttachment | null> {
    const audioMessage = message.audioMessage;
    if (!audioMessage) return null;

    try {
      console.log('[WhatsApp] Downloading audio message...');

      // Download the audio content
      const stream = await downloadContentFromMessage(
        audioMessage as DownloadableMessage,
        'audio'
      );

      // Collect the stream into a buffer
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const audioBuffer = Buffer.concat(chunks);

      console.log(`[WhatsApp] Downloaded audio: ${audioBuffer.length} bytes`);

      // Determine mime type (usually audio/ogg for voice messages)
      const mimeType = audioMessage.mimetype || 'audio/ogg; codecs=opus';
      const isVoiceNote = audioMessage.ptt === true;
      const fileName = isVoiceNote
        ? `voice_message_${Date.now()}.ogg`
        : `audio_${Date.now()}.${this.getAudioExtension(mimeType)}`;

      return {
        type: 'audio',
        data: audioBuffer,
        mimeType,
        fileName,
        size: audioBuffer.length,
      };
    } catch (error) {
      console.error('[WhatsApp] Failed to download audio:', error);
      return null;
    }
  }

  /**
   * Get file extension from mime type
   */
  private getAudioExtension(mimeType: string): string {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('webm')) return 'webm';
    return 'audio';
  }

  /**
   * Get status code from disconnect error
   */
  private getStatusCode(err: unknown): number | undefined {
    if (!err) return undefined;

    const asAny = err as any;
    return (
      asAny?.output?.statusCode ||
      asAny?.status ||
      undefined
    );
  }

  /**
   * Ensure directory exists
   */
  private async ensureDir(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

/**
 * Create a WhatsApp adapter from configuration
 */
export function createWhatsAppAdapter(config: WhatsAppConfig): WhatsAppAdapter {
  return new WhatsAppAdapter(config);
}
