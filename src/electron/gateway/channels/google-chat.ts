/**
 * Google Chat Channel Adapter
 *
 * Implements the ChannelAdapter interface using Google Chat API.
 * Supports direct messages, spaces, and threaded conversations.
 *
 * Authentication: Service Account with Domain-Wide Delegation
 * Message reception: HTTP webhook or Pub/Sub subscription
 * Message sending: Google Chat REST API
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  ChannelAdapter,
  ChannelStatus,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ErrorHandler,
  StatusHandler,
  ChannelInfo,
  GoogleChatConfig,
} from './types';

/**
 * Google Chat event types
 */
interface GoogleChatEvent {
  type: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'CARD_CLICKED';
  eventTime: string;
  token?: string;
  message?: GoogleChatMessage;
  user?: GoogleChatUser;
  space?: GoogleChatSpace;
  action?: GoogleChatAction;
  configCompleteRedirectUrl?: string;
}

interface GoogleChatMessage {
  name: string;
  sender: GoogleChatUser;
  createTime: string;
  text?: string;
  formattedText?: string;
  thread?: { name: string };
  space: GoogleChatSpace;
  argumentText?: string;
  attachment?: GoogleChatAttachment[];
  slashCommand?: { commandId: string };
}

interface GoogleChatUser {
  name: string;
  displayName: string;
  avatarUrl?: string;
  email?: string;
  type: 'HUMAN' | 'BOT';
  domainId?: string;
}

interface GoogleChatSpace {
  name: string;
  type: 'ROOM' | 'DM' | 'SPACE';
  displayName?: string;
  spaceThreadingState?: string;
  singleUserBotDm?: boolean;
}

interface GoogleChatAttachment {
  name: string;
  contentName: string;
  contentType: string;
  thumbnailUri?: string;
  downloadUri?: string;
  source: 'DRIVE_FILE' | 'UPLOADED_CONTENT';
}

interface GoogleChatAction {
  actionMethodName: string;
  parameters?: Array<{ key: string; value: string }>;
}

/**
 * Simple TTL cache for message deduplication
 */
