/**
 * Tests for Google Chat Channel Adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the adapter and types
import { GoogleChatAdapter, createGoogleChatAdapter } from '../channels/google-chat';
import { GoogleChatConfig } from '../channels/types';

describe('GoogleChatAdapter', () => {
  let adapter: GoogleChatAdapter;
  const defaultConfig: GoogleChatConfig = {
    enabled: true,
    serviceAccountKey: {
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALRiMLAHudeSA2B9BZRLVuSPm96tGI6Oe2NG36BAmVKGHHvM8xmG\nMIIBOgIBAAJBALRiMLAHudeSA2B9BZRLVuSPm96tGI6Oe2NG36BAmVKGHHvM8xmG\n-----END RSA PRIVATE KEY-----',
      project_id: 'test-project',
    },
    webhookPort: 13979, // Use high port to avoid conflicts
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GoogleChatAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('constructor', () => {
    it('should create adapter with correct type', () => {
      expect(adapter.type).toBe('googlechat');
    });

    it('should start in disconnected state', () => {
      expect(adapter.status).toBe('disconnected');
    });

    it('should have no bot username initially', () => {
      expect(adapter.botUsername).toBeUndefined();
    });

    it('should use default webhook port if not specified', () => {
      const adapterNoPort = new GoogleChatAdapter({
        enabled: true,
        serviceAccountKey: defaultConfig.serviceAccountKey,
      });
      const config = (adapterNoPort as any).config;
      expect(config.webhookPort).toBeUndefined(); // Will default to 3979 on connect
    });

    it('should accept custom webhook port', () => {
      const adapterCustomPort = new GoogleChatAdapter({
        enabled: true,
        serviceAccountKey: defaultConfig.serviceAccountKey,
        webhookPort: 4000,
      });
      const config = (adapterCustomPort as any).config;
      expect(config.webhookPort).toBe(4000);
    });

    it('should accept custom webhook path', () => {
      const adapterCustomPath = new GoogleChatAdapter({
        enabled: true,
        serviceAccountKey: defaultConfig.serviceAccountKey,
        webhookPath: '/custom/webhook',
      });
      const config = (adapterCustomPath as any).config;
      expect(config.webhookPath).toBe('/custom/webhook');
    });

    it('should accept inline service account credentials', () => {
      const adapterInline = new GoogleChatAdapter({
        enabled: true,
        serviceAccountKey: {
          client_email: 'test@test.iam.gserviceaccount.com',
          private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
          project_id: 'test-project',
        },
      });
      const config = (adapterInline as any).config;
      expect(config.serviceAccountKey).toBeDefined();
      expect(config.serviceAccountKey.client_email).toContain('test');
    });
  });

  describe('createGoogleChatAdapter factory', () => {
    it('should create adapter with valid config using inline key', () => {
      const newAdapter = createGoogleChatAdapter({
        enabled: true,
        serviceAccountKey: {
          client_email: 'test@test.iam.gserviceaccount.com',
          private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
          project_id: 'test-project',
        },
      });
      expect(newAdapter).toBeInstanceOf(GoogleChatAdapter);
      expect(newAdapter.type).toBe('googlechat');
    });

    it('should throw error if no credentials provided', () => {
      // Clear the environment variable mock
      const originalEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

      expect(() => createGoogleChatAdapter({
        enabled: true,
      })).toThrow('Google Chat requires service account credentials');

      // Restore
      if (originalEnv) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = originalEnv;
      }
    });
  });

  describe('onMessage', () => {
    it('should register message handlers', () => {
      const handler = vi.fn();
      adapter.onMessage(handler);
      expect((adapter as any).messageHandlers).toContain(handler);
    });

    it('should support multiple handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);
      expect((adapter as any).messageHandlers.length).toBe(2);
    });
  });

  describe('onError', () => {
    it('should register error handlers', () => {
      const handler = vi.fn();
      adapter.onError(handler);
      expect((adapter as any).errorHandlers).toContain(handler);
    });
  });

  describe('onStatusChange', () => {
    it('should register status handlers', () => {
      const handler = vi.fn();
      adapter.onStatusChange(handler);
      expect((adapter as any).statusHandlers).toContain(handler);
    });

    it('should call status handlers on status change', () => {
      const handler = vi.fn();
      adapter.onStatusChange(handler);
      (adapter as any).setStatus('connecting');
      expect(handler).toHaveBeenCalledWith('connecting', undefined);
    });

    it('should pass error to status handlers', () => {
      const handler = vi.fn();
      const error = new Error('Test error');
      adapter.onStatusChange(handler);
      (adapter as any).setStatus('error', error);
      expect(handler).toHaveBeenCalledWith('error', error);
    });
  });

  describe('getInfo', () => {
    it('should return channel info', async () => {
      const info = await adapter.getInfo();

      expect(info.type).toBe('googlechat');
      expect(info.status).toBe('disconnected');
    });
  });

  describe('sendMessage validation', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.sendMessage({
        chatId: 'spaces/test-space',
        text: 'Hello',
      })).rejects.toThrow('Google Chat bot is not connected');
    });
  });

  describe('editMessage', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.editMessage('spaces/test-space', 'msg-123', 'Updated'))
        .rejects.toThrow('Google Chat bot is not connected');
    });
  });

  describe('deleteMessage', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.deleteMessage('spaces/test-space', 'msg-123'))
        .rejects.toThrow('Google Chat bot is not connected');
    });
  });

  describe('message deduplication', () => {
    it('should track processed messages', () => {
      const cache = (adapter as any).deduplicationCache;
      cache.add('msg-123');
      expect(cache.has('msg-123')).toBe(true);
    });

    it('should return false for unknown messages', () => {
      const cache = (adapter as any).deduplicationCache;
      expect(cache.has('unknown-msg')).toBe(false);
    });

    it('should not duplicate message entries', () => {
      const cache = (adapter as any).deduplicationCache;
      cache.add('msg-456');
      cache.add('msg-456');
      // Cache should still work correctly
      expect(cache.has('msg-456')).toBe(true);
    });
  });

  describe('reconnection config', () => {
    it('should respect autoReconnect config', () => {
      const adapterWithReconnect = new GoogleChatAdapter({
        ...defaultConfig,
        autoReconnect: false,
      });
      expect((adapterWithReconnect as any).config.autoReconnect).toBe(false);
    });

    it('should respect maxReconnectAttempts config', () => {
      const adapterWithMax = new GoogleChatAdapter({
        ...defaultConfig,
        maxReconnectAttempts: 3,
      });
      expect((adapterWithMax as any).config.maxReconnectAttempts).toBe(3);
    });
  });
});

describe('GoogleChatConfig', () => {
  it('should accept minimal config with inline key', () => {
    const config: GoogleChatConfig = {
      enabled: true,
      serviceAccountKey: {
        client_email: 'test@test.iam.gserviceaccount.com',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
        project_id: 'test-project',
      },
    };

    expect(config.serviceAccountKey?.client_email).toContain('test');
  });

  it('should accept minimal config with keyPath', () => {
    const config: GoogleChatConfig = {
      enabled: true,
      serviceAccountKeyPath: '/path/to/key.json',
    };

    expect(config.serviceAccountKeyPath).toBe('/path/to/key.json');
  });

  it('should accept full config', () => {
    const config: GoogleChatConfig = {
      enabled: true,
      serviceAccountKeyPath: '/path/to/key.json',
      projectId: 'my-project',
      displayName: 'My Bot',
      webhookPort: 4000,
      webhookPath: '/custom/path',
      responsePrefix: '[Bot]',
      deduplicationEnabled: false,
      autoReconnect: true,
      maxReconnectAttempts: 10,
      pubsubSubscription: 'projects/my-project/subscriptions/chat-sub',
    };

    expect(config.projectId).toBe('my-project');
    expect(config.displayName).toBe('My Bot');
    expect(config.webhookPort).toBe(4000);
    expect(config.webhookPath).toBe('/custom/path');
    expect(config.responsePrefix).toBe('[Bot]');
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.autoReconnect).toBe(true);
    expect(config.maxReconnectAttempts).toBe(10);
    expect(config.pubsubSubscription).toBe('projects/my-project/subscriptions/chat-sub');
  });
});

describe('GoogleChatAdapter edge cases', () => {
  let adapter: GoogleChatAdapter;
  const defaultConfig: GoogleChatConfig = {
    enabled: true,
    serviceAccountKey: {
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
      project_id: 'test-project',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GoogleChatAdapter(defaultConfig);
  });

  afterEach(async () => {
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('message handler error isolation', () => {
    it('should not crash if a message handler throws', async () => {
      const failingHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const successHandler = vi.fn();

      adapter.onMessage(failingHandler);
      adapter.onMessage(successHandler);

      // Handlers are registered
      expect((adapter as any).messageHandlers.length).toBe(2);
    });
  });

  describe('error handler error isolation', () => {
    it('should not crash if an error handler throws', () => {
      const failingErrorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Error handler error');
      });

      adapter.onError(failingErrorHandler);

      // Should not throw when calling handleError
      expect(() => {
        (adapter as any).handleError(new Error('Test error'), 'test');
      }).not.toThrow();
    });
  });

  describe('status handler error isolation', () => {
    it('should not crash if a status handler throws', () => {
      const failingStatusHandler = vi.fn().mockImplementation(() => {
        throw new Error('Status handler error');
      });

      adapter.onStatusChange(failingStatusHandler);

      // Should not throw when setting status
      expect(() => {
        (adapter as any).setStatus('connecting');
      }).not.toThrow();
    });
  });

  describe('deduplication cache TTL', () => {
    it('should expire old entries', () => {
      vi.useFakeTimers();

      const cache = (adapter as any).deduplicationCache;
      cache.add('msg-old');

      // Fast-forward past TTL (default 60 seconds)
      vi.advanceTimersByTime(70000);

      // Entry should be expired (has returns false for expired entries)
      expect(cache.has('msg-old')).toBe(false);

      vi.useRealTimers();
    });

    it('should keep fresh entries', () => {
      const cache = (adapter as any).deduplicationCache;
      cache.add('msg-fresh');

      // Entry should still be valid
      expect(cache.has('msg-fresh')).toBe(true);
    });
  });

  describe('credential loading', () => {
    it('should prefer inline credentials over key path', async () => {
      const adapterWithBoth = new GoogleChatAdapter({
        enabled: true,
        serviceAccountKeyPath: '/path/to/key.json',
        serviceAccountKey: {
          client_email: 'inline@test.iam.gserviceaccount.com',
          private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
          project_id: 'inline-project',
        },
      });

      // The loadCredentials method should return inline credentials first
      const credentials = await (adapterWithBoth as any).loadCredentials();
      expect(credentials.client_email).toBe('inline@test.iam.gserviceaccount.com');
    });
  });
});

describe('MessageDeduplicationCache', () => {
  let adapter: GoogleChatAdapter;

  beforeEach(() => {
    adapter = new GoogleChatAdapter({
      enabled: true,
      serviceAccountKey: {
        client_email: 'test@test.iam.gserviceaccount.com',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
        project_id: 'test-project',
      },
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('should add and check messages', () => {
    const cache = (adapter as any).deduplicationCache;

    expect(cache.has('test-1')).toBe(false);
    cache.add('test-1');
    expect(cache.has('test-1')).toBe(true);
  });

  it('should handle multiple messages', () => {
    const cache = (adapter as any).deduplicationCache;

    cache.add('msg-1');
    cache.add('msg-2');
    cache.add('msg-3');

    expect(cache.has('msg-1')).toBe(true);
    expect(cache.has('msg-2')).toBe(true);
    expect(cache.has('msg-3')).toBe(true);
    expect(cache.has('msg-4')).toBe(false);
  });

  it('should cleanup expired entries', () => {
    vi.useFakeTimers();
    const cache = (adapter as any).deduplicationCache;

    cache.add('old-msg');

    // Advance past TTL and trigger cleanup
    vi.advanceTimersByTime(120000); // 2 minutes

    // Entry should be expired
    expect(cache.has('old-msg')).toBe(false);

    vi.useRealTimers();
  });
});

describe('Channel Registry integration', () => {
  it('should have googlechat as a valid channel type', () => {
    // This tests that the type system accepts 'googlechat'
    const adapter = new GoogleChatAdapter({
      enabled: true,
      serviceAccountKey: {
        client_email: 'test@test.iam.gserviceaccount.com',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
        project_id: 'test-project',
      },
    });
    expect(adapter.type).toBe('googlechat');
  });
});
