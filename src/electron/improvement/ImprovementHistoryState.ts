import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const IMPROVEMENT_HISTORY_STATE_CATEGORY = "improvement-history" as const;

interface ImprovementHistoryState {
  resetAt?: number;
}

export function getImprovementResetBaselineAt(): number | undefined {
  if (!SecureSettingsRepository.isInitialized()) return undefined;
  try {
    const repository = SecureSettingsRepository.getInstance();
    const state = repository.load<ImprovementHistoryState>(IMPROVEMENT_HISTORY_STATE_CATEGORY);
    return typeof state?.resetAt === "number" && Number.isFinite(state.resetAt)
      ? state.resetAt
      : undefined;
  } catch (error) {
    console.error("[ImprovementHistoryState] Failed to load reset baseline:", error);
    return undefined;
  }
}

export function saveImprovementResetBaselineAt(resetAt: number): void {
  if (!SecureSettingsRepository.isInitialized()) return;
  try {
    const repository = SecureSettingsRepository.getInstance();
    repository.save(IMPROVEMENT_HISTORY_STATE_CATEGORY, { resetAt });
  } catch (error) {
    console.error("[ImprovementHistoryState] Failed to save reset baseline:", error);
  }
}
