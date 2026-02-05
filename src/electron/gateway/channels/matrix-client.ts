/**
 * Matrix Client
 *
 * HTTP client for Matrix homeserver communication using the Client-Server API.
 * Implements sync-based message receiving for real-time updates.
 *
 * Features:
 * - Long-polling sync for real-time messages
 * - Room message sending with formatting
 * - File/media upload and download
 * - Room state management
 * - User presence
 *
 * Requirements:
 * - Matrix homeserver URL (e.g., https://matrix.org)
 * - Access token (from login or existing session)
 * - User ID (e.g., @user:matrix.org)
 */

import { EventEmitter } from 'events';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Matrix event types
 */
export interface MatrixRoomEvent {
  type: string;
  room_id: string;
  sender: string;
  event_id: string;
  origin_server_ts: number;
  content: {
    msgtype?: string;
    body?: string;
    format?: string;
    formatted_body?: string;
    'm.relates_to'?: {
      'm.in_reply_to'?: { event_id: string };
      rel_type?: string;
      event_id?: string;
    };
    url?: string;
    info?: {
      mimetype?: string;
      size?: number;
      w?: number;
      h?: number;
    };
    [key: string]: unknown;
  };
  unsigned?: {
    age?: number;
    transaction_id?: string;
  };
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: {
        events: MatrixRoomEvent[];
        limited?: boolean;
        prev_batch?: string;
      };
      state?: {
        events: MatrixRoomEvent[];
      };
      ephemeral?: {
        events: MatrixRoomEvent[];
      };
    }>;
    invite?: Record<string, {
      invite_state?: {
        events: MatrixRoomEvent[];
      };
    }>;
    leave?: Record<string, unknown>;
  };
  presence?: {
    events: MatrixRoomEvent[];
  };
}

export interface MatrixUser {
  user_id: string;
  displayname?: string;
  avatar_url?: string;
}

export interface MatrixRoom {
  room_id: string;
  name?: string;
  canonical_alias?: string;
  topic?: string;
  num_joined_members?: number;
  world_readable?: boolean;
  guest_can_join?: boolean;
}

export interface MatrixUploadResponse {
  content_uri: string;
}

/**
 * Matrix client options
 */
export interface MatrixClientOptions {
  /** Matrix homeserver URL (e.g., https://matrix.org) */
  homeserver: string;
  /** User ID (e.g., @user:matrix.org) */
  userId: string;
  /** Access token */
  accessToken: string;
  /** Device ID (optional) */
  deviceId?: string;
  /** Room IDs to listen to (optional, listens to all joined rooms if not specified) */
  roomIds?: string[];
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Matrix client events
 */
export interface MatrixClientEvents {
  message: (event: MatrixRoomEvent) => void;
  invite: (roomId: string, inviter: string) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * Matrix Client
 */
export class MatrixClient extends EventEmitter {
  private options: MatrixClientOptions;
  private syncToken?: string;
  private syncing = false;
  private connected = false;
  private syncAbortController?: AbortController;

