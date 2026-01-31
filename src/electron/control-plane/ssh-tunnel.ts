/**
 * SSH Tunnel Manager
 *
 * Creates and manages SSH tunnels for remote Control Plane connections.
 * Uses the system's ssh command to establish port forwarding.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import type {
  SSHTunnelConfig,
  SSHTunnelStatus,
  SSHTunnelState,
} from '../../shared/types';

/**
 * Default SSH tunnel configuration
 */
export const DEFAULT_SSH_TUNNEL_CONFIG: SSHTunnelConfig = {
  enabled: false,
  host: '',
  sshPort: 22,
  username: '',
  keyPath: undefined,
  localPort: 18789,
  remotePort: 18789,
  remoteBindAddress: '127.0.0.1',
  autoReconnect: true,
  reconnectDelayMs: 5000,
  maxReconnectAttempts: 10,
  connectionTimeoutMs: 30000,
};

/**
 * SSH Tunnel Manager events
 */
export interface SSHTunnelEvents {
  stateChange: (state: SSHTunnelState, error?: string) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  output: (data: string) => void;
}

/**
 * SSH Tunnel Manager
 *
 * Creates SSH tunnels using the system's ssh command.
 * Supports automatic reconnection and health monitoring.
 */
export class SSHTunnelManager extends EventEmitter {
  private config: SSHTunnelConfig;
  private state: SSHTunnelState = 'disconnected';
  private sshProcess: ChildProcess | null = null;
  private connectedAt: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private isShuttingDown = false;

  constructor(config: Partial<SSHTunnelConfig>) {
    super();
    this.config = {
      ...DEFAULT_SSH_TUNNEL_CONFIG,
      ...config,
    };
  }

  /**
   * Get current tunnel status
   */
  getStatus(): SSHTunnelStatus {
    return {
      state: this.state,
      config: {
        host: this.config.host,
        sshPort: this.config.sshPort,
        username: this.config.username,
        localPort: this.config.localPort,
        remotePort: this.config.remotePort,
        enabled: this.config.enabled,
      },
      connectedAt: this.connectedAt ?? undefined,
      error: this.lastError ?? undefined,
      reconnectAttempts: this.reconnectAttempts > 0 ? this.reconnectAttempts : undefined,
      pid: this.sshProcess?.pid,
      localEndpoint: this.state === 'connected'
        ? `ws://127.0.0.1:${this.config.localPort}`
        : undefined,
    };
  }

  /**
   * Get the local WebSocket URL for the tunnel
   */
  getLocalUrl(): string {
    return `ws://127.0.0.1:${this.config.localPort}`;
  }

  /**
   * Update configuration (disconnects if connected)
   */
  updateConfig(config: Partial<SSHTunnelConfig>): void {
    const wasConnected = this.state === 'connected';
    if (wasConnected) {
      this.disconnect();
    }

    this.config = {
      ...this.config,
      ...config,
    };

    // Reconnect if was connected and still enabled
    if (wasConnected && this.config.enabled) {
      this.connect();
    }
  }

  /**
   * Connect the SSH tunnel
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      console.log('[SSHTunnel] Already connected or connecting');
      return;
    }

    if (!this.validateConfig()) {
      const error = new Error('Invalid SSH tunnel configuration');
      this.lastError = error.message;
      this.setState('error');
      throw error;
    }

    this.isShuttingDown = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  /**
   * Disconnect the SSH tunnel
   */
  disconnect(): void {
    this.isShuttingDown = true;
    this.clearReconnectTimer();
    this.clearHealthCheckTimer();

    if (this.sshProcess) {
      console.log(`[SSHTunnel] Terminating SSH process (PID: ${this.sshProcess.pid})`);
      this.sshProcess.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (this.sshProcess && !this.sshProcess.killed) {
          console.log('[SSHTunnel] Force killing SSH process');
          this.sshProcess.kill('SIGKILL');
        }
      }, 5000);

