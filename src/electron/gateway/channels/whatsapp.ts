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
import { getUserDataDir } from '../../utils/user-data-dir';
import {
  ChannelAdapter,
  ChannelStatus,
  ChannelConfig,
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
import { isLikelyWhatsAppNaturalCommand, stripWhatsAppCommandPreamble } from '../whatsapp-command-utils';

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LID_JID_RE = /^(\d+)@lid$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  while (true) {
    const stripped = candidate.replace(/^whatsapp:/i, '').trim();
    if (stripped === candidate) {
      return candidate;
    }
    candidate = stripped;
  }
}

export function normalizeWhatsAppPhoneTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }

  const userMatch = candidate.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    return userMatch[1];
  }

  const lidMatch = candidate.match(WHATSAPP_LID_JID_RE);
  if (lidMatch) {
    return lidMatch[1];
  }

  if (candidate.includes('@')) {
    return null;
  }

  const digits = candidate.replace(/\D+/g, '');
  return digits.length > 0 ? digits : null;
}

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
  private readonly MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB
  private dedupCleanupTimer?: ReturnType<typeof setTimeout>;

  // Connection state
  private connectedAtMs: number = 0;
  private isReconnecting = false;
  private backoffAttempt = 0;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private currentQr?: string;
  private shouldReconnect = true;
  private selfChatIgnoreLogAt = 0;

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
  private readonly MESSAGE_SEND_RETRY_ATTEMPTS = 3;
  private readonly MESSAGE_SEND_RETRY_BASE_MS = 250;
  private readonly MESSAGE_SEND_RETRY_MAX_MS = 2000;
  private readonly MESSAGE_SEND_RETRY_MULTIPLIER = 1.8;
  private readonly MESSAGE_SEND_RETRY_JITTER = 0.25;

  constructor(config: WhatsAppConfig) {
    this.config = {
      deduplicationEnabled: true,
      sendReadReceipts: true,
      printQrToTerminal: false,
      selfChatMode: true, // Default to self-chat mode since most users use their own number
      responsePrefix: '🤖', // Default prefix for bot responses
      groupRoutingMode: 'mentionsOrCommands',
      ...config,
    };

    // In self-chat mode, disable read receipts by default
    if (this.config.selfChatMode && config.sendReadReceipts === undefined) {
      this.config.sendReadReceipts = false;
      console.log('[WhatsApp] Self-chat mode enabled; defaulting sendReadReceipts to false.');
    }

    // Set auth directory
    this.authDir = config.authDir || path.join(getUserDataDir(), 'whatsapp-auth');
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
    if (typeof this.config.responsePrefix === 'string') {
      return this.config.responsePrefix;
    }
    return '🤖';
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

    this.shouldReconnect = true;
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

    if (!this.shouldReconnect) {
      if (connection === 'open') {
        // If a manual disconnect happened mid-handshake, close immediately.
        this.sock?.ws?.close();
        this.setStatus('disconnected');
      } else if (connection === 'close') {
        this.setStatus('disconnected');
      }
      return;
    }

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

    const rawBody = this.extractText(msg.message) ?? '';
    const body = rawBody.trim();
    const isGroup = isJidGroup(remoteJid) === true;
    const participantJid = msg.key?.participant;
    const quotedMessageContext = this.extractQuotedMessageContext(msg.message);
    const isCommand = body.startsWith('/');
    const isPairingCode = body.length > 0 && this.looksLikePairingCode(body);
    const isNaturalCommand = isLikelyWhatsAppNaturalCommand(body);
    const botMentioned = isGroup ? this.isSelfMentionedInMessage(msg.message, body) : false;
    const shouldRouteGroupMessage = this.shouldRouteGroupMessage(isGroup, {
      isCommand,
      isPairingCode,
      botMentioned,
      isNaturalCommand,
    });

    // CRITICAL: In self-chat mode, only ROUTE messages from self-chat.
    // For ambient workflows we can optionally ingest other chats into the local message log
    // without routing them to the agent (log-only).
    let ingestOnly = false;
    let nonSelfChat = false;
    if (this.isSelfChatMode && this._selfJid) {
      const selfJidNormalized = this.normalizeJid(this._selfJid);
      const remoteJidNormalized = this.normalizeJid(remoteJid);

      if (remoteJidNormalized !== selfJidNormalized) {
        nonSelfChat = true;
        if (this.config.ingestNonSelfChatsInSelfChatMode) {
          ingestOnly = true;
        } else {
          const now = Date.now();
          if (now - this.selfChatIgnoreLogAt > 30000) {
            console.log(
              `WhatsApp: Ignoring message from ${remoteJidNormalized} because self-chat mode is enabled. ` +
              'Disable self-chat mode to accept messages from other numbers.'
            );
            this.selfChatIgnoreLogAt = now;
          }
          // Message is NOT in self-chat, silently ignore it
          return;
        }
      }
    }

    // Deduplication
    if (id && this.config.deduplicationEnabled) {
      const dedupeKey = `${this.normalizeJid(remoteJid)}:${id}`;
      if (this.processedMessages.has(dedupeKey)) return;
      this.processedMessages.set(dedupeKey, Date.now());

      // Cleanup if cache is too large
      if (this.processedMessages.size > this.DEDUP_CACHE_MAX_SIZE) {
        this.cleanupDedupCache();
      }
    }

    const from = isGroup ? remoteJid : this.jidToE164(remoteJid) || remoteJid;
    const senderE164 = isGroup
      ? participantJid ? this.jidToE164(participantJid) : null
      : from;
    const isFromMe = msg.key?.fromMe === true;
    const normalizedText = isGroup ? this.normalizeGroupMessageText(body, botMentioned) : body;
    const groupTextForRouting = isGroup ? stripWhatsAppCommandPreamble(normalizedText) : normalizedText;
    if (isGroup && !shouldRouteGroupMessage) {
      ingestOnly = true;
    }

    // Check access control
    const allowedNumbers = this.getAllowedNumbersSet(this.config.allowedNumbers);
    if (allowedNumbers.size > 0) {
      const senderNumber = senderE164?.replace(/[^0-9]/g, '');
      if (senderNumber && !allowedNumbers.has(senderNumber)) {
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
    if (!normalizedText) {
      // Check for media placeholder
      const mediaPlaceholder = this.extractMediaPlaceholder(msg.message);
      if (!mediaPlaceholder) return;
    }

    // Send read receipt
    if (!ingestOnly && id && this.config.sendReadReceipts && upsertType === 'notify') {
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

    // Download media attachments if present
    const mediaIdSuffix = id ? `-${id}` : '';
    const attachments: MessageAttachment[] = [];

    if (msg.message?.imageMessage) {
      const imageAttachment = await this.downloadMediaMessage({
        media: msg.message.imageMessage as DownloadableMessage,
        mediaType: 'image',
        attachmentType: 'image',
        mimeType: (msg.message.imageMessage as any)?.mimetype,
        fileName: this.extractWaFilename(msg.message.imageMessage as any),
        defaultBaseName: `image${mediaIdSuffix}`,
      });
      if (imageAttachment) {
        attachments.push(imageAttachment);
      }
    }

    if (msg.message?.videoMessage) {
      const videoAttachment = await this.downloadMediaMessage({
        media: msg.message.videoMessage as DownloadableMessage,
        mediaType: 'video',
        attachmentType: 'video',
        mimeType: (msg.message.videoMessage as any)?.mimetype,
        fileName: this.extractWaFilename(msg.message.videoMessage as any),
        defaultBaseName: `video${mediaIdSuffix}`,
      });
      if (videoAttachment) {
        attachments.push(videoAttachment);
      }
    }

    if (msg.message?.documentMessage) {
      const documentAttachment = await this.downloadMediaMessage({
        media: msg.message.documentMessage as DownloadableMessage,
        mediaType: 'document',
        attachmentType: 'document',
        mimeType: (msg.message.documentMessage as any)?.mimetype,
        fileName: this.extractWaFilename(msg.message.documentMessage as any),
        defaultBaseName: `document${mediaIdSuffix}`,
      });
      if (documentAttachment) {
        attachments.push(documentAttachment);
      }
    }

    if (msg.message?.stickerMessage) {
      const stickerAttachment = await this.downloadMediaMessage({
        media: msg.message.stickerMessage as DownloadableMessage,
        mediaType: 'sticker',
        attachmentType: 'image',
        mimeType: (msg.message.stickerMessage as any)?.mimetype,
        fileName: this.extractWaFilename(msg.message.stickerMessage as any),
        defaultBaseName: `sticker${mediaIdSuffix}`,
      });
      if (stickerAttachment) {
        attachments.push(stickerAttachment);
      }
    }

    if (msg.message?.audioMessage) {
      const audioAttachment = await this.downloadAudioAttachment({
        audioMessage: msg.message.audioMessage as DownloadableMessage,
        mimeType: (msg.message.audioMessage as any)?.mimetype,
        isVoiceNote: (msg.message.audioMessage as any)?.ptt === true,
        fileName: this.extractWaFilename(msg.message.audioMessage as any),
        defaultBaseName: `audio${mediaIdSuffix}`,
      });
      if (audioAttachment) {
        attachments.push(audioAttachment);
      }
    }

    const mediaPlaceholder = attachments.length === 0 ? this.extractMediaPlaceholder(msg.message) : '';
    const quotedContextBlock = this.formatQuotedMessageContextBlock(quotedMessageContext);
    const rawText = normalizedText || mediaPlaceholder || '';
    const routingText = isGroup ? (groupTextForRouting || mediaPlaceholder || '') : rawText;
    const textWithReplyContext = quotedContextBlock
      ? (rawText ? `${quotedContextBlock}\n\n${rawText}` : quotedContextBlock)
      : rawText;
    const textForRoutingWithReplyContext = quotedContextBlock
      ? (routingText ? `${quotedContextBlock}\n\n${routingText}` : quotedContextBlock)
      : routingText;

    // Create incoming message
    // Note: In self-chat mode we may ingest other chats into the message log (ingestOnly).
    // If the message is from our own account in a non-self chat, treat it as an outgoing user message.
    const authorId = nonSelfChat && isFromMe
      ? (this._selfE164 || this._selfJid || 'self')
      : (senderE164 || participantJid || remoteJid);
    const authorName = nonSelfChat && isFromMe
      ? 'Me'
      : (msg.pushName || senderE164 || 'Unknown');
    const incomingMessage: IncomingMessage = {
      messageId: id || `wa-${Date.now()}`,
      channel: 'whatsapp',
      userId: authorId,
      userName: authorName,
      chatId: remoteJid,
      isGroup,
      ...(nonSelfChat && isFromMe ? { direction: 'outgoing_user' as const } : {}),
      ...(quotedMessageContext.messageId ? { replyTo: quotedMessageContext.messageId } : {}),
      text: isGroup ? textForRoutingWithReplyContext : textWithReplyContext,
      timestamp: messageTimestampMs ? new Date(messageTimestampMs) : new Date(),
      attachments: attachments.length > 0 ? attachments : undefined,
      ...(ingestOnly ? { ingestOnly: true } : {}),
      metadata: {
        groupRoutingMode: this.config.groupRoutingMode,
        botMentioned,
        groupMessageRoutable: isGroup ? shouldRouteGroupMessage : true,
        ...(quotedMessageContext.body || quotedMessageContext.senderE164 || quotedMessageContext.senderName || quotedMessageContext.senderJid
          ? {
            quotedMessage: {
              messageId: quotedMessageContext.messageId,
              senderJid: quotedMessageContext.senderJid,
              senderE164: quotedMessageContext.senderE164,
              senderName: quotedMessageContext.senderName,
              body: quotedMessageContext.body,
            },
          }
          : {}),
      },
      raw: msg,
    };

    // Notify message handlers
    await this.handleIncomingMessage(incomingMessage);
  }

  /**
   * Disconnect from WhatsApp
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
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
      let didAttachWithCaption = false;
      for (const attachment of message.attachments) {
        try {
          const captionForAttachment = didAttachWithCaption
            ? undefined
            : textToSend?.trim()
              ? textToSend
              : undefined;
          const result = await this.sendWithRetry(
            () => this.sendMediaAttachment(jid, attachment, captionForAttachment),
            'sendMediaAttachment'
          );
          messageId = result;
          didAttachWithCaption = true;
          textToSend = '';
        } catch (error) {
          console.error('Failed to send media attachment; sending fallback message only:', error);
        }
      }
    }

    // Send text message if no media or text remains
    if (textToSend && textToSend.trim()) {
      // Send composing presence
      await this.sendComposingTo(jid);

      const result = await this.sendWithRetry(
        () => this.sock!.sendMessage(jid, { text: textToSend }),
        'sendText'
      );
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

    const resolvedType = attachment.type === 'file' ? 'document' : attachment.type;
    const payload = await this.resolveAttachmentPayload(attachment);

    if (!payload || payload.length === 0) {
      throw new Error(`No payload for attachment: ${attachment.fileName || attachment.type}`);
    }

    if (payload.length > this.MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment too large: ${payload.length} bytes`);
    }
    if (attachment.size && attachment.size > this.MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment metadata size exceeds limit: ${attachment.size} bytes`);
    }

    const isVoiceNote = attachment.isVoiceNote === true;
    const fileUrlName = this.extractAttachmentFileNameFromUrl(attachment.url);
    const inferredDocumentExt = this.inferAttachmentExtension(attachment.mimeType, resolvedType, attachment.fileName || fileUrlName);
    const documentFileName = this.normalizeAttachmentName(
      attachment.fileName || fileUrlName || `document.${inferredDocumentExt}`,
      inferredDocumentExt
    );

    let content: AnyMessageContent;

    if (resolvedType === 'image') {
      content = {
        image: payload,
        caption,
        mimetype: attachment.mimeType || 'image/jpeg',
      };
    } else if (resolvedType === 'document') {
      content = {
        document: payload,
        fileName: documentFileName,
        mimetype: attachment.mimeType || 'application/octet-stream',
        caption,
      };
    } else if (resolvedType === 'audio') {
      content = {
        audio: payload,
        mimetype: attachment.mimeType || 'audio/mpeg',
        ptt: isVoiceNote,
      };
    } else if (resolvedType === 'video') {
      content = {
        video: payload,
        caption,
        mimetype: attachment.mimeType || 'video/mp4',
      };
    } else {
      throw new Error(`Unsupported attachment type: ${attachment.type}`);
    }

    const result = await this.sendWithRetry(
      () => this.sock!.sendMessage(jid, content),
      'sendMediaAttachment'
    );
    return result?.key?.id || `wa-${Date.now()}`;
  }

  /**
   * Resolve attachment data from either in-memory payload or local/remote URL.
   */
  private async resolveAttachmentPayload(attachment: MessageAttachment): Promise<Buffer | null> {
    if (attachment.data && attachment.data.length > 0) {
      return attachment.data;
    }

    const source = attachment.url?.trim();
    if (!source) {
      return null;
    }

    if (fs.existsSync(source)) {
      const fileStats = fs.statSync(source);
      if (!fileStats.isFile()) {
        throw new Error(`Attachment source is not a file: ${source}`);
      }
      if (fileStats.size > this.MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment file exceeds size limit: ${fileStats.size} bytes`);
      }
      return fs.readFileSync(source);
    }

    if (/^file:\/\//i.test(source)) {
      const filePath = decodeURIComponent(new URL(source).pathname || '');
      if (filePath && fs.existsSync(filePath)) {
        const fileStats = fs.statSync(filePath);
        if (!fileStats.isFile()) {
          throw new Error(`Attachment source is not a file: ${filePath}`);
        }
        if (fileStats.size > this.MAX_ATTACHMENT_BYTES) {
          throw new Error(`Attachment file exceeds size limit: ${fileStats.size} bytes`);
        }
        return fs.readFileSync(filePath);
      }
    }

    if (/^https?:\/\//i.test(source) || source.startsWith('data:')) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to download attachment from URL: ${response.status} ${response.statusText}`);
      }
      const headerLength = response.headers.get('content-length');
      if (headerLength) {
        const contentLength = Number.parseInt(headerLength, 10);
        if (Number.isFinite(contentLength) && contentLength > this.MAX_ATTACHMENT_BYTES) {
          throw new Error(`Remote attachment exceeds size limit: ${contentLength} bytes`);
        }
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    return null;
  }

  /**
   * Extract a stable file name from an attachment URL or path.
   */
  private extractAttachmentFileNameFromUrl(url?: string): string | undefined {
    if (!url) {
      return undefined;
    }

    const trimmed = url.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed);
      const base = path.basename(parsed.pathname || '');
      return base && base !== '/' && base !== '.' ? base : undefined;
    } catch {
      const base = path.basename(trimmed);
      return base && base !== '.' ? base : undefined;
    }
  }

  /**
   * Send operation with retry + exponential jitter.
   */
  private async sendWithRetry<T>(operation: () => Promise<T>, operationName = 'operation'): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.MESSAGE_SEND_RETRY_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= this.MESSAGE_SEND_RETRY_ATTEMPTS) {
          break;
        }

        const delayMs = this.calculateSendRetryDelay(attempt);
        console.warn(`[WhatsApp] ${operationName} attempt ${attempt} failed, retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(
      `WhatsApp ${operationName} failed after ${this.MESSAGE_SEND_RETRY_ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : 'Unknown error'
      }`
    );
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private calculateSendRetryDelay(attempt: number): number {
    const exponentialDelay = Math.min(
      this.MESSAGE_SEND_RETRY_MAX_MS,
      this.MESSAGE_SEND_RETRY_BASE_MS * Math.pow(this.MESSAGE_SEND_RETRY_MULTIPLIER, attempt - 1)
    );
    const jitter = exponentialDelay * this.MESSAGE_SEND_RETRY_JITTER;
    const minDelay = Math.max(150, exponentialDelay - jitter);
    const maxDelay = exponentialDelay + jitter;
    return Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
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
   * Update adapter configuration at runtime
   */
  updateConfig(config: ChannelConfig): void {
    const next = config as Partial<WhatsAppConfig>;
    const prevDedupEnabled = this.config.deduplicationEnabled !== false;
    const prevSelfChat = this.config.selfChatMode === true;

    this.config = {
      ...this.config,
      ...next,
    };

    // If self-chat was just enabled and read receipts weren't explicitly set, default to false.
    if (!prevSelfChat && this.config.selfChatMode && next.sendReadReceipts === undefined) {
      this.config.sendReadReceipts = false;
      console.log('[WhatsApp] Self-chat mode enabled; defaulting sendReadReceipts to false.');
    }

    const nextDedupEnabled = this.config.deduplicationEnabled !== false;
    if (nextDedupEnabled && !prevDedupEnabled) {
      this.startDedupCleanup();
    } else if (!nextDedupEnabled && prevDedupEnabled) {
      if (this.dedupCleanupTimer) {
        clearInterval(this.dedupCleanupTimer);
        this.dedupCleanupTimer = undefined;
      }
      this.processedMessages.clear();
    }
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
    if (!this.shouldReconnect) {
      return;
    }

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
        if (!this.shouldReconnect) {
          this.isReconnecting = false;
          return;
        }

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
    return normalizeWhatsAppPhoneTarget(jid);
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

  private extractQuotedMessageContext(message: proto.IMessage | null | undefined): {
    messageId?: string;
    senderJid?: string;
    senderE164?: string;
    senderName?: string;
    body?: string;
  } {
    const contextInfo =
      (message as any)?.extendedTextMessage?.contextInfo ??
      (message as any)?.imageMessage?.contextInfo ??
      (message as any)?.videoMessage?.contextInfo ??
      (message as any)?.documentMessage?.contextInfo ??
      (message as any)?.audioMessage?.contextInfo ??
      (message as any)?.stickerMessage?.contextInfo;

    if (!contextInfo) {
      return {};
    }

    const quotedMessage = typeof contextInfo.quotedMessage === 'object'
      ? (contextInfo.quotedMessage as proto.IMessage)
      : undefined;
    const senderJid = typeof contextInfo.participant === 'string' ? contextInfo.participant : undefined;
    const senderE164 = senderJid ? (this.jidToE164(senderJid) ?? undefined) : undefined;
    const quotedBody = this.extractText(quotedMessage)?.trim();
    const quotedMediaPlaceholder = quotedMessage
      ? this.extractMediaPlaceholder(quotedMessage as proto.IMessage)
      : undefined;

    const quotedText = quotedBody
      ? quotedBody
      : (typeof contextInfo.quotedMessageText === 'string' && contextInfo.quotedMessageText.trim())
        ? contextInfo.quotedMessageText.trim()
        : quotedMediaPlaceholder;

    return {
      messageId:
        typeof contextInfo.stanzaId === 'string'
          ? contextInfo.stanzaId
          : (typeof contextInfo.quotedMessageId === 'string'
            ? contextInfo.quotedMessageId
            : undefined),
      senderJid,
      senderE164,
      senderName: senderE164 ?? senderJid ?? undefined,
      body: quotedText ? this.truncateTextForReplyContext(quotedText, 500) : undefined,
    };
  }

  private formatQuotedMessageContextBlock(context: {
    senderE164?: string;
    senderName?: string;
    body?: string;
  }): string | undefined {
    const rawBody = (context.body || '').trim();
    if (!rawBody) return undefined;

    const quotedFrom = context.senderName || context.senderE164 || 'a previous message';
    return `💬 In reply to ${quotedFrom}\n> ${rawBody.replace(/\n/g, '\n> ')}`;
  }

  private truncateTextForReplyContext(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength).trimEnd()}…`;
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
  private async downloadAudioAttachment(params: {
    audioMessage: DownloadableMessage;
    mimeType?: string;
    isVoiceNote?: boolean;
    fileName?: string;
    defaultBaseName?: string;
  }): Promise<MessageAttachment | null> {
    const defaultBaseName = params.isVoiceNote
      ? `voice_message${params.defaultBaseName ? `-${params.defaultBaseName}` : ''}`
      : (params.defaultBaseName || 'audio');
    return this.downloadMediaMessage({
      media: params.audioMessage,
      mediaType: 'audio',
      attachmentType: 'audio',
      mimeType: params.mimeType,
      fileName: params.fileName,
      defaultBaseName,
      isVoiceNote: params.isVoiceNote,
    });
  }

  private async downloadMediaMessage(params: {
    media: DownloadableMessage;
    mediaType: 'audio' | 'image' | 'video' | 'document' | 'sticker';
    attachmentType: MessageAttachment['type'];
    mimeType?: string;
    fileName?: string;
    isVoiceNote?: boolean;
    defaultBaseName: string;
  }): Promise<MessageAttachment | null> {
    try {
      const buffer = await this.bufferFromWhatsAppMedia(params.media, params.mediaType);
      if (!buffer.length || buffer.length > this.MAX_ATTACHMENT_BYTES) {
        console.warn('[WhatsApp] Attachment download skipped (size unacceptable):', params.defaultBaseName, buffer.length);
        return null;
      }

      const ext = this.inferAttachmentExtension(params.mimeType, params.attachmentType, params.fileName);
      const fileName = this.normalizeAttachmentName(params.fileName || `${params.defaultBaseName}.${ext}`, ext);

      return {
        type: params.attachmentType,
        data: buffer,
        mimeType: params.mimeType,
        fileName,
        size: buffer.length,
        isVoiceNote: params.isVoiceNote,
      };
    } catch (error) {
      console.error('[WhatsApp] Failed to download attachment:', error);
      return null;
    }
  }

  private async bufferFromWhatsAppMedia(
    media: DownloadableMessage,
    mediaType: 'audio' | 'image' | 'video' | 'document' | 'sticker'
  ): Promise<Buffer> {
    const stream = await downloadContentFromMessage(media, mediaType);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private normalizeAttachmentName(fileName: string, ext: string): string {
    const trimmed = fileName.trim();
    const currentExt = path.extname(trimmed);
    if (currentExt) {
      return trimmed;
    }
    const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
    return `${safe}.${ext || 'bin'}`;
  }

  private inferAttachmentExtension(
    mimeType: string | undefined,
    attachmentType: MessageAttachment['type'],
    fileName?: string
  ): string {
    const explicitExt = fileName ? path.extname(fileName).replace(/^\./, '').toLowerCase() : '';
    if (explicitExt) return explicitExt;

    if (!mimeType) {
      return attachmentType === 'audio' ? 'ogg' : attachmentType === 'image' ? 'jpg' : 'bin';
    }

    const mime = mimeType.toLowerCase();
    if (mime.includes('image/jpeg')) return 'jpg';
    if (mime.includes('image/png')) return 'png';
    if (mime.includes('image/webp')) return 'webp';
    if (mime.includes('image/gif')) return 'gif';
    if (mime.includes('image/bmp')) return 'bmp';
    if (mime.includes('audio/mpeg') || mime.includes('audio/mp3')) return 'mp3';
    if (mime.includes('audio/m4a') || mime.includes('audio/aac')) return 'm4a';
    if (mime.includes('audio/ogg')) return 'ogg';
    if (mime.includes('audio/wav')) return 'wav';
    if (mime.includes('audio/aac')) return 'm4a';
    if (mime.includes('audio/webm')) return 'webm';
    if (mime.includes('video/mp4')) return 'mp4';
    if (mime.includes('video/webm')) return 'webm';
    if (mime.includes('video/quicktime')) return 'mov';
    if (mime.includes('application/pdf')) return 'pdf';
    if (mime.includes('text/plain')) return 'txt';
    return attachmentType === 'audio' ? 'ogg' : attachmentType === 'image' ? 'jpg' : 'bin';
  }

  private extractWaFilename(message: { fileName?: string } | null | undefined): string | undefined {
    const candidate = message?.fileName?.trim();
    return candidate && candidate.length > 0 ? candidate : undefined;
  }

  /**
   * Check if text looks like a pairing code.
   */
  private looksLikePairingCode(text: string): boolean {
    return /^[A-Z0-9]{6,8}$/i.test(text);
  }

  /**
   * Normalize a WhatsApp JID (removes device suffix like :x).
   */
  private normalizeJid(jid: string): string {
    const candidate = stripWhatsAppTargetPrefixes(jid);
    return candidate.replace(/:\d+@/, '@');
  }

  /**
   * Strip non-digits from a phone/JID value.
   */
  private extractDigits(value: string): string {
    return value.replace(/\D+/g, '');
  }

  /**
   * Candidate tokens that identify the bot account.
   */
  private getBotMentionTokens(): string[] {
    const tokens = new Set<string>();

    if (this._selfJid) {
      tokens.add(this.normalizeJid(this._selfJid));
      tokens.add(this.extractDigits(this._selfJid));
    }

    if (this._selfE164) {
      tokens.add(this._selfE164);
      tokens.add(`@${this._selfE164}`);
      tokens.add(this.normalizeJid(`${this._selfE164}@s.whatsapp.net`));
    }

    return [...tokens].filter(Boolean);
  }

  /**
   * Extract mention-like tokens from text (e.g. '@1415...', '@cowork').
   */
  private extractMentionTokensFromText(text: string): string[] {
    return text
      .match(/@[^\s@.,!?;:\)\]]+/g)
      ?.map((token) => token.trim())
      ?.filter((token) => token.length > 1) ?? [];
  }

  private getAllowedNumbersSet(allowedNumbers: unknown): Set<string> {
    if (!Array.isArray(allowedNumbers) || allowedNumbers.length === 0) {
      return new Set();
    }

    const values = allowedNumbers
      .filter((value): value is string => typeof value === 'string')
      .map((value) => normalizeWhatsAppPhoneTarget(value))
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => {
        const normalized = value.replace(/[^0-9]/g, '').trim();
        return normalized.length >= 5 ? [normalized] : [];
      });

    return new Set(values);
  }

  /**
   * Check whether this group message mentions the bot.
   */
  private isSelfMentionedInMessage(message: proto.IMessage | null | undefined, text: string): boolean {
    const botTokens = this.getBotMentionTokens();
    const botDigits = new Set(botTokens.map((token) => this.extractDigits(token)));
    if (botDigits.size === 0) {
      return false;
    }

    const contextInfo =
      (message as any)?.extendedTextMessage?.contextInfo ??
      (message as any)?.imageMessage?.contextInfo ??
      (message as any)?.videoMessage?.contextInfo ??
      (message as any)?.documentMessage?.contextInfo;

    const mentionedJids = Array.isArray(contextInfo?.mentionedJid)
      ? contextInfo.mentionedJid
      : [];

    for (const mentioned of mentionedJids) {
      if (typeof mentioned === 'string' && botDigits.has(this.extractDigits(mentioned))) {
        return true;
      }
    }

    for (const mention of this.extractMentionTokensFromText(text)) {
      if (botDigits.has(this.extractDigits(mention))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine whether a group message should be routed to the agent.
   */
  private shouldRouteGroupMessage(
    isGroup: boolean,
    params: {
      isCommand: boolean;
      isPairingCode: boolean;
      botMentioned: boolean;
      isNaturalCommand: boolean;
    }
  ): boolean {
    if (!isGroup) {
      return true;
    }

    if (params.isPairingCode) {
      return true;
    }

    const mode = this.config.groupRoutingMode || 'mentionsOrCommands';
    if (mode === 'all') {
      return true;
    }
    if (mode === 'mentionsOrCommands') {
      return params.botMentioned || params.isCommand || params.isNaturalCommand;
    }
    if (mode === 'commandsOnly') {
      return params.isCommand || params.isNaturalCommand;
    }
    if (mode === 'mentionsOnly') {
      return params.botMentioned;
    }
    return params.botMentioned || params.isCommand || params.isNaturalCommand;
  }

  /**
   * Normalize group messages by removing self mentions before forwarding.
   */
  private normalizeGroupMessageText(body: string, botMentioned: boolean): string {
    if (!botMentioned) {
      return body;
    }

    const botDigits = new Set(
      this.getBotMentionTokens().map((token) => this.extractDigits(token)).filter(Boolean)
    );

    let normalized = body;
    const mentions = this.extractMentionTokensFromText(body);

    for (const mention of mentions) {
      if (!botDigits.has(this.extractDigits(mention))) {
        continue;
      }

      const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tokenPattern = new RegExp(`\\s*${escaped}\\s*`, 'gi');
      normalized = normalized.replace(tokenPattern, ' ');
    }

    return normalized.replace(/\s+/g, ' ').trim();
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
