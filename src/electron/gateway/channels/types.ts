/**
 * Channel Gateway Types
 *
 * Defines interfaces for multi-channel messaging support.
 * Each channel (Telegram, Discord, etc.) implements the ChannelAdapter interface.
 */

/**
 * Supported channel types
 */
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp';

/**
 * Channel connection status
 */
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Incoming message from any channel
 */
export interface IncomingMessage {
  /** Unique message ID from the channel */
  messageId: string;
  /** Channel type */
  channel: ChannelType;
  /** User identifier on the channel */
  userId: string;
  /** User display name */
  userName: string;
  /** Chat/conversation ID (for group chats) */
  chatId: string;
  /** Message content */
  text: string;
  /** Timestamp */
  timestamp: Date;
  /** Optional reply-to message ID */
  replyTo?: string;
  /** Optional attachments */
  attachments?: MessageAttachment[];
  /** Raw message object from the channel SDK */
  raw?: unknown;
}

/**
 * Outgoing message to any channel
 */
export interface OutgoingMessage {
  /** Target chat/conversation ID */
  chatId: string;
  /** Message content */
  text: string;
  /** Optional reply-to message ID */
  replyTo?: string;
  /** Parse mode for formatting */
  parseMode?: 'text' | 'markdown' | 'html';
  /** Optional attachments */
  attachments?: MessageAttachment[];
}

/**
 * Message attachment (file, image, etc.)
 */
export interface MessageAttachment {
  type: 'file' | 'image' | 'audio' | 'video' | 'document';
  /** URL or file path */
  url?: string;
  /** File data buffer */
  data?: Buffer;
  /** MIME type */
  mimeType?: string;
  /** File name */
  fileName?: string;
  /** File size in bytes */
  size?: number;
}

/**
 * Channel configuration base
 */
export interface ChannelConfig {
  /** Whether this channel is enabled */
  enabled: boolean;
  /** Channel-specific settings */
  [key: string]: unknown;
}

/**
 * Telegram-specific configuration
 */
export interface TelegramConfig extends ChannelConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Webhook URL (optional, uses polling if not set) */
  webhookUrl?: string;
}

/**
 * Discord-specific configuration (future)
 */
export interface DiscordConfig extends ChannelConfig {
  /** Bot token */
  botToken: string;
  /** Application ID */
  applicationId: string;
  /** Guild IDs to operate in (empty = all guilds) */
  guildIds?: string[];
}

/**
 * Slack-specific configuration
 */
export interface SlackConfig extends ChannelConfig {
  /** Bot token (xoxb-...) */
  botToken: string;
  /** App token for Socket Mode (xapp-...) */
  appToken: string;
  /** Signing secret for verifying requests */
  signingSecret?: string;
}

/**
 * Channel adapter interface
 * All channel implementations must implement this interface
 */
export interface ChannelAdapter {
  /** Channel type identifier */
  readonly type: ChannelType;

  /** Current connection status */
  readonly status: ChannelStatus;

  /** Bot/app username on the channel */
  readonly botUsername?: string;

  /**
   * Connect to the channel
   * @throws Error if connection fails
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the channel
   */
  disconnect(): Promise<void>;

  /**
   * Send a message to a chat
   * @param message The message to send
   * @returns The sent message ID
   */
  sendMessage(message: OutgoingMessage): Promise<string>;

  /**
   * Edit an existing message
   * @param chatId Chat ID
   * @param messageId Message ID to edit
   * @param text New text content
   */
  editMessage?(chatId: string, messageId: string, text: string): Promise<void>;

  /**
   * Delete a message
   * @param chatId Chat ID
   * @param messageId Message ID to delete
   */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;

  /**
   * Send a document/file to a chat
   * @param chatId Chat ID
   * @param filePath Path to the file to send
   * @param caption Optional caption for the file
   * @returns The sent message ID
   */
  sendDocument?(chatId: string, filePath: string, caption?: string): Promise<string>;

  /**
   * Send a photo/image to a chat
   * @param chatId Chat ID
   * @param filePath Path to the image file to send
   * @param caption Optional caption for the image
   * @returns The sent message ID
   */
  sendPhoto?(chatId: string, filePath: string, caption?: string): Promise<string>;

  /**
   * Register a message handler
   * @param handler Function to call when a message is received
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Register an error handler
   * @param handler Function to call when an error occurs
   */
  onError(handler: ErrorHandler): void;

  /**
   * Register a status change handler
   * @param handler Function to call when status changes
   */
  onStatusChange(handler: StatusHandler): void;

  /**
   * Get channel-specific info (bot info, etc.)
   */
  getInfo(): Promise<ChannelInfo>;
}

/**
 * Message handler callback
 */
export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

/**
 * Error handler callback
 */
export type ErrorHandler = (error: Error, context?: string) => void;

/**
 * Status change handler callback
 */
export type StatusHandler = (status: ChannelStatus, error?: Error) => void;

/**
 * Channel information
 */
export interface ChannelInfo {
  type: ChannelType;
  status: ChannelStatus;
  botId?: string;
  botUsername?: string;
  botDisplayName?: string;
  /** Additional channel-specific info */
  extra?: Record<string, unknown>;
}

/**
 * Channel user - represents a user on a specific channel
 */
export interface ChannelUser {
  /** Internal user ID */
  id: string;
  /** Channel type */
  channel: ChannelType;
  /** User ID on the channel */
  channelUserId: string;
  /** User display name */
  displayName: string;
  /** Username (if available) */
  username?: string;
  /** Whether this user is allowed to interact */
  allowed: boolean;
  /** Pairing code (if pending) */
  pairingCode?: string;
  /** When the user was first seen */
  createdAt: Date;
  /** Last interaction time */
  lastSeenAt: Date;
}

/**
 * Channel session - links a channel chat to a CoWork task
 */
export interface ChannelSession {
  /** Session ID */
  id: string;
  /** Channel type */
  channel: ChannelType;
  /** Chat ID on the channel */
  chatId: string;
  /** Associated CoWork task ID (if any) */
  taskId?: string;
  /** Associated workspace ID */
  workspaceId?: string;
  /** Session state */
  state: 'idle' | 'active' | 'waiting_approval';
  /** Session context/memory */
  context?: Record<string, unknown>;
  /** Created timestamp */
  createdAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
}

/**
 * Security configuration for channel access
 */
export interface SecurityConfig {
  /** Access mode */
  mode: 'open' | 'allowlist' | 'pairing';
  /** Allowed user IDs (for allowlist mode) */
  allowedUsers?: string[];
  /** Pairing code TTL in seconds (for pairing mode) */
  pairingCodeTTL?: number;
  /** Maximum pairing attempts */
  maxPairingAttempts?: number;
  /** Rate limit: messages per minute */
  rateLimitPerMinute?: number;
}

/**
 * Gateway event types
 */
export type GatewayEventType =
  | 'channel:connected'
  | 'channel:disconnected'
  | 'channel:error'
  | 'message:received'
  | 'message:sent'
  | 'user:paired'
  | 'user:blocked'
  | 'session:created'
  | 'session:ended';

/**
 * Gateway event
 */
export interface GatewayEvent {
  type: GatewayEventType;
  channel?: ChannelType;
  timestamp: Date;
  data?: Record<string, unknown>;
}

/**
 * Gateway event handler
 */
export type GatewayEventHandler = (event: GatewayEvent) => void;
