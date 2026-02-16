/**
 * Channel Gateway Types
 *
 * Defines interfaces for multi-channel messaging support.
 * Each channel (Telegram, Discord, etc.) implements the ChannelAdapter interface.
 */

/**
 * Supported channel types
 */
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'imessage' | 'signal' | 'mattermost' | 'matrix' | 'twitch' | 'line' | 'bluebubbles' | 'email' | 'teams' | 'googlechat';

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
  /** Whether this message is from a group chat */
  isGroup?: boolean;
  /**
   * Optional direction hint for persistence.
   * Default: incoming
   */
  direction?: 'incoming' | 'outgoing_user';
  /**
   * If true, the gateway will persist this message but will NOT route it to the agent
   * or send any replies (useful for ambient/monitoring ingestion).
   */
  ingestOnly?: boolean;
  /** Message content */
  text: string;
  /** Timestamp */
  timestamp: Date;
  /** Optional reply-to message ID */
  replyTo?: string;
  /** Optional attachments */
  attachments?: MessageAttachment[];
  /** Optional channel-specific metadata */
  metadata?: Record<string, unknown>;
  /** Forum topic thread ID (Telegram) */
  threadId?: string;
  /** Whether this is a forum topic message */
  isForumTopic?: boolean;
  /** Raw message object from the channel SDK */
  raw?: unknown;
}

/**
 * Inline keyboard button
 */
export interface InlineKeyboardButton {
  /** Button label text */
  text: string;
  /** Callback data sent when button is pressed */
  callbackData?: string;
  /** URL to open when button is pressed */
  url?: string;
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
  /** Forum topic thread ID (Telegram) */
  threadId?: string;
  /** Inline keyboard buttons (rows of buttons) */
  inlineKeyboard?: InlineKeyboardButton[][];
  /** Disable link preview (default: false) */
  disableLinkPreview?: boolean;
}

/**
 * Callback query from inline keyboard button press
 */
export interface CallbackQuery {
  /** Unique callback query ID */
  id: string;
  /** User who pressed the button */
  userId: string;
  /** User display name */
  userName: string;
  /** Chat ID where button was pressed */
  chatId: string;
  /** Message ID containing the button */
  messageId: string;
  /** Callback data from the button */
  data: string;
  /** Forum topic thread ID (if in forum) */
  threadId?: string;
  /** Raw callback query object */
  raw?: unknown;
}

/**
 * Callback query handler
 */
export type CallbackQueryHandler = (query: CallbackQuery) => void | Promise<void>;

/**
 * Message attachment (file, image, etc.)
 */
