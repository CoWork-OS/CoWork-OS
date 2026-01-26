/**
 * Discord Channel Adapter
 *
 * Implements the ChannelAdapter interface using discord.js for Discord Bot API.
 * Supports slash commands and direct messages.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  DMChannel,
  ChannelType as DiscordChannelType,
} from 'discord.js';
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
  DiscordConfig,
} from './types';

export class DiscordAdapter implements ChannelAdapter {
  readonly type = 'discord' as const;

  private client: Client | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private _botId?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: DiscordConfig;

  // Track pending interactions that need reply (chatId -> interaction)
  private pendingInteractions: Map<string, ChatInputCommandInteraction> = new Map();

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to Discord
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Create client instance with required intents and partials
      // Partials.Channel is required to receive DM messages
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [
          Partials.Channel, // Required to receive DMs
          Partials.Message, // Required for uncached message events
        ],
      });

      // Set up event handlers
      this.client.once(Events.ClientReady, async (client) => {
        this._botUsername = client.user.username;
        this._botId = client.user.id;
        console.log(`Discord bot @${this._botUsername} is ready`);

        // Register slash commands
        await this.registerSlashCommands();

        this.setStatus('connected');
      });

      // Handle regular messages (for conversations)
      this.client.on(Events.MessageCreate, async (message) => {
        // Ignore bot messages
        if (message.author.bot) return;

        // Handle DMs and mentions in guilds
        const isDM = message.channel.type === DiscordChannelType.DM;
        const isMentioned = message.mentions.has(this.client!.user!);

        console.log(`Discord message received: isDM=${isDM}, isMentioned=${isMentioned}, content="${message.content.slice(0, 50)}"`);

        if (isDM || isMentioned) {
          const incomingMessage = this.mapMessageToIncoming(message);
          console.log(`Processing Discord message from ${message.author.username}: ${incomingMessage.text.slice(0, 50)}`);
          await this.handleIncomingMessage(incomingMessage);
        }
      });

      // Handle slash command interactions
      this.client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        // Defer the reply FIRST to avoid interaction timeout (Discord requires response within 3 seconds)
        try {
          await interaction.deferReply();
        } catch (error) {
          console.error('Failed to defer reply:', error);
          return;
        }

        // Store the interaction so sendMessage can use editReply for the first response
        if (interaction.channelId) {
          this.pendingInteractions.set(interaction.channelId, interaction);

          // Auto-clear after 14 minutes (interactions expire after 15 minutes)
          setTimeout(() => {
            this.pendingInteractions.delete(interaction.channelId!);
          }, 14 * 60 * 1000);
        }

        // Convert slash command to message format
        const incomingMessage = this.mapInteractionToIncoming(interaction);
        await this.handleIncomingMessage(incomingMessage);
      });

      // Handle errors
      this.client.on(Events.Error, (error) => {
        console.error('Discord client error:', error);
        this.handleError(error, 'client.error');
      });

      // Login
      await this.client.login(this.config.botToken);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus('error', err);
      throw err;
    }
  }

  /**
   * Register slash commands with Discord
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.user) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('start')
        .setDescription('Start the bot and get help'),
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands'),
      new SlashCommandBuilder()
        .setName('workspaces')
        .setDescription('List available workspaces'),
      new SlashCommandBuilder()
        .setName('workspace')
        .setDescription('Select or show current workspace')
        .addStringOption(option =>
          option.setName('path')
            .setDescription('Workspace path to select')
            .setRequired(false)),
      new SlashCommandBuilder()
        .setName('addworkspace')
        .setDescription('Add a new workspace by path')
        .addStringOption(option =>
          option.setName('path')
            .setDescription('Path to the workspace folder')
            .setRequired(true)),
      new SlashCommandBuilder()
        .setName('newtask')
        .setDescription('Start a fresh task/conversation'),
      new SlashCommandBuilder()
        .setName('provider')
        .setDescription('Change or show current LLM provider')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Provider name (anthropic, gemini, openrouter, bedrock, ollama)')
            .setRequired(false)),
      new SlashCommandBuilder()
        .setName('models')
        .setDescription('List available AI models'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Change or show current model')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Model name to use')
            .setRequired(false)),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check bot status'),
      new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('Cancel current task'),
      new SlashCommandBuilder()
        .setName('task')
        .setDescription('Run a task')
        .addStringOption(option =>
          option.setName('prompt')
            .setDescription('Task description')
            .setRequired(true)),
      new SlashCommandBuilder()
        .setName('pair')
        .setDescription('Pair with a pairing code to gain access')
        .addStringOption(option =>
          option.setName('code')
            .setDescription('The pairing code from CoWork-OSS app')
            .setRequired(true)),
    ];

    const rest = new REST().setToken(this.config.botToken);

    try {
      console.log('Registering Discord slash commands...');

      // Register commands globally or to specific guilds
      if (this.config.guildIds && this.config.guildIds.length > 0) {
        // Register to specific guilds (faster for development)
        for (const guildId of this.config.guildIds) {
          await rest.put(
            Routes.applicationGuildCommands(this.config.applicationId, guildId),
            { body: commands.map(c => c.toJSON()) }
          );
        }
      } else {
        // Register globally (takes up to 1 hour to propagate)
        await rest.put(
          Routes.applicationCommands(this.config.applicationId),
          { body: commands.map(c => c.toJSON()) }
        );
      }

      console.log('Discord slash commands registered');
    } catch (error) {
      console.error('Failed to register Discord slash commands:', error);
    }
  }

  /**
   * Disconnect from Discord
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this._botUsername = undefined;
    this._botId = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Send a message to a Discord channel
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Discord bot is not connected');
    }

    // Process text for Discord compatibility
    let processedText = message.text;
    if (message.parseMode === 'markdown') {
      processedText = this.convertMarkdownForDiscord(message.text);
    }

    // Discord has a 2000 character limit
    const chunks = this.splitMessage(processedText, 2000);
    let lastMessageId = '';

    // Check if there's a pending interaction for this chat that needs reply
    const pendingInteraction = this.pendingInteractions.get(message.chatId);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // First chunk: use interaction reply if available
        if (i === 0 && pendingInteraction) {
          try {
            const reply = await pendingInteraction.editReply({ content: chunk });
            lastMessageId = typeof reply === 'object' && 'id' in reply ? reply.id : pendingInteraction.id;
            // Clear the pending interaction after first reply
            this.pendingInteractions.delete(message.chatId);
            continue;
          } catch (interactionError) {
            // Interaction may have expired, fall back to channel.send
            console.warn('Interaction reply failed, falling back to channel.send:', interactionError);
            this.pendingInteractions.delete(message.chatId);
          }
        }

        // Regular channel message
        const channel = await this.client.channels.fetch(message.chatId);
        if (!channel || !this.isTextBasedChannel(channel)) {
          throw new Error('Invalid channel or channel is not text-based');
        }

        const sent = await (channel as TextChannel | DMChannel).send({
          content: chunk,
          reply: message.replyTo && i === 0 ? { messageReference: message.replyTo } : undefined,
        });
        lastMessageId = sent.id;
      }
    } catch (error: unknown) {
      // If markdown parsing fails, retry without formatting (like Telegram)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('parse') || errorMessage.includes('format')) {
        console.log('Markdown parsing failed, retrying without formatting');
        return this.sendMessagePlain(message.chatId, message.text, message.replyTo);
      }
      throw error;
    }

    return lastMessageId;
  }

  /**
   * Send a plain text message without formatting
   */
  private async sendMessagePlain(chatId: string, text: string, replyTo?: string): Promise<string> {
    const channel = await this.client!.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error('Invalid channel');
    }

    const chunks = this.splitMessage(text, 2000);
    let lastMessageId = '';

    for (let i = 0; i < chunks.length; i++) {
      const sent = await (channel as TextChannel | DMChannel).send({
        content: chunks[i],
        reply: replyTo && i === 0 ? { messageReference: replyTo } : undefined,
      });
      lastMessageId = sent.id;
    }

    return lastMessageId;
  }

  /**
   * Convert GitHub-flavored markdown to Discord-compatible format
   * Discord supports: **bold**, *italic*, __underline__, ~~strikethrough~~, `code`, ```code blocks```, > quotes, [links](url)
   */
  private convertMarkdownForDiscord(text: string): string {
    let result = text;

    // Discord already supports most markdown, but we can adjust headers
    // Convert markdown headers (## Header) to bold (**Header**)
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');

    // Convert horizontal rules (---, ***) to a line
    result = result.replace(/^[-*]{3,}$/gm, '───────────────────');

    return result;
  }

  /**
   * Split message into chunks respecting Discord's character limit
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
    if (!this.client || this._status !== 'connected') {
      throw new Error('Discord bot is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error('Invalid channel');
    }

    const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
    await message.edit(text);
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Discord bot is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error('Invalid channel');
    }

    const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
    await message.delete();
  }

  /**
   * Send a document/file to a channel
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== 'connected') {
      throw new Error('Discord bot is not connected');
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error('Invalid channel');
    }

    const fileName = path.basename(filePath);
    const attachment = new AttachmentBuilder(filePath, { name: fileName });

    const sent = await (channel as TextChannel | DMChannel).send({
      content: caption,
      files: [attachment],
    });

    return sent.id;
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
      type: 'discord',
      status: this._status,
      botId: this._botId,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
      extra: {
        applicationId: this.config.applicationId,
        guildIds: this.config.guildIds,
      },
    };
  }

  // Private methods

  private isTextBasedChannel(channel: any): channel is TextChannel | DMChannel {
    return channel.type === DiscordChannelType.GuildText ||
           channel.type === DiscordChannelType.DM;
  }

  private mapMessageToIncoming(message: Message): IncomingMessage {
    // Remove bot mention from the text if present
    let text = message.content;
    if (this._botId) {
      text = text.replace(new RegExp(`<@!?${this._botId}>\\s*`, 'g'), '').trim();
    }

    // Map Discord message to command format if it looks like a command
    const commandText = this.parseCommand(text);

    return {
      messageId: message.id,
      channel: 'discord',
      userId: message.author.id,
      userName: message.author.displayName || message.author.username,
      chatId: message.channelId,
      text: commandText || text,
      timestamp: message.createdAt,
      replyTo: message.reference?.messageId,
      raw: message,
    };
  }

  private mapInteractionToIncoming(interaction: ChatInputCommandInteraction): IncomingMessage {
    const commandName = interaction.commandName;
    let text = `/${commandName}`;

    // Add options to the command text
    const options = interaction.options;

    // Handle specific commands with their options
    switch (commandName) {
      case 'workspace': {
        const wsPath = options.getString('path');
        if (wsPath) text += ` ${wsPath}`;
        break;
      }
      case 'addworkspace': {
        const addPath = options.getString('path');
        if (addPath) text += ` ${addPath}`;
        break;
      }
      case 'provider': {
        const provider = options.getString('name');
        if (provider) text += ` ${provider}`;
        break;
      }
      case 'model': {
        const model = options.getString('name');
        if (model) text += ` ${model}`;
        break;
      }
      case 'task': {
        const prompt = options.getString('prompt');
        if (prompt) text = prompt; // Task prompt becomes the text directly
        break;
      }
      case 'pair': {
        const code = options.getString('code');
        if (code) text += ` ${code}`;
        break;
      }
    }

    // Note: deferReply and pendingInteractions are handled in the event handler before this is called

    return {
      messageId: interaction.id,
      channel: 'discord',
      userId: interaction.user.id,
      userName: interaction.user.displayName || interaction.user.username,
      chatId: interaction.channelId!,
      text,
      timestamp: new Date(interaction.createdTimestamp),
      raw: interaction,
    };
  }

  /**
   * Parse text to see if it's a command (starts with /)
   */
  private parseCommand(text: string): string | null {
    // Check if text starts with a command
    const commandMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (commandMatch) {
      return text; // Already in command format
    }
    return null;
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
 * Create a Discord adapter from configuration
 */
export function createDiscordAdapter(config: DiscordConfig): DiscordAdapter {
  if (!config.botToken) {
    throw new Error('Discord bot token is required');
  }
  if (!config.applicationId) {
    throw new Error('Discord application ID is required');
  }
  return new DiscordAdapter(config);
}