class MessageDeduplicationCache {
  private cache: Map<string, number> = new Map();
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(ttlMs: number = 60000) {
    this.ttlMs = ttlMs;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
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

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

/**
 * Google OAuth2 token manager for service account
 */
class GoogleAuthManager {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private credentials: {
    client_email: string;
    private_key: string;
    project_id: string;
  };

  constructor(credentials: { client_email: string; private_key: string; project_id: string }) {
    this.credentials = credentials;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    const jwt = this.createJWT();
    const token = await this.exchangeJWTForToken(jwt);
    this.accessToken = token.access_token;
    this.tokenExpiry = Date.now() + (token.expires_in * 1000);
    return this.accessToken;
  }

  private createJWT(): string {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/chat.bot',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.credentials.private_key, 'base64url');

    return `${signatureInput}.${signature}`;
  }

  private async exchangeJWTForToken(jwt: string): Promise<{ access_token: string; expires_in: number }> {
    return new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString();

      const options = {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(`Token exchange failed: ${parsed.error_description || parsed.error}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

export class GoogleChatAdapter implements ChannelAdapter {
  readonly type = 'googlechat' as const;

  private server: http.Server | null = null;
  private authManager: GoogleAuthManager | null = null;
  private _status: ChannelStatus = 'disconnected';
  private _botUsername?: string;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private config: GoogleChatConfig;
  private deduplicationCache: MessageDeduplicationCache;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: GoogleChatConfig) {
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
   * Connect to Google Chat via webhook server
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this.setStatus('connecting');

    try {
      // Load service account credentials
      const credentials = await this.loadCredentials();
      this.authManager = new GoogleAuthManager(credentials);

      // Verify credentials by getting a token
      await this.authManager.getAccessToken();

      // Set bot info from config
      this._botUsername = this.config.displayName || 'Google Chat Bot';

      // Start the HTTP server for receiving webhooks
      await this.startWebhookServer();

      console.log(`Google Chat bot "${this._botUsername}" is connected on port ${this.config.webhookPort || 3979}`);
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
   * Load service account credentials
   */
  private async loadCredentials(): Promise<{ client_email: string; private_key: string; project_id: string }> {
    // Check for inline credentials first
    if (this.config.serviceAccountKey) {
      return this.config.serviceAccountKey;
    }

    // Check for key file path
    if (this.config.serviceAccountKeyPath) {
      const keyPath = this.config.serviceAccountKeyPath;
      if (!fs.existsSync(keyPath)) {
        throw new Error(`Service account key file not found: ${keyPath}`);
      }
      const keyContent = fs.readFileSync(keyPath, 'utf-8');
      const key = JSON.parse(keyContent);
      return {
        client_email: key.client_email,
        private_key: key.private_key,
        project_id: key.project_id,
      };
    }

    // Check for GOOGLE_APPLICATION_CREDENTIALS environment variable
    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envPath && fs.existsSync(envPath)) {
      const keyContent = fs.readFileSync(envPath, 'utf-8');
      const key = JSON.parse(keyContent);
      return {
        client_email: key.client_email,
        private_key: key.private_key,
        project_id: key.project_id,
      };
    }

    throw new Error('Google Chat credentials not configured. Provide serviceAccountKey or serviceAccountKeyPath.');
  }

  /**
   * Start the webhook server to receive messages from Google Chat
   */
  private async startWebhookServer(): Promise<void> {
    const port = this.config.webhookPort || 3979;
    const webhookPath = this.config.webhookPath || '/googlechat/webhook';

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === webhookPath) {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', async () => {
            try {
              await this.processIncomingEvent(req, res, body);
            } catch (error) {
              console.error('Error processing Google Chat event:', error);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
            }
          });
        } else if (req.method === 'GET' && req.url === '/health') {
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
        console.log(`Google Chat webhook server listening on port ${port} at ${webhookPath}`);
        resolve();
      });
    });
  }

  /**
   * Process incoming event from Google Chat
   */
  private async processIncomingEvent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ): Promise<void> {
    try {
      const event: GoogleChatEvent = JSON.parse(body);

      // Handle different event types
      switch (event.type) {
        case 'MESSAGE':
          await this.handleMessage(event);
          // Respond with empty JSON to acknowledge
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          break;

        case 'ADDED_TO_SPACE':
          console.log(`Bot added to space: ${event.space?.displayName || event.space?.name}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: `Hello! I'm ${this._botUsername}. How can I help you today?`,
          }));
          break;

        case 'REMOVED_FROM_SPACE':
          console.log(`Bot removed from space: ${event.space?.displayName || event.space?.name}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          break;

        case 'CARD_CLICKED':
          // Handle interactive card clicks
          console.log(`Card clicked: ${event.action?.actionMethodName}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          break;

        default:
          console.log(`Unhandled Google Chat event type: ${event.type}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
      }
    } catch (error) {
      console.error('Error parsing Google Chat event:', error);
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Bad Request' }));
    }
  }

  /**
   * Handle incoming message event
   */
  private async handleMessage(event: GoogleChatEvent): Promise<void> {
    const message = event.message;
    if (!message) {
      return;
    }

    // Skip bot's own messages
    if (message.sender?.type === 'BOT') {
      return;
    }

    // Get message text (use argumentText for @mentions, otherwise use text)
    const text = message.argumentText?.trim() || message.text?.trim();
    if (!text) {
      return;
    }

    // Extract message ID from name (format: spaces/{space}/messages/{message})
    const messageId = message.name.split('/').pop() || message.name;

    // Deduplication check
    if (this.config.deduplicationEnabled !== false && this.deduplicationCache.has(messageId)) {
      console.log(`Skipping duplicate Google Chat message: ${messageId}`);
      return;
    }
    this.deduplicationCache.add(messageId);

    // Extract space ID (format: spaces/{space})
    const spaceId = message.space.name;

    // Get user info
    const userName = message.sender?.displayName || 'Unknown User';
    const userId = message.sender?.name || '';

    const isGroup = message.space.type !== 'DM';

    // Map to IncomingMessage format
    const incomingMessage: IncomingMessage = {
      messageId: messageId,
      channel: 'googlechat',
      userId: userId,
      userName: userName,
      chatId: spaceId,
      isGroup,
      text: text,
      timestamp: message.createTime ? new Date(message.createTime) : new Date(),
      threadId: message.thread?.name,
      raw: event,
    };

    console.log(`Processing Google Chat message from ${userName}: ${text.slice(0, 50)}...`);
    await this.handleIncomingMessage(incomingMessage);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.config.autoReconnect) return;

    const maxAttempts = this.config.maxReconnectAttempts || 5;
    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`Google Chat: Max reconnection attempts (${maxAttempts}) reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Google Chat: Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error('Google Chat reconnection failed:', error);
      }
    }, delay);
  }

