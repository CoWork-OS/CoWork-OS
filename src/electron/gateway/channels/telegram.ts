/**
 * Telegram Channel Adapter
 *
 * Implements the ChannelAdapter interface using grammY for Telegram Bot API.
 * Supports both polling and webhook modes.
 *
 * Features:
 * - API throttling to prevent rate limits
 * - Message deduplication to prevent double processing
 * - Text fragment assembly for split long messages
 * - ACK reactions while processing
 * - Draft streaming for real-time response preview
 * - Sequential message processing to prevent race conditions
 * - Connection conflict detection (409 errors)
 * - Exponential backoff with jitter for error recovery
 * - Health check endpoint for webhook mode
 */

import {
  Bot,
  Context,
  webhookCallback,
  InputFile,
  GrammyError,
  HttpError,
  InlineKeyboard,
} from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
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
  CallbackQuery,
  CallbackQueryHandler,
  InlineKeyboardButton,
  Poll,
  ReplyKeyboard,
} from "./types";

/**
 * Exponential backoff configuration
 */
export interface BackoffConfig {
  /** Initial delay in ms (default: 2000) */
  initialDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
  /** Backoff multiplier (default: 1.8) */
  multiplier?: number;
  /** Jitter percentage 0-1 (default: 0.25) */
  jitter?: number;
  /** Maximum retry attempts before giving up (default: 10) */
  maxAttempts?: number;
}

/**
 * Webhook server configuration
 */
export interface WebhookServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Secret token for webhook validation */
  secretToken?: string;
  /** Path for webhook endpoint (default: '/webhook') */
  webhookPath?: string;
  /** Path for health check (default: '/healthz') */
  healthPath?: string;
}

/**
 * Extended Telegram configuration with new features
 */
export interface TelegramAdapterConfig extends TelegramConfig {
  /** Enable ACK reaction (👀) while processing messages */
  ackReactionEnabled?: boolean;
  /** Enable draft streaming for real-time response preview */
  draftStreamingEnabled?: boolean;
  /** Text fragment assembly timeout in ms (default: 1500) */
  fragmentAssemblyTimeout?: number;
  /** Enable message deduplication (default: true) */
  deduplicationEnabled?: boolean;
  /** Enable sequential message processing (default: true) */
  sequentialProcessingEnabled?: boolean;
  /** Exponential backoff configuration */
  backoff?: BackoffConfig;
  /** Webhook server configuration (if using webhook mode) */
  webhookServer?: WebhookServerConfig;
}

/**
 * Pending text fragment for assembly
 */
interface TextFragment {
  chatId: string;
  userId: string;
  messages: Array<{
    messageId: string;
    text: string;
    timestamp: Date;
    ctx: Context;
  }>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Draft message state for streaming
 */
interface DraftState {
  chatId: string;
  messageId?: string;
  currentText: string;
  lastUpdateTime: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;

  private bot: Bot | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];
  private config: TelegramAdapterConfig;

  // Message deduplication: track processed update IDs
  private processedUpdates: Map<number, number> = new Map(); // updateId -> timestamp
  private readonly DEDUP_CACHE_TTL = 60000; // 1 minute
  private readonly DEDUP_CACHE_MAX_SIZE = 1000;
  private dedupCleanupTimer?: ReturnType<typeof setTimeout>;

  // Text fragment assembly: buffer split messages
  private pendingFragments: Map<string, TextFragment> = new Map(); // chatId:userId -> fragment
  private readonly DEFAULT_FRAGMENT_TIMEOUT = 1500; // 1.5 seconds

  // Draft streaming state
  private draftStates: Map<string, DraftState> = new Map(); // chatId -> draft state
  private readonly DRAFT_UPDATE_INTERVAL = 500; // Update draft every 500ms

  // Exponential backoff state
  private backoffAttempt = 0;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private isReconnecting = false;

  // Webhook server
  private webhookServer?: http.Server;

  // Default backoff configuration
  private readonly DEFAULT_BACKOFF: Required<BackoffConfig> = {
    initialDelay: 2000,
    maxDelay: 30000,
    multiplier: 1.8,
    jitter: 0.25,
    maxAttempts: 10,
  };

  constructor(config: TelegramAdapterConfig) {
    this.config = {
      deduplicationEnabled: true,
      ackReactionEnabled: true,
      draftStreamingEnabled: true,
      fragmentAssemblyTimeout: 1500,
      sequentialProcessingEnabled: true,
      ...config,
    };
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
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");
    this.resetBackoff();

    try {
      // Create bot instance
      this.bot = new Bot(this.config.botToken);

      // Add API throttling to prevent rate limits
      const throttler = apiThrottler();
      this.bot.api.config.use(throttler);

      // Add sequential processing to prevent race conditions
      if (this.config.sequentialProcessingEnabled) {
        this.bot.use(sequentialize(this.getSequentialKey));
      }

      // Get bot info
      const me = await this.bot.api.getMe();
      this._botUsername = me.username;

      // Register expanded bot commands for the "/" menu
      await this.registerBotCommands();

      // Set up message handler with deduplication and fragment assembly
      // Note: we listen to all messages so photo/voice/document attachments can be handled.
      this.bot.on("message", async (ctx) => {
        const msg = ctx.message as Any;
        const from = msg?.from;
        if (!from || from.is_bot) return;

        if (typeof msg.text === "string" && String(msg.text).length > 0) {
          await this.handleTextMessage(ctx);
          return;
        }
        await this.handleNonTextMessage(ctx);
      });

      // Set up callback query handler for inline keyboards
      this.bot.on("callback_query:data", async (ctx) => {
        await this.handleCallbackQuery(ctx);
      });

      // Handle errors with 409 detection and backoff
      this.bot.catch(async (err) => {
        await this.handleBotError(err);
      });

      // Start deduplication cleanup timer
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      // Start polling with error handling
      await this.startPolling();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Check for connection conflict (409) during initial connection
      if (this.isConnectionConflictError(error)) {
        console.error("Connection conflict detected: Another bot instance is running");
        this.setStatus(
          "error",
          new Error(
            "Connection conflict: Another bot instance is running. Stop the other instance first.",
          ),
        );
        throw new Error("Connection conflict: Another bot instance is running");
      }

      this.setStatus("error", err);
      throw err;
    }
  }

