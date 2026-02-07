/**
 * Settings manager for built-in tools
 * Allows users to enable/disable and configure built-in tool categories
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { SecureSettingsRepository } from '../../database/SecureSettingsRepository';

/**
 * Tool category configuration
 */
export interface ToolCategoryConfig {
  enabled: boolean;
  priority: 'high' | 'normal' | 'low';
  description?: string;
}

/**
 * Individual tool override
 */
export interface ToolOverride {
  enabled: boolean;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Built-in tools settings structure
 */
export interface BuiltinToolsSettings {
  // Category-level settings
  categories: {
    code: ToolCategoryConfig;
    webfetch: ToolCategoryConfig;
    browser: ToolCategoryConfig;
    search: ToolCategoryConfig;
    system: ToolCategoryConfig;
    file: ToolCategoryConfig;
    skill: ToolCategoryConfig;
    shell: ToolCategoryConfig;
    image: ToolCategoryConfig;
  };
  // Individual tool overrides (tool name -> override)
  toolOverrides: Record<string, ToolOverride>;
  // Per-tool timeout overrides in milliseconds (tool name -> timeout)
  toolTimeouts: Record<string, number>;
  // Per-tool auto-approval overrides (tool name -> enabled)
  toolAutoApprove: Record<string, boolean>;
  // Version for migrations
  version: string;
}

/**
 * Default settings
 */
const DEFAULT_SETTINGS: BuiltinToolsSettings = {
  categories: {
    code: {
      enabled: true,
      priority: 'high',
      description: 'Code tools (glob, grep, edit) - preferred for code navigation and editing',
    },
    webfetch: {
      enabled: true,
      priority: 'high',
      description: 'Lightweight web fetching (preferred for reading web content)',
    },
    browser: {
      enabled: true,
      priority: 'normal',
      description: 'Browser automation tools (navigate, click, screenshot, etc.)',
    },
    search: {
      enabled: true,
      priority: 'normal',
      description: 'Web search tools (Brave, Tavily, etc.)',
    },
    system: {
      enabled: true,
      priority: 'normal',
      description: 'System tools (clipboard, screenshot, open apps, etc.)',
    },
    file: {
      enabled: true,
      priority: 'normal',
      description: 'File operations (read, write, copy, delete, etc.)',
    },
    skill: {
      enabled: true,
      priority: 'normal',
      description: 'Document creation skills (spreadsheets, documents, presentations)',
    },
    shell: {
      enabled: true,
      priority: 'normal',
      description: 'Shell command execution (requires workspace permission)',
    },
    image: {
      enabled: true,
      priority: 'normal',
      description: 'AI image generation (requires Gemini API)',
    },
  },
  toolOverrides: {},
  toolTimeouts: {},
  toolAutoApprove: {},
  version: '1.0.0',
};

/**
 * Tool category mapping
 */
const TOOL_CATEGORIES: Record<string, keyof BuiltinToolsSettings['categories']> = {
  // Code tools (high priority)
  glob: 'code',
  grep: 'code',
  edit_file: 'code',
  // Web fetch tools (high priority)
  web_fetch: 'webfetch',
  notion_action: 'webfetch',
  box_action: 'webfetch',
  onedrive_action: 'webfetch',
  google_drive_action: 'webfetch',
  gmail_action: 'webfetch',
  calendar_action: 'webfetch',
  dropbox_action: 'webfetch',
  sharepoint_action: 'webfetch',
  voice_call: 'webfetch',
  // Browser tools
  browser_navigate: 'browser',
  browser_screenshot: 'browser',
  browser_get_content: 'browser',
  browser_click: 'browser',
  browser_fill: 'browser',
  browser_type: 'browser',
  browser_press: 'browser',
  browser_wait: 'browser',
  browser_scroll: 'browser',
  browser_select: 'browser',
  browser_get_text: 'browser',
  browser_evaluate: 'browser',
  browser_back: 'browser',
  browser_forward: 'browser',
  browser_reload: 'browser',
  browser_save_pdf: 'browser',
  browser_close: 'browser',
  // Search tools
  web_search: 'search',
  // System tools
  system_info: 'system',
  read_clipboard: 'system',
  write_clipboard: 'system',
  take_screenshot: 'system',
  open_application: 'system',
  open_url: 'system',
  open_path: 'system',
  show_in_folder: 'system',
  get_env: 'system',
  get_app_paths: 'system',
  run_applescript: 'system',
  // File tools
  read_file: 'file',
  read_files: 'file',
  write_file: 'file',
  copy_file: 'file',
  list_directory: 'file',
  list_directory_with_sizes: 'file',
  get_file_info: 'file',
  rename_file: 'file',
  delete_file: 'file',
  create_directory: 'file',
  search_files: 'file',
  // Skill tools
  create_spreadsheet: 'skill',
  create_document: 'skill',
  edit_document: 'skill',
  create_presentation: 'skill',
  organize_folder: 'skill',
  // Shell tools
  run_command: 'shell',
  x_action: 'shell',
  // Image tools
  generate_image: 'image',
};

const LEGACY_SETTINGS_FILE = 'builtin-tools-settings.json';

export class BuiltinToolsSettingsManager {
  private static legacySettingsPath: string | null = null;
  private static cachedSettings: BuiltinToolsSettings | null = null;
  private static migrationCompleted = false;

