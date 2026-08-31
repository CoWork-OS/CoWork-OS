/**
 * Build text that is safe to show or send as a task completion.
 *
 * `semanticSummary` is deliberately not accepted here. It is timeline metadata
 * for internal progress display, not an answer for the user.
 */
export function formatUserFacingCompletionSummary(parts: {
  resultSummary?: unknown;
  verificationVerdict?: unknown;
  verificationReport?: unknown;
  separator?: string;
}): string {
  const resultSummary = normalizeCompletionPart(parts.resultSummary);
  const verificationVerdict = normalizeCompletionPart(parts.verificationVerdict);
  const verificationReport = normalizeCompletionPart(parts.verificationReport);
  const separator = parts.separator ?? "\n\n";
  const verification = [
    verificationVerdict ? `Verification: ${verificationVerdict}` : "",
    verificationReport,
  ]
    .filter((value) => value.length > 0)
    .join(separator === "\n\n" ? "\n" : separator);

  return [resultSummary, verification].filter((value) => value.length > 0).join(separator);
}

function normalizeCompletionPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