  /**
   * Get sequential key for message ordering
   * Messages from the same chat are processed sequentially
   */
  private getSequentialKey = (ctx: Context): string | undefined => {
    const chatId = ctx.chat?.id;
    if (!chatId) return undefined;

    // Use chat ID + thread ID for forum topics
    const threadId = ctx.message?.message_thread_id;
    if (threadId) {
      return `${chatId}:${threadId}`;
    }

    return String(chatId);
  };

  /**
   * Register bot commands for the "/" menu
   */
  private async registerBotCommands(): Promise<void> {
    if (!this.bot) return;

    await this.bot.api.setMyCommands([
      // Core commands
      { command: "start", description: "Start the bot and see welcome message" },
      { command: "help", description: "Show all available commands" },
      { command: "status", description: "Check bot connection and system status" },

      // Workspace management
      { command: "workspaces", description: "List all available workspaces" },
      { command: "workspace", description: "Select or show current workspace" },
      { command: "addworkspace", description: "Add a new workspace by path" },
      { command: "removeworkspace", description: "Remove a workspace from the list" },

      // Task management
      { command: "newtask", description: "Start a fresh task/conversation" },
      { command: "cancel", description: "Cancel the current running task" },
      { command: "retry", description: "Retry the last failed task" },
      { command: "history", description: "Show recent task history" },

      // Model configuration
      { command: "provider", description: "Change or show current LLM provider" },
      { command: "providers", description: "List all available LLM providers" },
      { command: "model", description: "Change or show current model" },
      { command: "models", description: "List available AI models" },

      // Skills management
      { command: "skills", description: "List available skills" },
      { command: "skill", description: "Enable or disable a skill" },

      // Settings
      { command: "settings", description: "View and modify bot settings" },
      { command: "debug", description: "Toggle debug mode on/off" },
      { command: "version", description: "Show bot version information" },
    ]);
  }

  /**
   * Start polling with error handling and reconnection
   */
  private async startPolling(): Promise<void> {
    if (!this.bot) return;

    this.bot.start({
      onStart: () => {
        console.log(`Telegram bot @${this._botUsername} started`);
        this.setStatus("connected");
        this.resetBackoff();
      },
      drop_pending_updates: true,
      allowed_updates: ["message", "message_reaction", "callback_query"] as const,
    });
  }

  /**
   * Handle bot errors including 409 conflict detection
   */
  private async handleBotError(err: unknown): Promise<void> {
    console.error("Telegram bot error:", err);

    // Check for connection conflict (409)
    if (this.isConnectionConflictError(err)) {
      console.error("Connection conflict detected (409): Another bot instance may be running");
      this.setStatus("error", new Error("Connection conflict: Another bot instance is running"));

      // Don't reconnect on 409 - let the user resolve the conflict
      this.handleError(
        new Error(
          "Connection conflict: Another bot instance is running. Stop the other instance and restart.",
        ),
        "connection_conflict",
      );
      return;
    }

    // Check for network errors that warrant reconnection
    if (this.isNetworkError(err)) {
      console.log("Network error detected, will attempt reconnection with backoff");
      await this.attemptReconnection();
      return;
    }

    // Handle other errors normally
    this.handleError(err instanceof Error ? err : new Error(String(err)), "bot.catch");
  }

