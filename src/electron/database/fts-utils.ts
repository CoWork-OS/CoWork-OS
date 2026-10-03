import { buildFtsPhraseQuery, extractFtsTerms, foldForMatch, quoteFtsTerm } from "./fts-query";

/**
 * Memory FTS helpers (memory FTS worker and host repository), on top of the shared
 * Unicode builder in fts-query.ts. Tokens keep letters, digits and marks of every script
 * plus `_`, `-` and `.`, so `größe`, `şehir`, `café` and `executor.ts` stay searchable
 * (the old filter kept only `[a-z0-9_-]`).
 */

const FTS5_KEYWORDS = new Set(["and", "or", "not", "near"]);
const MAX_RELAXED_TERMS = 32;

function codePoints(value: string): number {
  return Array.from(value).length;
}

export function sanitizeFtsToken(token: string): string {
  return String(token || "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}_.-]/gu, "")
    .replace(/^[._-]+|[._-]+$/g, "");
}

export function isSafeFtsToken(token: string): boolean {
  return codePoints(token) > 1 && !FTS5_KEYWORDS.has(foldForMatch(token));
}

/** An exact marker such as `[suggestion-feedback:acted_on]` as one quoted phrase. */
export function buildMarkerFtsQuery(marker: string): string | null {
  const phrase = buildFtsPhraseQuery(String(marker || "").toLowerCase());
  if (!phrase) return null;
  const inner = phrase.slice(1, -1);
  return isSafeFtsToken(inner) ? phrase : null;
}

/** Any of the tokens (quoted, OR-joined); unsafe and single-character tokens are dropped. */
export function buildRelaxedTokenFtsQuery(rawTokens: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of rawTokens) {
    for (const term of extractFtsTerms(sanitizeFtsToken(raw), { maxTerms: MAX_RELAXED_TERMS })) {
      const key = foldForMatch(term);
      if (!isSafeFtsToken(term) || seen.has(key)) continue;
      seen.add(key);
      parts.push(quoteFtsTerm(term));
      if (parts.length >= MAX_RELAXED_TERMS) return parts.join(" OR ");
    }
  }
  return parts.join(" OR ");
}

// Imported memories can optionally carry a lightweight control header on the first line.
export const IMPORTED_PROMPT_RECALL_IGNORE_MARKER = "[cowork:prompt_recall=ignore]";

/** SQL predicate matching imported memories; shared by the host repository and the FTS worker. */
export const buildImportedMemoryFilterSql = (contentExpr: string): string =>
  `(${contentExpr} LIKE '[Imported from %' OR ${contentExpr} LIKE '${IMPORTED_PROMPT_RECALL_IGNORE_MARKER}%[Imported from %')`;
