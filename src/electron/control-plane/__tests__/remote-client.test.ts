/**
 * Tests for Remote Gateway Client
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// Create mock WebSocket class inside the factory - avoid using vi inside factory
vi.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState: number = 0; // CONNECTING
    url: string;
    options: any;

    constructor(url: string, options?: any) {
      super();
      this.url = url;
      this.options = options;
      // Simulate immediate connection by default
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.emit('open');
      }, 0);
    }

    send() {
      // Mock send
    }

    close() {
      this.readyState = 3; // CLOSED
    }
  }

  return {
    default: MockWebSocket,
    WebSocket: MockWebSocket,
  };
});

// Mock crypto
vi.mock('crypto', () => ({
  default: {
    randomUUID: () => 'test-uuid-1234',
  },
  randomUUID: () => 'test-uuid-1234',
}));

// Import after mocking
import {
  RemoteGatewayClient,
  getRemoteGatewayClient,
  initRemoteGatewayClient,
  shutdownRemoteGatewayClient,
  type RemoteGatewayClientOptions,
} from '../remote-client';

describe('RemoteGatewayClient', () => {
  let client: RemoteGatewayClient;
  let onStateChange: Mock;
  let onEvent: Mock;
  let onResponse: Mock;

  const defaultOptions: RemoteGatewayClientOptions = {
    url: 'ws://127.0.0.1:18789',
    token: 'test-token-123',
    deviceName: 'Test Client',
    autoReconnect: false,
    reconnectIntervalMs: 1000,
    maxReconnectAttempts: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onStateChange = vi.fn();
    onEvent = vi.fn();
    onResponse = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (client) {
      client.disconnect();
    }
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      client = new RemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'token',
      });

      const status = client.getStatus();
      expect(status.state).toBe('disconnected');
    });

    it('should merge provided options with defaults', () => {
      client = new RemoteGatewayClient({
        url: 'ws://localhost:9999',
        token: 'my-token',
        deviceName: 'Custom Device',
        maxReconnectAttempts: 5,
      });

      // Client should be initialized without errors
      expect(client.getStatus().state).toBe('disconnected');
    });
  });

  describe('getStatus', () => {
    it('should return disconnected status initially', () => {
      client = new RemoteGatewayClient(defaultOptions);
      const status = client.getStatus();

      expect(status.state).toBe('disconnected');
      expect(status.url).toBe('ws://127.0.0.1:18789');
      expect(status.connectedAt).toBeUndefined();
      expect(status.clientId).toBeUndefined();
    });

    it('should include url in status', () => {
      client = new RemoteGatewayClient({
        url: 'ws://custom-host:9999',
        token: 'token',
      });

      expect(client.getStatus().url).toBe('ws://custom-host:9999');
    });
  });

  describe('connect', () => {
    it('should transition to connecting state', async () => {
      client = new RemoteGatewayClient({
        ...defaultOptions,
        onStateChange,
      });

      client.connect();

      // Should immediately be in connecting state
      expect(onStateChange).toHaveBeenCalledWith('connecting', undefined);
    });

    it('should not connect if already connecting', async () => {
      client = new RemoteGatewayClient({
        ...defaultOptions,
        onStateChange,
      });

      // Start first connection
      client.connect();

      // Clear mock to see if second call triggers state change
      onStateChange.mockClear();

      // Try to connect again
      client.connect();

      // Should not trigger another state change
      expect(onStateChange).not.toHaveBeenCalled();
    });

    it('should reject TLS fingerprint without wss:// URL', async () => {
      client = new RemoteGatewayClient({
        ...defaultOptions,
        tlsFingerprint: 'abc123',
        onStateChange,
      });

      await expect(client.connect()).rejects.toThrow('TLS fingerprint requires wss:// URL');
      expect(onStateChange).toHaveBeenCalledWith('error', 'TLS fingerprint requires wss:// URL');
    });
  });

  describe('disconnect', () => {
    it('should transition to disconnected state', () => {
      client = new RemoteGatewayClient({
        ...defaultOptions,
        onStateChange,
      });

      client.disconnect();

      expect(client.getStatus().state).toBe('disconnected');
    });

    it('should clear client state', async () => {
      client = new RemoteGatewayClient(defaultOptions);
      client.disconnect();

      const status = client.getStatus();
      expect(status.state).toBe('disconnected');
      expect(status.clientId).toBeUndefined();
      expect(status.connectedAt).toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('should return error on timeout', async () => {
      client = new RemoteGatewayClient(defaultOptions);

      const testPromise = client.testConnection();

      // Fast forward past the 15 second timeout
      await vi.advanceTimersByTimeAsync(16000);

      const result = await testPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });
  });

  describe('request', () => {
    it('should throw when not connected', async () => {
      client = new RemoteGatewayClient(defaultOptions);

      await expect(client.request('test.method')).rejects.toThrow('Not connected to remote gateway');
    });

    it('should throw with custom method name in error', async () => {
      client = new RemoteGatewayClient(defaultOptions);

      await expect(client.request('custom.method', { param: 'value' })).rejects.toThrow(
        'Not connected to remote gateway'
      );
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    shutdownRemoteGatewayClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    shutdownRemoteGatewayClient();
  });

  describe('getRemoteGatewayClient', () => {
    it('should return null when not initialized', () => {
      expect(getRemoteGatewayClient()).toBeNull();
    });

    it('should return client after initialization', () => {
      const client = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'test-token',
      });

      expect(getRemoteGatewayClient()).toBe(client);
    });
  });

  describe('initRemoteGatewayClient', () => {
    it('should create a new client', () => {
      const client = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'test-token',
        deviceName: 'Test Device',
      });

      expect(client).toBeInstanceOf(RemoteGatewayClient);
      expect(getRemoteGatewayClient()).toBe(client);
    });

    it('should disconnect previous client when reinitializing', () => {
      const client1 = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'token1',
      });

      const disconnectSpy = vi.spyOn(client1, 'disconnect');

      const client2 = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'token2',
      });

      expect(disconnectSpy).toHaveBeenCalled();
      expect(getRemoteGatewayClient()).toBe(client2);
      expect(client1).not.toBe(client2);
    });

    it('should create client with all options', () => {
      const client = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'test-token',
        deviceName: 'Custom Device',
        autoReconnect: true,
        reconnectIntervalMs: 10000,
        maxReconnectAttempts: 5,
      });

      expect(client).toBeDefined();
      expect(getRemoteGatewayClient()).toBe(client);
    });
  });

  describe('shutdownRemoteGatewayClient', () => {
    it('should disconnect and clear the client', () => {
      const client = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'test-token',
      });

      const disconnectSpy = vi.spyOn(client, 'disconnect');

      shutdownRemoteGatewayClient();

      expect(disconnectSpy).toHaveBeenCalled();
      expect(getRemoteGatewayClient()).toBeNull();
    });

    it('should do nothing when no client exists', () => {
      // Should not throw
      expect(() => shutdownRemoteGatewayClient()).not.toThrow();
    });

    it('should allow reinitialization after shutdown', () => {
      const client1 = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'token1',
      });

      shutdownRemoteGatewayClient();
      expect(getRemoteGatewayClient()).toBeNull();

      const client2 = initRemoteGatewayClient({
        url: 'ws://localhost:18789',
        token: 'token2',
      });

      expect(getRemoteGatewayClient()).toBe(client2);
      expect(client1).not.toBe(client2);
    });
  });
});

describe('RemoteGatewayClient status tracking', () => {
  let client: RemoteGatewayClient;

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
  });

  it('should not have reconnect attempts initially', () => {
    client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      autoReconnect: true,
      maxReconnectAttempts: 5,
    });

    const status = client.getStatus();
    expect(status.reconnectAttempts).toBeUndefined();
  });

  it('should track state correctly', () => {
    client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
    });

    const status = client.getStatus();
    expect(status.state).toBe('disconnected');
  });

  it('should include url in status', () => {
    client = new RemoteGatewayClient({
      url: 'ws://custom:9999',
      token: 'token',
    });

    expect(client.getStatus().url).toBe('ws://custom:9999');
  });
});

describe('Connection state callbacks', () => {
  it('should not trigger callback when already disconnected', () => {
    const onStateChange = vi.fn();
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      onStateChange,
    });

    // Initial state is disconnected, disconnect should not trigger callback
    client.disconnect();

    // disconnected -> disconnected should not trigger callback
    expect(onStateChange).not.toHaveBeenCalled();

    client.disconnect();
  });

  it('should trigger callback on connect', async () => {
    vi.useFakeTimers();

    const onStateChange = vi.fn();
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      onStateChange,
    });

    // Start connection
    client.connect();

    // Should have triggered 'connecting' state
    expect(onStateChange).toHaveBeenCalledWith('connecting', undefined);

    vi.useRealTimers();
    client.disconnect();
  });
});

describe('Auto-reconnect configuration', () => {
  it('should accept autoReconnect option', () => {
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      autoReconnect: true,
    });

    // Should not throw
    expect(client.getStatus().state).toBe('disconnected');
    client.disconnect();
  });

  it('should accept reconnectIntervalMs option', () => {
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      reconnectIntervalMs: 10000,
    });

    expect(client.getStatus().state).toBe('disconnected');
    client.disconnect();
  });

  it('should accept maxReconnectAttempts option', () => {
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      maxReconnectAttempts: 20,
    });

    expect(client.getStatus().state).toBe('disconnected');
    client.disconnect();
  });

  it('should allow unlimited reconnects with maxReconnectAttempts = 0', () => {
    const client = new RemoteGatewayClient({
      url: 'ws://localhost:18789',
      token: 'token',
      autoReconnect: true,
      maxReconnectAttempts: 0, // unlimited
    });

    expect(client.getStatus().state).toBe('disconnected');
    client.disconnect();
  });
});
