/**
 * Channel Gateway
 *
 * Main entry point for multi-channel messaging support.
 * Manages channel adapters, routing, and sessions.
 */

import { BrowserWindow } from 'electron';
import Database from 'better-sqlite3';
import { MessageRouter, RouterConfig } from './router';
import { SecurityManager } from './security';
import { SessionManager } from './session';
import {
  ChannelAdapter,
  ChannelType,
  TelegramConfig,
  DiscordConfig,
  SlackConfig,
  WhatsAppConfig,
  ImessageConfig,
  SignalConfig,
  MattermostConfig,
  MatrixConfig,
  TwitchConfig,
  LineConfig,
  BlueBubblesConfig,
  EmailConfig,
  GatewayEventHandler,
} from './channels/types';
import { TelegramAdapter, createTelegramAdapter } from './channels/telegram';
import { DiscordAdapter, createDiscordAdapter } from './channels/discord';
import { SlackAdapter, createSlackAdapter } from './channels/slack';
import { WhatsAppAdapter, createWhatsAppAdapter } from './channels/whatsapp';
import { ImessageAdapter, createImessageAdapter } from './channels/imessage';
import { SignalAdapter, createSignalAdapter } from './channels/signal';
import { MattermostAdapter, createMattermostAdapter } from './channels/mattermost';
import { MatrixAdapter, createMatrixAdapter } from './channels/matrix';
import { TwitchAdapter, createTwitchAdapter } from './channels/twitch';
import { LineAdapter, createLineAdapter } from './channels/line';
import { BlueBubblesAdapter, createBlueBubblesAdapter } from './channels/bluebubbles';
import { EmailAdapter, createEmailAdapter } from './channels/email';
import {
  ChannelRepository,
  ChannelUserRepository,
  ChannelSessionRepository,
  ChannelMessageRepository,
  Channel,
} from '../database/repositories';
import { AgentDaemon } from '../agent/daemon';
import { PersonalityManager } from '../settings/personality-manager';
import {
  getChannelMessage,
  DEFAULT_CHANNEL_CONTEXT,
  type ChannelMessageContext,
} from '../../shared/channelMessages';
import { DEFAULT_QUIRKS } from '../../shared/types';

export interface GatewayConfig {
  /** Router configuration */
  router?: RouterConfig;
  /** Auto-connect enabled channels on startup */
  autoConnect?: boolean;
  /** Agent daemon for task execution */
  agentDaemon?: AgentDaemon;
}

const DEFAULT_CONFIG: GatewayConfig = {
  autoConnect: true,
};

/**
 * Channel Gateway - Main class for managing multi-channel messaging
 */
export class ChannelGateway {
  private db: Database.Database;
  private router: MessageRouter;
  private securityManager: SecurityManager;
  private sessionManager: SessionManager;
  private channelRepo: ChannelRepository;
  private userRepo: ChannelUserRepository;
  private sessionRepo: ChannelSessionRepository;
  private messageRepo: ChannelMessageRepository;
  private config: GatewayConfig;
  private initialized = false;
  private agentDaemon?: AgentDaemon;
  private daemonListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  constructor(db: Database.Database, config: GatewayConfig = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize components
    this.router = new MessageRouter(db, config.router, config.agentDaemon);
    this.securityManager = new SecurityManager(db);
    this.sessionManager = new SessionManager(db);
    this.channelRepo = new ChannelRepository(db);
    this.userRepo = new ChannelUserRepository(db);
    this.sessionRepo = new ChannelSessionRepository(db);
    this.messageRepo = new ChannelMessageRepository(db);

    // Listen for agent daemon events to send responses back to channels
    if (config.agentDaemon) {
      this.agentDaemon = config.agentDaemon;
      this.setupAgentDaemonListeners(config.agentDaemon);
    }
  }

  /**
   * Get the channel message context from personality settings
   */
  private getMessageContext(): ChannelMessageContext {
    try {
      if (PersonalityManager.isInitialized()) {
        const settings = PersonalityManager.loadSettings();
        return {
          agentName: settings.agentName || 'CoWork',
          userName: settings.relationship?.userName,
          personality: settings.activePersonality || 'professional',
          emojiUsage: settings.responseStyle?.emojiUsage || 'minimal',
          quirks: settings.quirks || DEFAULT_QUIRKS,
        };
      }
    } catch (error) {
      console.error('[ChannelGateway] Failed to load personality settings:', error);
    }
    return DEFAULT_CHANNEL_CONTEXT;
  }

