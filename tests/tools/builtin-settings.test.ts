/**
 * Tests for Built-in Tools Settings Manager
 *
 * Tests the settings management for enabling/disabling
 * built-in tools and setting their priorities.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron app module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

let mockStoredSettings: any = undefined;
const mockRepositorySave = vi.fn().mockImplementation((_category: string, settings: any) => {
  mockStoredSettings = settings;
});
const mockRepositoryLoad = vi.fn().mockImplementation(() => mockStoredSettings);
const mockRepositoryExists = vi.fn().mockImplementation(() => mockStoredSettings !== undefined);

// Mock SecureSettingsRepository
vi.mock('../../src/electron/database/SecureSettingsRepository', () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockImplementation(() => ({
      save: mockRepositorySave,
      load: mockRepositoryLoad,
      exists: mockRepositoryExists,
    })),
  },
}));

// Mock fs module (legacy migration path)
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are set up
import {
  BuiltinToolsSettingsManager,
  BuiltinToolsSettings,
  ToolCategoryConfig,
} from '../../src/electron/agent/tools/builtin-settings';

describe('BuiltinToolsSettingsManager', () => {
  beforeEach(() => {
    // Clear the cached settings before each test
    BuiltinToolsSettingsManager.clearCache();
    // Reset all mocks
    vi.clearAllMocks();
    mockStoredSettings = undefined;
    (BuiltinToolsSettingsManager as any).migrationCompleted = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSettings', () => {
    it('should return default settings when no settings file exists', () => {
      mockStoredSettings = undefined;
      const settings = BuiltinToolsSettingsManager.loadSettings();

      expect(settings).toBeDefined();
      expect(settings.categories).toBeDefined();
      expect(settings.categories.browser.enabled).toBe(true);
      expect(settings.categories.browser.priority).toBe('normal');
      expect(settings.version).toBe('1.0.0');
    });

    it('should load settings from file when it exists', () => {
      const savedSettings: BuiltinToolsSettings = {
        categories: {
          browser: { enabled: false, priority: 'low' },
          search: { enabled: true, priority: 'high' },
          system: { enabled: true, priority: 'normal' },
          file: { enabled: true, priority: 'normal' },
          skill: { enabled: true, priority: 'normal' },
          shell: { enabled: true, priority: 'normal' },
          image: { enabled: true, priority: 'normal' },
        },
        toolOverrides: {},
        toolTimeouts: {},
        toolAutoApprove: {},
        runCommandApprovalMode: 'single_bundle',
        version: '1.0.0',
      };

      mockStoredSettings = savedSettings;

      const settings = BuiltinToolsSettingsManager.loadSettings();

      expect(settings.categories.browser.enabled).toBe(false);
      expect(settings.categories.browser.priority).toBe('low');
      expect(settings.categories.search.priority).toBe('high');
    });

    it('should merge loaded settings with defaults for new fields', () => {
      // Simulate old settings missing the image category
      const partialSettings = {
        categories: {
          browser: { enabled: false, priority: 'low' as const },
          search: { enabled: true, priority: 'normal' as const },
          system: { enabled: true, priority: 'normal' as const },
          file: { enabled: true, priority: 'normal' as const },
          skill: { enabled: true, priority: 'normal' as const },
          shell: { enabled: true, priority: 'normal' as const },
        },
        toolOverrides: {},
        toolTimeouts: {},
        toolAutoApprove: {},
        version: '1.0.0',
      };

      mockStoredSettings = partialSettings as BuiltinToolsSettings;

      const settings = BuiltinToolsSettingsManager.loadSettings();

      // Should have merged the image category from defaults
      expect(settings.categories.image).toBeDefined();
      expect(settings.categories.image.enabled).toBe(true);
      expect(settings.runCommandApprovalMode).toBe('single_bundle');
    });

    it('should cache settings after first load', () => {
      // First call
      BuiltinToolsSettingsManager.loadSettings();
      // Second call
      BuiltinToolsSettingsManager.loadSettings();

      // Repository load should only be called once due to caching
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);
    });

    it('should handle JSON parse errors gracefully', () => {
      mockRepositoryLoad.mockImplementationOnce(() => {
        throw new Error('invalid json');
      });

      const settings = BuiltinToolsSettingsManager.loadSettings();

      // Should fall back to defaults on error
      expect(settings.categories.browser.enabled).toBe(true);
    });
  });

  describe('saveSettings', () => {
    it('should save settings to the repository', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.enabled = false;

      BuiltinToolsSettingsManager.saveSettings(settings);

      expect(mockRepositorySave).toHaveBeenCalledWith('builtintools', settings);
    });

    it('should persist settings data', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();

      BuiltinToolsSettingsManager.saveSettings(settings);

      expect(mockStoredSettings.categories).toBeDefined();
      expect(mockStoredSettings.version).toBe('1.0.0');
    });

    it('should update the cache after saving', () => {
      // Load defaults
      let settings = BuiltinToolsSettingsManager.loadSettings();
      expect(settings.categories.browser.enabled).toBe(true);

      // Modify and save
      settings = { ...settings };
      settings.categories = { ...settings.categories };
      settings.categories.browser = { ...settings.categories.browser, enabled: false };
      BuiltinToolsSettingsManager.saveSettings(settings);

      // Load again - should return cached value without reading file
      const loaded = BuiltinToolsSettingsManager.loadSettings();
      expect(loaded.categories.browser.enabled).toBe(false);
      // Repository load should only have been called once (initial load)
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);
    });
  });

  describe('isToolEnabled', () => {
    it('should return true for tools in enabled categories', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.enabled = true;
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_navigate')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_click')).toBe(true);
    });

    it('should return false for tools in disabled categories', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.enabled = false;
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_navigate')).toBe(false);
      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_screenshot')).toBe(false);
    });

    it('should respect individual tool overrides over category settings', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.enabled = true;
      settings.toolOverrides['browser_navigate'] = { enabled: false };
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      // Tool override should take precedence
      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_navigate')).toBe(false);
      // Other browser tools should still be enabled
      expect(BuiltinToolsSettingsManager.isToolEnabled('browser_click')).toBe(true);
    });

    it('should return true for unknown tools (not in category mapping)', () => {
      expect(BuiltinToolsSettingsManager.isToolEnabled('unknown_tool')).toBe(true);
    });

    it('should correctly check tools in each category', () => {
      // Test one tool from each category with defaults
      expect(BuiltinToolsSettingsManager.isToolEnabled('read_file')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('web_search')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('read_clipboard')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('create_spreadsheet')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('run_command')).toBe(true);
      expect(BuiltinToolsSettingsManager.isToolEnabled('generate_image')).toBe(true);
    });
  });

  describe('getToolPriority', () => {
    it('should return category priority for tools', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.priority = 'high';
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      expect(BuiltinToolsSettingsManager.getToolPriority('browser_navigate')).toBe('high');
    });

    it('should return normal priority by default', () => {
      expect(BuiltinToolsSettingsManager.getToolPriority('read_file')).toBe('normal');
    });

    it('should respect individual tool priority overrides', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.categories.browser.priority = 'high';
      settings.toolOverrides['browser_navigate'] = { enabled: true, priority: 'low' };
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      // Tool override should take precedence
      expect(BuiltinToolsSettingsManager.getToolPriority('browser_navigate')).toBe('low');
      // Other browser tools should have category priority
      expect(BuiltinToolsSettingsManager.getToolPriority('browser_click')).toBe('high');
    });

    it('should return normal for unknown tools', () => {
      expect(BuiltinToolsSettingsManager.getToolPriority('unknown_tool')).toBe('normal');
    });
  });

  describe('getToolCategory', () => {
    it('should return correct category for browser tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('browser_navigate')).toBe('browser');
      expect(BuiltinToolsSettingsManager.getToolCategory('browser_click')).toBe('browser');
      expect(BuiltinToolsSettingsManager.getToolCategory('browser_screenshot')).toBe('browser');
    });

    it('should return correct category for file tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('read_file')).toBe('file');
      expect(BuiltinToolsSettingsManager.getToolCategory('write_file')).toBe('file');
      expect(BuiltinToolsSettingsManager.getToolCategory('delete_file')).toBe('file');
    });

    it('should return correct category for system tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('read_clipboard')).toBe('system');
      expect(BuiltinToolsSettingsManager.getToolCategory('take_screenshot')).toBe('system');
    });

    it('should return correct category for search tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('web_search')).toBe('search');
    });

    it('should return correct category for skill tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('create_spreadsheet')).toBe('skill');
      expect(BuiltinToolsSettingsManager.getToolCategory('create_document')).toBe('skill');
    });

    it('should return correct category for shell tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('run_command')).toBe('shell');
    });

    it('should return correct category for image tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('generate_image')).toBe('image');
    });

    it('should return null for unknown tools', () => {
      expect(BuiltinToolsSettingsManager.getToolCategory('unknown_tool')).toBe(null);
    });
  });

  describe('getToolsByCategory', () => {
    it('should return all tools grouped by category', () => {
      const byCategory = BuiltinToolsSettingsManager.getToolsByCategory();

      expect(byCategory).toBeDefined();
      expect(byCategory.browser).toContain('browser_navigate');
      expect(byCategory.browser).toContain('browser_click');
      expect(byCategory.file).toContain('read_file');
      expect(byCategory.file).toContain('write_file');
      expect(byCategory.search).toContain('web_search');
      expect(byCategory.system).toContain('read_clipboard');
      expect(byCategory.skill).toContain('create_spreadsheet');
      expect(byCategory.shell).toContain('run_command');
      expect(byCategory.image).toContain('generate_image');
    });

    it('should include all browser tools', () => {
      const byCategory = BuiltinToolsSettingsManager.getToolsByCategory();
      const browserTools = byCategory.browser;

      expect(browserTools).toContain('browser_navigate');
      expect(browserTools).toContain('browser_screenshot');
      expect(browserTools).toContain('browser_get_content');
      expect(browserTools).toContain('browser_click');
      expect(browserTools).toContain('browser_fill');
      expect(browserTools).toContain('browser_type');
      expect(browserTools).toContain('browser_press');
      expect(browserTools).toContain('browser_wait');
      expect(browserTools).toContain('browser_scroll');
    });
  });

  describe('setCategoryEnabled', () => {
    it('should enable a category', () => {
      BuiltinToolsSettingsManager.setCategoryEnabled('browser', true);

      expect(mockStoredSettings.categories.browser.enabled).toBe(true);
    });

    it('should disable a category', () => {
      BuiltinToolsSettingsManager.setCategoryEnabled('browser', false);

      expect(mockStoredSettings.categories.browser.enabled).toBe(false);
    });
  });

  describe('setCategoryPriority', () => {
    it('should set category priority to high', () => {
      BuiltinToolsSettingsManager.setCategoryPriority('browser', 'high');

      expect(mockStoredSettings.categories.browser.priority).toBe('high');
    });

    it('should set category priority to low', () => {
      BuiltinToolsSettingsManager.setCategoryPriority('search', 'low');

      expect(mockStoredSettings.categories.search.priority).toBe('low');
    });
  });

  describe('setToolOverride', () => {
    it('should add a tool override', () => {
      BuiltinToolsSettingsManager.setToolOverride('browser_navigate', {
        enabled: false,
        priority: 'low',
      });

      expect(mockStoredSettings.toolOverrides['browser_navigate']).toEqual({
        enabled: false,
        priority: 'low',
      });
    });

    it('should remove a tool override when null', () => {
      // First add an override
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.toolOverrides['browser_navigate'] = { enabled: false };
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      // Then remove it
      BuiltinToolsSettingsManager.setToolOverride('browser_navigate', null);

      expect(mockStoredSettings.toolOverrides['browser_navigate']).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('should force settings to be reloaded from storage', () => {
      // First load
      BuiltinToolsSettingsManager.loadSettings();
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);

      // Second load (cached)
      BuiltinToolsSettingsManager.loadSettings();
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(1);

      // Clear cache
      BuiltinToolsSettingsManager.clearCache();

      // Third load (should read from storage again)
      BuiltinToolsSettingsManager.loadSettings();
      expect(mockRepositoryLoad).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDefaultSettings', () => {
    it('should return a copy of default settings', () => {
      const defaults1 = BuiltinToolsSettingsManager.getDefaultSettings();
      const defaults2 = BuiltinToolsSettingsManager.getDefaultSettings();

      // Should be equal but not the same reference
      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2);
    });

    it('should have all categories enabled by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.categories.browser.enabled).toBe(true);
      expect(defaults.categories.search.enabled).toBe(true);
      expect(defaults.categories.system.enabled).toBe(true);
      expect(defaults.categories.file.enabled).toBe(true);
      expect(defaults.categories.skill.enabled).toBe(true);
      expect(defaults.categories.shell.enabled).toBe(true);
      expect(defaults.categories.image.enabled).toBe(true);
    });

    it('should use single-bundle shell approval mode by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();
      expect(defaults.runCommandApprovalMode).toBe('single_bundle');
    });

    it('should have all categories at normal priority by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.categories.browser.priority).toBe('normal');
      expect(defaults.categories.search.priority).toBe('normal');
      expect(defaults.categories.system.priority).toBe('normal');
      expect(defaults.categories.file.priority).toBe('normal');
      expect(defaults.categories.skill.priority).toBe('normal');
      expect(defaults.categories.shell.priority).toBe('normal');
      expect(defaults.categories.image.priority).toBe('normal');
    });

    it('should keep x_search disabled by default for opt-in', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.toolOverrides).toEqual({
        x_search: { enabled: false },
      });
    });
  });

  describe('getRunCommandApprovalMode', () => {
    it('returns single_bundle when configured', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings();
      settings.runCommandApprovalMode = 'single_bundle';
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      expect(BuiltinToolsSettingsManager.getRunCommandApprovalMode()).toBe('single_bundle');
    });

    it('falls back to single_bundle for unknown values', () => {
      const settings = BuiltinToolsSettingsManager.getDefaultSettings() as any;
      settings.runCommandApprovalMode = 'unexpected_mode';
      mockStoredSettings = settings;
      BuiltinToolsSettingsManager.clearCache();

      expect(BuiltinToolsSettingsManager.getRunCommandApprovalMode()).toBe('single_bundle');
    });
  });
});

describe('Tool Category Mapping Integration', () => {
  beforeEach(() => {
    BuiltinToolsSettingsManager.clearCache();
    mockStoredSettings = undefined;
  });

  it('should disable all browser tools when browser category is disabled', () => {
    const settings = BuiltinToolsSettingsManager.getDefaultSettings();
    settings.categories.browser.enabled = false;
    mockStoredSettings = settings;
    BuiltinToolsSettingsManager.clearCache();

    const browserTools = BuiltinToolsSettingsManager.getToolsByCategory().browser;
    for (const tool of browserTools) {
      expect(BuiltinToolsSettingsManager.isToolEnabled(tool)).toBe(false);
    }
  });

  it('should set all file tools to low priority when file category is low priority', () => {
    const settings = BuiltinToolsSettingsManager.getDefaultSettings();
    settings.categories.file.priority = 'low';
    mockStoredSettings = settings;
    BuiltinToolsSettingsManager.clearCache();

    const fileTools = BuiltinToolsSettingsManager.getToolsByCategory().file;
    for (const tool of fileTools) {
      expect(BuiltinToolsSettingsManager.getToolPriority(tool)).toBe('low');
    }
  });

  it('should allow mixed enabled/disabled state via tool overrides', () => {
    const settings = BuiltinToolsSettingsManager.getDefaultSettings();
    settings.categories.browser.enabled = true;
    settings.toolOverrides['browser_navigate'] = { enabled: false };
    settings.toolOverrides['browser_click'] = { enabled: false };
    mockStoredSettings = settings;
    BuiltinToolsSettingsManager.clearCache();

    expect(BuiltinToolsSettingsManager.isToolEnabled('browser_navigate')).toBe(false);
    expect(BuiltinToolsSettingsManager.isToolEnabled('browser_click')).toBe(false);
    expect(BuiltinToolsSettingsManager.isToolEnabled('browser_screenshot')).toBe(true);
    expect(BuiltinToolsSettingsManager.isToolEnabled('browser_fill')).toBe(true);
  });
});