  constructor(options: MatrixClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Check if the homeserver is accessible and token is valid
   */
  async checkConnection(): Promise<{ success: boolean; userId?: string; error?: string }> {
    try {
      const response = await this.apiRequest<{ user_id: string }>('GET', '/_matrix/client/v3/account/whoami');
      return { success: true, userId: response.user_id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get user profile
   */
  async getUserProfile(userId?: string): Promise<MatrixUser> {
    const targetUserId = userId || this.options.userId;
    const profile = await this.apiRequest<{ displayname?: string; avatar_url?: string }>(
      'GET',
      `/_matrix/client/v3/profile/${encodeURIComponent(targetUserId)}`
    );
    return {
      user_id: targetUserId,
      displayname: profile.displayname,
      avatar_url: profile.avatar_url,
    };
  }

  /**
   * Get joined rooms
   */
  async getJoinedRooms(): Promise<string[]> {
    const response = await this.apiRequest<{ joined_rooms: string[] }>(
      'GET',
      '/_matrix/client/v3/joined_rooms'
    );
    return response.joined_rooms;
  }

  /**
   * Get direct (1:1) room IDs from account data
   */
  async getDirectRooms(): Promise<string[]> {
    try {
      const response = await this.apiRequest<Record<string, string[]>>(
        'GET',
        `/_matrix/client/v3/user/${encodeURIComponent(this.options.userId)}/account_data/m.direct`
      );
      return Object.values(response || {}).flat().filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Start syncing (receiving messages)
   */
  async startReceiving(): Promise<void> {
    if (this.syncing) {
      return;
    }

    this.syncing = true;
    this.connected = true;
    this.emit('connected');

    // Start sync loop
    this.syncLoop();
  }

  /**
   * Sync loop for receiving messages
   */
  private async syncLoop(): Promise<void> {
    while (this.syncing) {
      try {
        const params = new URLSearchParams({
          timeout: '30000',
          ...(this.syncToken && { since: this.syncToken }),
          filter: JSON.stringify({
            room: {
              timeline: { limit: 50 },
              state: { lazy_load_members: true },
            },
            presence: { limit: 0 },
          }),
        });

        const response = await this.apiRequest<MatrixSyncResponse>(
          'GET',
          `/_matrix/client/v3/sync?${params.toString()}`,
          undefined,
          35000 // Slightly longer timeout than the sync timeout
        );

        this.syncToken = response.next_batch;

        // Process room events
        if (response.rooms?.join) {
          for (const [roomId, roomData] of Object.entries(response.rooms.join)) {
            // Check if we're filtering to specific rooms
            if (this.options.roomIds && this.options.roomIds.length > 0) {
              if (!this.options.roomIds.includes(roomId)) {
                continue;
              }
            }

            // Process timeline events (new messages)
            if (roomData.timeline?.events) {
              for (const event of roomData.timeline.events) {
                // Skip own messages
                if (event.sender === this.options.userId) {
                  continue;
                }

                // Only process m.room.message events
                if (event.type === 'm.room.message') {
                  this.emit('message', { ...event, room_id: roomId });
                }
              }
            }
          }
        }

        // Process invites
        if (response.rooms?.invite) {
          for (const [roomId, inviteData] of Object.entries(response.rooms.invite)) {
            const inviter = inviteData.invite_state?.events?.find(
              (e) => e.type === 'm.room.member' && e.content.membership === 'invite'
            )?.sender;
            if (inviter) {
              this.emit('invite', roomId, inviter);
            }
          }
        }
      } catch (error) {
        if (this.syncing) {
          if (this.options.verbose) {
            console.error('Matrix sync error:', error);
          }
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
  }

  /**
   * Stop syncing
   */
  async stopReceiving(): Promise<void> {
    this.syncing = false;
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message to a room
   */
  async sendMessage(
    roomId: string,
    body: string,
    options?: {
      msgtype?: string;
      format?: string;
      formattedBody?: string;
      replyTo?: string;
    }
  ): Promise<string> {
    const content: Record<string, unknown> = {
      msgtype: options?.msgtype || 'm.text',
      body,
    };

    // Add formatted content if provided
    if (options?.formattedBody) {
      content.format = options.format || 'org.matrix.custom.html';
      content.formatted_body = options.formattedBody;
    }

    // Add reply relationship if provided
    if (options?.replyTo) {
      content['m.relates_to'] = {
        'm.in_reply_to': {
          event_id: options.replyTo,
        },
      };
    }

    const txnId = `m${Date.now()}${Math.random().toString(36).substring(2)}`;
    const response = await this.apiRequest<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      content
    );

    return response.event_id;
  }

  /**
   * Send an image to a room
   */
  async sendImage(
    roomId: string,
    mxcUrl: string,
    body: string,
    info?: { mimetype?: string; size?: number; w?: number; h?: number }
  ): Promise<string> {
    const content: Record<string, unknown> = {
      msgtype: 'm.image',
      body,
      url: mxcUrl,
      info,
    };

    const txnId = `m${Date.now()}${Math.random().toString(36).substring(2)}`;
    const response = await this.apiRequest<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      content
    );

    return response.event_id;
  }

  /**
   * Send a file to a room
   */
  async sendFile(
    roomId: string,
    mxcUrl: string,
    body: string,
    info?: { mimetype?: string; size?: number }
  ): Promise<string> {
    const content: Record<string, unknown> = {
      msgtype: 'm.file',
      body,
      url: mxcUrl,
      info,
    };

    const txnId = `m${Date.now()}${Math.random().toString(36).substring(2)}`;
    const response = await this.apiRequest<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      content
    );

    return response.event_id;
  }

  /**
   * Upload media to the homeserver
   */
  async uploadMedia(
    filePath: string,
    contentType?: string
  ): Promise<MatrixUploadResponse> {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = contentType || this.getMimeType(fileName);

    return new Promise((resolve, reject) => {
      const url = new URL(this.options.homeserver);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const uploadPath = `/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`;

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: uploadPath,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'Content-Type': mimeType,
            'Content-Length': fileBuffer.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`Upload failed: ${res.statusCode} ${data}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(fileBuffer);
      req.end();
    });
  }

  /**
   * Get media download URL
   */
  getMediaUrl(mxcUrl: string): string {
    // Convert mxc://server/media_id to https://homeserver/_matrix/media/v3/download/server/media_id
    const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      return mxcUrl;
    }
    return `${this.options.homeserver}/_matrix/media/v3/download/${match[1]}/${match[2]}`;
  }

  /**
   * Redact (delete) a message
   */
  async redactMessage(roomId: string, eventId: string, reason?: string): Promise<string> {
    const txnId = `m${Date.now()}${Math.random().toString(36).substring(2)}`;
    const response = await this.apiRequest<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`,
      reason ? { reason } : {}
    );
    return response.event_id;
  }

  /**
   * Send a reaction to a message
   */
  async sendReaction(roomId: string, eventId: string, emoji: string): Promise<string> {
    const content = {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: eventId,
        key: emoji,
      },
    };

    const txnId = `m${Date.now()}${Math.random().toString(36).substring(2)}`;
    const response = await this.apiRequest<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
      content
    );

    return response.event_id;
  }

  /**
   * Send typing notification
   */
  async sendTyping(roomId: string, typing: boolean, timeout = 30000): Promise<void> {
    await this.apiRequest(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.options.userId)}`,
      { typing, timeout: typing ? timeout : undefined }
    );
  }

  /**
   * Send read receipt
   */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.apiRequest(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      {}
    );
  }

  /**
   * Join a room
   */
  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const response = await this.apiRequest<{ room_id: string }>(
      'POST',
      `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
      {}
    );
    return response.room_id;
  }

  /**
   * Leave a room
   */
  async leaveRoom(roomId: string): Promise<void> {
    await this.apiRequest(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      {}
    );
  }

  /**
   * Make an API request
   */
  private apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    timeout = 30000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.options.homeserver);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path,
        method,
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout,
      };

      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
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
              errorMessage = errorData.error || errorData.errcode || errorMessage;
            } catch {
              // Use status code as error
            }
            reject(new Error(errorMessage));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Get MIME type from filename
   */
  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get user ID
   */
  getUserId(): string {
    return this.options.userId;
  }
}
