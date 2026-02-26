/**
 * Discord Channel Adapter
 *
 * Implements the ChannelAdapter interface using discord.js for Discord Bot API.
 * Supports slash commands, direct messages, button components, embeds, and threads.
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
  ThreadChannel,
  ChannelType as DiscordChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
  ColorResolvable,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
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
  MessageAttachment,
  CallbackQuery,
  CallbackQueryHandler,
  InlineKeyboardButton,
  Poll,
  SelectMenu,
  SelectMenuHandler,
} from "./types";

/**
 * Embed color constants for different message types
 */
const EMBED_COLORS = {
  pending: 0xffa500 as ColorResolvable, // Orange
  success: 0x57f287 as ColorResolvable, // Green
  error: 0xed4245 as ColorResolvable, // Red
  info: 0x5865f2 as ColorResolvable, // Blue (Discord blurple)
  warning: 0xfee75c as ColorResolvable, // Yellow
  neutral: 0x99aab5 as ColorResolvable, // Gray
} as const;

export class DiscordAdapter implements ChannelAdapter {
  readonly type = "discord" as const;

  private client: Client | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private _botId?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];
  private selectMenuHandlers: SelectMenuHandler[] = [];
  private config: DiscordConfig;

  // Track pending interactions that need reply (chatId -> interaction)
  private pendingInteractions: Map<string, ChatInputCommandInteraction> = new Map();

  // Track thread starters for context (threadId -> starter info)
  private threadStarterCache: Map<
    string,
    { authorId: string; authorName: string; content: string }
  > = new Map();

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
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");

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

        this.setStatus("connected");
      });

      // Handle regular messages (for conversations)
      this.client.on(Events.MessageCreate, async (message) => {
        // Ignore bot messages
        if (message.author.bot) return;

        // Handle DMs and mentions in guilds
        const isDM = message.channel.type === DiscordChannelType.DM;
        const isMentioned = message.mentions.has(this.client!.user!);
        const isThread = message.channel.isThread();

        console.log(
          `Discord message received: isDM=${isDM}, isMentioned=${isMentioned}, isThread=${isThread}, content="${message.content.slice(0, 50)}"`,
        );

        if (isDM || isMentioned) {
          const incomingMessage = this.mapMessageToIncoming(message);
          console.log(
            `Processing Discord message from ${message.author.username}: ${incomingMessage.text.slice(0, 50)}`,
          );
          await this.handleIncomingMessage(incomingMessage);
        }
      });

      // Handle slash command, button, and select menu interactions
      this.client.on(Events.InteractionCreate, async (interaction) => {
        // Handle button interactions
        if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
          return;
        }

        // Handle select menu interactions
        if (interaction.isStringSelectMenu()) {
          await this.handleSelectMenuInteraction(interaction);
          return;
        }

        if (!interaction.isChatInputCommand()) return;

        // Defer the reply FIRST to avoid interaction timeout (Discord requires response within 3 seconds)
        try {
          await interaction.deferReply();
        } catch (error) {
          console.error("Failed to defer reply:", error);
          return;
        }

        // Store the interaction so sendMessage can use editReply for the first response
        if (interaction.channelId) {
          this.pendingInteractions.set(interaction.channelId, interaction);

          // Auto-clear after 14 minutes (interactions expire after 15 minutes)
          setTimeout(
            () => {
              this.pendingInteractions.delete(interaction.channelId!);
            },
            14 * 60 * 1000,
          );
        }

        // Convert slash command to message format
        const incomingMessage = this.mapInteractionToIncoming(interaction);
        await this.handleIncomingMessage(incomingMessage);
      });

      // Handle errors
      this.client.on(Events.Error, (error) => {
        console.error("Discord client error:", error);
        this.handleError(error, "client.error");
      });

      // Login
      await this.client.login(this.config.botToken);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("error", err);
      throw err;
    }
  }

  /**
   * Handle button interaction (callback query equivalent)
   */
  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // Create callback query object matching our interface
    const callbackQuery: CallbackQuery = {
      id: interaction.id,
      userId: interaction.user.id,
      userName: interaction.user.displayName || interaction.user.username,
      chatId: interaction.channelId!,
      messageId: interaction.message.id,
      data: customId,
      threadId: interaction.channel?.isThread() ? interaction.channelId! : undefined,
      raw: interaction,
    };

    // Notify all registered handlers
    for (const handler of this.callbackQueryHandlers) {
      try {
        await handler(callbackQuery);
      } catch (error) {
        console.error("Error in callback query handler:", error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          "callbackQueryHandler",
        );
      }
    }
  }

  /**
   * Register slash commands with Discord
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.user) return;

    const commands = [
      new SlashCommandBuilder().setName("start").setDescription("Start the bot and get help"),
      new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
      new SlashCommandBuilder().setName("workspaces").setDescription("List available workspaces"),
      new SlashCommandBuilder()
        .setName("workspace")
        .setDescription("Select or show current workspace")
        .addStringOption((option) =>
          option.setName("path").setDescription("Workspace path to select").setRequired(false),
        ),
      new SlashCommandBuilder()
        .setName("addworkspace")
        .setDescription("Add a new workspace by path")
        .addStringOption((option) =>
          option.setName("path").setDescription("Path to the workspace folder").setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("newtask")
        .setDescription("Start a fresh task/conversation"),
      new SlashCommandBuilder()
        .setName("provider")
        .setDescription("Change or show current LLM provider")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Provider name (anthropic, gemini, openrouter, bedrock, ollama)")
            .setRequired(false),
        ),
      new SlashCommandBuilder().setName("providers").setDescription("List all available providers"),
      new SlashCommandBuilder().setName("models").setDescription("List available AI models"),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Change or show current model")
        .addStringOption((option) =>
          option.setName("name").setDescription("Model name to use").setRequired(false),
        ),
      new SlashCommandBuilder().setName("status").setDescription("Check bot status"),
      new SlashCommandBuilder().setName("cancel").setDescription("Cancel current task"),
      new SlashCommandBuilder()
        .setName("task")
        .setDescription("Run a task")
        .addStringOption((option) =>
          option.setName("prompt").setDescription("Task description").setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName("pair")
        .setDescription("Pair with a pairing code to gain access")
        .addStringOption((option) =>
          option
            .setName("code")
            .setDescription("The pairing code from CoWork OS app")
            .setRequired(true),
        ),
      new SlashCommandBuilder().setName("approve").setDescription("Approve the pending action"),
      new SlashCommandBuilder().setName("deny").setDescription("Deny the pending action"),
    ];

    const rest = new REST().setToken(this.config.botToken);

    try {
      console.log("Registering Discord slash commands...");

      // Register commands globally or to specific guilds
      if (this.config.guildIds && this.config.guildIds.length > 0) {
        // Register to specific guilds (faster for development)
        for (const guildId of this.config.guildIds) {
          await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guildId), {
            body: commands.map((c) => c.toJSON()),
          });
        }
      } else {
        // Register globally (takes up to 1 hour to propagate)
        await rest.put(Routes.applicationCommands(this.config.applicationId), {
          body: commands.map((c) => c.toJSON()),
        });
      }

      console.log("Discord slash commands registered");
    } catch (error) {
      console.error("Failed to register Discord slash commands:", error);
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
    this.setStatus("disconnected");
  }

  /**
   * Send a message to a Discord channel
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    // Process text for Discord compatibility
    let processedText = message.text;
    if (message.parseMode === "markdown") {
      processedText = this.convertMarkdownForDiscord(message.text);
    }

    // Build button components if inline keyboard is provided
    const components =
      message.inlineKeyboard && message.inlineKeyboard.length > 0
        ? this.buildButtonComponents(message.inlineKeyboard)
        : [];

    // Use smart chunking that preserves code fences
    const chunks = this.splitMessageSmart(processedText, 2000);
    let lastMessageId = "";

    // Check if there's a pending interaction for this chat that needs reply
    const pendingInteraction = this.pendingInteractions.get(message.chatId);

    // Determine target channel (could be a thread)
    let targetChannelId = message.chatId;
    if (message.threadId) {
      targetChannelId = message.threadId;
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isLastChunk = i === chunks.length - 1;

        // Only add buttons to the last chunk
        const chunkComponents = isLastChunk ? components : [];

        // First chunk: use interaction reply if available
        if (i === 0 && pendingInteraction) {
          try {
            const reply = await pendingInteraction.editReply({
              content: chunk,
              components: chunkComponents,
            });
            lastMessageId =
              typeof reply === "object" && "id" in reply ? reply.id : pendingInteraction.id;
            // Clear the pending interaction after first reply
            this.pendingInteractions.delete(message.chatId);
            continue;
          } catch (interactionError) {
            // Interaction may have expired, fall back to channel.send
            console.warn(
              "Interaction reply failed, falling back to channel.send:",
              interactionError,
            );
            this.pendingInteractions.delete(message.chatId);
          }
        }

        // Regular channel message
        const channel = await this.client.channels.fetch(targetChannelId);
        if (!channel || !this.isTextBasedChannel(channel)) {
          throw new Error("Invalid channel or channel is not text-based");
        }

        const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
          content: chunk,
          components: chunkComponents,
          reply: message.replyTo && i === 0 ? { messageReference: message.replyTo } : undefined,
        });
        lastMessageId = sent.id;
      }
    } catch (error: unknown) {
      // If markdown parsing fails, retry without formatting
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("parse") || errorMessage.includes("format")) {
        console.log("Markdown parsing failed, retrying without formatting");
        return this.sendMessagePlain(targetChannelId, message.text, message.replyTo, components);
      }
      throw error;
    }

    return lastMessageId;
  }

  /**
   * Send a message with an embed (rich format)
   */
  async sendEmbed(
    chatId: string,
    options: {
      title?: string;
      description?: string;
      color?: keyof typeof EMBED_COLORS;
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
      footer?: string;
      timestamp?: boolean;
    },
    buttons?: InlineKeyboardButton[][],
  ): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const embed = new EmbedBuilder();

    if (options.title) embed.setTitle(options.title);
    if (options.description) embed.setDescription(options.description);
    if (options.color) embed.setColor(EMBED_COLORS[options.color]);
    if (options.fields) {
      for (const field of options.fields) {
        embed.addFields({ name: field.name, value: field.value, inline: field.inline });
      }
    }
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.timestamp) embed.setTimestamp();

    const components = buttons ? this.buildButtonComponents(buttons) : [];

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
      embeds: [embed],
      components,
    });

    return sent.id;
  }

  /**
   * Build Discord button components from our button format
   */
  private buildButtonComponents(
    buttons: InlineKeyboardButton[][],
  ): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const rowButtons of buttons) {
      if (rowButtons.length === 0) continue;

      const row = new ActionRowBuilder<ButtonBuilder>();
      let buttonCount = 0;

      for (const button of rowButtons) {
        if (buttonCount >= 5) break; // Discord max 5 buttons per row

        const discordButton = new ButtonBuilder().setLabel(button.text.substring(0, 80)); // Discord max 80 chars

        if (button.url) {
          discordButton.setStyle(ButtonStyle.Link);
          discordButton.setURL(button.url);
        } else if (button.callbackData) {
          // Determine button style based on callback data
          if (button.callbackData.startsWith("approve")) {
            discordButton.setStyle(ButtonStyle.Success);
          } else if (button.callbackData.startsWith("deny")) {
            discordButton.setStyle(ButtonStyle.Danger);
          } else {
            discordButton.setStyle(ButtonStyle.Primary);
          }
          discordButton.setCustomId(button.callbackData.substring(0, 100)); // Discord max 100 chars
        } else {
          continue; // Skip buttons without action
        }

        row.addComponents(discordButton);
        buttonCount++;
      }

      if (buttonCount > 0) {
        rows.push(row);
      }

      if (rows.length >= 5) break; // Discord max 5 rows
    }

    return rows;
  }

  /**
   * Send a plain text message without formatting
   */
  private async sendMessagePlain(
    chatId: string,
    text: string,
    replyTo?: string,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
  ): Promise<string> {
    const channel = await this.client!.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const chunks = this.splitMessageSmart(text, 2000);
    let lastMessageId = "";

    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
        content: chunks[i],
        components: isLastChunk ? components : [],
        reply: replyTo && i === 0 ? { messageReference: replyTo } : undefined,
      });
      lastMessageId = sent.id;
    }

    return lastMessageId;
  }

  /**
   * Convert GitHub-flavored markdown to Discord-compatible format
   */
  private convertMarkdownForDiscord(text: string): string {
    let result = text;

    // Convert markdown headers (## Header) to bold (**Header**)
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

    // Convert horizontal rules (---, ***) to a line
    result = result.replace(/^[-*]{3,}$/gm, "───────────────────");

    return result;
  }

  /**
   * Smart message splitting that preserves code fences
   */
  private splitMessageSmart(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;
    let inCodeBlock = false;
    let codeBlockLang = "";

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        // Close any open code block at the end
        if (inCodeBlock) {
          chunks.push(remaining);
        } else {
          chunks.push(remaining);
        }
        break;
      }

      // Find the best breaking point
      let breakIndex = this.findBreakPoint(remaining, maxLength, inCodeBlock);
      let chunk = remaining.substring(0, breakIndex);

      // Check if we're entering or leaving a code block
      const codeBlockMatches = chunk.match(/```(\w*)/g) || [];
      for (const match of codeBlockMatches) {
        if (inCodeBlock) {
          inCodeBlock = false;
          codeBlockLang = "";
        } else {
          inCodeBlock = true;
          codeBlockLang = match.replace("```", "");
        }
      }

      // If we're in a code block and the chunk doesn't close it, close it manually
      if (inCodeBlock && !chunk.endsWith("```")) {
        chunk += "\n```";
      }

      chunks.push(chunk);
      remaining = remaining.substring(breakIndex).trimStart();

      // If we closed a code block, reopen it in the next chunk
      if (inCodeBlock && remaining.length > 0) {
        remaining = "```" + codeBlockLang + "\n" + remaining;
      }
    }

    return chunks;
  }

  /**
   * Find the best break point for message splitting
   */
  private findBreakPoint(text: string, maxLength: number, inCodeBlock: boolean): number {
    // Reserve space for potential code fence closure
    const reservedSpace = inCodeBlock ? 4 : 0;
    const effectiveMax = maxLength - reservedSpace;

    // Try to break at a newline
    let breakIndex = text.lastIndexOf("\n", effectiveMax);
    if (breakIndex > effectiveMax / 2) {
      return breakIndex + 1;
    }

    // Try to break at a space
    breakIndex = text.lastIndexOf(" ", effectiveMax);
    if (breakIndex > effectiveMax / 2) {
      return breakIndex + 1;
    }

    // Force break at max length
    return effectiveMax;
  }

  /**
   * Legacy split method for compatibility
   */
  private splitMessage(text: string, maxLength: number): string[] {
    return this.splitMessageSmart(text, maxLength);
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const message = await (channel as TextChannel | DMChannel | ThreadChannel).messages.fetch(
      messageId,
    );
    await message.edit(text);
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const message = await (channel as TextChannel | DMChannel | ThreadChannel).messages.fetch(
      messageId,
    );
    await message.delete();
  }

  /**
   * Send a document/file to a channel
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const fileName = path.basename(filePath);
    const attachment = new AttachmentBuilder(filePath, { name: fileName });

    const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
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
   * Register a callback query handler (for button interactions)
   */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /**
   * Answer a callback query (acknowledge button press)
   * For Discord, this updates the message or sends an ephemeral response
   */
  async answerCallbackQuery(queryId: string, text?: string, showAlert?: boolean): Promise<void> {
    // In Discord, we need to use the interaction object stored in the raw field
    // The queryId is the interaction ID, but we need the actual interaction object
    // This is typically handled directly in handleButtonInteraction
    // This method provides API compatibility with Telegram
    console.log(`answerCallbackQuery called: ${queryId}, text: ${text}, showAlert: ${showAlert}`);
  }

  /**
   * Edit a message with a new inline keyboard
   */
  async editMessageWithKeyboard(
    chatId: string,
    messageId: string,
    text?: string,
    inlineKeyboard?: InlineKeyboardButton[][],
  ): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const message = await (channel as TextChannel | DMChannel | ThreadChannel).messages.fetch(
      messageId,
    );
    const components = inlineKeyboard ? this.buildButtonComponents(inlineKeyboard) : [];

    await message.edit({
      content: text || message.content,
      components,
    });
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Send typing indicator
   */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    await (channel as TextChannel | DMChannel | ThreadChannel).sendTyping();
  }

  /**
   * Add reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const message = await (channel as TextChannel | DMChannel | ThreadChannel).messages.fetch(
      messageId,
    );
    await message.react(emoji);
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const message = await (channel as TextChannel | DMChannel | ThreadChannel).messages.fetch(
      messageId,
    );
    const reaction = message.reactions.cache.get(emoji);
    if (reaction && this._botId) {
      await reaction.users.remove(this._botId);
    }
  }

  /**
   * Send a poll (Discord native polls)
   */
  async sendPoll(chatId: string, poll: Poll): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    // Discord polls require specific formatting
    const pollData = {
      question: { text: poll.question },
      answers: poll.options.map((opt) => ({ text: opt.text })),
      duration: poll.openPeriod ? Math.ceil(poll.openPeriod / 3600) : 24, // Convert seconds to hours
      allow_multiselect: poll.allowsMultipleAnswers ?? false,
    };

    const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
      poll: pollData as Any,
    });

    return sent.id;
  }

  /**
   * Send a message with a select menu (dropdown)
   */
  async sendWithSelectMenu(chatId: string, text: string, menu: SelectMenu): Promise<string> {
    if (!this.client || this._status !== "connected") {
      throw new Error("Discord bot is not connected");
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !this.isTextBasedChannel(channel)) {
      throw new Error("Invalid channel");
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(menu.customId)
      .setPlaceholder(menu.placeholder || "Select an option")
      .setMinValues(menu.minValues ?? 1)
      .setMaxValues(menu.maxValues ?? 1)
      .addOptions(
        menu.options.map((opt) => ({
          label: opt.label,
          value: opt.value,
          description: opt.description,
          emoji: opt.emoji ? { name: opt.emoji } : undefined,
          default: opt.default,
        })),
      );

    if (menu.disabled) {
      selectMenu.setDisabled(true);
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send({
      content: text,
      components: [row],
    });

    return sent.id;
  }

  /**
   * Register a select menu handler
   */
  onSelectMenu(handler: SelectMenuHandler): void {
    this.selectMenuHandlers.push(handler);
  }

  /**
   * Handle select menu interaction
   */
  private async handleSelectMenuInteraction(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    const customId = interaction.customId;
    const values = interaction.values;

    // Acknowledge the interaction
    try {
      await interaction.deferUpdate();
    } catch (error) {
      console.error("Failed to defer select menu update:", error);
    }

    // Notify all registered handlers
    for (const handler of this.selectMenuHandlers) {
      try {
        await handler(
          customId,
          values,
          interaction.user.id,
          interaction.channelId!,
          interaction.message.id,
          interaction,
        );
      } catch (error) {
        console.error("Error in select menu handler:", error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          "selectMenuHandler",
        );
      }
    }
  }

  // ============================================================================
  // Handler Registration
  // ============================================================================

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
      type: "discord",
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

  private inferAttachmentType(mimeType?: string, fileName?: string): MessageAttachment["type"] {
    const mime = (mimeType || "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "document";

    const ext = (fileName ? path.extname(fileName) : "").toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
    if ([".mp4", ".mov", ".webm", ".mkv"].includes(ext)) return "video";
    if (ext === ".pdf") return "document";

    return "file";
  }

  private extractAttachments(message: Message): MessageAttachment[] | undefined {
    if (!message.attachments || message.attachments.size === 0) return undefined;

    const out: MessageAttachment[] = [];
    for (const att of message.attachments.values()) {
      const url = typeof (att as Any)?.url === "string" ? String((att as Any).url).trim() : "";
      if (!url) continue;

      const fileName = typeof (att as Any)?.name === "string" ? (att as Any).name : undefined;
      const mimeType =
        typeof (att as Any)?.contentType === "string" && (att as Any).contentType.trim().length > 0
          ? (att as Any).contentType.trim()
          : undefined;
      const size = typeof (att as Any)?.size === "number" ? (att as Any).size : undefined;

      out.push({
        type: this.inferAttachmentType(mimeType, fileName),
        url,
        mimeType,
        fileName,
        size,
      });
    }

    return out.length > 0 ? out : undefined;
  }

  private isTextBasedChannel(channel: unknown): channel is TextChannel | DMChannel | ThreadChannel {
    const ch = channel as { type?: DiscordChannelType };
    return (
      ch.type === DiscordChannelType.GuildText ||
      ch.type === DiscordChannelType.DM ||
      ch.type === DiscordChannelType.PublicThread ||
      ch.type === DiscordChannelType.PrivateThread
    );
  }

  private mapMessageToIncoming(message: Message): IncomingMessage {
    // Remove bot mention from the text if present
    let text = message.content;
    if (this._botId) {
      text = text.replace(new RegExp(`<@!?${this._botId}>\\s*`, "g"), "").trim();
    }

    // Map Discord message to command format if it looks like a command
    const commandText = this.parseCommand(text);

    // Check for thread context
    const isThread = message.channel.isThread();
    const threadId = isThread ? message.channelId : undefined;
    const isGroup = message.channel.type !== DiscordChannelType.DM;
    const attachments = this.extractAttachments(message);
    const finalText =
      (commandText || text || "").trim() ||
      (attachments && attachments.length > 0 ? "<attachment>" : "");

    return {
      messageId: message.id,
      channel: "discord",
      userId: message.author.id,
      userName: message.author.displayName || message.author.username,
      chatId: isThread ? (message.channel as ThreadChannel).parentId! : message.channelId,
      isGroup,
      text: finalText,
      timestamp: message.createdAt,
      replyTo: message.reference?.messageId,
      threadId,
      isForumTopic: isThread,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
      case "workspace": {
        const wsPath = options.getString("path");
        if (wsPath) text += ` ${wsPath}`;
        break;
      }
      case "addworkspace": {
        const addPath = options.getString("path");
        if (addPath) text += ` ${addPath}`;
        break;
      }
      case "provider": {
        const provider = options.getString("name");
        if (provider) text += ` ${provider}`;
        break;
      }
      case "model": {
        const model = options.getString("name");
        if (model) text += ` ${model}`;
        break;
      }
      case "task": {
        const prompt = options.getString("prompt");
        if (prompt) text = prompt; // Task prompt becomes the text directly
        break;
      }
      case "pair": {
        const code = options.getString("code");
        if (code) text += ` ${code}`;
        break;
      }
    }

    // Check for thread context
    const isThread = interaction.channel?.isThread() ?? false;
    const isGroup = Boolean(interaction.guildId);

    return {
      messageId: interaction.id,
      channel: "discord",
      userId: interaction.user.id,
      userName: interaction.user.displayName || interaction.user.username,
      chatId: interaction.channelId!,
      isGroup,
      text,
      timestamp: new Date(interaction.createdTimestamp),
      threadId: isThread ? interaction.channelId! : undefined,
      isForumTopic: isThread,
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
        console.error("Error in message handler:", error);
        this.handleError(
          error instanceof Error ? error : new Error(String(error)),
          "messageHandler",
        );
      }
    }
  }

  private handleError(error: Error, context?: string): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error, context);
      } catch (e) {
        console.error("Error in error handler:", e);
      }
    }
  }

  private setStatus(status: ChannelStatus, error?: Error): void {
    this._status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status, error);
      } catch (e) {
        console.error("Error in status handler:", e);
      }
    }
  }
}

/**
 * Create a Discord adapter from configuration
 */
export function createDiscordAdapter(config: DiscordConfig): DiscordAdapter {
  if (!config.botToken) {
    throw new Error("Discord bot token is required");
  }
  if (!config.applicationId) {
    throw new Error("Discord application ID is required");
  }
  return new DiscordAdapter(config);
}
