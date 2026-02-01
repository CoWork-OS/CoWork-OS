/**
 * Signal Client
 *
 * Wrapper around signal-cli for sending and receiving Signal messages.
 * Supports multiple modes:
 * - Native: Direct CLI invocation (simplest, slower)
 * - JSON-RPC: Socket-based communication (faster, requires daemon)
 * - D-Bus: Linux D-Bus integration (Linux only)
 *
 * Requirements:
 * - signal-cli installed (https://github.com/AsamK/signal-cli)
 * - Phone number registered with Signal
 *
 * Installation:
 *   brew install signal-cli (macOS)
 *   apt install signal-cli (Ubuntu/Debian)
 *   Or download from GitHub releases
 */

import { spawn, ChildProcess, execSync, exec } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as readline from 'readline';

/**
 * Signal message types
 */
export interface SignalMessage {
  /** Message envelope */
  envelope: SignalEnvelope;
  /** Account that received the message */
  account: string;
}

export interface SignalEnvelope {
  /** Source phone number */
  source: string;
  /** Source UUID */
  sourceUuid?: string;
  /** Source device ID */
  sourceDevice?: number;
  /** Timestamp (milliseconds) */
  timestamp: number;
  /** Data message (if present) */
  dataMessage?: SignalDataMessage;
  /** Sync message (if present) */
  syncMessage?: SignalSyncMessage;
  /** Receipt message (if present) */
  receiptMessage?: SignalReceiptMessage;
  /** Typing message (if present) */
  typingMessage?: SignalTypingMessage;
}

export interface SignalDataMessage {
  /** Message timestamp */
  timestamp: number;
  /** Message body text */
  message?: string;
  /** Expiration timer (seconds) */
  expiresInSeconds?: number;
  /** Attachments */
  attachments?: SignalAttachment[];
  /** Group info (v2) */
  groupInfo?: SignalGroupInfo;
  /** Quote (reply) */
  quote?: SignalQuote;
  /** Mentions */
  mentions?: SignalMention[];
  /** Reaction */
  reaction?: SignalReaction;
  /** Remote delete */
  remoteDelete?: { timestamp: number };
}

export interface SignalSyncMessage {
  /** Sent message sync */
  sentMessage?: {
    destination?: string;
    destinationUuid?: string;
    timestamp: number;
    message?: string;
    expiresInSeconds?: number;
    attachments?: SignalAttachment[];
    groupInfo?: SignalGroupInfo;
  };
  /** Read receipts sync */
  readMessages?: Array<{ sender: string; timestamp: number }>;
}

export interface SignalReceiptMessage {
  /** When the receipts were created */
  when: number;
  /** Whether delivered */
  isDelivery: boolean;
  /** Whether read */
  isRead: boolean;
  /** Whether viewed */
  isViewed: boolean;
  /** Timestamps of messages */
  timestamps: number[];
}

export interface SignalTypingMessage {
  /** Typing action */
  action: 'STARTED' | 'STOPPED';
  /** Timestamp */
  timestamp: number;
  /** Group ID (if in group) */
  groupId?: string;
}

export interface SignalAttachment {
  /** Content type */
  contentType: string;
  /** Filename */
  filename?: string;
  /** Attachment ID */
  id: string;
  /** Size in bytes */
  size: number;
  /** Width (for images/videos) */
  width?: number;
  /** Height (for images/videos) */
  height?: number;
  /** Caption */
  caption?: string;
  /** Local file path (after download) */
  localPath?: string;
}

export interface SignalGroupInfo {
  /** Group ID (base64) */
  groupId: string;
  /** Group type (v2) */
  type?: string;
}

export interface SignalQuote {
  /** Quoted message ID */
  id: number;
  /** Author of quoted message */
  author: string;
  /** Quoted text */
  text?: string;
  /** Quoted attachments */
  attachments?: SignalAttachment[];
  /** Mentions in quote */
  mentions?: SignalMention[];
}

export interface SignalMention {
  /** Start position */
  start: number;
  /** Length */
  length: number;
  /** UUID of mentioned user */
  uuid: string;
}

export interface SignalReaction {
  /** Emoji */
  emoji: string;
  /** Target author */
  targetAuthor: string;
  /** Target timestamp */
  targetSentTimestamp: number;
  /** Is removal */
  isRemove: boolean;
}

/**
 * Signal CLI client options
 */
export interface SignalClientOptions {
  /** Phone number (E.164 format) */
  phoneNumber: string;
  /** Path to signal-cli executable */
  cliPath?: string;
  /** signal-cli data directory */
  dataDir?: string;
  /** Communication mode */
  mode?: 'native' | 'json-rpc' | 'dbus';
  /** JSON-RPC socket path */
  socketPath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Signal client events
 */
export interface SignalClientEvents {
  message: (message: SignalMessage) => void;
  receipt: (receipt: SignalReceiptMessage, source: string) => void;
  typing: (typing: SignalTypingMessage, source: string) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * Signal CLI Client
 */
export class SignalClient extends EventEmitter {
  private options: Required<SignalClientOptions>;
  private receiveProcess?: ChildProcess;
  private jsonRpcSocket?: net.Socket;
  private jsonRpcId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private messageBuffer = '';

