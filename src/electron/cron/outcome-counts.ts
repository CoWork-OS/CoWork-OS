import { randomUUID } from "node:crypto";
import {
  CRON_OUTCOME_COUNTS_VERSION,
  emptyCronOutcomeCountMap,
  isCronOutcomeCategory,
  type CronOutcomeCounts,
} from "../../shared/cron-outcomes";
import type { CronJobState, CronRunHistoryEntry } from "./types";

const RECORDED_RUN_KEYS_LIMIT = 200;

/**
 * Stable identity of one scheduled run. It is minted when the run starts and persisted
 * with the run lease (`runningRunKey` beside `runningAtMs`), so reconciling the same run
 * after a restart reuses it. Leases and history entries from older builds carry only
 * the start time, which is used as their key.
 */
export function newCronRunKey(runAtMs: number): string {
  return `run:${Math.trunc(runAtMs)}:${randomUUID().slice(0, 8)}`;
}

export function cronRunKey(runAtMs: number): string {
  return `run:${Math.trunc(runAtMs)}`;
}

export function historyEntryRunKey(entry: CronRunHistoryEntry): string {
  return entry.runKey || cronRunKey(entry.runAtMs);
}

function freshCounts(): CronOutcomeCounts {
  return {
    version: CRON_OUTCOME_COUNTS_VERSION,
    counts: emptyCronOutcomeCountMap(),
    coveredTotalRuns: 0,
    recordedRunKeys: [],
  };
}

function classifyInto(counts: CronOutcomeCounts, entry: CronRunHistoryEntry): void {
  if (isCronOutcomeCategory(entry.status)) counts.counts[entry.status] += 1;
  else counts.counts.legacyUnknown += 1;
  counts.recordedRunKeys.push(historyEntryRunKey(entry));
}

/**
 * Bring `state.outcomeCounts` up to date with the legacy counters. Idempotent.
 *
 * - First migration classifies each retained history entry once; earlier runs that
 *   history no longer holds become `legacyUnknown`. The old cumulative
 *   `successfulRuns` is never split into guessed full/partial successes.
 * - If an older build later incremented `totalRuns` without these counts, only the
 *   new retained entries are classified; any unrecoverable gap becomes unknown.
 */
export function reconcileCronOutcomeCounts(state: CronJobState): CronOutcomeCounts {
  const history = state.runHistory ?? [];
  const totalRuns = Math.max(0, Math.trunc(state.totalRuns ?? 0));
  const existing = state.outcomeCounts;

  if (!existing || existing.version !== CRON_OUTCOME_COUNTS_VERSION) {
    const counts = freshCounts();
    for (const entry of history) classifyInto(counts, entry);
    counts.counts.legacyUnknown += Math.max(0, totalRuns - history.length);
    counts.coveredTotalRuns = Math.max(totalRuns, history.length);
    if (history.length > totalRuns) {
      counts.limitation = `Retained history holds ${history.length} runs but the recorded total was ${totalRuns}.`;
    }
    counts.recordedRunKeys = counts.recordedRunKeys.slice(0, RECORDED_RUN_KEYS_LIMIT);
    state.outcomeCounts = counts;
    return counts;
  }

  existing.recordedRunKeys = Array.isArray(existing.recordedRunKeys)
    ? existing.recordedRunKeys
    : [];
  existing.counts = { ...emptyCronOutcomeCountMap(), ...existing.counts };

  if (totalRuns > existing.coveredTotalRuns) {
    let gap = totalRuns - existing.coveredTotalRuns;
    const known = new Set(existing.recordedRunKeys);
    const discovered: string[] = [];
    for (const entry of history) {
      if (gap === 0) break;
      const key = historyEntryRunKey(entry);
      if (known.has(key)) continue;
      if (isCronOutcomeCategory(entry.status)) existing.counts[entry.status] += 1;
      else existing.counts.legacyUnknown += 1;
      discovered.push(key);
      known.add(key);
      gap -= 1;
    }
    existing.counts.legacyUnknown += gap;
    existing.recordedRunKeys = [...discovered, ...existing.recordedRunKeys].slice(
      0,
      RECORDED_RUN_KEYS_LIMIT,
    );
    existing.coveredTotalRuns = totalRuns;
  } else if (totalRuns < existing.coveredTotalRuns) {
    if (totalRuns === 0 && history.length === 0) {
      // An older build cleared the history; clearing resets both representations.
      const reset = freshCounts();
      state.outcomeCounts = reset;
      return reset;
    }
    existing.limitation = `The recorded run total dropped from ${existing.coveredTotalRuns} to ${totalRuns}; counts may include runs no longer in the total.`;
    existing.coveredTotalRuns = totalRuns;
  }
  return existing;
}

/**
 * Record one completed run: history, legacy counters and versioned counts together.
 * Returns false, changing nothing, when this run key was already recorded.
 */
export function recordCronRunCompletion(
  state: CronJobState,
  entry: CronRunHistoryEntry & { runKey: string },
  maxHistoryEntries: number,
): boolean {
  const counts = reconcileCronOutcomeCounts(state);
  const history = state.runHistory ?? [];
  if (
    counts.recordedRunKeys.includes(entry.runKey) ||
    history.some((existing) => historyEntryRunKey(existing) === entry.runKey)
  ) {
    return false;
  }

  if (isCronOutcomeCategory(entry.status)) counts.counts[entry.status] += 1;
  else counts.counts.legacyUnknown += 1;

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
  counts.recordedRunKeys = [entry.runKey, ...counts.recordedRunKeys].slice(
    0,
    RECORDED_RUN_KEYS_LIMIT,
  );

  history.unshift(entry);
  state.runHistory =
    history.length > maxHistoryEntries ? history.slice(0, maxHistoryEntries) : history;
  return true;
}

export function resetCronOutcomeCounts(state: CronJobState): void {
  state.runHistory = [];
  state.totalRuns = 0;
  state.successfulRuns = 0;
  state.failedRuns = 0;
  state.outcomeCounts = freshCounts();
}
