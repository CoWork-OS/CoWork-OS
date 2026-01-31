/**
 * Tests for BuiltinToolsSettingsManager - webfetch category priority
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Track writes manually since mocking fs can be complex
let writeCount = 0;
let savedSettings: any = null;

// Mock fs module entirely
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn().mockImplementation((_path: string, content: string) => {
      writeCount++;
      savedSettings = JSON.parse(content);
    }),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn().mockImplementation((_path: string, content: string) => {
    writeCount++;
    savedSettings = JSON.parse(content);
  }),
  mkdirSync: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Import after mocking
import { BuiltinToolsSettingsManager } from '../builtin-settings';

describe('BuiltinToolsSettingsManager - webfetch category', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCount = 0;
    savedSettings = null;
    BuiltinToolsSettingsManager.clearCache();
  });

  describe('default settings', () => {
    it('should have webfetch category with high priority by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.categories.webfetch).toBeDefined();
      expect(defaults.categories.webfetch.enabled).toBe(true);
      expect(defaults.categories.webfetch.priority).toBe('high');
    });

    it('should have browser category with normal priority by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.categories.browser).toBeDefined();
      expect(defaults.categories.browser.enabled).toBe(true);
      expect(defaults.categories.browser.priority).toBe('normal');
    });

    it('should have search category with normal priority by default', () => {
      const defaults = BuiltinToolsSettingsManager.getDefaultSettings();

      expect(defaults.categories.search).toBeDefined();
      expect(defaults.categories.search.enabled).toBe(true);
      expect(defaults.categories.search.priority).toBe('normal');
    });
  });

  describe('tool category mapping', () => {
    it('should map web_fetch to webfetch category', () => {
      const category = BuiltinToolsSettingsManager.getToolCategory('web_fetch');
      expect(category).toBe('webfetch');
    });

    it('should map browser_navigate to browser category', () => {
      const category = BuiltinToolsSettingsManager.getToolCategory('browser_navigate');
      expect(category).toBe('browser');
    });

    it('should map web_search to search category', () => {
      const category = BuiltinToolsSettingsManager.getToolCategory('web_search');
      expect(category).toBe('search');
    });
  });

  describe('tool priority', () => {
    it('should return high priority for web_fetch', () => {
      const priority = BuiltinToolsSettingsManager.getToolPriority('web_fetch');
      expect(priority).toBe('high');
    });

    it('should return normal priority for browser tools', () => {
      const priority = BuiltinToolsSettingsManager.getToolPriority('browser_navigate');
      expect(priority).toBe('normal');
    });

    it('should return normal priority for web_search', () => {
      const priority = BuiltinToolsSettingsManager.getToolPriority('web_search');
      expect(priority).toBe('normal');
    });
  });

  describe('tool enabled status', () => {
    it('should return true for web_fetch by default', () => {
      const enabled = BuiltinToolsSettingsManager.isToolEnabled('web_fetch');
      expect(enabled).toBe(true);
    });

    it('should return true for browser_navigate by default', () => {
      const enabled = BuiltinToolsSettingsManager.isToolEnabled('browser_navigate');
      expect(enabled).toBe(true);
    });
  });

  describe('tools by category', () => {
    it('should include web_fetch in webfetch category', () => {
      const toolsByCategory = BuiltinToolsSettingsManager.getToolsByCategory();

      expect(toolsByCategory.webfetch).toBeDefined();
      expect(toolsByCategory.webfetch).toContain('web_fetch');
    });

    it('should include browser tools in browser category', () => {
      const toolsByCategory = BuiltinToolsSettingsManager.getToolsByCategory();

      expect(toolsByCategory.browser).toBeDefined();
      expect(toolsByCategory.browser).toContain('browser_navigate');
      expect(toolsByCategory.browser).toContain('browser_screenshot');
      expect(toolsByCategory.browser).toContain('browser_get_content');
    });

    it('should include web_search in search category', () => {
      const toolsByCategory = BuiltinToolsSettingsManager.getToolsByCategory();

      expect(toolsByCategory.search).toBeDefined();
      expect(toolsByCategory.search).toContain('web_search');
    });
  });

  describe('priority comparison', () => {
    it('web_fetch should have higher priority than browser tools', () => {
      const webFetchPriority = BuiltinToolsSettingsManager.getToolPriority('web_fetch');
      const browserPriority = BuiltinToolsSettingsManager.getToolPriority('browser_navigate');

      const priorityOrder = { high: 0, normal: 1, low: 2 };
      expect(priorityOrder[webFetchPriority]).toBeLessThan(priorityOrder[browserPriority]);
    });

    it('web_fetch should have higher priority than web_search', () => {
      const webFetchPriority = BuiltinToolsSettingsManager.getToolPriority('web_fetch');
      const searchPriority = BuiltinToolsSettingsManager.getToolPriority('web_search');

      const priorityOrder = { high: 0, normal: 1, low: 2 };
      expect(priorityOrder[webFetchPriority]).toBeLessThan(priorityOrder[searchPriority]);
    });
  });
});
