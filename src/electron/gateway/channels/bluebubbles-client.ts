/**
 * BlueBubbles Client
 *
 * REST API client for BlueBubbles iMessage server.
 * BlueBubbles runs on a Mac and exposes iMessage functionality via API.
 *
 * Features:
 * - Send and receive iMessage/SMS
 * - Attachment support (images, files)
 * - Group chat support
 * - Read receipts and typing indicators
 * - Contact sync
 *
 * Requirements:
 * - BlueBubbles server running on a Mac (https://bluebubbles.app/)
 * - Server URL and password
 * - Webhook endpoint for real-time notifications (optional)
 *
 * API Documentation:
 * - https://docs.bluebubbles.app/server/guides/using-the-api
 */

import { EventEmitter } from "events";
import * as http from "http";
import * as https from "https";
import { readWebhookSecret, timingSafeEqualString } from "../../utils/webhook-auth";

/**
 * BlueBubbles message
 */
export interface BlueBubblesMessage {
  /** Message GUID */
  guid: string;
  /** Chat GUID */
  chatGuid: string;
  /** Handle ID (sender) */
  handleId: number;
  /** Handle info */
  handle?: {
    id: number;
    address: string;
    service: string;
    country?: string;
    uncanonicalizedId?: string;
  };
  /** Message text */
  text: string;
  /** Subject (for MMS) */
  subject?: string;
  /** Is from me */
  isFromMe: boolean;
  /** Is read */
  isRead: boolean;
  /** Date created (ms since epoch) */
  dateCreated: number;
  /** Date read (ms since epoch) */
  dateRead?: number;
  /** Date delivered (ms since epoch) */
  dateDelivered?: number;
  /** Attachments */
  attachments?: BlueBubblesAttachment[];
  /** Associated message GUID (for reactions/replies) */
  associatedMessageGuid?: string;
  /** Associated message type */
  associatedMessageType?: number;
  /** Service (iMessage or SMS) */
  service?: string;
  /** Error code if send failed */
  error?: number;
  /** Has DD results (data detection) */
  hasDdResults?: boolean;
  /** Thread originator GUID */
  threadOriginatorGuid?: string;
  /** Raw data */
  raw?: unknown;
}

/**
 * BlueBubbles attachment
 */
export interface BlueBubblesAttachment {
  /** Attachment GUID */
  guid: string;
  /** Original filename */
  originalFilename?: string;
  /** MIME type */
  mimeType?: string;
  /** Transfer name */
  transferName?: string;
  /** Total bytes */
  totalBytes?: number;
  /** Height (for images) */
  height?: number;
  /** Width (for images) */
  width?: number;
}

/**
 * BlueBubbles chat
 */
export interface BlueBubblesChat {
  /** Chat GUID */
  guid: string;
  /** Display name */
  displayName?: string;
  /** Participants */
  participants: Array<{
    id: number;
    address: string;
    service: string;
  }>;
  /** Is group chat */
  isGroup: boolean;
  /** Is archived */
  isArchived: boolean;
  /** Last message */
  lastMessage?: BlueBubblesMessage;
}

/**
 * BlueBubbles client options
 */
export interface BlueBubblesClientOptions {
  /** Server URL (e.g., http://192.168.1.100:1234) */
  serverUrl: string;
  /** Server password */
  password: string;
  /** Webhook port for notifications */
  webhookPort?: number;
  /** Webhook path */
  webhookPath?: string;
  /** Shared secret required for webhook requests */
  webhookSecret?: string;
  /** Poll interval if webhooks not available (ms) */
  pollInterval?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * BlueBubbles client events
 */
export interface BlueBubblesClientEvents {
  message: (message: BlueBubblesMessage) => void;
  messageUpdated: (message: BlueBubblesMessage) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * BlueBubbles REST API Client
 */
export class BlueBubblesClient extends EventEmitter {
  private options: BlueBubblesClientOptions;
  private webhookServer?: http.Server;
  private pollTimer?: NodeJS.Timeout;
  private connected = false;
  private lastMessageDate = 0;
  private lastMessageGuids = new Set<string>();
  private pollInFlight?: Promise<void>;

