/**
 * The approval wait and the outer tool timeout intentionally use separate
 * values. The outer timeout needs a small grace period so an unanswered
 * approval rejects as an approval timeout instead of being misreported as a
 * generic tool timeout.
 */
export const APPROVAL_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const APPROVAL_TIMEOUT_GRACE_MS = 1_000;
export const APPROVAL_GATED_TOOL_TIMEOUT_MS =
  APPROVAL_REQUEST_TIMEOUT_MS + APPROVAL_TIMEOUT_GRACE_MS;