  /**
   * Get the legacy settings file path
   */
  private static getLegacySettingsPath(): string {
    if (!this.legacySettingsPath) {
      const userDataPath = app.getPath('userData');
      this.legacySettingsPath = path.join(userDataPath, LEGACY_SETTINGS_FILE);
    }
    return this.legacySettingsPath;
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private static migrateFromLegacyFile(): void {
    if (this.migrationCompleted) return;

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      if (repository.exists('builtintools')) {
        this.migrationCompleted = true;
        return;
      }

      const legacyPath = this.getLegacySettingsPath();
      if (!fs.existsSync(legacyPath)) {
        this.migrationCompleted = true;
        return;
      }

      console.log('[BuiltinToolsSettings] Migrating settings from legacy JSON file to encrypted database...');

      // Create backup before migration
      const backupPath = legacyPath + '.migration-backup';
      fs.copyFileSync(legacyPath, backupPath);

      try {
        const data = fs.readFileSync(legacyPath, 'utf-8');
        const settings = JSON.parse(data) as BuiltinToolsSettings;
        const merged = this.mergeWithDefaults(settings);

        repository.save('builtintools', merged);
        console.log('[BuiltinToolsSettings] Settings migrated to encrypted database');

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(legacyPath);
        console.log('[BuiltinToolsSettings] Migration complete, cleaned up legacy files');

        this.migrationCompleted = true;
      } catch (migrationError) {
        console.error('[BuiltinToolsSettings] Migration failed, backup preserved at:', backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error('[BuiltinToolsSettings] Migration failed:', error);
    }
  }

  /**
   * Load settings from encrypted database
   */
  static loadSettings(): BuiltinToolsSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    // Try migration first
    this.migrateFromLegacyFile();

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<BuiltinToolsSettings>('builtintools');
        if (stored) {
          this.cachedSettings = this.mergeWithDefaults(stored);
          return this.cachedSettings;
        }
      }
    } catch (error) {
      console.error('[BuiltinToolsSettings] Error loading settings:', error);
    }

    // Deep clone to prevent mutation of DEFAULT_SETTINGS
    const defaults: BuiltinToolsSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.cachedSettings = defaults;
    return defaults;
  }

