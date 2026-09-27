import {
  CRON_OUTCOME_COUNTS_VERSION,
  emptyCronOutcomeCountMap,
  isCronOutcomeCategory,
  type CronOutcomeCountMap,
  type CronOutcomeCounts,
} from "../../shared/cron-outcomes";
import type { CronJobState, CronRunHistoryEntry } from "./types";

function classifyInto(counts: CronOutcomeCountMap, entry: CronRunHistoryEntry): void {
  if (isCronOutcomeCategory(entry.status)) counts[entry.status] += 1;
  else counts.legacyUnknown += 1;
}

/**
 * Bring `state.outcomeCounts` up to date with the legacy counters. Idempotent.
 *
 * - First migration classifies each retained history entry once; earlier runs that
 *   history no longer holds become `legacyUnknown`. The old cumulative
 *   `successfulRuns` is never split into guessed full/partial successes. The same
 *   derivation runs again if an older build cleared the history in the meantime.
 * - If an older build later recorded runs without these counts, those runs are the
 *   newest history entries; any that history no longer holds become unknown.
 */
export function reconcileCronOutcomeCounts(state: CronJobState): CronOutcomeCounts {
  const history = state.runHistory ?? [];
  const totalRuns = state.totalRuns ?? 0;
  const existing = state.outcomeCounts;

  if (
    !existing ||
    existing.version !== CRON_OUTCOME_COUNTS_VERSION ||
    totalRuns < existing.coveredTotalRuns
  ) {
    const counts: CronOutcomeCounts = {
      version: CRON_OUTCOME_COUNTS_VERSION,
      counts: emptyCronOutcomeCountMap(),
      coveredTotalRuns: totalRuns,
    };
    for (const entry of history) classifyInto(counts.counts, entry);
    counts.counts.legacyUnknown += Math.max(0, totalRuns - history.length);
    state.outcomeCounts = counts;
    return counts;
  }

  if (totalRuns > existing.coveredTotalRuns) {
    const gap = totalRuns - existing.coveredTotalRuns;
    const unrecorded = history.slice(0, gap);
    for (const entry of unrecorded) classifyInto(existing.counts, entry);
    existing.counts.legacyUnknown += gap - unrecorded.length;
    existing.coveredTotalRuns = totalRuns;
  }
  return existing;
}

/** Record one completed run: history, legacy counters and versioned counts together. */
export function recordCronRunCompletion(
  state: CronJobState,
  entry: CronRunHistoryEntry,
  maxHistoryEntries: number,
): void {
  const counts = reconcileCronOutcomeCounts(state);
  classifyInto(counts.counts, entry);

  // Legacy aggregate fields keep their legacy semantics for existing callers.
  state.totalRuns = (state.totalRuns ?? 0) + 1;
  if (
    entry.status === "ok" ||
    entry.status === "partial_success" ||
    entry.status === "needs_user_action"
  ) {
    state.successfulRuns = (state.successfulRuns ?? 0) + 1;
  } else {
    state.failedRuns = (state.failedRuns ?? 0) + 1;
  }
  counts.coveredTotalRuns = state.totalRuns;

  const history = state.runHistory ?? [];
  history.unshift(entry);
  state.runHistory =
    history.length > maxHistoryEntries ? history.slice(0, maxHistoryEntries) : history;
}

export function resetCronOutcomeCounts(state: CronJobState): void {
  state.runHistory = [];
  state.totalRuns = 0;
  state.successfulRuns = 0;
  state.failedRuns = 0;
  state.outcomeCounts = {
    version: CRON_OUTCOME_COUNTS_VERSION,
    counts: emptyCronOutcomeCountMap(),
    coveredTotalRuns: 0,
  };
}
