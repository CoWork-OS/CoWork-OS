/**
 * Tests for hooks settings manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let mockSettings: Record<string, unknown> = {};
let writeCount = 0;

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockImplementation(() => Object.keys(mockSettings).length > 0),
    readFileSync: vi.fn().mockImplementation(() => JSON.stringify(mockSettings)),
    writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
      mockSettings = JSON.parse(data);
      writeCount++;
    }),
  },
  existsSync: vi.fn().mockImplementation(() => Object.keys(mockSettings).length > 0),
  readFileSync: vi.fn().mockImplementation(() => JSON.stringify(mockSettings)),
  writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
    mockSettings = JSON.parse(data);
    writeCount++;
  }),
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// Import after mocking
import { HooksSettingsManager, generateHookToken } from '../settings';

describe('generateHookToken', () => {
  it('should generate a token of default length', () => {
    const token = generateHookToken();
    // Default is 24 bytes = 48 hex characters
    expect(token).toHaveLength(48);
  });

  it('should generate a token of specified length', () => {
    const token = generateHookToken(16);
    // 16 bytes = 32 hex characters
    expect(token).toHaveLength(32);
  });

  it('should generate different tokens each time', () => {
    const token1 = generateHookToken();
    const token2 = generateHookToken();
    expect(token1).not.toBe(token2);
  });

  it('should generate valid hex string', () => {
    const token = generateHookToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
  });
});

describe('HooksSettingsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = {};
    writeCount = 0;
    HooksSettingsManager.clearCache();
  });

  describe('loadSettings', () => {
    it('should return defaults when no settings file exists', () => {
      const settings = HooksSettingsManager.loadSettings();

      expect(settings.enabled).toBe(false);
      expect(settings.token).toBe('');
      expect(settings.path).toBe('/hooks');
      expect(settings.maxBodyBytes).toBe(256 * 1024);
      expect(settings.presets).toEqual([]);
      expect(settings.mappings).toEqual([]);
    });

    it('should load existing settings', () => {
      mockSettings = {
        enabled: true,
        token: 'test-token',
        path: '/webhooks',
        presets: ['gmail'],
      };

      const settings = HooksSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.token).toBe('test-token');
      expect(settings.path).toBe('/webhooks');
      expect(settings.presets).toEqual(['gmail']);
    });

    it('should cache loaded settings', () => {
      mockSettings = { enabled: true };

      const settings1 = HooksSettingsManager.loadSettings();
      mockSettings = { enabled: false }; // Change mock
      const settings2 = HooksSettingsManager.loadSettings();

      // Should return cached value
      expect(settings2.enabled).toBe(true);
    });
  });

  describe('saveSettings', () => {
    it('should save settings to disk', () => {
      const settings = HooksSettingsManager.loadSettings();
      settings.enabled = true;
      settings.token = 'new-token';

      HooksSettingsManager.saveSettings(settings);

      expect(writeCount).toBe(1);
      expect(mockSettings.enabled).toBe(true);
    });

    it('should update cache after save', () => {
      const settings = HooksSettingsManager.loadSettings();
      settings.enabled = true;
      HooksSettingsManager.saveSettings(settings);

      const cached = HooksSettingsManager.loadSettings();
      expect(cached.enabled).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('should clear the cached settings', () => {
      mockSettings = { enabled: true };
      HooksSettingsManager.loadSettings();

      HooksSettingsManager.clearCache();
      mockSettings = { enabled: false };

      const settings = HooksSettingsManager.loadSettings();
      expect(settings.enabled).toBe(false);
    });
  });

  describe('getDefaults', () => {
    it('should return default settings', () => {
      const defaults = HooksSettingsManager.getDefaults();

      expect(defaults.enabled).toBe(false);
      expect(defaults.token).toBe('');
      expect(defaults.path).toBe('/hooks');
    });
  });

  describe('updateConfig', () => {
    it('should update and save config', () => {
      HooksSettingsManager.updateConfig({ enabled: true });

      expect(mockSettings.enabled).toBe(true);
    });

    it('should merge with existing config', () => {
      mockSettings = { enabled: false, path: '/custom' };
      HooksSettingsManager.clearCache();

      HooksSettingsManager.updateConfig({ enabled: true });

      expect(mockSettings.enabled).toBe(true);
      expect(mockSettings.path).toBe('/custom');
    });
  });

  describe('enableHooks', () => {
    it('should enable hooks and generate token if missing', () => {
      const settings = HooksSettingsManager.enableHooks();

      expect(settings.enabled).toBe(true);
      expect(settings.token).toBeDefined();
      expect(settings.token.length).toBeGreaterThan(0);
    });

    it('should preserve existing token', () => {
      mockSettings = { token: 'existing-token' };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.enableHooks();

      expect(settings.token).toBe('existing-token');
    });
  });

  describe('disableHooks', () => {
    it('should disable hooks', () => {
      mockSettings = { enabled: true, token: 'test' };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.disableHooks();

      expect(settings.enabled).toBe(false);
    });

    it('should preserve token when disabling', () => {
      mockSettings = { enabled: true, token: 'test' };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.disableHooks();

      expect(settings.token).toBe('test');
    });
  });

  describe('regenerateToken', () => {
    it('should generate a new token', () => {
      mockSettings = { token: 'old-token' };
      HooksSettingsManager.clearCache();

      const newToken = HooksSettingsManager.regenerateToken();

      expect(newToken).not.toBe('old-token');
      expect(newToken.length).toBe(48);
    });

    it('should save the new token', () => {
      const newToken = HooksSettingsManager.regenerateToken();
      const settings = HooksSettingsManager.loadSettings();

      expect(settings.token).toBe(newToken);
    });
  });

  describe('presets', () => {
    it('should add a preset', () => {
      const settings = HooksSettingsManager.addPreset('gmail');

      expect(settings.presets).toContain('gmail');
    });

    it('should not duplicate presets', () => {
      HooksSettingsManager.addPreset('gmail');
      const settings = HooksSettingsManager.addPreset('gmail');

      expect(settings.presets.filter((p) => p === 'gmail')).toHaveLength(1);
    });

    it('should remove a preset', () => {
      mockSettings = { presets: ['gmail', 'slack'] };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.removePreset('gmail');

      expect(settings.presets).not.toContain('gmail');
      expect(settings.presets).toContain('slack');
    });
  });

  describe('mappings', () => {
    it('should add a mapping', () => {
      const settings = HooksSettingsManager.addMapping({
        id: 'test',
        match: { path: 'test' },
        action: 'agent',
      });

      expect(settings.mappings).toHaveLength(1);
      expect(settings.mappings[0].id).toBe('test');
    });

    it('should update a mapping by id', () => {
      mockSettings = {
        mappings: [{ id: 'test', action: 'agent' }],
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.updateMapping('test', {
        action: 'wake',
      });

      expect(settings?.mappings[0].action).toBe('wake');
    });

    it('should return null when updating non-existent mapping', () => {
      const settings = HooksSettingsManager.updateMapping('non-existent', {
        action: 'wake',
      });

      expect(settings).toBeNull();
    });

    it('should remove a mapping by id', () => {
      mockSettings = {
        mappings: [
          { id: 'test1', action: 'agent' },
          { id: 'test2', action: 'wake' },
        ],
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.removeMapping('test1');

      expect(settings.mappings).toHaveLength(1);
      expect(settings.mappings[0].id).toBe('test2');
    });
  });

  describe('Gmail configuration', () => {
    it('should configure Gmail hooks', () => {
      const settings = HooksSettingsManager.configureGmail({
        account: 'test@gmail.com',
        topic: 'projects/test/topics/gmail-watch',
      });

      expect(settings.gmail?.account).toBe('test@gmail.com');
      expect(settings.gmail?.topic).toBe('projects/test/topics/gmail-watch');
    });

    it('should auto-add gmail preset when configuring account', () => {
      const settings = HooksSettingsManager.configureGmail({
        account: 'test@gmail.com',
      });

      expect(settings.presets).toContain('gmail');
    });

    it('should merge Gmail config with existing', () => {
      mockSettings = {
        gmail: { account: 'old@gmail.com', label: 'INBOX' },
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.configureGmail({
        account: 'new@gmail.com',
      });

      expect(settings.gmail?.account).toBe('new@gmail.com');
      expect(settings.gmail?.label).toBe('INBOX');
    });

    it('should get Gmail config with defaults', () => {
      mockSettings = {
        gmail: { account: 'test@gmail.com' },
      };
      HooksSettingsManager.clearCache();

      const gmail = HooksSettingsManager.getGmailConfig();

      expect(gmail.account).toBe('test@gmail.com');
      expect(gmail.label).toBe('INBOX');
      expect(gmail.includeBody).toBe(true);
      expect(gmail.maxBytes).toBe(20_000);
      expect(gmail.renewEveryMinutes).toBe(12 * 60);
      expect(gmail.serve?.bind).toBe('127.0.0.1');
      expect(gmail.serve?.port).toBe(8788);
      expect(gmail.serve?.path).toBe('/gmail-pubsub');
    });
  });

  describe('status checks', () => {
    it('should return true when properly configured', () => {
      mockSettings = { enabled: true, token: 'test' };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(true);
    });

    it('should return false when disabled', () => {
      mockSettings = { enabled: false, token: 'test' };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(false);
    });

    it('should return false when no token', () => {
      mockSettings = { enabled: true, token: '' };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(false);
    });

    it('should check Gmail configuration', () => {
      mockSettings = {
        gmail: {
          account: 'test@gmail.com',
          topic: 'projects/test/topics/test',
          pushToken: 'token123',
        },
      };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isGmailConfigured()).toBe(true);
    });

    it('should return false for incomplete Gmail config', () => {
      mockSettings = {
        gmail: { account: 'test@gmail.com' },
      };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isGmailConfigured()).toBe(false);
    });
  });

  describe('getSettingsForDisplay', () => {
    it('should mask token', () => {
      mockSettings = { token: 'secret-token' };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe('***configured***');
    });

    it('should show empty string for missing token', () => {
      mockSettings = { token: '' };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe('');
    });

    it('should mask Gmail push token', () => {
      mockSettings = {
        gmail: { pushToken: 'secret-push-token' },
      };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.gmail?.pushToken).toBe('***configured***');
    });
  });
});
