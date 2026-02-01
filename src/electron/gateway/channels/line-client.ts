/**
 * LINE Messaging API Client
 *
 * HTTP-based client for LINE messaging communication.
 * Uses webhooks for receiving and REST API for sending messages.
 *
 * Features:
 * - Real-time message receiving via webhooks
 * - Text, image, video, audio message support
 * - Reply and push message support
 * - User profile fetching
 * - Group and room support
 *
 * Requirements:
 * - LINE Channel Access Token (from LINE Developers Console)
 * - LINE Channel Secret (for webhook signature verification)
 * - Public webhook endpoint (use tunnel for development)
 *
 * Rate Limits:
 * - Push messages: Varies by plan (free plan has limits)
 * - Reply messages: Unlimited (use reply tokens when possible)
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

/**
 * LINE message types
 */
export type LineMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'sticker';

/**
 * LINE source types
 */
export type LineSourceType = 'user' | 'group' | 'room';

/**
 * LINE incoming message
 */
export interface LineMessage {
  /** Message ID */
  id: string;
  /** Message type */
  type: LineMessageType;
  /** Source info */
  source: {
    type: LineSourceType;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  /** Reply token (valid for 1 minute) */
  replyToken?: string;
  /** Message content (for text messages) */
  text?: string;
  /** Content provider info (for media messages) */
  contentProvider?: {
    type: 'line' | 'external';
    originalContentUrl?: string;
    previewImageUrl?: string;
  };
  /** Sticker info */
  sticker?: {
    packageId: string;
    stickerId: string;
  };
  /** Location info */
  location?: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  /** Timestamp */
  timestamp: Date;
  /** Raw webhook event */
  raw?: unknown;
}

/**
 * LINE user profile
 */
export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

/**
 * LINE client options
 */
export interface LineClientOptions {
  /** Channel access token */
  channelAccessToken: string;
  /** Channel secret for signature verification */
  channelSecret: string;
  /** Webhook port */
  webhookPort: number;
  /** Webhook path */
  webhookPath: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * LINE client events
 */
export interface LineClientEvents {
  message: (message: LineMessage) => void;
  follow: (userId: string, replyToken?: string) => void;
  unfollow: (userId: string) => void;
  join: (groupId: string, replyToken?: string) => void;
  leave: (groupId: string) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * LINE Messaging API Client
 */
export class LineClient extends EventEmitter {
  private options: LineClientOptions;
  private server?: http.Server;
  private connected = false;
  private userCache: Map<string, LineUserProfile> = new Map();

  private readonly API_BASE = 'https://api.line.me/v2';
  private readonly DATA_API_BASE = 'https://api-data.line.me/v2';

  constructor(options: LineClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Verify webhook signature
   */
  private verifySignature(body: string, signature: string): boolean {
    const hash = crypto
      .createHmac('sha256', this.options.channelSecret)
      .update(body)
      .digest('base64');
    return hash === signature;
  }

  /**
   * Check if credentials are valid by fetching bot info
   */
  async checkConnection(): Promise<{ success: boolean; botId?: string; error?: string }> {
    try {
      const profile = await this.getBotInfo();
      return { success: true, botId: profile.userId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get bot's own profile
   */
  async getBotInfo(): Promise<LineUserProfile> {
    const response = await this.apiRequest('GET', '/bot/info');
    return {
      userId: response.userId,
      displayName: response.displayName,
      pictureUrl: response.pictureUrl,
    };
  }

  /**
   * Start webhook server
   */
  async startReceiving(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleWebhook(req, res);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        let enhancedError = error;
        // Provide better error messages for common issues
        if (error.code === 'EADDRINUSE') {
          enhancedError = new Error(
            `Port ${this.options.webhookPort} is already in use. ` +
            `Another application or LINE channel may be using this port. ` +
            `Try a different webhook port in settings.`
          ) as NodeJS.ErrnoException;
          enhancedError.code = 'EADDRINUSE';
        } else if (error.code === 'EACCES') {
          enhancedError = new Error(
            `Permission denied to use port ${this.options.webhookPort}. ` +
            `Try a port number above 1024.`
          ) as NodeJS.ErrnoException;
          enhancedError.code = 'EACCES';
        }
        if (this.options.verbose) {
          console.error('LINE webhook server error:', enhancedError);
        }
        this.emit('error', enhancedError);
        if (!this.connected) {
          reject(enhancedError);
        }
      });

      this.server.listen(this.options.webhookPort, () => {
        this.connected = true;
        if (this.options.verbose) {
          console.log(
            `LINE webhook server listening on port ${this.options.webhookPort}${this.options.webhookPath}`
          );
        }
        this.emit('connected');
        resolve();
      });
    });
  }

  /**
   * Handle incoming webhook request
   */
  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only handle POST requests to webhook path
    if (req.method !== 'POST' || req.url !== this.options.webhookPath) {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        // Verify signature
        const signature = req.headers['x-line-signature'] as string;
        if (!signature || !this.verifySignature(body, signature)) {
          if (this.options.verbose) {
            console.warn('LINE webhook: Invalid signature');
          }
          res.writeHead(401);
          res.end();
          return;
        }

        // Parse and process events
        const data = JSON.parse(body);
        if (data.events && Array.isArray(data.events)) {
          for (const event of data.events) {
            await this.processEvent(event);
          }
        }

        res.writeHead(200);
        res.end();
      } catch (error) {
        console.error('LINE webhook processing error:', error);
        res.writeHead(500);
        res.end();
      }
    });
  }