  constructor(options: SignalClientOptions) {
    super();

    this.options = {
      phoneNumber: options.phoneNumber,
      cliPath: options.cliPath || 'signal-cli',
      dataDir: options.dataDir || path.join(process.env.HOME || '', '.local', 'share', 'signal-cli'),
      mode: options.mode || 'native',
      socketPath: options.socketPath || '/tmp/signal-cli.socket',
      verbose: options.verbose || false,
    };
  }

  /**
   * Check if signal-cli is installed and accessible
   */
  async checkInstallation(): Promise<{ installed: boolean; version?: string; error?: string }> {
    try {
      const result = execSync(`${this.options.cliPath} --version`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const version = result.trim().split('\n')[0];
      return { installed: true, version };
    } catch (error) {
      return {
        installed: false,
        error: `signal-cli not found at ${this.options.cliPath}. Install with: brew install signal-cli (macOS) or download from GitHub.`,
      };
    }
  }

  /**
   * Check if the phone number is registered
   */
  async checkRegistration(): Promise<{ registered: boolean; error?: string }> {
    try {
      const accountPath = path.join(this.options.dataDir, 'data', this.options.phoneNumber);
      if (!fs.existsSync(accountPath)) {
        return {
          registered: false,
          error: `Account not registered. Run: signal-cli -a ${this.options.phoneNumber} register`,
        };
      }
      return { registered: true };
    } catch (error) {
      return {
        registered: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Start receiving messages
   */
  async startReceiving(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.options.mode === 'json-rpc') {
      await this.startJsonRpcReceiving();
    } else {
      await this.startNativeReceiving();
    }
  }

  /**
   * Start native mode receiving (spawns signal-cli receive)
   */
  private async startNativeReceiving(): Promise<void> {
    const args = [
      '-a', this.options.phoneNumber,
      '--output', 'json',
      'receive',
      '--timeout', '-1', // Infinite timeout
    ];

    if (this.options.verbose) {
      console.log(`Starting signal-cli: ${this.options.cliPath} ${args.join(' ')}`);
    }

    this.receiveProcess = spawn(this.options.cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Handle stdout (messages)
    if (this.receiveProcess.stdout) {
      const rl = readline.createInterface({
        input: this.receiveProcess.stdout,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        this.handleJsonLine(line);
      });
    }

    // Handle stderr (errors/logs)
    if (this.receiveProcess.stderr) {
      this.receiveProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message && this.options.verbose) {
          console.log('[signal-cli]', message);
        }
      });
    }

    // Handle process exit
    this.receiveProcess.on('exit', (code, signal) => {
      this.connected = false;
      this.emit('disconnected');

      if (code !== 0 && code !== null) {
        console.error(`signal-cli exited with code ${code}`);
        // Attempt reconnection
        this.scheduleReconnect();
      }
    });

    this.receiveProcess.on('error', (error) => {
      this.emit('error', error);
    });

    this.connected = true;
    this.emit('connected');
  }

  /**
   * Start JSON-RPC mode receiving
   */
  private async startJsonRpcReceiving(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.jsonRpcSocket = net.createConnection(this.options.socketPath, () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.jsonRpcSocket.on('data', (data) => {
        this.messageBuffer += data.toString();

        // Process complete JSON lines
        let newlineIndex;
        while ((newlineIndex = this.messageBuffer.indexOf('\n')) !== -1) {
          const line = this.messageBuffer.substring(0, newlineIndex);
          this.messageBuffer = this.messageBuffer.substring(newlineIndex + 1);

          if (line.trim()) {
            this.handleJsonRpcResponse(line);
          }
        }
      });

      this.jsonRpcSocket.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.jsonRpcSocket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        this.scheduleReconnect();
      });
    });
  }

  /**
   * Handle a line of JSON output from signal-cli
   */
  private handleJsonLine(line: string): void {
    try {
      const data = JSON.parse(line);

      if (data.envelope) {
        const message: SignalMessage = {
          envelope: data.envelope,
          account: data.account || this.options.phoneNumber,
        };

        // Route to appropriate handler
        if (data.envelope.dataMessage) {
          this.emit('message', message);
        } else if (data.envelope.receiptMessage) {
          this.emit('receipt', data.envelope.receiptMessage, data.envelope.source);
        } else if (data.envelope.typingMessage) {
          this.emit('typing', data.envelope.typingMessage, data.envelope.source);
        }
      }
    } catch (error) {
      if (this.options.verbose) {
        console.error('Failed to parse signal-cli output:', line, error);
      }
    }
  }

