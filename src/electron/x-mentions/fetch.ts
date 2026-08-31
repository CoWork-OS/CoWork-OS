import { XSettingsData } from "../../shared/types";
import { runBirdCommand } from "../utils/x-cli";

const DEFAULT_MENTION_TIMEOUT_MS = 45_000;
const RETRY_MENTION_TIMEOUT_MS = 90_000;
const RETRY_FETCH_COUNT_MAX = 10;
const X_MENTION_TIMEOUT_ERROR_RE = /timeout|timed out|ETIMEDOUT/i;
const X_MENTION_UNSUPPORTED_JSON_ERROR_RE = /requires JSON support|unknown option.*--json/i;
const X_MENTION_AUTH_ERROR_RE =
  /missing auth_token|missing .*ct0|not logged in|login required|permission denied|access denied|authentication failed|auth(?:entication)? (?:failed|required|expired|invalid)|cookie (?:missing|expired|invalid|not found)|profile (?:missing|not found|unavailable)/i;
const X_MENTION_CLI_ERROR_RE =
  /Command failed: bird|spawn (EBADF|EACCES|ENOENT)|bird CLI not found/i;

export type XMentionFailureCode = "timeout" | "unsupported_json" | "auth" | "cli" | "unknown";

export interface XMentionFailure {
  code: XMentionFailureCode;
  message: string;
}

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
  return X_MENTION_TIMEOUT_ERROR_RE.test(error.message);
}

export function classifyXMentionFailure(error: unknown): XMentionFailure {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  // Auth check must precede timeout: bird error messages include the command string
  // (e.g. "bird --timeout 20000 --cookie-timeout 20000 ...") which would otherwise
  // match the timeout regex even when the real cause is missing credentials.
  if (X_MENTION_AUTH_ERROR_RE.test(message)) {
    return { code: "auth", message };
  }
  if (X_MENTION_TIMEOUT_ERROR_RE.test(message)) {
    return { code: "timeout", message };
  }
  if (X_MENTION_UNSUPPORTED_JSON_ERROR_RE.test(message)) {
    return { code: "unsupported_json", message };
  }
  if (X_MENTION_CLI_ERROR_RE.test(message)) {
    return { code: "cli", message };
  }
  return { code: "unknown", message };
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
    try {
      const retryResult = await runBirdCommand(
        settings,
        ["mentions", "-n", String(retryFetchCount)],
        {
          json: true,
          timeoutMs: retryTimeoutMs,
        },
      );
      return retryResult;
    } catch (retryError) {
      throw retryError;
    }
  }
}