  /**
   * Process a LINE webhook event
   */
  private async processEvent(event: Record<string, unknown>): Promise<void> {
    const eventType = event.type as string;

    switch (eventType) {
      case 'message':
        await this.handleMessageEvent(event);
        break;

      case 'follow':
        this.emit('follow', event.source && (event.source as Record<string, unknown>).userId, event.replyToken);
        break;

      case 'unfollow':
        this.emit('unfollow', event.source && (event.source as Record<string, unknown>).userId);
        break;

      case 'join':
        {
          const source = event.source as Record<string, unknown>;
          const groupOrRoomId = source.groupId || source.roomId;
          this.emit('join', groupOrRoomId, event.replyToken);
        }
        break;

      case 'leave':
        {
          const source = event.source as Record<string, unknown>;
          const groupOrRoomId = source.groupId || source.roomId;
          this.emit('leave', groupOrRoomId);
        }
        break;

      default:
        if (this.options.verbose) {
          console.log(`LINE: Unhandled event type: ${eventType}`);
        }
    }
  }

  /**
   * Handle message event
   */
  private async handleMessageEvent(event: Record<string, unknown>): Promise<void> {
    const messageData = event.message as Record<string, unknown>;
    const source = event.source as Record<string, string>;

    const message: LineMessage = {
      id: messageData.id as string,
      type: messageData.type as LineMessageType,
      source: {
        type: source.type as LineSourceType,
        userId: source.userId,
        groupId: source.groupId,
        roomId: source.roomId,
      },
      replyToken: event.replyToken as string,
      timestamp: new Date(event.timestamp as number),
      raw: event,
    };

    // Add type-specific content
    switch (messageData.type) {
      case 'text':
        message.text = messageData.text as string;
        break;

      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        message.contentProvider = messageData.contentProvider as LineMessage['contentProvider'];
        break;

      case 'sticker':
        message.sticker = {
          packageId: messageData.packageId as string,
          stickerId: messageData.stickerId as string,
        };
        break;

      case 'location':
        message.location = {
          title: messageData.title as string,
          address: messageData.address as string,
          latitude: messageData.latitude as number,
          longitude: messageData.longitude as number,
        };
        break;
    }

    this.emit('message', message);
  }

  /**
   * Stop webhook server
   */
  async stopReceiving(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = undefined;
          this.connected = false;
          this.emit('disconnected');
          resolve();
        });
      });
    }
    this.connected = false;
  }

  /**
   * Send reply message (using reply token - faster, unlimited)
   */
  async replyMessage(
    replyToken: string,
    messages: Array<{ type: string; text?: string; [key: string]: unknown }>
  ): Promise<void> {
    await this.apiRequest('POST', '/bot/message/reply', {
      replyToken,
      messages,
    });
  }

  /**
   * Send push message (direct - uses quota)
   */
  async pushMessage(
    to: string,
    messages: Array<{ type: string; text?: string; [key: string]: unknown }>
  ): Promise<void> {
    await this.apiRequest('POST', '/bot/message/push', {
      to,
      messages,
    });
  }

  /**
   * Send text message (convenience method)
   */
  async sendTextMessage(to: string, text: string, replyToken?: string): Promise<void> {
    const messages = [{ type: 'text', text }];

    if (replyToken) {
      await this.replyMessage(replyToken, messages);
    } else {
      await this.pushMessage(to, messages);
    }
  }

  /**
   * Get user profile
   */
  async getUserProfile(userId: string): Promise<LineUserProfile> {
    // Check cache
    const cached = this.userCache.get(userId);
    if (cached) {
      return cached;
    }

    const response = await this.apiRequest('GET', `/bot/profile/${userId}`);
    const profile: LineUserProfile = {
      userId: response.userId,
      displayName: response.displayName,
      pictureUrl: response.pictureUrl,
      statusMessage: response.statusMessage,
    };

    // Cache the profile
    this.userCache.set(userId, profile);
    return profile;
  }

  /**
   * Get group member profile
   */
  async getGroupMemberProfile(groupId: string, userId: string): Promise<LineUserProfile> {
    const response = await this.apiRequest('GET', `/bot/group/${groupId}/member/${userId}`);
    return {
      userId: response.userId,
      displayName: response.displayName,
      pictureUrl: response.pictureUrl,
    };
  }

  /**
   * Get room member profile
   */
  async getRoomMemberProfile(roomId: string, userId: string): Promise<LineUserProfile> {
    const response = await this.apiRequest('GET', `/bot/room/${roomId}/member/${userId}`);
    return {
      userId: response.userId,
      displayName: response.displayName,
      pictureUrl: response.pictureUrl,
    };
  }

  /**
   * Leave a group
   */
  async leaveGroup(groupId: string): Promise<void> {
    await this.apiRequest('POST', `/bot/group/${groupId}/leave`);
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string): Promise<void> {
    await this.apiRequest('POST', `/bot/room/${roomId}/leave`);
  }

  /**
   * Get message content (for images, videos, audio, files)
   */
  async getMessageContent(messageId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.DATA_API_BASE}/bot/message/${messageId}/content`);

      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.options.channelAccessToken}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(Buffer.concat(chunks));
            } else {
              reject(new Error(`Failed to get content: ${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Make API request
   */
  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.API_BASE}${path}`);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method,
        headers: {
          Authorization: `Bearer ${this.options.channelAccessToken}`,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve({});
            }
          } else {
            let errorMessage = `LINE API error: ${res.statusCode}`;
            try {
              const errorData = JSON.parse(data);
              errorMessage = errorData.message || errorMessage;
            } catch {
              // Use default error message
            }
            reject(new Error(errorMessage));
          }
        });
      });

      req.on('error', reject);

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
   * Clear user cache
   */
  clearUserCache(): void {
    this.userCache.clear();
  }
}
