/**
 * Shared classification of LLM provider failures.
 *
 * Adapters surface failures in different shapes: the Anthropic and OpenAI SDKs
 * throw `APIError` subclasses carrying `status`, `headers` and the parsed error
 * body; the AWS SDK throws named exceptions with `$metadata.httpStatusCode`;
 * fetch-based adapters throw plain errors with `status`; and network failures
 * arrive as SDK connection errors whose errno sits several `cause` levels deep.
 * The in-call retry loop, the task-level transient-recovery predicate and the
 * adapters' structured errors must agree on what is worth repeating, so the
 * decision is made here once.
 */

export type ProviderErrorReason =
  | "cancelled"
  | "explicit_retryable"
  | "explicit_non_retryable"
  | "quota_exhausted"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "connection"
  | "authentication"
  | "context_overflow"
  | "invalid_request"
  | "unknown";

export interface ProviderErrorClassification {
  /** Repeating the same request after a delay may succeed. */
  retryable: boolean;
  /**
   * A different configured provider/model may succeed even though repeating
   * the request here will not (an exhausted account quota, for example).
   */
  failoverEligible: boolean;
  reason: ProviderErrorReason;
  /** HTTP status found on the error or its cause chain. */
  status?: number;
  /** errno / SDK code found on the error or its cause chain. */
  code?: string;
  /** Delay the provider asked for via `retry-after-ms` / `retry-after`. */
  retryAfterMs?: number;
}

export interface ClassifyProviderErrorOptions {
  /**
   * Treat an explicit `retryable: false` as final. Code that stamps an error
   * after its own bounded retries relies on this. The in-call retry loop leaves
   * it off because adapters have historically defaulted the flag to `false` for
   * failures they did not recognise.
   */
  respectExplicitNonRetryable?: boolean;
  /**
   * Pre provider-retry-v2 semantics: ignore an explicit `retryable: true` and
   * stream-interruption messages ("terminated", "socket hang up", ...).
   */
  legacyRetrySemantics?: boolean;
}

/** Upper bound for a provider-requested retry delay honoured inside one call. */
export const MAX_PROVIDER_RETRY_AFTER_MS = 60_000;

const MAX_CAUSE_DEPTH = 5;

const TRANSIENT_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

// undici failures that are argument/abort errors rather than transport faults.
const NON_TRANSIENT_UNDICI_CODES = new Set([
  "UND_ERR_ABORTED",
  "UND_ERR_INVALID_ARG",
  "UND_ERR_INVALID_RETURN_VALUE",
  "UND_ERR_NOT_SUPPORTED",
]);

const QUOTA_IDENTIFIERS = new Set([
  "insufficient_quota",
  "billing_error",
  "billing_hard_limit_reached",
  "billing_not_active",
  "payment_required",
]);

const RATE_LIMIT_IDENTIFIERS = new Set([
  "rate_limit_error",
  "rate_limit_exceeded",
  "ratelimiterror",
  "throttlingexception",
  "toomanyrequestsexception",
]);

const OVERLOADED_IDENTIFIERS = new Set([
  "overloaded_error",
  "server_is_overloaded",
  "service_unavailable_error",
  "serviceunavailableexception",
  "modelnotreadyexception",
]);

const SERVER_ERROR_IDENTIFIERS = new Set(["api_error", "server_error", "internalserverexception"]);

const TIMEOUT_IDENTIFIERS = new Set([
  "timeout_error",
  "modeltimeoutexception",
  "apiconnectiontimeouterror",
]);

const CONNECTION_IDENTIFIERS = new Set(["apiconnectionerror"]);

const RATE_LIMIT_TEXT =
  /(?:^|[^0-9])429(?:[^0-9]|$)|rate[ _]limit|too many requests|free-models-per-min/;

const CONTEXT_OVERFLOW_TEXT =
  /context length|context window|context_length_exceeded|maximum context|max context|input too long|prompt too long|prompt is too long|token limit exceeded|request too large|maximum number of input tokens|reduce the length of the messages/;

