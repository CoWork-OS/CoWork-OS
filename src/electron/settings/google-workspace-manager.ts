/**
 * Google Workspace Settings Manager
 *
 * Stores Google Workspace integration settings in encrypted database.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { GoogleWorkspaceSettingsData } from "../../shared/types";
import {
  getActiveGoogleWorkspaceAccount,
  inferGoogleWorkspaceConnectionMode,
  normalizeGoogleAccountEmail,
} from "../../shared/google-workspace";

const DEFAULT_SETTINGS: GoogleWorkspaceSettingsData = {
  enabled: false,
  connectionMode: "gmail",
  timeoutMs: 20000,
};

export class GoogleWorkspaceSettingsManager {
  private static cachedSettings: GoogleWorkspaceSettingsData | null = null;

  static loadSettings(): GoogleWorkspaceSettingsData {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: GoogleWorkspaceSettingsData = { ...DEFAULT_SETTINGS };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        // Keep legacy category key for backwards compatibility with existing Google Drive settings.
        const stored = repository.load<GoogleWorkspaceSettingsData>("google-drive");
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
          if (!stored.connectionMode) {
            settings.connectionMode = inferGoogleWorkspaceConnectionMode(undefined, stored.scopes);
          }
          if (!settings.activeAccountEmail && settings.accounts?.length) {
            settings.activeAccountEmail = settings.accounts[0].email;
          }
          const activeAccount = getActiveGoogleWorkspaceAccount(settings);
          if (activeAccount) {
            settings.activeAccountEmail = normalizeGoogleAccountEmail(activeAccount.email);
            settings.accessToken = activeAccount.accessToken;
            settings.refreshToken = activeAccount.refreshToken;
            settings.tokenExpiresAt = activeAccount.tokenExpiresAt;
            settings.scopes = activeAccount.scopes ?? settings.scopes;
            settings.connectionMode = activeAccount.connectionMode ?? settings.connectionMode;
            settings.loginHint = activeAccount.email;
          }
        }
      }
    } catch (error) {
      console.error("[GoogleWorkspaceSettingsManager] Failed to load settings:", error);
    }

    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: GoogleWorkspaceSettingsData): void {
    try {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new Error("SecureSettingsRepository not initialized");
      }
      const repository = SecureSettingsRepository.getInstance();
      repository.save("google-drive", settings);
      this.cachedSettings = settings;
      console.log("[GoogleWorkspaceSettingsManager] Settings saved");
    } catch (error) {
      console.error("[GoogleWorkspaceSettingsManager] Failed to save settings:", error);
    }
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
