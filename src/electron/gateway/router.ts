/**
 * Message Router
 *
 * Routes incoming messages from channels to appropriate handlers.
 * Manages message flow: Security → Session → Task/Response
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  ChannelType,
  GatewayEvent,
  GatewayEventHandler,
} from './channels/types';
import { SecurityManager } from './security';
import { SessionManager } from './session';
import {
  ChannelRepository,
  ChannelUserRepository,
  ChannelSessionRepository,
  ChannelMessageRepository,
  WorkspaceRepository,
  TaskRepository,
  ArtifactRepository,
} from '../database/repositories';
import Database from 'better-sqlite3';
import { AgentDaemon } from '../agent/daemon';
import { Task, IPC_CHANNELS } from '../../shared/types';
import { LLMProviderFactory, LLMSettings } from '../agent/llm/provider-factory';
import { ModelKey, LLMProviderType } from '../agent/llm/types';

export interface RouterConfig {
  /** Default workspace ID to use for new sessions */
  defaultWorkspaceId?: string;
  /** Welcome message for new users */
  welcomeMessage?: string;
  /** Message shown when user is not authorized */
  unauthorizedMessage?: string;
  /** Message shown when pairing is required */
  pairingRequiredMessage?: string;
}

const DEFAULT_CONFIG: RouterConfig = {
  welcomeMessage: '👋 Welcome to CoWork! I can help you with tasks in your workspace.',
  unauthorizedMessage: '⚠️ You are not authorized to use this bot. Please contact the administrator.',
  pairingRequiredMessage: '🔐 Please enter your pairing code to get started.',
};

export class MessageRouter {
  private adapters: Map<ChannelType, ChannelAdapter> = new Map();
  private securityManager: SecurityManager;
  private sessionManager: SessionManager;
  private config: RouterConfig;
  private eventHandlers: GatewayEventHandler[] = [];
  private mainWindow: BrowserWindow | null = null;
  private agentDaemon?: AgentDaemon;

  // Repositories
  private channelRepo: ChannelRepository;
  private userRepo: ChannelUserRepository;
  private sessionRepo: ChannelSessionRepository;
  private messageRepo: ChannelMessageRepository;
  private workspaceRepo: WorkspaceRepository;
  private taskRepo: TaskRepository;
  private artifactRepo: ArtifactRepository;

  // Track pending responses for tasks
  private pendingTaskResponses: Map<string, { adapter: ChannelAdapter; chatId: string; sessionId: string }> = new Map();

  // Track pending approval requests for Discord/Telegram
  private pendingApprovals: Map<string, { taskId: string; approval: any; sessionId: string }> = new Map();

  constructor(db: Database.Database, config: RouterConfig = {}, agentDaemon?: AgentDaemon) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agentDaemon = agentDaemon;

    // Initialize repositories
    this.channelRepo = new ChannelRepository(db);
    this.userRepo = new ChannelUserRepository(db);
    this.sessionRepo = new ChannelSessionRepository(db);
    this.messageRepo = new ChannelMessageRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.artifactRepo = new ArtifactRepository(db);

    // Initialize managers
    this.securityManager = new SecurityManager(db);
    this.sessionManager = new SessionManager(db);

