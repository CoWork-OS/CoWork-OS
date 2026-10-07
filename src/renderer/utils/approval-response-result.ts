import type { ApprovalResponseStatus } from "../../shared/types";

export type ApprovalResponseDisposition = "resolved" | "stale" | "in_progress" | "unknown";

/** Only confirmed terminal outcomes should remove an approval from the UI. */
export function approvalResponseDisposition(status: unknown): ApprovalResponseDisposition {
  if (status === "handled" || status === "duplicate") return "resolved";
  if (status === "not_found") return "stale";
  if (status === "in_progress") return "in_progress";
  return "unknown";
}

export function isResolvedApprovalResponse(
  status: ApprovalResponseStatus | unknown,
): status is "handled" | "duplicate" {
  return approvalResponseDisposition(status) === "resolved";
}