  /**
   * Save settings to encrypted database
   */
  static saveSettings(settings: BuiltinToolsSettings): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error('SecureSettingsRepository not initialized');
      }

      const repository = SecureSettingsRepository.getInstance();
      repository.save('builtintools', settings);
      this.cachedSettings = settings;
      console.log('[BuiltinToolsSettings] Settings saved to encrypted database');
    } catch (error) {
      console.error('[BuiltinToolsSettings] Error saving settings:', error);
      throw error;
    }
  }

  /**
   * Merge loaded settings with defaults
   */
  private static mergeWithDefaults(settings: Partial<BuiltinToolsSettings>): BuiltinToolsSettings {
    // Deep clone defaults first to prevent mutation
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as BuiltinToolsSettings;
    return {
      categories: {
        ...defaults.categories,
        ...settings.categories,
      },
      toolOverrides: settings.toolOverrides || {},
      toolTimeouts: settings.toolTimeouts || {},
      toolAutoApprove: settings.toolAutoApprove || {},
      version: settings.version || defaults.version,
    };
  }

  /**
   * Check if a tool is enabled
   */
  static isToolEnabled(toolName: string): boolean {
    const settings = this.loadSettings();

    // Check individual override first
    if (settings.toolOverrides[toolName] !== undefined) {
      return settings.toolOverrides[toolName].enabled;
    }

    // Check category
    const category = TOOL_CATEGORIES[toolName];
    if (category && settings.categories[category]) {
      return settings.categories[category].enabled;
    }

    // Default to enabled for unknown tools
    return true;
  }

  /**
   * Get tool priority
   */
  static getToolPriority(toolName: string): 'high' | 'normal' | 'low' {
    const settings = this.loadSettings();

    // Check individual override first
    if (settings.toolOverrides[toolName]?.priority) {
      return settings.toolOverrides[toolName].priority!;
    }

    // Check category
    const category = TOOL_CATEGORIES[toolName];
    if (category && settings.categories[category]) {
      return settings.categories[category].priority;
    }

    return 'normal';
  }

  /**
   * Get the category for a tool
   */
  static getToolCategory(toolName: string): string | null {
    return TOOL_CATEGORIES[toolName] || null;
  }

  /**
   * Get per-tool timeout override (ms), if configured
   */
  static getToolTimeoutMs(toolName: string): number | null {
    const settings = this.loadSettings();
    const timeout = settings.toolTimeouts?.[toolName];
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      return null;
    }
    return Math.round(timeout);
  }

  /**
   * Check if a tool should be auto-approved
   */
  static getToolAutoApprove(toolName: string): boolean {
    const settings = this.loadSettings();
    return Boolean(settings.toolAutoApprove?.[toolName]);
  }

  /**
   * Get all tool categories with their tools
   */
  static getToolsByCategory(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [tool, category] of Object.entries(TOOL_CATEGORIES)) {
      if (!result[category]) {
        result[category] = [];
      }
      result[category].push(tool);
    }
    return result;
  }

  /**
   * Enable/disable a category
   */
  static setCategoryEnabled(category: keyof BuiltinToolsSettings['categories'], enabled: boolean): void {
    const settings = this.loadSettings();
    if (settings.categories[category]) {
      settings.categories[category].enabled = enabled;
      this.saveSettings(settings);
    }
  }

  /**
   * Set category priority
   */
  static setCategoryPriority(
    category: keyof BuiltinToolsSettings['categories'],
    priority: 'high' | 'normal' | 'low'
  ): void {
    const settings = this.loadSettings();
    if (settings.categories[category]) {
      settings.categories[category].priority = priority;
      this.saveSettings(settings);
    }
  }

  /**
   * Set tool override
   */
  static setToolOverride(toolName: string, override: ToolOverride | null): void {
    const settings = this.loadSettings();
    if (override === null) {
      delete settings.toolOverrides[toolName];
    } else {
      settings.toolOverrides[toolName] = override;
    }
    this.saveSettings(settings);
  }

  /**
   * Clear cached settings (for testing or reload)
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Get default settings
   */
  static getDefaultSettings(): BuiltinToolsSettings {
    // Deep clone to prevent mutation of DEFAULT_SETTINGS
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}
