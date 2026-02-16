/**
 * Channel Registry
 *
 * Centralized registry for channel adapters. Provides:
 * - Registration of built-in and plugin-based channels
 * - Channel discovery and metadata
 * - Factory pattern for creating adapter instances
 * - Channel capability tracking
 * - Configuration validation
 */

import { EventEmitter } from 'events';
import {
  ChannelAdapter,
  ChannelType,
  ChannelConfig,
  ChannelInfo,
  ChannelStatus,
  TelegramConfig,
  DiscordConfig,
  SlackConfig,
  WhatsAppConfig,
  ImessageConfig,
  SignalConfig,
  TeamsConfig,
  GoogleChatConfig,
  MattermostConfig,
  MatrixConfig,
  TwitchConfig,
  LineConfig,
  BlueBubblesConfig,
  EmailConfig,
} from './channels/types';
import { createTelegramAdapter } from './channels/telegram';
import { createDiscordAdapter } from './channels/discord';
import { createSlackAdapter } from './channels/slack';
import { createWhatsAppAdapter } from './channels/whatsapp';
import { createImessageAdapter } from './channels/imessage';
import { createSignalAdapter } from './channels/signal';
import { createTeamsAdapter } from './channels/teams';
import { createGoogleChatAdapter } from './channels/google-chat';
import { createMattermostAdapter } from './channels/mattermost';
import { createMatrixAdapter } from './channels/matrix';
import { createTwitchAdapter } from './channels/twitch';
import { createLineAdapter } from './channels/line';
import { createBlueBubblesAdapter } from './channels/bluebubbles';
import { createEmailAdapter } from './channels/email';

/**
 * Channel metadata for registration
 */
export interface ChannelMetadata {
  /** Unique channel type identifier */
  type: string;

  /** Human-readable display name */
  displayName: string;

  /** Channel description */
  description: string;

  /** Channel icon (emoji or icon name) */
  icon?: string;

  /** Whether this is a built-in channel */
  builtin: boolean;

  /** Plugin name (if from a plugin) */
  pluginName?: string;

  /** Channel capabilities */
  capabilities: ChannelCapabilities;

  /** Configuration schema */
  configSchema?: ChannelConfigSchema;

  /** Platform requirements */
  platforms?: NodeJS.Platform[];
}

/**
 * Channel capabilities
 */
export interface ChannelCapabilities {
  sendMessage: boolean;
  receiveMessage: boolean;
  attachments: boolean;
  reactions: boolean;
  inlineKeyboards: boolean;
  replyKeyboards: boolean;
  polls: boolean;
  voice: boolean;
  video: boolean;
  location: boolean;
  editMessage: boolean;
  deleteMessage: boolean;
  typing: boolean;
  readReceipts: boolean;
  groups: boolean;
  threads: boolean;
  webhooks: boolean;
  e2eEncryption: boolean;
}

/**
 * Channel configuration schema
 */
export interface ChannelConfigSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    secret?: boolean;
    default?: unknown;
  }>;
  required?: string[];
}

/**
 * Channel adapter factory function
 */
export type ChannelAdapterFactory = (config: ChannelConfig) => ChannelAdapter;

/**
 * Registered channel entry
 */
interface RegisteredChannel {
  metadata: ChannelMetadata;
  factory: ChannelAdapterFactory;
}

/**
 * Channel registry events
 */
export type ChannelRegistryEventType =
  | 'channel:registered'
  | 'channel:unregistered'
  | 'channel:updated';

/**
 * Channel Registry - Singleton for managing channel types
 */
export class ChannelRegistry extends EventEmitter {
  private static instance: ChannelRegistry;

  /** Registered channels by type */
  private channels: Map<string, RegisteredChannel> = new Map();

  /** Active adapter instances by type */
  private activeAdapters: Map<string, ChannelAdapter> = new Map();

  private constructor() {
    super();
    this.registerBuiltinChannels();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ChannelRegistry {
    if (!ChannelRegistry.instance) {
      ChannelRegistry.instance = new ChannelRegistry();
    }
    return ChannelRegistry.instance;
  }

  /**
   * Register built-in channels
   */
  private registerBuiltinChannels(): void {
    // Telegram
    this.register({
      metadata: {
        type: 'telegram',
        displayName: 'Telegram',
        description: 'Telegram Bot API integration using grammY',
        icon: '✈️',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: true,
          replyKeyboards: true,
          polls: true,
          voice: true,
          video: true,
          location: true,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: false,
          groups: true,
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            botToken: {
              type: 'string',
              description: 'Bot token from @BotFather',
              required: true,
              secret: true,
            },
            webhookUrl: {
              type: 'string',
              description: 'Webhook URL (optional, uses polling if not set)',
            },
          },
          required: ['botToken'],
        },
      },
      factory: (config) => createTelegramAdapter(config as TelegramConfig),
    });

