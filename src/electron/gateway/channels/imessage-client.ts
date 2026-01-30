/**
 * iMessage RPC Client
 *
 * JSON-RPC client for communicating with the imsg CLI tool.
 * Based on 's implementation pattern.
 *
 * The imsg CLI (brew install steipete/tap/imsg) provides a JSON-RPC
 * interface over stdio for sending and receiving iMessages.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import * as path from 'path';
import * as os from 'os';

/**
 * JSON-RPC error structure
 */
export interface ImessageRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

/**
 * JSON-RPC response structure
 */
export interface ImessageRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: ImessageRpcError;
  method?: string;
  params?: unknown;
}

/**
 * JSON-RPC notification (no id field)
 */
export interface ImessageRpcNotification {
  method: string;
  params?: unknown;
}

/**
 * iMessage attachment information
 */
export interface ImessageAttachment {
  original_path?: string | null;
  mime_type?: string | null;
  missing?: boolean | null;
}

/**
 * iMessage payload from watch subscription
 */
export interface ImessagePayload {
  id?: number | null;
  chat_id?: number | null;
  sender?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  reply_to_id?: number | string | null;
  reply_to_text?: string | null;
  reply_to_sender?: string | null;
  created_at?: string | null;
  attachments?: ImessageAttachment[] | null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
}

/**
 * Client configuration options
 */
export interface ImessageRpcClientOptions {
  /** Path to imsg CLI (default: "imsg") */
  cliPath?: string;
  /** Path to Messages database */
  dbPath?: string;
  /** Callback for JSON-RPC notifications */
  onNotification?: (msg: ImessageRpcNotification) => void;
  /** Error logging callback */
  onError?: (message: string) => void;
}

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Send message options
 */
export interface ImessageSendOptions {
  /** Target phone number, email, or chat_id */
  to?: string;
  /** Chat ID for group chats */
  chatId?: number;
  /** Message text */
  text: string;
  /** Service preference */
  service?: 'imessage' | 'sms' | 'auto';
  /** File path for attachment */
  file?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

/**
 * Send message result
 */
export interface ImessageSendResult {
  messageId: string;
  ok?: boolean;
}

/**
 * Resolve user home path (expand ~)
 */
function resolveUserPath(inputPath: string): string {
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

/**
 * iMessage RPC Client
 *
 * Manages a JSON-RPC connection to the imsg CLI subprocess.
 */
export class ImessageRpcClient {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly onNotification?: (msg: ImessageRpcNotification) => void;
  private readonly onError?: (message: string) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;

  constructor(opts: ImessageRpcClientOptions = {}) {
    this.cliPath = opts.cliPath?.trim() || 'imsg';
    this.dbPath = opts.dbPath?.trim() ? resolveUserPath(opts.dbPath) : undefined;
    this.onNotification = opts.onNotification;
    this.onError = opts.onError;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  /**
   * Start the RPC client (spawn imsg rpc subprocess)
   */
  async start(): Promise<void> {
    if (this.child) return;

    const args = ['rpc'];
    if (this.dbPath) {
      args.push('--db', this.dbPath);
    }

    const child = spawn(this.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });

    this.reader.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed);
    });

