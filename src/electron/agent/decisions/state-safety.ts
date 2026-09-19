import type { JevJsonValue } from "./types";

export const DECISION_REDACTED = "[REDACTED]";
export const DECISION_UNAVAILABLE = "[UNAVAILABLE]";
export const DECISION_TRUNCATED = "[TRUNCATED]";

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|(?:access|refresh|id|session)?[_-]?token|authorization|password|secret|cookie|credential|private[_-]?key)/i;

/** Redact common credential-shaped text before it enters a decision request. */
export function redactDecisionText(value: unknown, maxLength = 400): string {
  let result = String(value ?? "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|authorization|password|secret|credential|private[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (match) => match.replace(/([:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)$/, `$1${DECISION_REDACTED}`),
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (result.length > maxLength) result = `${result.slice(0, maxLength)}${DECISION_TRUNCATED}`;
  return result;
}

/**
 * Produce a bounded JSON-compatible projection for external decision calls.
 * The projection is intentionally conservative: omitted or redacted data is
 * evidence of an incomplete assessment, never an implicit approval.
 */
export function redactDecisionValue(
  value: unknown,
  options: {
    maxStringLength?: number;
    maxObjectEntries?: number;
    maxArrayItems?: number;
    maxDepth?: number;
  } = {},
): JevJsonValue {
  const maxStringLength = Math.max(1, Math.floor(options.maxStringLength ?? 400));
  const maxObjectEntries = Math.max(1, Math.floor(options.maxObjectEntries ?? 24));
  const maxArrayItems = Math.max(1, Math.floor(options.maxArrayItems ?? 16));
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 3));
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): JevJsonValue => {
    if (candidate === null) return null;
    if (typeof candidate === "string") return redactDecisionText(candidate, maxStringLength);
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? candidate : DECISION_UNAVAILABLE;
    }
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "bigint")
      return redactDecisionText(String(candidate), maxStringLength);
    if (typeof candidate !== "object") return DECISION_UNAVAILABLE;
    if (depth >= maxDepth) return DECISION_TRUNCATED;
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      const result = candidate.slice(0, maxArrayItems).map((item) => visit(item, depth + 1));
      if (candidate.length > maxArrayItems) result.push(DECISION_TRUNCATED);
      return result;
    }

    const result: Record<string, JevJsonValue> = {};
    const entries = Object.entries(candidate as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, maxObjectEntries)) {
      result[redactDecisionText(key, 80)] = SECRET_KEY_PATTERN.test(key)
        ? DECISION_REDACTED
        : visit(item, depth + 1);
    }
    if (entries.length > maxObjectEntries) result.__truncated__ = true;
    return result;
  };

  return visit(value, 0);
}