      this.sshProcess = null;
    }

    this.connectedAt = null;
    this.lastError = null;
    this.setState('disconnected');
    this.emit('disconnected', 'User requested disconnect');
    console.log('[SSHTunnel] Disconnected');
  }

  /**
   * Test SSH connectivity without establishing a tunnel
   */
  async testConnection(): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const args = this.buildSSHArgs(true); // Test mode
      console.log('[SSHTunnel] Testing connection:', this.maskCommand(args));

      const testProcess = spawn('ssh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
      });

      const timeout = setTimeout(() => {
        testProcess.kill('SIGTERM');
        resolve({ success: false, error: 'Connection timeout' });
      }, this.config.connectionTimeoutMs || 30000);

      let stderrOutput = '';

      testProcess.stderr?.on('data', (data) => {
        stderrOutput += data.toString();
      });

      testProcess.on('close', (code) => {
        clearTimeout(timeout);
        const latencyMs = Date.now() - startTime;

        if (code === 0) {
          resolve({ success: true, latencyMs });
        } else {
          resolve({
            success: false,
            error: this.parseSSHError(stderrOutput) || `SSH exited with code ${code}`,
          });
        }
      });

      testProcess.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: error.message });
      });
    });
  }

  // ===== Private Methods =====

  private validateConfig(): boolean {
    if (!this.config.host || !this.config.host.trim()) {
      this.lastError = 'SSH host is required';
      return false;
    }

    if (!this.config.username || !this.config.username.trim()) {
      this.lastError = 'SSH username is required';
      return false;
    }

    if (this.config.keyPath) {
      const keyPath = this.expandPath(this.config.keyPath);
      if (!fs.existsSync(keyPath)) {
        this.lastError = `SSH key file not found: ${this.config.keyPath}`;
        return false;
      }
    }

    return true;
  }

  private async doConnect(): Promise<void> {
    this.setState('connecting');

    return new Promise((resolve, reject) => {
      try {
        const args = this.buildSSHArgs(false);
        console.log('[SSHTunnel] Connecting:', this.maskCommand(args));

        this.sshProcess = spawn('ssh', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
          detached: false,
        });

        let stderrBuffer = '';
        let connected = false;

        // Connection timeout
        const connectionTimeout = setTimeout(() => {
          if (!connected && this.sshProcess) {
            this.sshProcess.kill('SIGTERM');
            const error = new Error('SSH connection timeout');
            this.lastError = error.message;
            this.setState('error');
            reject(error);
          }
        }, this.config.connectionTimeoutMs || 30000);

        this.sshProcess.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrBuffer += output;
          this.emit('output', output);

          // Check for successful connection indicators
          if (!connected && this.isConnectionEstablished(stderrBuffer)) {
            connected = true;
            clearTimeout(connectionTimeout);
            this.onConnected();
            resolve();
          }

          // Check for authentication failures
          if (this.isAuthFailure(stderrBuffer)) {
            clearTimeout(connectionTimeout);
            const error = new Error('SSH authentication failed');
            this.lastError = error.message;
            this.setState('error');
            this.sshProcess?.kill('SIGTERM');
            reject(error);
          }
        });

        this.sshProcess.stdout?.on('data', (data) => {
          this.emit('output', data.toString());
        });

        this.sshProcess.on('close', (code, signal) => {
          clearTimeout(connectionTimeout);

          if (connected) {
            console.log(`[SSHTunnel] Connection closed: code=${code}, signal=${signal}`);
            this.handleDisconnect(code, signal);
          } else if (!this.isShuttingDown) {
            const error = new Error(
              this.parseSSHError(stderrBuffer) || `SSH failed with code ${code}`
            );
            this.lastError = error.message;
            this.setState('error');
            reject(error);
          }
        });

        this.sshProcess.on('error', (error) => {
          clearTimeout(connectionTimeout);
          console.error('[SSHTunnel] Process error:', error);
          this.lastError = error.message;
          this.setState('error');
          this.emit('error', error);
          reject(error);
        });

        // For tunnels, we also verify by checking if the local port becomes available
        this.waitForLocalPort()
          .then(() => {
            if (!connected) {
              connected = true;
              clearTimeout(connectionTimeout);
              this.onConnected();
              resolve();
            }
          })
          .catch(() => {
            // Port check failed, but SSH might still work via stderr
          });

      } catch (error: any) {
        this.lastError = error.message;
        this.setState('error');
        reject(error);
      }
    });
  }

  private buildSSHArgs(testMode: boolean): string[] {
    const args: string[] = [];

    // SSH options
    args.push('-o', 'BatchMode=yes'); // No interactive prompts
    args.push('-o', 'StrictHostKeyChecking=accept-new'); // Accept new hosts
    args.push('-o', 'ServerAliveInterval=30'); // Keepalive
    args.push('-o', 'ServerAliveCountMax=3'); // Disconnect after 3 missed keepalives
    args.push('-o', 'ExitOnForwardFailure=yes'); // Exit if tunnel fails
    args.push('-o', 'ConnectTimeout=30'); // Connection timeout

    // Verbose mode for debugging (shows when tunnel is ready)
    args.push('-v');

    // SSH key if specified
    if (this.config.keyPath) {
      args.push('-i', this.expandPath(this.config.keyPath));
    }

    // SSH port
    if (this.config.sshPort !== 22) {
      args.push('-p', String(this.config.sshPort));
    }

    if (testMode) {
      // Test mode: just verify connection and exit
      args.push('-o', 'PasswordAuthentication=no');
      args.push(`${this.config.username}@${this.config.host}`);
      args.push('exit');
    } else {
      // Tunnel mode: don't execute remote command, just forward
      args.push('-N');

      // Local port forwarding: -L localPort:remoteBindAddress:remotePort
      const remoteBindAddress = this.config.remoteBindAddress || '127.0.0.1';
      args.push(
        '-L',
        `${this.config.localPort}:${remoteBindAddress}:${this.config.remotePort}`
      );

      // User@host
      args.push(`${this.config.username}@${this.config.host}`);
    }

    return args;
  }

  private maskCommand(args: string[]): string {
    // Mask sensitive parts for logging
    return `ssh ${args.join(' ')}`;
  }

  private expandPath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
  }

  private isConnectionEstablished(output: string): boolean {
    // SSH verbose output indicators that connection is ready
    return (
      output.includes('Entering interactive session') ||
      output.includes('Local forwarding listening') ||
      output.includes('Local connections to LOCALHOST:') ||
      output.includes('channel 0: new')
    );
  }

  private isAuthFailure(output: string): boolean {
    return (
      output.includes('Permission denied') ||
      output.includes('Authentication failed') ||
      output.includes('Too many authentication failures')
    );
  }

  private parseSSHError(output: string): string | null {
    // Extract meaningful error messages from SSH output
    const errorPatterns = [
      /Permission denied.*$/m,
      /Connection refused/,
      /Connection timed out/,
      /No route to host/,
      /Could not resolve hostname/,
      /Host key verification failed/,
      /Connection closed by remote host/,
      /Network is unreachable/,
      /Address already in use/,
    ];

    for (const pattern of errorPatterns) {
      const match = output.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return null;
  }

  private async waitForLocalPort(): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 500;

    for (let i = 0; i < maxAttempts; i++) {
      if (await this.isPortOpen(this.config.localPort)) {
        return;
      }
      await this.delay(delayMs);
    }

    throw new Error('Local port did not become available');
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private onConnected(): void {
    this.connectedAt = Date.now();
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.setState('connected');
    this.startHealthCheck();
    this.emit('connected');
    console.log(
      `[SSHTunnel] Connected - Local endpoint: ws://127.0.0.1:${this.config.localPort}`
    );
  }

  private handleDisconnect(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearHealthCheckTimer();
    this.sshProcess = null;
    this.connectedAt = null;

    if (this.isShuttingDown) {
      this.setState('disconnected');
      return;
    }

    // Attempt reconnection if configured
    if (
      this.config.autoReconnect &&
      code !== 0 && // Not a clean exit
      (this.config.maxReconnectAttempts === 0 ||
        this.reconnectAttempts < (this.config.maxReconnectAttempts || 10))
    ) {
      this.scheduleReconnect();
    } else {
      this.setState('disconnected');
      this.emit('disconnected', `SSH exited: code=${code}, signal=${signal}`);
    }
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff
    const baseDelay = this.config.reconnectDelayMs || 5000;
    const delay = Math.min(baseDelay * Math.pow(1.5, this.reconnectAttempts - 1), 60000);

    console.log(
      `[SSHTunnel] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch((error) => {
        console.error('[SSHTunnel] Reconnection failed:', error.message);
        if (
          this.config.maxReconnectAttempts !== 0 &&
          this.reconnectAttempts >= (this.config.maxReconnectAttempts || 10)
        ) {
          this.lastError = 'Max reconnection attempts reached';
          this.setState('error');
          this.emit('error', new Error(this.lastError));
        }
      });
    }, delay);
  }

  private startHealthCheck(): void {
    // Periodically verify the tunnel is still working
    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== 'connected') return;

      const isOpen = await this.isPortOpen(this.config.localPort);
      if (!isOpen) {
        console.warn('[SSHTunnel] Health check failed - tunnel port not responding');
        // The SSH process should exit and trigger reconnect
        if (this.sshProcess) {
          this.sshProcess.kill('SIGTERM');
        }
      }
    }, 30000);
  }

  private setState(state: SSHTunnelState): void {
    if (this.state !== state) {
      this.state = state;
      console.log(`[SSHTunnel] State: ${state}${this.lastError ? ` (${this.lastError})` : ''}`);
      this.emit('stateChange', state, this.lastError ?? undefined);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

// Singleton instance
let sshTunnelManager: SSHTunnelManager | null = null;

/**
 * Get the SSH tunnel manager instance
 */
export function getSSHTunnelManager(): SSHTunnelManager | null {
  return sshTunnelManager;
}

/**
 * Initialize the SSH tunnel manager with config
 */
export function initSSHTunnelManager(config: Partial<SSHTunnelConfig>): SSHTunnelManager {
  if (sshTunnelManager) {
    sshTunnelManager.disconnect();
  }
  sshTunnelManager = new SSHTunnelManager(config);
  return sshTunnelManager;
}

/**
 * Shutdown the SSH tunnel manager
 */
export function shutdownSSHTunnelManager(): void {
  if (sshTunnelManager) {
    sshTunnelManager.disconnect();
    sshTunnelManager = null;
  }
}