export interface MessageAttachment {
  type: 'file' | 'image' | 'audio' | 'video' | 'document';
  /** URL or file path */
  url?: string;
  /** File data buffer */
  data?: Buffer;
  /** Indicates if an audio attachment should be sent as a WhatsApp voice note */
  isVoiceNote?: boolean;
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
  /** Default agent role ID for tasks created from this channel */
  defaultAgentRoleId?: string;
  /** Default workspace ID for this channel (overrides router default) */
  defaultWorkspaceId?: string;
  /** Allowed agent role IDs (empty = all allowed) */
  allowedAgentRoleIds?: string[];
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
 * WhatsApp-specific configuration
 */
export interface WhatsAppConfig extends ChannelConfig {
  /** Directory to store auth credentials (optional, defaults to app data) */
  authDir?: string;
  /** Print QR code to terminal for debugging */
  printQrToTerminal?: boolean;
  /** Send read receipts for incoming messages (default: true) */
  sendReadReceipts?: boolean;
  /** Allowed phone numbers in E.164 format without + (e.g., "14155551234") */
  allowedNumbers?: string[];
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /**
   * Group routing policy:
   * - all: route every group message
   * - mentionsOnly: route only messages mentioning the bot
   * - mentionsOrCommands: route mentions or command-style messages
   * - commandsOnly: route slash or natural commands
   *
   * Defaults to mentionsOrCommands to reduce group noise.
   */
  groupRoutingMode?: 'all' | 'mentionsOnly' | 'mentionsOrCommands' | 'commandsOnly';
  /**
   * Self-chat mode: When true, the bot is running on the same WhatsApp account
   * as the user (messaging yourself). This mode:
   * - Disables read receipts (to avoid marking your own messages as read)
   * - Adds a response prefix to distinguish bot messages from user messages
   */
  selfChatMode?: boolean;
  /**
   * Ambient mode:
   * - true: all non-command inbound messages are ingested and never routed.
   * - false: normal routing rules apply (subject to command and authorization checks).
   *
   * Useful for monitoring a busy conversation stream while keeping command-based interaction.
   */
  ambientMode?: boolean;
  /**
   * Prefix to add to bot responses (e.g., "[CoWork]" or "🤖")
   * Only used when selfChatMode is true. Default: "🤖"
   */
  responsePrefix?: string;
  /**
   * When selfChatMode is enabled, also ingest messages from other chats (DMs/groups) into the local
   * message log without routing them to the agent (ambient/log-only).
   *
   * This enables scheduled digests/follow-up extraction across your existing chats while still
   * preventing the bot from responding outside the self-chat.
   */
  ingestNonSelfChatsInSelfChatMode?: boolean;
}

/**
 * iMessage-specific configuration
 * Uses imsg CLI (brew install steipete/tap/imsg) for communication
 */
export interface ImessageConfig extends ChannelConfig {
  /** Path to imsg CLI (default: "imsg") */
  cliPath?: string;
  /** Path to Messages database (default: ~/Library/Messages/chat.db) */
  dbPath?: string;
  /** DM access policy (default: "pairing") */
  dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  /** Group access policy (default: "allowlist") */
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  /** Allowed contacts (phone numbers, emails, or chat_id:*) */
  allowedContacts?: string[];
  /** Include attachments in context (default: false) */
  includeAttachments?: boolean;
  /** Max media size in MB (default: 16) */
  mediaMaxMb?: number;
  /** iMessage service preference */
  service?: 'imessage' | 'sms' | 'auto';
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /**
   * Capture messages that are "from me" (sent by the local Messages account).
   * When enabled, these messages are ingested into the local message log as direction=outgoing_user
   * and marked ingestOnly to avoid reply loops.
   */
  captureSelfMessages?: boolean;
}

/**
 * Signal-specific configuration
 * Uses signal-cli for communication (https://github.com/AsamK/signal-cli)
 */
export interface SignalConfig extends ChannelConfig {
  /** Phone number to use (E.164 format, e.g., +14155551234) */
  phoneNumber: string;
  /** Path to signal-cli (default: "signal-cli") */
  cliPath?: string;
  /** signal-cli data directory (default: ~/.local/share/signal-cli) */
  dataDir?: string;
  /** Configuration mode */
  mode?: 'native' | 'daemon';
  /** JSON-RPC socket path (for daemon mode) */
  socketPath?: string;
  /** Trust mode for new contacts */
  trustMode?: 'tofu' | 'always' | 'manual';
  /** DM access policy (default: "pairing") */
  dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  /** Group access policy (default: "allowlist") */
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  /** Allowed phone numbers (E.164 format) */
  allowedNumbers?: string[];
  /** Enable read receipts (default: true) */
  sendReadReceipts?: boolean;
  /** Enable typing indicators (default: true) */
  sendTypingIndicators?: boolean;
  /** Max attachment size in MB (default: 100) */
  maxAttachmentMb?: number;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Poll interval for receiving messages in ms (default: 1000) */
  pollInterval?: number;
}

/**
 * Mattermost-specific configuration
 */
export interface MattermostConfig extends ChannelConfig {
  /** Mattermost server URL (e.g., https://mattermost.example.com) */
  serverUrl: string;
  /** Personal access token */
  token: string;
  /** Team ID to operate in (optional) */
  teamId?: string;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
}

/**
 * Matrix-specific configuration
 */
export interface MatrixConfig extends ChannelConfig {
  /** Matrix homeserver URL (e.g., https://matrix.org) */
  homeserver: string;
  /** User ID (e.g., @user:matrix.org) */
  userId: string;
  /** Access token */
  accessToken: string;
  /** Device ID (optional) */
  deviceId?: string;
  /** Room IDs to listen to (optional, listens to all joined rooms if not specified) */
  roomIds?: string[];
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Send typing indicators (default: true) */
  sendTypingIndicators?: boolean;
  /** Send read receipts (default: true) */
  sendReadReceipts?: boolean;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
}

/**
 * Twitch-specific configuration
 */
export interface TwitchConfig extends ChannelConfig {
  /** Twitch username (login name) */
  username: string;
  /** OAuth token (with oauth: prefix or without) */
  oauthToken: string;
  /** Channels to join (without # prefix) */
  channels: string[];
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Whether to respond to whispers (DMs) - default: false */
  allowWhispers?: boolean;
}

/**
 * LINE-specific configuration
 * Uses LINE Messaging API for communication
 */
export interface LineConfig extends ChannelConfig {
  /** LINE Channel Access Token (long-lived) */
  channelAccessToken: string;
  /** LINE Channel Secret (for webhook signature verification) */
  channelSecret: string;
  /** Webhook port to listen on (default: 3100) */
  webhookPort?: number;
  /** Webhook path (default: /line/webhook) */
  webhookPath?: string;
  /** Response prefix for bot messages */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Whether to use reply tokens (faster) or push messages */
  useReplyTokens?: boolean;
}

/**
 * BlueBubbles-specific configuration
 * Uses BlueBubbles REST API for iMessage integration
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
  /**
   * Capture messages that are "from me" (sent by the linked iMessage account).
   * When enabled, these messages are ingested into the local message log as direction=outgoing_user
   * and marked ingestOnly to avoid reply loops.
   */
  captureSelfMessages?: boolean;
}

