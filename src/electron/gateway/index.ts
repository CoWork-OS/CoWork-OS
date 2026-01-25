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
  GatewayEventHandler,
} from './channels/types';
import { TelegramAdapter, createTelegramAdapter } from './channels/telegram';
import { DiscordAdapter, createDiscordAdapter } from './channels/discord';
import {
  ChannelRepository,
  ChannelUserRepository,
  Channel,
} from '../database/repositories';
import { AgentDaemon } from '../agent/daemon';

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

    // Listen for agent daemon events to send responses back to channels
    if (config.agentDaemon) {
      this.agentDaemon = config.agentDaemon;
      this.setupAgentDaemonListeners(config.agentDaemon);
    }
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
        // Save the last message as the result
        lastMessages.set(data.taskId, message);
        // Stream update to channel
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
      this.router.sendTaskUpdate(data.taskId, `⚠️ Tool error (${toolName}): ${errorMsg}`);
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

    const onFollowUpCompleted = (data: { taskId: string }) => {
      // If no assistant messages were sent during the follow-up, send a confirmation
      if (!followUpMessagesSent.get(data.taskId)) {
        this.router.sendTaskUpdate(data.taskId, '✅ Done');
      }
      followUpMessagesSent.delete(data.taskId);
    };
    agentDaemon.on('follow_up_completed', onFollowUpCompleted);
    this.daemonListeners.push({ event: 'follow_up_completed', handler: onFollowUpCompleted });

    // Listen for follow-up failures
    const onFollowUpFailed = (data: { taskId: string; error?: string }) => {
      const errorMsg = data.error || 'Unknown error';
      this.router.sendTaskUpdate(data.taskId, `❌ Follow-up failed: ${errorMsg}`);
      followUpMessagesSent.delete(data.taskId);
    };
    agentDaemon.on('follow_up_failed', onFollowUpFailed);
    this.daemonListeners.push({ event: 'follow_up_failed', handler: onFollowUpFailed });
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
   * Remove a channel
   */
  async removeChannel(channelId: string): Promise<void> {
    await this.disableChannel(channelId);
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
  generatePairingCode(channelId: string, userId: string, displayName?: string): string {
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
   */
  getChannelUsers(channelId: string): ReturnType<typeof this.userRepo.findByChannelId> {
    return this.userRepo.findByChannelId(channelId);
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
export { TelegramAdapter, createTelegramAdapter } from './channels/telegram';
export { DiscordAdapter, createDiscordAdapter } from './channels/discord';