  /**
   * Handle JSON-RPC response
   */
  private handleJsonRpcResponse(line: string): void {
    try {
      const data = JSON.parse(line);

      // Check if it's a response to a request
      if (data.id !== undefined && this.pendingRequests.has(data.id)) {
        const { resolve, reject } = this.pendingRequests.get(data.id)!;
        this.pendingRequests.delete(data.id);

        if (data.error) {
          reject(new Error(data.error.message || 'Unknown error'));
        } else {
          resolve(data.result);
        }
        return;
      }

      // Otherwise treat as event/message
      if (data.method === 'receive' && data.params) {
        this.handleJsonLine(JSON.stringify(data.params));
      }
    } catch (error) {
      if (this.options.verbose) {
        console.error('Failed to parse JSON-RPC response:', line, error);
      }
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
        console.error('Reconnection failed:', error);
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

    if (this.receiveProcess) {
      this.receiveProcess.kill('SIGTERM');
      this.receiveProcess = undefined;
    }

    if (this.jsonRpcSocket) {
      this.jsonRpcSocket.destroy();
      this.jsonRpcSocket = undefined;
    }

    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message
   */
  async sendMessage(
    recipient: string,
    message: string,
    options?: {
      attachments?: string[];
      quote?: { timestamp: number; author: string };
      groupId?: string;
    }
  ): Promise<{ timestamp: number }> {
    const args = [
      '-a', this.options.phoneNumber,
      '--output', 'json',
      'send',
    ];

    if (options?.groupId) {
      args.push('-g', options.groupId);
    } else {
      args.push(recipient);
    }

    args.push('-m', message);

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        args.push('-a', attachment);
      }
    }

    if (options?.quote) {
      args.push('--quote-timestamp', options.quote.timestamp.toString());
      args.push('--quote-author', options.quote.author);
    }

    const result = await this.execCommand(args);

    // Parse timestamp from result
    try {
      const data = JSON.parse(result);
      return { timestamp: data.timestamp || Date.now() };
    } catch {
      return { timestamp: Date.now() };
    }
  }

  /**
   * Send a reaction
   */
  async sendReaction(
    recipient: string,
    emoji: string,
    targetAuthor: string,
    targetTimestamp: number,
    remove = false
  ): Promise<void> {
    const args = [
      '-a', this.options.phoneNumber,
      'sendReaction',
      recipient,
      '-e', emoji,
      '-a', targetAuthor,
      '-t', targetTimestamp.toString(),
    ];

    if (remove) {
      args.push('-r');
    }

    await this.execCommand(args);
  }

  /**
   * Send typing indicator
   */
  async sendTyping(recipient: string, stop = false): Promise<void> {
    const args = [
      '-a', this.options.phoneNumber,
      'sendTyping',
      recipient,
    ];

    if (stop) {
      args.push('-s');
    }

    await this.execCommand(args);
  }

  /**
   * Send read receipt
   */
  async sendReadReceipt(sender: string, timestamps: number[]): Promise<void> {
    const args = [
      '-a', this.options.phoneNumber,
      'sendReceipt',
      '--type', 'read',
      sender,
      '-t', ...timestamps.map(String),
    ];

    await this.execCommand(args);
  }

  /**
   * Get contacts
   */
  async getContacts(): Promise<Array<{ number: string; name?: string; uuid?: string }>> {
    const args = [
      '-a', this.options.phoneNumber,
      '--output', 'json',
      'listContacts',
    ];

    const result = await this.execCommand(args);

    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }

  /**
   * Get groups
   */
  async getGroups(): Promise<Array<{ id: string; name: string; members: string[] }>> {
    const args = [
      '-a', this.options.phoneNumber,
      '--output', 'json',
      'listGroups',
      '-d',
    ];

    const result = await this.execCommand(args);

    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }

  /**
   * Trust a contact's identity
   */
  async trustIdentity(phoneNumber: string, trustAllKnownKeys = false): Promise<void> {
    const args = [
      '-a', this.options.phoneNumber,
      'trust',
      phoneNumber,
    ];

    if (trustAllKnownKeys) {
      args.push('-a');
    }

    await this.execCommand(args);
  }

  /**
   * Download an attachment
   */
  async downloadAttachment(attachmentId: string, outputPath: string): Promise<string> {
    // Attachments are automatically downloaded to the data directory
    const attachmentPath = path.join(
      this.options.dataDir,
      'attachments',
      attachmentId
    );

    if (fs.existsSync(attachmentPath)) {
      // Copy to output path if different
      if (attachmentPath !== outputPath) {
        fs.copyFileSync(attachmentPath, outputPath);
      }
      return outputPath;
    }

    throw new Error(`Attachment not found: ${attachmentId}`);
  }

  /**
   * Execute a signal-cli command
   */
  private execCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullArgs = [...args];

      if (this.options.verbose) {
        console.log(`Executing: ${this.options.cliPath} ${fullArgs.join(' ')}`);
      }

      exec(`${this.options.cliPath} ${fullArgs.map(a => `"${a}"`).join(' ')}`, {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get phone number
   */
  getPhoneNumber(): string {
    return this.options.phoneNumber;
  }
}