  constructor(options: BlueBubblesClientOptions) {
    super();
    this.options = {
      pollInterval: 5000,
      webhookPort: 3101,
      webhookPath: "/bluebubbles/webhook",
      ...options,
    };
    // Remove trailing slash from server URL
    this.options.serverUrl = this.options.serverUrl.replace(/\/$/, "");
  }

  /**
   * Check if server is reachable and password is correct
   */
  async checkConnection(): Promise<{ success: boolean; serverVersion?: string; error?: string }> {
    try {
      const response = await this.apiRequest("GET", "/server/info");
      const data = response.data as { os_version?: string; server_version?: string } | undefined;
      return {
        success: true,
        serverVersion: data?.os_version || data?.server_version,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Start receiving messages (via webhooks or polling)
   */
  async startReceiving(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Check connection first
    const check = await this.checkConnection();
    if (!check.success) {
      throw new Error(check.error || "Failed to connect to BlueBubbles server");
    }

    // Initialize last message date
    this.lastMessageDate = Date.now();

    // Try to start webhook server
    if (this.options.webhookPort) {
      try {
        await this.startWebhookServer();
        this.connected = true;
        this.emit("connected");
        return;
      } catch (error) {
        if (this.options.verbose) {
          console.warn("BlueBubbles webhook server failed, falling back to polling:", error);
        }
      }
    }

    // Fall back to polling
    this.startPolling();
    this.connected = true;
    this.emit("connected");
  }

  /**
   * Start webhook server for real-time notifications
   */
  private async startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.webhookServer = http.createServer((req, res) => {
        this.handleWebhook(req, res);
      });

      this.webhookServer.on("error", (error: NodeJS.ErrnoException) => {
        let enhancedError = error;
        // Provide better error messages for common issues
        if (error.code === "EADDRINUSE") {
          enhancedError = new Error(
            `Port ${this.options.webhookPort} is already in use. ` +
              `Another application or BlueBubbles channel may be using this port. ` +
              `Try a different webhook port in settings.`,
          ) as NodeJS.ErrnoException;
          enhancedError.code = "EADDRINUSE";
        } else if (error.code === "EACCES") {
          enhancedError = new Error(
            `Permission denied to use port ${this.options.webhookPort}. ` +
              `Try a port number above 1024.`,
          ) as NodeJS.ErrnoException;
          enhancedError.code = "EACCES";
        }
        if (this.options.verbose) {
          console.error("BlueBubbles webhook server error:", enhancedError);
        }
        reject(enhancedError);
      });

      this.webhookServer.listen(this.options.webhookPort, () => {
        if (this.options.verbose) {
          console.log(
            `BlueBubbles webhook server listening on port ${this.options.webhookPort}${this.options.webhookPath}`,
          );
        }
        resolve();
      });
    });
  }

