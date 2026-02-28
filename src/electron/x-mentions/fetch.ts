import { XSettingsData } from "../../shared/types";
import { runBirdCommand } from "../utils/x-cli";

const DEFAULT_MENTION_TIMEOUT_MS = 45_000;
const RETRY_MENTION_TIMEOUT_MS = 90_000;
const RETRY_FETCH_COUNT_MAX = 10;

function normalizeFetchCount(value: number): number {
  if (!Number.isFinite(value)) return 25;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function resolveMentionsTimeoutMs(settings: XSettingsData): number {
  const configured = Number(settings.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(DEFAULT_MENTION_TIMEOUT_MS, configured);
  }
  return DEFAULT_MENTION_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout/i.test(error.message);
}

export async function fetchMentionsWithRetry(
  settings: XSettingsData,
  fetchCount: number,
): Promise<Awaited<ReturnType<typeof runBirdCommand>>> {
  const primaryFetchCount = normalizeFetchCount(fetchCount);
  const primaryTimeoutMs = resolveMentionsTimeoutMs(settings);

  try {
    return await runBirdCommand(settings, ["mentions", "-n", String(primaryFetchCount)], {
      json: true,
      timeoutMs: primaryTimeoutMs,
    });
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }

    const retryFetchCount = Math.max(1, Math.min(RETRY_FETCH_COUNT_MAX, primaryFetchCount));
    const retryTimeoutMs = Math.max(RETRY_MENTION_TIMEOUT_MS, primaryTimeoutMs);

    if (retryFetchCount === primaryFetchCount && retryTimeoutMs === primaryTimeoutMs) {
      throw error;
    }

    console.warn(
      `[X Mentions] Mention fetch timed out (n=${primaryFetchCount}, timeout=${primaryTimeoutMs}ms). ` +
        `Retrying with n=${retryFetchCount}, timeout=${retryTimeoutMs}ms`,
    );

    return runBirdCommand(settings, ["mentions", "-n", String(retryFetchCount)], {
      json: true,
      timeoutMs: retryTimeoutMs,
    });
  }
}
