/** Deterministic lexical selection inside an already-authorized memory file. */
import { extractFtsTerms, foldSearchText, isFtsStopword } from "../../database/fts-query";

export const MEMORY_REPO_RELEVANT_ENTRIES = 5;

/** Same bounded, Unicode-aware terms for ranking and cache identity. No raw query is logged. */
export function memorySelectionTerms(query?: string | null): string[] {
  return [
    ...new Set(
      extractFtsTerms(query ?? "", { maxTerms: 24, minTermLength: 2, dropStopwords: true })
        .map(foldSearchText)
        .filter((term) => !isFtsStopword(term)),
    ),
  ].sort();
}

export interface MemorySelectionCandidate {
  text: string;
  hash: string;
  /** Explicit user constraints survive unrelated task queries. */
  essential: boolean;
  sourceChanged: boolean;
}

/** Return candidate indices in selection priority, not display order. Budgeting follows
 * ranking, so an early irrelevant/oversized row cannot starve a small relevant one. */
export function rankMemoryEntries(
  candidates: MemorySelectionCandidate[],
  terms: string[],
): number[] {
  const words = candidates.map((candidate) =>
    extractFtsTerms(candidate.text, { maxTerms: 256 }).map(foldSearchText),
  );
  const matches = words.map((row) =>
    terms.map((term) =>
      row.some((word) => word === term || (term.length >= 3 && word.startsWith(term))),
    ),
  );
  const frequency = terms.map((_, index) => matches.filter((row) => row[index]).length);
  const scores = candidates.map((candidate, index) =>
    candidate.sourceChanged
      ? 0
      : matches[index].reduce(
          (score, match, t) =>
            score + (match ? 1 + Math.log((candidates.length + 1) / (frequency[t] + 1)) : 0),
          0,
        ),
  );
  const best = Math.max(0, ...scores.filter((_, index) => !candidates[index].essential));
  const ordered = candidates
    .map((_, index) => index)
    .sort(
      (a, b) =>
        Number(candidates[b].essential) - Number(candidates[a].essential) ||
        (candidates[a].essential && candidates[b].essential ? 0 : scores[b] - scores[a]) ||
        a - b,
    );
  const seen = new Set<string>();
  return ordered.filter((index) => {
    const candidate = candidates[index];
    if (seen.has(candidate.hash)) return false;
    if (!candidate.essential && (scores[index] <= 0 || scores[index] < best * 0.4)) return false;
    seen.add(candidate.hash);
    return true;
  });
}
