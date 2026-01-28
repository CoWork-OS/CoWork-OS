/**
 * Telegram Channel Adapter
 *
 * Implements the ChannelAdapter interface using grammY for Telegram Bot API.
 * Supports both polling and webhook modes.
 */

import { Bot, Context, webhookCallback, InputFile } from 'grammy';
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
  TelegramConfig,
  MessageAttachment,
} from './types';

export class TelegramAdapter implements ChannelAdapter {
  readonly type = 'telegram' as const;

  private bot: Bot | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to Telegram using long polling
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create bot instance
      this.bot = new Bot(this.config.botToken);

      // Get bot info
      const me = await this.bot.api.getMe();
      this._botUsername = me.username;

      // Register bot commands for the "/" menu
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Start the bot' },
        { command: 'help', description: 'Show available commands' },
        { command: 'workspaces', description: 'List available workspaces' },
        { command: 'workspace', description: 'Select or show current workspace' },
        { command: 'addworkspace', description: 'Add a new workspace by path' },
        { command: 'newtask', description: 'Start a fresh task/conversation' },
        { command: 'provider', description: 'Change or show current LLM provider' },
        { command: 'models', description: 'List available AI models' },
        { command: 'model', description: 'Change or show current model' },
        { command: 'status', description: 'Check bot status' },
        { command: 'cancel', description: 'Cancel current task' },
      ]);

      // Set up message handler
      this.bot.on('message:text', async (ctx) => {
        const message = this.mapContextToMessage(ctx);
        await this.handleIncomingMessage(message);
      });

      // Handle errors
      this.bot.catch((err) => {
        console.error('Telegram bot error:', err);
        this.handleError(err instanceof Error ? err : new Error(String(err)), 'bot.catch');
      });

      // Start polling
      this.bot.start({
        onStart: () => {
          console.log(`Telegram bot @${this._botUsername} started`);
          this.setStatus('connected');
        },
        drop_pending_updates: true,
        allowed_updates: ['message'] as const,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Disconnect from Telegram
   */
  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this._botUsername = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Send a message to a Telegram chat
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.bot || this._status !== 'connected') {
      throw new Error('Telegram bot is not connected');
    }

    // Handle image attachments first (send images before text)
    let lastMessageId: string | undefined;
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        if (attachment.type === 'image' && attachment.url) {
          try {
            // attachment.url is the file path for local images
            const msgId = await this.sendPhoto(message.chatId, attachment.url);
            lastMessageId = msgId;
          } catch (err) {
            console.error('Failed to send image attachment:', err);
          }
        }
      }
    }

    // If we have text to send, send it
    if (message.text && message.text.trim()) {
      // Process text for Telegram compatibility
      let processedText = message.text;
      if (message.parseMode === 'markdown') {
        processedText = this.convertMarkdownForTelegram(message.text);
      }

      const options: Record<string, unknown> = {};

      // Set parse mode
      // Use legacy Markdown (not MarkdownV2) to avoid escaping issues with special characters
      if (message.parseMode === 'markdown') {
        options.parse_mode = 'Markdown';
      } else if (message.parseMode === 'html') {
        options.parse_mode = 'HTML';
      }

      // Reply to message if specified
      if (message.replyTo) {
        options.reply_to_message_id = parseInt(message.replyTo, 10);
      }

      try {
        const sent = await this.bot.api.sendMessage(message.chatId, processedText, options);
        return sent.message_id.toString();
      } catch (error: any) {
        // If markdown parsing fails, retry without parse_mode
        if (error?.error_code === 400 && error?.description?.includes("can't parse entities")) {
          console.log('Markdown parsing failed, retrying without parse_mode');
          const plainOptions: Record<string, unknown> = {};
          if (message.replyTo) {
            plainOptions.reply_to_message_id = parseInt(message.replyTo, 10);
          }
          const sent = await this.bot.api.sendMessage(message.chatId, message.text, plainOptions);
          return sent.message_id.toString();
        }
        throw error;
      }
    }

    // If no text but had attachments, return the last attachment message ID
    return lastMessageId || '';
  }

  /**
   * Convert GitHub-flavored markdown to Telegram-compatible format
   * Telegram legacy Markdown only supports: *bold*, _italic_, `code`, ```code blocks```, [links](url)
   */
  private convertMarkdownForTelegram(text: string): string {
    let result = text;

    // Convert markdown headers (## Header) to bold (*Header*)
    // Must be done before ** conversion
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Convert markdown tables to code blocks
    // Tables start with | and have a separator line like |---|---|
    const tableRegex = /(\|[^\n]+\|\n)+/g;
    const hasSeparatorLine = /\|[\s-:]+\|/;

    result = result.replace(tableRegex, (match) => {
      // Check if this looks like a table (has separator line with dashes)
      if (hasSeparatorLine.test(match)) {
        // Convert table to code block for monospace display
        // Remove the separator line (|---|---|) as it's just formatting
        const lines = match.split('\n').filter(line => line.trim());
        const cleanedLines = lines.filter(line => !(/^\|[\s-:]+\|$/.test(line.trim())));

        // Format table nicely
        const formattedTable = cleanedLines.map(line => {
          // Remove leading/trailing pipes and clean up
          return line.replace(/^\||\|$/g, '').trim();
        }).join('\n');

        return '```\n' + formattedTable + '\n```\n';
      }
      return match;
    });

    // Convert **bold** to *bold* (Telegram uses single asterisk)
    result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');

    // Convert __bold__ to *bold* (alternative bold syntax)
    result = result.replace(/__([^_]+)__/g, '*$1*');

    // Convert horizontal rules (---, ***) to a line
    result = result.replace(/^[-*]{3,}$/gm, '─────────────────');

    return result;
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot || this._status !== 'connected') {
      throw new Error('Telegram bot is not connected');
    }

    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId)) {
      throw new Error(`Invalid message ID: ${messageId}`);
    }

    await this.bot.api.editMessageText(chatId, msgId, text);
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.bot || this._status !== 'connected') {
      throw new Error('Telegram bot is not connected');
    }

    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId)) {
      throw new Error(`Invalid message ID: ${messageId}`);
    }

    await this.bot.api.deleteMessage(chatId, msgId);
  }

  /**
   * Send a document/file to a chat
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.bot || this._status !== 'connected') {
      throw new Error('Telegram bot is not connected');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const sent = await this.bot.api.sendDocument(
      chatId,
      new InputFile(fileBuffer, fileName),
      { caption }
    );

    return sent.message_id.toString();
  }

  /**
   * Send a photo/image to a chat
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.bot || this._status !== 'connected') {
      throw new Error('Telegram bot is not connected');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const sent = await this.bot.api.sendPhoto(
      chatId,
      new InputFile(fileBuffer, fileName),
      { caption }
    );

    return sent.message_id.toString();
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
    let botId: string | undefined;
    let botDisplayName: string | undefined;

    if (this.bot && this._status === 'connected') {
      try {
        const me = await this.bot.api.getMe();
        botId = me.id.toString();
        botDisplayName = me.first_name;
        this._botUsername = me.username;
      } catch {
        // Ignore errors getting info
      }
    }

    return {
      type: 'telegram',
      status: this._status,
      botId,
      botUsername: this._botUsername,
      botDisplayName,
    };
  }

  /**
   * Get webhook callback for Express/Fastify/etc.
   * Use this when running in webhook mode instead of polling.
   */
  getWebhookCallback(): (req: Request, res: Response) => Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized');
    }
    return webhookCallback(this.bot, 'express') as unknown as (req: Request, res: Response) => Promise<void>;
  }

  /**
   * Set webhook URL
   */
  async setWebhook(url: string, secretToken?: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized');
    }

    await this.bot.api.setWebhook(url, {
      secret_token: secretToken,
      allowed_updates: ['message'] as const,
    });
  }

  /**
   * Remove webhook
   */
  async deleteWebhook(): Promise<void> {
    if (!this.bot) {
      throw new Error('Bot not initialized');
    }

    await this.bot.api.deleteWebhook();
  }

  // Private methods

  private mapContextToMessage(ctx: Context): IncomingMessage {
    const msg = ctx.message!;
    const from = msg.from!;
    const chat = msg.chat;

    return {
      messageId: msg.message_id.toString(),
      channel: 'telegram',
      userId: from.id.toString(),
      userName: from.first_name + (from.last_name ? ` ${from.last_name}` : ''),
      chatId: chat.id.toString(),
      text: msg.text || '',
      timestamp: new Date(msg.date * 1000),
      replyTo: msg.reply_to_message?.message_id.toString(),
      raw: ctx,
    };
  }

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
 * Create a Telegram adapter from configuration
 */
export function createTelegramAdapter(config: TelegramConfig): TelegramAdapter {
  if (!config.botToken) {
    throw new Error('Telegram bot token is required');
  }
  return new TelegramAdapter(config);
}
