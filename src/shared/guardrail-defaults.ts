/**
 * Default guardrail settings.
 *
 * Single source of truth for guardrail defaults: GuardrailManager falls back to
 * these values, the GuardrailSettingsSchema derives its `.default()` values from
 * them (so a partial save stores these, not a stale copy), and the settings UI
 * reads its fallbacks and hints from them.
 *
 * Lives in shared/ (no Node or Electron imports) so the validation schema and the
 * renderer can use it without pulling in the encrypted settings store.
 */

import type { GuardrailSettings } from "./types";

export const DEFAULT_GUARDRAIL_SETTINGS: Readonly<GuardrailSettings> = Object.freeze({
  // Token Budget — counted per user turn: a follow-up message starts a new count,
  // continuation windows inside one turn keep accumulating. Raised from 100,000
  // (counted over the whole task): local providers report no cache reads, so every
  // call re-counts the full prompt and hit 100,000 within 3-6 calls, and long chat
  // threads died once their lifetime total crossed it. The cumulative cost cap
  // below remains the lifetime spend guard.
  maxTokensPerTask: 2_000_000,
  tokenBudgetEnabled: true,

  // Cost Budget — on by default so a runaway task cannot silently spend without bound.
  // $10 leaves room for long tasks on frontier models (Opus-class tasks regularly
  // exceed $1). Subscription routes are exempt from this default cap because their
  // cost is an API-equivalent estimate, not a bill; an explicit per-task budgetCost
  // is always enforced. Users who saved guardrail settings before keep their choice.
  maxCostPerTask: 10.0,
  costBudgetEnabled: true,

  // Dangerous Commands
  blockDangerousCommands: true,
  customBlockedPatterns: [],

  // Auto-Approve Trusted Commands
  autoApproveTrustedCommands: false,
  trustedCommandPatterns: [],

  // File Size
  maxFileSizeMB: 50,
  fileSizeLimitEnabled: true,

  // Network Domains
  enforceAllowedDomains: false,
  allowedDomains: [],

  // Web search policy
  webSearchMode: "cached",
  webSearchMaxUsesPerTask: 8,
  webSearchMaxUsesPerStep: 3,
  webSearchAllowedDomains: [],
  webSearchBlockedDomains: [],

  // Iterations (LLM calls per continuation window) — raised 50 → 100 → 500.
  // Complex multi-repo operations and deep-research tasks routinely exceeded 50
  // without being stuck: each file edit + verify + lint cycle costs ~3 iterations.
  // 500 matches defaultLifetimeTurnCap. Hitting it is a turn-window limit: the task
  // auto-continues within the continuation caps instead of failing.
  maxIterationsPerTask: 500,
  iterationLimitEnabled: true,

  // Execution continuation.
  // autoContinuations: raised 3 → 5; large tasks often need more than 3 segments.
  // minProgressScore: lowered 0.25 → 0.15; read/search ops now contribute to score
  //   (see progress-score-engine.ts), so the bar naturally shifted down.
  // lifetimeTurnCap: raised 320 → 500; aligns with the new maxIterations ceiling
  //   and extended loop guardrail windows (see completion-checks.ts).
  // loopWarning/Critical/CircuitBreaker: raised proportionally so warning/critical
  //   thresholds remain meaningful relative to the larger cap.
  autoContinuationEnabled: true,
  defaultMaxAutoContinuations: 5,
  defaultMinProgressScore: 0.15,
  lifetimeTurnCapEnabled: true,
  defaultLifetimeTurnCap: 500,
  compactOnContinuation: true,
  // Match the Codex-style automatic compaction trigger.  Individual tasks can
  // still opt into a lower threshold through agentConfig.
  compactionThresholdRatio: 0.9,
  loopWarningThreshold: 12,
  loopCriticalThreshold: 20,
  globalNoProgressCircuitBreaker: 30,
  sideChannelDuringExecution: "paused",
  sideChannelMaxCallsPerWindow: 2,

  // Adaptive Style Engine — opt-in, conservative by default
  adaptiveStyleEnabled: false,
  adaptiveStyleMaxDriftPerWeek: 1,

  // Cross-Channel Persona Coherence — opt-in
  channelPersonaEnabled: false,
} satisfies GuardrailSettings);

/** A fresh, mutable copy of the defaults (arrays are not shared with the constant). */
export function getDefaultGuardrailSettings(): GuardrailSettings {
  return {
    ...DEFAULT_GUARDRAIL_SETTINGS,
    customBlockedPatterns: [...DEFAULT_GUARDRAIL_SETTINGS.customBlockedPatterns],
    trustedCommandPatterns: [...DEFAULT_GUARDRAIL_SETTINGS.trustedCommandPatterns],
    allowedDomains: [...DEFAULT_GUARDRAIL_SETTINGS.allowedDomains],
    webSearchAllowedDomains: [...DEFAULT_GUARDRAIL_SETTINGS.webSearchAllowedDomains],
    webSearchBlockedDomains: [...DEFAULT_GUARDRAIL_SETTINGS.webSearchBlockedDomains],
  };
}
