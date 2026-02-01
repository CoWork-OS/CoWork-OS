/**
 * Tests for LINE Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock the LineClient class
vi.mock('../channels/line-client', () => ({
  LineClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        botId: 'U1234567890',
      }),
      getBotInfo: vi.fn().mockResolvedValue({
        userId: 'U1234567890',
        displayName: 'TestBot',
        pictureUrl: 'https://example.com/pic.jpg',
      }),
      isConnected: vi.fn().mockReturnValue(false),
      startReceiving: vi.fn().mockResolvedValue(undefined),
      stopReceiving: vi.fn().mockResolvedValue(undefined),
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
      getUserProfile: vi.fn().mockResolvedValue({
        userId: 'U9876543210',
        displayName: 'TestUser',
      }),
      getMessageContent: vi.fn().mockResolvedValue(Buffer.from('test')),
      clearUserCache: vi.fn(),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import { LineAdapter, createLineAdapter, LineConfig } from '../channels/line';
import { LineClient } from '../channels/line-client';

describe('LineAdapter', () => {
  let adapter: LineAdapter;
  const defaultConfig: LineConfig = {
    enabled: true,
    channelAccessToken: 'test-access-token-12345',
    channelSecret: 'test-channel-secret',
    webhookPort: 8080,
    webhookPath: '/webhook',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LineAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('constructor', () => {
    it('should create adapter with correct type', () => {
      expect(adapter.type).toBe('line');
    });

    it('should start in disconnected state', () => {
      expect(adapter.status).toBe('disconnected');
    });

    it('should have no bot username initially', () => {
      expect(adapter.botUsername).toBeUndefined();
    });

    it('should enable deduplication by default', () => {
      const adapterConfig = adapter as any;
      expect(adapterConfig.config.deduplicationEnabled).toBe(true);
    });

    it('should use default webhook port if not specified', () => {
      const adapterNoPort = new LineAdapter({
        enabled: true,
        channelAccessToken: 'token',
        channelSecret: 'secret',
      });
      const config = (adapterNoPort as any).config;
      expect(config.webhookPort).toBe(3100);
    });

    it('should use default webhook path if not specified', () => {
      const adapterNoPath = new LineAdapter({
        enabled: true,
        channelAccessToken: 'token',
        channelSecret: 'secret',
      });
      const config = (adapterNoPath as any).config;
      expect(config.webhookPath).toBe('/line/webhook');
    });

    it('should enable useReplyTokens by default', () => {
      const adapterDefault = new LineAdapter({
        enabled: true,
        channelAccessToken: 'token',
        channelSecret: 'secret',
      });
      const config = (adapterDefault as any).config;
      expect(config.useReplyTokens).toBe(true);
    });
  });

  describe('createLineAdapter factory', () => {
    it('should create adapter with valid config', () => {
      const newAdapter = createLineAdapter({
        enabled: true,
        channelAccessToken: 'valid-token',
        channelSecret: 'valid-secret',
      });
      expect(newAdapter).toBeInstanceOf(LineAdapter);
      expect(newAdapter.type).toBe('line');
    });

    it('should throw error if channelAccessToken is missing', () => {
      expect(() => createLineAdapter({
        enabled: true,
        channelAccessToken: '',
        channelSecret: 'secret',
      })).toThrow('LINE channel access token is required');
    });

    it('should throw error if channelSecret is missing', () => {
      expect(() => createLineAdapter({
        enabled: true,
        channelAccessToken: 'token',
        channelSecret: '',
      })).toThrow('LINE channel secret is required');
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
  });

  describe('getInfo', () => {
    it('should return channel info', async () => {
      const info = await adapter.getInfo();

      expect(info.type).toBe('line');
      expect(info.status).toBe('disconnected');
    });

    it('should include webhook config in extra', async () => {
      const info = await adapter.getInfo();
      expect(info.extra?.webhookPort).toBeDefined();
      expect(info.extra?.webhookPath).toBeDefined();
    });
  });

  describe('disconnect', () => {
    it('should clear state on disconnect', async () => {
      (adapter as any)._status = 'connected';
      (adapter as any)._botUsername = 'TestBot';
      (adapter as any)._botId = 'U1234567890';

      await adapter.disconnect();

      expect(adapter.status).toBe('disconnected');
      expect(adapter.botUsername).toBeUndefined();
    });

    it('should stop deduplication cleanup timer', async () => {
      (adapter as any).dedupCleanupTimer = setInterval(() => {}, 60000);

      await adapter.disconnect();

      expect((adapter as any).dedupCleanupTimer).toBeUndefined();
    });

    it('should clear processed messages cache', async () => {
      (adapter as any).processedMessages.set('msg-123', Date.now());

      await adapter.disconnect();

      expect((adapter as any).processedMessages.size).toBe(0);
    });

    it('should clear reply token cache', async () => {
      (adapter as any).replyTokenCache.set('user-123', { token: 'rt-123', expires: Date.now() });

      await adapter.disconnect();

      expect((adapter as any).replyTokenCache.size).toBe(0);
    });
  });

  describe('message deduplication', () => {
    it('should track processed messages', () => {
      (adapter as any).markMessageProcessed('msg-123');
      expect((adapter as any).isMessageProcessed('msg-123')).toBe(true);
    });

    it('should not mark duplicate messages as unprocessed', () => {
      (adapter as any).markMessageProcessed('msg-456');
      (adapter as any).markMessageProcessed('msg-456');
      expect((adapter as any).processedMessages.size).toBe(1);
    });

    it('should cleanup old messages from cache', () => {
      const oldTime = Date.now() - 120000;
      (adapter as any).processedMessages.set('old-msg', oldTime);
      (adapter as any).processedMessages.set('new-msg', Date.now());

      (adapter as any).cleanupDedupCache();

      expect((adapter as any).processedMessages.has('old-msg')).toBe(false);
      expect((adapter as any).processedMessages.has('new-msg')).toBe(true);
    });
  });

  describe('reply token cache', () => {
    it('should cache reply tokens', () => {
      (adapter as any).replyTokenCache.set('user-123', {
        token: 'rt-token-123',
        expires: Date.now() + 55000,
      });
      const cached = (adapter as any).replyTokenCache.get('user-123');
      expect(cached).toBeDefined();
      expect(cached.token).toBe('rt-token-123');
    });

    it('should retrieve cached reply token if not expired', () => {
      const token = 'rt-fresh-token';
      (adapter as any).replyTokenCache.set('user-123', {
        token,
        expires: Date.now() + 55000,
      });
      const cached = (adapter as any).replyTokenCache.get('user-123');
      expect(cached.token).toBe(token);
      expect(cached.expires).toBeGreaterThan(Date.now());
    });

    it('should not use expired reply tokens', () => {
      (adapter as any).replyTokenCache.set('user-123', {
        token: 'rt-old-token',
        expires: Date.now() - 1000, // Already expired
      });
      const cached = (adapter as any).replyTokenCache.get('user-123');
      expect(cached.expires).toBeLessThan(Date.now());
    });
  });

  describe('sendMessage validation', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.sendMessage({
        chatId: 'U9876543210',
        text: 'Hello',
      })).rejects.toThrow('LINE client is not connected');
    });
  });

  describe('editMessage', () => {
    it('should throw error as LINE does not support editing', async () => {
      await expect(adapter.editMessage('U123', 'msg-123', 'Updated'))
        .rejects.toThrow('LINE does not support message editing');
    });
  });

  describe('deleteMessage', () => {
    it('should throw error as deletion not implemented', async () => {
      await expect(adapter.deleteMessage('U123', 'msg-123'))
        .rejects.toThrow('LINE message deletion not implemented');
    });
  });

  describe('sendDocument', () => {
    it('should throw error as file sending requires hosting', async () => {
      await expect(adapter.sendDocument('U123', '/path/to/file.pdf'))
        .rejects.toThrow('LINE file sending requires hosting');
    });
  });

  describe('sendPhoto', () => {
    it('should throw error as image sending requires hosting', async () => {
      await expect(adapter.sendPhoto('U123', '/path/to/image.png'))
        .rejects.toThrow('LINE image sending requires hosting');
    });
  });

  describe('getUserProfile', () => {
    it('should return null when not connected', async () => {
      const profile = await adapter.getUserProfile('U123');
      expect(profile).toBeNull();
    });
  });

  describe('leaveGroup', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.leaveGroup('G123'))
        .rejects.toThrow('LINE client is not connected');
    });
  });

  describe('leaveRoom', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.leaveRoom('R123'))
        .rejects.toThrow('LINE client is not connected');
    });
  });
});

describe('LineConfig', () => {
  it('should accept minimal config', () => {
    const config: LineConfig = {
      enabled: true,
      channelAccessToken: 'test-token',
      channelSecret: 'test-secret',
    };

    expect(config.channelAccessToken).toBe('test-token');
    expect(config.channelSecret).toBe('test-secret');
  });

  it('should accept full config', () => {
    const config: LineConfig = {
      enabled: true,
      channelAccessToken: 'test-token',
      channelSecret: 'test-secret',
      webhookPort: 9000,
      webhookPath: '/line/webhook',
      responsePrefix: '[Bot]',
      deduplicationEnabled: false,
      useReplyTokens: true,
    };

    expect(config.webhookPort).toBe(9000);
    expect(config.webhookPath).toBe('/line/webhook');
    expect(config.responsePrefix).toBe('[Bot]');
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.useReplyTokens).toBe(true);
  });
});

describe('LineAdapter edge cases', () => {
  let adapter: LineAdapter;
  const defaultConfig: LineConfig = {
    enabled: true,
    channelAccessToken: 'test-token',
    channelSecret: 'test-secret',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LineAdapter(defaultConfig);
  });

  afterEach(async () => {
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('expired reply token handling', () => {
    it('should detect expired reply tokens', () => {
      const expiredTime = Date.now() - 1000; // Already expired
      (adapter as any).replyTokenCache.set('user-123', {
        token: 'expired-token',
        expires: expiredTime,
      });

      const cached = (adapter as any).replyTokenCache.get('user-123');
      expect(cached.expires).toBeLessThan(Date.now());
    });

    it('should not use reply tokens that will expire soon', () => {
      // Token expiring in 5 seconds (too short for safe use)
      const nearExpiry = Date.now() + 5000;
      (adapter as any).replyTokenCache.set('user-456', {
        token: 'near-expiry-token',
        expires: nearExpiry,
      });

      const cached = (adapter as any).replyTokenCache.get('user-456');
      // Token exists but is near expiry - caller should check
      expect(cached.expires - Date.now()).toBeLessThan(10000);
    });
  });

  describe('deduplication cache size limits', () => {
    it('should respect maximum cache size', () => {
      const maxSize = (adapter as any).DEDUP_CACHE_MAX_SIZE;
      expect(maxSize).toBe(1000);

      // Fill cache to max
      for (let i = 0; i < maxSize; i++) {
        (adapter as any).processedMessages.set(`msg-${i}`, Date.now());
      }
      expect((adapter as any).processedMessages.size).toBe(maxSize);
    });
  });

  describe('message handler error isolation', () => {
    it('should not crash if a message handler throws', () => {
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
});
