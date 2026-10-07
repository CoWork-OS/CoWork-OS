/**
 * Memory Features Settings Manager
 *
 * Stores global toggles for memory-related features in encrypted settings storage.
 */

import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { MemoryFeaturesSettings, MemoryRepoTeamRepoSetting } from "../../shared/types";

const DEFAULT_SETTINGS: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
  checkpointCaptureEnabled: true,
  wakeUpLayersEnabled: true,
  temporalKnowledgeEnabled: true,
  transcriptStoreEnabled: false,
  durableContextEnabled: false,
  durableContextMode: "off",
  durableContextLargePayloadThreshold: 25000,
  queryOrchestratorEnabled: false,
  curatedMemoryEnabled: true,
  sessionRecallEnabled: true,
  defaultArchiveInjectionEnabled: false,
  memoryWriteApprovalMode: "off",
  autoPromoteToCuratedMemoryEnabled: false,
  structuredObservationsEnabled: true,
  memoryInspectorEnabled: true,
  memoryCompressionDailyTokenBudget: 20000,
  memoryRepoEnabled: true,
  // `memoryRepoDefaultOnApplied` is deliberately absent: a stored blob without it gets the
  // one-time default-on migration in normalizeSettings.
  memoryRepoPath: "",
  memoryRepoDreamingEnabled: true,
  memoryRepoDreamDailyTokenBudget: 50000,
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

// Builds the settings from known keys only, so retired keys still present in a stored blob
// (`verbatimRecallEnabled`, `progressiveRecallToolsEnabled`, `layeredMemoryEnabled`,
// `topicMemoryEnabled`) are dropped on load and save.
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
    wakeUpLayersEnabled: settings.wakeUpLayersEnabled !== false,
    temporalKnowledgeEnabled: settings.temporalKnowledgeEnabled !== false,
    // No longer writes transcript spans (the conversation index is always fed from task
    // events). It now only turns on the query orchestrator's `transcript_context` prompt
    // section and the checkpoint resume label.
    transcriptStoreEnabled: isEnabled(settings.transcriptStoreEnabled),
    // Durable context only controls the compaction-recovery layer: recording the full
    // LLM history and compaction summaries that context_recall can expand.
    durableContextEnabled,
    durableContextMode: effectiveDurableMode,
    durableContextLargePayloadThreshold: Math.floor(
      normalizePositiveNumber(settings.durableContextLargePayloadThreshold, 25000),
    ),
    queryOrchestratorEnabled: isEnabled(settings.queryOrchestratorEnabled),
    curatedMemoryEnabled: settings.curatedMemoryEnabled !== false,
    sessionRecallEnabled: settings.sessionRecallEnabled !== false,
    defaultArchiveInjectionEnabled: isEnabled(settings.defaultArchiveInjectionEnabled),
    memoryWriteApprovalMode: normalizeMemoryWriteApprovalMode(settings.memoryWriteApprovalMode),
    autoPromoteToCuratedMemoryEnabled: isEnabled(settings.autoPromoteToCuratedMemoryEnabled),
    structuredObservationsEnabled: settings.structuredObservationsEnabled !== false,
    memoryInspectorEnabled: settings.memoryInspectorEnabled !== false,
    memoryCompressionDailyTokenBudget: Math.min(
      1_000_000,
      Math.floor(normalizePositiveNumber(settings.memoryCompressionDailyTokenBudget, 20000)),
    ),
    // Phase 3 turned the memory folder on for everyone once; a stored `false` from before
    // was usually the saved default, not a choice. After that, the user's choice holds.
    memoryRepoEnabled:
      settings.memoryRepoDefaultOnApplied === true ? isEnabled(settings.memoryRepoEnabled) : true,
    memoryRepoDefaultOnApplied: true,
    memoryRepoPath:
      typeof settings.memoryRepoPath === "string"
        ? settings.memoryRepoPath.trim().slice(0, 1024)
        : "",
    memoryRepoDreamingEnabled: settings.memoryRepoDreamingEnabled !== false,
    memoryRepoDreamDailyTokenBudget: Math.min(
      1_000_000,
      Math.max(
        1,
        Math.floor(normalizePositiveNumber(settings.memoryRepoDreamDailyTokenBudget, 50000)),
      ),
    ),
    memoryRepoRemoteUrl:
      typeof settings.memoryRepoRemoteUrl === "string"
        ? settings.memoryRepoRemoteUrl.trim().slice(0, 500)
        : "",
    memoryRepoRemoteConfirmedPrivate: isEnabled(settings.memoryRepoRemoteConfirmedPrivate),
    memoryRepoTeamRepos: normalizeTeamRepos(settings.memoryRepoTeamRepos),
  };
}

const MAX_TEAM_REPOS = 3;

function normalizeTeamRepos(value: unknown): MemoryRepoTeamRepoSetting[] {
  if (!Array.isArray(value)) return [];
  const out: MemoryRepoTeamRepoSetting[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 60) : "";
    const repoPath = typeof entry.path === "string" ? entry.path.trim().slice(0, 1024) : "";
    if (!name || !repoPath || names.has(name.toLowerCase())) continue;
    if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) continue;
    names.add(name.toLowerCase());
    const workspaceIds = Array.isArray(entry.workspaceIds)
      ? entry.workspaceIds
          .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)
          .slice(0, 200)
      : [];
    out.push({ name, path: repoPath, ...(workspaceIds.length ? { workspaceIds } : {}) });
    if (out.length >= MAX_TEAM_REPOS) break;
  }
  return out;
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

type MemoryFeaturesListener = (settings: MemoryFeaturesSettings) => void;

export class MemoryFeaturesManager {
  private static cachedSettings: MemoryFeaturesSettings | null = null;
  private static listeners = new Set<MemoryFeaturesListener>();

  /** Called after every save (the memory repo restarts when its settings change). */
  static onSaved(listener: MemoryFeaturesListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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
    for (const listener of this.listeners) {
      try {
        listener(normalized);
      } catch (error) {
        console.error("[MemoryFeaturesManager] Settings listener failed:", error);
      }
    }
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }
}