  /**
   * Check if error is a connection conflict (409)
   */
  private isConnectionConflictError(err: unknown): boolean {
    if (err instanceof GrammyError) {
      return err.error_code === 409;
    }
    if (err instanceof HttpError) {
      return (err as HttpError & { status?: number }).status === 409;
    }
    // Check error message for 409 indicators
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("409") ||
      message.includes("Conflict") ||
      message.includes("terminated by other getUpdates")
    );
  }

  /**
   * Check if error is a network error that warrants reconnection
   */
  private isNetworkError(err: unknown): boolean {
    if (err instanceof HttpError) {
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("ECONNRESET") ||
      message.includes("ETIMEDOUT") ||
      message.includes("ENOTFOUND") ||
      message.includes("network") ||
      message.includes("socket") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504")
    );
  }

  /**
   * Attempt reconnection with exponential backoff
   */
  private async attemptReconnection(): Promise<void> {
    if (this.isReconnecting) {
      console.log("Reconnection already in progress");
      return;
    }

    const backoffConfig = { ...this.DEFAULT_BACKOFF, ...this.config.backoff };

    if (this.backoffAttempt >= backoffConfig.maxAttempts) {
      console.error(`Max reconnection attempts (${backoffConfig.maxAttempts}) reached`);
      this.setStatus("error", new Error("Max reconnection attempts reached"));
      this.handleError(
        new Error("Failed to reconnect after maximum attempts"),
        "reconnection_failed",
      );
      return;
    }

    this.isReconnecting = true;
    this.backoffAttempt++;

    const delay = this.calculateBackoffDelay(backoffConfig);
    console.log(
      `Reconnection attempt ${this.backoffAttempt}/${backoffConfig.maxAttempts} in ${delay}ms`,
    );

    this.backoffTimer = setTimeout(async () => {
      try {
        // Stop existing bot if any
        if (this.bot) {
          await this.bot.stop();
          this.bot = null;
        }

        this.isReconnecting = false;
        this.setStatus("disconnected");

        // Attempt to reconnect
        await this.connect();
      } catch (error) {
        this.isReconnecting = false;
        console.error("Reconnection attempt failed:", error);

        // Schedule next attempt if not a 409 conflict
        if (!this.isConnectionConflictError(error)) {
          await this.attemptReconnection();
        }
      }
    }, delay);
  }

  /**
   * Calculate backoff delay with jitter
   */
  private calculateBackoffDelay(config: Required<BackoffConfig>): number {
    // Calculate base delay: initialDelay * multiplier^attempt
    let delay = config.initialDelay * Math.pow(config.multiplier, this.backoffAttempt - 1);

    // Cap at max delay
    delay = Math.min(delay, config.maxDelay);

    // Add jitter: delay ± (delay * jitter * random)
    const jitterAmount = delay * config.jitter;
    const jitter = (Math.random() * 2 - 1) * jitterAmount; // Random between -jitterAmount and +jitterAmount
    delay = Math.round(delay + jitter);

    // Ensure minimum delay of 1 second
    return Math.max(1000, delay);
  }

  /**
   * Reset backoff state
   */
  private resetBackoff(): void {
    this.backoffAttempt = 0;
    this.isReconnecting = false;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /**
   * Handle incoming text message with deduplication and fragment assembly
   */
  private async handleTextMessage(ctx: Context): Promise<void> {
    const msg = ctx.message!;
    const updateId = ctx.update.update_id;

    if (!this.shouldProcessUpdate(updateId)) return;

    // Feature 3: Text fragment assembly - buffer split messages
    const fragmentKey = `${msg.chat.id}:${msg.from!.id}`;
    const existingFragment = this.pendingFragments.get(fragmentKey);

    if (existingFragment) {
      // Add to existing fragment
      clearTimeout(existingFragment.timer);
      existingFragment.messages.push({
        messageId: msg.message_id.toString(),
        text: msg.text || "",
        timestamp: new Date(msg.date * 1000),
        ctx,
      });

      // Reset timer
      existingFragment.timer = setTimeout(() => {
        this.processFragments(fragmentKey);
      }, this.config.fragmentAssemblyTimeout || this.DEFAULT_FRAGMENT_TIMEOUT);
    } else {
      // Check if this might be a split message (long text arriving in chunks)
      // Telegram splits messages at ~4096 chars, so check if message ends mid-sentence
      const mightBeSplit = this.mightBeSplitMessage(msg.text || "");

      if (mightBeSplit) {
        // Start new fragment buffer
        const timer = setTimeout(() => {
          this.processFragments(fragmentKey);
        }, this.config.fragmentAssemblyTimeout || this.DEFAULT_FRAGMENT_TIMEOUT);

        this.pendingFragments.set(fragmentKey, {
          chatId: msg.chat.id.toString(),
          userId: msg.from!.id.toString(),
          messages: [
            {
              messageId: msg.message_id.toString(),
              text: msg.text || "",
              timestamp: new Date(msg.date * 1000),
              ctx,
            },
          ],
          timer,
        });
      } else {
        // Process immediately (single message)
        await this.processMessage(ctx);
      }
    }
  }

  private shouldProcessUpdate(updateId: number): boolean {
    if (!this.config.deduplicationEnabled) return true;
    if (this.isUpdateProcessed(updateId)) {
      console.log(`Skipping duplicate update ${updateId}`);
      return false;
    }
    this.markUpdateProcessed(updateId);
    return true;
  }

  private async handleNonTextMessage(ctx: Context): Promise<void> {
    const updateId = ctx.update.update_id;
    if (!this.shouldProcessUpdate(updateId)) return;

    const msg = ctx.message as Any;
    if (!msg) return;

    const hasMedia =
      (Array.isArray(msg.photo) && msg.photo.length > 0) ||
      !!msg.document ||
      !!msg.voice ||
      !!msg.audio ||
      !!msg.video ||
      !!msg.animation ||
      !!msg.video_note;

    // Ignore non-text messages we do not currently support (joins/leaves/pins/etc).
    if (!hasMedia) return;

    await this.processMessage(ctx);
  }

  /**
   * Check if a message might be part of a split message
   */
  private mightBeSplitMessage(text: string): boolean {
    // Messages near Telegram's limit or ending abruptly might be split
    if (text.length >= 4000) return true;

    // Check if text ends mid-sentence (no terminal punctuation)
    const trimmed = text.trim();
    if (trimmed.length > 100) {
      const lastChar = trimmed.charAt(trimmed.length - 1);
      const terminalPunctuation = [".", "!", "?", ")", "]", "}", '"', "'", "`"];
      if (!terminalPunctuation.includes(lastChar)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Process assembled fragments
   */
  private async processFragments(fragmentKey: string): Promise<void> {
    const fragment = this.pendingFragments.get(fragmentKey);
    if (!fragment) return;

    this.pendingFragments.delete(fragmentKey);

    if (fragment.messages.length === 1) {
      // Single message, process normally
      await this.processMessage(fragment.messages[0].ctx);
    } else {
      // Multiple messages, combine them
      const combinedText = fragment.messages
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .map((m) => m.text)
        .join("");

      // Use the first message's context but with combined text
      const firstCtx = fragment.messages[0].ctx;
      const message = await this.mapContextToMessage(firstCtx, combinedText);

      console.log(
        `Assembled ${fragment.messages.length} text fragments into single message (${combinedText.length} chars)`,
      );

      await this.handleIncomingMessage(message);
    }
  }

  /**
   * Process a single message (with ACK reaction)
   */
  private async processMessage(ctx: Context): Promise<void> {
    // Feature 2: Send ACK reaction (👀) while processing
    if (this.config.ackReactionEnabled) {
      try {
        await this.sendAckReaction(ctx);
      } catch (err) {
        // Ignore reaction errors (might not have permission)
        console.debug("Could not send ACK reaction:", err);
      }
    }

    const message = await this.mapContextToMessage(ctx);
    await this.handleIncomingMessage(message);
  }

  /**
   * Send ACK reaction (👀) to indicate message received
   */
  private async sendAckReaction(ctx: Context): Promise<void> {
    if (!this.bot || !ctx.message) return;

    try {
      await this.bot.api.setMessageReaction(ctx.message.chat.id, ctx.message.message_id, [
        { type: "emoji", emoji: "👀" },
      ]);
    } catch {
      // Silently fail - reactions might not be available
    }
  }

  /**
   * Remove ACK reaction after processing
   */
  async removeAckReaction(chatId: string, messageId: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.api.setMessageReaction(
        chatId,
        parseInt(messageId, 10),
        [], // Empty array removes reactions
      );
    } catch {
      // Silently fail
    }
  }

  /**
   * Send a completion reaction when done
   * Note: Telegram only allows specific reaction emojis, using 👍 for completion
   */
  async sendCompletionReaction(chatId: string, messageId: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.api.setMessageReaction(chatId, parseInt(messageId, 10), [
        { type: "emoji", emoji: "👍" },
      ]);
    } catch {
      // Silently fail
    }
  }

  /**
   * Check if update was already processed (deduplication)
   */
  private isUpdateProcessed(updateId: number): boolean {
    return this.processedUpdates.has(updateId);
  }

  /**
   * Mark update as processed
   */
  private markUpdateProcessed(updateId: number): void {
    this.processedUpdates.set(updateId, Date.now());

    // Prevent unbounded growth
    if (this.processedUpdates.size > this.DEDUP_CACHE_MAX_SIZE) {
      this.cleanupDedupCache();
    }
  }

  /**
   * Start periodic cleanup of dedup cache
   */
  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      this.cleanupDedupCache();
    }, this.DEDUP_CACHE_TTL);
  }

  /**
   * Clean up old entries from dedup cache
   */
  private cleanupDedupCache(): void {
    const now = Date.now();
    for (const [updateId, timestamp] of this.processedUpdates) {
      if (now - timestamp > this.DEDUP_CACHE_TTL) {
        this.processedUpdates.delete(updateId);
      }
    }
  }

  /**
   * Disconnect from Telegram
   */
  async disconnect(): Promise<void> {
    // Reset backoff state
    this.resetBackoff();

    // Clear timers
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = undefined;
    }

    // Clear pending fragments
    for (const fragment of this.pendingFragments.values()) {
      clearTimeout(fragment.timer);
    }
    this.pendingFragments.clear();

    // Clear draft states
    this.draftStates.clear();

    // Clear dedup cache
    this.processedUpdates.clear();

    // Stop webhook server if running
    if (this.webhookServer) {
      await this.stopWebhookServer();
    }

    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this._botUsername = undefined;
    this.setStatus("disconnected");
  }

  /**
   * Send a message to a Telegram chat
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    // Handle image attachments first (send images before text)
    let lastMessageId: string | undefined;
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        if (attachment.type === "image" && attachment.url) {
          try {
            // attachment.url is the file path for local images
            const msgId = await this.sendPhoto(message.chatId, attachment.url);
            lastMessageId = msgId;
          } catch (err) {
            console.error("Failed to send image attachment:", err);
          }
        }
      }
    }

    // If we have text to send, send it
    if (message.text && message.text.trim()) {
      // Process text for Telegram compatibility
      let processedText = message.text;
      if (message.parseMode === "markdown") {
        processedText = this.convertMarkdownForTelegram(message.text);
      }

      const options: Record<string, unknown> = {};

      // Set parse mode
      // Use legacy Markdown (not MarkdownV2) to avoid escaping issues with special characters
      if (message.parseMode === "markdown") {
        options.parse_mode = "Markdown";
      } else if (message.parseMode === "html") {
        options.parse_mode = "HTML";
      }

      // Reply to message if specified
      if (message.replyTo) {
        options.reply_to_message_id = parseInt(message.replyTo, 10);
      }

      // Forum topic thread support
      if (message.threadId) {
        options.message_thread_id = parseInt(message.threadId, 10);
      }

      // Link preview control
      if (message.disableLinkPreview) {
        options.link_preview_options = { is_disabled: true };
      }

      // Inline keyboard support
      if (message.inlineKeyboard && message.inlineKeyboard.length > 0) {
        options.reply_markup = this.buildInlineKeyboard(message.inlineKeyboard);
      }

      try {
        const sent = await this.bot.api.sendMessage(message.chatId, processedText, options);
        return sent.message_id.toString();
      } catch (error: Any) {
        // If markdown parsing fails, retry without parse_mode
        if (error?.error_code === 400 && error?.description?.includes("can't parse entities")) {
          console.log("Markdown parsing failed, retrying without parse_mode");
          const plainOptions: Record<string, unknown> = {
            ...(message.threadId && { message_thread_id: parseInt(message.threadId, 10) }),
            ...(message.disableLinkPreview && { link_preview_options: { is_disabled: true } }),
            ...(message.inlineKeyboard && {
              reply_markup: this.buildInlineKeyboard(message.inlineKeyboard),
            }),
          };
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
    return lastMessageId || "";
  }

  /**
   * Build grammY InlineKeyboard from our button format
   */
  private buildInlineKeyboard(buttons: InlineKeyboardButton[][]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const row of buttons) {
      for (const button of row) {
        if (button.url) {
          keyboard.url(button.text, button.url);
        } else if (button.callbackData) {
          keyboard.text(button.text, button.callbackData);
        }
      }
      keyboard.row();
    }
    return keyboard;
  }

  /**
   * Handle incoming callback query from inline keyboard button press
   */
  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery!;
    if (!query.data || !query.message) {
      return;
    }

    const callbackQuery: CallbackQuery = {
      id: query.id,
      userId: query.from.id.toString(),
      userName: query.from.first_name + (query.from.last_name ? ` ${query.from.last_name}` : ""),
      chatId: query.message.chat.id.toString(),
      messageId: query.message.message_id.toString(),
      data: query.data,
      threadId: (query.message as { message_thread_id?: number }).message_thread_id?.toString(),
      raw: ctx,
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
   * Feature 1: Draft streaming - Start streaming a response
   * Creates or updates a draft message that shows response as it generates
   */
  async startDraftStream(chatId: string): Promise<void> {
    if (!this.config.draftStreamingEnabled) return;

    this.draftStates.set(chatId, {
      chatId,
      currentText: "",
      lastUpdateTime: Date.now(),
    });
  }

  /**
   * Update draft stream with new content
   */
  async updateDraftStream(chatId: string, text: string): Promise<void> {
    if (!this.bot || !this.config.draftStreamingEnabled) return;

    let state = this.draftStates.get(chatId);
    if (!state) {
      // Be robust to callers that didn't explicitly start a draft stream
      // (e.g., follow-ups or after process restarts).
      state = {
        chatId,
        currentText: "",
        lastUpdateTime: 0,
      };
      this.draftStates.set(chatId, state);
    }

    const now = Date.now();

    // Throttle updates to prevent API spam
    if (now - state.lastUpdateTime < this.DRAFT_UPDATE_INTERVAL) {
      // Just update the text, don't send yet
      state.currentText = text;
      return;
    }

    // Add typing indicator suffix
    const displayText = text + " ▌";

    try {
      if (state.messageId) {
        // Edit existing message
        await this.bot.api.editMessageText(chatId, parseInt(state.messageId, 10), displayText);
      } else {
        // Create new message
        const sent = await this.bot.api.sendMessage(chatId, displayText);
        state.messageId = sent.message_id.toString();
      }

      state.currentText = text;
      state.lastUpdateTime = now;
    } catch (error: Any) {
      // Ignore "message not modified" errors
      if (!error?.description?.includes("message is not modified")) {
        console.error("Draft stream update error:", error);
      }
    }
  }

  /**
   * Finalize draft stream with final content
   */
  async finalizeDraftStream(chatId: string, finalText: string): Promise<string> {
    if (!this.bot) throw new Error("Bot not connected");

    const state = this.draftStates.get(chatId);
    this.draftStates.delete(chatId);

    if (!this.config.draftStreamingEnabled || !state?.messageId) {
      // No draft exists, send as new message
      const sent = await this.bot.api.sendMessage(chatId, finalText);
      return sent.message_id.toString();
    }

    try {
      // Edit the draft message to final content (remove typing indicator)
      await this.bot.api.editMessageText(chatId, parseInt(state.messageId, 10), finalText);
      return state.messageId;
    } catch (error: Any) {
      // If edit fails, send as new message
      console.error("Failed to finalize draft, sending new message:", error);
      const sent = await this.bot.api.sendMessage(chatId, finalText);
      return sent.message_id.toString();
    }
  }

  /**
   * Cancel draft stream (delete the draft message)
   */
  async cancelDraftStream(chatId: string): Promise<void> {
    const state = this.draftStates.get(chatId);
    this.draftStates.delete(chatId);

    if (state?.messageId && this.bot) {
      try {
        await this.bot.api.deleteMessage(chatId, parseInt(state.messageId, 10));
      } catch {
        // Ignore deletion errors
      }
    }
  }

  /**
   * Convert GitHub-flavored markdown to Telegram-compatible format
   * Telegram legacy Markdown only supports: *bold*, _italic_, `code`, ```code blocks```, [links](url)
   */
  private convertMarkdownForTelegram(text: string): string {
    let result = text;

    // Convert markdown headers (## Header) to bold (*Header*)
    // Must be done before ** conversion
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

    // Convert markdown tables to code blocks
    // Tables start with | and have a separator line like |---|---|
    const tableRegex = /(\|[^\n]+\|\n)+/g;
    const hasSeparatorLine = /\|[\s-:]+\|/;

    result = result.replace(tableRegex, (match) => {
      // Check if this looks like a table (has separator line with dashes)
      if (hasSeparatorLine.test(match)) {
        // Convert table to code block for monospace display
        // Remove the separator line (|---|---|) as it's just formatting
        const lines = match.split("\n").filter((line) => line.trim());
        const cleanedLines = lines.filter((line) => !/^\|[\s-:]+\|$/.test(line.trim()));

        // Format table nicely
        const formattedTable = cleanedLines
          .map((line) => {
            // Remove leading/trailing pipes and clean up
            return line.replace(/^\||\|$/g, "").trim();
          })
          .join("\n");

        return "```\n" + formattedTable + "\n```\n";
      }
      return match;
    });

    // Convert **bold** to *bold* (Telegram uses single asterisk)
    result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

    // Convert __bold__ to *bold* (alternative bold syntax)
    result = result.replace(/__([^_]+)__/g, "*$1*");

    // Convert horizontal rules (---, ***) to a line
    result = result.replace(/^[-*]{3,}$/gm, "─────────────────");

    return result;
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
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
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
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
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const sent = await this.bot.api.sendDocument(chatId, new InputFile(fileBuffer, fileName), {
      caption,
    });

    return sent.message_id.toString();
  }

  /**
   * Send a photo/image to a chat
   */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const sent = await this.bot.api.sendPhoto(chatId, new InputFile(fileBuffer, fileName), {
      caption,
    });

    return sent.message_id.toString();
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a callback query handler (for inline keyboard buttons)
   */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /**
   * Answer a callback query (acknowledge button press)
   * Call this to remove the loading state from the button.
   */
  async answerCallbackQuery(queryId: string, text?: string, showAlert?: boolean): Promise<void> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    await this.bot.api.answerCallbackQuery(queryId, {
      text,
      show_alert: showAlert,
    });
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
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const msgId = parseInt(messageId, 10);
    if (isNaN(msgId)) {
      throw new Error(`Invalid message ID: ${messageId}`);
    }

    const options: Record<string, unknown> = {};
    // If inlineKeyboard is provided (even empty), update reply_markup accordingly.
    // Passing an empty keyboard clears existing buttons.
    if (inlineKeyboard) {
      options.reply_markup = this.buildInlineKeyboard(inlineKeyboard);
    }

    if (text) {
      await this.bot.api.editMessageText(chatId, msgId, text, options);
    } else if (inlineKeyboard) {
      await this.bot.api.editMessageReplyMarkup(chatId, msgId, options);
    }
  }

  // ============================================================================
  // Extended Features
  // ============================================================================

  /**
   * Send typing indicator (chat action)
   */
  async sendTyping(chatId: string, threadId?: string): Promise<void> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const options: Record<string, unknown> = {};
    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    await this.bot.api.sendChatAction(chatId, "typing", options);
  }

  /**
   * Add reaction to a message
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const msgId = parseInt(messageId, 10);
    // Cast emoji to the expected type - Telegram will reject invalid emojis at runtime
    await this.bot.api.setMessageReaction(chatId, msgId, [{ type: "emoji", emoji: emoji as "👍" }]);
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(chatId: string, messageId: string): Promise<void> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const msgId = parseInt(messageId, 10);
    await this.bot.api.setMessageReaction(chatId, msgId, []);
  }

  /**
   * Send a poll
   */
  async sendPoll(chatId: string, poll: Poll, threadId?: string): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const options: Record<string, unknown> = {
      is_anonymous: poll.isAnonymous ?? true,
      allows_multiple_answers: poll.allowsMultipleAnswers ?? false,
    };

    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    if (poll.type === "quiz" && poll.correctOptionId !== undefined) {
      options.type = "quiz";
      options.correct_option_id = poll.correctOptionId;
      if (poll.explanation) {
        options.explanation = poll.explanation;
      }
    }

    if (poll.openPeriod) {
      options.open_period = poll.openPeriod;
    } else if (poll.closeDate) {
      options.close_date = Math.floor(poll.closeDate.getTime() / 1000);
    }

    const sent = await this.bot.api.sendPoll(
      chatId,
      poll.question,
      poll.options.map((o) => o.text),
      options,
    );

    return sent.message_id.toString();
  }

  /**
   * Send message with reply keyboard (persistent keyboard below input)
   */
  async sendWithReplyKeyboard(
    chatId: string,
    text: string,
    keyboard: ReplyKeyboard,
    threadId?: string,
  ): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const replyMarkup = {
      keyboard: keyboard.buttons.map((row) =>
        row.map((btn) => ({
          text: btn.text,
          request_contact: btn.requestContact,
          request_location: btn.requestLocation,
        })),
      ),
      resize_keyboard: keyboard.resizeKeyboard ?? true,
      one_time_keyboard: keyboard.oneTimeKeyboard ?? false,
      input_field_placeholder: keyboard.inputPlaceholder,
    };

    const options: Record<string, unknown> = {
      reply_markup: replyMarkup,
    };

    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    const sent = await this.bot.api.sendMessage(chatId, text, options);
    return sent.message_id.toString();
  }

  /**
   * Remove reply keyboard (send message that hides the keyboard)
   */
  async removeReplyKeyboard(chatId: string, text: string, threadId?: string): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const options: Record<string, unknown> = {
      reply_markup: { remove_keyboard: true },
    };

    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    const sent = await this.bot.api.sendMessage(chatId, text, options);
    return sent.message_id.toString();
  }

  /**
   * Send a sticker
   */
  async sendSticker(chatId: string, stickerId: string, threadId?: string): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const options: Record<string, unknown> = {};
    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    const sent = await this.bot.api.sendSticker(chatId, stickerId, options);
    return sent.message_id.toString();
  }

  /**
   * Send location
   */
  async sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    threadId?: string,
  ): Promise<string> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const options: Record<string, unknown> = {};
    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    const sent = await this.bot.api.sendLocation(chatId, latitude, longitude, options);
    return sent.message_id.toString();
  }

  /**
   * Send a media group (album)
   */
  async sendMediaGroup(
    chatId: string,
    media: Array<{ type: "photo" | "video"; filePath: string; caption?: string }>,
    threadId?: string,
  ): Promise<string[]> {
    if (!this.bot || this._status !== "connected") {
      throw new Error("Telegram bot is not connected");
    }

    const inputMedia = media.map((m, index) => {
      const fileBuffer = fs.readFileSync(m.filePath);
      const fileName = path.basename(m.filePath);
      return {
        type: m.type,
        media: new InputFile(fileBuffer, fileName),
        caption: index === 0 ? m.caption : undefined, // Caption on first item only
      };
    });

    const options: Record<string, unknown> = {};
    if (threadId) {
      options.message_thread_id = parseInt(threadId, 10);
    }

    const sent = await this.bot.api.sendMediaGroup(chatId, inputMedia as Any, options);
    return sent.map((m) => m.message_id.toString());
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
    let botId: string | undefined;
    let botDisplayName: string | undefined;

    if (this.bot && this._status === "connected") {
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
      type: "telegram",
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
      throw new Error("Bot not initialized");
    }
    return webhookCallback(this.bot, "express") as unknown as (
      req: Request,
      res: Response,
    ) => Promise<void>;
  }

  /**
   * Set webhook URL
   */
  async setWebhook(url: string, secretToken?: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }

    await this.bot.api.setWebhook(url, {
      secret_token: secretToken,
      allowed_updates: ["message"] as const,
    });
  }

  /**
   * Remove webhook
   */
  async deleteWebhook(): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }

    await this.bot.api.deleteWebhook();
  }

  /**
   * Start webhook server with health check endpoint
   * This creates an HTTP server that handles both webhook callbacks and health checks.
   */
  async startWebhookServer(config: WebhookServerConfig): Promise<void> {
    if (this.webhookServer) {
      throw new Error("Webhook server is already running");
    }

    if (!this.bot) {
      throw new Error("Bot not initialized. Call connect() first or initialize bot manually.");
    }

    const {
      port,
      host = "0.0.0.0",
      secretToken,
      webhookPath = "/webhook",
      healthPath = "/healthz",
    } = config;

    // Create HTTP server
    this.webhookServer = http.createServer(async (req, res) => {
      const url = req.url || "/";

      // Health check endpoint
      if (req.method === "GET" && url === healthPath) {
        await this.handleHealthCheck(req, res);
        return;
      }

      // Webhook endpoint
      if (req.method === "POST" && url === webhookPath) {
        // Validate secret token if configured
        if (secretToken) {
          const requestToken = req.headers["x-telegram-bot-api-secret-token"];
          if (requestToken !== secretToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }

        // Handle webhook callback
        await this.handleWebhookRequest(req, res);
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    // Start listening
    return new Promise((resolve, reject) => {
      this.webhookServer!.listen(port, host, () => {
        console.log(`Telegram webhook server listening on ${host}:${port}`);
        console.log(`  Webhook endpoint: ${webhookPath}`);
        console.log(`  Health check: ${healthPath}`);
        resolve();
      });

      this.webhookServer!.on("error", (error) => {
        console.error("Webhook server error:", error);
        reject(error);
      });
    });
  }

  /**
   * Stop the webhook server
   */
  async stopWebhookServer(): Promise<void> {
    if (!this.webhookServer) {
      return;
    }

    return new Promise((resolve) => {
      this.webhookServer!.close(() => {
        console.log("Webhook server stopped");
        this.webhookServer = undefined;
        resolve();
      });
    });
  }

  /**
   * Handle health check requests
   */
  private async handleHealthCheck(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const health = {
      status: this._status === "connected" ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      bot: {
        status: this._status,
        username: this._botUsername || null,
        connected: this._status === "connected",
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };

    const statusCode = health.status === "healthy" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health, null, 2));
  }

  /**
   * Handle webhook requests
   */
  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const update = JSON.parse(body);

        // Process the update using grammY's webhook handler
        if (this.bot) {
          await this.bot.handleUpdate(update);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error("Error processing webhook:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  }

  /**
   * Connect using webhook mode instead of polling
   * Sets up the bot, registers commands, and starts the webhook server.
   */
  async connectWithWebhook(webhookUrl: string, serverConfig: WebhookServerConfig): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");
    this.resetBackoff();

    try {
      // Create bot instance
      this.bot = new Bot(this.config.botToken);

      // Add API throttling
      const throttler = apiThrottler();
      this.bot.api.config.use(throttler);

      // Add sequential processing
      if (this.config.sequentialProcessingEnabled) {
        this.bot.use(sequentialize(this.getSequentialKey));
      }

      // Get bot info
      const me = await this.bot.api.getMe();
      this._botUsername = me.username;

      // Register bot commands
      await this.registerBotCommands();

      // Set up message handler
      // Note: we listen to all messages so photo/voice/document attachments can be handled.
      this.bot.on("message", async (ctx) => {
        const msg = ctx.message as Any;
        const from = msg?.from;
        if (!from || from.is_bot) return;

        if (typeof msg.text === "string" && String(msg.text).length > 0) {
          await this.handleTextMessage(ctx);
          return;
        }
        await this.handleNonTextMessage(ctx);
      });

      // Handle errors
      this.bot.catch(async (err) => {
        await this.handleBotError(err);
      });

      // Start deduplication cleanup
      if (this.config.deduplicationEnabled) {
        this.startDedupCleanup();
      }

      // Start webhook server
      await this.startWebhookServer(serverConfig);

      // Set webhook URL with Telegram
      await this.setWebhook(webhookUrl, serverConfig.secretToken);

      console.log(`Telegram bot @${this._botUsername} connected via webhook`);
      this.setStatus("connected");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("error", err);
      throw err;
    }
  }

  // Private methods

  private inferAttachmentType(mimeType?: string, fileName?: string): MessageAttachment["type"] {
    const mime = (mimeType || "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "document";
    const ext = (fileName ? path.extname(fileName) : "").toLowerCase();
    if (ext === ".pdf") return "document";
    return "file";
  }

  private async downloadTelegramAttachment(opts: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
    type?: MessageAttachment["type"];
  }): Promise<MessageAttachment | null> {
    if (!this.bot) return null;

    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

    try {
      const fileInfo = await this.bot.api.getFile(opts.fileId);
      const filePath = (fileInfo as Any)?.file_path as string | undefined;
      const declaredSize = (fileInfo as Any)?.file_size as number | undefined;

      if (!filePath) return null;
      if (typeof declaredSize === "number" && declaredSize > MAX_ATTACHMENT_BYTES) {
        console.warn("[Telegram] Skipping attachment (too large):", declaredSize, "bytes");
        return null;
      }

      // Download internally (do not leak bot token in URLs to the agent or DB).
      const url = `https://api.telegram.org/file/bot${this.config.botToken}/${filePath}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          console.warn("[Telegram] Failed to download attachment:", res.status, res.statusText);
          return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          console.warn("[Telegram] Skipping attachment (download too large):", buf.length, "bytes");
          return null;
        }

        const fileName =
          (opts.fileName || "").trim() || path.basename(filePath) || `telegram-${opts.fileId}`;
        const mimeType = (opts.mimeType || "").trim() || undefined;
        const type = opts.type || this.inferAttachmentType(mimeType, fileName);

        return {
          type,
          data: buf,
          mimeType,
          fileName,
          size: buf.length,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.warn("[Telegram] Error downloading attachment:", error);
      return null;
    }
  }

  private async mapContextToMessage(ctx: Context, overrideText?: string): Promise<IncomingMessage> {
    const msg = ctx.message!;
    const from = msg.from!;
    const chat = msg.chat;
    const isGroup = chat.type !== "private";

    // Check for forum topic (message_thread_id indicates a forum topic)
    const threadId = msg.message_thread_id?.toString();
    const isForumTopic = msg.is_topic_message === true || threadId !== undefined;

    const msgAny = msg as Any;
    const attachments: MessageAttachment[] = [];

    const hadMedia =
      (Array.isArray(msgAny.photo) && msgAny.photo.length > 0) ||
      !!msgAny.document ||
      !!msgAny.voice ||
      !!msgAny.audio ||
      !!msgAny.video ||
      !!msgAny.animation ||
      !!msgAny.video_note;

    // Photo
    if (Array.isArray(msgAny.photo) && msgAny.photo.length > 0) {
      // Telegram photo sizes are sorted from smallest to largest.
      const photo = msgAny.photo[msgAny.photo.length - 1];
      const fileId = typeof photo?.file_id === "string" ? photo.file_id : "";
      if (fileId) {
        const att = await this.downloadTelegramAttachment({
          fileId,
          type: "image",
          mimeType: "image/jpeg",
        });
        if (att) attachments.push(att);
      }
    }

    // Document
    if (msgAny.document && typeof msgAny.document.file_id === "string") {
      const mimeType =
        typeof msgAny.document.mime_type === "string" ? msgAny.document.mime_type : undefined;
      const fileName =
        typeof msgAny.document.file_name === "string" ? msgAny.document.file_name : undefined;
      const type = this.inferAttachmentType(mimeType, fileName);
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.document.file_id,
        type,
        mimeType,
        fileName,
      });
      if (att) attachments.push(att);
    }

    // Voice note (usually OGG/Opus)
    if (msgAny.voice && typeof msgAny.voice.file_id === "string") {
      const mimeType =
        typeof msgAny.voice.mime_type === "string" ? msgAny.voice.mime_type : "audio/ogg";
      const fileName = `voice-${msg.message_id}.ogg`;
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.voice.file_id,
        type: "audio",
        mimeType,
        fileName,
      });
      if (att) attachments.push(att);
    }

    // Audio
    if (msgAny.audio && typeof msgAny.audio.file_id === "string") {
      const mimeType =
        typeof msgAny.audio.mime_type === "string" ? msgAny.audio.mime_type : undefined;
      const fileName =
        typeof msgAny.audio.file_name === "string" ? msgAny.audio.file_name : undefined;
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.audio.file_id,
        type: "audio",
        mimeType,
        fileName,
      });
      if (att) attachments.push(att);
    }

    // Video
    if (msgAny.video && typeof msgAny.video.file_id === "string") {
      const mimeType =
        typeof msgAny.video.mime_type === "string" ? msgAny.video.mime_type : "video/mp4";
      const fileName =
        typeof msgAny.video.file_name === "string" ? msgAny.video.file_name : undefined;
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.video.file_id,
        type: "video",
        mimeType,
        fileName,
      });
      if (att) attachments.push(att);
    }

    // Animation (GIF / MP4)
    if (msgAny.animation && typeof msgAny.animation.file_id === "string") {
      const mimeType =
        typeof msgAny.animation.mime_type === "string" ? msgAny.animation.mime_type : undefined;
      const fileName =
        typeof msgAny.animation.file_name === "string" ? msgAny.animation.file_name : undefined;
      const type = this.inferAttachmentType(mimeType, fileName);
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.animation.file_id,
        type,
        mimeType,
        fileName,
      });
      if (att) attachments.push(att);
    }

    // Video note
    if (msgAny.video_note && typeof msgAny.video_note.file_id === "string") {
      const att = await this.downloadTelegramAttachment({
        fileId: msgAny.video_note.file_id,
        type: "video",
        mimeType: "video/mp4",
        fileName: `video-note-${msg.message_id}.mp4`,
      });
      if (att) attachments.push(att);
    }

    const caption = typeof msgAny.caption === "string" ? msgAny.caption : "";
    const baseText = overrideText ?? msg.text ?? caption ?? "";
    const finalText = String(baseText || "").trim() || (hadMedia ? "<attachment>" : "");

    return {
      messageId: msg.message_id.toString(),
      channel: "telegram",
      userId: from.id.toString(),
      userName: from.first_name + (from.last_name ? ` ${from.last_name}` : ""),
      chatId: chat.id.toString(),
      isGroup,
      text: finalText,
      timestamp: new Date(msg.date * 1000),
      replyTo: msg.reply_to_message?.message_id.toString(),
      threadId,
      isForumTopic,
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: ctx,
    };
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
 * Create a Telegram adapter from configuration
 */
export function createTelegramAdapter(config: TelegramAdapterConfig): TelegramAdapter {
  if (!config.botToken) {
    throw new Error("Telegram bot token is required");
  }
  return new TelegramAdapter(config);
}
