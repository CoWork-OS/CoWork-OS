/**
 * Guardrail Manager
 *
 * Manages user-configurable safety guardrails for the agent.
 * Provides settings storage and helper methods for enforcement.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { GuardrailSettings, DEFAULT_BLOCKED_COMMAND_PATTERNS, DEFAULT_TRUSTED_COMMAND_PATTERNS } from '../../shared/types';

const SETTINGS_FILE = 'guardrail-settings.json';

const DEFAULT_SETTINGS: GuardrailSettings = {
  // Token Budget
  maxTokensPerTask: 100000,
  tokenBudgetEnabled: true,

  // Cost Budget
  maxCostPerTask: 1.00,
  costBudgetEnabled: false,

  // Dangerous Commands
  blockDangerousCommands: true,
  customBlockedPatterns: [],

  // Auto-Approve Trusted Commands
  autoApproveTrustedCommands: false,
  trustedCommandPatterns: [],

  // File Size
  maxFileSizeMB: 50,
  fileSizeLimitEnabled: true,

  // Network Domains
  enforceAllowedDomains: false,
  allowedDomains: [],

  // Iterations
  maxIterationsPerTask: 50,
  iterationLimitEnabled: true,
};

export class GuardrailManager {
  private static settingsPath: string;
  private static cachedSettings: GuardrailSettings | null = null;

  /**
   * Initialize the GuardrailManager with the settings path
   */
  static initialize(): void {
    const userDataPath = app.getPath('userData');
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
  }

  /**
   * Load settings from disk (with caching)
   */
  static loadSettings(): GuardrailSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(data);
        // Merge with defaults to handle missing fields from older versions
        this.cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
      } else {
        this.cachedSettings = { ...DEFAULT_SETTINGS };
      }
    } catch (error) {
      console.error('[GuardrailManager] Failed to load settings:', error);
      this.cachedSettings = { ...DEFAULT_SETTINGS };
    }

    return this.cachedSettings!;
  }

  /**
   * Save settings to disk
   */
  static saveSettings(settings: GuardrailSettings): void {
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
      this.cachedSettings = settings;
      console.log('[GuardrailManager] Settings saved');
    } catch (error) {
      console.error('[GuardrailManager] Failed to save settings:', error);
      throw error;
    }
  }

  /**
   * Clear the settings cache (call after external changes)
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Get default settings (for reference)
   */
  static getDefaults(): GuardrailSettings {
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Check if a command matches any blocked pattern
   * @returns Object with blocked status and matched pattern if blocked
   */
  static isCommandBlocked(command: string): { blocked: boolean; pattern?: string } {
    const settings = this.loadSettings();

    if (!settings.blockDangerousCommands) {
      return { blocked: false };
    }

    // Combine default patterns with custom patterns
    const allPatterns = [
      ...DEFAULT_BLOCKED_COMMAND_PATTERNS,
      ...settings.customBlockedPatterns,
    ];

    for (const pattern of allPatterns) {
      try {
        // Try to compile as regex
        const regex = new RegExp(pattern, 'i');
        if (regex.test(command)) {
          return { blocked: true, pattern };
        }
      } catch {
        // If invalid regex, try simple case-insensitive substring match
        if (command.toLowerCase().includes(pattern.toLowerCase())) {
          return { blocked: true, pattern };
        }
      }
    }

    return { blocked: false };
  }

  /**
   * Convert a glob-like pattern to regex
   * Supports * as wildcard for any characters
   */
  private static globToRegex(pattern: string): RegExp {
    // Escape special regex characters except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // Convert * to regex wildcard (.*)
    const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr, 'i');
  }

  /**
   * Check if a command matches any trusted pattern (auto-approve without user confirmation)
   * @returns Object with trusted status and matched pattern if trusted
   */
  static isCommandTrusted(command: string): { trusted: boolean; pattern?: string } {
    const settings = this.loadSettings();

    if (!settings.autoApproveTrustedCommands) {
      return { trusted: false };
    }

    // Combine default patterns with custom patterns
    const allPatterns = [
      ...DEFAULT_TRUSTED_COMMAND_PATTERNS,
      ...settings.trustedCommandPatterns,
    ];

    for (const pattern of allPatterns) {
      try {
        const regex = this.globToRegex(pattern);
        if (regex.test(command)) {
          return { trusted: true, pattern };
        }
      } catch {
        // If conversion fails, try simple prefix match
        const prefix = pattern.replace(/\*/g, '');
        if (command.toLowerCase().startsWith(prefix.toLowerCase())) {
          return { trusted: true, pattern };
        }
      }
    }

    return { trusted: false };
  }

  /**
   * Check if a URL's domain is allowed for network access
   * @returns true if allowed, false if blocked
   */
  static isDomainAllowed(url: string): boolean {
    const settings = this.loadSettings();

    // If domain enforcement is disabled, allow everything
    if (!settings.enforceAllowedDomains) {
      return true;
    }

    // If no domains configured, block everything (safety)
    if (settings.allowedDomains.length === 0) {
      return false;
    }

    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return settings.allowedDomains.some(pattern => {
        const normalizedPattern = pattern.toLowerCase().trim();

        if (normalizedPattern.startsWith('*.')) {
          // Wildcard match (e.g., *.google.com matches maps.google.com)
          const suffix = normalizedPattern.slice(2);
          return hostname === suffix || hostname.endsWith('.' + suffix);
        }

        // Exact match
        return hostname === normalizedPattern;
      });
    } catch {
      // Invalid URL - block it
      return false;
    }
  }

  /**
   * Check if file size exceeds the limit
   * @param sizeInBytes Size of the content in bytes
   * @returns Object with exceeded status and limit info
   */
  static isFileSizeExceeded(sizeInBytes: number): {
    exceeded: boolean;
    sizeMB: number;
    limitMB: number;
  } {
    const settings = this.loadSettings();
    const sizeMB = sizeInBytes / (1024 * 1024);

    if (!settings.fileSizeLimitEnabled) {
      return { exceeded: false, sizeMB, limitMB: settings.maxFileSizeMB };
    }

    return {
      exceeded: sizeMB > settings.maxFileSizeMB,
      sizeMB,
      limitMB: settings.maxFileSizeMB,
    };
  }

  /**
   * Check if token budget is exceeded
   */
  static isTokenBudgetExceeded(tokensUsed: number): {
    exceeded: boolean;
    used: number;
    limit: number;
  } {
    const settings = this.loadSettings();

    if (!settings.tokenBudgetEnabled) {
      return { exceeded: false, used: tokensUsed, limit: settings.maxTokensPerTask };
    }

    return {
      exceeded: tokensUsed >= settings.maxTokensPerTask,
      used: tokensUsed,
      limit: settings.maxTokensPerTask,
    };
  }

  /**
   * Check if cost budget is exceeded
   */
  static isCostBudgetExceeded(costIncurred: number): {
    exceeded: boolean;
    cost: number;
    limit: number;
  } {
    const settings = this.loadSettings();

    if (!settings.costBudgetEnabled) {
      return { exceeded: false, cost: costIncurred, limit: settings.maxCostPerTask };
    }

    return {
      exceeded: costIncurred >= settings.maxCostPerTask,
      cost: costIncurred,
      limit: settings.maxCostPerTask,
    };
  }

  /**
   * Check if iteration limit is exceeded
   */
  static isIterationLimitExceeded(iterations: number): {
    exceeded: boolean;
    iterations: number;
    limit: number;
  } {
    const settings = this.loadSettings();

    if (!settings.iterationLimitEnabled) {
      return { exceeded: false, iterations, limit: settings.maxIterationsPerTask };
    }

    return {
      exceeded: iterations >= settings.maxIterationsPerTask,
      iterations,
      limit: settings.maxIterationsPerTask,
    };
  }
}
