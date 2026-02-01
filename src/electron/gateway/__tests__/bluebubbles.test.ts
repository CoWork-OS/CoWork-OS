/**
 * Tests for BlueBubbles Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock the BlueBubblesClient class
vi.mock('../channels/bluebubbles-client', () => ({
  BlueBubblesClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        serverVersion: '1.9.0',
      }),
      isConnected: vi.fn().mockReturnValue(false),
      startReceiving: vi.fn().mockResolvedValue(undefined),
      stopReceiving: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ guid: 'msg-12345' }),
      sendMessageToAddress: vi.fn().mockResolvedValue({ guid: 'msg-67890' }),
      getChats: vi.fn().mockResolvedValue([
        { guid: 'chat-1', displayName: 'Test Chat', participants: [] },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
      markChatRead: vi.fn().mockResolvedValue(undefined),
      sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(Buffer.from('test')),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import { BlueBubblesAdapter, createBlueBubblesAdapter, BlueBubblesConfig } from '../channels/bluebubbles';
import { BlueBubblesClient } from '../channels/bluebubbles-client';

describe('BlueBubblesAdapter', () => {
  let adapter: BlueBubblesAdapter;
  const defaultConfig: BlueBubblesConfig = {
    enabled: true,
    serverUrl: 'http://localhost:1234',
    password: 'test-password-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new BlueBubblesAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('constructor', () => {
    it('should create adapter with correct type', () => {
      expect(adapter.type).toBe('bluebubbles');
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
      const config = (adapter as any).config;
      expect(config.webhookPort).toBe(3101);
    });

    it('should use default webhook path if not specified', () => {
      const config = (adapter as any).config;
      expect(config.webhookPath).toBe('/bluebubbles/webhook');
    });

    it('should use default poll interval if not specified', () => {
      const config = (adapter as any).config;
      expect(config.pollInterval).toBe(5000);
    });

    it('should enable webhook by default', () => {
      const config = (adapter as any).config;
      expect(config.enableWebhook).toBe(true);
    });
  });

  describe('createBlueBubblesAdapter factory', () => {
    it('should create adapter with valid config', () => {
      const newAdapter = createBlueBubblesAdapter({
        enabled: true,
        serverUrl: 'http://localhost:5000',
        password: 'password123',
      });
      expect(newAdapter).toBeInstanceOf(BlueBubblesAdapter);
      expect(newAdapter.type).toBe('bluebubbles');
    });

    it('should throw error if serverUrl is missing', () => {
      expect(() => createBlueBubblesAdapter({
        enabled: true,
        serverUrl: '',
        password: 'password',
      })).toThrow('BlueBubbles server URL is required');
    });

    it('should throw error if password is missing', () => {
      expect(() => createBlueBubblesAdapter({
        enabled: true,
        serverUrl: 'http://localhost:1234',
        password: '',
      })).toThrow('BlueBubbles server password is required');
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

      expect(info.type).toBe('bluebubbles');
      expect(info.status).toBe('disconnected');
    });

    it('should include server config in extra', async () => {
      const info = await adapter.getInfo();
      expect(info.extra?.serverUrl).toBe('http://localhost:1234');
      expect(info.extra?.webhookEnabled).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should clear state on disconnect', async () => {
      (adapter as any)._status = 'connected';
      (adapter as any)._botUsername = 'BlueBubbles (1.9.0)';

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

    it('should clear chat cache', async () => {
      (adapter as any).chatCache.set('chat-123', { guid: 'chat-123' });

      await adapter.disconnect();

      expect((adapter as any).chatCache.size).toBe(0);
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

  describe('sendMessage validation', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.sendMessage({
        chatId: 'chat-123',
        text: 'Hello',
      })).rejects.toThrow('BlueBubbles client is not connected');
    });
  });

  describe('editMessage', () => {
    it('should throw error as iMessage does not support editing', async () => {
      await expect(adapter.editMessage('chat-123', 'msg-123', 'Updated'))
        .rejects.toThrow('iMessage does not support message editing');
    });
  });

  describe('deleteMessage', () => {
    it('should throw error as iMessage does not support deletion via BlueBubbles', async () => {
      await expect(adapter.deleteMessage('chat-123', 'msg-123'))
        .rejects.toThrow('iMessage message deletion not supported via BlueBubbles');
    });
  });

  describe('sendDocument', () => {
    it('should throw error as not implemented', async () => {
      await expect(adapter.sendDocument('chat-123', '/path/to/file.pdf'))
        .rejects.toThrow('BlueBubbles file sending not implemented');
    });
  });

  describe('sendPhoto', () => {
    it('should throw error as not implemented', async () => {
      await expect(adapter.sendPhoto('chat-123', '/path/to/image.png'))
        .rejects.toThrow('BlueBubbles image sending not implemented');
    });
  });

  describe('getChats', () => {
    it('should return empty array when not connected', async () => {
      const chats = await adapter.getChats();
      expect(chats).toEqual([]);
    });
  });

  describe('sendToAddress', () => {
    it('should throw error when not connected', async () => {
      await expect(adapter.sendToAddress('+1234567890', 'Hello'))
        .rejects.toThrow('BlueBubbles client is not connected');
    });
  });

  describe('markAsRead', () => {
    it('should not throw when not connected', async () => {
      // Just returns silently when not connected
      await expect(adapter.markAsRead('chat-123')).resolves.toBeUndefined();
    });
  });

  describe('sendTyping', () => {
    it('should not throw when not connected', async () => {
      // Just returns silently when not connected
      await expect(adapter.sendTyping('chat-123')).resolves.toBeUndefined();
    });
  });
});

describe('BlueBubblesConfig', () => {
  it('should accept minimal config', () => {
    const config: BlueBubblesConfig = {
      enabled: true,
      serverUrl: 'http://localhost:1234',
      password: 'test-password',
    };

    expect(config.serverUrl).toBe('http://localhost:1234');
    expect(config.password).toBe('test-password');
  });

  it('should accept full config', () => {
    const config: BlueBubblesConfig = {
      enabled: true,
      serverUrl: 'http://192.168.1.100:1234',
      password: 'secure-password',
      enableWebhook: true,
      webhookPort: 9000,
      webhookPath: '/bb/webhook',
      pollInterval: 3000,
      responsePrefix: '[Bot]',
      deduplicationEnabled: false,
      allowedContacts: ['+1234567890', 'friend@email.com'],
    };

    expect(config.enableWebhook).toBe(true);
    expect(config.webhookPort).toBe(9000);
    expect(config.webhookPath).toBe('/bb/webhook');
    expect(config.pollInterval).toBe(3000);
    expect(config.responsePrefix).toBe('[Bot]');
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.allowedContacts).toHaveLength(2);
  });
});
