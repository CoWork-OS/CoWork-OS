/**
 * StdioTransport - MCP transport over stdio (stdin/stdout)
 *
 * This is the primary transport for MCP servers that are launched as
 * child processes and communicate via JSON-RPC over stdin/stdout.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import {
  MCPTransport,
  MCPServerConfig,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from "../../types";
import { createLogger } from "../../../utils/logger";

interface PendingRequest {
  resolve: (result: Any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const logger = createLogger("MCP StdioTransport");

const STDERR_REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },
  { pattern: /("(?:access_token|refresh_token|api_key|apiKey|secret_key|client_secret|password|token)":\s*")([^"]{8,})(")/gi, replacement: "$1[REDACTED]$3" },
  { pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
];

function redactStderr(text: string): string {
  let out = text;
  for (const { pattern, replacement } of STDERR_REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

interface NormalizedStdioSpawnCommand {
  command: string;
  args: string[];
  shell: boolean;
}

const WINDOWS_CMD_SHIM_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "yarnpkg"]);

export function splitStdioCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (char === "\\" && (next === '"' || next === "'" || /\s/.test(next || ""))) {
      current += next;
      index++;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function shouldSplitInlineCommand(command: string, args: string[]): boolean {
  const trimmed = command.trim();
  if (args.length > 0 || !/\s/.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return true;
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] || "";
  if (/^[A-Za-z]:[\\/]/.test(firstToken) || firstToken.includes("/") || firstToken.includes("\\")) {
    return false;
  }

  return true;
}

function shouldUseWindowsShell(command: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") {
    return false;
  }

  const baseName = path.win32.basename(command).toLowerCase();
  if (baseName.endsWith(".cmd") || baseName.endsWith(".bat")) {
    return true;
  }

  const extension = path.win32.extname(baseName);
  const commandName = extension ? baseName.slice(0, -extension.length) : baseName;
  return WINDOWS_CMD_SHIM_COMMANDS.has(commandName);
}

export function normalizeStdioSpawnCommand(
  command: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
): NormalizedStdioSpawnCommand {
  const trimmedCommand = command.trim();
  let resolvedCommand = trimmedCommand;
  let resolvedArgs = [...args];

  if (shouldSplitInlineCommand(trimmedCommand, resolvedArgs)) {
    const parts = splitStdioCommandLine(trimmedCommand);
    if (parts.length > 1) {
      resolvedCommand = parts[0];
      resolvedArgs = [...parts.slice(1), ...resolvedArgs];
    }
  }

  return {
    command: resolvedCommand,
    args: resolvedArgs,
    shell: shouldUseWindowsShell(resolvedCommand, platform),
  };
}

export class StdioTransport extends EventEmitter implements MCPTransport {
  private process: ChildProcess | null = null;
  private config: MCPServerConfig;
  private messageHandler: ((message: JSONRPCResponse | JSONRPCNotification) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private pendingRequests: Map<string | number, PendingRequest> = new Map();
  private buffer = "";
  private stderrBuffer = ""; // Capture stderr for better error messages
  private connected = false;
  private requestId = 0;
  private lastCloseError: Error | null = null;

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the MCP server by spawning the process
   */
  async connect(): Promise<void> {
    if (this.connected || this.process) {
      throw new Error("Already connected");
    }

    const { command, args = [], env, cwd } = this.config;

    if (!command) {
      throw new Error("No command specified for stdio transport");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup();
        reject(
          new Error(
            `Connection timeout: server did not respond within ${this.config.connectionTimeout || 30000}ms`,
          ),
        );
      }, this.config.connectionTimeout || 30000);

      try {
        // Merge environment variables
        const processEnv = {
          ...process.env,
          ...env,
        };

        // Substitute ${VAR} in args with env values (for connectors that require CLI args)
        const resolvedArgs = args.map((arg) => {
          if (typeof arg === "string" && /^\$\{[^}]+\}$/.test(arg)) {
            const varName = arg.slice(2, -1);
            return processEnv[varName] ?? arg;
          }
          return arg;
        });
        const spawnCommand = normalizeStdioSpawnCommand(command, resolvedArgs);

        // When launching via Electron's executable with --runAsNode, force pure
        // Node mode so macOS doesn't treat child connector processes as GUI apps.
        if (spawnCommand.command === process.execPath && spawnCommand.args.includes("--runAsNode")) {
          processEnv.ELECTRON_RUN_AS_NODE = "1";
        }

        this.lastCloseError = null;
        logger.debug(
          `Spawning: ${spawnCommand.command} ${spawnCommand.args.join(" ")}${
            spawnCommand.shell ? " (shell)" : ""
          }`,
        );

        this.process = spawn(spawnCommand.command, spawnCommand.args, {
          cwd: cwd || process.cwd(),
          env: processEnv,
          stdio: ["pipe", "pipe", "pipe"],
          shell: spawnCommand.shell,
        });

        // Handle stdout (JSON-RPC messages from server)
        this.process.stdout?.on("data", (data: Buffer) => {
          this.handleData(data);
        });

        // Handle stderr (logging/errors from server)
        this.process.stderr?.on("data", (data: Buffer) => {
          const text = redactStderr(data.toString());
          logger.debug(`Server stderr: ${text}`);
          // Capture stderr for better error messages (limit to last 1000 chars)
          this.stderrBuffer += text;
          if (this.stderrBuffer.length > 1000) {
            this.stderrBuffer = this.stderrBuffer.slice(-1000);
          }
        });

        // Handle process errors
        this.process.on("error", (error) => {
          clearTimeout(timeout);
          this.lastCloseError = error;
          logger.error("Process error:", error);
          this.errorHandler?.(error);
          if (!this.connected) {
            reject(error);
          }
          this.cleanup();
        });

        // Handle process exit
        this.process.on("exit", (code, signal) => {
          clearTimeout(timeout);
          // Build error message including stderr output for better diagnostics
          let message = `Process exited with code ${code}`;
          if (signal) {
            message += `, signal ${signal}`;
          }
          // Include stderr in error message if there was an error exit
          if (code !== 0 && this.stderrBuffer.trim()) {
            const stderrSnippet = this.stderrBuffer.trim().slice(-500); // Last 500 chars
            message += `: ${stderrSnippet}`;
          }
          const exitError = new Error(message);
          this.lastCloseError = exitError;
          if (code === 0) {
            logger.debug(message);
          } else {
            logger.warn(message);
          }

          if (!this.connected) {
            reject(exitError);
          } else {
            this.closeHandler?.(code !== 0 ? exitError : undefined);
          }
          this.cleanup();
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (this.connected) {
            let message = `Process closed with code ${code}`;
            if (code !== 0 && this.stderrBuffer.trim()) {
              const stderrSnippet = this.stderrBuffer.trim().slice(-500);
              message += `: ${stderrSnippet}`;
            }
            const closeError = code !== 0 ? new Error(message) : undefined;
            this.lastCloseError = closeError || null;
            this.closeHandler?.(closeError);
          }
          this.cleanup();
        });

        // Mark as connected once process is spawned
        // The actual MCP handshake will be done by MCPServerConnection
        this.connected = true;
        clearTimeout(timeout);
        logger.debug("Process spawned successfully");
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        logger.error("Failed to spawn process:", error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    logger.debug("Disconnecting...");

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Transport disconnected"));
    }
    this.pendingRequests.clear();

    // Try graceful shutdown first
    if (this.process.stdin?.writable) {
      try {
        this.process.stdin.end();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Give process time to exit gracefully
    await new Promise<void>((resolve) => {
      const forceKillTimeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          logger.warn("Force killing process");
          this.process.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      if (this.process) {
        this.process.once("exit", () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });

        // Send SIGTERM first
        this.process.kill("SIGTERM");
      } else {
        clearTimeout(forceKillTimeout);
        resolve();
      }
    });

    this.cleanup();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest(method: string, params?: Record<string, Any>): Promise<Any> {
    if (!this.connected || !this.process?.stdin?.writable) {
      throw new Error(
        this.lastCloseError ? `Not connected: ${this.lastCloseError.message}` : "Not connected",
      );
    }

    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${method}`));
      }, this.config.requestTimeout || 60000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        const message = JSON.stringify(request) + "\n";
        this.process!.stdin!.write(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Send a JSON-RPC message (request or notification)
   */
  async send(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (!this.connected || !this.process?.stdin?.writable) {
      throw new Error(
        this.lastCloseError ? `Not connected: ${this.lastCloseError.message}` : "Not connected",
      );
    }

    try {
      const data = JSON.stringify(message) + "\n";
      this.process.stdin.write(data);
    } catch (error) {
      throw new Error(`Failed to send message: ${error}`);
    }
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: JSONRPCResponse | JSONRPCNotification) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register close handler
   */
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Register error handler
   */
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Check if transport is connected
   */
  isConnected(): boolean {
    return this.connected && !!this.process && !this.process.killed;
  }

  /**
   * Handle incoming data from stdout
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete lines (JSON-RPC messages are newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch  {
          logger.warn(`Failed to parse message: ${line}`);
        }
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: Any): void {
    // Check if this is a response to a pending request
    if ("id" in message && message.id !== null) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if ("error" in message && message.error) {
          pending.reject(new Error(message.error.message || "Unknown error"));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    // Otherwise, pass to message handler (notifications)
    this.messageHandler?.(message as JSONRPCResponse | JSONRPCNotification);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.connected = false;
    this.buffer = "";
    this.stderrBuffer = "";

    // Reject all pending requests so callers don't hang forever
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(this.lastCloseError || new Error("Transport closed"));
    }
    this.pendingRequests.clear();

    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process = null;
    }
  }
}
