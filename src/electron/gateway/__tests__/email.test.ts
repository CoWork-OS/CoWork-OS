/**
 * Tests for Email Channel Adapter and Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock the EmailClient class
vi.mock('../channels/email-client', () => ({
  EmailClient: vi.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      checkConnection: vi.fn().mockResolvedValue({
        success: true,
        imap: true,
        smtp: true,
      }),
      isConnected: vi.fn().mockReturnValue(false),
      startReceiving: vi.fn().mockResolvedValue(undefined),
      stopReceiving: vi.fn().mockResolvedValue(undefined),
      sendEmail: vi.fn().mockResolvedValue('msg-12345@example.com'),
      markAsRead: vi.fn().mockResolvedValue(undefined),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      off: emitter.off.bind(emitter),
    };
  }),
}));

// Import after mocking
import { EmailAdapter, createEmailAdapter, EmailConfig } from '../channels/email';
import { EmailClient } from '../channels/email-client';

describe('EmailAdapter', () => {
  let adapter: EmailAdapter;
  const defaultConfig: EmailConfig = {
    enabled: true,
    email: 'bot@example.com',
    password: 'test-password-123',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new EmailAdapter(defaultConfig);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('constructor', () => {
    it('should create adapter with correct type', () => {
      expect(adapter.type).toBe('email');
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

    it('should use default IMAP port if not specified', () => {
      const adapterNoPort = new EmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      });
      const config = (adapterNoPort as any).config;
      expect(config.imapPort).toBe(993);
    });

    it('should use default SMTP port if not specified', () => {
      const adapterNoPort = new EmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      });
      const config = (adapterNoPort as any).config;
      expect(config.smtpPort).toBe(587);
    });

    it('should use default poll interval if not specified', () => {
      const config = (adapter as any).config;
      expect(config.pollInterval).toBe(30000);
    });

    it('should use default mailbox INBOX if not specified', () => {
      const adapterDefault = new EmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      });
      const config = (adapterDefault as any).config;
      expect(config.mailbox).toBe('INBOX');
    });

    it('should enable markAsRead by default', () => {
      const adapterDefault = new EmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      });
      const config = (adapterDefault as any).config;
      expect(config.markAsRead).toBe(true);
    });

    it('should default protocol to imap-smtp', () => {
      const config = (adapter as any).config;
      expect(config.protocol).toBe('imap-smtp');
    });
  });

  describe('createEmailAdapter factory', () => {
    it('should create adapter with valid config', () => {
      const newAdapter = createEmailAdapter({
        enabled: true,
        email: 'test@example.com',
        password: 'password123',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      });
      expect(newAdapter).toBeInstanceOf(EmailAdapter);
      expect(newAdapter.type).toBe('email');
    });

    it('should throw error if email is missing', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        email: '',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      })).toThrow('Email address is required');
    });

    it('should throw error if password is missing', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: '',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      })).toThrow('Email password is required');
    });

    it('should throw error if imapHost is missing', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: '',
        smtpHost: 'smtp.example.com',
      })).toThrow('IMAP host is required');
    });

    it('should throw error if smtpHost is missing', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        email: 'bot@example.com',
        password: 'password',
        imapHost: 'imap.example.com',
        smtpHost: '',
      })).toThrow('SMTP host is required');
    });

    it('should create adapter with valid loom config', () => {
      const newAdapter = createEmailAdapter({
        enabled: true,
        protocol: 'loom',
        loomBaseUrl: 'http://127.0.0.1:8787',
        loomAccessToken: 'token_123',
      });
      expect(newAdapter).toBeInstanceOf(EmailAdapter);
      expect((newAdapter as any).config.protocol).toBe('loom');
    });

    it('should reject insecure non-localhost loom base URL', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        protocol: 'loom',
        loomBaseUrl: 'http://loom.example.com',
        loomAccessToken: 'token_123',
      })).toThrow('LOOM base URL must use HTTPS');
    });

    it('should throw error if loom base URL is missing in loom mode', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        protocol: 'loom',
        loomAccessToken: 'token_123',
      })).toThrow('LOOM base URL is required');
    });

    it('should throw error if loom access token is missing in loom mode', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        protocol: 'loom',
        loomBaseUrl: 'http://127.0.0.1:8787',
      })).toThrow('LOOM access token is required');
    });

    it('should reject invalid LOOM mailbox folder', () => {
      expect(() => createEmailAdapter({
        enabled: true,
        protocol: 'loom',
        loomBaseUrl: 'http://127.0.0.1:8787',
        loomAccessToken: 'token_123',
        loomMailboxFolder: 'INBOX/../Work',
      })).toThrow('LOOM mailbox folder contains invalid characters');
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

      expect(info.type).toBe('email');
      expect(info.status).toBe('disconnected');
    });

    it('should include email config in extra', async () => {
      const info = await adapter.getInfo();
      expect(info.extra?.email).toBe('bot@example.com');
      expect(info.extra?.imapHost).toBe('imap.example.com');
      expect(info.extra?.smtpHost).toBe('smtp.example.com');
    });
  });

  describe('disconnect', () => {
    it('should clear state on disconnect', async () => {
      (adapter as any)._status = 'connected';
      (adapter as any)._botUsername = 'bot@example.com';

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

    it('should clear reply context cache', async () => {
      (adapter as any).replyContext.set('user@example.com|Subject', {
        messageId: '<msg-123@example.com>',
        references: [],
      });

      await adapter.disconnect();

      expect((adapter as any).replyContext.size).toBe(0);
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
      // Email uses 5 minute TTL (300000ms)
      const oldTime = Date.now() - 310000; // Over 5 minutes ago
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
        chatId: 'user@example.com|Subject',
        text: 'Hello',
      })).rejects.toThrow('Email client is not connected');
    });
  });

  describe('editMessage', () => {
    it('should throw error as email does not support editing', async () => {
      await expect(adapter.editMessage('user@example.com', 'msg-123', 'Updated'))
        .rejects.toThrow('Email does not support message editing');
    });
  });

  describe('deleteMessage', () => {
    it('should throw error as deletion not implemented', async () => {
      await expect(adapter.deleteMessage('user@example.com', 'msg-123'))
        .rejects.toThrow('Email message deletion not implemented');
    });
  });

  describe('sendDocument', () => {
    it('should throw error as attachments not implemented', async () => {
      await expect(adapter.sendDocument('user@example.com', '/path/to/file.pdf'))
        .rejects.toThrow('Email attachment sending not implemented');
    });
  });

  describe('sendPhoto', () => {
    it('should throw error as attachments not implemented', async () => {
      await expect(adapter.sendPhoto('user@example.com', '/path/to/image.png'))
        .rejects.toThrow('Email image sending not implemented');
    });
  });

  describe('reply context caching', () => {
    it('should cache reply context', () => {
      (adapter as any).replyContext.set('user@example.com|Test Subject', {
        messageId: '<msg-123@example.com>',
        references: [],
      });

      const cached = (adapter as any).replyContext.get('user@example.com|Test Subject');
      expect(cached).toBeDefined();
      expect(cached.messageId).toBe('<msg-123@example.com>');
    });

    it('should retrieve cached reply context', () => {
      (adapter as any).replyContext.set('user@example.com|Test Subject', {
        messageId: '<msg-123@example.com>',
        references: ['<msg-001@example.com>'],
      });

      const context = (adapter as any).replyContext.get('user@example.com|Test Subject');
      expect(context).toBeDefined();
      expect(context.messageId).toBe('<msg-123@example.com>');
      expect(context.references).toHaveLength(1);
    });
  });
});

describe('EmailConfig', () => {
  it('should accept minimal config', () => {
    const config: EmailConfig = {
      enabled: true,
      email: 'bot@example.com',
      password: 'test-password',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
    };

    expect(config.email).toBe('bot@example.com');
    expect(config.imapHost).toBe('imap.example.com');
    expect(config.smtpHost).toBe('smtp.example.com');
  });

  it('should accept full config', () => {
    const config: EmailConfig = {
      enabled: true,
      email: 'bot@example.com',
      password: 'secure-password',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
      displayName: 'CoWork Bot',
      mailbox: 'INBOX',
      pollInterval: 60000,
      markAsRead: true,
      responsePrefix: '[Bot]',
      deduplicationEnabled: false,
      allowedSenders: ['admin@company.com', 'user@company.com'],
      subjectFilter: '[CoWork]',
    };

    expect(config.imapPort).toBe(993);
    expect(config.smtpPort).toBe(465);
    expect(config.displayName).toBe('CoWork Bot');
    expect(config.pollInterval).toBe(60000);
    expect(config.markAsRead).toBe(true);
    expect(config.responsePrefix).toBe('[Bot]');
    expect(config.deduplicationEnabled).toBe(false);
    expect(config.allowedSenders).toHaveLength(2);
    expect(config.subjectFilter).toBe('[CoWork]');
  });
});

describe('EmailAdapter edge cases', () => {
  let adapter: EmailAdapter;
  const defaultConfig: EmailConfig = {
    enabled: true,
    email: 'bot@example.com',
    password: 'test-password',
    imapHost: 'imap.example.com',
    smtpHost: 'smtp.example.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new EmailAdapter(defaultConfig);
  });

  afterEach(async () => {
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  describe('sender filtering', () => {
    it('should accept config with allowedSenders', () => {
      const adapterWithFilter = new EmailAdapter({
        ...defaultConfig,
        allowedSenders: ['allowed@example.com', 'vip@company.com'],
      });
      const config = (adapterWithFilter as any).config;
      expect(config.allowedSenders).toEqual(['allowed@example.com', 'vip@company.com']);
    });

    it('should accept config with empty allowedSenders (allow all)', () => {
      const adapterNoFilter = new EmailAdapter({
        ...defaultConfig,
        allowedSenders: [],
      });
      const config = (adapterNoFilter as any).config;
      expect(config.allowedSenders).toEqual([]);
    });
  });

  describe('subject filtering', () => {
    it('should accept config with subjectFilter', () => {
      const adapterWithSubject = new EmailAdapter({
        ...defaultConfig,
        subjectFilter: '[CoWork]',
      });
      const config = (adapterWithSubject as any).config;
      expect(config.subjectFilter).toBe('[CoWork]');
    });

    it('should handle empty subject filter', () => {
      const config = (adapter as any).config;
      expect(config.subjectFilter).toBeUndefined();
    });
  });

  describe('reply threading', () => {
    it('should build references chain correctly', () => {
      const chatId = 'user@example.com|Test Subject';

      // Set up initial context
      (adapter as any).replyContext.set(chatId, {
        messageId: '<msg-001@example.com>',
        references: [],
      });

      const context = (adapter as any).replyContext.get(chatId);
      expect(context.messageId).toBe('<msg-001@example.com>');
      expect(context.references).toEqual([]);
    });

    it('should preserve references chain for deep threads', () => {
      const chatId = 'user@example.com|Long Thread';

      // Simulate a deep thread
      (adapter as any).replyContext.set(chatId, {
        messageId: '<msg-005@example.com>',
        references: [
          '<msg-001@example.com>',
          '<msg-002@example.com>',
          '<msg-003@example.com>',
          '<msg-004@example.com>',
        ],
      });

      const context = (adapter as any).replyContext.get(chatId);
      expect(context.references).toHaveLength(4);
    });
  });

  describe('deduplication cache TTL', () => {
    it('should use longer TTL for email (5 minutes)', () => {
      const ttl = (adapter as any).DEDUP_CACHE_TTL;
      expect(ttl).toBe(300000); // 5 minutes in ms
    });

    it('should have smaller max cache size for email', () => {
      const maxSize = (adapter as any).DEDUP_CACHE_MAX_SIZE;
      expect(maxSize).toBe(500);
    });
  });

  describe('chatId format', () => {
    it('should construct chatId from sender and subject', () => {
      // The chatId format is "sender|subject"
      const sender = 'user@example.com';
      const subject = 'Re: Help needed';
      const chatId = `${sender}|${subject}`;

      expect(chatId).toBe('user@example.com|Re: Help needed');
      expect(chatId.split('|')[0]).toBe(sender);
      expect(chatId.split('|')[1]).toBe(subject);
    });
  });
});
