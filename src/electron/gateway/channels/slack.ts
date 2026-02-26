/**
 * Slack Channel Adapter
 *
 * Implements the ChannelAdapter interface using @slack/bolt for Slack API.
 * Supports Socket Mode for real-time messaging without exposing webhooks.
 */

import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
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
  SlackConfig,
  MessageAttachment,
} from "./types";

export class SlackAdapter implements ChannelAdapter {
  readonly type = "slack" as const;

  private app: App | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private _botId?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  /**
   * Connect to Slack using Socket Mode
   */
  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");

    try {
      // Create SocketModeReceiver with relaxed ping/pong timeouts.
      // Default 5s pong / 30s ping timeouts are too aggressive and cause
      // excessive reconnection churn, especially on unstable networks.
      const receiver = new SocketModeReceiver({
        appToken: this.config.appToken,
        logLevel: LogLevel.WARN,
      });

      // SocketModeReceiver doesn't expose ping/pong timeout options, so we
      // set them directly on the underlying SocketModeClient before start().
      (receiver.client as Any).clientPingTimeout = 15000; // 15s (default: 5s)
      (receiver.client as Any).serverPingTimeout = 60000; // 60s (default: 30s)

      this.app = new App({
        token: this.config.botToken,
        receiver,
        logLevel: LogLevel.WARN,
      });

      // Get bot info
      const authResult = await this.app.client.auth.test();
      this._botUsername = authResult.user as string;
      this._botId = authResult.user_id as string;

      // Handle direct messages and mentions
      this.app.message(async ({ message, client }) => {
        // Ignore bot messages
        if (
          "bot_id" in message ||
          ("subtype" in message && (message as Any).subtype === "bot_message")
        ) {
          return;
        }

        const hasText =
          typeof (message as Any)?.text === "string" &&
          String((message as Any).text).trim().length > 0;
        const hasFiles =
          Array.isArray((message as Any)?.files) && (message as Any).files.length > 0;

        // Only process messages with some content
        if (!hasText && !hasFiles) {
          return;
        }

        // Check if it's a DM or mentions the bot
        const channelInfo = await client.conversations.info({ channel: message.channel });
        const isDirect = channelInfo.channel?.is_im === true;
        const isMultiPartyDm = channelInfo.channel?.is_mpim === true;
        const isGroup = isDirect ? false : true;
        const isMentioned =
          hasText && this._botId
            ? String((message as Any).text).includes(`<@${this._botId}>`)
            : false;

        if (isDirect || isMultiPartyDm || isMentioned) {
          const incomingMessage = await this.mapMessageToIncoming(message, client, isGroup);
          console.log(
            `Processing Slack message from ${incomingMessage.userName}: ${incomingMessage.text.slice(0, 50)}`,
          );
          await this.handleIncomingMessage(incomingMessage);
        }
      });

      // Handle slash commands
      this.app.command(/.*/, async ({ command, ack }) => {
        await ack();

        const isGroup = command.channel_id ? !command.channel_id.startsWith("D") : undefined;
        const incomingMessage: IncomingMessage = {
          messageId: command.trigger_id,
          channel: "slack",
          userId: command.user_id,
          userName: command.user_name,
          chatId: command.channel_id,
          isGroup,
          text: `/${command.command.replace("/", "")} ${command.text}`.trim(),
          timestamp: new Date(),
          raw: command,
        };

        await this.handleIncomingMessage(incomingMessage);
      });

      // Handle errors
      this.app.error(async (error) => {
        console.error("Slack app error:", error);
        this.handleError(error instanceof Error ? error : new Error(String(error)), "app.error");
      });

      // Start the app
      await this.app.start();
      console.log(`Slack bot @${this._botUsername} is connected`);
      this.setStatus("connected");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus("error", err);
      throw err;
    }
  }

  /**
   * Disconnect from Slack
   */
  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this._botUsername = undefined;
    this._botId = undefined;
    this.setStatus("disconnected");
  }

  /**
   * Send a message to a Slack channel
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.app || this._status !== "connected") {
      throw new Error("Slack bot is not connected");
    }

    // Process text for Slack compatibility
    let processedText = message.text;
    if (message.parseMode === "markdown") {
      processedText = this.convertMarkdownForSlack(message.text);
    }

    // Slack has a 4000 character limit per message block
    const chunks = this.splitMessage(processedText, 3900);
    let lastMessageTs = "";

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const result = await this.app.client.chat.postMessage({
          channel: message.chatId,
          text: chunk,
          mrkdwn: true,
          thread_ts: message.replyTo && i === 0 ? message.replyTo : undefined,
        });

        lastMessageTs = result.ts || "";
      }
    } catch (error: unknown) {
      // If markdown parsing fails, retry without formatting
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("invalid") || errorMessage.includes("parse")) {
        console.log("Markdown parsing failed, retrying without formatting");
        return this.sendMessagePlain(message.chatId, message.text, message.replyTo);
      }
      throw error;
    }

    return lastMessageTs;
  }

  /**
   * Send a plain text message without formatting
   */
  private async sendMessagePlain(chatId: string, text: string, replyTo?: string): Promise<string> {
    const chunks = this.splitMessage(text, 3900);
    let lastMessageTs = "";

    for (let i = 0; i < chunks.length; i++) {
      const result = await this.app!.client.chat.postMessage({
        channel: chatId,
        text: chunks[i],
        thread_ts: replyTo && i === 0 ? replyTo : undefined,
      });
      lastMessageTs = result.ts || "";
    }

    return lastMessageTs;
  }

  /**
   * Convert GitHub-flavored markdown to Slack mrkdwn format
   * Slack uses: *bold*, _italic_, ~strikethrough~, `code`, ```code blocks```, >quotes, <url|text>
   */
  private convertMarkdownForSlack(text: string): string {
    let result = text;

    // Convert markdown headers (## Header) to bold (*Header*)
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

    // Convert **bold** to *bold* (Slack uses single asterisk)
    result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

    // Convert __bold__ to *bold*
    result = result.replace(/__([^_]+)__/g, "*$1*");

    // Convert ~~strikethrough~~ to ~strikethrough~
    result = result.replace(/~~([^~]+)~~/g, "~$1~");

    // Convert horizontal rules (---, ***) to a line
    result = result.replace(/^[-*]{3,}$/gm, "───────────────────");

    // Convert [text](url) links to <url|text>
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

    return result;
  }

  /**
   * Split message into chunks respecting Slack's character limit
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
      let breakIndex = remaining.lastIndexOf("\n", maxLength);
      if (breakIndex === -1 || breakIndex < maxLength / 2) {
        breakIndex = remaining.lastIndexOf(" ", maxLength);
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
    if (!this.app || this._status !== "connected") {
      throw new Error("Slack bot is not connected");
    }

    await this.app.client.chat.update({
      channel: chatId,
      ts: messageId,
      text,
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.app || this._status !== "connected") {
      throw new Error("Slack bot is not connected");
    }

    await this.app.client.chat.delete({
      channel: chatId,
      ts: messageId,
    });
  }

  /**
   * Send a document/file to a channel
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    if (!this.app || this._status !== "connected") {
      throw new Error("Slack bot is not connected");
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const result = (await this.app.client.files.uploadV2({
      channel_id: chatId,
      file: fileBuffer,
      filename: fileName,
      title: fileName,
      initial_comment: caption,
    })) as Any;

    // Return the file ID if available
    if (result.files && result.files.length > 0) {
      return result.files[0].id || "";
    }
    return "";
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
      type: "slack",
      status: this._status,
      botId: this._botId,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
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
    if (ext === ".pdf") return "document";
    return "file";
  }

  private async downloadSlackAttachment(file: Any): Promise<MessageAttachment | null> {
    const url: string = String(file?.url_private_download || file?.url_private || "").trim();
    if (!url) return null;

    const fileName: string = String(
      file?.name || file?.title || path.basename(url) || "attachment",
    ).trim();
    const mimeType: string | undefined =
      typeof file?.mimetype === "string" && file.mimetype.trim().length > 0
        ? file.mimetype.trim()
        : undefined;

    const size: number | undefined = typeof file?.size === "number" ? file.size : undefined;
    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
    if (typeof size === "number" && size > MAX_ATTACHMENT_BYTES) {
      console.warn("[Slack] Skipping attachment (too large):", size, "bytes", fileName);
      return null;
    }

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.botToken}`,
        },
      });
      if (!res.ok) {
        console.warn(
          "[Slack] Failed to download attachment:",
          res.status,
          res.statusText,
          fileName,
        );
        return null;
      }

      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        console.warn(
          "[Slack] Skipping attachment (download too large):",
          buf.length,
          "bytes",
          fileName,
        );
        return null;
      }

      return {
        type: this.inferAttachmentType(mimeType, fileName),
        data: buf,
        mimeType,
        fileName,
        size: buf.length,
      };
    } catch (error) {
      console.warn("[Slack] Error downloading attachment:", fileName, error);
      return null;
    }
  }

  private async buildAttachments(message: Any): Promise<MessageAttachment[] | undefined> {
    const files = Array.isArray(message?.files) ? message.files : [];
    if (files.length === 0) return undefined;

    const out: MessageAttachment[] = [];
    for (const file of files) {
      const att = await this.downloadSlackAttachment(file);
      if (att) out.push(att);
    }

    return out.length > 0 ? out : undefined;
  }

  private async mapMessageToIncoming(
    message: Any,
    client: Any,
    isGroup?: boolean,
  ): Promise<IncomingMessage> {
    const hadFiles = Array.isArray(message?.files) && message.files.length > 0;

    // Remove bot mention from the text if present
    let text = message.text || "";
    if (this._botId) {
      text = text.replace(new RegExp(`<@${this._botId}>\\s*`, "g"), "").trim();
    }

    // Get user info for display name
    let userName = message.user || "Unknown";
    try {
      const userInfo = await client.users.info({ user: message.user });
      if (userInfo.user) {
        userName = userInfo.user.real_name || userInfo.user.name || message.user;
      }
    } catch {
      // Ignore errors getting user info
    }

    // Map Slack message to command format if it looks like a command
    const commandText = this.parseCommand(text);
    const attachments = await this.buildAttachments(message);
    const finalText = (commandText || text || "").trim() || (hadFiles ? "<attachment>" : "");

    return {
      messageId: message.ts || "",
      channel: "slack",
      userId: message.user || "",
      userName,
      chatId: message.channel || "",
      isGroup,
      text: finalText,
      timestamp: new Date(parseFloat(message.ts || "0") * 1000),
      replyTo: message.thread_ts,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      raw: message,
    };
  }

  /**
   * Parse text to see if it's a command (starts with /)
   */
  private parseCommand(text: string): string | null {
    const commandMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (commandMatch) {
      return text;
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
 * Create a Slack adapter from configuration
 */
export function createSlackAdapter(config: SlackConfig): SlackAdapter {
  if (!config.botToken) {
    throw new Error("Slack bot token is required");
  }
  if (!config.appToken) {
    throw new Error("Slack app token is required for Socket Mode");
  }
  return new SlackAdapter(config);
}
