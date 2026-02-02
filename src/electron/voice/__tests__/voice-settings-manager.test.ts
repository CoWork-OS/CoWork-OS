/**
 * Tests for VoiceSettingsManager
 *
 * Now tests the SecureSettingsRepository-based implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Define mock functions at module scope before imports
const mockRepositorySave = vi.fn();
const mockRepositoryLoad = vi.fn();
const mockRepositoryDelete = vi.fn();
const mockRepositoryExists = vi.fn();

// Mock SecureSettingsRepository before importing VoiceSettingsManager
vi.mock('../../database/SecureSettingsRepository', () => {
  return {
    SecureSettingsRepository: class MockSecureSettingsRepository {
      save = mockRepositorySave;
      load = mockRepositoryLoad;
      delete = mockRepositoryDelete;
      exists = mockRepositoryExists;
      constructor(_db: any) {}
    },
  };
});

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(true),
    encryptString: vi.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: vi.fn((buffer: Buffer) => {
      const str = buffer.toString();
      return str.replace('encrypted:', '');
    }),
  },
}));

// Mock fs module (for migration tests)
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are set up
import { app, safeStorage } from 'electron';
import { VoiceSettingsManager } from '../voice-settings-manager';
import { DEFAULT_VOICE_SETTINGS, VoiceSettings } from '../../../shared/types';

// Mock database
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  }),
} as any;

describe('VoiceSettingsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset cached settings and repository
    VoiceSettingsManager.clearCache();
    (VoiceSettingsManager as any).repository = null;
    (VoiceSettingsManager as any).migrationComplete = false;

    // Default mock behavior - no existing settings
    mockRepositoryExists.mockReturnValue(false);
    mockRepositoryLoad.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should set the user data path', () => {
      VoiceSettingsManager.initialize(mockDb);
      expect(app.getPath).toHaveBeenCalledWith('userData');
    });

    it('should create a SecureSettingsRepository', () => {
      VoiceSettingsManager.initialize(mockDb);
      expect((VoiceSettingsManager as any).repository).toBeDefined();
    });
  });

  describe('loadSettings', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should return default settings when no settings exist', () => {
      mockRepositoryLoad.mockReturnValue(undefined);

      const settings = VoiceSettingsManager.loadSettings();

      expect(settings).toEqual(DEFAULT_VOICE_SETTINGS);
    });

    it('should load settings from repository', () => {
      mockRepositoryLoad.mockReturnValue({
        enabled: true,
        ttsProvider: 'openai',
        volume: 75,
      });

      const settings = VoiceSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.ttsProvider).toBe('openai');
      expect(settings.volume).toBe(75);
      expect(mockRepositoryLoad).toHaveBeenCalledWith('voice');
    });

    it('should merge with defaults for missing fields', () => {
      mockRepositoryLoad.mockReturnValue({
        enabled: true,
      });

      const settings = VoiceSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      // Should have default values for missing fields
      expect(settings.ttsProvider).toBe(DEFAULT_VOICE_SETTINGS.ttsProvider);
      expect(settings.volume).toBe(DEFAULT_VOICE_SETTINGS.volume);
    });

    it('should load API keys from repository', () => {
      mockRepositoryLoad.mockReturnValue({
        enabled: true,
        elevenLabsApiKey: 'secret-key',
        openaiApiKey: 'another-key',
      });

      const settings = VoiceSettingsManager.loadSettings();

      expect(settings.elevenLabsApiKey).toBe('secret-key');
      expect(settings.openaiApiKey).toBe('another-key');
    });

    it('should cache loaded settings', () => {
      mockRepositoryLoad.mockReturnValue({ enabled: true });

      VoiceSettingsManager.loadSettings();
      VoiceSettingsManager.loadSettings();

      // Should only call repository once (cached)
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);
    });

    it('should return defaults on load error', () => {
      mockRepositoryLoad.mockImplementation(() => {
        throw new Error('Load error');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const settings = VoiceSettingsManager.loadSettings();

      expect(settings).toEqual(DEFAULT_VOICE_SETTINGS);
      consoleSpy.mockRestore();
    });

    it('should return defaults when repository not initialized', () => {
      (VoiceSettingsManager as any).repository = null;
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const settings = VoiceSettingsManager.loadSettings();

      expect(settings).toEqual(DEFAULT_VOICE_SETTINGS);
      consoleSpy.mockRestore();
    });
  });

  describe('saveSettings', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should save settings to repository', () => {
      const settings: VoiceSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        enabled: true,
        volume: 80,
      };

      VoiceSettingsManager.saveSettings(settings);

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        enabled: true,
        volume: 80,
      }));
    });

    it('should validate settings before saving', () => {
      const invalidSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        volume: 200, // Invalid - should be clamped to 100
        speechRate: 5, // Invalid - should be clamped to 2.0
      };

      VoiceSettingsManager.saveSettings(invalidSettings);

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        volume: 100,
        speechRate: 2.0,
      }));
    });

    it('should save API keys in repository', () => {
      const settings: VoiceSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        elevenLabsApiKey: 'secret-api-key',
      };

      VoiceSettingsManager.saveSettings(settings);

      // API key should be in the saved data
      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        elevenLabsApiKey: 'secret-api-key',
      }));
    });

    it('should update cache after saving', () => {
      const settings: VoiceSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        enabled: true,
      };

      VoiceSettingsManager.saveSettings(settings);

      // Loading should return cached value without calling repository
      mockRepositoryLoad.mockClear();
      const loaded = VoiceSettingsManager.loadSettings();

      expect(loaded.enabled).toBe(true);
      expect(mockRepositoryLoad).not.toHaveBeenCalled();
    });

    it('should throw when repository not initialized', () => {
      (VoiceSettingsManager as any).repository = null;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => VoiceSettingsManager.saveSettings(DEFAULT_VOICE_SETTINGS))
        .toThrow('Settings repository not initialized');

      consoleSpy.mockRestore();
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should merge partial settings with existing', () => {
      mockRepositoryLoad.mockReturnValue({ ...DEFAULT_VOICE_SETTINGS });

      VoiceSettingsManager.updateSettings({ enabled: true });

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        enabled: true,
        ttsProvider: DEFAULT_VOICE_SETTINGS.ttsProvider,
      }));
    });

    it('should return updated settings', () => {
      mockRepositoryLoad.mockReturnValue({ ...DEFAULT_VOICE_SETTINGS });

      const updated = VoiceSettingsManager.updateSettings({ volume: 90 });

      expect(updated.volume).toBe(90);
    });
  });

  describe('clearCache', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should clear the cached settings', () => {
      mockRepositoryLoad.mockReturnValue({ enabled: true });

      VoiceSettingsManager.loadSettings();
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);

      VoiceSettingsManager.clearCache();
      VoiceSettingsManager.loadSettings();

      // Should call repository again after clearing cache
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetSettings', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should delete settings from repository', () => {
      VoiceSettingsManager.resetSettings();

      expect(mockRepositoryDelete).toHaveBeenCalledWith('voice');
    });

    it('should clear cache', () => {
      mockRepositoryLoad.mockReturnValue({ enabled: true });

      VoiceSettingsManager.loadSettings();
      VoiceSettingsManager.resetSettings();

      // After reset, loading should hit repository again
      mockRepositoryLoad.mockReturnValue(undefined);
      VoiceSettingsManager.loadSettings();

      expect(mockRepositoryLoad).toHaveBeenCalledTimes(2);
    });
  });

  describe('hasElevenLabsKey', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should return true when key is configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        elevenLabsApiKey: 'key',
      });

      expect(VoiceSettingsManager.hasElevenLabsKey()).toBe(true);
    });

    it('should return false when key is not configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        elevenLabsApiKey: undefined,
      });

      expect(VoiceSettingsManager.hasElevenLabsKey()).toBe(false);
    });
  });

  describe('hasOpenAIKey', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should return true when key is configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        openaiApiKey: 'key',
      });

      expect(VoiceSettingsManager.hasOpenAIKey()).toBe(true);
    });

    it('should return false when key is not configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        openaiApiKey: undefined,
      });

      expect(VoiceSettingsManager.hasOpenAIKey()).toBe(false);
    });
  });

  describe('hasAzureKey', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should return true when key is configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        azureApiKey: 'key',
      });

      expect(VoiceSettingsManager.hasAzureKey()).toBe(true);
    });

    it('should return false when key is not configured', () => {
      mockRepositoryLoad.mockReturnValue({
        ...DEFAULT_VOICE_SETTINGS,
        azureApiKey: undefined,
      });

      expect(VoiceSettingsManager.hasAzureKey()).toBe(false);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      VoiceSettingsManager.initialize(mockDb);
    });

    it('should validate ttsProvider', () => {
      const settings = {
        ...DEFAULT_VOICE_SETTINGS,
        ttsProvider: 'invalid' as any,
      };

      VoiceSettingsManager.saveSettings(settings);

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        ttsProvider: DEFAULT_VOICE_SETTINGS.ttsProvider,
      }));
    });

    it('should validate inputMode', () => {
      const settings = {
        ...DEFAULT_VOICE_SETTINGS,
        inputMode: 'invalid' as any,
      };

      VoiceSettingsManager.saveSettings(settings);

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        inputMode: DEFAULT_VOICE_SETTINGS.inputMode,
      }));
    });

    it('should clamp volume to 0-100', () => {
      VoiceSettingsManager.saveSettings({
        ...DEFAULT_VOICE_SETTINGS,
        volume: -10,
      });

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        volume: 0,
      }));

      mockRepositorySave.mockClear();

      VoiceSettingsManager.saveSettings({
        ...DEFAULT_VOICE_SETTINGS,
        volume: 150,
      });

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        volume: 100,
      }));
    });

    it('should clamp speechRate to 0.5-2.0', () => {
      VoiceSettingsManager.saveSettings({
        ...DEFAULT_VOICE_SETTINGS,
        speechRate: 0.1,
      });

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        speechRate: 0.5,
      }));

      mockRepositorySave.mockClear();

      VoiceSettingsManager.saveSettings({
        ...DEFAULT_VOICE_SETTINGS,
        speechRate: 3.0,
      });

      expect(mockRepositorySave).toHaveBeenCalledWith('voice', expect.objectContaining({
        speechRate: 2.0,
      }));
    });
  });
});
