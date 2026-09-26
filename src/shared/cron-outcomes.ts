/**
 * Versioned outcome counts for scheduled tasks.
 *
 * The legacy `successfulRuns` counter adds partial and needs-action runs to the
 * success numerator, so a job that needs attention every time could show 100%.
 * These counts keep every category separate and only `ok` counts as run success.
 */

export const CRON_OUTCOME_COUNTS_VERSION = 1 as const;

export const CRON_OUTCOME_CATEGORIES = [
  "ok",
  "partial_success",
  "needs_user_action",
  "error",
  "timeout",
  "cancelled",
  "skipped",
] as const;

export type CronOutcomeCategory = (typeof CRON_OUTCOME_CATEGORIES)[number];

export type CronOutcomeCountMap = Record<CronOutcomeCategory, number> & {
  /** Runs recorded before classification existed that retained history cannot explain. */
  legacyUnknown: number;
};

export interface CronOutcomeCounts {
  version: typeof CRON_OUTCOME_COUNTS_VERSION;
  counts: CronOutcomeCountMap;
  /**
   * The legacy `totalRuns` value these counts account for. A later legacy writer
   * that increments `totalRuns` without updating these counts is detected by the gap.
   */
  coveredTotalRuns: number;
  /** Recent run keys already counted, so a repeated completion is ignored. */
  recordedRunKeys: string[];
  /** Why the counts cannot fully explain the recorded history, if they cannot. */
  limitation?: string;
}

export function emptyCronOutcomeCountMap(): CronOutcomeCountMap {
  return {
    ok: 0,
    partial_success: 0,
    needs_user_action: 0,
    error: 0,
    timeout: 0,
    cancelled: 0,
    skipped: 0,
    legacyUnknown: 0,
  };
}

export function isCronOutcomeCategory(value: unknown): value is CronOutcomeCategory {
  return (
    typeof value === "string" && (CRON_OUTCOME_CATEGORIES as readonly string[]).includes(value)
  );
}

export interface CronRunSuccessSummary {
  /** Classified attempts: ok + partial + needs action + error + timeout + cancelled. */
  knownAttempts: number;
  ok: number;
  partial: number;
  needsAttention: number;
  failed: number;
  cancelled: number;
  skipped: number;
  unclassified: number;
  /** Rounded percentage of known attempts that fully succeeded; null when there are none. */
  ratePercent: number | null;
}

/**
 * "Run success among classified attempts": `ok / knownAttempts`. Skipped and legacy
 * unclassified runs are excluded and reported separately. This measures completed
 * runs, not whether the user accepted or used the result.
 */
export function summarizeCronRunSuccess(
  counts: CronOutcomeCountMap | undefined | null,
): CronRunSuccessSummary {
  const value = counts ?? emptyCronOutcomeCountMap();
  const failed = value.error + value.timeout;
  const knownAttempts =
    value.ok + value.partial_success + value.needs_user_action + failed + value.cancelled;
  return {
    knownAttempts,
    ok: value.ok,
    partial: value.partial_success,
    needsAttention: value.needs_user_action,
    failed,
    cancelled: value.cancelled,
    skipped: value.skipped,
    unclassified: value.legacyUnknown,
    ratePercent: knownAttempts > 0 ? Math.round((value.ok / knownAttempts) * 100) : null,
  };
}

export function addCronOutcomeCountMaps(
  left: CronOutcomeCountMap,
  right: CronOutcomeCountMap | undefined | null,
): CronOutcomeCountMap {
  if (!right) return left;
  const next = { ...left };
  for (const key of Object.keys(next) as Array<keyof CronOutcomeCountMap>) {
    next[key] += Number(right[key]) || 0;
  }
  return next;
}

export interface CronRunStatusLabel {
  emoji: string;
  /** Sentence used in channel deliveries, e.g. "Task completed successfully." */
  sentence: string;
  /** Short suffix for notifications, e.g. "completed". */
  short: string;
}

/** Human labels for a scheduled run status, shared by notifications and deliveries. */
export function describeCronRunStatus(status: string | undefined): CronRunStatusLabel {
  switch (status) {
    case "ok":
      return { emoji: "✅", sentence: "Task completed successfully.", short: "completed" };
    case "partial_success":
      return {
        emoji: "⚠️",
        sentence: "Task completed with partial results.",
        short: "completed with partial results",
      };
    case "needs_user_action":
      return {
        emoji: "⚠️",
        sentence: "Task completed - action required.",
        short: "completed, action required",
      };
    case "error":
      return { emoji: "❌", sentence: "Task failed.", short: "failed" };
    case "cancelled":
      return { emoji: "⏹️", sentence: "Task was cancelled.", short: "cancelled" };
    case "skipped":
      return { emoji: "⏭️", sentence: "Run was skipped.", short: "skipped" };
    case "timeout":
      return { emoji: "⏱️", sentence: "Task timed out.", short: "timed out" };
    default:
      return { emoji: "❔", sentence: "Run finished with an unknown status.", short: "finished" };
  }
}
