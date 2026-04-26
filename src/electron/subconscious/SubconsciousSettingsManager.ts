import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import {
  DEFAULT_SUBCONSCIOUS_SETTINGS,
  SUBCONSCIOUS_TARGET_KINDS,
  type SubconsciousSettings,
} from "../../shared/subconscious";

export class SubconsciousSettingsManager {
  private static cached: SubconsciousSettings | null = null;

  static loadSettings(): SubconsciousSettings {
    if (this.cached) return this.cached;
    let settings: SubconsciousSettings = { ...DEFAULT_SUBCONSCIOUS_SETTINGS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        const stored = SecureSettingsRepository.getInstance().load<Partial<SubconsciousSettings>>(
          "subconscious-loop",
        );
        if (stored) {
          settings = {
            ...DEFAULT_SUBCONSCIOUS_SETTINGS,
            ...stored,
            durableTargetKinds: stored.durableTargetKinds || DEFAULT_SUBCONSCIOUS_SETTINGS.durableTargetKinds,
            phaseModels: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.phaseModels,
              ...(stored.phaseModels || {}),
            },
            dispatchDefaults: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults,
              ...(stored.dispatchDefaults || {}),
              defaultKinds: {
                ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults.defaultKinds,
                ...(stored.dispatchDefaults?.defaultKinds || {}),
              },
            },
            notificationPolicy: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.notificationPolicy,
              ...(stored.notificationPolicy || {}),
            },
            perExecutorPolicy: {
              ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy,
              ...(stored.perExecutorPolicy || {}),
              codeChangeTask: {
                ...DEFAULT_SUBCONSCIOUS_SETTINGS.perExecutorPolicy.codeChangeTask,
                ...(stored.perExecutorPolicy?.codeChangeTask || {}),
              },
            },
          };
        }
      }
    } catch (error) {
      console.error("[SubconsciousSettingsManager] Failed to load settings:", error);
    }
    this.cached = this.normalize(settings);
    return this.cached;
  }

  static saveSettings(settings: SubconsciousSettings): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const normalized = this.normalize(settings);
    SecureSettingsRepository.getInstance().save("subconscious-loop", normalized);
    this.cached = normalized;
  }

  static clearCache(): void {
    this.cached = null;
  }

  private static normalize(input: SubconsciousSettings): SubconsciousSettings {
    return {
      enabled: !!input.enabled,
      autoRun: input.autoRun !== false,
      cadenceMinutes: Math.min(Math.max(Math.round(input.cadenceMinutes || 24 * 60), 15), 7 * 24 * 60),
      enabledTargetKinds:
        Array.isArray(input.enabledTargetKinds) && input.enabledTargetKinds.length
          ? input.enabledTargetKinds.filter((kind): kind is (typeof SUBCONSCIOUS_TARGET_KINDS)[number] =>
              SUBCONSCIOUS_TARGET_KINDS.includes(kind as (typeof SUBCONSCIOUS_TARGET_KINDS)[number]),
            )
          : [...SUBCONSCIOUS_TARGET_KINDS],
      durableTargetKinds:
        Array.isArray(input.durableTargetKinds)
          ? input.durableTargetKinds.filter((kind): kind is (typeof SUBCONSCIOUS_TARGET_KINDS)[number] =>
              SUBCONSCIOUS_TARGET_KINDS.includes(kind as (typeof SUBCONSCIOUS_TARGET_KINDS)[number]),
            )
          : [...DEFAULT_SUBCONSCIOUS_SETTINGS.durableTargetKinds],
      catchUpOnRestart: input.catchUpOnRestart === true,
      journalingEnabled: input.journalingEnabled !== false,
      dreamsEnabled: input.dreamsEnabled !== false,
      dreamCadenceHours: Math.min(Math.max(Math.round(input.dreamCadenceHours || 24), 1), 24 * 30),
      autonomyMode:
        input.autonomyMode === "recommendation_first" || input.autonomyMode === "strong_autonomy"
          ? input.autonomyMode
          : input.autonomyMode === "balanced_autopilot"
            ? input.autonomyMode
            : "recommendation_first",
      trustedTargetKeys: Array.isArray(input.trustedTargetKeys)
        ? input.trustedTargetKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [],
      phaseModels: {
        collectingEvidence:
          typeof input.phaseModels?.collectingEvidence === "string"
            ? input.phaseModels.collectingEvidence.trim()
            : undefined,
        ideation:
          typeof input.phaseModels?.ideation === "string"
            ? input.phaseModels.ideation.trim()
            : undefined,
        critique:
          typeof input.phaseModels?.critique === "string"
            ? input.phaseModels.critique.trim()
            : undefined,
        synthesis:
          typeof input.phaseModels?.synthesis === "string"
            ? input.phaseModels.synthesis.trim()
            : undefined,
      },
      dispatchDefaults: {
        autoDispatch: input.dispatchDefaults?.autoDispatch === true,
        defaultKinds: {
          ...DEFAULT_SUBCONSCIOUS_SETTINGS.dispatchDefaults.defaultKinds,
          ...(input.dispatchDefaults?.defaultKinds || {}),
        },
      },
      artifactRetentionDays: Math.min(Math.max(Math.round(input.artifactRetentionDays || 30), 1), 365),
      maxHypothesesPerRun: Math.min(Math.max(Math.round(input.maxHypothesesPerRun || 4), 3), 5),
      notificationPolicy: {
        inputNeeded: input.notificationPolicy?.inputNeeded !== false,
        importantActionTaken: input.notificationPolicy?.importantActionTaken !== false,
        completedWhileAway: input.notificationPolicy?.completedWhileAway !== false,
        throttleMinutes: Math.min(Math.max(Math.round(input.notificationPolicy?.throttleMinutes || 30), 0), 24 * 60),
        quietHoursStart: Math.min(Math.max(Math.round(input.notificationPolicy?.quietHoursStart ?? 22), 0), 23),
        quietHoursEnd: Math.min(Math.max(Math.round(input.notificationPolicy?.quietHoursEnd ?? 8), 0), 23),
      },
      perExecutorPolicy: {
        task: { enabled: input.perExecutorPolicy?.task?.enabled !== false },
        suggestion: { enabled: input.perExecutorPolicy?.suggestion?.enabled !== false },
        notify: { enabled: input.perExecutorPolicy?.notify?.enabled !== false },
        codeChangeTask: {
          enabled: input.perExecutorPolicy?.codeChangeTask?.enabled !== false,
          requireWorktree: input.perExecutorPolicy?.codeChangeTask?.requireWorktree !== false,
          strictReview: input.perExecutorPolicy?.codeChangeTask?.strictReview !== false,
          verificationRequired: input.perExecutorPolicy?.codeChangeTask?.verificationRequired !== false,
        },
      },
    };
  }
}
