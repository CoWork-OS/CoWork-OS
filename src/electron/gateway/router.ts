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
} from '../database/repositories';
import Database from 'better-sqlite3';
import { AgentDaemon } from '../agent/daemon';
import { Task, IPC_CHANNELS } from '../../shared/types';

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

  // Track pending responses for tasks
  private pendingTaskResponses: Map<string, { adapter: ChannelAdapter; chatId: string; sessionId: string }> = new Map();

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
    // If pairing is required, check if the message IS a pairing code
    if (securityResult.pairingRequired) {
      const text = message.text.trim();
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
      console.log('No pending response for task:', taskId);
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

      // Don't unlink session - keep it linked for follow-up messages
      // User can use /newtask to explicitly start a new task
    } catch (error) {
      console.error('Error sending task completion:', error);
    } finally {
      this.pendingTaskResponses.delete(taskId);
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
/cancel - Cancel current task

💬 *How to use*
1. Add or select a workspace:
   • \`/workspaces\` to see existing workspaces
   • \`/workspace <name>\` to select one
   • \`/addworkspace ~/path/to/folder\` to add new
2. Send me a message describing what you want to do
3. Continue the conversation with follow-up messages
4. Use \`/newtask\` when you want to start something new

Examples:
• "What files are in this project?"
• "Create a new React component called Button"
• "Find all TODO comments in the code"`;
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