/**
 * Email-specific configuration
 * Uses IMAP for receiving and SMTP for sending
 */
export interface EmailConfig extends ChannelConfig {
  /** IMAP server host */
  imapHost: string;
  /** IMAP server port (default: 993) */
  imapPort?: number;
  /** IMAP use SSL/TLS (default: true) */
  imapSecure?: boolean;
  /** SMTP server host */
  smtpHost: string;
  /** SMTP server port (default: 587) */
  smtpPort?: number;
  /** SMTP use SSL/TLS (default: false for STARTTLS) */
  smtpSecure?: boolean;
  /** Email address (used for both IMAP and SMTP) */
  email: string;
  /** Password or app password */
  password: string;
  /** Display name for outgoing emails */
  displayName?: string;
  /** IMAP mailbox to monitor (default: INBOX) */
  mailbox?: string;
  /** Poll interval in ms for IMAP IDLE fallback (default: 30000) */
  pollInterval?: number;
  /** Mark emails as read after processing (default: true) */
  markAsRead?: boolean;
  /** Response prefix for bot replies */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Allowed sender addresses (empty = allow all) */
  allowedSenders?: string[];
  /** Subject prefix filter (only process emails with this prefix) */
  subjectFilter?: string;
}

/**
 * Microsoft Teams-specific configuration
 */
