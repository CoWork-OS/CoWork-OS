/**
 * Memory Features Settings Manager
 *
 * Stores global toggles for memory-related features in encrypted settings storage.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { MemoryFeaturesSettings } from "../../shared/types";

const DEFAULT_SETTINGS: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
  checkpointCaptureEnabled: true,
  verbatimRecallEnabled: true,
  wakeUpLayersEnabled: true,
  temporalKnowledgeEnabled: true,
  promptStackV2Enabled: false,
  layeredMemoryEnabled: false,
  transcriptStoreEnabled: false,
  durableContextEnabled: false,
  durableContextMode: "off",
  durableContextThreshold: 0.75,
  durableContextFreshTailCount: 64,
  durableContextLargePayloadThreshold: 25000,
  durableContextSummaryModel: "",
  backgroundConsolidationEnabled: false,
  queryOrchestratorEnabled: false,
  sessionLineageEnabled: false,
  curatedMemoryEnabled: true,
  sessionRecallEnabled: true,
  topicMemoryEnabled: true,
  defaultArchiveInjectionEnabled: false,
  memoryWriteApprovalMode: "off",
  autoPromoteToCuratedMemoryEnabled: false,
  structuredObservationsEnabled: true,
  progressiveRecallToolsEnabled: true,
  memoryInspectorEnabled: true,
};

function isEnabled(value: boolean | undefined): boolean {
  return value === true;
}

function normalizeDurableContextMode(
  value: MemoryFeaturesSettings["durableContextMode"],
): "off" | "experimental" | "on" {
  return value === "experimental" || value === "on" ? value : "off";
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeSettings(settings: MemoryFeaturesSettings): MemoryFeaturesSettings {
  const durableContextMode = normalizeDurableContextMode(settings.durableContextMode);
  const durableContextEnabled =
    isEnabled(settings.durableContextEnabled) || durableContextMode !== "off";
  const effectiveDurableMode =
    durableContextEnabled && durableContextMode === "off" ? "experimental" : durableContextMode;

  return {
    contextPackInjectionEnabled: !!settings.contextPackInjectionEnabled,
    heartbeatMaintenanceEnabled: !!settings.heartbeatMaintenanceEnabled,
    checkpointCaptureEnabled: durableContextEnabled || settings.checkpointCaptureEnabled !== false,
    verbatimRecallEnabled: settings.verbatimRecallEnabled !== false,
    wakeUpLayersEnabled: settings.wakeUpLayersEnabled !== false,
    temporalKnowledgeEnabled: settings.temporalKnowledgeEnabled !== false,
    promptStackV2Enabled: isEnabled(settings.promptStackV2Enabled),
    layeredMemoryEnabled: isEnabled(settings.layeredMemoryEnabled),
    transcriptStoreEnabled: durableContextEnabled || isEnabled(settings.transcriptStoreEnabled),
    durableContextEnabled,
    durableContextMode: effectiveDurableMode,
    durableContextThreshold: Math.min(
      0.95,
      Math.max(0.25, normalizePositiveNumber(settings.durableContextThreshold, 0.75)),
    ),
    durableContextFreshTailCount: Math.floor(
      normalizePositiveNumber(settings.durableContextFreshTailCount, 64),
    ),
    durableContextLargePayloadThreshold: Math.floor(
      normalizePositiveNumber(settings.durableContextLargePayloadThreshold, 25000),
    ),
    durableContextSummaryModel:
      typeof settings.durableContextSummaryModel === "string"
        ? settings.durableContextSummaryModel.trim()
        : "",
    backgroundConsolidationEnabled: isEnabled(settings.backgroundConsolidationEnabled),
    queryOrchestratorEnabled: isEnabled(settings.queryOrchestratorEnabled),
    sessionLineageEnabled: isEnabled(settings.sessionLineageEnabled),
    curatedMemoryEnabled: settings.curatedMemoryEnabled !== false,
    sessionRecallEnabled: settings.sessionRecallEnabled !== false,
    topicMemoryEnabled: settings.topicMemoryEnabled !== false,
    defaultArchiveInjectionEnabled: isEnabled(settings.defaultArchiveInjectionEnabled),
    memoryWriteApprovalMode: normalizeMemoryWriteApprovalMode(settings.memoryWriteApprovalMode),
    autoPromoteToCuratedMemoryEnabled: isEnabled(settings.autoPromoteToCuratedMemoryEnabled),
    structuredObservationsEnabled: settings.structuredObservationsEnabled !== false,
    progressiveRecallToolsEnabled: settings.progressiveRecallToolsEnabled !== false,
    memoryInspectorEnabled: settings.memoryInspectorEnabled !== false,
  };
}

function normalizeMemoryWriteApprovalMode(
  value: MemoryFeaturesSettings["memoryWriteApprovalMode"],
): NonNullable<MemoryFeaturesSettings["memoryWriteApprovalMode"]> {
  switch (value) {
    case "curated_only":
    case "external_only":
    case "background_only":
    case "all":
      return value;
    default:
      return "off";
  }
}

export class MemoryFeaturesManager {
  private static cachedSettings: MemoryFeaturesSettings | null = null;

  static initialize(): void {
    // No migration required currently; kept for parity with other managers.
    console.log("[MemoryFeaturesManager] Initialized");
  }

  static loadSettings(): MemoryFeaturesSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    let settings: MemoryFeaturesSettings = { ...DEFAULT_SETTINGS };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<MemoryFeaturesSettings>("memory");
        if (stored) {
          settings = { ...DEFAULT_SETTINGS, ...stored };
        }
      }
    } catch (error) {
      console.error("[MemoryFeaturesManager] Failed to load settings:", error);
    }

    // Normalize defensively against corrupted stored values.
    settings = normalizeSettings(settings);

    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: MemoryFeaturesSettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }

    const normalized: MemoryFeaturesSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...settings,
    });

    const repository = SecureSettingsRepository.getInstance();
    repository.save("memory", normalized);
    this.cachedSettings = normalized;
    console.log("[MemoryFeaturesManager] Settings saved");
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
