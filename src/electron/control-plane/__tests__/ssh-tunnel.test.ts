/**
 * Tests for SSH Tunnel Manager
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
  existsSync: vi.fn(() => true),
}));

// Mock net
const mockSocket = {
  setTimeout: vi.fn(),
  on: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('net', () => ({
  default: {
    Socket: vi.fn(() => mockSocket),
  },
  Socket: vi.fn(() => mockSocket),
}));

// Import after mocking
import {
  SSHTunnelManager,
  getSSHTunnelManager,
  initSSHTunnelManager,
  shutdownSSHTunnelManager,
  DEFAULT_SSH_TUNNEL_CONFIG,
} from '../ssh-tunnel';
import type { SSHTunnelConfig } from '../../../shared/types';

// Helper to create a mock process
function createMockProcess(options?: { emitCloseOnKill?: boolean }) {
  const { emitCloseOnKill = false } = options || {};
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: Mock;
    stdin: null;
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
  };
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal) => {
    proc.killed = true;
    // Only emit close if explicitly requested to avoid unhandled errors
    if (emitCloseOnKill) {
      proc.emit('close', signal === 'SIGTERM' ? 0 : 1, signal);
    }
  });
  proc.stdin = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('SSHTunnelManager', () => {
  let manager: SSHTunnelManager;

  const defaultConfig: Partial<SSHTunnelConfig> = {
    host: 'test-host.example.com',
    username: 'testuser',
    sshPort: 22,
    localPort: 18789,
    remotePort: 18789,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSpawn.mockReturnValue(createMockProcess());
  });

  afterEach(() => {
    vi.useRealTimers();
    if (manager) {
      manager.disconnect();
    }
    shutdownSSHTunnelManager();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      manager = new SSHTunnelManager({});
      const status = manager.getStatus();

      expect(status.state).toBe('disconnected');
      expect(status.config?.localPort).toBe(DEFAULT_SSH_TUNNEL_CONFIG.localPort);
      expect(status.config?.remotePort).toBe(DEFAULT_SSH_TUNNEL_CONFIG.remotePort);
    });

    it('should merge provided config with defaults', () => {
      manager = new SSHTunnelManager({
        host: 'custom-host.com',
        username: 'customuser',
        localPort: 9999,
      });

      const status = manager.getStatus();
      expect(status.config?.host).toBe('custom-host.com');
      expect(status.config?.username).toBe('customuser');
      expect(status.config?.localPort).toBe(9999);
      expect(status.config?.remotePort).toBe(DEFAULT_SSH_TUNNEL_CONFIG.remotePort);
    });
  });

  describe('getStatus', () => {
    it('should return disconnected status initially', () => {
      manager = new SSHTunnelManager(defaultConfig);
      const status = manager.getStatus();

      expect(status.state).toBe('disconnected');
      expect(status.connectedAt).toBeUndefined();
      expect(status.error).toBeUndefined();
      expect(status.pid).toBeUndefined();
      expect(status.localEndpoint).toBeUndefined();
    });

    it('should include config in status', () => {
      manager = new SSHTunnelManager(defaultConfig);
      const status = manager.getStatus();

      expect(status.config?.host).toBe('test-host.example.com');
      expect(status.config?.username).toBe('testuser');
      expect(status.config?.sshPort).toBe(22);
      expect(status.config?.localPort).toBe(18789);
      expect(status.config?.remotePort).toBe(18789);
    });

    it('should not include reconnect attempts initially', () => {
      manager = new SSHTunnelManager(defaultConfig);
      const status = manager.getStatus();

      expect(status.reconnectAttempts).toBeUndefined();
    });
  });

  describe('getLocalUrl', () => {
    it('should return local WebSocket URL', () => {
      manager = new SSHTunnelManager(defaultConfig);
      expect(manager.getLocalUrl()).toBe('ws://127.0.0.1:18789');
    });

    it('should use configured local port', () => {
      manager = new SSHTunnelManager({ ...defaultConfig, localPort: 9999 });
      expect(manager.getLocalUrl()).toBe('ws://127.0.0.1:9999');
    });
  });

  describe('connect', () => {
    it('should reject when host is missing', async () => {
      manager = new SSHTunnelManager({ username: 'user' });

      await expect(manager.connect()).rejects.toThrow('Invalid SSH tunnel configuration');
      expect(manager.getStatus().state).toBe('error');
    });

    it('should reject when username is missing', async () => {
      manager = new SSHTunnelManager({ host: 'host.com' });

      await expect(manager.connect()).rejects.toThrow('Invalid SSH tunnel configuration');
      expect(manager.getStatus().state).toBe('error');
    });

    it('should transition to connecting state', () => {
      manager = new SSHTunnelManager(defaultConfig);

      const stateChanges: string[] = [];
      manager.on('stateChange', (state: string) => {
        stateChanges.push(state);
      });

      // Start connect (don't await)
      manager.connect().catch(() => {});

      // Should have transitioned to connecting immediately
      expect(stateChanges).toContain('connecting');

      // Clean up
      manager.disconnect();
    });

    it('should not connect if already connecting', () => {
      manager = new SSHTunnelManager(defaultConfig);

      // Start first connection (don't await)
      manager.connect().catch(() => {});

      // Try to connect again (should return immediately without spawning)
      manager.connect().catch(() => {});

      // Only one spawn should have happened
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Clean up
      manager.disconnect();
    });

    it('should spawn ssh with correct arguments', async () => {
      manager = new SSHTunnelManager({
        ...defaultConfig,
        keyPath: '~/.ssh/id_rsa',
      });

      // Start connect
      manager.connect().catch(() => {});

      expect(mockSpawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining([
          '-o', 'BatchMode=yes',
          '-v',
          '-i', expect.stringContaining('.ssh/id_rsa'),
          '-N',
          '-L', '18789:127.0.0.1:18789',
          'testuser@test-host.example.com',
        ]),
        expect.any(Object)
      );

      manager.disconnect();
    });

    it('should include custom SSH port in arguments', async () => {
      manager = new SSHTunnelManager({
        ...defaultConfig,
        sshPort: 2222,
      });

      manager.connect().catch(() => {});

      expect(mockSpawn).toHaveBeenCalledWith(
        'ssh',
        expect.arrayContaining(['-p', '2222']),
        expect.any(Object)
      );

      manager.disconnect();
    });
  });

  describe('disconnect', () => {
    it('should transition to disconnected state', () => {
      manager = new SSHTunnelManager(defaultConfig);
      manager.disconnect();

      expect(manager.getStatus().state).toBe('disconnected');
    });

    it('should kill SSH process if running', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      manager.connect().catch(() => {});

      manager.disconnect();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should emit disconnected event', () => {
      manager = new SSHTunnelManager(defaultConfig);
      const onDisconnect = vi.fn();
      manager.on('disconnected', onDisconnect);

      manager.disconnect();

      expect(onDisconnect).toHaveBeenCalledWith('User requested disconnect');
    });

    it('should clear connectedAt and error', () => {
      manager = new SSHTunnelManager(defaultConfig);
      manager.disconnect();

      const status = manager.getStatus();
      expect(status.connectedAt).toBeUndefined();
      expect(status.error).toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('should return error on timeout', async () => {
      const mockProcess = createMockProcess();
      // Don't emit close event to simulate timeout
      mockProcess.kill = vi.fn();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const testPromise = manager.testConnection();

      // Fast forward past timeout
      await vi.advanceTimersByTimeAsync(31000);

      const result = await testPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });

    it('should return success on code 0', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const testPromise = manager.testConnection();

      // Simulate successful exit
      mockProcess.emit('close', 0, null);

      const result = await testPromise;
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeDefined();
    });

    it('should return error on non-zero exit code', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const testPromise = manager.testConnection();

      // Simulate failed exit
      mockProcess.emit('close', 255, null);

      const result = await testPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('SSH exited with code 255');
    });

    it('should parse SSH error from stderr', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const testPromise = manager.testConnection();

      // Emit error to stderr
      mockProcess.stderr?.emit('data', Buffer.from('Permission denied (publickey)'));
      mockProcess.emit('close', 255, null);

      const result = await testPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle spawn error', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const testPromise = manager.testConnection();

      // Emit error
      mockProcess.emit('error', new Error('Command not found'));

      const result = await testPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Command not found');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      manager = new SSHTunnelManager(defaultConfig);
      manager.updateConfig({ host: 'new-host.com' });

      expect(manager.getStatus().config?.host).toBe('new-host.com');
    });

    it('should preserve other config values', () => {
      manager = new SSHTunnelManager(defaultConfig);
      manager.updateConfig({ host: 'new-host.com' });

      expect(manager.getStatus().config?.username).toBe('testuser');
      expect(manager.getStatus().config?.localPort).toBe(18789);
    });
  });

  describe('event emission', () => {
    it('should emit stateChange on state transitions', () => {
      manager = new SSHTunnelManager(defaultConfig);
      const onStateChange = vi.fn();
      manager.on('stateChange', onStateChange);

      manager.disconnect();

      // Already disconnected, so no state change
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('should emit output event on stderr data', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      manager = new SSHTunnelManager(defaultConfig);
      const onOutput = vi.fn();
      manager.on('output', onOutput);

      manager.connect().catch(() => {});

      // Emit some output
      mockProcess.stderr?.emit('data', Buffer.from('debug1: Connection established'));

      expect(onOutput).toHaveBeenCalledWith('debug1: Connection established');

      manager.disconnect();
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    shutdownSSHTunnelManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    shutdownSSHTunnelManager();
  });

  describe('getSSHTunnelManager', () => {
    it('should return null when not initialized', () => {
      expect(getSSHTunnelManager()).toBeNull();
    });

    it('should return manager after initialization', () => {
      const manager = initSSHTunnelManager({
        host: 'localhost',
        username: 'user',
      });

      expect(getSSHTunnelManager()).toBe(manager);
    });
  });

  describe('initSSHTunnelManager', () => {
    it('should create a new manager', () => {
      const manager = initSSHTunnelManager({
        host: 'localhost',
        username: 'testuser',
      });

      expect(manager).toBeInstanceOf(SSHTunnelManager);
      expect(getSSHTunnelManager()).toBe(manager);
    });

    it('should disconnect previous manager when reinitializing', () => {
      const manager1 = initSSHTunnelManager({
        host: 'host1.com',
        username: 'user1',
      });

      const disconnectSpy = vi.spyOn(manager1, 'disconnect');

      const manager2 = initSSHTunnelManager({
        host: 'host2.com',
        username: 'user2',
      });

      expect(disconnectSpy).toHaveBeenCalled();
      expect(getSSHTunnelManager()).toBe(manager2);
      expect(manager1).not.toBe(manager2);
    });

    it('should create manager with all options', () => {
      const manager = initSSHTunnelManager({
        host: 'localhost',
        username: 'testuser',
        sshPort: 2222,
        keyPath: '~/.ssh/custom_key',
        localPort: 9999,
        remotePort: 8888,
        autoReconnect: true,
        reconnectDelayMs: 10000,
        maxReconnectAttempts: 5,
      });

      expect(manager).toBeDefined();
      const status = manager.getStatus();
      expect(status.config?.sshPort).toBe(2222);
      expect(status.config?.localPort).toBe(9999);
      expect(status.config?.remotePort).toBe(8888);
    });
  });

  describe('shutdownSSHTunnelManager', () => {
    it('should disconnect and clear the manager', () => {
      const manager = initSSHTunnelManager({
        host: 'localhost',
        username: 'testuser',
      });

      const disconnectSpy = vi.spyOn(manager, 'disconnect');

      shutdownSSHTunnelManager();

      expect(disconnectSpy).toHaveBeenCalled();
      expect(getSSHTunnelManager()).toBeNull();
    });

    it('should do nothing when no manager exists', () => {
      expect(() => shutdownSSHTunnelManager()).not.toThrow();
    });

    it('should allow reinitialization after shutdown', () => {
      const manager1 = initSSHTunnelManager({
        host: 'host1.com',
        username: 'user1',
      });

      shutdownSSHTunnelManager();
      expect(getSSHTunnelManager()).toBeNull();

      const manager2 = initSSHTunnelManager({
        host: 'host2.com',
        username: 'user2',
      });

      expect(getSSHTunnelManager()).toBe(manager2);
      expect(manager1).not.toBe(manager2);
    });
  });
});

describe('DEFAULT_SSH_TUNNEL_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_SSH_TUNNEL_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.sshPort).toBe(22);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.localPort).toBe(18789);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.remotePort).toBe(18789);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.remoteBindAddress).toBe('127.0.0.1');
    expect(DEFAULT_SSH_TUNNEL_CONFIG.autoReconnect).toBe(true);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.reconnectDelayMs).toBe(5000);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.maxReconnectAttempts).toBe(10);
    expect(DEFAULT_SSH_TUNNEL_CONFIG.connectionTimeoutMs).toBe(30000);
  });
});

describe('SSH argument building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(createMockProcess());
  });

  afterEach(() => {
    shutdownSSHTunnelManager();
  });

  it('should include standard SSH options', () => {
    const manager = new SSHTunnelManager({
      host: 'test.com',
      username: 'user',
    });

    manager.connect().catch(() => {});

    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=30',
      ]),
      expect.any(Object)
    );

    manager.disconnect();
  });

  it('should use custom remote bind address', () => {
    const manager = new SSHTunnelManager({
      host: 'test.com',
      username: 'user',
      localPort: 8080,
      remotePort: 9090,
      remoteBindAddress: '0.0.0.0',
    });

    manager.connect().catch(() => {});

    expect(mockSpawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['-L', '8080:0.0.0.0:9090']),
      expect.any(Object)
    );

    manager.disconnect();
  });
});