export interface TeamsConfig extends ChannelConfig {
  /** Microsoft App ID from Azure Bot registration */
  appId: string;
  /** Microsoft App Password (Client Secret) from Azure Bot registration */
  appPassword: string;
  /** Tenant ID for single-tenant apps (optional, uses multi-tenant if not set) */
  tenantId?: string;
  /** Bot display name */
  displayName?: string;
  /** Webhook endpoint port (default: 3978) */
  webhookPort?: number;
  /** Response prefix for bot replies */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Auto-reconnect on connection failure (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
}

/**
 * Google Chat-specific configuration
 * Uses Google Chat API with service account authentication
 */
export interface GoogleChatConfig extends ChannelConfig {
  /** Path to service account JSON key file */
  serviceAccountKeyPath?: string;
  /** Service account credentials JSON (alternative to keyPath) */
  serviceAccountKey?: {
    client_email: string;
    private_key: string;
    project_id: string;
  };
  /** Google Cloud project ID */
  projectId?: string;
  /** Webhook port to listen on (default: 3979) */
  webhookPort?: number;
  /** Webhook path (default: /googlechat/webhook) */
  webhookPath?: string;
  /** Bot display name */
  displayName?: string;
  /** Response prefix for bot replies */
  responsePrefix?: string;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Auto-reconnect on connection failure (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Pub/Sub subscription name (alternative to webhook) */
  pubsubSubscription?: string;
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
   * Update adapter configuration at runtime (if supported).
   * Useful for channels with dynamic settings like self-chat mode.
   */
  updateConfig?(config: ChannelConfig): void;

  /**
   * Register a callback query handler (for inline keyboard buttons)
   * @param handler Function to call when a button is pressed
   */
  onCallbackQuery?(handler: CallbackQueryHandler): void;

  /**
   * Answer a callback query (acknowledge button press)
   * @param queryId Callback query ID
   * @param text Optional notification text
   * @param showAlert Show as alert instead of toast
   */
  answerCallbackQuery?(queryId: string, text?: string, showAlert?: boolean): Promise<void>;

  /**
   * Edit message with inline keyboard
   * @param chatId Chat ID
   * @param messageId Message ID
   * @param text New text (optional)
   * @param inlineKeyboard New keyboard (optional)
   */
  editMessageWithKeyboard?(
    chatId: string,
    messageId: string,
    text?: string,
    inlineKeyboard?: InlineKeyboardButton[][]
  ): Promise<void>;

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

// ============================================================================
// Extended Features Types
// ============================================================================

/**
 * Reply keyboard button (persistent keyboard below input)
 */
export interface ReplyKeyboardButton {
  /** Button text */
  text: string;
  /** Request contact (Telegram) */
  requestContact?: boolean;
  /** Request location (Telegram) */
  requestLocation?: boolean;
}

/**
 * Reply keyboard configuration
 */
export interface ReplyKeyboard {
  /** Rows of buttons */
  buttons: ReplyKeyboardButton[][];
  /** Resize keyboard to fit buttons */
  resizeKeyboard?: boolean;
  /** Hide after use */
  oneTimeKeyboard?: boolean;
  /** Placeholder text in input */
  inputPlaceholder?: string;
}

/**
 * Select menu option (Discord)
 */
export interface SelectMenuOption {
  /** Display label */
  label: string;
  /** Value sent on selection */
  value: string;
  /** Description shown below label */
  description?: string;
  /** Emoji to display */
  emoji?: string;
  /** Whether this is selected by default */
  default?: boolean;
}

/**
 * Select menu configuration (Discord)
 */
export interface SelectMenu {
  /** Custom ID for handling */
  customId: string;
  /** Placeholder text */
  placeholder?: string;
  /** Menu options */
  options: SelectMenuOption[];
  /** Minimum selections */
  minValues?: number;
  /** Maximum selections */
  maxValues?: number;
  /** Whether menu is disabled */
  disabled?: boolean;
}

/**
 * Poll option
 */
export interface PollOption {
  /** Option text */
  text: string;
  /** Vote count (when reading results) */
  voterCount?: number;
}

/**
 * Poll configuration
 */
export interface Poll {
  /** Poll question */
  question: string;
  /** Poll options */
  options: PollOption[];
  /** Allow multiple answers */
  allowsMultipleAnswers?: boolean;
  /** Anonymous voting */
  isAnonymous?: boolean;
  /** Poll type: quiz has correct answer */
  type?: 'regular' | 'quiz';
  /** Correct option index (for quiz) */
  correctOptionId?: number;
  /** Explanation shown after answering (quiz) */
  explanation?: string;
  /** Auto-close after seconds */
  openPeriod?: number;
  /** Close at specific time */
  closeDate?: Date;
}

/**
 * Reaction on a message
 */
export interface MessageReaction {
  /** Emoji or custom emoji ID */
  emoji: string;
  /** Whether it's a custom emoji */
  isCustom?: boolean;
  /** Count of this reaction */
  count?: number;
  /** Whether bot reacted with this */
  isOwnReaction?: boolean;
}

/**
 * Scheduled message
 */
export interface ScheduledMessage {
  /** Unique ID */
  id: string;
  /** Target channel */
  channel: ChannelType;
  /** Target chat ID */
  chatId: string;
  /** Message to send */
  message: OutgoingMessage;
  /** When to send */
  scheduledAt: Date;
  /** Status */
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  /** Error if failed */
  error?: string;
  /** Created timestamp */
  createdAt: Date;
}

/**
 * Message delivery status
 */
export interface MessageDelivery {
  /** Message ID */
  messageId: string;
  /** Channel type */
  channel: ChannelType;
  /** Chat ID */
  chatId: string;
  /** Delivery status */
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  /** Sent timestamp */
  sentAt?: Date;
  /** Delivered timestamp */
  deliveredAt?: Date;
  /** Read timestamp */
  readAt?: Date;
  /** Error if failed */
  error?: string;
}

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  /** Entry ID */
  id: string;
  /** Timestamp */
  timestamp: Date;
  /** Action type */
  action: string;
  /** Channel */
  channel?: ChannelType;
  /** User ID */
  userId?: string;
  /** Chat ID */
  chatId?: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * User rate limit info
 */
export interface UserRateLimit {
  /** User ID */
  userId: string;
  /** Channel type */
  channel: ChannelType;
  /** Message count in current window */
  messageCount: number;
  /** Window start time */
  windowStart: Date;
  /** Whether currently limited */
  isLimited: boolean;
  /** When limit expires */
  limitExpiresAt?: Date;
}

/**
 * Broadcast configuration
 */
export interface BroadcastConfig {
  /** Target chat IDs */
  chatIds: string[];
  /** Channel type */
  channel: ChannelType;
  /** Message to broadcast */
  message: OutgoingMessage;
  /** Delay between sends (ms) */
  delayBetweenSends?: number;
}

/**
 * Broadcast result
 */
export interface BroadcastResult {
  /** Total recipients */
  total: number;
  /** Successfully sent */
  sent: number;
  /** Failed sends */
  failed: number;
  /** Details per chat */
  results: Array<{
    chatId: string;
    success: boolean;
    messageId?: string;
    error?: string;
  }>;
}

/**
 * Extended channel adapter interface with all features
 */
export interface ExtendedChannelAdapter extends ChannelAdapter {
  /**
   * Send typing indicator
   * @param chatId Chat ID
   * @param threadId Optional thread ID
   */
  sendTyping?(chatId: string, threadId?: string): Promise<void>;

  /**
   * Add reaction to a message
   * @param chatId Chat ID
   * @param messageId Message ID
   * @param emoji Emoji to react with
   */
  addReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Remove reaction from a message
   * @param chatId Chat ID
   * @param messageId Message ID
   * @param emoji Emoji to remove
   */
  removeReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Send a poll
   * @param chatId Chat ID
   * @param poll Poll configuration
   * @returns Message ID
   */
  sendPoll?(chatId: string, poll: Poll): Promise<string>;

  /**
   * Send a message with reply keyboard
   * @param chatId Chat ID
   * @param text Message text
   * @param keyboard Reply keyboard
   * @returns Message ID
   */
  sendWithReplyKeyboard?(chatId: string, text: string, keyboard: ReplyKeyboard): Promise<string>;

  /**
   * Remove reply keyboard
   * @param chatId Chat ID
   * @param text Message text
   */
  removeReplyKeyboard?(chatId: string, text: string): Promise<string>;

  /**
   * Send a message with select menu (Discord)
   * @param chatId Chat ID
   * @param text Message text
   * @param menu Select menu configuration
   */
  sendWithSelectMenu?(chatId: string, text: string, menu: SelectMenu): Promise<string>;

  /**
   * Register select menu handler (Discord)
   */
  onSelectMenu?(handler: SelectMenuHandler): void;
}

/**
 * Select menu interaction handler
 */
export type SelectMenuHandler = (
  customId: string,
  values: string[],
  userId: string,
  chatId: string,
  messageId: string,
  raw: unknown
) => void | Promise<void>;
