import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type { ChronicleSettings } from "./types";

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
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSettings(input: Partial<ChronicleSettings> | null | undefined): ChronicleSettings {
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
      ...(input || {}),
    });
    if (SecureSettingsRepository.isInitialized()) {
      SecureSettingsRepository.getInstance().save("chronicle", next);
    }
    return next;
  }
}