  /**
   * Set up listeners for agent daemon events
   */
  private setupAgentDaemonListeners(agentDaemon: AgentDaemon): void {
    // Track the last assistant message for each task to send as completion result
    const lastMessages = new Map<string, string>();

    // Listen for assistant messages (streaming responses)
    // Note: daemon emits { taskId, message } not { taskId, content }
    const onAssistantMessage = (data: { taskId: string; message?: string }) => {
      const message = data.message;
      if (message && message.length > 10) {
        // Keep the BEST (longest substantive) answer, not just the last one
        // This prevents confused step messages from overwriting good answers
        const existingMessage = lastMessages.get(data.taskId);
        const isConfusedMessage = message.toLowerCase().includes("don't have") ||
                                  message.toLowerCase().includes("please provide") ||
                                  message.toLowerCase().includes("i cannot") ||
                                  message.toLowerCase().includes("not available");

        // Only overwrite if new message is better (longer and not confused)
        if (!existingMessage || (!isConfusedMessage && message.length >= existingMessage.length)) {
          lastMessages.set(data.taskId, message);
        }

        // Always stream updates to channel (so user sees progress)
        this.router.sendTaskUpdate(data.taskId, message);
      }
    };
    agentDaemon.on('assistant_message', onAssistantMessage);
    this.daemonListeners.push({ event: 'assistant_message', handler: onAssistantMessage });

    // Listen for task completion
    const onTaskCompleted = (data: { taskId: string; message?: string }) => {
      // Use the last assistant message as the result
      const result = lastMessages.get(data.taskId);
      this.router.handleTaskCompletion(data.taskId, result);
      lastMessages.delete(data.taskId);
    };
    agentDaemon.on('task_completed', onTaskCompleted);
    this.daemonListeners.push({ event: 'task_completed', handler: onTaskCompleted });

    // Listen for task errors
    // Note: daemon emits { taskId, error } or { taskId, message }
    const onError = (data: { taskId: string; error?: string; message?: string }) => {
      const errorMsg = data.error || data.message || 'Unknown error';
      this.router.handleTaskFailure(data.taskId, errorMsg);
      lastMessages.delete(data.taskId);
    };
    agentDaemon.on('error', onError);
    this.daemonListeners.push({ event: 'error', handler: onError });

    // Listen for tool errors (individual tool execution failures)
    const onToolError = (data: { taskId: string; tool?: string; error?: string }) => {
      const toolName = data.tool || 'Unknown tool';
      const errorMsg = data.error || 'Unknown error';
      const message = getChannelMessage('toolError', this.getMessageContext(), { tool: toolName, error: errorMsg });
      this.router.sendTaskUpdate(data.taskId, message);
    };
    agentDaemon.on('tool_error', onToolError);
    this.daemonListeners.push({ event: 'tool_error', handler: onToolError });

    // Listen for follow-up message completion
    // Track if any assistant messages were sent during follow-up
    const followUpMessagesSent = new Map<string, boolean>();
    const originalOnAssistantMessage = onAssistantMessage;
    // Override to track follow-up messages
    agentDaemon.off('assistant_message', onAssistantMessage);
    const trackingAssistantMessage = (data: { taskId: string; message?: string }) => {
      followUpMessagesSent.set(data.taskId, true);
      originalOnAssistantMessage(data);
    };
    agentDaemon.on('assistant_message', trackingAssistantMessage);
    // Update the stored handler
    const assistantIdx = this.daemonListeners.findIndex(l => l.event === 'assistant_message');
    if (assistantIdx >= 0) {
      this.daemonListeners[assistantIdx] = { event: 'assistant_message', handler: trackingAssistantMessage };
    }

    const onFollowUpCompleted = async (data: { taskId: string }) => {
      // If no assistant messages were sent during the follow-up, send a confirmation
      if (!followUpMessagesSent.get(data.taskId)) {
        const message = getChannelMessage('followUpProcessed', this.getMessageContext());
        this.router.sendTaskUpdate(data.taskId, message);
      }
      followUpMessagesSent.delete(data.taskId);

      // Send any artifacts (images, screenshots) created during the follow-up
      await this.router.sendArtifacts(data.taskId);
    };
    agentDaemon.on('follow_up_completed', onFollowUpCompleted);
    this.daemonListeners.push({ event: 'follow_up_completed', handler: onFollowUpCompleted });

    // Listen for follow-up failures
    const onFollowUpFailed = (data: { taskId: string; error?: string }) => {
      const errorMsg = data.error || 'Unknown error';
      const message = getChannelMessage('followUpFailed', this.getMessageContext(), { error: errorMsg });
      this.router.sendTaskUpdate(data.taskId, message);
      followUpMessagesSent.delete(data.taskId);
    };
    agentDaemon.on('follow_up_failed', onFollowUpFailed);
    this.daemonListeners.push({ event: 'follow_up_failed', handler: onFollowUpFailed });

    // Listen for approval requests - forward to Discord/Telegram
    const onApprovalRequested = (data: { taskId: string; approval: any }) => {
      this.router.sendApprovalRequest(data.taskId, data.approval);
    };
    agentDaemon.on('approval_requested', onApprovalRequested);
    this.daemonListeners.push({ event: 'approval_requested', handler: onApprovalRequested });
  }