    // Discord
    this.register({
      metadata: {
        type: 'discord',
        displayName: 'Discord',
        description: 'Discord Bot integration using discord.js',
        icon: '🎮',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: true,
          replyKeyboards: false,
          polls: false,
          voice: true,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: false,
          groups: true,
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            botToken: {
              type: 'string',
              description: 'Bot token from Discord Developer Portal',
              required: true,
              secret: true,
            },
            applicationId: {
              type: 'string',
              description: 'Application ID',
              required: true,
            },
            guildIds: {
              type: 'array',
              description: 'Guild IDs to operate in (empty = all)',
            },
          },
          required: ['botToken', 'applicationId'],
        },
      },
      factory: (config) => createDiscordAdapter(config as DiscordConfig),
    });

    // Slack
    this.register({
      metadata: {
        type: 'slack',
        displayName: 'Slack',
        description: 'Slack Bot integration using Bolt SDK',
        icon: '💼',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: true,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: false,
          groups: true,
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            botToken: {
              type: 'string',
              description: 'Bot token (xoxb-...)',
              required: true,
              secret: true,
            },
            appToken: {
              type: 'string',
              description: 'App token for Socket Mode (xapp-...)',
              required: true,
              secret: true,
            },
            signingSecret: {
              type: 'string',
              description: 'Signing secret for verifying requests',
              secret: true,
            },
          },
          required: ['botToken', 'appToken'],
        },
      },
      factory: (config) => createSlackAdapter(config as SlackConfig),
    });

    // WhatsApp
    this.register({
      metadata: {
        type: 'whatsapp',
        displayName: 'WhatsApp',
        description: 'WhatsApp integration using Baileys (unofficial)',
        icon: '💬',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: true,
          voice: true,
          video: true,
          location: true,
          editMessage: false,
          deleteMessage: true,
          typing: true,
          readReceipts: true,
          groups: true,
          threads: false,
          webhooks: false,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            allowedNumbers: {
              type: 'array',
              description: 'Allowed phone numbers in E.164 format',
            },
            selfChatMode: {
              type: 'boolean',
              description: 'Enable self-chat mode (messaging yourself)',
              default: true,
            },
            groupRoutingMode: {
              type: 'string',
              description: 'Group message routing mode (all, mentionsOnly, mentionsOrCommands, commandsOnly)',
              default: 'mentionsOrCommands',
            },
            sendReadReceipts: {
              type: 'boolean',
              description: 'Send read receipts',
              default: true,
            },
            ambientMode: {
              type: 'boolean',
              description: 'Enable ambient ingestion (non-command messages are logged only)',
              default: false,
            },
            deduplicationEnabled: {
              type: 'boolean',
              description: 'Enable message deduplication',
              default: true,
            },
            responsePrefix: {
              type: 'string',
              description: 'Prefix for bot responses',
              default: '🤖',
            },
            ingestNonSelfChatsInSelfChatMode: {
              type: 'boolean',
              description: 'Ingest non-self-chat messages in self-chat mode without routing to the agent',
              default: false,
            },
          },
          required: [],
        },
      },
      factory: (config) => createWhatsAppAdapter(config as WhatsAppConfig),
    });

    // iMessage
    this.register({
      metadata: {
        type: 'imessage',
        displayName: 'iMessage',
        description: 'iMessage integration using imsg CLI (macOS only)',
        icon: '💬',
        builtin: true,
        platforms: ['darwin'],
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: false,
          deleteMessage: false,
          typing: true,
          readReceipts: true,
          groups: true,
          threads: false,
          webhooks: false,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            cliPath: {
              type: 'string',
              description: 'Path to imsg CLI (default: "imsg")',
            },
            dbPath: {
              type: 'string',
              description: 'Path to Messages database',
            },
            dmPolicy: {
              type: 'string',
              description: 'DM access policy',
              default: 'pairing',
            },
            groupPolicy: {
              type: 'string',
              description: 'Group access policy',
              default: 'allowlist',
            },
            allowedContacts: {
              type: 'array',
              description: 'Allowed contacts (phone numbers, emails)',
            },
          },
          required: [],
        },
      },
      factory: (config) => createImessageAdapter(config as ImessageConfig),
    });

    // Signal
    this.register({
      metadata: {
        type: 'signal',
        displayName: 'Signal',
        description: 'Signal messaging integration using signal-cli',
        icon: '🔐',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: true,
          video: false,
          location: false,
          editMessage: false,
          deleteMessage: true,
          typing: true,
          readReceipts: true,
          groups: true,
          threads: false,
          webhooks: false,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            phoneNumber: {
              type: 'string',
              description: 'Phone number in E.164 format (e.g., +14155551234)',
              required: true,
            },
            cliPath: {
              type: 'string',
              description: 'Path to signal-cli executable (default: "signal-cli")',
            },
            dataDir: {
              type: 'string',
              description: 'signal-cli data directory',
            },
            mode: {
              type: 'string',
              description: 'Communication mode (native, daemon)',
              default: 'native',
            },
            socketPath: {
              type: 'string',
              description: 'Daemon socket path (for daemon mode)',
              default: '/tmp/signal-cli.socket',
            },
            trustMode: {
              type: 'string',
              description: 'Trust mode for new contacts (tofu, always, manual)',
              default: 'tofu',
            },
            dmPolicy: {
              type: 'string',
              description: 'DM access policy',
              default: 'pairing',
            },
            groupPolicy: {
              type: 'string',
              description: 'Group access policy',
              default: 'allowlist',
            },
            allowedNumbers: {
              type: 'array',
              description: 'Allowed phone numbers in E.164 format',
            },
            sendReadReceipts: {
              type: 'boolean',
              description: 'Send read receipts',
              default: true,
            },
            sendTypingIndicators: {
              type: 'boolean',
              description: 'Send typing indicators',
              default: true,
            },
            maxAttachmentMb: {
              type: 'number',
              description: 'Max attachment size in MB',
              default: 100,
            },
            pollInterval: {
              type: 'number',
              description: 'Polling interval for receiving messages in ms',
              default: 1000,
            },
            deduplicationEnabled: {
              type: 'boolean',
              description: 'Enable message deduplication',
              default: true,
            },
            responsePrefix: {
              type: 'string',
              description: 'Prefix for bot responses',
            },
          },
          required: ['phoneNumber'],
        },
      },
      factory: (config) => createSignalAdapter(config as SignalConfig),
    });

    // Microsoft Teams
    this.register({
      metadata: {
        type: 'teams',
        displayName: 'Microsoft Teams',
        description: 'Microsoft Teams Bot integration using Bot Framework SDK',
        icon: '🟦',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: true,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: false,
          groups: true,
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            appId: {
              type: 'string',
              description: 'Microsoft App ID from Azure Bot registration',
              required: true,
            },
            appPassword: {
              type: 'string',
              description: 'Microsoft App Password (Client Secret)',
              required: true,
              secret: true,
            },
            tenantId: {
              type: 'string',
              description: 'Tenant ID for single-tenant apps (optional)',
            },
            displayName: {
              type: 'string',
              description: 'Bot display name',
            },
            webhookPort: {
              type: 'number',
              description: 'Webhook endpoint port (default: 3978)',
              default: 3978,
            },
          },
          required: ['appId', 'appPassword'],
        },
      },
      factory: (config) => createTeamsAdapter(config as TeamsConfig),
    });

    // Google Chat
    this.register({
      metadata: {
        type: 'googlechat',
        displayName: 'Google Chat',
        description: 'Google Chat integration using Google Chat API with service account',
        icon: '💚',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: false, // Limited - requires Google Drive integration
          reactions: true,
          inlineKeyboards: true, // Via cards
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: false,
          readReceipts: false,
          groups: true, // Spaces
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            serviceAccountKeyPath: {
              type: 'string',
              description: 'Path to service account JSON key file',
            },
            projectId: {
              type: 'string',
              description: 'Google Cloud project ID',
            },
            displayName: {
              type: 'string',
              description: 'Bot display name',
            },
            webhookPort: {
              type: 'number',
              description: 'Webhook endpoint port (default: 3979)',
              default: 3979,
            },
            webhookPath: {
              type: 'string',
              description: 'Webhook path (default: /googlechat/webhook)',
              default: '/googlechat/webhook',
            },
          },
          required: [],
        },
      },
      factory: (config) => createGoogleChatAdapter(config as GoogleChatConfig),
    });

    // Mattermost
    this.register({
      metadata: {
        type: 'mattermost',
        displayName: 'Mattermost',
        description: 'Mattermost integration using WebSocket and REST API',
        icon: '🔵',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: false,
          groups: true,
          threads: true,
          webhooks: true,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            serverUrl: {
              type: 'string',
              description: 'Mattermost server URL (e.g., https://mattermost.example.com)',
              required: true,
            },
            token: {
              type: 'string',
              description: 'Personal access token',
              required: true,
              secret: true,
            },
            teamId: {
              type: 'string',
              description: 'Team ID to operate in (optional)',
            },
            responsePrefix: {
              type: 'string',
              description: 'Prefix for bot responses',
            },
          },
          required: ['serverUrl', 'token'],
        },
      },
      factory: (config) => createMattermostAdapter(config as MattermostConfig),
    });

    // Matrix
    this.register({
      metadata: {
        type: 'matrix',
        displayName: 'Matrix',
        description: 'Matrix federated messaging integration',
        icon: '🟢',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: true,
          deleteMessage: true,
          typing: true,
          readReceipts: true,
          groups: true,
          threads: true,
          webhooks: false,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            homeserver: {
              type: 'string',
              description: 'Matrix homeserver URL (e.g., https://matrix.org)',
              required: true,
            },
            userId: {
              type: 'string',
              description: 'User ID (e.g., @user:matrix.org)',
              required: true,
            },
            accessToken: {
              type: 'string',
              description: 'Access token',
              required: true,
              secret: true,
            },
            deviceId: {
              type: 'string',
              description: 'Device ID (optional)',
            },
            roomIds: {
              type: 'array',
              description: 'Room IDs to listen to (optional)',
            },
          },
          required: ['homeserver', 'userId', 'accessToken'],
        },
      },
      factory: (config) => createMatrixAdapter(config as MatrixConfig),
    });

    // Twitch
    this.register({
      metadata: {
        type: 'twitch',
        displayName: 'Twitch',
        description: 'Twitch IRC chat integration',
        icon: '🟣',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: false,
          reactions: false,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: false,
          deleteMessage: true,
          typing: false,
          readReceipts: false,
          groups: true,
          threads: false,
          webhooks: false,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            username: {
              type: 'string',
              description: 'Twitch username (login name)',
              required: true,
            },
            oauthToken: {
              type: 'string',
              description: 'OAuth token',
              required: true,
              secret: true,
            },
            channels: {
              type: 'array',
              description: 'Channels to join (without # prefix)',
              required: true,
            },
            allowWhispers: {
              type: 'boolean',
              description: 'Whether to respond to whispers (DMs)',
              default: false,
            },
          },
          required: ['username', 'oauthToken', 'channels'],
        },
      },
      factory: (config) => createTwitchAdapter(config as TwitchConfig),
    });

    // LINE
    this.register({
      metadata: {
        type: 'line',
        displayName: 'LINE',
        description: 'LINE Messaging API integration with webhooks',
        icon: '💚',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: false,
          inlineKeyboards: true,
          replyKeyboards: true,
          polls: false,
          voice: false,
          video: false,
          location: true,
          editMessage: false,
          deleteMessage: false,
          typing: false,
          readReceipts: true,
          groups: true,
          threads: false,
          webhooks: true,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            channelAccessToken: {
              type: 'string',
              description: 'LINE Channel Access Token',
              required: true,
              secret: true,
            },
            channelSecret: {
              type: 'string',
              description: 'LINE Channel Secret',
              required: true,
              secret: true,
            },
            webhookPort: {
              type: 'number',
              description: 'Webhook port (default: 3100)',
              default: 3100,
            },
            webhookPath: {
              type: 'string',
              description: 'Webhook path (default: /line/webhook)',
              default: '/line/webhook',
            },
            useReplyTokens: {
              type: 'boolean',
              description: 'Use reply tokens for faster responses',
              default: true,
            },
          },
          required: ['channelAccessToken', 'channelSecret'],
        },
      },
      factory: (config) => createLineAdapter(config as LineConfig),
    });

    // BlueBubbles
    this.register({
      metadata: {
        type: 'bluebubbles',
        displayName: 'BlueBubbles',
        description: 'iMessage integration via BlueBubbles server',
        icon: '💙',
        builtin: true,
        platforms: ['darwin'],
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: true,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: false,
          deleteMessage: false,
          typing: true,
          readReceipts: true,
          groups: true,
          threads: false,
          webhooks: true,
          e2eEncryption: true,
        },
        configSchema: {
          type: 'object',
          properties: {
            serverUrl: {
              type: 'string',
              description: 'BlueBubbles server URL (e.g., http://192.168.1.100:1234)',
              required: true,
            },
            password: {
              type: 'string',
              description: 'BlueBubbles server password',
              required: true,
              secret: true,
            },
            webhookPort: {
              type: 'number',
              description: 'Webhook port (default: 3101)',
              default: 3101,
            },
            webhookPath: {
              type: 'string',
              description: 'Webhook path (default: /bluebubbles/webhook)',
              default: '/bluebubbles/webhook',
            },
            pollInterval: {
              type: 'number',
              description: 'Poll interval in ms if webhooks unavailable',
              default: 5000,
            },
            allowedContacts: {
              type: 'array',
              description: 'Allowed contacts (phone numbers or emails)',
            },
          },
          required: ['serverUrl', 'password'],
        },
      },
      factory: (config) => createBlueBubblesAdapter(config as BlueBubblesConfig),
    });

    // Email
    this.register({
      metadata: {
        type: 'email',
        displayName: 'Email',
        description: 'Email integration using IMAP/SMTP',
        icon: '📧',
        builtin: true,
        capabilities: {
          sendMessage: true,
          receiveMessage: true,
          attachments: true,
          reactions: false,
          inlineKeyboards: false,
          replyKeyboards: false,
          polls: false,
          voice: false,
          video: false,
          location: false,
          editMessage: false,
          deleteMessage: true,
          typing: false,
          readReceipts: false,
          groups: false,
          threads: true,
          webhooks: false,
          e2eEncryption: false,
        },
        configSchema: {
          type: 'object',
          properties: {
            imapHost: {
              type: 'string',
              description: 'IMAP server host',
              required: true,
            },
            imapPort: {
              type: 'number',
              description: 'IMAP port (default: 993)',
              default: 993,
            },
            smtpHost: {
              type: 'string',
              description: 'SMTP server host',
              required: true,
            },
            smtpPort: {
              type: 'number',
              description: 'SMTP port (default: 587)',
              default: 587,
            },
            email: {
              type: 'string',
              description: 'Email address',
              required: true,
            },
            password: {
              type: 'string',
              description: 'Password or app password',
              required: true,
              secret: true,
            },
            displayName: {
              type: 'string',
              description: 'Display name for outgoing emails',
            },
            mailbox: {
              type: 'string',
              description: 'IMAP mailbox to monitor (default: INBOX)',
              default: 'INBOX',
            },
            subjectFilter: {
              type: 'string',
              description: 'Subject line filter pattern',
            },
            allowedSenders: {
              type: 'array',
              description: 'Allowed sender email addresses',
            },
          },
          required: ['imapHost', 'smtpHost', 'email', 'password'],
        },
      },
      factory: (config) => createEmailAdapter(config as EmailConfig),
    });
  }

  /**
   * Register a channel
   */
  register(entry: RegisteredChannel): void {
    const { metadata, factory } = entry;

    // Check platform compatibility
    if (metadata.platforms && !metadata.platforms.includes(process.platform)) {
      console.log(`Channel ${metadata.type} not supported on ${process.platform}`);
      return;
    }

    // Check for duplicate
    if (this.channels.has(metadata.type)) {
      console.warn(`Channel ${metadata.type} already registered, overwriting`);
    }

    this.channels.set(metadata.type, entry);
    this.emit('channel:registered', { type: metadata.type, metadata });
    console.log(`Channel registered: ${metadata.type} (${metadata.displayName})`);
  }

  /**
   * Unregister a channel
   */
  unregister(type: string): boolean {
    const entry = this.channels.get(type);
    if (!entry) {
      return false;
    }

    // Cannot unregister built-in channels
    if (entry.metadata.builtin) {
      throw new Error(`Cannot unregister built-in channel: ${type}`);
    }

    this.channels.delete(type);
    this.emit('channel:unregistered', { type });
    return true;
  }

  /**
   * Get all registered channel types
   */
  getChannelTypes(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get channel metadata
   */
  getMetadata(type: string): ChannelMetadata | undefined {
    return this.channels.get(type)?.metadata;
  }

  /**
   * Get all channel metadata
   */
  getAllMetadata(): ChannelMetadata[] {
    return Array.from(this.channels.values()).map(e => e.metadata);
  }

  /**
   * Get built-in channels
   */
  getBuiltinChannels(): ChannelMetadata[] {
    return Array.from(this.channels.values())
      .filter(e => e.metadata.builtin)
      .map(e => e.metadata);
  }

  /**
   * Get plugin-provided channels
   */
  getPluginChannels(): ChannelMetadata[] {
    return Array.from(this.channels.values())
      .filter(e => !e.metadata.builtin)
      .map(e => e.metadata);
  }

  /**
   * Check if a channel type is registered
   */
  hasChannel(type: string): boolean {
    return this.channels.has(type);
  }

  /**
   * Check if a channel type is supported on current platform
   */
  isSupported(type: string): boolean {
    const entry = this.channels.get(type);
    if (!entry) {
      return false;
    }

    if (entry.metadata.platforms) {
      return entry.metadata.platforms.includes(process.platform);
    }

    return true;
  }

  /**
   * Create a channel adapter instance
   */
  createAdapter(type: string, config: ChannelConfig): ChannelAdapter {
    const entry = this.channels.get(type);
    if (!entry) {
      throw new Error(`Unknown channel type: ${type}`);
    }

    return entry.factory(config);
  }

  /**
   * Validate configuration for a channel type
   */
  validateConfig(type: string, config: ChannelConfig): { valid: boolean; errors: string[] } {
    const entry = this.channels.get(type);
    if (!entry) {
      return { valid: false, errors: [`Unknown channel type: ${type}`] };
    }

    const schema = entry.metadata.configSchema;
    if (!schema) {
      return { valid: true, errors: [] };
    }

    const errors: string[] = [];

    // Check required fields
    for (const required of schema.required || []) {
      if (!(required in config) || config[required] === undefined || config[required] === '') {
        errors.push(`Missing required field: ${required}`);
      }
    }

    // Basic type validation
    for (const [key, prop] of Object.entries(schema.properties)) {
      const value = config[key];
      if (value === undefined) {
        continue;
      }

      const expectedType = prop.type;
      const actualType = Array.isArray(value) ? 'array' : typeof value;

      if (expectedType !== actualType) {
        errors.push(`Field ${key} should be ${expectedType}, got ${actualType}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get channels by capability
   */
  getChannelsByCapability(capability: keyof ChannelCapabilities): ChannelMetadata[] {
    return Array.from(this.channels.values())
      .filter(e => e.metadata.capabilities[capability])
      .map(e => e.metadata);
  }

  /**
   * Get channel capabilities
   */
  getCapabilities(type: string): ChannelCapabilities | undefined {
    return this.channels.get(type)?.metadata.capabilities;
  }

  /**
   * Set an active adapter instance (for tracking)
   */
  setActiveAdapter(type: string, adapter: ChannelAdapter): void {
    this.activeAdapters.set(type, adapter);
  }

  /**
   * Get an active adapter instance
   */
  getActiveAdapter(type: string): ChannelAdapter | undefined {
    return this.activeAdapters.get(type);
  }

  /**
   * Remove an active adapter
   */
  removeActiveAdapter(type: string): void {
    this.activeAdapters.delete(type);
  }

  /**
   * Get all active adapters
   */
  getActiveAdapters(): Map<string, ChannelAdapter> {
    return new Map(this.activeAdapters);
  }

  /**
   * Get channel status summary
   */
  getStatusSummary(): Array<{ type: string; displayName: string; status: ChannelStatus }> {
    const summary: Array<{ type: string; displayName: string; status: ChannelStatus }> = [];

    for (const [type, entry] of this.channels) {
      const adapter = this.activeAdapters.get(type);
      summary.push({
        type,
        displayName: entry.metadata.displayName,
        status: adapter?.status || 'disconnected',
      });
    }

    return summary;
  }
}

// Export singleton getter
export const getChannelRegistry = (): ChannelRegistry => ChannelRegistry.getInstance();
