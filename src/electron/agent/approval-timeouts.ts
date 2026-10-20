/**
 * How long an approval request stays answerable. A decision left on Today, in a
 * session or in a chat channel waits for the person to come back (overnight
 * included) instead of lapsing into a denial after a few minutes. It is still
 * bounded, so a forgotten request cannot be approved days later.
 */
export const APPROVAL_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** How long a granted approval may wait to be used once the person decided. */
export const APPROVAL_GRANT_TTL_MS = 5 * 60 * 1000;

export const APPROVAL_TIMEOUT_GRACE_MS = 1_000;

/**
 * Fixed allowance that tool deadlines carry for approval handling. The time a
 * person spends deciding is credited on top of it while the decision is pending
 * (see APPROVAL_WAIT_MAX_PAUSE_MS), so it never has to fit in here.
 */
export const APPROVAL_GATED_TOOL_TIMEOUT_MS = 5 * 60 * 1000 + APPROVAL_TIMEOUT_GRACE_MS;

/**
 * Most decision time a tool deadline is extended by: the whole answer window plus
 * a grace period, so an unanswered request lapses as an approval timeout instead
 * of being misreported as a generic tool timeout.
 */
export const APPROVAL_WAIT_MAX_PAUSE_MS = APPROVAL_REQUEST_TIMEOUT_MS + APPROVAL_TIMEOUT_GRACE_MS;

/** "24 hours", "90 minutes": the answer window in words for messages. */
export function formatApprovalWindow(ms: number = APPROVAL_REQUEST_TIMEOUT_MS): string {
  const hours = ms / (60 * 60 * 1000);
  if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