function asRecord(value: unknown): Record<string, Any> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, Any>) : null;
}

function collectCauseChain(error: unknown): Array<Record<string, Any>> {
  const chain: Array<Record<string, Any>> = [];
  let current: unknown = error;
  while (chain.length <= MAX_CAUSE_DEPTH) {
    const record = asRecord(current);
    if (!record || chain.includes(record)) break;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

function readStatus(entry: Record<string, Any>): number | undefined {
  const candidates = [
    entry.status,
    entry.statusCode,
    entry.$metadata?.httpStatusCode,
    entry.response?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100) {
      return candidate;
    }
  }
  return undefined;
}

function constructorNames(entry: Record<string, Any>): string[] {
  const names: string[] = [];
  let proto = Object.getPrototypeOf(entry);
  while (proto && proto !== Error.prototype && proto !== Object.prototype) {
    const name = proto.constructor?.name;
    if (typeof name === "string" && name) names.push(name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

function collectIdentifiers(chain: Array<Record<string, Any>>): Set<string> {
  const identifiers = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) identifiers.add(value.trim().toLowerCase());
  };
  for (const entry of chain) {
    add(entry.name);
    add(entry.code);
    add(entry.type);
    add(entry.providerCode);
    add(entry.error?.type);
    add(entry.error?.code);
    add(entry.error?.error?.type);
    add(entry.error?.error?.code);
    add(entry.errorData?.error?.type);
    add(entry.errorData?.error?.code);
    for (const name of constructorNames(entry)) add(name);
  }
  return identifiers;
}

function findTransientErrno(chain: Array<Record<string, Any>>): string | undefined {
  for (const entry of chain) {
    const code = typeof entry.code === "string" ? entry.code.trim().toUpperCase() : "";
    if (!code) continue;
    if (TRANSIENT_ERRNO_CODES.has(code)) return code;
    if (code.startsWith("UND_ERR_") && !NON_TRANSIENT_UNDICI_CODES.has(code)) return code;
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  const record = asRecord(headers);
  if (!record) return undefined;
  const raw =
    typeof record.get === "function"
      ? record.get(name)
      : (record[name] ?? record[name.toLowerCase()]);
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  return text ? text : undefined;
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  const retryAfterMs = readHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const value = Number(retryAfterMs);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const retryAfter = readHeader(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function hasAny(identifiers: Set<string>, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (identifiers.has(candidate)) return true;
  }
  return false;
}

function isQuotaExhausted(
  status: number | undefined,
  identifiers: Set<string>,
  text: string,
): boolean {
  if (status === 402 || hasAny(identifiers, QUOTA_IDENTIFIERS)) return true;
  if (
    /exceeded your current quota|insufficient[_ ]quota|credit balance is too low|insufficient credits/.test(
      text,
    )
  ) {
    return true;
  }
  // Without a rate-limit signal, generic quota/billing wording is an account
  // limit rather than a per-minute throttle (for example Gemini daily quotas).
  const rateLimited =
    status === 429 || hasAny(identifiers, RATE_LIMIT_IDENTIFIERS) || RATE_LIMIT_TEXT.test(text);
  return (
    !rateLimited &&
    /quota.*exceeded|exceeds?.*usage.*limit|resource.*exhausted|billing|payment.*required|upgrade your plan/.test(
      text,
    )
  );
}

function structuredTransientReason(
  status: number | undefined,
  identifiers: Set<string>,
  errno: string | undefined,
): ProviderErrorReason | null {
  if (status === 529 || hasAny(identifiers, OVERLOADED_IDENTIFIERS)) return "overloaded";
  if (status === 429 || hasAny(identifiers, RATE_LIMIT_IDENTIFIERS)) return "rate_limited";
  if (hasAny(identifiers, TIMEOUT_IDENTIFIERS)) return "timeout";
  if (hasAny(identifiers, SERVER_ERROR_IDENTIFIERS)) return "server_error";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503) return "overloaded";
  if (status === 409) return "server_error";
  if (status !== undefined && status >= 500 && status !== 501 && status !== 505) {
    return "server_error";
  }
  if (hasAny(identifiers, CONNECTION_IDENTIFIERS)) return "connection";
  if (errno) return /TIMEOUT|TIMEDOUT/.test(errno) ? "timeout" : "connection";
  return null;
}

function messageTransientReason(text: string, legacy: boolean): ProviderErrorReason | null {
  if (RATE_LIMIT_TEXT.test(text)) return "rate_limited";
  if (
    /overloaded|service_unavailable_error|service unavailable|temporarily unavailable/.test(text)
  ) {
    return "overloaded";
  }
  if (/timeout|timed out/.test(text)) return "timeout";
  if (
    /fetch failed|failed to fetch|network|connection error\.|econnreset|etimedout|enotfound|eai_again|econnrefused/.test(
      text,
    )
  ) {
    return "connection";
  }
  if (
    !legacy &&
    /terminated|stream disconnected|connection reset|unexpected eof|socket hang up/.test(text)
  ) {
    return "connection";
  }
  return null;
}

/**
 * Decide whether a provider failure is worth repeating, and why.
 *
 * Order matters: an exhausted quota is final even when it arrives as HTTP 429;
 * an adapter's explicit `retryable: true` (used to request failover) beats the
 * status; deterministic 4xx statuses beat message heuristics; and message
 * heuristics only apply when no structured signal exists.
 */
export function classifyProviderError(
  error: unknown,
  options: ClassifyProviderErrorOptions = {},
): ProviderErrorClassification {
  const chain = collectCauseChain(error);
  const top = chain[0] ?? {};
  const status = chain.map(readStatus).find((value) => value !== undefined);
  const identifiers = collectIdentifiers(chain);
  const errno = findTransientErrno(chain);
  const rawCode = typeof top.code === "string" && top.code.trim() ? top.code.trim() : undefined;
  const text = (
    typeof error === "string"
      ? error
      : chain.map((entry) => String(entry.message ?? "")).join(" | ")
  ).toLowerCase();
  const retryAfterMs = chain
    .map((entry) => parseRetryAfterMs(entry.headers ?? entry.response?.headers))
    .find((value) => value !== undefined);

  const classify = (
    retryable: boolean,
    reason: ProviderErrorReason,
    failoverEligible = retryable,
  ): ProviderErrorClassification => ({
    retryable,
    failoverEligible,
    reason,
    ...(status !== undefined ? { status } : {}),
    ...((errno ?? rawCode) ? { code: errno ?? rawCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  if (top.name === "AbortError" || text.trim() === "request cancelled") {
    return classify(false, "cancelled");
  }
  if (isQuotaExhausted(status, identifiers, text)) {
    return classify(false, "quota_exhausted", true);
  }
  if (top.retryable === true && !options.legacyRetrySemantics) {
    return classify(true, "explicit_retryable");
  }
  if (top.retryable === false && options.respectExplicitNonRetryable) {
    return classify(false, "explicit_non_retryable");
  }
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429
  ) {
    if (status === 401 || status === 403) return classify(false, "authentication");
    return classify(
      false,
      CONTEXT_OVERFLOW_TEXT.test(text) ? "context_overflow" : "invalid_request",
    );
  }
  const structuredReason = structuredTransientReason(status, identifiers, errno);
  if (structuredReason) return classify(true, structuredReason);
  const messageReason = messageTransientReason(text, options.legacyRetrySemantics === true);
  if (messageReason) return classify(true, messageReason);
  return classify(false, "unknown");
}

/**
 * Delay before the next attempt: the exponential backoff, or the provider's
 * requested delay (capped, plus a little jitter) when that is longer.
 */
export function resolveProviderRetryDelayMs(backoffMs: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return backoffMs;
  }
  const requested = Math.min(MAX_PROVIDER_RETRY_AFTER_MS, retryAfterMs);
  const jitter = Math.round(Math.random() * Math.min(1_000, requested * 0.1));
  return Math.max(backoffMs, requested + jitter);
}
