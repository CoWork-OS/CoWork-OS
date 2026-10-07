import { createHash } from "node:crypto";
import type { ApprovalRequest } from "../../shared/types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
/** Exact request content. Resolution status and transport metadata are not the revision. */
export function approvalRequestRevisionHash(
  request: Pick<ApprovalRequest, "taskId" | "type" | "description" | "details" | "requestedAt">,
): string {
  const serialized = JSON.stringify(
    canonical({
      taskId: request.taskId,
      type: request.type,
      description: request.description,
      details: request.details,
      requestedAt: request.requestedAt,
    }),
  );
  if (serialized.length > 256000) throw new Error("Approval revision exceeds limit");
  return createHash("sha256").update(serialized).digest("hex");
}
export function approvalRevisionMatches(
  request: Parameters<typeof approvalRequestRevisionHash>[0],
  expected: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  try {
    return approvalRequestRevisionHash(request) === expected;
  } catch {
    return false;
  }
}

/** Attach a trusted revision token to the exact approval content being presented. */
export function presentApprovalRevision<T extends ApprovalRequest>(
  request: T,
): T & { revisionHash: string } {
  return { ...request, revisionHash: approvalRequestRevisionHash(request) };
}
