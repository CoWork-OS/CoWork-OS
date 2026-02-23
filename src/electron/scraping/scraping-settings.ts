import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../utils/user-data-dir";

export interface ScrapingSettings {
  enabled: boolean;
  defaultFetcher: "default" | "stealth" | "playwright";
  headless: boolean;
  timeout: number;
  maxContentLength: number;
  proxy: {
    enabled: boolean;
    url: string;
  };
  rateLimiting: {
    enabled: boolean;
    requestsPerMinute: number;
  };
  pythonPath: string;
}

export const DEFAULT_SCRAPING_SETTINGS: ScrapingSettings = {
  enabled: false,
  defaultFetcher: "default",
  headless: true,
  timeout: 30000,
  maxContentLength: 100000,
  proxy: {
    enabled: false,
    url: "",
  },
  rateLimiting: {
    enabled: true,
    requestsPerMinute: 30,
  },
  pythonPath: "python3",
};

const SETTINGS_FILE = "scraping-settings.json";

export class ScrapingSettingsManager {
  private static cachedSettings: ScrapingSettings | null = null;

  static loadSettings(): ScrapingSettings {
    if (this.cachedSettings) return { ...this.cachedSettings };

    try {
      const filePath = path.join(getUserDataDir(), SETTINGS_FILE);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        const stored = JSON.parse(raw);
        this.cachedSettings = {
          ...DEFAULT_SCRAPING_SETTINGS,
          ...stored,
          proxy: { ...DEFAULT_SCRAPING_SETTINGS.proxy, ...stored.proxy },
          rateLimiting: {
            ...DEFAULT_SCRAPING_SETTINGS.rateLimiting,
            ...stored.rateLimiting,
          },
        } as ScrapingSettings;
        return { ...this.cachedSettings };
      }
    } catch (error) {
      console.warn("[ScrapingSettings] Failed to load settings:", error);
    }

    this.cachedSettings = { ...DEFAULT_SCRAPING_SETTINGS };
    return { ...this.cachedSettings };
  }

  static saveSettings(settings: ScrapingSettings): void {
    try {
      const filePath = path.join(getUserDataDir(), SETTINGS_FILE);
      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
      this.cachedSettings = { ...settings };
    } catch (error) {
      console.error("[ScrapingSettings] Failed to save settings:", error);
      throw error;
    }
  }

  static resetSettings(): void {
    this.cachedSettings = null;
    try {
      const filePath = path.join(getUserDataDir(), SETTINGS_FILE);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  static isEnabled(): boolean {
    return this.loadSettings().enabled;
  }
}
