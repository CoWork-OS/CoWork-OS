import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type { ChronicleExcludedApp, ChronicleSettings } from "./types";

/** Never captured unless the user removes them: apps that show passwords and keys. */
export const DEFAULT_CHRONICLE_EXCLUDED_APPS: ChronicleExcludedApp[] = [
  { bundleId: "com.apple.Passwords", name: "Passwords" },
  { bundleId: "com.apple.keychainaccess", name: "Keychain Access" },
  { bundleId: "com.1password.1password", name: "1Password" },
  { bundleId: "com.agilebits.onepassword7", name: "1Password 7" },
  { bundleId: "com.bitwarden.desktop", name: "Bitwarden" },
  { bundleId: "com.lastpass.LastPass", name: "LastPass" },
  { bundleId: "org.keepassxc.keepassxc", name: "KeePassXC" },
  { bundleId: "com.dashlane.dashlanephonefinal", name: "Dashlane" },
];

const MAX_EXCLUDED_APPS = 200;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function isValidChronicleBundleId(value: unknown): value is string {
  return typeof value === "string" && BUNDLE_ID_PATTERN.test(value);
}

function cleanAppName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (text || fallback).slice(0, 120);
}

/** A valid, de-duplicated list; a missing list means the defaults. */
export function normalizeExcludedApps(value: unknown): ChronicleExcludedApp[] {
  if (!Array.isArray(value)) return DEFAULT_CHRONICLE_EXCLUDED_APPS.map((app) => ({ ...app }));
  const seen = new Set<string>();
  const apps: ChronicleExcludedApp[] = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (!isValidChronicleBundleId(record.bundleId)) continue;
    const key = record.bundleId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({ bundleId: record.bundleId, name: cleanAppName(record.name, record.bundleId) });
    if (apps.length >= MAX_EXCLUDED_APPS) break;
  }
  return apps;
}

/** Whether Chronicle must not capture while this app is in front. */
export function isChronicleExcludedApp(
  settings: Pick<ChronicleSettings, "excludedApps">,
  bundleId: string | undefined | null,
): boolean {
  if (!bundleId) return false;
  const key = bundleId.toLowerCase();
  return (settings.excludedApps ?? []).some((app) => app.bundleId.toLowerCase() === key);
}

const DEFAULT_SETTINGS: ChronicleSettings = {
  enabled: false,
  mode: "hybrid",
  paused: false,
  captureIntervalSeconds: 10,
  retentionMinutes: 5,
  maxFrames: 60,
  captureScope: "frontmost_display",
  backgroundGenerationEnabled: true,
  respectWorkspaceMemory: true,
  consentAcceptedAt: null,
  excludedApps: DEFAULT_CHRONICLE_EXCLUDED_APPS,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSettings(
  input: Partial<ChronicleSettings> | null | undefined,
): ChronicleSettings {
  return {
    enabled: Boolean(input?.enabled),
    mode: input?.mode === "hybrid" ? "hybrid" : "hybrid",
    paused: Boolean(input?.paused),
    captureIntervalSeconds: clampInt(
      input?.captureIntervalSeconds,
      DEFAULT_SETTINGS.captureIntervalSeconds,
      5,
      300,
    ),
    retentionMinutes: clampInt(input?.retentionMinutes, DEFAULT_SETTINGS.retentionMinutes, 1, 60),
    maxFrames: clampInt(input?.maxFrames, DEFAULT_SETTINGS.maxFrames, 6, 240),
    captureScope: input?.captureScope === "all_displays" ? "all_displays" : "frontmost_display",
    backgroundGenerationEnabled:
      input?.backgroundGenerationEnabled ?? DEFAULT_SETTINGS.backgroundGenerationEnabled,
    respectWorkspaceMemory:
      input?.respectWorkspaceMemory ?? DEFAULT_SETTINGS.respectWorkspaceMemory,
    consentAcceptedAt:
      typeof input?.consentAcceptedAt === "number" && Number.isFinite(input.consentAcceptedAt)
        ? Math.max(0, Math.round(input.consentAcceptedAt))
        : null,
    excludedApps: normalizeExcludedApps(input?.excludedApps),
  };
}

export class ChronicleSettingsManager {
  static readonly DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  static loadSettings(): ChronicleSettings {
    if (!SecureSettingsRepository.isInitialized()) {
      return { ...DEFAULT_SETTINGS };
    }
    const repository = SecureSettingsRepository.getInstance();
    const loaded = repository.load<ChronicleSettings>("chronicle");
    return normalizeSettings(loaded);
  }

  static saveSettings(input: Partial<ChronicleSettings>): ChronicleSettings {
    const next = normalizeSettings({
      ...this.loadSettings(),
      ...input,
    });
    if (SecureSettingsRepository.isInitialized()) {
      SecureSettingsRepository.getInstance().save("chronicle", next);
    }
    return next;
  }
}
