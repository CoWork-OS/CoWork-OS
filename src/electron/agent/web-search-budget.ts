/**
 * web_search use caps for a task: the Settings > Guardrails values, scaled by the
 * task's budget profile while the user has left the per-task cap at its default.
 */

import { DEFAULT_GUARDRAIL_SETTINGS } from "../../shared/guardrail-defaults";

export type WebSearchBudgetProfile = "strict" | "balanced" | "aggressive";

const MAX_USES_PER_TASK_LIMIT = 500;
const MAX_USES_PER_STEP_LIMIT = 100;

/**
 * Per-task caps by budget profile. Balanced (the profile ordinary tasks get) is the
 * guardrail default; strict and aggressive keep the earlier half/double ratio.
 */
export const WEB_SEARCH_PROFILE_MAX_USES_PER_TASK: Readonly<
  Record<WebSearchBudgetProfile, number>
> = Object.freeze({
  strict: 12,
  balanced: DEFAULT_GUARDRAIL_SETTINGS.webSearchMaxUsesPerTask,
  aggressive: 50,
});

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  if (normalized < min) return fallback;
  return Math.max(min, Math.min(max, normalized));
}

export function resolveWebSearchUseCaps(input: {
  profile: WebSearchBudgetProfile;
  /** GuardrailSettings.webSearchMaxUsesPerTask as loaded (always present after load). */
  guardrailMaxUsesPerTask: unknown;
  /** GuardrailSettings.webSearchMaxUsesPerStep as loaded. */
  guardrailMaxUsesPerStep: unknown;
  /** task.agentConfig.webSearchMaxUsesPerTask; wins when set. */
  taskMaxUsesPerTask?: unknown;
  /** task.agentConfig.webSearchMaxUsesPerStep; wins when set. */
  taskMaxUsesPerStep?: unknown;
}): { perTask: number; perStep: number } {
  const profileCap =
    WEB_SEARCH_PROFILE_MAX_USES_PER_TASK[input.profile] ??
    WEB_SEARCH_PROFILE_MAX_USES_PER_TASK.balanced;
  // Loaded settings always carry this field, so "unset" cannot be detected. A value
  // equal to the default is treated as uncustomized and lets the profile scale it;
  // any other value is the user's choice and applies to every profile.
  const guardrailTaskCap =
    input.guardrailMaxUsesPerTask === DEFAULT_GUARDRAIL_SETTINGS.webSearchMaxUsesPerTask
      ? profileCap
      : clampInt(input.guardrailMaxUsesPerTask, profileCap, 1, MAX_USES_PER_TASK_LIMIT);
  const guardrailStepCap = clampInt(
    input.guardrailMaxUsesPerStep,
    DEFAULT_GUARDRAIL_SETTINGS.webSearchMaxUsesPerStep,
    1,
    MAX_USES_PER_STEP_LIMIT,
  );
  return {
    perTask: clampInt(input.taskMaxUsesPerTask, guardrailTaskCap, 1, MAX_USES_PER_TASK_LIMIT),
    perStep: clampInt(input.taskMaxUsesPerStep, guardrailStepCap, 1, MAX_USES_PER_STEP_LIMIT),
  };
}
