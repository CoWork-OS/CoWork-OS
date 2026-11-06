/**
 * Machine-readable failure classification for TaskExecutor step failures.
 *
 * The executor used to branch on lowercased English text alone, so localized
 * error text never matched and category ordering hid real causes (a 429 was a
 * "user blocker" before the quota branch could see it; "EACCES" matched
 * /permission/ the same way). Codes are recognized in three tiers:
 *
 * 1. structured fields on the thrown error (HTTP status, errno, code),
 * 2. locale-independent markers that survive translation (errno names, HTTP
 *    status numbers, provider error codes),
 * 3. English text, only as a fallback for untyped errors.
 */

export type StepFailureReason =
  | "approval_denied"
  | "auth_required"
  | "integration_disconnected"
  | "access_profile_denied"
  | "rate_limited"
  | "quota_exhausted"
  | "local_io"
  | "untyped";

/** HTTP statuses that identify a category regardless of the message language. */
const STATUS_REASONS: Record<number, StepFailureReason> = {
  401: "auth_required",
  403: "auth_required",
  429: "rate_limited",
  402: "quota_exhausted",
};

/** err.code / errno values that identify a category regardless of message language. */
const CODE_REASONS: Record<string, StepFailureReason> = {
  EACCES: "local_io",
  EPERM: "local_io",
  ENOENT: "local_io",
  EISDIR: "local_io",
  ENOTDIR: "local_io",
  ENOSPC: "local_io",
  EROFS: "local_io",
  EMFILE: "local_io",
};

function* causeChain(error: unknown): Generator<Record<string, unknown>> {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current !== "object") break;
    const entry = current as Record<string, unknown>;
    yield entry;
    current = entry.cause ?? entry.previous ?? (entry as { error?: unknown }).error;
  }
}

function readStructured(error: unknown): StepFailureReason | null {
  if (!error || typeof error !== "object") return null;
  for (const entry of causeChain(error)) {
    const status =
      (typeof entry.status === "number" && entry.status) ||
      (typeof entry.statusCode === "number" && entry.statusCode) ||
      (typeof (entry.response as Record<string, unknown> | undefined)?.status === "number" &&
        ((entry.response as Record<string, unknown>).status as number));
    if (typeof status === "number" && STATUS_REASONS[status]) {
      return STATUS_REASONS[status];
    }
    const rawCode =
      typeof entry.code === "string" ? entry.code.trim().toUpperCase() : undefined;
    if (rawCode) {
      if (CODE_REASONS[rawCode]) return CODE_REASONS[rawCode];
      if (rawCode === "RATE_LIMITED" || rawCode === "RATELIMIT") return "rate_limited";
      if (rawCode === "INSUFFICIENT_QUOTA" || rawCode === "QUOTA_EXCEEDED") {
        return "quota_exhausted";
      }
      if (rawCode === "EAUTH" || rawCode === "UNAUTHORIZED") return "auth_required";
    }
    const errno = typeof entry.errno === "number" ? entry.errno : undefined;
    if (errno === -13 || errno === -1 || errno === -2 || errno === -20 || errno === -36) {
      return "local_io";
    }
  }
  return null;
}

export interface ClassifyStepFailureOptions {
  /** The thrown error, when one exists: its status/code/errno are checked before any text. */
  error?: unknown;
}

/**
 * Classify a step failure into a machine-readable reason. Text matching is the
 * last tier and stays English-only; everything locale-independent is matched
 * before it.
 */
export function classifyStepFailure(
  reason: string,
  options: ClassifyStepFailureOptions = {},
): StepFailureReason {
  const fromStructure = readStructured(options.error);
  if (fromStructure) return fromStructure;

  const lower = String(reason || "").toLowerCase();
  if (!lower) return "untyped";

  // Locale-independent markers first: errno names and HTTP statuses survive
  // translation because the OS or SDK prints them verbatim.
  const errnoMatch = /\b(eacces|eperm|enoent|eisdir|enotdir|enospc|erofs|emfile)\b/.exec(lower);
  if (errnoMatch) return "local_io";
  const statusMatch = /\b(401|403|402|429)\b(?![\d.])/m.exec(lower);
  if (statusMatch) return STATUS_REASONS[Number(statusMatch[1])];
  if (/\b432\b/.test(lower)) return "quota_exhausted";
  if (
    /\b(insufficient_quota|quota_exceeded|billing_hard_limit_reached|insufficient_user_quota)\b/.test(
      lower,
    )
  ) {
    return "quota_exhausted";
  }

  // English fallback tiers, checked most specific first so a quota mention in
  // a provider error is never mistaken for a user blocker.
  if (
    /\b(quota|usage limit|upgrade your plan|billing|payment required|resource exhausted)\b/.test(
      lower,
    ) ||
    /\brate limit/.test(lower)
  ) {
    return "rate_limited";
  }

  if (/\b(blocked by policy|capability is disabled|disabled by policy|access profile)\b/.test(lower)) {
    return "access_profile_denied";
  }

  if (/\b(approval|approve|user denied|denied approval)\b/.test(lower)) {
    return "approval_denied";
  }

  if (/\b(auth|authentication|unauthorized|credential|login|api key|token required)\b/.test(lower)) {
    return "auth_required";
  }

  if (
    /\b(integration|account|provider|channel|wallet)\b.*\b(disconnected|not connected|expired)\b/.test(
      lower,
    ) ||
    /\b(connect|reconnect|link|authorize)\b.*\b(integration|account|provider|channel|wallet)\b/.test(
      lower,
    )
  ) {
    return "integration_disconnected";
  }

  if (
    /\b(no such file|does not exist|invalid path|syntax error|workspace|permission denied)\b/.test(
      lower,
    )
  ) {
    return "local_io";
  }

  return "untyped";
}

/** Reasons that mean "only the user can clear this". */
export function isUserActionReason(reason: StepFailureReason): boolean {
  return (
    reason === "approval_denied" ||
    reason === "auth_required" ||
    reason === "integration_disconnected" ||
    reason === "access_profile_denied"
  );
}
