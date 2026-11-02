/**
 * Watchdog settings: stored encrypted with the other app settings ("watchdog" category) so the
 * desktop app and the headless daemon read the same values. Off by default.
 */
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import {
  DEFAULT_WATCHDOG_SETTINGS,
  WATCHDOG_SETTINGS_LIMITS,
  type WatchdogSettings,
} from "../../../shared/types";
import { createLogger } from "../../utils/logger";
import { z } from "zod";

const logger = createLogger("Watchdog");

const limits = WATCHDOG_SETTINGS_LIMITS;

/** A settings change arriving over IPC from the renderer: only known fields, within limits. */
export const WatchdogSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z
      .number()
      .int()
      .min(limits.intervalMinutes.min)
      .max(limits.intervalMinutes.max)
      .optional(),
    stallMinutes: z
      .number()
      .int()
      .min(limits.stallMinutes.min)
      .max(limits.stallMinutes.max)
      .optional(),
    progressCheckAfterMinutes: z
      .number()
      .int()
      .min(limits.progressCheckAfterMinutes.min)
      .max(limits.progressCheckAfterMinutes.max)
      .optional(),
    allowCancel: z.boolean().optional(),
  })
  .strict();

/** The headless daemon has no settings UI: `COWORK_WATCHDOG=1` turns the watchdog on there. */
export const WATCHDOG_ENV_FLAG = "COWORK_WATCHDOG";

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Coerce stored or renderer-supplied values into a valid settings object. */
export function normalizeWatchdogSettings(input: unknown): WatchdogSettings {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  return {
    enabled: raw.enabled === true,
    intervalMinutes: clampInteger(
      raw.intervalMinutes,
      DEFAULT_WATCHDOG_SETTINGS.intervalMinutes,
      limits.intervalMinutes.min,
      limits.intervalMinutes.max,
    ),
    stallMinutes: clampInteger(
      raw.stallMinutes,
      DEFAULT_WATCHDOG_SETTINGS.stallMinutes,
      limits.stallMinutes.min,
      limits.stallMinutes.max,
    ),
    progressCheckAfterMinutes: clampInteger(
      raw.progressCheckAfterMinutes,
      DEFAULT_WATCHDOG_SETTINGS.progressCheckAfterMinutes,
      limits.progressCheckAfterMinutes.min,
      limits.progressCheckAfterMinutes.max,
    ),
    allowCancel: raw.allowCancel === true,
  };
}

/** True when the environment turns the watchdog on regardless of the stored setting. */
export function watchdogForcedOnByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WATCHDOG_ENV_FLAG];
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export class WatchdogSettingsManager {
  private static cached: WatchdogSettings | null = null;

  static loadSettings(): WatchdogSettings {
    if (this.cached) return { ...this.cached };
    let settings: WatchdogSettings = { ...DEFAULT_WATCHDOG_SETTINGS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        const stored =
          SecureSettingsRepository.getInstance().load<Partial<WatchdogSettings>>("watchdog");
        if (stored) {
          settings = normalizeWatchdogSettings({ ...DEFAULT_WATCHDOG_SETTINGS, ...stored });
        }
      }
    } catch (error) {
      logger.warn("Could not load watchdog settings; using defaults:", error);
    }
    this.cached = settings;
    return { ...settings };
  }

  /** The settings the running watchdog uses: the stored ones, switched on by the env flag. */
  static loadEffectiveSettings(env: NodeJS.ProcessEnv = process.env): WatchdogSettings {
    const settings = this.loadSettings();
    return watchdogForcedOnByEnv(env) ? { ...settings, enabled: true } : settings;
  }

  static saveSettings(input: Partial<WatchdogSettings>): WatchdogSettings {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Watchdog settings cannot be saved before secure settings are initialized.");
    }
    const next = normalizeWatchdogSettings({ ...this.loadSettings(), ...input });
    if (!SecureSettingsRepository.getInstance().save("watchdog", next)) {
      throw new Error("Watchdog settings were not saved because secure storage refused the write.");
    }
    this.cached = next;
    return { ...next };
  }

  static clearCache(): void {
    this.cached = null;
  }
}