  /**
   * Disconnect from Google Chat
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

    this.deduplicationCache.destroy();
    this.authManager = null;
    this._botUsername = undefined;
    this.setStatus('disconnected');
  }

  /**
   * Send a message to a Google Chat space
   */
  async sendMessage(message: OutgoingMessage): Promise<string> {
    if (!this.authManager || this._status !== 'connected') {
      throw new Error('Google Chat bot is not connected');
    }

    const accessToken = await this.authManager.getAccessToken();

    // Prepare message payload
    const payload: Record<string, unknown> = {
      text: message.text,
    };

    // Add thread if specified
    if (message.threadId) {
      payload.thread = { name: message.threadId };
    }

    // Build the API URL
    // Format: spaces/{space}/messages
    const apiUrl = `https://chat.googleapis.com/v1/${message.chatId}/messages`;

    try {
      const response = await this.makeApiRequest('POST', apiUrl, accessToken, payload);
      return (response.name as string) || '';
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error sending Google Chat message:', errorMessage);
      throw error;
    }
  }

  /**
   * Make an authenticated API request to Google Chat
   */
  private async makeApiRequest(
    method: string,
    url: string,
    accessToken: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const postData = body ? JSON.stringify(body) : undefined;

      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      };

      if (postData) {
        (options.headers as Record<string, string | number>)['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`API error ${res.statusCode}: ${parsed.error?.message || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`API error ${res.statusCode}: ${data}`));
            } else {
              resolve({});
            }
          }
        });
      });

      req.on('error', reject);
      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * Edit an existing message
   */
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.authManager || this._status !== 'connected') {
      throw new Error('Google Chat bot is not connected');
    }

    const accessToken = await this.authManager.getAccessToken();

    // Build the message name (format: spaces/{space}/messages/{message})
    const messageName = messageId.includes('/') ? messageId : `${chatId}/messages/${messageId}`;
    const apiUrl = `https://chat.googleapis.com/v1/${messageName}?updateMask=text`;

    const payload = { text };

    await this.makeApiRequest('PATCH', apiUrl, accessToken, payload);
  }

  /**
   * Delete a message
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.authManager || this._status !== 'connected') {
      throw new Error('Google Chat bot is not connected');
    }

    const accessToken = await this.authManager.getAccessToken();

    // Build the message name
    const messageName = messageId.includes('/') ? messageId : `${chatId}/messages/${messageId}`;
    const apiUrl = `https://chat.googleapis.com/v1/${messageName}`;

    await this.makeApiRequest('DELETE', apiUrl, accessToken);
  }

  /**
   * Send a document/file to a space
   * Note: Google Chat has limited file attachment support via API
   */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    // Google Chat API doesn't support direct file uploads
    // Files must be uploaded to Google Drive first
    // For now, send a message with the file path/name
    const fileName = path.basename(filePath);
    const message = caption ? `${caption}\n📎 ${fileName}` : `📎 ${fileName}`;

    return this.sendMessage({
      chatId,
      text: message,
    });
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
      type: 'googlechat',
      status: this._status,
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
 * Create a Google Chat adapter from configuration
 */
export function createGoogleChatAdapter(config: GoogleChatConfig): GoogleChatAdapter {
  // At least one credential source must be provided
  if (!config.serviceAccountKey && !config.serviceAccountKeyPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Google Chat requires service account credentials (serviceAccountKey, serviceAccountKeyPath, or GOOGLE_APPLICATION_CREDENTIALS)');
  }
  return new GoogleChatAdapter(config);
}
