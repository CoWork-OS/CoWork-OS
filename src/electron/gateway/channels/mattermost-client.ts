/**
 * Mattermost Client
 *
 * HTTP/WebSocket client for Mattermost server communication.
 * Supports both self-hosted and cloud Mattermost instances.
 *
 * Features:
 * - REST API for sending messages
 * - WebSocket for real-time message receiving
 * - Personal access token authentication
 * - Channel and direct message support
 * - File attachment support
 *
 * Requirements:
 * - Mattermost server URL
 * - Personal access token (generated in Account Settings > Security)
 */

import { EventEmitter } from "events";
import * as https from "https";
import * as http from "http";
import WebSocket from "ws";

/**
 * Mattermost message types
 */
export interface MattermostPost {
  id: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  edit_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  parent_id: string;
  original_id: string;
  message: string;
  type: string;
  props: Record<string, unknown>;
  hashtags: string;
  pending_post_id: string;
  reply_count: number;
  metadata?: {
    files?: MattermostFile[];
  };
}

export interface MattermostFile {
  id: string;
  user_id: string;
  post_id: string;
  name: string;
  extension: string;
  size: number;
  mime_type: string;
  width?: number;
  height?: number;
}

export interface MattermostUser {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  nickname: string;
  position: string;
}

export interface MattermostChannel {
  id: string;
  team_id: string;
  type: "O" | "P" | "D" | "G"; // Open, Private, Direct, Group
  display_name: string;
  name: string;
  header: string;
  purpose: string;
}

export interface MattermostWebSocketEvent {
  event: string;
  data: {
    post?: string; // JSON stringified MattermostPost
    channel_id?: string;
    channel_type?: string;
    sender_name?: string;
    team_id?: string;
    [key: string]: unknown;
  };
  broadcast: {
    omit_users: Record<string, boolean>;
    user_id: string;
    channel_id: string;
    team_id: string;
  };
  seq: number;
}

/**
 * Mattermost client options
 */
export interface MattermostClientOptions {
  /** Mattermost server URL (e.g., https://mattermost.example.com) */
  serverUrl: string;
  /** Personal access token */
  token: string;
  /** Team ID to operate in (optional, will use first team if not specified) */
  teamId?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Mattermost Client
 */
export class MattermostClient extends EventEmitter {
  private options: MattermostClientOptions;
  private ws?: WebSocket;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private currentUserId?: string;
  private baseUrl: string;
  private wsUrl: string;

  constructor(options: MattermostClientOptions) {
    super();
    this.options = options;

    // Parse and construct URLs
    const url = new URL(options.serverUrl);
    this.baseUrl = `${url.protocol}//${url.host}`;
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = `${wsProtocol}//${url.host}/api/v4/websocket`;
  }

