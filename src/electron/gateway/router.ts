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
  CallbackQuery,
  InlineKeyboardButton,
} from './channels/types';
import { TelegramAdapter } from './channels/telegram';
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
import { Task, IPC_CHANNELS, TEMP_WORKSPACE_ID, TEMP_WORKSPACE_NAME, Workspace } from '../../shared/types';
import * as os from 'os';
import { LLMProviderFactory, LLMSettings } from '../agent/llm/provider-factory';
import { LLMProviderType } from '../agent/llm/types';
import { getCustomSkillLoader } from '../agent/custom-skill-loader';
import { app } from 'electron';
import { getVoiceService } from '../voice/VoiceService';
import { PersonalityManager } from '../settings/personality-manager';
import {
  getChannelMessage,
  getCompletionMessage,
  getChannelUiCopy,
  DEFAULT_CHANNEL_CONTEXT,
  type ChannelMessageContext,
} from '../../shared/channelMessages';
import { DEFAULT_QUIRKS } from '../../shared/types';

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
  private db: Database.Database;

  // Repositories
  private channelRepo: ChannelRepository;
  private userRepo: ChannelUserRepository;
  private sessionRepo: ChannelSessionRepository;
  private messageRepo: ChannelMessageRepository;
  private workspaceRepo: WorkspaceRepository;
  private taskRepo: TaskRepository;
  private artifactRepo: ArtifactRepository;

  // Track pending responses for tasks
  private pendingTaskResponses: Map<string, {
    adapter: ChannelAdapter;
    chatId: string;
    sessionId: string;
    originalMessageId?: string; // For reaction updates
    requestingUserId?: string;
    requestingUserName?: string;
    lastChannelMessageId?: string;
  }> = new Map();

  // Track pending approval requests for Discord/Telegram
  private pendingApprovals: Map<string, {
    taskId: string;
    approval: any;
    sessionId: string;
    chatId: string;
    channelType: ChannelType;
    requestingUserId?: string;
    requestingUserName?: string;
    contextType?: 'dm' | 'group';
  }> = new Map();

  // Track inline-keyboard messages that change state (workspace/provider/model selection).
  // Prevents group hijack and accidental presses on stale keyboards (after restarts).
  private pendingInlineActionGuards: Map<string, {
    action: 'workspace' | 'provider' | 'model';
    channelType: ChannelType;
    chatId: string;
    messageId: string;
    requestingUserId: string;
    requestingUserName?: string;
    expiresAt: number;
  }> = new Map();

  private streamingUpdateBuffers: Map<string, {
    latestText: string;
    timeoutHandle: ReturnType<typeof setTimeout> | null;
    lastSentAt: number;
  }> = new Map();

  private static readonly STREAMING_UPDATE_DEBOUNCE_MS = 1200;
  private static readonly INLINE_ACTION_GUARD_TTL_MS = 10 * 60 * 1000;

  constructor(db: Database.Database, config: RouterConfig = {}, agentDaemon?: AgentDaemon) {
    this.db = db;
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
   * Get the main window for sending IPC events
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
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
          persona: settings.activePersona,
          emojiUsage: settings.responseStyle?.emojiUsage || 'minimal',
          quirks: settings.quirks || DEFAULT_QUIRKS,
        };
      }
    } catch (error) {
      console.error('[MessageRouter] Failed to load personality settings:', error);
    }
    return DEFAULT_CHANNEL_CONTEXT;
  }

  private normalizeSimpleChannelMessage(text: string, context: ChannelMessageContext): string {
    if (!text) return text;

    let normalized = text;
    const signOff = context.quirks?.signOff?.trim();

    if (signOff) {
      const escaped = signOff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const signOffRegex = new RegExp(`(?:\\s|\\n)*${escaped}\\s*$`, 'i');
      const withoutSignOff = normalized.replace(signOffRegex, '').trimEnd();
      if (withoutSignOff.length > 0) {
        normalized = withoutSignOff;
      }
    }

    normalized = normalized.replace(/[ \t]+$/g, '');
    if (normalized.endsWith(':')) {
      normalized = normalized.slice(0, -1).trimEnd();
    }

    return normalized;
  }

  private getUiCopy(
    key: Parameters<typeof getChannelUiCopy>[0],
    replacements?: Record<string, string | number>
  ): string {
    return getChannelUiCopy(key, this.getMessageContext(), replacements);
  }

  /**
   * Get or create the temp workspace for sessions without a workspace
   */
  private getOrCreateTempWorkspace(): Workspace {
    // Check if temp workspace exists
    const existing = this.workspaceRepo.findById(TEMP_WORKSPACE_ID);
    if (existing) {
      const updatedPermissions = {
        ...existing.permissions,
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: existing.permissions.shell ?? false,
        unrestrictedFileAccess: true,
      };

      if (!existing.permissions.unrestrictedFileAccess) {
        this.workspaceRepo.updatePermissions(existing.id, updatedPermissions);
      }

      // Verify directory exists
      if (fs.existsSync(existing.path)) {
        return { ...existing, permissions: updatedPermissions, isTemp: true };
      }
      // Directory was deleted, recreate it
      const tempDir = path.join(os.tmpdir(), 'cowork-os-temp');
      fs.mkdirSync(tempDir, { recursive: true });
      return { ...existing, permissions: updatedPermissions, isTemp: true };
    }

    // Create temp directory
    const tempDir = path.join(os.tmpdir(), 'cowork-os-temp');
    fs.mkdirSync(tempDir, { recursive: true });

    // Create workspace record
    const tempWorkspace: Workspace = {
      id: TEMP_WORKSPACE_ID,
      name: TEMP_WORKSPACE_NAME,
      path: tempDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
        unrestrictedFileAccess: true,
      },
      isTemp: true,
    };

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO workspaces (id, name, path, created_at, permissions)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      tempWorkspace.id,
      tempWorkspace.name,
      tempWorkspace.path,
      tempWorkspace.createdAt,
      JSON.stringify(tempWorkspace.permissions)
    );

    return tempWorkspace;
  }

  /**
   * Register a channel adapter
   */
  registerAdapter(adapter: ChannelAdapter): void {
    // Set up message handler
    adapter.onMessage(async (message) => {
      await this.handleMessage(adapter, message);
    });

    // Set up callback query handler for inline keyboards
    if (adapter.onCallbackQuery) {
      adapter.onCallbackQuery(async (query) => {
        await this.handleCallbackQuery(adapter, query);
      });
    }

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

      if (status === 'connected') {
        void this.restorePendingTaskRoutes(adapter).catch((restoreError) => {
          console.error(`[Router] Failed to restore pending task routes for ${adapter.type}:`, restoreError);
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
      if (!adapter) continue;

      if (adapter.status !== 'connected') {
        try {
          await adapter.connect();
        } catch (error) {
          console.error(`Failed to connect ${channel.type}:`, error);
          continue;
        }
      }

      if (adapter.status === 'connected') {
        try {
          await this.restorePendingTaskRoutes(adapter);
        } catch (error) {
          console.error(`[Router] Failed to restore pending tasks for ${adapter.type}:`, error);
        }
      }
    }
  }

  private async restorePendingTaskRoutes(adapter: ChannelAdapter): Promise<void> {
    const channel = this.channelRepo.findByType(adapter.type);
    if (!channel) return;

    const sessions = this.sessionRepo.findActiveByChannelId(channel.id);
    if (sessions.length === 0) return;

    for (const session of sessions) {
      if (!session.taskId) continue;
      if (this.pendingTaskResponses.has(session.taskId)) continue;

      const task = this.taskRepo.findById(session.taskId);
      if (!task) continue;
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        continue;
      }

      const context = session.context as any;
      const requestingUserId =
        typeof context?.taskRequesterUserId === 'string'
          ? context.taskRequesterUserId
          : (typeof context?.lastChannelUserId === 'string' ? context.lastChannelUserId : undefined);
      const requestingUserName =
        typeof context?.taskRequesterUserName === 'string'
          ? context.taskRequesterUserName
          : (typeof context?.lastChannelUserName === 'string' ? context.lastChannelUserName : undefined);
      const lastChannelMessageId = typeof context?.lastChannelMessageId === 'string' ? context.lastChannelMessageId : undefined;

      this.pendingTaskResponses.set(session.taskId, {
        adapter,
        chatId: session.chatId,
        sessionId: session.id,
        requestingUserId,
        requestingUserName,
        lastChannelMessageId,
      });

      // Ensure draft-streaming state is available even after restarts.
      if (adapter instanceof TelegramAdapter) {
        await adapter.startDraftStream(session.chatId);
      }
    }
  }

  private makeInlineActionGuardKey(channelType: ChannelType, chatId: string, messageId: string): string {
    return `${channelType}:${chatId}:${messageId}`;
  }

  private registerInlineActionGuard(params: {
    action: 'workspace' | 'provider' | 'model';
    channelType: ChannelType;
    chatId: string;
    messageId: string;
    requestingUserId: string;
    requestingUserName?: string;
  }): void {
    const expiresAt = Date.now() + MessageRouter.INLINE_ACTION_GUARD_TTL_MS;
    const key = this.makeInlineActionGuardKey(params.channelType, params.chatId, params.messageId);
    const entry = {
      ...params,
      expiresAt,
    };
    this.pendingInlineActionGuards.set(key, entry);

    // Best-effort cleanup.
    setTimeout(() => {
      const existing = this.pendingInlineActionGuards.get(key);
      if (existing && existing.expiresAt === expiresAt) {
        this.pendingInlineActionGuards.delete(key);
      }
    }, MessageRouter.INLINE_ACTION_GUARD_TTL_MS + 500);
  }

  private resolveTaskRequesterFromSessionContext(session: { context?: unknown }): {
    requestingUserId?: string;
    requestingUserName?: string;
    lastChannelMessageId?: string;
  } {
    const ctx = session?.context as any;
    const requestingUserId =
      typeof ctx?.taskRequesterUserId === 'string'
        ? ctx.taskRequesterUserId
        : (typeof ctx?.lastChannelUserId === 'string' ? ctx.lastChannelUserId : undefined);
    const requestingUserName =
      typeof ctx?.taskRequesterUserName === 'string'
        ? ctx.taskRequesterUserName
        : (typeof ctx?.lastChannelUserName === 'string' ? ctx.lastChannelUserName : undefined);
    const lastChannelMessageId = typeof ctx?.lastChannelMessageId === 'string' ? ctx.lastChannelMessageId : undefined;
    return { requestingUserId, requestingUserName, lastChannelMessageId };
  }

  /**
   * Resolve which channel/chat/session should receive messages for a given task.
   * Primary use: approvals for child tasks (sub-agents) should route back to the
   * originating chat session (usually the root task).
   */
  private resolveRouteForTask(taskId: string): {
    adapter: ChannelAdapter;
    chatId: string;
    sessionId: string;
    requestingUserId?: string;
    requestingUserName?: string;
    lastChannelMessageId?: string;
    routedTaskId: string;
  } | undefined {
    const direct = this.pendingTaskResponses.get(taskId);
    if (direct) {
      return { ...direct, routedTaskId: taskId };
    }

    let currentTaskId: string | undefined = taskId;
    for (let depth = 0; depth < 12 && currentTaskId; depth++) {
      const pending = this.pendingTaskResponses.get(currentTaskId);
      if (pending) {
        return { ...pending, routedTaskId: currentTaskId };
      }

      const session = this.sessionRepo.findByTaskId(currentTaskId);
      if (session) {
        const channel = this.channelRepo.findById(session.channelId);
        if (!channel) return undefined;
        const adapter = this.adapters.get(channel.type as ChannelType);
        if (!adapter) return undefined;

        const { requestingUserId, requestingUserName, lastChannelMessageId } =
          this.resolveTaskRequesterFromSessionContext(session);

        return {
          adapter,
          chatId: session.chatId,
          sessionId: session.id,
          requestingUserId,
          requestingUserName,
          lastChannelMessageId,
          routedTaskId: currentTaskId,
        };
      }

      const task = this.taskRepo.findById(currentTaskId);
      currentTaskId = task?.parentTaskId;
    }

    return undefined;
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
   * Transcribe audio attachments in a message
   * Downloads audio from URL or uses buffer, transcribes via VoiceService
   * Saves audio file to a temp folder for transcription and sets message text to include full transcript with context
   */
  private async transcribeAudioAttachments(message: IncomingMessage, workspacePath?: string): Promise<void> {
    if (!message.attachments || message.attachments.length === 0) {
      return;
    }

    const audioAttachments = message.attachments.filter(a => a.type === 'audio');
    if (audioAttachments.length === 0) {
      return;
    }

    const voiceService = getVoiceService();

    // Check if transcription is available
    if (!voiceService.isTranscriptionAvailable()) {
      console.log('[Router] Audio transcription not available - no STT provider configured');
      // Add placeholder for audio messages
      for (const attachment of audioAttachments) {
        const fileName = attachment.fileName || 'voice message';
        message.text += message.text ? `\n[Audio: ${fileName} - transcription unavailable]` : `[Audio: ${fileName} - transcription unavailable]`;
      }
      return;
    }

    console.log(`[Router] Transcribing ${audioAttachments.length} audio attachment(s)...`);

    for (const attachment of audioAttachments) {
      let savedAudioPath: string | undefined;
      try {
        let audioBuffer: Buffer | undefined;

        // Get audio data from buffer or file
        if (attachment.data) {
          audioBuffer = attachment.data;
        } else if (attachment.url) {
          // Check if it's a local file path
          if (attachment.url.startsWith('/') || attachment.url.startsWith('file://')) {
            const filePath = attachment.url.replace('file://', '');
            if (fs.existsSync(filePath)) {
              audioBuffer = fs.readFileSync(filePath);
            }
          } else if (attachment.url.startsWith('http')) {
            // Download from URL
            try {
              const response = await fetch(attachment.url);
              if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                audioBuffer = Buffer.from(arrayBuffer);
              }
            } catch (fetchError) {
              console.error('[Router] Failed to download audio:', fetchError);
            }
          }
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          console.log('[Router] No audio data available for transcription');
          const fileName = attachment.fileName || 'voice message';
          message.text += message.text ? `\n[Audio: ${fileName} - could not load]` : `[Audio: ${fileName} - could not load]`;
          continue;
        }

        // Save audio file to temp directory for transcription
        try {
          const tempDir = path.join(os.tmpdir(), 'cowork-audio');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          const audioFileName = attachment.fileName || `voice_message_${Date.now()}.ogg`;
          savedAudioPath = path.join(tempDir, audioFileName);
          fs.writeFileSync(savedAudioPath, audioBuffer);
          console.log(`[Router] Saved audio file to: ${savedAudioPath}`);
        } catch (saveError) {
          console.error('[Router] Failed to save audio file:', saveError);
        }

        // Transcribe the audio
        const transcript = await voiceService.transcribe(audioBuffer, { force: true });

        if (transcript && transcript.trim()) {
          console.log(`[Router] Transcribed audio: "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"`);

          // Create a structured message with the full transcript
          // This ensures the agent knows it's a voice message and has the complete transcript
          const voiceMessageContext = [
            '📢 **Voice Message Received**',
            '',
            'The user sent a voice message. Here is the complete transcription:',
            '',
            '---',
            transcript,
            '---',
            '',
            'Please respond to the user\'s voice message above.',
          ].filter(line => line !== undefined).join('\n');

          // Append or set the transcribed text with context
          if (message.text && message.text.trim()) {
            message.text += `\n\n${voiceMessageContext}`;
          } else {
            message.text = voiceMessageContext;
          }
        } else {
          const fileName = attachment.fileName || 'voice message';
          message.text += message.text ? `\n[Audio: ${fileName} - no speech detected]` : `[Audio: ${fileName} - no speech detected]`;
        }
      } catch (error) {
        console.error('[Router] Failed to transcribe audio:', error);
        const fileName = attachment.fileName || 'voice message';
        message.text += message.text ? `\n[Audio: ${fileName} - transcription failed]` : `[Audio: ${fileName} - transcription failed]`;
      } finally {
        if (savedAudioPath && fs.existsSync(savedAudioPath)) {
          try {
            fs.unlinkSync(savedAudioPath);
          } catch (cleanupError) {
            console.error('[Router] Failed to delete temp audio file:', cleanupError);
          }
        }
      }
    }
  }

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

    // Transcribe any audio attachments before processing
    await this.transcribeAudioAttachments(message);

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
    const securityResult = await this.securityManager.checkAccess(channel, message, message.isGroup);

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

    // Track last sender for this chat (useful for restoring after restarts).
    // Note: sessions are keyed by chatId (group chats share a session).
    this.sessionManager.updateSessionContext(session.id, {
      lastChannelUserId: message.userId,
      lastChannelUserName: message.userName,
      lastChannelMessageId: message.messageId,
    });

    // Handle the message based on content
    await this.routeMessage(adapter, message, session.id, securityResult);
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
      responseText = this.getUiCopy('pairingRequired');
    } else {
      responseText = this.getUiCopy('unauthorized');
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
    sessionId: string,
    securityContext?: { contextType?: 'dm' | 'group'; deniedTools?: string[] }
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

    const session = this.sessionRepo.findById(sessionId);
    const ctx = session?.context as any;
    const pendingSelection = ctx?.pendingSelection as any;
    const PENDING_SELECTION_TTL_MS = 2 * 60 * 1000;

    if (pendingSelection && typeof pendingSelection === 'object' && typeof pendingSelection.type === 'string') {
      const createdAt = typeof pendingSelection.createdAt === 'number' ? pendingSelection.createdAt : 0;
      const ageMs = Date.now() - createdAt;

      if (ageMs > PENDING_SELECTION_TTL_MS) {
        // Expired - clear and proceed normally.
        this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
      } else {
        // Only treat as a selection if the user reply looks like a selection (not a full task).
        const looksLikeSelection = /^[0-9]+$/.test(text) || (!/\s/.test(text) && text.length <= 48);
        if (!looksLikeSelection) {
          // User likely sent a real task; clear pending selection and continue.
          this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
        } else if (pendingSelection.type === 'workspace') {
          const workspaces = this.workspaceRepo.findAll();
          const isNumeric = /^[0-9]+$/.test(text);
          const num = parseInt(text, 10);
          let workspace: Workspace | undefined;
          if (isNumeric) {
            if (!isNaN(num) && num > 0 && num <= workspaces.length) {
              workspace = workspaces[num - 1];
            } else {
              // Likely attempted a selection but it's out of range: keep selection mode.
              await adapter.sendMessage({
                chatId: message.chatId,
                text: this.getUiCopy('workspaceNotFound', { selector: text }),
              });
              return;
            }
          } else {
            const lowered = text.toLowerCase();
            workspace = workspaces.find(
              ws => ws.name.toLowerCase() === lowered || ws.name.toLowerCase().startsWith(lowered)
            );
          }

          if (workspace) {
            this.sessionManager.setSessionWorkspace(sessionId, workspace.id);
            if (workspace.id !== TEMP_WORKSPACE_ID) {
              try {
                this.workspaceRepo.updateLastUsedAt(workspace.id);
              } catch (error) {
                console.warn('Failed to update workspace last used time:', error);
              }
            }
            this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
            const selectedText = this.getUiCopy('workspaceSelected', { workspaceName: workspace.name });
            const exampleText = this.getUiCopy('workspaceSelectedExample');
            await adapter.sendMessage({
              chatId: message.chatId,
              text: `${selectedText}\n\n${exampleText}`,
              parseMode: 'markdown',
            });
            return;
          }

          // Not a valid selection; treat the next message as a normal task prompt.
          this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
        } else if (pendingSelection.type === 'provider') {
          const selector = text.toLowerCase();
          const providerMap: Record<string, LLMProviderType> = {
            '1': 'anthropic',
            'anthropic': 'anthropic',
            'api': 'anthropic',
            '2': 'openai',
            'openai': 'openai',
            'chatgpt': 'openai',
            '3': 'azure',
            'azure': 'azure',
            'azure-openai': 'azure',
            '4': 'gemini',
            'gemini': 'gemini',
            'google': 'gemini',
            '5': 'openrouter',
            'openrouter': 'openrouter',
            'or': 'openrouter',
            '6': 'bedrock',
            'bedrock': 'bedrock',
            'aws': 'bedrock',
            '7': 'ollama',
            'ollama': 'ollama',
            'local': 'ollama',
          };

          if (!providerMap[selector]) {
            // If it's a numeric reply, user likely intended selection.
            if (/^[0-9]+$/.test(text)) {
              await adapter.sendMessage({
                chatId: message.chatId,
                text: `❌ Unknown provider: "${text}". Reply with \`1\`- \`7\` or a name like \`openai\`, \`bedrock\`, \`ollama\`.\n\nTip: use /providers to list options again.`,
                parseMode: 'markdown',
              });
              return;
            }

            // Otherwise, treat as normal task prompt.
            this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
          } else {
            this.sessionManager.updateSessionContext(sessionId, { pendingSelection: undefined });
            await this.handleProviderCommand(adapter, message, [text]);
            return;
          }

          // fallthrough: proceed normally
        }
      }
    }

    // Check if session has no workspace - might be workspace selection
    if (!session?.workspaceId) {
      // Check if this looks like workspace selection (number or short name)
      const workspaces = this.workspaceRepo.findAll();
      if (workspaces.length > 0) {
        // Try to match by number
        const num = parseInt(text, 10);
        if (!isNaN(num) && num > 0 && num <= workspaces.length) {
          const workspace = workspaces[num - 1];
          this.sessionManager.setSessionWorkspace(sessionId, workspace.id);
          if (workspace.id !== TEMP_WORKSPACE_ID) {
            try {
              this.workspaceRepo.updateLastUsedAt(workspace.id);
            } catch (error) {
              console.warn('Failed to update workspace last used time:', error);
            }
          }
          const selectedText = this.getUiCopy('workspaceSelected', { workspaceName: workspace.name });
          const exampleText = this.getUiCopy('workspaceSelectedExample');
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `${selectedText}\n\n${exampleText}`,
            parseMode: 'markdown',
          });
          return;
        }

        // Try to match by name (case-insensitive partial match)
        const matchedWorkspace = workspaces.find(
          ws => ws.name.toLowerCase() === text.toLowerCase() ||
                ws.name.toLowerCase().startsWith(text.toLowerCase())
        );
        if (matchedWorkspace) {
          this.sessionManager.setSessionWorkspace(sessionId, matchedWorkspace.id);
          if (matchedWorkspace.id !== TEMP_WORKSPACE_ID) {
            try {
              this.workspaceRepo.updateLastUsedAt(matchedWorkspace.id);
            } catch (error) {
              console.warn('Failed to update workspace last used time:', error);
            }
          }
          const selectedText = this.getUiCopy('workspaceSelected', { workspaceName: matchedWorkspace.name });
          const exampleText = this.getUiCopy('workspaceSelectedExample');
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `${selectedText}\n\n${exampleText}`,
            parseMode: 'markdown',
          });
          return;
        }
      }

      // No workspace match found - auto-assign temp workspace so tasks can proceed
      const tempWorkspace = this.getOrCreateTempWorkspace();
      this.sessionManager.setSessionWorkspace(sessionId, tempWorkspace.id);
    }

    // Regular message - send to desktop app for task processing
    await this.forwardToDesktopApp(adapter, message, sessionId, securityContext);
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
        await this.handleStartCommand(adapter, message, sessionId);
        break;

      case '/help':
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getHelpText(adapter.type),
          parseMode: 'markdown',
        });
        break;

      case '/status':
        await this.handleStatusCommand(adapter, message, sessionId);
        break;

      case '/workspaces':
        await this.handleWorkspacesCommand(adapter, message, sessionId);
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
            text: this.getUiCopy('pairingPrompt'),
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
        await this.handleApproveCommand(adapter, message, sessionId, args);
        break;

      case '/deny':
      case '/no':
      case '/n':
        await this.handleDenyCommand(adapter, message, sessionId, args);
        break;

      case '/queue':
        await this.handleQueueCommand(adapter, message, args);
        break;

      case '/removeworkspace':
        await this.handleRemoveWorkspaceCommand(adapter, message, sessionId, args);
        break;

      case '/retry':
        await this.handleRetryCommand(adapter, message, sessionId);
        break;

      case '/history':
        await this.handleHistoryCommand(adapter, message, sessionId);
        break;

      case '/skills':
        await this.handleSkillsCommand(adapter, message, sessionId);
        break;

      case '/skill':
        await this.handleSkillCommand(adapter, message, sessionId, args);
        break;

      case '/providers':
        await this.handleProvidersCommand(adapter, message, sessionId);
        break;

      case '/settings':
        await this.handleSettingsCommand(adapter, message, sessionId);
        break;

      case '/debug':
        await this.handleDebugCommand(adapter, message, sessionId);
        break;

      case '/version':
        await this.handleVersionCommand(adapter, message);
        break;

      default:
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('unknownCommand', { command }),
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
    let statusText = `✅ ${this.getUiCopy('statusHeader')}\n\n`;

    if (session?.workspaceId) {
      const workspace = this.workspaceRepo.findById(session.workspaceId);
      if (workspace) {
        statusText += this.getUiCopy('workspaceCurrent', {
          workspaceName: workspace.name,
          workspacePath: workspace.path,
        });
        statusText += '\n';
      }
    } else {
      statusText += this.getUiCopy('statusNoWorkspace');
    }

    if (session?.taskId) {
      const task = this.taskRepo.findById(session.taskId);
      if (task) {
        statusText += `\n${this.getUiCopy('statusActiveTask', { taskTitle: task.title, status: task.status })}`;
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
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const workspaces = this.workspaceRepo.findAll();

    if (workspaces.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspacesNone'),
        parseMode: 'markdown',
      });
      return;
    }

    // WhatsApp and iMessage don't support inline keyboards - use text-based selection
    if (adapter.type === 'whatsapp' || adapter.type === 'imessage') {
      let text = `${this.getUiCopy('workspacesHeader')}\n\n`;
      workspaces.forEach((ws, index) => {
        text += `${index + 1}. *${ws.name}*\n   \`${ws.path}\`\n\n`;
      });
      text += '━━━━━━━━━━━━━━━\n';
      text += this.getUiCopy('workspacesFooter');

      await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
      });

      // Allow a plain numeric reply (e.g., "1") to select a workspace even when
      // one is already set (important for WhatsApp/iMessage UX).
      this.sessionManager.updateSessionContext(sessionId, {
        pendingSelection: { type: 'workspace', createdAt: Date.now() },
      });
      return;
    }

    // Build inline keyboard with workspace buttons for Telegram/Discord
    const keyboard: InlineKeyboardButton[][] = [];
    for (const ws of workspaces) {
      // Create one button per row for better readability
      keyboard.push([{
        text: `📁 ${ws.name}`,
        callbackData: `workspace:${ws.id}`,
      }]);
    }

    let text = `${this.getUiCopy('workspacesHeader')}\n\n${this.getUiCopy('workspacesSelectPrompt')}`;

    const messageId = await adapter.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: 'markdown',
      inlineKeyboard: keyboard,
      threadId: message.threadId,
    });
    if (messageId) {
      this.registerInlineActionGuard({
        action: 'workspace',
        channelType: adapter.type,
        chatId: message.chatId,
        messageId,
        requestingUserId: message.userId,
        requestingUserName: message.userName,
      });
    }
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
      let session = this.sessionRepo.findById(sessionId);

      // Auto-assign temp workspace if none selected
      if (!session?.workspaceId) {
        const tempWorkspace = this.getOrCreateTempWorkspace();
        this.sessionRepo.update(sessionId, { workspaceId: tempWorkspace.id });
        session = this.sessionRepo.findById(sessionId);
      }

      if (session?.workspaceId) {
        const workspace = this.workspaceRepo.findById(session.workspaceId);
        if (workspace) {
          const isTempWorkspace = workspace.id === TEMP_WORKSPACE_ID;
          const displayName = isTempWorkspace ? 'Temporary Workspace (work in a folder for persistence)' : workspace.name;
          await adapter.sendMessage({
            chatId: message.chatId,
            text: this.getUiCopy('workspaceCurrent', {
              workspaceName: displayName,
              workspacePath: workspace.path,
            }),
            parseMode: 'markdown',
          });
          return;
        }
      }
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspaceNoneSelected'),
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
        text: this.getUiCopy('workspaceNotFound', { selector }),
      });
      return;
    }

    // Update session workspace
    this.sessionManager.setSessionWorkspace(sessionId, workspace.id);
    if (workspace.id !== TEMP_WORKSPACE_ID) {
      try {
        this.workspaceRepo.updateLastUsedAt(workspace.id);
      } catch (error) {
        console.warn('Failed to update workspace last used time:', error);
      }
    }

    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('workspaceSet', {
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      }),
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
        text: this.getUiCopy('workspaceAddUsage'),
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
          text: this.getUiCopy('workspacePathNotDir', { workspacePath }),
          parseMode: 'markdown',
        });
        return;
      }
    } catch {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspacePathNotFound', { workspacePath }),
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
        text: this.getUiCopy('workspaceAlreadyExists', {
          workspaceName: existing.name,
          workspacePath: existing.path,
        }),
        parseMode: 'markdown',
      });
      return;
    }

    // Create workspace name from path
    const workspaceName = path.basename(workspacePath);

    // Create new workspace with default permissions
    // Note: network is enabled by default for browser tools (web access)
    const workspace = this.workspaceRepo.create(
      workspaceName,
      workspacePath,
      {
        read: true,
        write: true,
        delete: false, // Requires approval
        network: true,
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
      text: this.getUiCopy('workspaceAdded', {
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      }),
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
    const providerType = status.currentProvider;

    let text = '🤖 *AI Models & Providers*\n\n';

    // Get provider-specific models and current model
    let models: Array<{ key: string; displayName: string }> = [];
    let currentModel = status.currentModel;

    // Provider display names
    const providerModelNames: Record<string, string> = {
      'anthropic': 'Claude',
      'bedrock': 'Claude',
      'openai': 'OpenAI',
      'azure': 'Azure OpenAI',
      'gemini': 'Gemini',
      'openrouter': 'OpenRouter',
      'ollama': 'Ollama',
    };

    // Get models based on current provider
    switch (providerType) {
      case 'anthropic':
      case 'bedrock':
        models = status.models;
        break;

      case 'openai': {
        currentModel = settings.openai?.model || 'gpt-4o-mini';
        const cachedOpenAI = LLMProviderFactory.getCachedModels('openai');
        if (cachedOpenAI && cachedOpenAI.length > 0) {
          models = cachedOpenAI;
        } else {
          // Default OpenAI models
          models = [
            { key: 'gpt-4o', displayName: 'GPT-4o' },
            { key: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
            { key: 'gpt-4-turbo', displayName: 'GPT-4 Turbo' },
            { key: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo' },
            { key: 'o1', displayName: 'o1' },
            { key: 'o1-mini', displayName: 'o1 Mini' },
          ];
        }
        break;
      }

      case 'azure': {
        const deployments = (settings.azure?.deployments || []).filter(Boolean);
        currentModel = settings.azure?.deployment || deployments[0] || 'deployment-name';
        models = deployments.map((deployment) => ({
          key: deployment,
          displayName: deployment,
        }));
        if (currentModel && !models.some(m => m.key === currentModel)) {
          models.unshift({ key: currentModel, displayName: currentModel });
        }
        break;
      }

      case 'gemini': {
        currentModel = settings.gemini?.model || 'gemini-2.0-flash';
        const cachedGemini = LLMProviderFactory.getCachedModels('gemini');
        if (cachedGemini && cachedGemini.length > 0) {
          models = cachedGemini;
        } else {
          models = [
            { key: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            { key: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
            { key: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
          ];
        }
        break;
      }

      case 'openrouter': {
        currentModel = settings.openrouter?.model || 'anthropic/claude-3.5-sonnet';
        const cachedOpenRouter = LLMProviderFactory.getCachedModels('openrouter');
        if (cachedOpenRouter && cachedOpenRouter.length > 0) {
          models = cachedOpenRouter.slice(0, 10); // Limit to 10 for readability
        } else {
          models = [
            { key: 'anthropic/claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet' },
            { key: 'openai/gpt-4o', displayName: 'GPT-4o' },
            { key: 'google/gemini-pro', displayName: 'Gemini Pro' },
          ];
        }
        break;
      }

      case 'ollama': {
        // Ollama handled separately below
        break;
      }

      default:
        models = status.models;
    }

    if (providerType !== 'ollama' && currentModel && !models.some((model) => model.key === currentModel)) {
      models.unshift({
        key: currentModel,
        displayName: currentModel,
      });
    }

    // Current configuration
    text += '*Current:*\n';
    const currentProvider = status.providers.find(p => p.type === providerType);
    text += `• Provider: ${currentProvider?.name || providerType}\n`;

    if (providerType === 'ollama') {
      const ollamaModel = settings.ollama?.model || 'llama3.2';
      text += `• Model: ${ollamaModel}\n\n`;
    } else {
      const modelInfo = models.find(m => m.key === currentModel);
      text += `• Model: ${modelInfo?.displayName || currentModel}\n\n`;
    }

    // Available providers
    text += '*Available Providers:*\n';
    status.providers.forEach(provider => {
      const isActive = provider.type === providerType ? ' ✓' : '';
      const configStatus = provider.configured ? '🟢' : '⚪';
      text += `${configStatus} ${provider.name}${isActive}\n`;
    });
    text += '\n';

    // Available models - show different list based on provider
    if (providerType === 'ollama') {
      text += '*Available Ollama Models:*\n';
      try {
        const ollamaModels = await LLMProviderFactory.getOllamaModels();
        const currentOllamaModel = settings.ollama?.model || 'llama3.2';

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
      text += '\n💡 Use `/model <name>` to switch (e.g., `/model llama3.2`)';
    } else {
      const modelBrand = providerModelNames[providerType] || 'Available';
      text += `*Available ${modelBrand} Models:*\n`;
      models.forEach((model, index) => {
        const isActive = model.key === currentModel ? ' ✓' : '';
        text += `${index + 1}. ${model.displayName}${isActive}\n`;
      });
      text += '\n💡 Use `/model <name>` to switch\n';
      text += 'Example: `/model 2` or `/model <model-name>`';
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
    const providerType = status.currentProvider;
    const currentProviderInfo = status.providers.find(p => p.type === providerType);

    // Get provider-specific models and current model
    let models: Array<{ key: string; displayName: string }> = [];
    let currentModel = status.currentModel;

    // Get models based on current provider
    switch (providerType) {
      case 'anthropic':
      case 'bedrock':
        models = status.models;
        break;

      case 'openai': {
        currentModel = settings.openai?.model || 'gpt-4o-mini';
        const cachedOpenAI = LLMProviderFactory.getCachedModels('openai');
        if (cachedOpenAI && cachedOpenAI.length > 0) {
          models = cachedOpenAI;
        } else {
          models = [
            { key: 'gpt-4o', displayName: 'GPT-4o' },
            { key: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
            { key: 'gpt-4-turbo', displayName: 'GPT-4 Turbo' },
            { key: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo' },
            { key: 'o1', displayName: 'o1' },
            { key: 'o1-mini', displayName: 'o1 Mini' },
          ];
        }
        break;
      }

      case 'gemini': {
        currentModel = settings.gemini?.model || 'gemini-2.0-flash';
        const cachedGemini = LLMProviderFactory.getCachedModels('gemini');
        if (cachedGemini && cachedGemini.length > 0) {
          models = cachedGemini;
        } else {
          models = [
            { key: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            { key: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
            { key: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
          ];
        }
        break;
      }

      case 'openrouter': {
        currentModel = settings.openrouter?.model || 'anthropic/claude-3.5-sonnet';
        const cachedOpenRouter = LLMProviderFactory.getCachedModels('openrouter');
        if (cachedOpenRouter && cachedOpenRouter.length > 0) {
          models = cachedOpenRouter.slice(0, 10);
        } else {
          models = [
            { key: 'anthropic/claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet' },
            { key: 'openai/gpt-4o', displayName: 'GPT-4o' },
            { key: 'google/gemini-pro', displayName: 'Gemini Pro' },
          ];
        }
        break;
      }

      case 'ollama':
        // Handled separately
        break;

      default:
        models = status.models;
    }

    if (providerType !== 'ollama' && currentModel && !models.some((model) => model.key === currentModel)) {
      models.unshift({
        key: currentModel,
        displayName: currentModel,
      });
    }

    // If no args, show current model and available models
    if (args.length === 0) {
      let text = '🤖 *Current Model*\n\n';
      text += `• Provider: ${currentProviderInfo?.name || providerType}\n`;

      if (providerType === 'ollama') {
        const ollamaModel = settings.ollama?.model || 'llama3.2';
        text += `• Model: ${ollamaModel}\n\n`;

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
        const modelInfo = models.find(m => m.key === currentModel);
        text += `• Model: ${modelInfo?.displayName || currentModel}\n\n`;

        text += '*Available Models:*\n';
        models.forEach((model, index) => {
          const isActive = model.key === currentModel ? ' ✓' : '';
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

    if (providerType === 'ollama') {
      const result = await this.selectOllamaModel(selector, args);
      if (!result.success) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: result.error!,
          parseMode: 'markdown',
        });
        return;
      }

      const newSettings = LLMProviderFactory.applyModelSelection(settings, result.model!);

      LLMProviderFactory.saveSettings(newSettings);
      LLMProviderFactory.clearCache();

      await adapter.sendMessage({
        chatId: message.chatId,
        text: `✅ Model changed to: *${result.model}*`,
        parseMode: 'markdown',
      });
      return;
    }

    // For all other providers, use the provider-specific model list
    const result = this.selectClaudeModel(selector, models);
    if (!result.success) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: result.error!,
      });
      return;
    }

    const newSettings = LLMProviderFactory.applyModelSelection(settings, result.model!.key);

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
      text += '3. azure - Azure OpenAI\n';
      text += '4. gemini - Google Gemini\n';
      text += '5. openrouter - OpenRouter\n';
      text += '6. bedrock - AWS Bedrock\n';
      text += '7. ollama - Ollama (local)\n\n';

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
      '3': 'azure',
      'azure': 'azure',
      'azure-openai': 'azure',
      '4': 'gemini',
      'gemini': 'gemini',
      'google': 'gemini',
      '5': 'openrouter',
      'openrouter': 'openrouter',
      'or': 'openrouter',
      '6': 'bedrock',
      'bedrock': 'bedrock',
      'aws': 'bedrock',
      '7': 'ollama',
      'ollama': 'ollama',
      'local': 'ollama',
    };

    const targetProvider = providerMap[selector];
    if (!targetProvider) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `❌ Unknown provider: "${args[0]}"\n\n*Available providers:*\n1. anthropic\n2. openai\n3. azure\n4. gemini\n5. openrouter\n6. bedrock\n7. ollama\n\nUse \`/provider <name>\` or \`/provider <number>\``,
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
    const updatedStatus = LLMProviderFactory.getConfigStatus();
    const providerInfo = updatedStatus.providers.find(p => p.type === targetProvider);
    const model = updatedStatus.models.find((entry) => entry.key === updatedStatus.currentModel);
    const modelInfo = model?.displayName || updatedStatus.currentModel;

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
    let session = this.sessionRepo.findById(sessionId);

    // Auto-assign temp workspace if none selected
    if (!session?.workspaceId) {
      const tempWorkspace = this.getOrCreateTempWorkspace();
      this.sessionRepo.update(sessionId, { workspaceId: tempWorkspace.id });
      session = this.sessionRepo.findById(sessionId);
    }

    const workspace = this.workspaceRepo.findById(session!.workspaceId!);
    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspaceNotFoundForShell'),
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
        text: this.getUiCopy('shellInvalidOption'),
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
        text: this.getUiCopy('pairingSuccess'),
        replyTo: message.messageId,
      });

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('gateway:users-updated', {
          channelId: channel.id,
          channelType: adapter.type,
        });
      }

      this.emitEvent({
        type: 'user:paired',
        channel: adapter.type,
        timestamp: new Date(),
        data: { userId: message.userId, userName: message.userName },
      });
    } else {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('pairingFailed', {
          error: result.error || 'Invalid pairing code. Please try again.',
        }),
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
    sessionId: string,
    securityContext?: { contextType?: 'dm' | 'group'; deniedTools?: string[] }
  ): Promise<void> {
    let session = this.sessionRepo.findById(sessionId);

    // Auto-assign temp workspace if none selected
    if (!session?.workspaceId) {
      const tempWorkspace = this.getOrCreateTempWorkspace();
      this.sessionManager.setSessionWorkspace(sessionId, tempWorkspace.id);
      session = this.sessionRepo.findById(sessionId);
    }

    // Check if there's an existing task for this session (active or completed)
    if (session!.taskId) {
      const existingTask = this.taskRepo.findById(session!.taskId);
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
                ? '💬 Got it — adding that to the current task...'
                : '💬 Picking up where we left off...';
              await adapter.sendMessage({
                chatId: message.chatId,
                text: statusMsg,
                replyTo: message.messageId,
              });

              const requester = this.resolveTaskRequesterFromSessionContext(session!);
              const requestingUserId = requester.requestingUserId ?? message.userId;
              const requestingUserName = requester.requestingUserName ?? message.userName;

              // Re-register task for response tracking (may have been removed after initial completion)
              this.pendingTaskResponses.set(session!.taskId!, {
                adapter,
                chatId: message.chatId,
                sessionId,
                requestingUserId,
                requestingUserName,
                lastChannelMessageId: message.messageId,
              });

              await this.agentDaemon.sendMessage(session!.taskId!, message.text);
              } catch (error) {
                console.error('Error sending follow-up message:', error);
                await adapter.sendMessage({
                  chatId: message.chatId,
                  text: this.getUiCopy('taskContinueFailed'),
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
        text: this.getUiCopy('agentUnavailable'),
        replyTo: message.messageId,
      });
      return;
    }

    // Get workspace
    const workspace = this.workspaceRepo.findById(session!.workspaceId!);
    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspaceMissingForTask'),
        replyTo: message.messageId,
      });
      return;
    }

    // Create task
    const taskTitle = message.text.length > 50
      ? message.text.substring(0, 50) + '...'
      : message.text;

    // Prefer adapter-provided isGroup. If missing, fall back to a conservative heuristic.
    // Note: For some adapters chatId/userId can differ even in DMs, which would over-restrict tools.
    // Adapters should set isGroup explicitly when possible.
    const dmOnlyChannels: ChannelType[] = ['email', 'imessage', 'bluebubbles'];
    const inferredIsGroup = message.isGroup ?? (dmOnlyChannels.includes(adapter.type) ? false : message.chatId !== message.userId);

    const contextType = securityContext?.contextType ?? (inferredIsGroup ? 'group' : 'dm');
    const gatewayContext = contextType === 'group' ? 'group' : 'private';
    const toolRestrictions = securityContext?.deniedTools?.filter((t) => typeof t === 'string' && t.trim().length > 0);

    const task = this.taskRepo.create({
      workspaceId: workspace.id,
      title: taskTitle,
      prompt: message.text,
      status: 'pending',
      agentConfig: {
        gatewayContext,
        ...(toolRestrictions && toolRestrictions.length > 0 ? { toolRestrictions } : {}),
      },
    });

    // Link session to task
    this.sessionManager.linkSessionToTask(sessionId, task.id);
    this.sessionManager.updateSessionContext(sessionId, {
      taskRequesterUserId: message.userId,
      taskRequesterUserName: message.userName,
    });

    // Track this task for response handling
    this.pendingTaskResponses.set(task.id, {
      adapter,
      chatId: message.chatId,
      sessionId,
      originalMessageId: message.messageId, // Track for reaction updates
      requestingUserId: message.userId,
      requestingUserName: message.userName,
      lastChannelMessageId: message.messageId,
    });

    // Start draft streaming for real-time response preview (Telegram)
    if (adapter instanceof TelegramAdapter) {
      await adapter.startDraftStream(message.chatId);
    }

    // Send acknowledgment - concise for WhatsApp and iMessage
    const ackMessage = (adapter.type === 'whatsapp' || adapter.type === 'imessage')
      ? this.getUiCopy('taskStartAckSimple')
      : this.getUiCopy('taskStartAck', { taskTitle });
    await adapter.sendMessage({
      chatId: message.chatId,
      text: ackMessage,
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
        text: this.getUiCopy('taskStartFailed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      });

      // Cleanup
      this.pendingTaskResponses.delete(task.id);
      this.sessionManager.unlinkSessionFromTask(sessionId);
    }
  }

  /**
   * Send task update to channel
   * Uses draft streaming for Telegram to show real-time progress
   */
  async sendTaskUpdate(taskId: string, text: string, isStreaming = false): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) {
      // This is expected for tasks started from the UI (not via Telegram)
      return;
    }

    try {
      const sendNow = async (pendingEntry: typeof pending, rawText: string): Promise<void> => {
        const msgCtx = this.getMessageContext();
        const normalizedText = pendingEntry.adapter.type === 'whatsapp'
          ? this.normalizeSimpleChannelMessage(rawText, msgCtx)
          : rawText;

        // Split long updates for simple messaging channels to avoid silent drops.
        if (pendingEntry.adapter.type === 'whatsapp' || pendingEntry.adapter.type === 'imessage') {
          const chunks = this.splitMessage(normalizedText, 4000);
          for (const chunk of chunks) {
            await pendingEntry.adapter.sendMessage({
              chatId: pendingEntry.chatId,
              text: chunk,
              parseMode: 'markdown',
            });
          }
          return;
        }

        await pendingEntry.adapter.sendMessage({
          chatId: pendingEntry.chatId,
          text: normalizedText,
          parseMode: 'markdown',
        });
      };

      const trimmed = (text || '').trim();
      if (!trimmed) {
        return;
      }

      // Non-streaming messages should flush any pending streaming buffers to avoid
      // sending stale partial text after important updates.
      if (!isStreaming) {
        this.clearStreamingUpdate(taskId);
      }

      // Use draft streaming for Telegram when streaming content.
      if (isStreaming && pending.adapter instanceof TelegramAdapter) {
        await pending.adapter.updateDraftStream(pending.chatId, trimmed);
        return;
      }

      // Coalesce "streaming" updates for channels that don't support message edits
      // to avoid spamming WhatsApp/iMessage/etc with many near-duplicate messages.
      if (isStreaming) {
        const existing = this.streamingUpdateBuffers.get(taskId) || {
          latestText: '',
          timeoutHandle: null,
          lastSentAt: 0,
        };

        existing.latestText = trimmed;

        if (!existing.timeoutHandle) {
          const now = Date.now();
          const sinceLast = now - existing.lastSentAt;
          const delay = Math.max(0, MessageRouter.STREAMING_UPDATE_DEBOUNCE_MS - sinceLast);

          existing.timeoutHandle = setTimeout(() => {
            const buffer = this.streamingUpdateBuffers.get(taskId);
            const latestPending = this.pendingTaskResponses.get(taskId);
            if (!buffer || !latestPending) {
              if (buffer?.timeoutHandle) {
                clearTimeout(buffer.timeoutHandle);
              }
              this.streamingUpdateBuffers.delete(taskId);
              return;
            }

            buffer.timeoutHandle = null;
            buffer.lastSentAt = Date.now();
            const toSend = buffer.latestText;
            buffer.latestText = '';

            sendNow(latestPending, toSend).catch((error) => {
              console.error('Error sending buffered task update:', error);
            });
          }, delay);
        }

        this.streamingUpdateBuffers.set(taskId, existing);
        return;
      }

      await sendNow(pending, trimmed);
    } catch (error) {
      console.error('Error sending task update:', error);
    }
  }

  private clearStreamingUpdate(taskId: string): void {
    const existing = this.streamingUpdateBuffers.get(taskId);
    if (existing?.timeoutHandle) {
      clearTimeout(existing.timeoutHandle);
    }
    this.streamingUpdateBuffers.delete(taskId);
  }

  /**
   * Send typing indicator to channel
   */
  async sendTypingIndicator(taskId: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) return;

    if (pending.adapter instanceof TelegramAdapter) {
      await pending.adapter.sendTyping(pending.chatId);
    }
  }

  /**
   * Send any artifacts (images, documents) created during task execution
   * Called when follow-ups complete to deliver screenshots, etc.
   */
  async sendArtifacts(taskId: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) {
      return;
    }

    await this.sendTaskArtifacts(taskId, pending.adapter, pending.chatId);
  }

  /**
   * Handle task completion
   * Note: We keep the session linked to the task for follow-up messages
   */
  async handleTaskCompletion(taskId: string, result?: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) return;

    this.clearStreamingUpdate(taskId);

    try {
      // WhatsApp/iMessage-optimized completion message (no follow-up hint)
      const isSimpleMessaging = pending.adapter.type === 'whatsapp' || pending.adapter.type === 'imessage';
      const msgCtx = this.getMessageContext();
      const message = getCompletionMessage(msgCtx, result, !isSimpleMessaging);
      const normalizedMessage = pending.adapter.type === 'whatsapp'
        ? this.normalizeSimpleChannelMessage(message, msgCtx)
        : message;

      // Finalize draft stream if using Telegram
      if (pending.adapter instanceof TelegramAdapter) {
        // Finalize the streaming draft with final message
        await pending.adapter.finalizeDraftStream(pending.chatId, message);

        // Update reaction from 👀 to ✅ on the original message
        if (pending.originalMessageId) {
          await pending.adapter.sendCompletionReaction(pending.chatId, pending.originalMessageId);
        }
      } else {
        // Split long messages (Telegram has 4096 char limit, WhatsApp/iMessage ~65k but keep it reasonable)
        const maxLen = isSimpleMessaging ? 4000 : 4000;
        const chunks = this.splitMessage(normalizedMessage, maxLen);
        for (const chunk of chunks) {
          await pending.adapter.sendMessage({
            chatId: pending.chatId,
            text: chunk,
            parseMode: 'markdown',
          });
        }
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
   * Send task artifacts as documents/images to the channel
   */
  private async sendTaskArtifacts(
    taskId: string,
    adapter: ChannelAdapter,
    chatId: string
  ): Promise<void> {
    try {
      const artifacts = this.artifactRepo.findByTaskId(taskId);
      if (artifacts.length === 0) return;

      // Image extensions
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

      // Document extensions
      const documentExtensions = [
        '.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt',
        '.txt', '.csv', '.json', '.md', '.html', '.xml'
      ];

      // Filter for sendable file types
      const sendableArtifacts = artifacts.filter(artifact => {
        const ext = path.extname(artifact.path).toLowerCase();
        return (imageExtensions.includes(ext) || documentExtensions.includes(ext)) && fs.existsSync(artifact.path);
      });

      if (sendableArtifacts.length === 0) return;

      // Send each artifact
      for (const artifact of sendableArtifacts) {
        try {
          const ext = path.extname(artifact.path).toLowerCase();
          const fileName = path.basename(artifact.path);

          if (imageExtensions.includes(ext) && adapter.sendPhoto) {
            // Send as photo for better display
            await adapter.sendPhoto(chatId, artifact.path, `📷 ${fileName}`);
            console.log(`Sent image: ${fileName}`);
          } else if (adapter.sendDocument) {
            // Send as document
            await adapter.sendDocument(chatId, artifact.path, `📎 ${fileName}`);
            console.log(`Sent document: ${fileName}`);
          } else {
            console.log(`Adapter does not support sending ${ext} files, skipping: ${fileName}`);
          }
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

    this.clearStreamingUpdate(taskId);

    try {
      // Cancel any draft stream
      if (pending.adapter instanceof TelegramAdapter) {
        await pending.adapter.cancelDraftStream(pending.chatId);

        // Remove ACK reaction on failure
        if (pending.originalMessageId) {
          await pending.adapter.removeAckReaction(pending.chatId, pending.originalMessageId);
        }
      }

      const message = getChannelMessage('taskFailed', this.getMessageContext(), { error });
      await pending.adapter.sendMessage({
        chatId: pending.chatId,
        text: message,
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
   * Handle task cancellation.
   * Note: Cancelling unlinks the session from the task.
   */
  async handleTaskCancelled(taskId: string, reason?: string): Promise<void> {
    const pending = this.pendingTaskResponses.get(taskId);
    if (!pending) {
      // Best-effort cleanup if the response tracking entry was already removed.
      const session = this.sessionRepo.findByTaskId(taskId);
      if (session) {
        this.sessionManager.unlinkSessionFromTask(session.id);
      }
      return;
    }

    this.clearStreamingUpdate(taskId);

    try {
      // Cancel any draft stream
      if (pending.adapter instanceof TelegramAdapter) {
        await pending.adapter.cancelDraftStream(pending.chatId);

        // Remove ACK reaction on cancellation
        if (pending.originalMessageId) {
          await pending.adapter.removeAckReaction(pending.chatId, pending.originalMessageId);
        }
      }

      const base = this.getUiCopy('cancelled');
      const message = reason ? `${base}\n\nReason: ${reason}` : base;
      const normalizedMessage = pending.adapter.type === 'whatsapp'
        ? this.normalizeSimpleChannelMessage(message, this.getMessageContext())
        : message;

      await pending.adapter.sendMessage({
        chatId: pending.chatId,
        text: normalizedMessage,
      });

      this.sessionManager.unlinkSessionFromTask(pending.sessionId);
    } catch (err) {
      console.error('Error sending task cancelled message:', err);
    } finally {
      this.pendingTaskResponses.delete(taskId);
    }
  }

  /**
   * Send approval request to Discord/Telegram
   */
  async sendApprovalRequest(taskId: string, approval: any): Promise<void> {
    // Approvals can be requested by sub-agent tasks that do not have their own
    // channel/session mapping. Route these approvals back to the originating
    // session (usually the root task that spawned them).
    const route = this.resolveRouteForTask(taskId);
    if (!route) return;

    const task = this.taskRepo.findById(taskId);
    const taskGatewayContext = task?.agentConfig?.gatewayContext;
    const contextType: 'dm' | 'group' =
      taskGatewayContext === 'group' || taskGatewayContext === 'public' ? 'group' : 'dm';
    const isRoutedFromChild = route.routedTaskId !== taskId;
    const taskTitle = task?.title;

    // Store approval for response handling
    this.pendingApprovals.set(approval.id, {
      taskId,
      approval,
      sessionId: route.sessionId,
      chatId: route.chatId,
      channelType: route.adapter.type,
      requestingUserId: route.requestingUserId,
      requestingUserName: route.requestingUserName,
      contextType,
    });

    // Opportunistic cleanup in case the daemon times out before user responds.
    // We don't have a dedicated expiry event wired into the router yet.
    setTimeout(() => {
      const existing = this.pendingApprovals.get(approval.id);
      if (existing && existing.taskId === taskId) {
        this.pendingApprovals.delete(approval.id);
      }
    }, 6 * 60 * 1000);

    // Format approval message
    let message = `🔐 *${this.getUiCopy('approvalRequiredTitle')}*\n\n`;
    message += `**${approval.description}**\n\n`;

    if (isRoutedFromChild && taskTitle) {
      message += `Source task: *${taskTitle}*\n\n`;
    }

    if (approval.type === 'run_command' && approval.details?.command) {
      message += `\`\`\`\n${approval.details.command}\n\`\`\`\n\n`;
    } else if (approval.details) {
      message += `Details: ${JSON.stringify(approval.details, null, 2)}\n\n`;
    }

    if (contextType === 'group' && route.requestingUserName) {
      message += `Requested by: *${route.requestingUserName}*\n\n`;
    }

    message += `⏳ _Expires in 5 minutes_`;

    // WhatsApp/iMessage don't support inline keyboards - use text commands
    if (route.adapter.type === 'whatsapp' || route.adapter.type === 'imessage') {
      const shortId = typeof approval.id === 'string' ? approval.id.slice(0, 8) : 'unknown';
      message += `\n\nID: \`${shortId}\``;
      message += `\n\n━━━━━━━━━━━━━━━\nReply */approve ${shortId}* or */deny ${shortId}*`;

      try {
        await route.adapter.sendMessage({
          chatId: route.chatId,
          text: message,
          parseMode: 'markdown',
        });
      } catch (error) {
        console.error('Error sending approval request:', error);
      }
    } else {
      // Create inline keyboard with Approve/Deny buttons for Telegram/Discord
      const keyboard: InlineKeyboardButton[][] = [
        [
          { text: this.getUiCopy('approvalButtonApprove'), callbackData: 'approve:' + approval.id },
          { text: this.getUiCopy('approvalButtonDeny'), callbackData: 'deny:' + approval.id },
        ],
      ];

      try {
        await route.adapter.sendMessage({
          chatId: route.chatId,
          text: message,
          parseMode: 'markdown',
          inlineKeyboard: keyboard,
        });
      } catch (error) {
        console.error('Error sending approval request:', error);
      }
    }
  }

  /**
   * Handle /approve command
   */
  private async handleApproveCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    await this.handleApprovalTextCommand(adapter, message, sessionId, args, true);
  }

  /**
   * Handle /deny command
   */
  private async handleDenyCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    await this.handleApprovalTextCommand(adapter, message, sessionId, args, false);
  }

  private formatPendingApprovalChoices(
    approvals: Array<[string, { approval: any }]>
  ): string {
    return approvals
      .map(([id, data], index) => {
        const shortId = id.slice(0, 8);
        const description =
          typeof data.approval?.description === 'string' ? data.approval.description : 'Approval required';
        const trimmed = description.length > 80 ? description.slice(0, 77) + '...' : description;
        return `${index + 1}. \`${shortId}\` - ${trimmed}`;
      })
      .join('\n');
  }

  private async handleApprovalTextCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[],
    approved: boolean
  ): Promise<void> {
    if (!this.agentDaemon) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('agentUnavailable'),
        replyTo: message.messageId,
      });
      return;
    }

    const candidates = Array.from(this.pendingApprovals.entries())
      .filter(([, data]) => data.sessionId === sessionId);

    if (candidates.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('approvalNone'),
        replyTo: message.messageId,
      });
      return;
    }

    const selector = args[0]?.trim();

    let selected: [string, (typeof candidates)[number][1]] | undefined;

    if (!selector) {
      if (candidates.length > 1) {
        const list = this.formatPendingApprovalChoices(candidates as any);
        await adapter.sendMessage({
          chatId: message.chatId,
          text: `Multiple approvals are pending. Reply with:\n\n- \`/approve <id>\` or \`/deny <id>\` (recommended)\n- Or use \`/approve <number>\` (example: \`/approve 1\`)\n\n${list}`,
          parseMode: 'markdown',
          replyTo: message.messageId,
        });
        return;
      }
      selected = candidates[0];
    } else {
      // Support selecting by numeric index (1-based) or by ID prefix.
      const idx = Number.parseInt(selector, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= candidates.length) {
        selected = candidates[idx - 1];
      } else {
        const prefix = selector.toLowerCase();
        const matches = candidates.filter(([id]) => id.toLowerCase().startsWith(prefix));
        if (matches.length === 1) {
          selected = matches[0];
        } else if (matches.length === 0) {
          const list = this.formatPendingApprovalChoices(candidates as any);
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `No pending approval found for \`${selector}\`.\n\n${list}`,
            parseMode: 'markdown',
            replyTo: message.messageId,
          });
          return;
        } else {
          const list = this.formatPendingApprovalChoices(matches as any);
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `That ID prefix is ambiguous. Please paste more characters.\n\n${list}`,
            parseMode: 'markdown',
            replyTo: message.messageId,
          });
          return;
        }
      }
    }

    const [approvalId, data] = selected;

    // Sanity check: approvals are scoped to a session/chat.
    if (data.chatId !== message.chatId) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('approvalNone'),
        replyTo: message.messageId,
      });
      return;
    }

    // Group chat safety: only the user who triggered the approval request can respond.
    // This prevents group-hijack of dangerous approvals.
    if (data.contextType === 'group' && data.requestingUserId && message.userId !== data.requestingUserId) {
      const who = data.requestingUserName ? `*${data.requestingUserName}*` : 'the original requester';
      await adapter.sendMessage({
        chatId: message.chatId,
        text: `⚠️ Only ${who} can approve/deny this request in a group chat.`,
        parseMode: 'markdown',
        replyTo: message.messageId,
      });
      return;
    }

    try {
      const status = await this.agentDaemon.respondToApproval(approvalId, approved);
      if (status === 'in_progress') {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: '⏳ That approval is already being processed. Try again in a moment.',
          replyTo: message.messageId,
        });
        return;
      }

      // Remove it from local pending approvals regardless of daemon response outcome.
      this.pendingApprovals.delete(approvalId);

      if (status === 'handled') {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: approved ? this.getUiCopy('approvalApproved') : this.getUiCopy('approvalDenied'),
          replyTo: message.messageId,
        });
        return;
      }

      if (status === 'duplicate') {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: '✅ That approval was already handled.',
          replyTo: message.messageId,
        });
        return;
      }

      if (status === 'not_found') {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: '⌛ That approval request has expired or was already handled.',
          replyTo: message.messageId,
        });
        return;
      }

      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('approvalFailed'),
        replyTo: message.messageId,
      });
    } catch (error) {
      console.error('Error responding to approval:', error);
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('approvalFailed'),
        replyTo: message.messageId,
      });
    }
  }

  /**
   * Handle /queue command - view or clear task queue
   */
  private async handleQueueCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    args: string[]
  ): Promise<void> {
    if (!this.agentDaemon) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('agentUnavailable'),
      });
      return;
    }

    const subcommand = args[0]?.toLowerCase();

    if (subcommand === 'clear' || subcommand === 'reset') {
      // Clear stuck tasks (also properly cancels running tasks to clean up browser sessions)
      const result = await this.agentDaemon.clearStuckTasks();
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('queueCleared', {
          running: result.clearedRunning,
          queued: result.clearedQueued,
        }),
      });
    } else {
      // Show queue status
      const status = this.agentDaemon.getQueueStatus();
      const statusText = `📊 *Queue Status*

• Running: ${status.runningCount}/${status.maxConcurrent}
• Queued: ${status.queuedCount}

${status.runningCount > 0 ? `Running task IDs: ${status.runningTaskIds.join(', ')}` : ''}
${status.queuedCount > 0 ? `Queued task IDs: ${status.queuedTaskIds.join(', ')}` : ''}

*Commands:*
• \`/queue\` - Show this status
• \`/queue clear\` - Clear stuck tasks`;

      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('queueStatus', { statusText }),
        parseMode: 'markdown',
      });
    }
  }

  /**
   * Split a message into chunks for channel character limits.
   * Prefers splitting on newlines/spaces to avoid breaking words.
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
      const taskId = session.taskId;

      const task = this.taskRepo.findById(taskId);
      if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) {
        // No active task to cancel.
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('cancelNoActive'),
        });
        return;
      }

      // Cancel task directly when daemon is available (works even without a renderer window).
      // When the daemon is present, it will emit task_cancelled, and handleTaskCancelled performs the cleanup + user message.
      if (this.agentDaemon) {
        try {
          await this.agentDaemon.cancelTask(taskId);
        } catch (error) {
          console.error('Error cancelling task:', error);
          await adapter.sendMessage({
            chatId: message.chatId,
            text: `❌ Failed to cancel task: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
        return;
      }

      // Fallback: notify desktop app to cancel the task.
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('gateway:cancel-task', {
          taskId,
          sessionId,
        });
      }

      // Without a daemon, we won't receive task_cancelled. Perform the same cleanup + user message here.
      const pending = this.pendingTaskResponses.get(taskId);
      if (pending) {
        await this.handleTaskCancelled(taskId);
      } else {
        this.sessionManager.unlinkSessionFromTask(sessionId);
        this.pendingTaskResponses.delete(taskId);
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('cancelled'),
        });
      }
    } else {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('cancelNoActive'),
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
      text: this.getUiCopy('newTaskReady'),
    });
  }

  /**
   * Handle /removeworkspace command
   */
  private async handleRemoveWorkspaceCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string,
    args: string[]
  ): Promise<void> {
    if (args.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspaceRemoveUsage'),
        parseMode: 'markdown',
      });
      return;
    }

    const workspaceName = args.join(' ');
    const workspaces = this.workspaceRepo.findAll();
    const workspace = workspaces.find(
      (w) => w.name.toLowerCase() === workspaceName.toLowerCase()
    );

    if (!workspace) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('workspaceNotFound', { selector: workspaceName }),
      });
      return;
    }

    // Check if this is the current workspace for the session
    const session = this.sessionRepo.findById(sessionId);
    if (session?.workspaceId === workspace.id) {
      // Clear the workspace from session
      this.sessionRepo.update(sessionId, { workspaceId: undefined });
    }

    // Remove the workspace
    this.workspaceRepo.delete(workspace.id);

    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('workspaceRemoved', { workspaceName: workspace.name }),
    });
  }

  /**
   * Handle /retry command - retry the last failed task
   */
  private async handleRetryCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    let session = this.sessionRepo.findById(sessionId);

    // Auto-assign temp workspace if none selected
    if (!session?.workspaceId) {
      const tempWorkspace = this.getOrCreateTempWorkspace();
      this.sessionRepo.update(sessionId, { workspaceId: tempWorkspace.id });
      session = this.sessionRepo.findById(sessionId);
    }

    // Find the last task for this session's workspace that failed or was cancelled
    const tasks = this.taskRepo.findByWorkspace(session!.workspaceId!);
    const lastFailedTask = tasks
      .filter((t: Task) => t.status === 'failed' || t.status === 'cancelled')
      .sort((a: Task, b: Task) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!lastFailedTask) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('retryNone'),
      });
      return;
    }

    // Re-submit the task by sending the original prompt as a new message
    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('retrying', { taskTitle: lastFailedTask.title }),
    });

    // Create a synthetic message with the original prompt
    const retryMessage: IncomingMessage = {
      ...message,
      text: lastFailedTask.title,
    };

    // Route as a regular task message
    await this.routeMessage(adapter, retryMessage, sessionId);
  }

  /**
   * Handle /history command - show recent task history
   */
  private async handleHistoryCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    let session = this.sessionRepo.findById(sessionId);

    // Auto-assign temp workspace if none selected
    if (!session?.workspaceId) {
      const tempWorkspace = this.getOrCreateTempWorkspace();
      this.sessionRepo.update(sessionId, { workspaceId: tempWorkspace.id });
      session = this.sessionRepo.findById(sessionId);
    }

    const tasks = this.taskRepo.findByWorkspace(session!.workspaceId!);
    const recentTasks = tasks
      .sort((a: Task, b: Task) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);

    if (recentTasks.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('historyNone'),
      });
      return;
    }

    const statusEmoji: Record<string, string> = {
      completed: '✅',
      running: '⏳',
      pending: '⏸️',
      error: '❌',
      cancelled: '🚫',
    };

    const historyText = recentTasks
      .map((t: Task, i: number) => {
        const emoji = statusEmoji[t.status] || '❓';
        const date = new Date(t.createdAt).toLocaleDateString();
        const title = t.title.length > 40 ? t.title.substring(0, 40) + '...' : t.title;
        return `${i + 1}. ${emoji} ${title}\n   ${date} • ${t.status}`;
      })
      .join('\n\n');

    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('historyHeader', { history: historyText }),
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /skills command - list available skills
   */
  private async handleSkillsCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    _sessionId: string
  ): Promise<void> {
    try {
      const skillLoader = getCustomSkillLoader();
      await skillLoader.initialize();
      const skills = skillLoader.listTaskSkills();

      if (skills.length === 0) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('skillsNone'),
          parseMode: 'markdown',
        });
        return;
      }

      // Group skills by category
      const byCategory = new Map<string, typeof skills>();
      for (const skill of skills) {
        const category = skill.category || 'Uncategorized';
        if (!byCategory.has(category)) {
          byCategory.set(category, []);
        }
        byCategory.get(category)!.push(skill);
      }

      let text = '📚 *Available Skills*\n\n';
      for (const [category, categorySkills] of byCategory) {
        text += `*${category}*\n`;
        for (const skill of categorySkills) {
          const status = skill.enabled !== false ? '✅' : '❌';
          text += `${skill.icon || '⚡'} ${skill.name} ${status}\n`;
          text += `   \`/skill ${skill.id}\` to toggle\n`;
        }
        text += '\n';
      }

      text += '_Use `/skill <name>` to toggle a skill on/off_';

      await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
      });
    } catch (error) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('skillsLoadFailed'),
      });
    }
  }

  /**
   * Handle /skill command - toggle a skill on/off
   */
  private async handleSkillCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    _sessionId: string,
    args: string[]
  ): Promise<void> {
    if (args.length === 0) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('skillSpecify'),
        parseMode: 'markdown',
      });
      return;
    }

    try {
      const skillLoader = getCustomSkillLoader();
      await skillLoader.initialize();
      const skillId = args[0].toLowerCase();
      const skill = skillLoader.getSkill(skillId);

      if (!skill) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('skillNotFound', { skillId }),
        });
        return;
      }

      // Toggle the enabled state
      const newState = skill.enabled === false;
      await skillLoader.updateSkill(skillId, { enabled: newState });

      const statusText = newState ? '✅ enabled' : '❌ disabled';
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('skillToggle', {
          emoji: skill.icon || '⚡',
          skillName: skill.name,
          statusText,
        }),
        parseMode: 'markdown',
      });
    } catch (error) {
      await adapter.sendMessage({
        chatId: message.chatId,
        text: this.getUiCopy('skillsLoadFailed'),
      });
    }
  }

  /**
   * Handle /providers command - list available LLM providers
   */
  private async handleProvidersCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const status = LLMProviderFactory.getConfigStatus();
    const current = status.currentProvider;

    const providerEmoji: Record<string, string> = {
      anthropic: '🟠',
      openai: '🟢',
      gemini: '🔵',
      bedrock: '🟡',
      ollama: '⚪',
      openrouter: '🟣',
    };

    // Build inline keyboard with provider buttons
    const keyboard: InlineKeyboardButton[][] = [];
    const row1: InlineKeyboardButton[] = [];
    const row2: InlineKeyboardButton[] = [];

    // Get configured providers for the keyboard
    const providerOrder: LLMProviderType[] = ['anthropic', 'openai', 'azure', 'gemini', 'bedrock', 'openrouter', 'ollama'];

    for (let i = 0; i < providerOrder.length; i++) {
      const provider = providerOrder[i];
      const emoji = providerEmoji[provider] || '⚡';
      const isCurrent = provider === current ? ' ✓' : '';
      const providerInfo = status.providers.find(p => p.type === provider);
      const name = providerInfo?.name || provider;

      const button: InlineKeyboardButton = {
        text: `${emoji} ${name}${isCurrent}`,
        callbackData: `provider:${provider}`,
      };

      // Split into two rows
      if (i < 3) {
        row1.push(button);
      } else {
        row2.push(button);
      }
    }

    keyboard.push(row1);
    keyboard.push(row2);

    const currentProviderInfo = status.providers.find(p => p.type === current);

    // WhatsApp/iMessage don't support inline keyboards - use text-based selection
    if (adapter.type === 'whatsapp' || adapter.type === 'imessage') {
      let text = `🤖 *AI Providers*\n\nCurrent: *${currentProviderInfo?.name || current}*\n\n`;
      providerOrder.forEach((provider, index) => {
        const emoji = providerEmoji[provider] || '⚡';
        const providerInfo = status.providers.find(p => p.type === provider);
        const name = providerInfo?.name || provider;
        const isCurrent = provider === current ? ' ✓' : '';
        text += `${index + 1}. ${emoji} *${name}*${isCurrent}\n`;
      });
      text += '\n━━━━━━━━━━━━━━━\n';
      text += 'Reply with number to switch.\nExample: `1` for Anthropic';

      await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
        threadId: message.threadId,
      });

      // Allow a plain numeric reply (e.g., "1") to select provider.
      this.sessionManager.updateSessionContext(sessionId, {
        pendingSelection: { type: 'provider', createdAt: Date.now() },
      });
    } else {
      let text = `🤖 *AI Providers*\n\nCurrent: ${currentProviderInfo?.name || current}\n\nTap to switch:`;

      const messageId = await adapter.sendMessage({
        chatId: message.chatId,
        text,
        parseMode: 'markdown',
        inlineKeyboard: keyboard,
        threadId: message.threadId,
      });
      if (messageId) {
        this.registerInlineActionGuard({
          action: 'provider',
          channelType: adapter.type,
          chatId: message.chatId,
          messageId,
          requestingUserId: message.userId,
          requestingUserName: message.userName,
        });
      }
    }
  }

  /**
   * Handle /settings command - view current settings
   */
  private async handleSettingsCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    const workspace = session?.workspaceId
      ? this.workspaceRepo.findById(session.workspaceId)
      : null;

    const provider = LLMProviderFactory.getSelectedProvider();
    const model = LLMProviderFactory.getSelectedModel();
    const settings = LLMProviderFactory.getSettings();

    let text = '⚙️ *Current Settings*\n\n';

    text += '*Workspace*\n';
    text += workspace ? `📁 ${workspace.name}\n` : '❌ None selected\n';
    text += '\n';

    text += '*AI Configuration*\n';
    text += `🤖 Provider: \`${provider}\`\n`;
    text += `🧠 Model: \`${model}\`\n`;
    text += '\n';

    text += '*Session*\n';
    text += `🔧 Shell commands: ${session?.shellEnabled ? '✅' : '❌'}\n`;
    text += `📝 Debug mode: ${session?.debugMode ? '✅' : '❌'}\n`;

    await adapter.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /debug command - toggle debug mode
   */
  private async handleDebugCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    const currentDebug = session?.debugMode || false;
    const newDebug = !currentDebug;

    this.sessionRepo.update(sessionId, { debugMode: newDebug });

    const statusText = newDebug ? '✅ enabled' : '❌ disabled';
    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('debugStatus', { statusText }),
    });
  }

  /**
   * Handle /version command - show version info
   */
  private async handleVersionCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage
  ): Promise<void> {
    const version = app.getVersion();
    const electronVersion = process.versions.electron;
    const nodeVersion = process.versions.node;
    const platform = process.platform;
    const arch = process.arch;

    const text = `📦 *CoWork OS*

Version: \`${version}\`
Platform: \`${platform}\` (${arch})
Electron: \`${electronVersion}\`
Node.js: \`${nodeVersion}\`

🔗 [GitHub](https://github.com/CoWork-OS/cowork-os)`;

    await adapter.sendMessage({
      chatId: message.chatId,
      text,
      parseMode: 'markdown',
    });
  }

  /**
   * Handle /start command with smart onboarding
   */
  private async handleStartCommand(
    adapter: ChannelAdapter,
    message: IncomingMessage,
    sessionId: string
  ): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    const workspaces = this.workspaceRepo.findAll();

    // WhatsApp/iMessage-optimized welcome flow (no inline keyboards)
    if (adapter.type === 'whatsapp' || adapter.type === 'imessage') {
      if (session?.workspaceId) {
        const workspace = this.workspaceRepo.findById(session.workspaceId);
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('welcomeBack', { workspaceName: workspace?.name || 'Unknown' }),
          parseMode: 'markdown',
        });
      } else if (workspaces.length === 0) {
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('welcomeNoWorkspace'),
          parseMode: 'markdown',
        });
      } else if (workspaces.length === 1) {
        // Auto-select the only workspace
        const workspace = workspaces[0];
        this.sessionManager.setSessionWorkspace(sessionId, workspace.id);
        await adapter.sendMessage({
          chatId: message.chatId,
          text: this.getUiCopy('welcomeSingleWorkspace', { workspaceName: workspace.name }),
          parseMode: 'markdown',
        });
      } else {
        // Multiple workspaces - show selection
        const workspaceList = workspaces
          .map((ws, index) => `${index + 1}. *${ws.name}*`)
          .join('\n');
        const text = this.getUiCopy('welcomeSelectWorkspace', { workspaceList });

        await adapter.sendMessage({
          chatId: message.chatId,
          text,
          parseMode: 'markdown',
        });
      }
      return;
    }

    // Standard welcome for Telegram/Discord
    await adapter.sendMessage({
      chatId: message.chatId,
      text: this.getUiCopy('welcomeStandard'),
    });

    // Show workspaces if none selected
    if (!session?.workspaceId && workspaces.length > 0) {
      await this.handleWorkspacesCommand(adapter, message, sessionId);
    }
  }

  /**
   * Get help text - channel-specific for better UX
   */
  private getHelpText(channelType?: ChannelType): string {
    // Compact help for WhatsApp (mobile-friendly)
    if (channelType === 'whatsapp') {
      return this.getUiCopy('helpCompact');
    }

    // Full help for other channels
    return this.getUiCopy('helpFull');
  }

  /**
   * Handle callback query from inline keyboard button press
   */
  private async handleCallbackQuery(adapter: ChannelAdapter, query: CallbackQuery): Promise<void> {
    const { data, chatId } = query;

    // Parse callback data (format: action:param)
    const [action, ...params] = data.split(':');
    const param = params.join(':');

    try {
      let callbackAnswered = false;
      const answer = async (text?: string, showAlert?: boolean): Promise<void> => {
        if (callbackAnswered) return;
        callbackAnswered = true;
        if (adapter.answerCallbackQuery) {
          await adapter.answerCallbackQuery(query.id, text, showAlert);
        }
      };

      const channel = this.channelRepo.findByType(adapter.type);
      if (!channel) {
        console.error(`No channel configuration found for ${adapter.type}`);
        return;
      }

      // Security check for callback actions (inline keyboard presses).
      // Without this, any user in a group could press buttons even if they aren't authorized.
      const syntheticMessage: IncomingMessage = {
        messageId: query.messageId,
        channel: adapter.type,
        userId: query.userId,
        userName: query.userName,
        chatId: query.chatId,
        text: '',
        timestamp: new Date(),
      };
      const securityResult = await this.securityManager.checkAccess(channel, syntheticMessage);
      if (!securityResult.allowed) {
        await answer('Not authorized.', true);
        if (securityResult.pairingRequired) {
          await adapter.sendMessage({
            chatId: query.chatId,
            text: this.getUiCopy('pairingRequired'),
          });
        }
        return;
      }

      // Get or create session for this chat
      // Find existing session or create one
      let session = this.sessionRepo.findByChatId(channel.id, chatId);
      if (!session) {
        // Create a minimal session for handling callback
        session = this.sessionRepo.create({
          channelId: channel.id,
          chatId,
          state: 'idle',
        });
      }

      // Guard certain inline actions (workspace/provider/model selectors) so only the
      // initiating user can press buttons, and so old keyboards don't keep working.
      const guardKey = this.makeInlineActionGuardKey(adapter.type, query.chatId, query.messageId);
      const guardable = action === 'workspace' || action === 'provider' || action === 'model';
      if (guardable) {
        const guard = this.pendingInlineActionGuards.get(guardKey);
        const expiredText =
          action === 'workspace'
            ? '⌛ This workspace selector has expired. Run /workspaces again.'
            : action === 'provider'
              ? '⌛ This provider selector has expired. Run /providers again.'
              : '⌛ This selector has expired. Please run the command again.';

        if (!guard || guard.action !== action || guard.channelType !== adapter.type || guard.chatId !== query.chatId) {
          await answer(expiredText, true);
          return;
        }
        if (Date.now() > guard.expiresAt) {
          this.pendingInlineActionGuards.delete(guardKey);
          await answer(expiredText, true);
          return;
        }
        if (guard.requestingUserId && guard.requestingUserId !== query.userId) {
          const who = guard.requestingUserName ? guard.requestingUserName : 'the original requester';
          await answer(`Only ${who} can use these buttons.`, true);
          return;
        }
      }

      // Answer the callback to remove loading indicator (after validation).
      await answer();

      switch (action) {
        case 'workspace':
          await this.handleWorkspaceCallback(adapter, query, session.id, param);
          this.pendingInlineActionGuards.delete(guardKey);
          break;

        case 'provider':
          await this.handleProviderCallback(adapter, query, param);
          this.pendingInlineActionGuards.delete(guardKey);
          break;

        case 'model':
          await this.handleModelCallback(adapter, query, param);
          this.pendingInlineActionGuards.delete(guardKey);
          break;

        case 'approve':
          await this.handleApprovalCallback(adapter, query, session.id, param, true);
          break;

        case 'deny':
          await this.handleApprovalCallback(adapter, query, session.id, param, false);
          break;

        default:
          console.log(`Unknown callback action: ${action}`);
      }
    } catch (error) {
      console.error('Error handling callback query:', error);
    }
  }

  /**
   * Handle workspace selection callback
   */
  private async handleWorkspaceCallback(
    adapter: ChannelAdapter,
    query: CallbackQuery,
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: this.getUiCopy('workspaceNotFoundShort'),
      });
      return;
    }

    // Update session workspace
    this.sessionManager.setSessionWorkspace(sessionId, workspace.id);

    // Update the original message with the selection
    if (adapter.editMessageWithKeyboard) {
      await adapter.editMessageWithKeyboard(
        query.chatId,
        query.messageId,
        this.getUiCopy('workspaceSet', {
          workspaceName: workspace.name,
          workspacePath: workspace.path,
        }),
        []
      );
    } else {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: this.getUiCopy('workspaceSet', {
          workspaceName: workspace.name,
          workspacePath: workspace.path,
        }),
        parseMode: 'markdown',
      });
    }
  }

  /**
   * Handle provider selection callback
   */
  private async handleProviderCallback(
    adapter: ChannelAdapter,
    query: CallbackQuery,
    providerType: string
  ): Promise<void> {
    const settings = LLMProviderFactory.loadSettings();
    const status = LLMProviderFactory.getConfigStatus();

    // Update provider
    const newSettings: LLMSettings = {
      ...settings,
      providerType: providerType as LLMProviderType,
    };

    LLMProviderFactory.saveSettings(newSettings);
    LLMProviderFactory.clearCache();

    const providerInfo = status.providers.find(p => p.type === providerType);

    // Update the original message
    if (adapter.editMessageWithKeyboard) {
      await adapter.editMessageWithKeyboard(
        query.chatId,
        query.messageId,
        `✅ Provider changed to: *${providerInfo?.name || providerType}*\n\nUse /models to see available models.`,
        []
      );
    } else {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: `✅ Provider changed to: *${providerInfo?.name || providerType}*`,
        parseMode: 'markdown',
      });
    }
  }

  /**
   * Handle model selection callback
   */
  private async handleModelCallback(
    adapter: ChannelAdapter,
    query: CallbackQuery,
    modelKey: string
  ): Promise<void> {
    const settings = LLMProviderFactory.loadSettings();
    const status = LLMProviderFactory.getConfigStatus();
    const modelInfo = status.models.find(m => m.key === modelKey);
    const displayName = modelInfo?.displayName || modelKey;
    const newSettings = LLMProviderFactory.applyModelSelection(settings, modelKey);

    LLMProviderFactory.saveSettings(newSettings);
    LLMProviderFactory.clearCache();

    // Update the original message
    if (adapter.editMessageWithKeyboard) {
      await adapter.editMessageWithKeyboard(
        query.chatId,
        query.messageId,
        `✅ Model changed to: *${displayName}*`,
        []
      );
    } else {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: `✅ Model changed to: *${displayName}*`,
        parseMode: 'markdown',
      });
    }
  }

  /**
   * Handle approval/deny callback from inline buttons
   */
  private async handleApprovalCallback(
    adapter: ChannelAdapter,
    query: CallbackQuery,
    sessionId: string,
    approvalId: string,
    approved: boolean
  ): Promise<void> {
    if (!this.agentDaemon) {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: this.getUiCopy('agentUnavailable'),
      });
      return;
    }

    if (!approvalId) {
      await adapter.sendMessage({
        chatId: query.chatId,
        text: this.getUiCopy('approvalNone'),
      });
      return;
    }

    const data = this.pendingApprovals.get(approvalId);
    if (!data || data.sessionId !== sessionId || data.chatId !== query.chatId) {
      if (adapter.editMessageWithKeyboard) {
        await adapter.editMessageWithKeyboard(
          query.chatId,
          query.messageId,
          '⌛ This approval request has expired or is no longer pending.',
          []
        );
      } else {
        await adapter.sendMessage({
          chatId: query.chatId,
          text: '⌛ This approval request has expired or is no longer pending.',
        });
      }
      return;
    }

    // Group chat safety: only the user who triggered the approval request can respond.
    if (data.contextType === 'group' && data.requestingUserId && query.userId !== data.requestingUserId) {
      const who = data.requestingUserName ? `*${data.requestingUserName}*` : 'the original requester';
      await adapter.sendMessage({
        chatId: query.chatId,
        text: `⚠️ Only ${who} can approve/deny this request in a group chat.`,
        parseMode: 'markdown',
      });
      return;
    }

    try {
      const status = await this.agentDaemon.respondToApproval(approvalId, approved);
      if (status === 'in_progress') {
        await adapter.sendMessage({
          chatId: query.chatId,
          text: '⏳ That approval is already being processed. Try again in a moment.',
        });
        return;
      }

      this.pendingApprovals.delete(approvalId);

      let statusText: string;
      if (status === 'handled') {
        statusText = approved ? this.getUiCopy('approvalApproved') : this.getUiCopy('approvalDenied');
      } else if (status === 'duplicate') {
        statusText = '✅ That approval was already handled.';
      } else if (status === 'not_found') {
        statusText = '⌛ This approval request has expired or was already handled.';
      } else {
        statusText = this.getUiCopy('approvalFailed');
      }

      if (adapter.editMessageWithKeyboard) {
        await adapter.editMessageWithKeyboard(
          query.chatId,
          query.messageId,
          statusText,
          []
        );
      } else {
        await adapter.sendMessage({
          chatId: query.chatId,
          text: statusText,
        });
      }
    } catch (error) {
      console.error('Error responding to approval:', error);
      await adapter.sendMessage({
        chatId: query.chatId,
        text: this.getUiCopy('responseFailed'),
      });
    }
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