  /**
   * Handle webhook notification
   */
  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST" || req.url !== this.options.webhookPath) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (!this.verifyWebhookRequest(req)) {
      res.writeHead(401);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        this.processWebhookEvent(data);
        res.writeHead(200);
        res.end();
      } catch (error) {
        console.error("BlueBubbles webhook error:", error);
        res.writeHead(500);
        res.end();
      }
    });
  }

  private verifyWebhookRequest(req: http.IncomingMessage): boolean {
    const secret = this.options.webhookSecret?.trim();
    if (!secret) {
      return false;
    }
    const provided = readWebhookSecret(req);
    return Boolean(provided && timingSafeEqualString(provided, secret));
  }

  /**
   * Process webhook event
   */
  private processWebhookEvent(data: Record<string, unknown>): void {
    const type = data.type as string;

    switch (type) {
      case "new-message":
        {
          const message = data.data as BlueBubblesMessage;
          if (message && !message.isFromMe) {
            this.emit("message", this.normalizeMessage(message));
          }
        }
        break;

      case "updated-message":
        {
          const message = data.data as BlueBubblesMessage;
          if (message) {
            this.emit("messageUpdated", this.normalizeMessage(message));
          }
        }
        break;

      case "typing-indicator":
        // Could emit typing event
        break;

      default:
        if (this.options.verbose) {
          console.log(`BlueBubbles: Unhandled webhook type: ${type}`);
        }
    }
  }

  /**
   * Start polling for new messages
   */
  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(async () => {
      try {
        await this.pollMessages();
      } catch (error) {
        if (this.options.verbose) {
          console.error("BlueBubbles poll error:", error);
        }
      }
    }, this.options.pollInterval);

    if (this.options.verbose) {
      console.log(`BlueBubbles polling started (interval: ${this.options.pollInterval}ms)`);
    }
  }

  /**
   * Poll for new messages
   */
  private async pollMessages(): Promise<void> {
    if (this.pollInFlight) {
      return this.pollInFlight;
    }
    const poll = this.pollMessagesOnce();
    let guarded!: Promise<void>;
    guarded = poll.finally(() => {
      if (this.pollInFlight === guarded) this.pollInFlight = undefined;
    });
    this.pollInFlight = guarded;
    return guarded;
  }

  /** Execute one complete paginated cursor transaction. */
  private async pollMessagesOnce(): Promise<void> {
    const pageSize = 100;
    const previousDate = this.lastMessageDate;
    const previousGuids = this.lastMessageGuids;
    // Query a one-millisecond overlap because BlueBubbles treats `after` as
    // exclusive. The local cursor and GUID set provide the exact boundary.
    const queryAfter = Math.max(0, previousDate - 1);
    // Freeze the upper bound so inserts during pagination are deferred to the
    // next poll instead of shifting DESC offsets underneath this batch.
    const queryBefore = Date.now();
    const messages: BlueBubblesMessage[] = [];
    const seenGuids = new Set<string>();
    let offset = 0;
    while (true) {
      const response = await this.apiRequest("POST", "/message/query", {
        with: ["chat", "handle"],
        sort: "DESC",
        after: queryAfter,
        before: queryBefore,
        limit: pageSize,
        offset,
      });
      const page = (response.data || []) as BlueBubblesMessage[];
      let added = 0;
      for (const message of page) {
        if (!seenGuids.has(message.guid)) {
          seenGuids.add(message.guid);
          messages.push(message);
          added += 1;
        }
      }
      // A full page with nothing new means the server ignored `offset`; stop
      // instead of re-requesting the same page forever.
      if (page.length < pageSize || added === 0) break;
      offset += page.length;
    }

    const eligible = messages
      .filter(
        (msg) =>
          !msg.isFromMe &&
          (msg.dateCreated > previousDate ||
            (msg.dateCreated === previousDate && !previousGuids.has(msg.guid))),
      )
      .sort((a, b) => a.dateCreated - b.dateCreated || a.guid.localeCompare(b.guid));
    for (const msg of eligible) this.emit("message", this.normalizeMessage(msg));

    if (eligible.length > 0) {
      const maxDate = eligible.reduce((max, msg) => Math.max(max, msg.dateCreated), previousDate);
      this.lastMessageDate = maxDate;
      const guidsAtCursor = maxDate === previousDate ? new Set(previousGuids) : new Set<string>();
      for (const msg of eligible) {
        if (msg.dateCreated === maxDate) guidsAtCursor.add(msg.guid);
      }
      this.lastMessageGuids = guidsAtCursor;
    }
  }

  /**
   * Normalize message data
   */
  private normalizeMessage(msg: BlueBubblesMessage): BlueBubblesMessage {
    return {
      ...msg,
      raw: msg,
    };
  }

  /**
   * Stop receiving messages
   */
  async stopReceiving(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.webhookServer) {
      return new Promise((resolve) => {
        this.webhookServer!.close(() => {
          this.webhookServer = undefined;
          this.connected = false;
          this.emit("disconnected");
          resolve();
        });
      });
    }

    this.connected = false;
    this.emit("disconnected");
  }

  /**
   * Send a message
   */
  async sendMessage(
    chatGuid: string,
    message: string,
    options?: { subject?: string; method?: "private-api" | "apple-script" },
  ): Promise<BlueBubblesMessage> {
    const response = await this.apiRequest("POST", "/message/text", {
      chatGuid,
      message,
      subject: options?.subject,
      method: options?.method || "private-api",
    });

    return response.data as BlueBubblesMessage;
  }

  /**
   * Send a message to a new chat (by address)
   */
  async sendMessageToAddress(
    address: string,
    message: string,
    service: "iMessage" | "SMS" = "iMessage",
  ): Promise<BlueBubblesMessage> {
    // First, get or create chat
    const chatResponse = await this.apiRequest("POST", "/chat/new", {
      addresses: [address],
      service,
    });

    const chat = chatResponse.data as BlueBubblesChat;
    if (!chat || !chat.guid) {
      throw new Error("Failed to create chat");
    }

    // Then send message
    return this.sendMessage(chat.guid, message);
  }

  /**
   * Get chats
   */
  async getChats(options?: { limit?: number; offset?: number }): Promise<BlueBubblesChat[]> {
    const response = await this.apiRequest("POST", "/chat/query", {
      with: ["lastMessage", "participants"],
      sort: "lastmessage",
      limit: options?.limit || 25,
      offset: options?.offset || 0,
    });

    return (response.data || []) as BlueBubblesChat[];
  }

  /**
   * Get chat by GUID
   */
  async getChat(chatGuid: string): Promise<BlueBubblesChat> {
    const response = await this.apiRequest("GET", `/chat/${encodeURIComponent(chatGuid)}`, {
      with: ["participants", "lastMessage"],
    });

    return response.data as BlueBubblesChat;
  }

  /**
   * Get messages from a chat
   */
  async getMessages(
    chatGuid: string,
    options?: { limit?: number; offset?: number; after?: number; before?: number },
  ): Promise<BlueBubblesMessage[]> {
    const response = await this.apiRequest("GET", `/chat/${encodeURIComponent(chatGuid)}/message`, {
      with: ["handle", "attachment"],
      sort: "DESC",
      limit: options?.limit || 25,
      offset: options?.offset || 0,
      after: options?.after,
      before: options?.before,
    });

    return (response.data || []) as BlueBubblesMessage[];
  }

  /**
   * Mark chat as read
   */
  async markChatRead(chatGuid: string): Promise<void> {
    await this.apiRequest("POST", `/chat/${encodeURIComponent(chatGuid)}/read`);
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(chatGuid: string): Promise<void> {
    await this.apiRequest("POST", `/chat/${encodeURIComponent(chatGuid)}/typing`);
  }

  /**
   * Get attachment data
   */
  async getAttachment(attachmentGuid: string): Promise<Buffer> {
    return this.apiRequestBinary(
      "GET",
      `/attachment/${encodeURIComponent(attachmentGuid)}/download`,
    );
  }

  /**
   * Make API request
   */
  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.options.serverUrl}/api/v1${path}`);

      // Add password to query params
      url.searchParams.set("password", this.options.password);

      // Add body params to query for GET requests
      if (method === "GET" && body) {
        for (const [key, value] of Object.entries(body)) {
          if (value !== undefined) {
            url.searchParams.set(key, String(value));
          }
        }
      }

      const isHttps = url.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
        },
      };

      const req = requestModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ data: data });
            }
          } else {
            let errorMessage = `BlueBubbles API error: ${res.statusCode}`;
            try {
              const errorData = JSON.parse(data);
              errorMessage = errorData.message || errorData.error || errorMessage;
            } catch {
              // Use default error message
            }
            reject(new Error(errorMessage));
          }
        });
      });

      req.on("error", reject);

      if (method !== "GET" && body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Make binary API request (for attachments)
   */
  private async apiRequestBinary(method: string, path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.options.serverUrl}/api/v1${path}`);
      url.searchParams.set("password", this.options.password);

      const isHttps = url.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
      };

      const req = requestModule.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error(`BlueBubbles API error: ${res.statusCode}`));
          }
        });
      });

      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get server URL
   */
  getServerUrl(): string {
    return this.options.serverUrl;
  }
}