    // Listen for task events if agent daemon is available
    if (this.agentDaemon) {
      this.setupTaskEventListener();
    }
  }

  /**
   * Set up listener for task events to send responses back to channels
   */
  private setupTaskEventListener(): void {
    // We'll listen for task events through BrowserWindow IPC
    // The agent daemon emits events to all windows
  }

  /**
   * Set the main window for sending IPC events
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Register a channel adapter
   */
  registerAdapter(adapter: ChannelAdapter): void {
    // Set up message handler
    adapter.onMessage(async (message) => {
      await this.handleMessage(adapter, message);
    });

    // Set up error handler
    adapter.onError((error, context) => {
      console.error(`[${adapter.type}] Error in ${context}:`, error);
      this.emitEvent({
        type: 'channel:error',
        channel: adapter.type,
        timestamp: new Date(),
        data: { error: error.message, context },
      });
    });

    // Set up status handler
    adapter.onStatusChange((status, error) => {
      const eventType = status === 'connected' ? 'channel:connected' : 'channel:disconnected';
      this.emitEvent({
        type: eventType,
        channel: adapter.type,
        timestamp: new Date(),
        data: { status, error: error?.message },
      });

      // Update channel status in database
      const channel = this.channelRepo.findByType(adapter.type);
      if (channel) {
        this.channelRepo.update(channel.id, {
          status,
          botUsername: adapter.botUsername,
        });
      }
    });

    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Get a registered adapter
   */
  getAdapter(type: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }

  /**
   * Get all registered adapters
   */
  getAllAdapters(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Connect all enabled adapters
   */
  async connectAll(): Promise<void> {
    const enabledChannels = this.channelRepo.findEnabled();

    for (const channel of enabledChannels) {
      const adapter = this.adapters.get(channel.type as ChannelType);
      if (adapter && adapter.status !== 'connected') {
        try {
          await adapter.connect();
        } catch (error) {
          console.error(`Failed to connect ${channel.type}:`, error);
        }
      }
    }
  }

  /**
   * Disconnect all adapters
   */
  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.status === 'connected') {
        try {
          await adapter.disconnect();
        } catch (error) {
          console.error(`Failed to disconnect ${adapter.type}:`, error);
        }
      }
    }
  }

  /**
   * Send a message through a channel
   */
  async sendMessage(channelType: ChannelType, message: OutgoingMessage): Promise<string> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      throw new Error(`No adapter registered for channel type: ${channelType}`);
    }

    if (adapter.status !== 'connected') {
      throw new Error(`Adapter ${channelType} is not connected`);
    }

    const messageId = await adapter.sendMessage(message);

    // Find channel for logging
    const channel = this.channelRepo.findByType(channelType);
    if (channel) {
      // Log outgoing message
      this.messageRepo.create({
        channelId: channel.id,
        channelMessageId: messageId,
        chatId: message.chatId,
        direction: 'outgoing',
        content: message.text,
        timestamp: Date.now(),
      });

      this.emitEvent({
        type: 'message:sent',
        channel: channelType,
        timestamp: new Date(),
        data: { chatId: message.chatId, messageId },
      });
    }

    return messageId;
  }

  /**
   * Register an event handler
   */
  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }

  // Private methods

  /**
   * Handle an incoming message
   */
  private async handleMessage(adapter: ChannelAdapter, message: IncomingMessage): Promise<void> {
    const channelType = adapter.type;
    const channel = this.channelRepo.findByType(channelType);

    if (!channel) {
      console.error(`No channel configuration found for ${channelType}`);
      return;
    }

    // Log incoming message
    this.messageRepo.create({
      channelId: channel.id,
      channelMessageId: message.messageId,
      chatId: message.chatId,
      direction: 'incoming',
      content: message.text,
      timestamp: message.timestamp.getTime(),
    });

    this.emitEvent({
      type: 'message:received',
      channel: channelType,
      timestamp: new Date(),
      data: {
        messageId: message.messageId,
        chatId: message.chatId,
        userId: message.userId,
        preview: message.text.slice(0, 100),
      },
    });

    // Security check
    const securityResult = await this.securityManager.checkAccess(channel, message);

    if (!securityResult.allowed) {
      // Handle unauthorized access
      await this.handleUnauthorizedMessage(adapter, message, securityResult);
      return;
    }

    // Update user's last seen
    if (securityResult.user) {
      this.userRepo.update(securityResult.user.id, {
        lastSeenAt: Date.now(),
      });
    }

    // Get or create session
    const session = await this.sessionManager.getOrCreateSession(
      channel,
      message.chatId,
      securityResult.user?.id,
      this.config.defaultWorkspaceId
    );

    // Handle the message based on content
    await this.routeMessage(adapter, message, session.id);
  }

  /**
   * Handle unauthorized message
   */
  private async handleUnauthorizedMessage(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    securityResult: { reason?: string; pairingRequired?: boolean }
  ): Promise<void> {
    // If pairing is required, check if the message IS a pairing code or /pair command
    if (securityResult.pairingRequired) {
      const text = message.text.trim();

      // Check if it's a /pair command
      if (text.toLowerCase().startsWith('/pair ')) {
        const code = text.slice(6).trim(); // Remove '/pair ' prefix
        if (code) {
          await this.handlePairingAttempt(adapter, message, code);
          return;
        }
      }

      // Check if the raw text looks like a pairing code
      if (this.looksLikePairingCode(text)) {
        // This looks like a pairing code - try to verify it
        await this.handlePairingAttempt(adapter, message, text);
        return;
      }
    }

    // Not a pairing code or pairing not required - send appropriate message
    let responseText: string;

    if (securityResult.pairingRequired) {
      responseText = this.config.pairingRequiredMessage!;
    } else {
      responseText = this.config.unauthorizedMessage!;
    }

    try {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: responseText,
        replyTo: message.messageId,
      });
    } catch (error) {
      console.error('Failed to send unauthorized message response:', error);
    }
  }

  /**
   * Route message to appropriate handler
   */
  private async routeMessage(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const text = message.text.trim();

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(adapter, message, sessionId);
      return;
    }

    // Check if this is a pairing code
    if (this.looksLikePairingCode(text)) {
      await this.handlePairingAttempt(adapter, message, text);
      return;
    }

    // Regular message - send to desktop app for task processing
    await this.forwardToDesktopApp(adapter, message, sessionId);
  }

  /**
   * Handle bot commands
   */
  private async handleCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const [command, ...args] = message.text.trim().split(/\s+/);

    switch (command.toLowerCase()) {
      case '/start':
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.config.welcomeMessage!,
        });
        break;

      case '/help':
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getHelpText(),
        });
        break;

      case '/status':
        await this.handleStatusCommand(adapter, message, sessionId);
        break;

      case '/workspaces':
        await this.handleWorkspacesCommand(adapter, message);
        break;

      case '/workspace':
        await this.handleWorkspaceCommand(adapter, message, sessionId, args);
        break;

      case '/cancel':
        // Cancel current task if any
        await this.handleCancelCommand(adapter, message, sessionId);
        break;

      case '/newtask':
        // Start a new task (unlink current session)
        await this.handleNewTaskCommand(adapter, message, sessionId);
        break;

      case '/addworkspace':
        await this.handleAddWorkspaceCommand(adapter, message, sessionId, args);
        break;

      case '/models':
        await this.handleModelsCommand(adapter, message);
        break;

      case '/model':
        await this.handleModelCommand(adapter, message, args);
        break;

      case '/provider':
        await this.handleProviderCommand(adapter, message, args);
        break;

      case '/pair':
        // Handle pairing code
        if (args.length === 0) {
          await adapter.sendMessage({
            chatId: message.chatId,
            text: '🔐 Please provide a pairing code.\n\nUsage: `/pair <code>`',
            parseMode: 'markdown',
          });
        } else {
          const code = args[0].trim();
          await this.handlePairingAttempt(adapter, message, code);
        }
        break;

      case '/shell':
        await this.handleShellCommand(adapter, message, sessionId, args);
        break;

      case '/approve':
      case '/yes':
      case '/y':
        await this.handleApproveCommand(adapter, message, sessionId);
        break;

      case '/deny':
      case '/no':
      case '/n':
        await this.handleDenyCommand(adapter, message, sessionId);
        break;

      default:
        await adapter.sendMessage({
          chatId: message.chatId,
          text: `Unknown command: ${command}\n\nUse /help to see available commands.`,
          replyTo: message.messageId,
        });
    }
  }

  /**
   * Handle /status command
   */
  private async handleStatusCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    let statusText = '✅ Bot is online and ready.\n\n';

    if (session?.workspaceId) {
      const workspace = this.workspaceRepo.findById(session.workspaceId);
      if (workspace) {
        statusText += `📁 Current workspace: ${workspace.name}\n`;
        statusText += `   Path: ${workspace.path}\n`;
      }
    } else {
      statusText += '⚠️ No workspace selected. Use /workspaces to see available workspaces.';
    }

    if (session?.taskId) {
      const task = this.taskRepo.findById(session.taskId);
      if (task) {
        statusText += `\n🔄 Active task: ${task.title} (${task.status})`;
      }
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text: statusText,
    });
  }

  /**
   * Handle /workspaces command - list available workspaces
   */
  private async handleWorkspacesCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage
  ): Promise<void> {
    const workspaces = this.workspaceRepo.findAll();

    if (workspaces.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '📁 No workspaces configured yet.\n\nAdd a workspace in the CoWork desktop app first.',
      });
      return;
    }

    let text = '📁 *Available Workspaces*\n\n';
    workspaces.forEach((ws, index) => {
      text += `${index + 1}. *${ws.name}*\n   \`${ws.path}\`\n\n`;
    });
    text += 'Use `/workspace <number>` or `/workspace <name>` to select a workspace.';

    await adapter.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /workspace command - set current workspace
   */
  private async handleWorkspaceCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    if (args.length === 0) {
      // Show current workspace
      const session = this.sessionRepo.findById(sessionId);
      if (session?.workspaceId) {
        const workspace = this.workspaceRepo.findById(session.workspaceId);
        if (workspace) {
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `📁 Current workspace: *${workspace.name}*\n\`${workspace.path}\``,
            parseMode: 'markdown',
          });
          return;
        }
      }
      await adapter.sendMessage({
        chatId: message.chatId,
        text: 'No workspace selected. Use `/workspaces` to see available workspaces.',
        parseMode: 'markdown',
      });
      return;
    }

    const workspaces = this.workspaceRepo.findAll();
    const selector = args.join(' ');
    let workspace;

    // Try to find by number
    const num = parseInt(selector, 10);
    if (!isNaN(num) && num > 0 && num <= workspaces.length) {
      workspace = workspaces[num - 1];
    } else {
      // Try to find by name (case-insensitive)
      workspace = workspaces.find(
        ws => ws.name.toLowerCase() === selector.toLowerCase()
      );
    }

    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ Workspace not found: "${selector}"\n\nUse /workspaces to see available workspaces.`,
      });
      return;
    }

    // Update session workspace
    this.sessionManager.setSessionWorkspace(sessionId, workspace.id);

    await adapter.sendMessage({
      chatId: message.chatId,
      text: `✅ Workspace set to: *${workspace.name}*\n\`${workspace.path}\`\n\nYou can now send messages to create tasks in this workspace.`,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /addworkspace command - add a new workspace by path
   */
  private async handleAddWorkspaceCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    if (args.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '📁 *Add Workspace*\n\nUsage: `/addworkspace <path>`\n\nExample:\n`/addworkspace /Users/john/projects/myapp`\n`/addworkspace ~/Documents`',
        parseMode: 'markdown',
      });
      return;
    }

    // Join args to handle paths with spaces
    let workspacePath = args.join(' ');

    // Expand ~ to home directory
    if (workspacePath.startsWith('~')) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      workspacePath = workspacePath.replace('~', homeDir);
    }

    // Resolve to absolute path
    workspacePath = path.resolve(workspacePath);

    // Check if path exists and is a directory
    try {
      const stats = fs.statSync(workspacePath);
      if (!stats.isDirectory()) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: `❌ Path is not a directory: \`${workspacePath}\``,
          parseMode: 'markdown',
        });
        return;
      }
    } catch {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ Directory not found: \`${workspacePath}\``,
        parseMode: 'markdown',
      });
      return;
    }

    // Check if workspace already exists
    const existingWorkspaces = this.workspaceRepo.findAll();
    const existing = existingWorkspaces.find(ws => ws.path === workspacePath);
    if (existing) {
      // Workspace exists, just select it
      this.sessionManager.setSessionWorkspace(sessionId, existing.id);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `📁 Workspace already exists!\n\n✅ Selected: *${existing.name}*\n\`${existing.path}\``,
        parseMode: 'markdown',
      });
      return;
    }

    // Create workspace name from path
    const workspaceName = path.basename(workspacePath);

    // Create new workspace with default permissions
    const workspace = this.workspaceRepo.create(
      workspaceName,
      workspacePath,
      {
        read: true,
        write: true,
        delete: false, // Requires approval
        network: false,
        shell: false, // Requires approval
      }
    );

    // Set as current workspace
    this.sessionManager.setSessionWorkspace(sessionId, workspace.id);

    // Notify desktop app
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('workspace:added', {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
      });
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text: `✅ Workspace added and selected!\n\n📁 *${workspace.name}*\n\`${workspace.path}\`\n\nYou can now send messages to create tasks in this workspace.`,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /models command - list available models and providers
   */
  private async handleModelsCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage
  ): Promise<void> {
    const status = LLMProviderFactory.getConfigStatus();
    const settings = LLMProviderFactory.loadSettings();
    const isOllama = status.currentProvider === 'ollama';

    let text = '🤖 *AI Models & Providers*\n\n';

    // Current configuration
    text += '*Current:*\n';
    const currentProvider = status.providers.find(p => p.type === status.currentProvider);

    if (isOllama) {
      const ollamaModel = settings.ollama?.model || 'gpt-oss:20b';
      text += `• Provider: ${currentProvider?.name || 'Ollama'}\n`;
      text += `• Model: ${ollamaModel}\n\n`;
    } else {
      const currentModel = status.models.find(m => m.key === status.currentModel);
      text += `• Provider: ${currentProvider?.name || status.currentProvider}\n`;
      text += `• Model: ${currentModel?.displayName || status.currentModel}\n\n`;
    }

    // Available providers
    text += '*Available Providers:*\n';
    status.providers.forEach(provider => {
      const isActive = provider.type === status.currentProvider ? ' ✓' : '';
      const configStatus = provider.configured ? '🟢' : '⚪';
      text += `${configStatus} ${provider.name}${isActive}\n`;
    });
    text += '\n';

    // Available models - show different list based on provider
    if (isOllama) {
      text += '*Available Ollama Models:*\n';
      try {
        const ollamaModels = await LLMProviderFactory.getOllamaModels();
        const currentOllamaModel = settings.ollama?.model || 'gpt-oss:20b';

        if (ollamaModels.length === 0) {
          text += '⚠️ No models found. Run `ollama pull <model>` to download.\n';
        } else {
          ollamaModels.slice(0, 10).forEach((model, index) => {
            const isActive = model.name === currentOllamaModel ? ' ✓' : '';
            const sizeGB = (model.size / 1e9).toFixed(1);
            text += `${index + 1}. ${model.name} (${sizeGB}GB)${isActive}\n`;
          });
          if (ollamaModels.length > 10) {
            text += `   ... and ${ollamaModels.length - 10} more\n`;
          }
        }
      } catch {
        text += '⚠️ Could not fetch Ollama models. Is Ollama running?\n';
      }
      text += '\n💡 Use `/model <name>` to switch (e.g., `/model gpt-oss:20b`)';
    } else {
      text += '*Available Claude Models:*\n';
      status.models.forEach((model, index) => {
        const isActive = model.key === status.currentModel ? ' ✓' : '';
        text += `${index + 1}. ${model.displayName}${isActive}\n`;
      });
      text += '\n💡 Use `/model <name>` to switch\n';
      text += 'Example: `/model sonnet-4` or `/model 2`';
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /model command - show or change current model within current provider
   */
  private async handleModelCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    args: string[]
  ): Promise<void> {
    const status = LLMProviderFactory.getConfigStatus();
    const settings = LLMProviderFactory.loadSettings();
    const isOllama = status.currentProvider === 'ollama';
    const currentProvider = status.providers.find(p => p.type === status.currentProvider);

    // If no args, show current model and available models
    if (args.length === 0) {
      let text = '🤖 *Current Model*\n\n';

      if (isOllama) {
        const ollamaModel = settings.ollama?.model || 'gpt-oss:20b';
        text += `• Provider: ${currentProvider?.name || 'Ollama'}\n`;
        text += `• Model: ${ollamaModel}\n\n`;

        // Show available Ollama models
        text += '*Available Models:*\n';
        try {
          const ollamaModels = await LLMProviderFactory.getOllamaModels();
          if (ollamaModels.length === 0) {
            text += '⚠️ No models found.\n';
          } else {
            ollamaModels.slice(0, 8).forEach((model, index) => {
              const isActive = model.name === ollamaModel ? ' ✓' : '';
              const sizeGB = (model.size / 1e9).toFixed(1);
              text += `${index + 1}. ${model.name} (${sizeGB}GB)${isActive}\n`;
            });
            if (ollamaModels.length > 8) {
              text += `   ... and ${ollamaModels.length - 8} more\n`;
            }
          }
        } catch {
          text += '⚠️ Could not fetch models.\n';
        }
        text += '\n💡 Use `/model <name>` or `/model <number>` to switch';
      } else {
        const currentModel = status.models.find(m => m.key === status.currentModel);
        text += `• Provider: ${currentProvider?.name || status.currentProvider}\n`;
        text += `• Model: ${currentModel?.displayName || status.currentModel}\n\n`;

        // Show available Claude models
        text += '*Available Models:*\n';
        status.models.forEach((model, index) => {
          const isActive = model.key === status.currentModel ? ' ✓' : '';
          text += `${index + 1}. ${model.displayName}${isActive}\n`;
        });
        text += '\n💡 Use `/model <name>` or `/model <number>` to switch';
      }

      await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
      });
      return;
    }

    // Change model within current provider
    const selector = args.join(' ').toLowerCase();

    if (isOllama) {
      const result = await this.selectOllamaModel(selector, args);
      if (!result.success) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: result.error!,
          parseMode: 'markdown',
        });
        return;
      }

      const newSettings: LLMSettings = {
        ...settings,
        ollama: {
          ...settings.ollama,
          model: result.model!,
        },
      };

      LLMProviderFactory.saveSettings(newSettings);
      LLMProviderFactory.clearCache();

      await adapter.sendMessage({
        chatId: message.chatId,
        text: `✅ Model changed to: *${result.model}*`,
        parseMode: 'markdown',
      });
      return;
    }

    // For Anthropic/Bedrock, match against Claude models
    const result = this.selectClaudeModel(selector, status.models);
    if (!result.success) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: result.error!,
      });
      return;
    }

    const newSettings: LLMSettings = {
      ...settings,
      modelKey: result.model!.key as ModelKey,
    };

    LLMProviderFactory.saveSettings(newSettings);
    LLMProviderFactory.clearCache();

    await adapter.sendMessage({
      chatId: message.chatId,
      text: `✅ Model changed to: *${result.model!.displayName}*`,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /provider command - show or change current provider
   */
  private async handleProviderCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    args: string[]
  ): Promise<void> {
    const status = LLMProviderFactory.getConfigStatus();
    const settings = LLMProviderFactory.loadSettings();

    // If no args, show current provider and available options
    if (args.length === 0) {
      const currentProvider = status.providers.find(p => p.type === status.currentProvider);

      let text = '🔌 *Current Provider*\n\n';
      text += `• Provider: ${currentProvider?.name || status.currentProvider}\n`;

      // Show current model for context
      if (status.currentProvider === 'ollama') {
        text += `• Model: ${settings.ollama?.model || 'gpt-oss:20b'}\n\n`;
      } else {
        const currentModel = status.models.find(m => m.key === status.currentModel);
        text += `• Model: ${currentModel?.displayName || status.currentModel}\n\n`;
      }

      text += '*Available Providers:*\n';
      text += '1. anthropic - Anthropic API (direct)\n';
      text += '2. openai - OpenAI/ChatGPT\n';
      text += '3. gemini - Google Gemini\n';
      text += '4. openrouter - OpenRouter\n';
      text += '5. bedrock - AWS Bedrock\n';
      text += '6. ollama - Ollama (local)\n\n';

      text += '💡 Use `/provider <name>` to switch\n';
      text += 'Example: `/provider bedrock` or `/provider 2`';

      await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
      });
      return;
    }

    const selector = args[0].toLowerCase();

    // Map of provider shortcuts
    const providerMap: Record<string, LLMProviderType> = {
      '1': 'anthropic',
      'anthropic': 'anthropic',
      'api': 'anthropic',
      '2': 'openai',
      'openai': 'openai',
      'chatgpt': 'openai',
      '3': 'gemini',
      'gemini': 'gemini',
      'google': 'gemini',
      '4': 'openrouter',
      'openrouter': 'openrouter',
      'or': 'openrouter',
      '5': 'bedrock',
      'bedrock': 'bedrock',
      'aws': 'bedrock',
      '6': 'ollama',
      'ollama': 'ollama',
      'local': 'ollama',
    };

    const targetProvider = providerMap[selector];
    if (!targetProvider) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ Unknown provider: "${args[0]}"\n\n*Available providers:*\n1. anthropic\n2. openai\n3. gemini\n4. openrouter\n5. bedrock\n6. ollama\n\nUse \`/provider <name>\` or \`/provider <number>\``,
        parseMode: 'markdown',
      });
      return;
    }

    // Update provider
    const newSettings: LLMSettings = {
      ...settings,
      providerType: targetProvider,
    };

    LLMProviderFactory.saveSettings(newSettings);
    LLMProviderFactory.clearCache();

    // Get provider display info
    const providerInfo = status.providers.find(p => p.type === targetProvider);
    let modelInfo: string;

    if (targetProvider === 'ollama') {
      modelInfo = settings.ollama?.model || 'gpt-oss:20b';
    } else {
      const model = status.models.find(m => m.key === settings.modelKey);
      modelInfo = model?.displayName || settings.modelKey;
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text: `✅ Provider changed to: *${providerInfo?.name || targetProvider}*\n\nCurrent model: ${modelInfo}\n\nUse \`/model\` to see available models for this provider.`,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /shell command - enable or disable shell execution permission
   */
  private async handleShellCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);

    if (!session?.workspaceId) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '⚠️ No workspace selected. Use `/workspace` to select one first.',
        parseMode: 'markdown',
      });
      return;
    }

    const workspace = this.workspaceRepo.findById(session.workspaceId);
    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Workspace not found.',
      });
      return;
    }

    // If no args, show current status
    if (args.length === 0) {
      const status = workspace.permissions.shell ? '🟢 Enabled' : '🔴 Disabled';
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `🖥️ *Shell Commands*\n\nStatus: ${status}\n\nWhen enabled, the AI can execute shell commands like \`npm install\`, \`git\`, etc. Each command requires your approval before running.\n\n*Usage:*\n• \`/shell on\` - Enable shell commands\n• \`/shell off\` - Disable shell commands`,
        parseMode: 'markdown',
      });
      return;
    }

    const action = args[0].toLowerCase();
    let newShellPermission: boolean;

    if (action === 'on' || action === 'enable' || action === '1' || action === 'true') {
      newShellPermission = true;
    } else if (action === 'off' || action === 'disable' || action === '0' || action === 'false') {
      newShellPermission = false;
    } else {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Invalid option. Use `/shell on` or `/shell off`',
        parseMode: 'markdown',
      });
      return;
    }

    // Update workspace permissions
    const updatedPermissions = {
      ...workspace.permissions,
      shell: newShellPermission,
    };

    // Update in database
    this.workspaceRepo.updatePermissions(workspace.id, updatedPermissions);

    const statusText = newShellPermission ? '🟢 enabled' : '🔴 disabled';
    const warning = newShellPermission
      ? '\n\n⚠️ The AI will now ask for approval before running each command.'
      : '';

    await adapter.sendMessage({
      chatId: message.chatId,
      text: `✅ Shell commands ${statusText} for workspace *${workspace.name}*${warning}`,
      parseMode: 'markdown',
    });
  }

  /**
   * Helper to select an Ollama model from available models
   */
  private async selectOllamaModel(
    selector: string,
    originalArgs: string[]
  ): Promise<{ success: boolean; model?: string; error?: string }> {
    let ollamaModels: Array<{ name: string; size: number; modified: string }> = [];
    try {
      ollamaModels = await LLMProviderFactory.getOllamaModels();
    } catch {
      return {
        success: false,
        error: `❌ Could not fetch Ollama models. Is Ollama running?\n\nMake sure Ollama is running with \`ollama serve\``,
      };
    }

    if (ollamaModels.length === 0) {
      return {
        success: false,
        error: `❌ No Ollama models found.\n\nRun \`ollama pull <model>\` to download a model first.`,
      };
    }

    let selectedModel: string | undefined;

    // Try to find model by number
    const num = parseInt(selector, 10);
    if (!isNaN(num) && num > 0 && num <= ollamaModels.length) {
      selectedModel = ollamaModels[num - 1].name;
    } else {
      // Try to find by name (exact or partial match)
      const match = ollamaModels.find(
        m => m.name.toLowerCase() === selector ||
             m.name.toLowerCase().includes(selector)
      );
      if (match) {
        selectedModel = match.name;
      }
    }

    if (!selectedModel) {
      const modelList = ollamaModels.slice(0, 5).map((m, i) => `${i + 1}. ${m.name}`).join('\n');
      const moreText = ollamaModels.length > 5 ? `\n   ... and ${ollamaModels.length - 5} more` : '';
      return {
        success: false,
        error: `❌ Model not found: "${originalArgs.join(' ')}"\n\n*Available Ollama models:*\n${modelList}${moreText}\n\nUse \`/model <name>\` or \`/model <number>\``,
      };
    }

    return { success: true, model: selectedModel };
  }

  /**
   * Helper to select a Claude model from available models
   */
  private selectClaudeModel(
    selector: string,
    models: Array<{ key: string; displayName: string }>
  ): { success: boolean; model?: { key: string; displayName: string }; error?: string } {
    let selectedModel: { key: string; displayName: string } | undefined;

    // Try to find model by number
    const num = parseInt(selector, 10);
    if (!isNaN(num) && num > 0 && num <= models.length) {
      selectedModel = models[num - 1];
    } else {
      // Try to find by name (partial match)
      selectedModel = models.find(
        m => m.key.toLowerCase() === selector ||
             m.key.toLowerCase().includes(selector) ||
             m.displayName.toLowerCase().includes(selector)
      );
    }

    if (!selectedModel) {
      return {
        success: false,
        error: `❌ Model not found: "${selector}"\n\nUse /models to see available options.`,
      };
    }

    return { success: true, model: selectedModel };
  }

  /**
   * Check if text looks like a pairing code
   */
  private looksLikePairingCode(text: string): boolean {
    // Pairing codes are typically 6-8 alphanumeric characters
    return /^[A-Z0-9]{6,8}$/i.test(text);
  }

  /**
   * Handle pairing code attempt
   */
  private async handlePairingAttempt(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    code: string
  ): Promise<void> {
    const channel = this.channelRepo.findByType(adapter.type);
    if (!channel) return;

    const result = await this.securityManager.verifyPairingCode(channel, message.userId, code);

    if (result.success) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '✅ Pairing successful! You can now use the bot.',
        replyTo: message.messageId,
      });

      this.emitEvent({
        type: 'user:paired',
        channel: adapter.type,
        timestamp: new Date(),
        data: { userId: message.userId, userName: message.userName },
      });
    } else {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ ${result.error || 'Invalid pairing code. Please try again.'}`,
        replyTo: message.messageId,
      });
    }
  }

  /**
   * Forward message to desktop app / create task
   */
  private async forwardToDesktopApp(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);

    // Check if workspace is selected
    if (!session?.workspaceId) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '⚠️ Please select a workspace first.\n\nUse `/workspaces` to see available workspaces, then `/workspace <name>` to select one.',
        parseMode: 'markdown',
        replyTo: message.messageId,
      });
      return;
    }

    // Check if there's an existing task for this session (active or completed)
    if (session.taskId) {
      const existingTask = this.taskRepo.findById(session.taskId);
      if (existingTask) {
        // For active tasks, send follow-up message
        // For completed tasks, also allow follow-up (continues the conversation)
        const activeStatuses = ['pending', 'planning', 'executing', 'paused'];
        const isActive = activeStatuses.includes(existingTask.status);
        const isCompleted = existingTask.status === 'completed';

        if (isActive || isCompleted) {
          if (this.agentDaemon) {
            try {
              const statusMsg = isActive
                ? '💬 Sending follow-up message...'
                : '💬 Continuing conversation...';
              await adapter.sendMessage({
                chatId: message.chatId,
                text: statusMsg,
                replyTo: message.messageId,
              });

              // Re-register task for response tracking (may have been removed after initial completion)
              this.pendingTaskResponses.set(session.taskId, {
                adapter,
                chatId: message.chatId,
                sessionId,
              });

              await this.agentDaemon.sendMessage(session.taskId, message.text);
            } catch (error) {
              console.error('Error sending follow-up message:', error);
              await adapter.sendMessage({
                chatId: message.chatId,
                text: '❌ Failed to send message. Use /newtask to start a new task.',
              });
            }
          }
          return;
        }
        // Task is in failed/cancelled state - unlink and create new task
        this.sessionManager.unlinkSessionFromTask(sessionId);
      }
    }

    // Create a new task
    if (!this.agentDaemon) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Agent not available. Please try again later.',
        replyTo: message.messageId,
      });
      return;
    }

    // Get workspace
    const workspace = this.workspaceRepo.findById(session.workspaceId);
    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Workspace not found. Please select a workspace with /workspace.',
        replyTo: message.messageId,
      });
      return;
    }

    // Create task
    const taskTitle = message.text.length > 50
      ? message.text.substring(0, 50) + '...'
      : message.text;

    const task = this.taskRepo.create({
      workspaceId: workspace.id,
      title: taskTitle,
      prompt: message.text,
      status: 'pending',
    });

    // Link session to task
    this.sessionManager.linkSessionToTask(sessionId, task.id);

    // Track this task for response handling
    this.pendingTaskResponses.set(task.id, {
      adapter,
      chatId: message.chatId,
      sessionId,
    });

    // Send acknowledgment
    await adapter.sendMessage({
      chatId: message.chatId,
      text: `🚀 Starting task: "${taskTitle}"\n\nI'll notify you when it's complete or if I need your input.`,
      replyTo: message.messageId,
    });

    // Notify desktop app via IPC
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('gateway:message', {
        channel: adapter.type,
        sessionId,
        taskId: task.id,
        message: {
          id: message.messageId,
          userId: message.userId,
          userName: message.userName,
          chatId: message.chatId,
          text: message.text,
          timestamp: message.timestamp.getTime(),
        },
      });
    }

    // Start task execution
    try {
      await this.agentDaemon.startTask(task);
    } catch (error) {
      console.error('Error starting task:', error);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ Failed to start task: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });

      // Cleanup
      this.pendingTaskResponses.delete(task.id);
      this.sessionManager.unlinkSessionFromTask(sessionId);
    }
  }

  /**
   * Send task update to channel
   */
  async sendTaskUpdate(taskId: string, text: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) {
      // This is expected for tasks started from the UI (not via Telegram)
      return;
    }

    try {
      await pending.adapter.sendMessage({
        chatId: pending.chatId,
        text,
        parseMode: 'markdown',
      });
    } catch (error) {
      console.error('Error sending task update:', error);
    }
  }

  /**
   * Handle task completion
   * Note: We keep the session linked to the task for follow-up messages
   */
  async handleTaskCompletion(taskId: string, result?: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) return;

    try {
      const message = result
        ? `✅ Task completed!\n\n${result}\n\n💡 Send a follow-up message to continue, or use /newtask to start fresh.`
        : '✅ Task completed!\n\n💡 Send a follow-up message to continue, or use /newtask to start fresh.';

      // Split long messages (Telegram has 4096 char limit)
      const chunks = this.splitMessage(message, 4000);
      for (const chunk of chunks) {
        await pending.adapter.sendMessage({
          chatId: pending.chatId,
          text: chunk,
          parseMode: 'markdown',
        });
      }

      // Send artifacts if any were created
      await this.sendTaskArtifacts(taskId, pending.adapter, pending.chatId);

      // Don't unlink session - keep it linked for follow-up messages
      // User can use /newtask to explicitly start a new task
    } catch (error) {
      console.error('Error sending task completion:', error);
    } finally {
      this.pendingTaskResponses.delete(taskId);
    }
  }

  /**
   * Send task artifacts as documents to the channel
   */
  private async sendTaskArtifacts(
    taskId: string,
    adapter: ChannelAdapter,
    chatId: string
  ): Promise<void> {
    try {
      const artifacts = this.artifactRepo.findByTaskId(taskId);
      if (artifacts.length === 0) return;

      // Filter for sendable file types (documents, spreadsheets, etc.)
      const sendableExtensions = [
        '.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt',
        '.txt', '.csv', '.json', '.md', '.html', '.xml'
      ];

      const sendableArtifacts = artifacts.filter(artifact => {
        const ext = path.extname(artifact.path).toLowerCase();
        return sendableExtensions.includes(ext) && fs.existsSync(artifact.path);
      });

      if (sendableArtifacts.length === 0) return;

      // Check if adapter supports sendDocument
      if (!adapter.sendDocument) {
        console.log('Adapter does not support sendDocument, skipping artifact delivery');
        return;
      }

      // Send each artifact
      for (const artifact of sendableArtifacts) {
        try {
          const fileName = path.basename(artifact.path);
          await adapter.sendDocument(chatId, artifact.path, `📎 ${fileName}`);
          console.log(`Sent artifact: ${fileName}`);
        } catch (err) {
          console.error(`Failed to send artifact ${artifact.path}:`, err);
        }
      }
    } catch (error) {
      console.error('Error sending task artifacts:', error);
    }
  }

  /**
   * Handle task failure
   */
  async handleTaskFailure(taskId: string, error: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) return;

    try {
      await pending.adapter.sendMessage({
        chatId: pending.chatId,
        text: `❌ Task failed: ${error}`,
      });

      // Unlink session from task
      this.sessionManager.unlinkSessionFromTask(pending.sessionId);
    } catch (err) {
      console.error('Error sending task failure:', err);
    } finally {
      this.pendingTaskResponses.delete(taskId);
    }
  }

  /**
   * Send approval request to Discord/Telegram
   */
  async sendApprovalRequest(taskId: string, approval: any): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) return;

    // Store approval for response handling
    this.pendingApprovals.set(approval.id, {
      taskId,
      approval,
      sessionId: pending.sessionId,
    });

    // Format approval message
    let message = `🔐 *Approval Required*\n\n`;
    message += `**${approval.description}**\n\n`;

    if (approval.type === 'run_command' && approval.details?.command) {
      message += `\`\`\`\n${approval.details.command}\n\`\`\`\n\n`;
    } else if (approval.details) {
      message += `Details: ${JSON.stringify(approval.details, null, 2)}\n\n`;
    }

    message += `Reply with:\n`;
    message += `• \`/approve\` - Allow this action\n`;
    message += `• \`/deny\` - Reject this action\n\n`;
    message += `⏳ _Expires in 5 minutes_`;

    try {
      await pending.adapter.sendMessage({
        chatId: pending.chatId,
        text: message,
        parseMode: 'markdown',
      });
    } catch (error) {
      console.error('Error sending approval request:', error);
    }
  }

  /**
   * Handle /approve command
   */
  private async handleApproveCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    // Find pending approval for this session
    const approvalEntry = Array.from(this.pendingApprovals.entries())
      .find(([, data]) => data.sessionId === sessionId);

    if (!approvalEntry) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ No pending approval request.',
      });
      return;
    }

    const [approvalId, data] = approvalEntry;
    this.pendingApprovals.delete(approvalId);

    try {
      await this.agentDaemon?.respondToApproval(approvalId, true);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '✅ Approved! Executing...',
      });
    } catch (error) {
      console.error('Error responding to approval:', error);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Failed to process approval.',
      });
    }
  }

  /**
   * Handle /deny command
   */
  private async handleDenyCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    // Find pending approval for this session
    const approvalEntry = Array.from(this.pendingApprovals.entries())
      .find(([, data]) => data.sessionId === sessionId);

    if (!approvalEntry) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ No pending approval request.',
      });
      return;
    }

    const [approvalId] = approvalEntry;
    this.pendingApprovals.delete(approvalId);

    try {
      await this.agentDaemon?.respondToApproval(approvalId, false);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '🛑 Denied. Action cancelled.',
      });
    } catch (error) {
      console.error('Error responding to denial:', error);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: '❌ Failed to process denial.',
      });
    }
  }

  /**
   * Split a message into chunks for Telegram's character limit
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try to split at space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Force split
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  /**
   * Handle cancel command
   */
  private async handleCancelCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);

    if (session?.taskId) {
      // Notify desktop app to cancel the task
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('gateway:cancel-task', {
          taskId: session.taskId,
          sessionId,
        });
      }

      // Update session state
      this.sessionRepo.update(sessionId, { state: 'idle', taskId: undefined });

      await adapter.sendMessage({
        chatId: message.chatId,
        text: '🛑 Task cancelled.',
      });
    } else {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: 'No active task to cancel.',
      });
    }
  }

  /**
   * Handle newtask command - start a fresh task session
   */
  private async handleNewTaskCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);

    if (session?.taskId) {
      // Unlink current task from session
      this.sessionManager.unlinkSessionFromTask(sessionId);
      this.pendingTaskResponses.delete(session.taskId);
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text: '🆕 Ready for a new task!\n\nSend me a message describing what you want to do.',
    });
  }

  /**
   * Get help text
   */
  private getHelpText(): string {
    return `📚 *Available Commands*

/start - Start the bot
/help - Show this help message
/status - Check bot status and current workspace
/workspaces - List available workspaces
/workspace <name> - Select a workspace
/addworkspace <path> - Add a new workspace
/newtask - Start a fresh task/conversation
/provider - Show or change AI provider
/model - Show or change model
/shell - Enable/disable shell command execution
/cancel - Cancel current task
/approve - Approve pending action (or /yes, /y)
/deny - Reject pending action (or /no, /n)

💬 *How to use*
1. Add or select a workspace:
   • \`/workspaces\` to see existing workspaces
   • \`/workspace <name>\` to select one
   • \`/addworkspace ~/path/to/folder\` to add new
2. Enable shell commands if needed: \`/shell on\`
3. Send me a message describing what you want to do
4. Continue the conversation with follow-up messages
5. Use \`/newtask\` when you want to start something new
6. Use \`/models\` to see AI models, \`/model <name>\` to switch

Examples:
• "What files are in this project?"
• "Create a new React component called Button"
• "Run npm install to install dependencies"`;
  }

  /**
   * Emit an event to all handlers
   */
  private emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Error in event handler:', error);
      }
    }
  }
}
