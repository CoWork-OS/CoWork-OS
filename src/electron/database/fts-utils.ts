const FTS5_KEYWORDS = new Set(["and", "or", "not", "near"]);

export function sanitizeFtsToken(token: string): string {
  return token.replace(/[^a-z0-9_-]/g, "");
}

export function isSafeFtsToken(token: string): boolean {
  return token.length > 1 && !FTS5_KEYWORDS.has(token);
}

export function buildMarkerFtsQuery(marker: string): string | null {
  const token = sanitizeFtsToken(marker.toLowerCase()).trim();
  if (!isSafeFtsToken(token)) return null;
  return `"${token}"`;
}

export function buildRelaxedTokenFtsQuery(rawTokens: string[]): string {
  const parts = rawTokens
    .map((t) => sanitizeFtsToken(t))
    .filter((t) => isSafeFtsToken(t))
    .map((t) => `"${t}"`);
  return parts.join(" OR ");
}

// Imported memories can optionally carry a lightweight control header on the first line.
export const IMPORTED_PROMPT_RECALL_IGNORE_MARKER = "[cowork:prompt_recall=ignore]";

/** SQL predicate matching imported memories; shared by the host repository and the FTS worker. */
export const buildImportedMemoryFilterSql = (contentExpr: string): string =>
  `(${contentExpr} LIKE '[Imported from %' OR ${contentExpr} LIKE '${IMPORTED_PROMPT_RECALL_IGNORE_MARKER}%[Imported from %')`;
