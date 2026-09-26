import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { getUserDataDir } from "../utils/user-data-dir";

// The Scrapling StealthFetcher was removed: CoWork does not ship anti-bot or
// Cloudflare-bypass tooling. Legacy "stealth" values fall back to Playwright.
export const SCRAPING_FETCHERS = ["default", "playwright"] as const;
export type ScrapingFetcher = (typeof SCRAPING_FETCHERS)[number];

export function normalizeScrapingFetcher(value: unknown): ScrapingFetcher {
  if (value === "stealth") return "playwright";
  return SCRAPING_FETCHERS.includes(value as ScrapingFetcher)
    ? (value as ScrapingFetcher)
    : "default";
}

export interface ScrapingSettings {
  enabled: boolean;
  defaultFetcher: ScrapingFetcher;
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
const scrapingLogger = createLogger("ScrapingSettings");
const SAFE_PYTHON_COMMANDS = new Set(["python3", "python", "py"]);
const SAFE_PYTHON_BASENAME = /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$|^py(?:\.exe)?$/i;

export function resolveSafePythonPath(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return DEFAULT_SCRAPING_SETTINGS.pythonPath;
  }

  if (SAFE_PYTHON_COMMANDS.has(trimmed)) {
    return trimmed;
  }

  if (!path.isAbsolute(trimmed)) {
    scrapingLogger.warn("Ignoring unsafe non-absolute Python path override.", {
      attemptedPath: trimmed,
    });
    return DEFAULT_SCRAPING_SETTINGS.pythonPath;
  }

  const basename = path.basename(trimmed);
  if (!SAFE_PYTHON_BASENAME.test(basename)) {
    scrapingLogger.warn("Ignoring non-Python executable path in scraping settings.", {
      attemptedPath: trimmed,
    });
    return DEFAULT_SCRAPING_SETTINGS.pythonPath;
  }

  return trimmed;
}

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
          defaultFetcher: normalizeScrapingFetcher(stored.defaultFetcher),
          pythonPath: resolveSafePythonPath(stored.pythonPath),
        } as ScrapingSettings;
        return { ...this.cachedSettings };
      }
    } catch (error) {
      scrapingLogger.warn("Failed to load settings:", error);
    }

    this.cachedSettings = { ...DEFAULT_SCRAPING_SETTINGS };
    return { ...this.cachedSettings };
  }

  static saveSettings(settings: ScrapingSettings): void {
    try {
      const filePath = path.join(getUserDataDir(), SETTINGS_FILE);
      const normalized = {
        ...settings,
        defaultFetcher: normalizeScrapingFetcher(settings.defaultFetcher),
        pythonPath: resolveSafePythonPath(settings.pythonPath),
      };
      fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf-8");
      this.cachedSettings = { ...normalized };
    } catch (error) {
      scrapingLogger.error("Failed to save settings:", error);
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