  /**
   * Check if the server is accessible and token is valid
   */
  async checkConnection(): Promise<{ success: boolean; userId?: string; error?: string }> {
    try {
      const user = await this.apiRequest<MattermostUser>("GET", "/api/v4/users/me");
      return { success: true, userId: user.id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the current user info
   */
  async getCurrentUser(): Promise<MattermostUser> {
    return this.apiRequest<MattermostUser>("GET", "/api/v4/users/me");
  }

  /**
   * Get user by ID
   */
  async getUser(userId: string): Promise<MattermostUser> {
    return this.apiRequest<MattermostUser>("GET", `/api/v4/users/${userId}`);
  }

  /**
   * Start receiving messages via WebSocket
   */
  async startReceiving(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Get current user ID first
    const user = await this.getCurrentUser();
    this.currentUserId = user.id;

    return new Promise((resolve, reject) => {
      if (this.options.verbose) {
        console.log(`Connecting to Mattermost WebSocket: ${this.wsUrl}`);
      }

      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `Bearer ${this.options.token}`,
        },
      });

      this.ws.on("open", () => {
        this.connected = true;
        this.startPing();
        this.emit("connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        this.handleWebSocketMessage(data.toString());
      });

      this.ws.on("error", (error: Error) => {
        if (this.options.verbose) {
          console.error("Mattermost WebSocket error:", error);
        }
        this.emit("error", error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        this.stopPing();
        this.emit("disconnected");
        this.scheduleReconnect();
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleWebSocketMessage(data: string): void {
    try {
      const event: MattermostWebSocketEvent = JSON.parse(data);

      if (event.event === "posted" && event.data.post) {
        const post: MattermostPost = JSON.parse(event.data.post);

        // Skip own messages
        if (post.user_id === this.currentUserId) {
          return;
        }

        const channelType = event.data.channel_type || "O";
        this.emit("post", post, channelType);
      }
    } catch (error) {
      if (this.options.verbose) {
        console.error("Failed to parse Mattermost WebSocket message:", error);
      }
    }
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.ping();
      }
    }, 30000);
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.startReceiving();
      } catch (error) {
        console.error("Mattermost reconnection failed:", error);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  /**
   * Stop receiving messages
   */
  async stopReceiving(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this.connected = false;
    this.emit("disconnected");
  }

  /**
   * Send a message to a channel
   */
  async sendMessage(
    channelId: string,
    message: string,
    options?: {
      rootId?: string;
      fileIds?: string[];
    },
  ): Promise<MattermostPost> {
    const body: Record<string, unknown> = {
      channel_id: channelId,
      message,
    };

    if (options?.rootId) {
      body.root_id = options.rootId;
    }

    if (options?.fileIds && options.fileIds.length > 0) {
      body.file_ids = options.fileIds;
    }

    return this.apiRequest<MattermostPost>("POST", "/api/v4/posts", body);
  }

  /**
   * Update a message
   */
  async updateMessage(postId: string, message: string): Promise<MattermostPost> {
    return this.apiRequest<MattermostPost>("PUT", `/api/v4/posts/${postId}`, {
      id: postId,
      message,
    });
  }

  /**
   * Delete a message
   */
  async deleteMessage(postId: string): Promise<void> {
    await this.apiRequest("DELETE", `/api/v4/posts/${postId}`);
  }

  /**
   * Add a reaction to a post
   */
  async addReaction(postId: string, emojiName: string): Promise<void> {
    await this.apiRequest("POST", "/api/v4/reactions", {
      user_id: this.currentUserId,
      post_id: postId,
      emoji_name: emojiName,
    });
  }

  /**
   * Remove a reaction from a post
   */
  async removeReaction(postId: string, emojiName: string): Promise<void> {
    await this.apiRequest(
      "DELETE",
      `/api/v4/users/${this.currentUserId}/posts/${postId}/reactions/${emojiName}`,
    );
  }

  /**
   * Get channel by ID
   */
  async getChannel(channelId: string): Promise<MattermostChannel> {
    return this.apiRequest<MattermostChannel>("GET", `/api/v4/channels/${channelId}`);
  }

  /**
   * Get direct message channel with a user (creates if doesn't exist)
   */
  async getDirectChannel(userId: string): Promise<MattermostChannel> {
    return this.apiRequest<MattermostChannel>("POST", "/api/v4/channels/direct", [
      this.currentUserId,
      userId,
    ]);
  }

  /**
   * Upload a file
   */
  async uploadFile(
    channelId: string,
    filePath: string,
    fileName: string,
  ): Promise<{ file_infos: MattermostFile[] }> {
    const fs = await import("fs");
    const path = await import("path");
    const FormData = (await import("form-data")).default;

    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", fs.createReadStream(filePath), {
      filename: fileName || path.basename(filePath),
    });

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/v4/files`);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: "POST",
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${this.options.token}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Upload failed: ${res.statusCode} ${data}`));
            }
          });
        },
      );

      req.on("error", reject);
      form.pipe(req);
    });
  }

  /**
   * Get file URL
   */
  getFileUrl(fileId: string): string {
    return `${this.baseUrl}/api/v4/files/${fileId}`;
  }

  /**
   * Make an API request
   */
  private apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${path}`);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
      };

      const req = httpModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : ({} as T));
            } catch {
              resolve(data as unknown as T);
            }
          } else {
            let errorMessage = `HTTP ${res.statusCode}`;
            try {
              const errorData = JSON.parse(data);
              errorMessage = errorData.message || errorData.error || errorMessage;
            } catch {
              // Use status code as error
            }
            reject(new Error(errorMessage));
          }
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

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
   * Get current user ID
   */
  getCurrentUserId(): string | undefined {
    return this.currentUserId;
  }
}
