/**
 * Voice Settings Manager
 *
 * Manages voice settings persistence using the encrypted database.
 * All settings (including API keys) are stored encrypted in the database
 * using the SecureSettingsRepository.
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import {
  VoiceSettings,
  VoiceProvider,
  VoiceInputMode,
  VoiceResponseMode,
  DEFAULT_VOICE_SETTINGS,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";

// Legacy file names for migration
const LEGACY_SETTINGS_FILE = "voice-settings.json";
const LEGACY_SECURE_KEYS_FILE = "voice-keys.enc";
const logger = createLogger("VoiceSettingsManager");

// Legacy interfaces for migration
interface LegacyVoiceSettingsFile {
  enabled?: boolean;
  ttsProvider?: VoiceProvider;
  sttProvider?: VoiceProvider;
  elevenLabsVoiceId?: string;
  openaiVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  azureEndpoint?: string;
  azureTtsDeploymentName?: string;
  azureSttDeploymentName?: string;
  azureVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  azureApiVersion?: string;
  inputMode?: VoiceInputMode;
  responseMode?: VoiceResponseMode;
  pushToTalkKey?: string;
  volume?: number;
  speechRate?: number;
  language?: string;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  silenceTimeout?: number;
  audioFeedback?: boolean;
}

interface LegacySecureKeys {
  elevenLabsApiKey?: string;
  openaiApiKey?: string;
  azureApiKey?: string;
}

export class VoiceSettingsManager {
  private static repository: SecureSettingsRepository | null = null;
  private static cachedSettings: VoiceSettings | null = null;
  private static userDataPath: string;
  private static migrationComplete = false;

  /**
   * Initialize the VoiceSettingsManager with the database
   */
  static initialize(db?: Database.Database): void {
    this.userDataPath = getUserDataDir();
    const repository = this.resolveRepository(db);
    if (!repository) {
      logger.warn("No database provided, will initialize on first use");
      return;
    }

    logger.debug("Initialized with secure database storage");
    this.migrateFromLegacyFiles();
  }

  /**
   * Set the repository (called after database is ready)
   */
  static setRepository(db: Database.Database): void {
    this.resolveRepository(db);
    logger.debug("Repository set");

    // Migrate from legacy JSON files if needed
    if (!this.migrationComplete) {
      this.migrateFromLegacyFiles();
    }
  }

  /**
   * Load voice settings from encrypted database
   */
  static loadSettings(): VoiceSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };

    try {
      if (this.repository) {
        const stored = this.repository.load<VoiceSettings>("voice");
        if (stored) {
          settings = {
            ...DEFAULT_VOICE_SETTINGS,
            ...stored,
          };
          // Validate values
          settings = this.validateSettings(settings);
        }
      } else {
        logger.warn("Repository not initialized, using defaults");
      }
    } catch (error) {
      logger.error("Failed to load settings:", error);
      settings = { ...DEFAULT_VOICE_SETTINGS };
    }

    this.cachedSettings = settings;
    return settings;
  }

  /**
   * Save voice settings to encrypted database
   */
  static saveSettings(settings: VoiceSettings): void {
    try {
      // Validate and prepare settings for storage
      const validatedSettings = this.validateSettings(settings);

      if (this.repository) {
        // Save all settings (including API keys) encrypted in database
        this.repository.save("voice", validatedSettings);
      } else {
        logger.error("Repository not initialized, cannot save");
        throw new Error("Settings repository not initialized");
      }

      this.cachedSettings = validatedSettings;
      logger.debug("Settings saved to encrypted database");
    } catch (error) {
      logger.error("Failed to save settings:", error);
      throw error;
    }
  }

  /**
   * Update partial settings
   */
  static updateSettings(partial: Partial<VoiceSettings>): VoiceSettings {
    const current = this.loadSettings();
    const updated = { ...current, ...partial };
    this.saveSettings(updated);
    return updated;
  }

  /**
   * Clear cached settings
   */
  static clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Delete all voice settings (reset to defaults)
   */
  static resetSettings(): void {
    try {
      if (this.repository) {
        this.repository.delete("voice");
      }
      this.cachedSettings = null;
      logger.debug("Settings reset to defaults");
    } catch (error) {
      logger.error("Failed to reset settings:", error);
      throw error;
    }
  }

  /**
   * Check if ElevenLabs API key is configured
   */
  static hasElevenLabsKey(): boolean {
    const settings = this.loadSettings();
    return !!settings.elevenLabsApiKey;
  }

  /**
   * Check if OpenAI API key is configured
   */
  static hasOpenAIKey(): boolean {
    const settings = this.loadSettings();
    return !!settings.openaiApiKey;
  }

  /**
   * Check if Azure API key is configured
   */
  static hasAzureKey(): boolean {
    const settings = this.loadSettings();
    return !!settings.azureApiKey;
  }

  // ============ Migration from Legacy Files ============

  /**
   * Migrate settings from legacy JSON files to encrypted database
   */
  private static migrateFromLegacyFiles(): void {
    if (this.migrationComplete) return;
    if (!this.repository) return;

    const legacySettingsPath = path.join(this.userDataPath, LEGACY_SETTINGS_FILE);
    const legacyKeysPath = path.join(this.userDataPath, LEGACY_SECURE_KEYS_FILE);

    // Check if legacy files exist
    const hasLegacySettings = fs.existsSync(legacySettingsPath);
    const hasLegacyKeys = fs.existsSync(legacyKeysPath);

    if (!hasLegacySettings && !hasLegacyKeys) {
      this.migrationComplete = true;
      return;
    }

    // Check if we already have settings in the database
    if (this.repository.exists("voice")) {
      // Clean up legacy files
      this.cleanupLegacyFiles();
      this.migrationComplete = true;
      return;
    }

    logger.debug("Migrating from legacy JSON files to encrypted database...");

    // Create backups before migration
    const settingsBackupPath = legacySettingsPath + ".migration-backup";
    const keysBackupPath = legacyKeysPath + ".migration-backup";

    try {
      if (hasLegacySettings) {
        fs.copyFileSync(legacySettingsPath, settingsBackupPath);
      }
      if (hasLegacyKeys) {
        fs.copyFileSync(legacyKeysPath, keysBackupPath);
      }
    } catch (backupError) {
      logger.error("Failed to create backups:", backupError);
      return;
    }

    try {
      let settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };

      // Load legacy settings file
      if (hasLegacySettings) {
        const data = fs.readFileSync(legacySettingsPath, "utf-8");
        const parsed: LegacyVoiceSettingsFile = JSON.parse(data);
        settings = {
          ...DEFAULT_VOICE_SETTINGS,
          ...parsed,
        };
        logger.debug("Loaded legacy settings file");
      }

      // Load legacy secure keys
      if (hasLegacyKeys) {
        const secureKeys = this.loadLegacySecureKeys(legacyKeysPath);
        if (secureKeys.elevenLabsApiKey) {
          settings.elevenLabsApiKey = secureKeys.elevenLabsApiKey;
        }
        if (secureKeys.openaiApiKey) {
          settings.openaiApiKey = secureKeys.openaiApiKey;
        }
        if (secureKeys.azureApiKey) {
          settings.azureApiKey = secureKeys.azureApiKey;
        }
        logger.debug("Loaded legacy secure keys");
      }

      // Validate and save to database
      settings = this.validateSettings(settings);
      this.repository.save("voice", settings);
      this.cachedSettings = settings;

      logger.debug("Successfully migrated to encrypted database");

      // Migration successful - delete backups and original files
      if (hasLegacySettings) {
        fs.unlinkSync(settingsBackupPath);
        fs.unlinkSync(legacySettingsPath);
      }
      if (hasLegacyKeys) {
        fs.unlinkSync(keysBackupPath);
        fs.unlinkSync(legacyKeysPath);
      }
      logger.debug("Migration complete, cleaned up legacy files");

      this.migrationComplete = true;
    } catch (error) {
      logger.error("Migration failed, backups preserved:", error);
      if (hasLegacySettings) {
        logger.error("Settings backup at:", settingsBackupPath);
      }
      if (hasLegacyKeys) {
        logger.error("Keys backup at:", keysBackupPath);
      }
      // Don't throw - allow app to continue with defaults
      this.migrationComplete = true;
    }
  }

  /**
   * Load secure keys from legacy encrypted file
   */
  private static loadLegacySecureKeys(legacyKeysPath: string): LegacySecureKeys {
    try {
      const safeStorage = getSafeStorage();
      if (!safeStorage?.isEncryptionAvailable?.()) {
        // Fall back to plain text storage if encryption unavailable
        const data = fs.readFileSync(legacyKeysPath, "utf-8");
        return JSON.parse(data);
      }

      const encryptedData = fs.readFileSync(legacyKeysPath);
      const decryptedString = safeStorage.decryptString(encryptedData);
      return JSON.parse(decryptedString);
    } catch (error) {
      logger.error("Failed to load legacy secure keys:", error);
      return {};
    }
  }

  /**
   * Remove legacy files after successful migration
   */
  private static cleanupLegacyFiles(): void {
    const legacySettingsPath = path.join(this.userDataPath, LEGACY_SETTINGS_FILE);
    const legacyKeysPath = path.join(this.userDataPath, LEGACY_SECURE_KEYS_FILE);

    try {
      if (fs.existsSync(legacySettingsPath)) {
        // Rename to .bak instead of deleting (safety)
        fs.renameSync(legacySettingsPath, legacySettingsPath + ".migrated");
        logger.debug("Backed up legacy settings file");
      }
      if (fs.existsSync(legacyKeysPath)) {
        // Securely delete encrypted keys file
        fs.unlinkSync(legacyKeysPath);
        logger.debug("Removed legacy secure keys file");
      }
    } catch (error) {
      logger.warn("Failed to clean up legacy files:", error);
      // Non-fatal - continue anyway
    }
  }

  private static resolveRepository(
    db?: Database.Database,
  ): SecureSettingsRepository | null {
    if (this.repository) {
      return this.repository;
    }

    if (SecureSettingsRepository.isInitialized()) {
      this.repository = SecureSettingsRepository.getInstance();
      return this.repository;
    }

    if (db) {
      this.repository = new SecureSettingsRepository(db);
      return this.repository;
    }

    return null;
  }

  // ============ Validation ============

  private static validateSettings(settings: VoiceSettings): VoiceSettings {
    const validated = { ...settings };

    // Validate provider
    if (!["elevenlabs", "openai", "azure", "local"].includes(validated.ttsProvider)) {
      validated.ttsProvider = DEFAULT_VOICE_SETTINGS.ttsProvider;
    }
    if (!["elevenlabs", "openai", "azure", "local"].includes(validated.sttProvider)) {
      validated.sttProvider = DEFAULT_VOICE_SETTINGS.sttProvider;
    }

    // Validate input mode
    if (!["push_to_talk", "voice_activity", "disabled"].includes(validated.inputMode)) {
      validated.inputMode = DEFAULT_VOICE_SETTINGS.inputMode;
    }

    // Validate response mode
    if (!["auto", "manual", "smart"].includes(validated.responseMode)) {
      validated.responseMode = DEFAULT_VOICE_SETTINGS.responseMode;
    }

    // Validate OpenAI and Azure voices
    const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    if (validated.openaiVoice && !validVoices.includes(validated.openaiVoice)) {
      validated.openaiVoice = undefined;
    }
    if (validated.azureVoice && !validVoices.includes(validated.azureVoice)) {
      validated.azureVoice = undefined;
    }

    // Validate numeric ranges
    validated.volume = Math.max(
      0,
      Math.min(100, validated.volume || DEFAULT_VOICE_SETTINGS.volume),
    );
    validated.speechRate = Math.max(
      0.5,
      Math.min(2.0, validated.speechRate || DEFAULT_VOICE_SETTINGS.speechRate),
    );
    validated.silenceTimeout = Math.max(
      1,
      Math.min(10, validated.silenceTimeout || DEFAULT_VOICE_SETTINGS.silenceTimeout),
    );

    return validated;
  }
}
