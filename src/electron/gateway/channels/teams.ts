/**
 * Microsoft Teams Channel Adapter
 *
 * Implements the ChannelAdapter interface using Microsoft Bot Framework SDK.
 * Supports direct messages, channel mentions, and group chats.
 */

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  Activity,
  ActivityTypes,
  ConversationReference,
  MessageFactory,
} from 'botbuilder';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  TeamsConfig,
} from './types';

/**
 * Simple TTL cache for message deduplication
 */
class MessageDeduplicationCache {
  private cache: Map<string, number> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60000) {
    this.ttlMs = ttlMs;
    // Cleanup expired entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  has(messageId: string): boolean {
    const timestamp = this.cache.get(messageId);
    if (!timestamp) return false;
    if (Date.now() - timestamp > this.ttlMs) {
      this.cache.delete(messageId);
      return false;
    }
    return true;
  }

  add(messageId: string): void {
    this.cache.set(messageId, Date.now());
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

export class TeamsAdapter implements ChannelAdapter {
  readonly type = 'teams' as const;

  private adapter: CloudAdapter | null = null;
  private server: http.Server | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private _botId?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: TeamsConfig;
  private conversationReferences: Map<string, Partial<ConversationReference>> = new Map();
  private deduplicationCache: MessageDeduplicationCache;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: TeamsConfig) {
    this.config = config;
    this.deduplicationCache = new MessageDeduplicationCache();
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to Microsoft Teams via Bot Framework
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create Bot Framework authentication
      const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: this.config.appId,
        MicrosoftAppPassword: this.config.appPassword,
        MicrosoftAppTenantId: this.config.tenantId,
        MicrosoftAppType: this.config.tenantId ? 'SingleTenant' : 'MultiTenant',
      });

      // Create the adapter
      this.adapter = new CloudAdapter(botFrameworkAuth);

      // Set up error handling for the adapter
      this.adapter.onTurnError = async (context: TurnContext, error: Error) => {
        console.error('Teams adapter turn error:', error);
        this.handleError(error, 'turnError');

        // Send error message to user
        try {
          await context.sendActivity('Sorry, something went wrong processing your message.');
        } catch (sendError) {
          console.error('Failed to send error message:', sendError);
        }
      };

      // Set bot info from config
      this._botUsername = this.config.displayName || 'Teams Bot';

      // Start the HTTP server for receiving webhooks
      await this.startWebhookServer();

      console.log(`Teams bot "${this._botUsername}" is connected on port ${this.config.webhookPort || 3978}`);
      this.setStatus('connected');
      this.reconnectAttempts = 0;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Start the webhook server to receive messages from Teams
   */
  private async startWebhookServer(): Promise<void> {
    const port = this.config.webhookPort || 3978;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/api/messages') {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', async () => {
            try {
              await this.processIncomingActivity(req, res, body);
            } catch (error) {
              console.error('Error processing Teams message:', error);
              res.writeHead(500);
              res.end('Internal Server Error');
            }
          });
        } else if (req.method === 'GET' && req.url === '/api/health') {
          // Health check endpoint
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', bot: this._botUsername }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Please choose a different webhook port.`));
        } else if (error.code === 'EACCES') {
          reject(new Error(`Permission denied to use port ${port}. Try a port above 1024.`));
        } else {
          reject(error);
        }
      });

      this.server.listen(port, () => {
        console.log(`Teams webhook server listening on port ${port}`);
        resolve();
      });
    });
  }

  /**
   * Process incoming activity from Teams
   */
  private async processIncomingActivity(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ): Promise<void> {
    if (!this.adapter) {
      res.writeHead(500);
      res.end('Adapter not initialized');
      return;
    }

    try {
      const activity: Activity = JSON.parse(body);

      // Create a fake request object for the adapter
      const fakeReq = {
        body: activity,
        headers: req.headers,
        method: req.method,
      };

      await this.adapter.process(fakeReq as any, res as any, async (context: TurnContext) => {
        await this.handleActivity(context);
      });
    } catch (error) {
      console.error('Error parsing Teams activity:', error);
      res.writeHead(400);
      res.end('Bad Request');
    }
  }

  /**
   * Handle incoming activity from Teams
   */
  private async handleActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Store conversation reference for proactive messaging
    const conversationRef = TurnContext.getConversationReference(activity);
    this.conversationReferences.set(activity.conversation.id, conversationRef);

    // Handle different activity types
    switch (activity.type) {
      case ActivityTypes.Message:
        await this.handleMessage(context, activity);
        break;

      case ActivityTypes.ConversationUpdate:
        await this.handleConversationUpdate(context, activity);
        break;

      case ActivityTypes.MessageReaction:
        // Handle reactions if needed
        break;

      default:
        // Log unhandled activity types for debugging
        console.log(`Unhandled activity type: ${activity.type}`);
    }
  }

  /**
   * Handle incoming message activity
   */
  private async handleMessage(context: TurnContext, activity: Activity): Promise<void> {
    // Skip if no text content
    if (!activity.text) {
      return;
    }

    // Deduplication check
    const messageId = activity.id || `${activity.conversation.id}-${activity.timestamp}`;
    if (this.config.deduplicationEnabled !== false && this.deduplicationCache.has(messageId)) {
      console.log(`Skipping duplicate Teams message: ${messageId}`);
      return;
    }
    this.deduplicationCache.add(messageId);

    // Remove bot mention from text
    let text = activity.text;
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id === activity.recipient?.id) {
          // Remove the mention from the text
          const mentionText = entity.text || '';
          text = text.replace(mentionText, '').trim();
        }
      }
    }

    // Skip empty messages after removing mentions
    if (!text.trim()) {
      return;
    }

    // Get user info
    const userName = activity.from?.name || 'Unknown User';
    const userId = activity.from?.id || '';

    const conversationType = activity.conversation?.conversationType;
    const isGroup = conversationType ? conversationType !== 'personal' : undefined;

    // Map to IncomingMessage format
    const incomingMessage: IncomingMessage = {
      messageId: messageId,
      channel: 'teams',
      userId: userId,
      userName: userName,
      chatId: activity.conversation.id,
      isGroup,
      text: text.trim(),
      timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
      replyTo: activity.replyToId,
      threadId: activity.conversation.id,
      raw: activity,
    };

    console.log(`Processing Teams message from ${userName}: ${text.slice(0, 50)}...`);
    await this.handleIncomingMessage(incomingMessage);
  }

  /**
   * Handle conversation update activity (new members, etc.)
   */
  private async handleConversationUpdate(context: TurnContext, activity: Activity): Promise<void> {
    // Welcome new members
    if (activity.membersAdded) {
      for (const member of activity.membersAdded) {
        // Don't welcome the bot itself
        if (member.id !== activity.recipient?.id) {
          // Could send a welcome message here if desired
          console.log(`New member added to conversation: ${member.name}`);
        }
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.config.autoReconnect) return;

    const maxAttempts = this.config.maxReconnectAttempts || 5;
    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`Teams: Max reconnection attempts (${maxAttempts}) reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Teams: Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error('Teams reconnection failed:', error);
      }
    }, delay);
  }

  /**
   * Disconnect from Teams
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.adapter = null;
    this._botUsername = undefined;
    this._botId = undefined;
    this.conversationReferences.clear();
    this.setStatus('disconnected');
  }

  /**
   * Send a message to a Teams conversation
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.adapter || this._status !== 'connected') {
      throw new Error('Teams bot is not connected');
    }

    // Get conversation reference
    const conversationRef = this.conversationReferences.get(message.chatId);
    if (!conversationRef) {
      throw new Error(`No conversation reference found for chat: ${message.chatId}`);
    }

    // Process text for Teams compatibility
    let processedText = message.text;
    if (message.parseMode === 'markdown') {
      processedText = this.convertMarkdownForTeams(message.text);
    }

    // Teams has a 28KB limit per message, but practical limit is ~4000 chars for readability
    const chunks = this.splitMessage(processedText, 4000);
    let lastMessageId = '';

    try {
      for (const chunk of chunks) {
        await this.adapter.continueConversationAsync(
          this.config.appId,
          conversationRef as ConversationReference,
          async (context: TurnContext) => {
            const response = await context.sendActivity(MessageFactory.text(chunk));
            lastMessageId = response?.id || '';
          }
        );
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error sending Teams message:', errorMessage);
      throw error;
    }

    return lastMessageId;
  }

  /**
   * Convert GitHub-flavored markdown to Teams format
   * Teams supports a subset of markdown
   */
  private convertMarkdownForTeams(text: string): string {
    let result = text;

    // Teams supports basic markdown: **bold**, *italic*, ~~strikethrough~~, `code`, ```code blocks```
    // No conversion needed for these

    // Convert horizontal rules
    result = result.replace(/^[-*]{3,}$/gm, '───────────────────');

    return result;
  }

  /**
   * Split message into chunks respecting Teams message limit
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

      // Find a good breaking point (newline or space)
      let breakIndex = remaining.lastIndexOf('\n', maxLength);
      if (breakIndex === -1 || breakIndex < maxLength / 2) {
        breakIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakIndex === -1 || breakIndex < maxLength / 2) {
        breakIndex = maxLength;
      }

      chunks.push(remaining.substring(0, breakIndex));
      remaining = remaining.substring(breakIndex).trimStart();
    }

    return chunks;
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.adapter || this._status !== 'connected') {
      throw new Error('Teams bot is not connected');
    }

    const conversationRef = this.conversationReferences.get(chatId);
    if (!conversationRef) {
      throw new Error(`No conversation reference found for chat: ${chatId}`);
    }

    await this.adapter.continueConversationAsync(
      this.config.appId,
      conversationRef as ConversationReference,
      async (context: TurnContext) => {
        const activity = MessageFactory.text(text);
        activity.id = messageId;
        await context.updateActivity(activity);
      }
    );
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.adapter || this._status !== 'connected') {
      throw new Error('Teams bot is not connected');
    }

    const conversationRef = this.conversationReferences.get(chatId);
    if (!conversationRef) {
      throw new Error(`No conversation reference found for chat: ${chatId}`);
    }

    await this.adapter.continueConversationAsync(
      this.config.appId,
      conversationRef as ConversationReference,
      async (context: TurnContext) => {
        await context.deleteActivity(messageId);
      }
    );
  }

  /**
   * Send a document/file to a conversation
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.adapter || this._status !== 'connected') {
      throw new Error('Teams bot is not connected');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const conversationRef = this.conversationReferences.get(chatId);
    if (!conversationRef) {
      throw new Error(`No conversation reference found for chat: ${chatId}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const base64Content = fileBuffer.toString('base64');
    const contentType = this.getContentType(fileName);

    let lastMessageId = '';

    await this.adapter.continueConversationAsync(
      this.config.appId,
      conversationRef as ConversationReference,
      async (context: TurnContext) => {
        // Create attachment
        const attachment = {
          name: fileName,
          contentType: contentType,
          contentUrl: `data:${contentType};base64,${base64Content}`,
        };

        const activity = MessageFactory.attachment(attachment, caption);
        const response = await context.sendActivity(activity);
        lastMessageId = response?.id || '';
      }
    );

    return lastMessageId;
  }

  /**
   * Get content type from file extension
   */
  private getContentType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.zip': 'application/zip',
    };
    return contentTypes[ext] || 'application/octet-stream';
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
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
   * Get channel info
   */
  async getInfo(): Promise<ChannelInfo> {
    return {
      type: 'teams',
      status: this._status,
      botId: this.config.appId,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
    };
  }

  // Private helper methods

  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (error) {
        console.error('Error in message handler:', error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          'messageHandler'
        );
      }
    }
  }

  private handleError(error: Error, context?: string): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error, context);
      } catch (e) {
        console.error('Error in error handler:', e);
      }
    }
  }

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
}

/**
 * Create a Teams adapter from configuration
 */
export function createTeamsAdapter(config: TeamsConfig): TeamsAdapter {
  if (!config.appId) {
    throw new Error('Microsoft App ID is required');
  }
  if (!config.appPassword) {
    throw new Error('Microsoft App Password is required');
  }
  return new TeamsAdapter(config);
}