  /**
   * Initialize the gateway
   */
  async initialize(mainWindow?: BrowserWindow): Promise<void> {
    if (this.initialized) return;

    if (mainWindow) {
      this.router.setMainWindow(mainWindow);
    }

    // Load and register enabled channels
    await this.loadChannels();

    // Auto-connect if configured
    if (this.config.autoConnect) {
      await this.router.connectAll();
    }

    this.initialized = true;
    console.log('Channel Gateway initialized');
  }

  /**
   * Set the main window for IPC communication
   */
  setMainWindow(window: BrowserWindow): void {
    this.router.setMainWindow(window);
  }

  /**
   * Shutdown the gateway
   */
  async shutdown(): Promise<void> {
    // Clean up daemon event listeners
    if (this.agentDaemon) {
      for (const { event, handler } of this.daemonListeners) {
        this.agentDaemon.off(event, handler);
      }
      this.daemonListeners = [];
    }

    await this.router.disconnectAll();
    this.initialized = false;
    console.log('Channel Gateway shutdown');
  }

  // Channel Management

  /**
   * Add a new Telegram channel
   */
  async addTelegramChannel(
    name: string,
    botToken: string,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Telegram channel already exists
    const existing = this.channelRepo.findByType('telegram');
    if (existing) {
      throw new Error('Telegram channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'telegram',
      name,
      enabled: false, // Don't enable until tested
      config: { botToken },
      securityConfig: {
        mode: securityMode,
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Discord channel
   */
  async addDiscordChannel(
    name: string,
    botToken: string,
    applicationId: string,
    guildIds?: string[],
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Discord channel already exists
    const existing = this.channelRepo.findByType('discord');
    if (existing) {
      throw new Error('Discord channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'discord',
      name,
      enabled: false, // Don't enable until tested
      config: { botToken, applicationId, guildIds },
      securityConfig: {
        mode: securityMode,
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Slack channel
   */
  async addSlackChannel(
    name: string,
    botToken: string,
    appToken: string,
    signingSecret?: string,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Slack channel already exists
    const existing = this.channelRepo.findByType('slack');
    if (existing) {
      throw new Error('Slack channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'slack',
      name,
      enabled: false, // Don't enable until tested
      config: { botToken, appToken, signingSecret },
      securityConfig: {
        mode: securityMode,
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new WhatsApp channel
   */
  async addWhatsAppChannel(
    name: string,
    allowedNumbers?: string[],
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing',
    selfChatMode: boolean = true,
    responsePrefix: string = '🤖'
  ): Promise<Channel> {
    // Check if WhatsApp channel already exists
    const existing = this.channelRepo.findByType('whatsapp');
    if (existing) {
      throw new Error('WhatsApp channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'whatsapp',
      name,
      enabled: false, // Don't enable until QR code is scanned
      config: {
        allowedNumbers,
        selfChatMode,
        responsePrefix,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: allowedNumbers,
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new iMessage channel
   */
  async addImessageChannel(
    name: string,
    cliPath?: string,
    dbPath?: string,
    allowedContacts?: string[],
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing',
    dmPolicy: 'open' | 'allowlist' | 'pairing' | 'disabled' = 'pairing',
    groupPolicy: 'open' | 'allowlist' | 'disabled' = 'allowlist'
  ): Promise<Channel> {
    // Check if iMessage channel already exists
    const existing = this.channelRepo.findByType('imessage');
    if (existing) {
      throw new Error('iMessage channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'imessage',
      name,
      enabled: false, // Don't enable until connected
      config: {
        cliPath,
        dbPath,
        allowedContacts,
        dmPolicy,
        groupPolicy,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: allowedContacts,
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Signal channel
   */
  async addSignalChannel(
    name: string,
    phoneNumber: string,
    dataDir?: string,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing',
    mode: 'native' | 'daemon' = 'native',
    trustMode: 'tofu' | 'always' | 'manual' = 'tofu',
    dmPolicy: 'open' | 'allowlist' | 'pairing' | 'disabled' = 'pairing',
    groupPolicy: 'open' | 'allowlist' | 'disabled' = 'allowlist',
    sendReadReceipts: boolean = true,
    sendTypingIndicators: boolean = true
  ): Promise<Channel> {
    // Check if Signal channel already exists
    const existing = this.channelRepo.findByType('signal');
    if (existing) {
      throw new Error('Signal channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'signal',
      name,
      enabled: false, // Don't enable until connected
      config: {
        phoneNumber,
        dataDir,
        mode,
        trustMode,
        dmPolicy,
        groupPolicy,
        sendReadReceipts,
        sendTypingIndicators,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: [],
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Mattermost channel
   */
  async addMattermostChannel(
    name: string,
    serverUrl: string,
    token: string,
    teamId?: string,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Mattermost channel already exists
    const existing = this.channelRepo.findByType('mattermost');
    if (existing) {
      throw new Error('Mattermost channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'mattermost',
      name,
      enabled: false, // Don't enable until connected
      config: {
        serverUrl,
        token,
        teamId,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: [],
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Matrix channel
   */
  async addMatrixChannel(
    name: string,
    homeserver: string,
    userId: string,
    accessToken: string,
    deviceId?: string,
    roomIds?: string[],
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Matrix channel already exists
    const existing = this.channelRepo.findByType('matrix');
    if (existing) {
      throw new Error('Matrix channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'matrix',
      name,
      enabled: false, // Don't enable until connected
      config: {
        homeserver,
        userId,
        accessToken,
        deviceId,
        roomIds,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: [],
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Twitch channel
   */
  async addTwitchChannel(
    name: string,
    username: string,
    oauthToken: string,
    channels: string[],
    allowWhispers: boolean = false,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Twitch channel already exists
    const existing = this.channelRepo.findByType('twitch');
    if (existing) {
      throw new Error('Twitch channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'twitch',
      name,
      enabled: false, // Don't enable until connected
      config: {
        username,
        oauthToken,
        channels,
        allowWhispers,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: [],
        pairingCodeTTL: 300, // 5 minutes
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new LINE channel
   */
  async addLineChannel(
    name: string,
    channelAccessToken: string,
    channelSecret: string,
    webhookPort: number = 3100,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if LINE channel already exists
    const existing = this.channelRepo.findByType('line');
    if (existing) {
      throw new Error('LINE channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'line',
      name,
      enabled: false, // Don't enable until connected
      config: {
        channelAccessToken,
        channelSecret,
        webhookPort,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: [],
        pairingCodeTTL: 300,
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new BlueBubbles channel
   */
  async addBlueBubblesChannel(
    name: string,
    serverUrl: string,
    password: string,
    webhookPort: number = 3101,
    allowedContacts?: string[],
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if BlueBubbles channel already exists
    const existing = this.channelRepo.findByType('bluebubbles');
    if (existing) {
      throw new Error('BlueBubbles channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'bluebubbles',
      name,
      enabled: false, // Don't enable until connected
      config: {
        serverUrl,
        password,
        webhookPort,
        allowedContacts,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: allowedContacts || [],
        pairingCodeTTL: 300,
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Add a new Email channel
   */
  async addEmailChannel(
    name: string,
    email: string,
    password: string,
    imapHost: string,
    smtpHost: string,
    displayName?: string,
    allowedSenders?: string[],
    subjectFilter?: string,
    securityMode: 'open' | 'allowlist' | 'pairing' = 'pairing'
  ): Promise<Channel> {
    // Check if Email channel already exists
    const existing = this.channelRepo.findByType('email');
    if (existing) {
      throw new Error('Email channel already configured. Update or remove it first.');
    }

    // Create channel record
    const channel = this.channelRepo.create({
      type: 'email',
      name,
      enabled: false, // Don't enable until connected
      config: {
        email,
        password,
        imapHost,
        smtpHost,
        displayName,
        allowedSenders,
        subjectFilter,
      },
      securityConfig: {
        mode: securityMode,
        allowedUsers: allowedSenders || [],
        pairingCodeTTL: 300,
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
      },
      status: 'disconnected',
    });

    return channel;
  }

  /**
   * Update a channel configuration
   */
  updateChannel(channelId: string, updates: Partial<Channel>): void {
    this.channelRepo.update(channelId, updates);
  }

  /**
   * Enable a channel and connect
   */
  async enableChannel(channelId: string): Promise<void> {
    const channel = this.channelRepo.findById(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Create and register adapter if not already done
    let adapter = this.router.getAdapter(channel.type as ChannelType);
    if (!adapter) {
      adapter = this.createAdapterForChannel(channel);
      this.router.registerAdapter(adapter);
    }

    // Update channel state
    this.channelRepo.update(channelId, { enabled: true });

    // Connect
    await adapter.connect();
  }

  /**
   * Disable a channel and disconnect
   */
  async disableChannel(channelId: string): Promise<void> {
    const channel = this.channelRepo.findById(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    const adapter = this.router.getAdapter(channel.type as ChannelType);
    if (adapter) {
      await adapter.disconnect();
    }

    this.channelRepo.update(channelId, { enabled: false, status: 'disconnected' });
  }

  /**
   * Enable WhatsApp channel and set up QR code forwarding
   * This method connects the WhatsApp adapter and forwards QR codes to the renderer
   */
  async enableWhatsAppWithQRForwarding(channelId: string): Promise<void> {
    const channel = this.channelRepo.findById(channelId);
    if (!channel || channel.type !== 'whatsapp') {
      throw new Error('WhatsApp channel not found');
    }

    // Create and register adapter if not already done
    let adapter = this.router.getAdapter('whatsapp') as WhatsAppAdapter | undefined;
    if (!adapter) {
      adapter = this.createAdapterForChannel(channel) as WhatsAppAdapter;
      this.router.registerAdapter(adapter);
    }

    // Set up QR code forwarding to renderer
    const mainWindow = this.router.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      adapter.onQrCode((qr: string) => {
        console.log('WhatsApp QR code received, forwarding to renderer');
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whatsapp:qr-code', qr);
        }
      });

      adapter.onStatusChange((status, error) => {
        console.log(`WhatsApp status changed to: ${status}`);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whatsapp:status', { status, error: error?.message });
          if (status === 'connected') {
            mainWindow.webContents.send('whatsapp:connected');
            // Update channel status in database
            this.channelRepo.update(channelId, {
              enabled: true,
              status: 'connected',
              botUsername: adapter?.botUsername,
            });
          } else if (status === 'error') {
            this.channelRepo.update(channelId, { status: 'error' });
          } else if (status === 'disconnected') {
            this.channelRepo.update(channelId, { status: 'disconnected' });
          }
        }
      });
    }

    // Update channel state to connecting
    this.channelRepo.update(channelId, { enabled: true, status: 'connecting' });

    // Connect (this will trigger QR code generation)
    await adapter.connect();
  }

  /**
   * Get WhatsApp channel info including QR code
   */
  async getWhatsAppInfo(): Promise<{ qrCode?: string; phoneNumber?: string; status?: string }> {
    const channel = this.channelRepo.findByType('whatsapp');
    if (!channel) {
      return {};
    }

    const adapter = this.router.getAdapter('whatsapp') as WhatsAppAdapter | undefined;
    if (!adapter) {
      return { status: channel.status };
    }

    return {
      qrCode: adapter.qrCode,
      phoneNumber: adapter.botUsername,
      status: adapter.status,
    };
  }

  /**
   * Logout from WhatsApp and clear credentials
   */
  async whatsAppLogout(): Promise<void> {
    const adapter = this.router.getAdapter('whatsapp') as WhatsAppAdapter | undefined;
    if (adapter) {
      await adapter.logout();
    }

    const channel = this.channelRepo.findByType('whatsapp');
    if (channel) {
      this.channelRepo.update(channel.id, { enabled: false, status: 'disconnected', botUsername: undefined });
    }
  }

  /**
   * Remove a channel
   */
  async removeChannel(channelId: string): Promise<void> {
    await this.disableChannel(channelId);

    // Delete associated data first (to avoid foreign key constraint errors)
    this.messageRepo.deleteByChannelId(channelId);
    this.sessionRepo.deleteByChannelId(channelId);
    this.userRepo.deleteByChannelId(channelId);

    // Now delete the channel
    this.channelRepo.delete(channelId);
  }

  /**
   * Test a channel connection without enabling it
   */
  async testChannel(channelId: string): Promise<{ success: boolean; error?: string; botUsername?: string }> {
    const channel = this.channelRepo.findById(channelId);
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }

    try {
      const adapter = this.createAdapterForChannel(channel);
      await adapter.connect();
      const info = await adapter.getInfo();
      await adapter.disconnect();

      return {
        success: true,
        botUsername: info.botUsername,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get all channels
   */
  getChannels(): Channel[] {
    return this.channelRepo.findAll();
  }

  /**
   * Get a channel by ID
   */
  getChannel(channelId: string): Channel | undefined {
    return this.channelRepo.findById(channelId);
  }

  /**
   * Get channel by type
   */
  getChannelByType(type: string): Channel | undefined {
    return this.channelRepo.findByType(type);
  }

  // User Management

  /**
   * Generate a pairing code for a user
   */
  generatePairingCode(channelId: string, userId?: string, displayName?: string): string {
    const channel = this.channelRepo.findById(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }
    return this.securityManager.generatePairingCode(channel, userId, displayName);
  }

  /**
   * Grant access to a user
   */
  grantUserAccess(channelId: string, userId: string, displayName?: string): void {
    this.securityManager.grantAccess(channelId, userId, displayName);
  }

  /**
   * Revoke user access
   */
  revokeUserAccess(channelId: string, userId: string): void {
    this.securityManager.revokeAccess(channelId, userId);
  }

  /**
   * Get users for a channel
   * Automatically cleans up expired pending pairing entries
   */
  getChannelUsers(channelId: string): ReturnType<typeof this.userRepo.findByChannelId> {
    // Use securityManager to trigger cleanup of expired pending entries
    return this.securityManager.getChannelUsers(channelId);
  }

  // Messaging

  /**
   * Send a message to a channel chat
   */
  async sendMessage(
    channelType: ChannelType,
    chatId: string,
    text: string,
    options?: { replyTo?: string; parseMode?: 'text' | 'markdown' | 'html' }
  ): Promise<string> {
    return this.router.sendMessage(channelType, {
      chatId,
      text,
      replyTo: options?.replyTo,
      parseMode: options?.parseMode,
    });
  }

  /**
   * Send a message to a session's chat
   */
  async sendMessageToSession(
    sessionId: string,
    text: string,
    options?: { replyTo?: string; parseMode?: 'text' | 'markdown' | 'html' }
  ): Promise<string | null> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      console.error('Session not found:', sessionId);
      return null;
    }

    const channel = this.channelRepo.findById(session.channelId);
    if (!channel) {
      console.error('Channel not found:', session.channelId);
      return null;
    }

    return this.router.sendMessage(channel.type as ChannelType, {
      chatId: session.chatId,
      text,
      replyTo: options?.replyTo,
      parseMode: options?.parseMode,
    });
  }

  // Events

  /**
   * Register an event handler
   */
  onEvent(handler: GatewayEventHandler): void {
    this.router.onEvent(handler);
  }

  // Task response methods

  /**
   * Send a task update to the channel
   */
  async sendTaskUpdate(taskId: string, text: string): Promise<void> {
    return this.router.sendTaskUpdate(taskId, text);
  }

  /**
   * Handle task completion
   */
  async handleTaskCompletion(taskId: string, result?: string): Promise<void> {
    return this.router.handleTaskCompletion(taskId, result);
  }

  /**
   * Handle task failure
   */
  async handleTaskFailure(taskId: string, error: string): Promise<void> {
    return this.router.handleTaskFailure(taskId, error);
  }

  // Private methods

  /**
   * Load and register channel adapters
   */
  private async loadChannels(): Promise<void> {
    const channels = this.channelRepo.findAll();

    for (const channel of channels) {
      try {
        const adapter = this.createAdapterForChannel(channel);
        this.router.registerAdapter(adapter);
      } catch (error) {
        console.error(`Failed to create adapter for channel ${channel.type}:`, error);
      }
    }
  }

  /**
   * Create an adapter for a channel
   */
  private createAdapterForChannel(channel: Channel): ChannelAdapter {
    switch (channel.type) {
      case 'telegram':
        return createTelegramAdapter({
          enabled: channel.enabled,
          botToken: channel.config.botToken as string,
          webhookUrl: channel.config.webhookUrl as string | undefined,
        });

      case 'discord':
        return createDiscordAdapter({
          enabled: channel.enabled,
          botToken: channel.config.botToken as string,
          applicationId: channel.config.applicationId as string,
          guildIds: channel.config.guildIds as string[] | undefined,
        });

      case 'slack':
        return createSlackAdapter({
          enabled: channel.enabled,
          botToken: channel.config.botToken as string,
          appToken: channel.config.appToken as string,
          signingSecret: channel.config.signingSecret as string | undefined,
        });

      case 'whatsapp':
        return createWhatsAppAdapter({
          enabled: channel.enabled,
          allowedNumbers: channel.config.allowedNumbers as string[] | undefined,
          printQrToTerminal: true, // For debugging
          selfChatMode: channel.config.selfChatMode as boolean | undefined ?? true,
          responsePrefix: channel.config.responsePrefix as string | undefined ?? '🤖',
        });

      case 'imessage':
        return createImessageAdapter({
          enabled: channel.enabled,
          cliPath: channel.config.cliPath as string | undefined,
          dbPath: channel.config.dbPath as string | undefined,
          dmPolicy: channel.config.dmPolicy as 'open' | 'allowlist' | 'pairing' | 'disabled' | undefined,
          groupPolicy: channel.config.groupPolicy as 'open' | 'allowlist' | 'disabled' | undefined,
          allowedContacts: channel.config.allowedContacts as string[] | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'signal':
        return createSignalAdapter({
          enabled: channel.enabled,
          phoneNumber: channel.config.phoneNumber as string,
          cliPath: channel.config.cliPath as string | undefined,
          dataDir: channel.config.dataDir as string | undefined,
          mode: channel.config.mode as 'native' | 'daemon' | undefined,
          socketPath: channel.config.socketPath as string | undefined,
          trustMode: channel.config.trustMode as 'tofu' | 'always' | 'manual' | undefined,
          dmPolicy: channel.config.dmPolicy as 'open' | 'allowlist' | 'pairing' | 'disabled' | undefined,
          groupPolicy: channel.config.groupPolicy as 'open' | 'allowlist' | 'disabled' | undefined,
          allowedNumbers: channel.config.allowedNumbers as string[] | undefined,
          sendReadReceipts: channel.config.sendReadReceipts as boolean | undefined,
          sendTypingIndicators: channel.config.sendTypingIndicators as boolean | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'mattermost':
        return createMattermostAdapter({
          enabled: channel.enabled,
          serverUrl: channel.config.serverUrl as string,
          token: channel.config.token as string,
          teamId: channel.config.teamId as string | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'matrix':
        return createMatrixAdapter({
          enabled: channel.enabled,
          homeserver: channel.config.homeserver as string,
          userId: channel.config.userId as string,
          accessToken: channel.config.accessToken as string,
          deviceId: channel.config.deviceId as string | undefined,
          roomIds: channel.config.roomIds as string[] | undefined,
          sendTypingIndicators: channel.config.sendTypingIndicators as boolean | undefined,
          sendReadReceipts: channel.config.sendReadReceipts as boolean | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'twitch':
        return createTwitchAdapter({
          enabled: channel.enabled,
          username: channel.config.username as string,
          oauthToken: channel.config.oauthToken as string,
          channels: channel.config.channels as string[],
          allowWhispers: channel.config.allowWhispers as boolean | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'line':
        return createLineAdapter({
          enabled: channel.enabled,
          channelAccessToken: channel.config.channelAccessToken as string,
          channelSecret: channel.config.channelSecret as string,
          webhookPort: channel.config.webhookPort as number | undefined,
          webhookPath: channel.config.webhookPath as string | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'bluebubbles':
        return createBlueBubblesAdapter({
          enabled: channel.enabled,
          serverUrl: channel.config.serverUrl as string,
          password: channel.config.password as string,
          webhookPort: channel.config.webhookPort as number | undefined,
          webhookPath: channel.config.webhookPath as string | undefined,
          pollInterval: channel.config.pollInterval as number | undefined,
          allowedContacts: channel.config.allowedContacts as string[] | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      case 'email':
        return createEmailAdapter({
          enabled: channel.enabled,
          imapHost: channel.config.imapHost as string,
          imapPort: channel.config.imapPort as number | undefined,
          imapSecure: channel.config.imapSecure as boolean | undefined,
          smtpHost: channel.config.smtpHost as string,
          smtpPort: channel.config.smtpPort as number | undefined,
          smtpSecure: channel.config.smtpSecure as boolean | undefined,
          email: channel.config.email as string,
          password: channel.config.password as string,
          displayName: channel.config.displayName as string | undefined,
          mailbox: channel.config.mailbox as string | undefined,
          pollInterval: channel.config.pollInterval as number | undefined,
          markAsRead: channel.config.markAsRead as boolean | undefined,
          allowedSenders: channel.config.allowedSenders as string[] | undefined,
          subjectFilter: channel.config.subjectFilter as string | undefined,
          responsePrefix: channel.config.responsePrefix as string | undefined,
        });

      default:
        throw new Error(`Unsupported channel type: ${channel.type}`);
    }
  }
}

// Re-export types and components
export * from './channels/types';
export * from './router';
export * from './session';
export * from './security';
export * from './channel-registry';
export { TelegramAdapter, createTelegramAdapter } from './channels/telegram';
export { DiscordAdapter, createDiscordAdapter } from './channels/discord';
export { SlackAdapter, createSlackAdapter } from './channels/slack';
export { WhatsAppAdapter, createWhatsAppAdapter } from './channels/whatsapp';
export { ImessageAdapter, createImessageAdapter } from './channels/imessage';
export { SignalAdapter, createSignalAdapter } from './channels/signal';
export { SignalClient } from './channels/signal-client';
export { MattermostAdapter, createMattermostAdapter } from './channels/mattermost';
export { MattermostClient } from './channels/mattermost-client';
export { MatrixAdapter, createMatrixAdapter } from './channels/matrix';
export { MatrixClient } from './channels/matrix-client';
export { TwitchAdapter, createTwitchAdapter } from './channels/twitch';
export { TwitchClient } from './channels/twitch-client';
export { LineAdapter, createLineAdapter } from './channels/line';
export { LineClient } from './channels/line-client';
export { BlueBubblesAdapter, createBlueBubblesAdapter } from './channels/bluebubbles';
export { BlueBubblesClient } from './channels/bluebubbles-client';
export { EmailAdapter, createEmailAdapter } from './channels/email';
export { EmailClient } from './channels/email-client';
export { TunnelManager, getAvailableTunnelProviders, createAutoTunnel } from './tunnel';
export type { TunnelProvider, TunnelStatus, TunnelConfig, TunnelInfo } from './tunnel';