    child.stderr?.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.onError?.(`imsg rpc stderr: ${line.trim()}`);
      }
    });

    child.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      this.closedResolve?.();
    });

    child.on('close', (code, signal) => {
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        this.failAll(new Error(`imsg rpc exited (${reason})`));
      } else {
        this.failAll(new Error('imsg rpc closed'));
      }
      this.closedResolve?.();
    });
  }

  /**
   * Stop the RPC client
   */
  async stop(): Promise<void> {
    if (!this.child) return;

    this.reader?.close();
    this.reader = null;
    this.child.stdin?.end();
    const child = this.child;
    this.child = null;

    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
          resolve();
        }, 500);
      }),
    ]);
  }

  /**
   * Wait for the client to close
   */
  async waitForClose(): Promise<void> {
    await this.closed;
  }

  /**
   * Check if the client is running
   */
  get isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Send a JSON-RPC request
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    if (!this.child || !this.child.stdin) {
      throw new Error('imsg rpc not running');
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`imsg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.child.stdin.write(line);
    return await response;
  }

  /**
   * Handle a line of output from imsg
   */
  private handleLine(line: string): void {
    // Check for known non-JSON error patterns from imsg
    if (line.startsWith('permissionDenied')) {
      const errorMsg = this.parseImsgError(line);
      this.onError?.(`imsg: ${errorMsg}`);
      this.failAll(new Error(errorMsg));
      return;
    }

    // Skip lines that don't look like JSON
    if (!line.startsWith('{') && !line.startsWith('[')) {
      // Log non-JSON output but don't treat as error
      if (line.trim()) {
        this.onError?.(`imsg output: ${line}`);
      }
      return;
    }

    let parsed: ImessageRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line) as ImessageRpcResponse<unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.onError?.(`imsg rpc: failed to parse JSON: ${detail}`);
      return;
    }

    // Response to a request (has id)
    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);

      if (parsed.error) {
        const baseMessage = parsed.error.message ?? 'imsg rpc error';
        const details = parsed.error.data;
        const code = parsed.error.code;
        const suffixes: string[] = [];
        if (typeof code === 'number') suffixes.push(`code=${code}`);
        if (details !== undefined) {
          const detailText =
            typeof details === 'string' ? details : JSON.stringify(details, null, 2);
          if (detailText) suffixes.push(detailText);
        }
        const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(' ')}` : baseMessage;
        pending.reject(new Error(msg));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    // Notification (no id, has method)
    if (parsed.method) {
      this.onNotification?.({
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  /**
   * Parse imsg error messages (non-JSON format)
   */
  private parseImsgError(line: string): string {
    // Parse patterns like: permissionDenied(path: "...", underlying: ...)
    if (line.startsWith('permissionDenied')) {
      const pathMatch = line.match(/path:\s*"([^"]+)"/);
      const path = pathMatch ? pathMatch[1] : 'unknown';

      if (line.includes('authorization denied')) {
        return `imsg needs Full Disk Access to read the Messages database. Open System Settings > Privacy & Security > Full Disk Access and enable access for your Terminal application.`;
      }
      return `Permission denied: ${path}`;
    }
    return line;
  }

  /**
   * Fail all pending requests
   */
  private failAll(err: Error): void {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}

/**
 * Create and start an iMessage RPC client
 */
export async function createImessageRpcClient(
  opts: ImessageRpcClientOptions = {}
): Promise<ImessageRpcClient> {
  const client = new ImessageRpcClient(opts);
  await client.start();
  return client;
}

/**
 * Check if imsg CLI is available
 */
export async function probeImsg(
  timeoutMs: number = 2000,
  opts: { cliPath?: string; dbPath?: string } = {}
): Promise<{ ok: boolean; error?: string; fatal?: boolean }> {
  const cliPath = opts.cliPath?.trim() || 'imsg';

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);

    const child = spawn(cliPath, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          ok: false,
          error: `imsg CLI not found at "${cliPath}". Install with: brew install steipete/tap/imsg`,
          fatal: true,
        });
      } else {
        resolve({ ok: false, error: String(err) });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `imsg exited with code ${code}` });
      }
    });
  });
}

/**
 * Normalize an iMessage handle (phone number or email)
 */
export function normalizeImessageHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return trimmed;

  // If it's an email, lowercase it
  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  // If it's a phone number, normalize to E.164 format
  // Remove any non-digit characters except leading +
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return trimmed;

  // Return with + prefix if it had one, or if it's long enough to be E.164
  if (hasPlus || digits.length >= 10) {
    return `+${digits}`;
  }

  return digits;
}

/**
 * Format a chat ID target string
 */
export function formatImessageChatTarget(chatId: number | undefined): string | undefined {
  if (chatId === undefined || chatId === null) return undefined;
  return `chat_id:${chatId}`;
}
